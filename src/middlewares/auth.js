import { verifyAccessToken } from "../lib/tokens.js";
import { prisma } from "../lib/prisma.js";
import { defaultOwnerPermissions } from "../lib/permissions.js";

export const authMiddleware = async (req, res, next) => {
  try {
    const url = req.originalUrl || req.path || "";
    if (url.startsWith("/api/v1/public") || url.startsWith("/api/v1/auth") || url.includes("/test-email") || url.includes("/uploads") || url.includes("/zoho/callback") || url.includes("/health") || url.includes("/ready")) {
      return next();
    }
    let token = null;
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer ")) {
      token = header.slice(7);
    }
    if (!token) return res.status(401).json({ message: "Authentication required" });
    const decoded = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { memberships: true, customerProfile: true }
    });
    if (!user || !user.isActive) return res.status(401).json({ message: "Invalid user" });

    const membership = decoded.salonId
      ? user.memberships.find((m) => m.salonId === decoded.salonId)
      : null;
    // Fix: customer profile must match the requested salon (or any salon if no salonId in token).
    // Previous parenthesisation was ambiguous due to JS ternary precedence with `&&`.
    const customerProfile = user.systemRole === "CUSTOMER"
      ? (decoded.salonId
          ? (user.customerProfile && user.customerProfile.salonId === decoded.salonId ? user.customerProfile : null)
          : user.customerProfile)
      : null;

    const resolvedSalonId = membership?.salonId || customerProfile?.salonId || null;

    if (resolvedSalonId) {
      const salon = await prisma.salon.findUnique({
        where: { id: resolvedSalonId },
        select: { status: true }
      });
      if (!salon || salon.status === "SUSPENDED") {
        return res.status(403).json({ message: "Salon access suspended" });
      }
    }

    const [salon, subscription, salonSettings] = resolvedSalonId
      ? await Promise.all([
          prisma.salon.findUnique({
            where: { id: resolvedSalonId },
            select: { featureFlags: true }
          }),
          prisma.subscription.findFirst({
            where: { salonId: resolvedSalonId, status: { in: ["ACTIVE", "TRIAL"] } },
            include: { plan: true },
            orderBy: { endsAt: "desc" }
          }),
          prisma.salonSetting.findFirst({
            where: { salonId: resolvedSalonId, branchId: null },
            select: { advancedSettings: true }
          })
        ])
      : [null, null, null];

    const mergedFeatureFlags = {
      ...(subscription?.plan?.featureFlags || {}),
      ...(salon?.featureFlags || {})
    };
    const accessControlSettings = (salonSettings?.advancedSettings && typeof salonSettings.advancedSettings === "object")
      ? (salonSettings.advancedSettings.accessControl || {})
      : {};
    const mergedPermissions = membership
      ? membership.salonRole === "SALON_OWNER"
        ? { ...defaultOwnerPermissions, ...(membership.permissions || {}) }
        : (await (async () => {
            if (membership.customRoleId) {
              const customRole = await prisma.customRole.findFirst({ where: { id: membership.customRoleId, salonId: resolvedSalonId } });
              if (customRole) {
                const base = { ...(membership.permissions || {}), ...(customRole.permissions || {}) };
                return base;
              }
            }
            return membership.permissions || {};
          })())
      : null;

    req.user = {
      id: user.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      systemRole: user.systemRole,
      customerId: customerProfile?.id || null,
      membershipId: membership?.id || null,
      salonId: resolvedSalonId,
      salonRole: membership?.salonRole || null,
      branchId: membership?.branchId || null,
      permissions: mergedPermissions,
      featureFlags: mergedFeatureFlags,
      accessControlSettings,
      plan: subscription?.plan
        ? {
            id: subscription.plan.id,
            name: subscription.plan.name,
            branchLimit: subscription.plan.branchLimit,
            userLimit: subscription.plan.userLimit,
            customerLimit: subscription.plan.customerLimit,
            invoiceLimit: subscription.plan.invoiceLimit,
            storageLimit: subscription.plan.storageLimit,
            isCustom: subscription.plan.isCustom
          }
        : null
    };
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ message: "Invalid token" });
    }
    console.error("Auth middleware error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};
