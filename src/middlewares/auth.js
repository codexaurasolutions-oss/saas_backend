import { verifyAccessToken } from "../lib/tokens.js";
import { prisma } from "../lib/prisma.js";
import { defaultOwnerPermissions } from "../lib/permissions.js";
import { runExpiredDemoCleanup } from "../lib/trialCleanup.js";

export const authMiddleware = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return next();
    const token = header.slice(7);
    const decoded = verifyAccessToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { memberships: true, customerProfile: true }
    });
    if (!user || !user.isActive) return res.status(401).json({ message: "Invalid user" });

    const membership = decoded.salonId
      ? user.memberships.find((m) => m.salonId === decoded.salonId)
      : null;
    const customerProfile = user.systemRole === "CUSTOMER"
      ? (decoded.salonId ? user.customerProfile && user.customerProfile.salonId === decoded.salonId ? user.customerProfile : null : user.customerProfile)
      : null;

    const resolvedSalonId = membership?.salonId || customerProfile?.salonId || null;

    if (resolvedSalonId) {
      await runExpiredDemoCleanup({ actorName: "AUTH_MIDDLEWARE", salonId: resolvedSalonId });
    }

    if (resolvedSalonId) {
      const salon = await prisma.salon.findUnique({
        where: { id: resolvedSalonId },
        select: { status: true }
      });
      if (!salon || salon.status === "SUSPENDED") {
        return res.status(403).json({ message: "Salon access suspended" });
      }
    }

    const [salon, subscription] = resolvedSalonId
      ? await Promise.all([
          prisma.salon.findUnique({
            where: { id: resolvedSalonId },
            select: { featureFlags: true }
          }),
          prisma.subscription.findFirst({
            where: { salonId: resolvedSalonId, status: { in: ["ACTIVE", "TRIAL"] } },
            include: { plan: true },
            orderBy: { endsAt: "desc" }
          })
        ])
      : [null, null];

    const mergedFeatureFlags = {
      ...(subscription?.plan?.featureFlags || {}),
      ...(salon?.featureFlags || {})
    };
    const mergedPermissions = membership
      ? membership.salonRole === "SALON_OWNER"
        ? { ...defaultOwnerPermissions, ...(membership.permissions || {}) }
        : (membership.permissions || {})
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
      permissions: mergedPermissions,
      featureFlags: mergedFeatureFlags,
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
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};
