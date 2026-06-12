import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { signLoginAccessToken } from "./tokens.js";

const frontendBaseUrl = () => process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173";

const formatDate = (value) =>
  new Date(value).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

const getSalonOwner = async (salonId) => {
  const membership = await prisma.userSalon.findFirst({
    where: { salonId, salonRole: "SALON_OWNER" },
    include: { user: true }
  });
  return membership?.user || null;
};

export const buildTrialReminderEmail = ({ ownerName, salonName, endsAt, loginLink, daysLeft }) => {
  const subject = `${salonName} trial expires in ${daysLeft} day(s)`;
  const text = [
    `Hi ${ownerName},`,
    "",
    `Your Skillify trial for ${salonName} expires on ${formatDate(endsAt)}.`,
    "",
    `Login here: ${loginLink}`,
    "",
    "If you want to continue without interruption, please upgrade your subscription before the trial ends.",
    "",
    "Skillify Team"
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;background:#f7f4ef;padding:32px;color:#18212c;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid rgba(24,33,44,0.08);">
        <p style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#8a4b08;margin:0 0 12px;">Trial Reminder</p>
        <h1 style="margin:0 0 14px;font-size:30px;line-height:1.15;">Your trial expires in ${daysLeft} day(s).</h1>
        <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">Hi ${ownerName}, your Skillify trial for <strong>${salonName}</strong> ends on <strong>${formatDate(endsAt)}</strong>.</p>
        <div style="background:#fff7ed;border-radius:18px;padding:18px 20px;margin:0 0 20px;">
          <p style="margin:0;"><strong>Login link:</strong> <a href="${loginLink}" style="color:#0f766e;">Open panel</a></p>
        </div>
        <p style="margin:0;color:#516170;line-height:1.7;">Upgrade before the trial ends if you want uninterrupted access.</p>
      </div>
    </div>
  `;

  return { subject, text, html };
};

export const buildConversionEmail = ({ ownerName, salonName, planName, endsAt, loginLink }) => {
  const subject = `${salonName} is now active on ${planName}`;
  const text = [
    `Hi ${ownerName},`,
    "",
    `${salonName} has been converted from trial to the ${planName} plan.`,
    `Subscription active until: ${formatDate(endsAt)}`,
    "",
    `Login here: ${loginLink}`,
    "",
    "Skillify Team"
  ].join("\n");

  const html = `
    <div style="font-family:Arial,sans-serif;background:#f7f4ef;padding:32px;color:#18212c;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid rgba(24,33,44,0.08);">
        <p style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#0f766e;margin:0 0 12px;">Subscription Active</p>
        <h1 style="margin:0 0 14px;font-size:30px;line-height:1.15;">Your trial has been converted successfully.</h1>
        <p style="font-size:16px;line-height:1.7;margin:0 0 18px;">Hi ${ownerName}, <strong>${salonName}</strong> is now active on the <strong>${planName}</strong> plan.</p>
        <div style="background:#ecfeff;border-radius:18px;padding:18px 20px;margin:0 0 20px;">
          <p style="margin:0 0 8px;"><strong>Active until:</strong> ${formatDate(endsAt)}</p>
          <p style="margin:0;"><a href="${loginLink}" style="color:#0f766e;">Open login page</a></p>
        </div>
      </div>
    </div>
  `;

  return { subject, text, html };
};

export const sendTrialReminder = async ({ subscriptionId, actorName }) => {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { salon: true, plan: true }
  });
  if (!subscription) return { error: { status: 404, message: "Subscription not found" } };
  if (subscription.status !== "TRIAL") {
    return { error: { status: 400, message: "Only trial subscriptions can receive trial reminders." } };
  }

  const owner = await getSalonOwner(subscription.salonId);
  if (!owner) return { error: { status: 404, message: "No salon owner found for this subscription." } };

  const loginAccessToken = signLoginAccessToken({
    userId: owner.id,
    email: owner.email,
    salonId: subscription.salon.id
  });
  const loginLink = `${frontendBaseUrl()}/login?email=${encodeURIComponent(owner.email)}&access=${encodeURIComponent(loginAccessToken)}`;
  const diffMs = new Date(subscription.endsAt) - new Date();
  const daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
  const email = buildTrialReminderEmail({
    ownerName: owner.name,
    salonName: subscription.salon.name,
    endsAt: subscription.endsAt,
    loginLink,
    daysLeft
  });

  let delivery;
  let emailError = null;
  try {
    delivery = await sendMail({
      to: owner.email,
      subject: email.subject,
      text: email.text,
      html: email.html
    });
  } catch (error) {
    emailError = error?.message || "Reminder email failed";
    delivery = { mode: "failed", messageId: null, preview: null };
  }

  const updated = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { reminderSentAt: new Date() }
  });

  await prisma.subscriptionHistory.create({
    data: {
      subscriptionId: subscription.id,
      action: "TRIAL_REMINDER_SENT",
      createdBy: actorName,
      fromStatus: subscription.status,
      toStatus: subscription.status,
      fromPaymentStatus: subscription.paymentStatus || "PENDING",
      toPaymentStatus: subscription.paymentStatus || "PENDING",
      notes: `Trial reminder sent for ${daysLeft} day(s) remaining`
    }
  });

  return { subscription: updated, ownerEmail: owner.email, loginLink, delivery, emailError };
};

export const convertDemoToPaid = async ({ subscriptionId, actorName, planId, endsAt, paymentStatus, manualDiscount, notes }) => {
  const existing = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { salon: true, plan: true }
  });
  if (!existing) return { error: { status: 404, message: "Subscription not found" } };
  if (!["TRIAL", "ACTIVE"].includes(existing.status)) {
    return { error: { status: 400, message: "Only trial or active subscriptions can be converted through this flow." } };
  }

  const targetPlan = planId && planId !== existing.planId
    ? await prisma.plan.findUnique({ where: { id: planId } })
    : existing.plan;
  if (!targetPlan) return { error: { status: 404, message: "Selected plan not found." } };

  const owner = await getSalonOwner(existing.salonId);
  if (!owner) return { error: { status: 404, message: "No salon owner found for this subscription." } };

  const activeUntil = endsAt ? new Date(endsAt) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: "ACTIVE",
        planId: targetPlan.id,
        paymentStatus: paymentStatus || "PAID",
        manualDiscount: manualDiscount != null ? Number(manualDiscount) : existing.manualDiscount,
        notes: notes ?? existing.notes,
        startsAt: new Date(),
        endsAt: activeUntil,
        convertedAt: new Date()
      }
    });

    await tx.salon.update({
      where: { id: existing.salonId },
      data: {
        status: "ACTIVE"
      }
    });

    await tx.subscriptionHistory.create({
      data: {
        subscriptionId: row.id,
        action: "DEMO_CONVERTED",
        createdBy: actorName,
        fromStatus: existing.status,
        toStatus: "ACTIVE",
        fromPaymentStatus: existing.paymentStatus || "PENDING",
        toPaymentStatus: paymentStatus || "PAID",
        notes: notes || `Converted from demo to paid on ${targetPlan.name}`
      }
    });

    return tx.subscription.findUnique({
      where: { id: row.id },
      include: { salon: true, plan: true, history: { orderBy: { createdAt: "desc" } } }
    });
  });

  const loginAccessToken = signLoginAccessToken({
    userId: owner.id,
    email: owner.email,
    salonId: existing.salon.id
  });
  const loginLink = `${frontendBaseUrl()}/login?email=${encodeURIComponent(owner.email)}&access=${encodeURIComponent(loginAccessToken)}`;
  const email = buildConversionEmail({
    ownerName: owner.name,
    salonName: existing.salon.name,
    planName: targetPlan.name,
    endsAt: activeUntil,
    loginLink
  });

  let delivery;
  let emailError = null;
  try {
    delivery = await sendMail({
      to: owner.email,
      subject: email.subject,
      text: email.text,
      html: email.html
    });
  } catch (error) {
    emailError = error?.message || "Conversion email failed";
    delivery = { mode: "failed", messageId: null, preview: null };
  }

  return { subscription: updated, ownerEmail: owner.email, loginLink, delivery, emailError };
};
