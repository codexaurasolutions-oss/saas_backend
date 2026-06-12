import bcrypt from "bcryptjs";
import { prisma } from "./prisma.js";
import { defaultOwnerPermissions } from "./permissions.js";
import { generateRawPasswordSetupToken, generateTemporaryPassword, hashPasswordSetupToken } from "./passwordSetup.js";
import { sendMail } from "./mailer.js";
import { signLoginAccessToken } from "./tokens.js";

const frontendBaseUrl = () => process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173";

const slugify = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "demo-salon";

const createUniqueSlug = async (tx, baseLabel) => {
  const base = slugify(baseLabel);
  let slug = base;
  let counter = 1;
  while (await tx.salon.findUnique({ where: { slug } })) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return slug;
};

const buildInviteLink = ({ token, loginAccessToken, email }) =>
  `${frontendBaseUrl()}/reset-password?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}&access=${encodeURIComponent(loginAccessToken)}`;

const buildOwnerLoginLink = ({ email, loginAccessToken }) =>
  `${frontendBaseUrl()}/login?email=${encodeURIComponent(email)}&access=${encodeURIComponent(loginAccessToken)}`;

export const buildInviteEmail = ({ ownerName, salonName, trialEndsAt, inviteLink, loginLink }) => {
  const trialEndLabel = new Date(trialEndsAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric"
  });

  const subject = `Your Skillify demo is ready for ${salonName}`;
  const text = [
    `Hi ${ownerName},`,
    "",
    `Your 7-day Skillify trial for ${salonName} is now ready.`,
    `Trial ends: ${trialEndLabel}`,
    "",
    "Use this secure link to set your password:",
    inviteLink,
    "",
    "After setting your password, login here:",
    loginLink,
    "",
    "Regards,",
    "Skillify Team"
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;background:#f7f4ef;padding:32px;color:#18212c;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid rgba(24,33,44,0.08);">
        <p style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#8a4b08;margin:0 0 12px;">Skillify Demo Access</p>
        <h1 style="margin:0 0 14px;font-size:32px;line-height:1.15;">Your ${salonName} trial is ready.</h1>
        <p style="font-size:16px;line-height:1.7;margin:0 0 20px;">Hi ${ownerName}, your 7-day trial environment has been created. Set your password using the secure link below and then access your panel with your account email.</p>
        <div style="background:#fff7ed;border-radius:18px;padding:18px 20px;margin:0 0 20px;">
          <p style="margin:0;"><strong>Trial ends:</strong> ${trialEndLabel}</p>
        </div>
        <p style="margin:0 0 18px;"><a href="${inviteLink}" style="display:inline-block;background:linear-gradient(135deg,#c2410c,#0f766e);color:#fff;text-decoration:none;padding:14px 20px;border-radius:999px;font-weight:700;">Set your password</a></p>
        <p style="font-size:14px;line-height:1.7;margin:0 0 12px;">After setting the password, open your login page here:</p>
        <p style="margin:0 0 16px;"><a href="${loginLink}" style="color:#0f766e;">${loginLink}</a></p>
        <p style="font-size:13px;color:#516170;line-height:1.7;margin:0;">If the button does not open, copy this direct password-setup link:<br /><a href="${inviteLink}" style="color:#0f766e;">${inviteLink}</a></p>
      </div>
    </div>
  `;

  return { subject, text, html };
};

export const issuePasswordSetupToken = async ({ tx = prisma, userId, demoLeadId, expiresAt }) => {
  const rawToken = generateRawPasswordSetupToken();
  const tokenHash = hashPasswordSetupToken(rawToken);

  await tx.passwordSetupToken.create({
    data: {
      userId,
      demoLeadId: demoLeadId || null,
      tokenHash,
      expiresAt
    }
  });

  return rawToken;
};

export const approveDemoLead = async ({ leadId, actorName, trialDays = 7, planId, salonName, reviewNote, businessType }) => {
  const lead = await prisma.demoLead.findUnique({ where: { id: leadId } });
  if (!lead) {
    return { error: { status: 404, message: "Demo lead not found" } };
  }
  if (lead.status === "REJECTED") {
    return { error: { status: 400, message: "Rejected demo lead cannot be approved directly" } };
  }
  if (lead.status === "APPROVED" && lead.salonId && lead.approvedUserId) {
    return { error: { status: 400, message: "Demo lead is already approved. Use resend invite if needed." } };
  }

  const existingUser = await prisma.user.findUnique({ where: { email: lead.email } });
  if (existingUser) {
    return { error: { status: 400, message: "This email already belongs to an existing user. Use a different email or manage access manually." } };
  }

  const plan = planId
    ? await prisma.plan.findUnique({ where: { id: planId } })
    : await prisma.plan.findFirst({ orderBy: { monthlyPrice: "asc" } });

  if (!plan) {
    return { error: { status: 400, message: "At least one plan must exist before approving demo leads." } };
  }

  const startsAt = new Date();
  const endsAt = new Date(startsAt);
  endsAt.setDate(endsAt.getDate() + Number(trialDays || 7));

  const result = await prisma.$transaction(async (tx) => {
    const finalSalonName = salonName?.trim() || `${lead.name.split(" ")[0] || "Demo"} Salon`;
    const slug = await createUniqueSlug(tx, finalSalonName);
    const tempPassword = generateTemporaryPassword();
    const ownerPasswordHash = await bcrypt.hash(tempPassword, 10);

    const salon = await tx.salon.create({
      data: {
        name: finalSalonName,
        slug,
        email: lead.email,
        phone: lead.phone,
        businessType: businessType || "Salon",
        status: "TRIAL",
        trialStartsAt: startsAt,
        trialEndsAt: endsAt,
        featureFlags: plan.featureFlags || { pos: true, crm: true, reports: true, publicCatalog: true, digitalCatalog: true }
      }
    });

    const owner = await tx.user.create({
      data: {
        email: lead.email,
        name: lead.name,
        systemRole: "SALON_USER",
        passwordHash: ownerPasswordHash,
        passwordSetupRequired: true,
        isDemoAccount: true
      }
    });

    await tx.userSalon.create({
      data: {
        userId: owner.id,
        salonId: salon.id,
        salonRole: "SALON_OWNER",
        permissions: defaultOwnerPermissions
      }
    });

    const subscription = await tx.subscription.create({
      data: {
        salonId: salon.id,
        planId: plan.id,
        status: "TRIAL",
        paymentStatus: "PENDING",
        notes: "Auto-created from approved demo lead",
        startsAt,
        endsAt
      }
    });

    await tx.subscriptionHistory.create({
      data: {
        subscriptionId: subscription.id,
        action: "DEMO_APPROVED",
        createdBy: actorName,
        toStatus: "TRIAL",
        toPaymentStatus: "PENDING",
        notes: "7-day demo trial activated from demo lead approval"
      }
    });

    const rawToken = await issuePasswordSetupToken({
      tx,
      userId: owner.id,
      demoLeadId: lead.id,
      expiresAt: endsAt
    });

    const updatedLead = await tx.demoLead.update({
      where: { id: lead.id },
      data: {
        status: "APPROVED",
        salonId: salon.id,
        approvedUserId: owner.id,
        reviewedAt: new Date(),
        reviewedByName: actorName,
        reviewNote: reviewNote || "Approved for 7-day demo"
      }
    });

    return { salon, owner, subscription, rawToken, lead: updatedLead };
  });

  const loginAccessToken = signLoginAccessToken({
    userId: result.owner.id,
    email: result.owner.email,
    salonId: result.salon.id
  });
  const inviteLink = buildInviteLink({ token: result.rawToken, loginAccessToken, email: result.owner.email });
  const loginLink = buildOwnerLoginLink({ email: result.owner.email, loginAccessToken });
  const emailContent = buildInviteEmail({
    ownerName: result.owner.name,
    salonName: result.salon.name,
    trialEndsAt: result.subscription.endsAt,
    inviteLink,
    loginLink
  });

  let delivery;
  let emailError = null;
  try {
    delivery = await sendMail({
      to: result.owner.email,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html
    });

    await prisma.demoLead.update({
      where: { id: result.lead.id },
      data: { inviteSentAt: new Date() }
    });
  } catch (error) {
    emailError = error?.message || "SMTP delivery failed";
    delivery = { mode: "failed", messageId: null, preview: null };
  }

  return {
    leadId: result.lead.id,
    salon: result.salon,
    owner: result.owner,
    subscription: result.subscription,
    inviteLink,
    loginLink,
    delivery,
    emailError
  };
};

export const resendDemoInvite = async ({ leadId }) => {
  const lead = await prisma.demoLead.findUnique({ where: { id: leadId } });
  if (!lead || lead.status !== "APPROVED" || !lead.salonId || !lead.approvedUserId) {
    return { error: { status: 400, message: "Only approved demo leads can receive a resent invite." } };
  }

  const [owner, subscription, salon] = await Promise.all([
    prisma.user.findUnique({ where: { id: lead.approvedUserId } }),
    prisma.subscription.findFirst({
      where: { salonId: lead.salonId, status: { in: ["TRIAL", "ACTIVE"] } },
      orderBy: { endsAt: "desc" }
    }),
    prisma.salon.findUnique({ where: { id: lead.salonId } })
  ]);

  if (!owner || !subscription || !salon) {
    return { error: { status: 404, message: "Approved demo lead data is incomplete for resend." } };
  }

  const rawToken = await issuePasswordSetupToken({
    userId: owner.id,
    demoLeadId: lead.id,
    expiresAt: subscription.endsAt
  });

  const loginAccessToken = signLoginAccessToken({
    userId: owner.id,
    email: owner.email,
    salonId: salon.id
  });
  const inviteLink = buildInviteLink({ token: rawToken, salonId: salon.id, loginAccessToken, email: owner.email });
  const loginLink = buildOwnerLoginLink({ salonId: salon.id, email: owner.email, loginAccessToken });
  const emailContent = buildInviteEmail({
    ownerName: owner.name,
    salonName: salon.name,
    trialEndsAt: subscription.endsAt,
    inviteLink,
    loginLink,
    salonId: salon.id
  });

  let delivery;
  let emailError = null;
  try {
    delivery = await sendMail({
      to: owner.email,
      subject: emailContent.subject,
      text: emailContent.text,
      html: emailContent.html
    });

    await prisma.demoLead.update({
      where: { id: lead.id },
      data: { inviteSentAt: new Date() }
    });
  } catch (error) {
    emailError = error?.message || "SMTP delivery failed";
    delivery = { mode: "failed", messageId: null, preview: null };
  }

  return { inviteLink, loginLink, delivery, emailError };
};
