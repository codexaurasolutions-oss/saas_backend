import jwt from "jsonwebtoken";

const tokenBlacklist = new Set();
const BLACKLIST_CLEANUP_INTERVAL = 60 * 60 * 1000;

const cleanupBlacklist = () => {
  const now = Math.floor(Date.now() / 1000);
  for (const token of tokenBlacklist) {
    try {
      const decoded = jwt.decode(token);
      if (decoded?.exp && decoded.exp < now) tokenBlacklist.delete(token);
    } catch { tokenBlacklist.delete(token); }
  }
};
setInterval(cleanupBlacklist, BLACKLIST_CLEANUP_INTERVAL);

export const revokeToken = (token) => tokenBlacklist.add(token);
export const isTokenRevoked = (token) => tokenBlacklist.has(token);

export const signAccessToken = (payload, options) => jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: options?.expiresIn || "1h" });
export const signRefreshToken = (payload, options) => jwt.sign(payload, process.env.JWT_REFRESH_SECRET, { expiresIn: options?.expiresIn || "7d" });
export const signLoginAccessToken = (payload, options) => jwt.sign({ ...payload, purpose: "DEMO_LOGIN" }, process.env.JWT_SECRET, { expiresIn: options?.expiresIn || "30d" });
export const verifyAccessToken = (token) => {
  if (isTokenRevoked(token)) throw new Error("Token has been revoked");
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded?.purpose === "DEMO_LOGIN") throw new Error("Invalid token purpose");
  return decoded;
};
export const verifyRefreshToken = (token) => {
  if (isTokenRevoked(token)) throw new Error("Refresh token has been revoked");
  return jwt.verify(token, process.env.JWT_REFRESH_SECRET);
};
export const verifyLoginAccessToken = (token) => {
  if (isTokenRevoked(token)) throw new Error("Token has been revoked");
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded?.purpose !== "DEMO_LOGIN") throw new Error("Invalid login access token");
  return decoded;
};

export const signTempToken = (payload, options) => {
  return jwt.sign({ ...payload, purpose: "OTP_VERIFICATION" }, process.env.JWT_SECRET, { expiresIn: options?.expiresIn || "10m" });
};

export const verifyTempToken = (token) => {
  if (isTokenRevoked(token)) throw new Error("Token has been revoked");
  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded?.purpose !== "OTP_VERIFICATION") throw new Error("Invalid temp token purpose");
  return decoded;
};
