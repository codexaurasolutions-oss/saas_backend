import { Router } from "express";
import { authRouter } from "../modules/auth/routes.js";
import { ownerRouter } from "../modules/owner/routes.js";
import { reportsRouter } from "../modules/reports/routes.js";
import { publicRouter } from "../modules/public/routes.js";
import { customerRouter } from "../modules/customer/routes.js";
import { uploadRouter } from "../modules/upload/routes.js";
import { superAdminRouter } from "../modules/superAdmin/routes.js";

export const router = Router();
router.use("/auth", authRouter);
router.use("/owner", ownerRouter);
router.use("/reports", reportsRouter);
router.use("/public", publicRouter);
router.use("/customer", customerRouter);
router.use("/upload", uploadRouter);
router.use("/super-admin", superAdminRouter);
