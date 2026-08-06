import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { signAccessToken, signRefreshToken, verifyLoginAccessToken, verifyRefreshToken, signTempToken, verifyTempToken } from "../../lib/tokens.js";
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

const generateLoginPayload = async (user, membership) => {
  const [salon, subscription] = membership
    ? await Promise.all([
        prisma.salon.findUnique({ where: { id: membership.salonId }, select: { name: true, featureFlags: true } }),
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
      : (await (async () => {
          if (membership.customRoleId) {
            const customRole = await prisma.customRole.findFirst({ where: { id: membership.customRoleId, salonId: membership.salonId } });
            if (customRole) {
              return { ...(membership.permissions || {}), ...(customRole.permissions || {}) };
            }
          }
          return membership.permissions || {};
        })())
    : null;

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, systemRole: user.systemRole },
    membership: membership
      ? {
          salonId: membership.salonId,
          salonName: salon?.name || membership.salon?.name || null,
          salonRole: membership.salonRole,
          branchId: membership.branchId || null,
          customRoleId: membership.customRoleId || null,
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
  };
};

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
  if (user.systemRole === "SALON_USER" && membership?.salonRole === "SALON_OWNER") {
    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`\n🔑 [LOGIN OTP] User: ${user.email} | OTP: ${otp}\n`);
    const tempToken = signTempToken({ userId: user.id, salonId: membership.salonId, otp });
    
    // Send email asynchronously so we don't block the login response
    sendMail({
      to: user.email,
      subject: "Your SalonNest Login OTP",
      html: `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:40px 20px;"><tr><td align="center">
        <div style="max-width:480px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0;">
          <div style="background:linear-gradient(135deg,#111827 0%,#1f2937 50%,#374151 100%);padding:36px;text-align:center;">
            <h1 style="margin:0 0 4px;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">SalonNest</h1>
            <p style="margin:0;font-size:12px;color:#c8a97e;letter-spacing:1.5px;text-transform:uppercase;">Login Verification</p>
          </div>
          <div style="padding:36px;text-align:center;">
            <p style="margin:0 0 8px;font-size:15px;color:#374151;">Hi,</p>
            <p style="margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.6;">Use the following OTP to complete your login:</p>
            <div style="background:#faf6f0;border:2px dashed #c8a97e;border-radius:16px;padding:24px;margin:0 0 28px;">
              <p style="margin:0 0 8px;font-size:11px;color:#9ca3af;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Your One-Time Password</p>
              <p style="margin:0;font-size:40px;font-weight:900;color:#111827;letter-spacing:8px;font-family:monospace;">${otp}</p>
            </div>
            <div style="background:#fef3c7;border-radius:12px;padding:14px 18px;margin:0 0 24px;">
              <p style="margin:0;font-size:13px;color:#92400e;line-height:1.5;">
                <strong>⏰ Valid for 10 minutes</strong><br>
                Do not share this code with anyone.
              </p>
            </div>
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">If you didn't request this login, please ignore this email or contact support.</p>
          </div>
          <div style="background:#111827;padding:20px;text-align:center;border-radius:0 0 20px 20px;">
            <p style="margin:0;font-size:12px;color:#6b7280;">SalonNest ERP &mdash; Automated Security Email</p>
          </div>
        </div>
        </td></tr></table>
        </body></html>
      `
    }).catch(err => console.error("[Login OTP Email Error]", err));

    return res.json({
      requireOtp: true,
      tempToken,
      otp
    });
  }

  const payload = await generateLoginPayload(user, membership);
  res.json(payload);
});

authRouter.post("/verify-otp", async (req, res) => {
  const { tempToken, otp } = req.body;
  if (!tempToken || !otp) return res.status(400).json({ message: "Token and OTP are required" });

  try {
    const decoded = verifyTempToken(tempToken);
    if (decoded.otp !== otp) {
      return res.status(401).json({ message: "Invalid OTP" });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: {
        memberships: {
          include: { salon: true }
        }
      }
    });

    if (!user) return res.status(404).json({ message: "User not found" });

    const activeMemberships = sortMemberships(
      (user.memberships || []).filter((membership) => membership?.salon?.status !== "SUSPENDED")
    );
    const membership = activeMemberships.find((item) => item.salonId === decoded.salonId) || activeMemberships[0] || null;

    const payload = await generateLoginPayload(user, membership);
    res.json(payload);
  } catch (err) {
    res.status(401).json({ message: "Invalid or expired token" });
  }
});

authRouter.post("/resend-otp", async (req, res) => {
  const { tempToken } = req.body;
  if (!tempToken) return res.status(400).json({ message: "Token is required" });

  try {
    const decoded = verifyTempToken(tempToken);
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) return res.status(404).json({ message: "User not found" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`\n🔑 [RESEND OTP] User: ${user.email} | OTP: ${otp}\n`);
    const newTempToken = signTempToken({ userId: decoded.userId, salonId: decoded.salonId, otp });

    await sendMail({
      to: user.email,
      subject: "Your SalonNest Login OTP",
      html: `
        <!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;">
        <table width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:40px 20px;"><tr><td align="center">
        <div style="max-width:480px;width:100%;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #e2e8f0;">
          <div style="background:linear-gradient(135deg,#111827 0%,#1f2937 50%,#374151 100%);padding:36px;text-align:center;">
            <h1 style="margin:0 0 4px;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">SalonNest</h1>
            <p style="margin:0;font-size:12px;color:#c8a97e;letter-spacing:1.5px;text-transform:uppercase;">Login Verification</p>
          </div>
          <div style="padding:36px;text-align:center;">
            <p style="margin:0 0 8px;font-size:15px;color:#374151;">Hi,</p>
            <p style="margin:0 0 28px;font-size:14px;color:#6b7280;line-height:1.6;">Use the following OTP to complete your login:</p>
            <div style="background:#faf6f0;border:2px dashed #c8a97e;border-radius:16px;padding:24px;margin:0 0 28px;">
              <p style="margin:0 0 8px;font-size:11px;color:#9ca3af;letter-spacing:2px;text-transform:uppercase;font-weight:700;">Your One-Time Password</p>
              <p style="margin:0;font-size:40px;font-weight:900;color:#111827;letter-spacing:8px;font-family:monospace;">${otp}</p>
            </div>
            <div style="background:#fef3c7;border-radius:12px;padding:14px 18px;margin:0 0 24px;">
              <p style="margin:0;font-size:13px;color:#92400e;line-height:1.5;">
                <strong>⏰ Valid for 10 minutes</strong><br>
                Do not share this code with anyone.
              </p>
            </div>
            <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.5;">If you didn't request this login, please ignore this email or contact support.</p>
          </div>
          <div style="background:#111827;padding:20px;text-align:center;border-radius:0 0 20px 20px;">
            <p style="margin:0;font-size:12px;color:#6b7280;">SalonNest ERP &mdash; Automated Security Email</p>
          </div>
        </div>
        </td></tr></table>
        </body></html>
      `
    });

    res.json({
      tempToken: newTempToken,
      otp
    });
  } catch (err) {
    res.status(401).json({ message: "Invalid or expired token" });
  }
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
    subject: "Reset your SalonNest password",
    text: `Hi ${user.name},\n\nUse this secure link to set a new password:\n${resetLink}\n\nLogin page:\n${loginLink}\n`,
    html: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f7f4ef;color:#18212c;"><div style="max-width:620px;margin:0 auto;background:#fff;border-radius:24px;padding:28px;"><h2>Reset your password</h2><p>Hi ${user.name}, use the secure link below to choose a new password for your SalonNest account.</p><p><a href="${resetLink}" style="display:inline-block;background:#c8a97e;color:#fff;padding:14px 18px;border-radius:999px;text-decoration:none;font-weight:700;">Set new password</a></p><p style="font-size:14px;">Login page: <a href="${loginLink}" style="color:#c8a97e;">${loginLink}</a></p></div></div>`
  });

  return res.json({ message: "If this email exists in the system, a password setup email has been sent." });
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
