import compression from "compression";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { authMiddleware } from "./middlewares/auth.js";
import { errorHandler } from "./middlewares/error.js";
import { router } from "./routes/index.js";
import path from "node:path";

dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeOrigins = (origins = []) =>
  [...new Set(
    origins
      .flatMap((value) => String(value || "").split(","))
      .map((value) => value.trim())
      .filter(Boolean)
  )];

const getAllowedOrigins = (overrideOrigins = null) => {
  if (overrideOrigins) return normalizeOrigins(overrideOrigins);
  return normalizeOrigins([
    process.env.FRONTEND_APP_URL,
    process.env.FRONTEND_APP_URLS,
    "http://127.0.0.1:5173",
    "http://localhost:5173"
  ]);
};

const isLocalRequest = (req) => {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "");
  const remoteAddress = String(req.ip || req.socket?.remoteAddress || "");
  const origin = String(req.headers.origin || "");
  return [forwardedFor, remoteAddress, origin].some((value) =>
    value.includes("127.0.0.1") || value.includes("::1") || value.includes("localhost")
  );
};

const shouldBypassLocalRateLimit = () => {
  const env = process.env.NODE_ENV || "development";
  if (env === "production" || env === "test") return false;
  if (process.env.VITEST) return false;
  return true;
};

export const createApp = ({
  routerOverride = router,
  authMiddlewareOverride = authMiddleware,
  errorHandlerOverride = errorHandler,
  loggerFormat = process.env.NODE_ENV === "production" ? "combined" : "dev",
  allowedOrigins = null,
  jsonLimit = process.env.JSON_BODY_LIMIT || "1mb",
  rateLimitWindowMs = parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
  rateLimitMax = parseNumber(process.env.RATE_LIMIT_MAX, 300),
  trustProxy = process.env.TRUST_PROXY === "true"
} = {}) => {
  const app = express();
  const resolvedOrigins = new Set(getAllowedOrigins(allowedOrigins));

  app.disable("x-powered-by");
  if (trustProxy) app.set("trust proxy", 1);

  morgan.token("req-id", (req) => req.requestId);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    next();
  });

  app.use(cors({
    origin(origin, callback) {
      if (!origin || resolvedOrigins.size === 0 || resolvedOrigins.has(origin)) {
        return callback(null, true);
      }
      const error = new Error("Origin not allowed by CORS policy");
      error.status = 403;
      return callback(error);
    },
    credentials: true
  }));

  app.use(helmet({
    crossOriginResourcePolicy: false
  }));

  app.use(compression());
  app.use(rateLimit({
    windowMs: rateLimitWindowMs,
    limit: rateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      if (req.path === "/health" || req.path === "/ready") return true;
      if (shouldBypassLocalRateLimit() && isLocalRequest(req)) return true;
      return false;
    },
    handler: (req, res) => {
      res.status(429).json({
        message: "Too many requests, please try again shortly.",
        requestId: req.requestId
      });
    }
  }));
  app.use(morgan(
    loggerFormat === "combined"
      ? `:remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" req=:req-id`
      : ":method :url :status :response-time ms req=:req-id"
  ));
  app.use(express.json({ limit: jsonLimit }));
  app.use(express.urlencoded({ extended: true, limit: jsonLimit }));
  app.use(cookieParser());
  app.use(authMiddlewareOverride);
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
  app.use("/api/v1", routerOverride);
  app.get("/health", (req, res) => res.json({
    ok: true,
    environment: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime())
  }));
  app.get("/ready", (req, res) => res.json({
    ok: true,
    requestId: req.requestId,
    checks: {
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
      jwtConfigured: Boolean(process.env.JWT_SECRET && process.env.JWT_REFRESH_SECRET),
      frontendOriginConfigured: resolvedOrigins.size > 0
    }
  }));
  app.use(errorHandlerOverride);

  return app;
};
