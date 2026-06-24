import { prisma } from "../lib/prisma.js";

export const requireAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  next();
};

export const requireSystemRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.systemRole)) return res.status(403).json({ message: "Forbidden" });
  next();
};

export const requireSalonPermission = (moduleKey, action = "view") => (req, res, next) => {
  if (req.user.systemRole === "SUPER_ADMIN" || req.user.systemRole === "SALON_OWNER") return next();
  const perms = req.user.permissions || {};
  const allowed = perms[moduleKey]?.includes(action);
  if (!allowed) return res.status(403).json({ message: `No permission: ${moduleKey}.${action}` });
  next();
};

export const requireFeatureEnabled = (featureKey) => (req, res, next) => {
  if (req.user.systemRole === "SUPER_ADMIN" || req.user.systemRole === "SALON_OWNER") return next();
  const flags = req.user.featureFlags || {};
  if (flags[featureKey] === false) {
    return res.status(403).json({ message: `Feature disabled: ${featureKey}` });
  }
  next();
};

export const requireSalonContext = (req, res, next) => {
  if (req.user.systemRole === "SUPER_ADMIN") return next();
  if (!req.user.salonId) return res.status(403).json({ message: "Salon context required" });
  req.salonId = req.user.salonId;
  next();
};

export const requireMaintenanceAccess = async (req, res, next) => {
  if (req.user?.systemRole === "SUPER_ADMIN") return next();
  const settings = await prisma.globalSetting.findFirst();
  if (settings?.maintenanceMode) {
    return res.status(503).json({ message: "System is in maintenance mode" });
  }
  next();
};

export const requireCustomerAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  if (req.user.systemRole !== "CUSTOMER" || !req.user.customerId || !req.user.salonId) {
    return res.status(403).json({ message: "Customer access only" });
  }
  next();
};

// ---- Access Control policy middleware ----
// Reads toggles from req.user.accessControlSettings (loaded by authMiddleware
// from SalonSetting.advancedSettings.accessControl). Each helper short-circuits
// to `next()` for SALON_OWNER / SUPER_ADMIN so the owner is never blocked by
// their own policy.
const isOwnerOrAdmin = (req) => req.user?.systemRole === "SUPER_ADMIN" || req.user?.systemRole === "SALON_OWNER";
const acFlag = (req, key, fallback = true) => {
  const ac = req.user?.accessControlSettings || {};
  const value = ac[key];
  return value === undefined ? fallback : Boolean(value);
};

export const requireStaffExportEnabled = (req, res, next) => {
  if (isOwnerOrAdmin(req)) return next();
  if (!acFlag(req, "allowStaffExport", true)) {
    return res.status(403).json({ message: "Staff export is disabled in access control settings" });
  }
  next();
};

export const requireRosterOverrideEnabled = (req, res, next) => {
  if (isOwnerOrAdmin(req)) return next();
  if (!acFlag(req, "allowRosterOverrides", true)) {
    return res.status(403).json({ message: "Roster overrides are disabled in access control settings" });
  }
  next();
};

export const getAccessControlSettings = (req) => req.user?.accessControlSettings || {};
