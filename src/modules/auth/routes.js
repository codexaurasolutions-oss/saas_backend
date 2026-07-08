import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { signAccessToken, signRefreshToken, verifyLoginAccessToken, verifyRefreshToken } from "../../lib/tokens.js";
import { validate, schemas } from "../../middlewares/validate.js";
import { hashPasswordSetupToken, generateRawPasswordSetupToken } from "../../lib/passwordSetup.js";
import { sendMail } from "../../lib/mailer.js";
import { defaultOwnerPermissions } from "../../lib/permissions.js";
import { runExpiredDemoCleanup } from "../../lib/trialCleanup.js";

export const authRouter = Router();

const membershipPriority = {
  SALON_OWNER: 1,
  ADMIN: 2,
  MANAGER: 3,
  RECEPTIONIST: 4,
  STAFF: 5,
  INVENTORY_MANAGER: 6,
  ACCOUNTANT: 7
};

const sortMemberships = (memberships = []) =>
  [...memberships].sort((left, right) => {
    const roleDiff = (membershipPriority[left.salonRole] || 99) - (membershipPriority[right.salonRole] || 99);
    if (roleDiff !== 0) return roleDiff;
    return new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime();
  });

authRouter.post("/register", validate(schemas.register), async (req, res) => {
  const { name, email, password, systemRole = "SALON_USER", salonId } = req.body;
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(400).json({ message: "Email already exists" });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({ data: { name, email, passwordHash, systemRole } });

  if (salonId && systemRole === "SALON_USER") {
    await prisma.userSalon.create({
      data: {
        userId: user.id,
        salonId,
        salonRole: "SALON_OWNER",
        permissions: defaultOwnerPermissions
      }
    });
  }

  res.status(201).json({ id: user.id, email: user.email });
});

authRouter.post("/login", validate(schemas.login), async (req, res) => {
  const { email, password, loginAccessToken } = req.body;
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      memberships: {
        include: {
          salon: {
            select: {
              id: true,
              status: true,
              featureFlags: true
            }
          }
        }
      }
    }
  });
  if (!user) return res.status(401).json({ message: "Invalid credentials" });
  if (user.isActive === false) {
    return res.status(403).json({ message: "User account is inactive" });
  }
  if (user.passwordSetupRequired) {
    return res.status(403).json({ message: "Password setup is still pending. Use the invite link from your email to activate this account." });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });
  if (user.systemRole !== "SUPER_ADMIN") {
    const globalSetting = await prisma.globalSetting.findFirst();
    if (globalSetting?.maintenanceMode) {
      return res.status(503).json({ message: "System is in maintenance mode" });
    }
  }
  let decodedLoginAccess = null;
  if (loginAccessToken) {
    try {
      decodedLoginAccess = verifyLoginAccessToken(loginAccessToken);
    } catch {
      return res.status(403).json({ message: "Invalid or expired secure login link." });
    }
  }

  const requestedSalonId = decodedLoginAccess?.salonId || null;
  const activeMemberships = sortMemberships(
    (user.memberships || []).filter((membership) => membership?.salon?.status !== "SUSPENDED")
  );
  const membership = user.systemRole === "SUPER_ADMIN"
    ? null
    : requestedSalonId
      ? activeMemberships.find((item) => item.salonId === requestedSalonId)
      : activeMemberships[0] || null;

  if (membership?.salonId) {
    await runExpiredDemoCleanup({ actorName: "LOGIN_CHECK", salonId: membership.salonId });
  }
  if (user.systemRole !== "SUPER_ADMIN" && !membership) {
    return res.status(403).json({ message: "No active salon membership is linked to this email." });
  }
  if (user.isDemoAccount) {
    if (!loginAccessToken) {
      return res.status(403).json({ message: "Use the secure login link sent to your email for this demo account." });
    }
    if (decodedLoginAccess?.email !== user.email || decodedLoginAccess?.userId !== user.id || decodedLoginAccess?.salonId !== membership?.salonId) {
      return res.status(403).json({ message: "Invalid demo login link." });
    }
  }
  const [salon, subscription] = membership
    ? await Promise.all([
        prisma.salon.findUnique({ where: { id: membership.salonId }, select: { name: true, slug: true, logoUrl: true, featureFlags: true } }),
        prisma.subscription.findFirst({
          where: { salonId: membership.salonId, status: { in: ["ACTIVE", "TRIAL"] } },
          include: { plan: true },
          orderBy: { endsAt: "desc" }
        })
      ])
    : [null, null];
  const resolvedSalonId = membership?.salonId || null;
  const accessToken = signAccessToken({ userId: user.id, salonId: resolvedSalonId });
  const refreshToken = signRefreshToken({ userId: user.id, salonId: resolvedSalonId });
  const mergedFeatureFlags = {
    ...(subscription?.plan?.featureFlags || {}),
    ...(salon?.featureFlags || {})
  };
  const mergedPermissions = membership
    ? membership.salonRole === "SALON_OWNER"
      ? { ...defaultOwnerPermissions, ...(membership.permissions || {}) }
      : (membership.permissions || {})
    : null;

  res.json({
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, systemRole: user.systemRole },
    membership: membership
      ? {
          salonId: membership.salonId,
          salonName: salon?.name || membership.salon?.name || null,
          salonSlug: salon?.slug || null,
          salonLogo: salon?.logoUrl || null,
          salonRole: membership.salonRole,
          permissions: mergedPermissions || {},
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
        }
      : null
  });
});

authRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;
  try {
    const decoded = verifyRefreshToken(refreshToken);
    const accessToken = signAccessToken({ userId: decoded.userId, salonId: decoded.salonId || null });
    return res.json({ accessToken });
  } catch {
    return res.status(401).json({ message: "Invalid refresh token" });
  }
});

authRouter.post("/logout", async (req, res) => res.json({ ok: true }));

authRouter.post("/forgot-password", validate(schemas.forgotPassword), async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      memberships: {
        include: {
          salon: true
        }
      }
    }
  });

  if (!user) {
    return res.json({ message: "If this email exists in the system, a password setup email has been sent." });
  }

  const primaryMembership = user.memberships[0] || null;
  const rawToken = generateRawPasswordSetupToken();
  const tokenHash = hashPasswordSetupToken(rawToken);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

  await prisma.passwordSetupToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt
    }
  });

  const resetLink = `${process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173"}/reset-password?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(user.email)}`;
  const loginLink = `${process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173"}/login?email=${encodeURIComponent(user.email)}`;

  await sendMail({
    to: user.email,
    subject: "Reset your ReSpark password",
    text: `Hi ${user.name},\n\nUse this secure link to set a new password:\n${resetLink}\n\nLogin page:\n${loginLink}\n`,
    html: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f7f4ef;color:#18212c;"><div style="max-width:620px;margin:0 auto;background:#fff;border-radius:24px;padding:28px;"><h2>Reset your password</h2><p>Hi ${user.name}, use the secure link below to choose a new password for your ReSpark account.</p><p><a href="${resetLink}" style="display:inline-block;background:#0f766e;color:#fff;padding:14px 18px;border-radius:999px;text-decoration:none;font-weight:700;">Set new password</a></p><p style="font-size:14px;">Login page: <a href="${loginLink}">${loginLink}</a></p></div></div>`
  });

  const isSandbox = !process.env.SMTP_HOST;
  if (isSandbox) {
    console.log("\n==================================================");
    console.log("RECOVERY LINK GENERATED (SMTP is NOT configured):");
    console.log(resetLink);
    console.log("==================================================\n");
  }

  return res.json({
    message: "If this email exists in the system, a password setup email has been sent.",
    resetLink: isSandbox ? resetLink : undefined
  });
});

authRouter.post("/validate-reset-token", validate(schemas.validateResetToken), async (req, res) => {
  const tokenHash = hashPasswordSetupToken(req.body.token);
  const token = await prisma.passwordSetupToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          memberships: true
        }
      }
    }
  });

  if (!token || token.usedAt || token.expiresAt < new Date()) {
    return res.status(400).json({ message: "This password setup link is invalid or expired." });
  }

  return res.json({
    valid: true,
    email: token.user.email,
    name: token.user.name
  });
});

authRouter.post("/reset-password", validate(schemas.resetPassword), async (req, res) => {
  const tokenHash = hashPasswordSetupToken(req.body.token);
  const token = await prisma.passwordSetupToken.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          memberships: true
        }
      }
    }
  });

  if (!token || token.usedAt || token.expiresAt < new Date()) {
    return res.status(400).json({ message: "This password setup link is invalid or expired." });
  }

  const passwordHash = await bcrypt.hash(req.body.password, 10);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: token.userId },
      data: {
        passwordHash,
        passwordSetupRequired: false
      }
    }),
    prisma.passwordSetupToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() }
    })
  ]);

  return res.json({
    message: "Password has been set successfully. You can now login.",
    email: token.user.email
  });
});
