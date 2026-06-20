import { prisma } from "./prisma.js";
import { attemptCustomerTemplateEmail } from "./emailNotifications.js";
import { sendMail } from "./mailer.js";
import { buildWhatsAppLink, getCampaignAudience, renderTemplateText, resolveTemplateContext } from "./phase3.js";
import { createAuditLog } from "./phase4.js";

const DEFAULT_SCHEDULER_INTERVAL_MS = Number(process.env.EMAIL_SCHEDULER_INTERVAL_MS || 60_000);
const DEFAULT_REMINDER_LOOKAHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const FEEDBACK_APPOINTMENT_ACTION = "AUTO_FEEDBACK_REQUEST_SENT";
const FEEDBACK_INVOICE_ACTION = "AUTO_FEEDBACK_REQUEST_SENT";
const REMINDER_ACTION = "REMINDER_EMAIL_SENT";

const toPlainObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const getSalonAutomationSettings = async (salonId, branchId = null) => {
  const [branchSetting, globalSetting] = await Promise.all([
    branchId
      ? prisma.salonSetting.findFirst({
          where: { salonId, branchId }
        })
      : Promise.resolve(null),
    prisma.salonSetting.findFirst({
      where: { salonId, branchId: null }
    })
  ]);

  const effective = branchSetting || globalSetting || null;
  const advancedSettings = toPlainObject(effective?.advancedSettings);
  const genericSettings = toPlainObject(advancedSettings.genericSettings);
  const notificationSettings = toPlainObject(advancedSettings.notificationSettings);

  return {
    row: effective,
    advancedSettings,
    genericSettings,
    notificationSettings
  };
};

const isEmailAutomationEnabled = (settings) => settings.notificationSettings.emailEnabled !== false;

const isReminderAutomationEnabled = (settings) =>
  isEmailAutomationEnabled(settings) &&
  settings.genericSettings.appointmentBookingEnabled !== false;

const getReminderWindowMs = (settings) => {
  const days = Math.max(0, toNumber(settings.genericSettings.appointmentReminderDays, 1));
  const hours = Math.max(0, toNumber(settings.genericSettings.appointmentReminderHours, 1));
  return (days * 24 + hours) * 60 * 60 * 1000;
};

const alreadySentAppointmentLog = async (appointmentId, action, marker) =>
  prisma.appointmentLog.findFirst({
    where: {
      appointmentId,
      action,
      ...(marker
        ? {
            details: {
              contains: marker
            }
          }
        : {})
    }
  });

const createReminderLog = async (appointmentId, details) =>
  prisma.appointmentLog.create({
    data: {
      appointmentId,
      action: REMINDER_ACTION,
      details
    }
  });

const createFeedbackAudit = async ({
  salonId,
  actorUserId = null,
  actorMembershipId = null,
  entityType,
  entityId,
  summary,
  metadata
}) =>
  createAuditLog({
    salonId,
    actorUserId,
    actorMembershipId,
    module: "FEEDBACK",
    action: entityType === "Appointment" ? FEEDBACK_APPOINTMENT_ACTION : FEEDBACK_INVOICE_ACTION,
    entityType,
    entityId,
    summary,
    metadata
  });

const feedbackAuditExists = async ({ salonId, entityType, entityId }) =>
  prisma.auditLog.findFirst({
    where: {
      salonId,
      module: "FEEDBACK",
      action: entityType === "Appointment" ? FEEDBACK_APPOINTMENT_ACTION : FEEDBACK_INVOICE_ACTION,
      entityType,
      entityId
    }
  });

export const maybeSendFeedbackRequestForAppointment = async ({
  salonId,
  appointmentId,
  actorUserId = null,
  actorMembershipId = null
}) => {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, salonId },
    include: {
      customer: true
    }
  });
  if (!appointment?.customer?.email) {
    return { skipped: true, reason: "missing-recipient" };
  }
  if (String(appointment.status || "").toUpperCase() !== "COMPLETED") {
    return { skipped: true, reason: "appointment-not-completed" };
  }

  const alreadySent = await feedbackAuditExists({
    salonId,
    entityType: "Appointment",
    entityId: appointment.id
  });
  if (alreadySent) {
    return { skipped: true, reason: "already-sent" };
  }

  const delivery = await attemptCustomerTemplateEmail({
    salonId,
    toEmail: appointment.customer.email,
    templateType: "feedback_request_template",
    context: {
      appointmentId: appointment.id,
      customerId: appointment.customerId
    }
  });

  if (!delivery.skipped) {
    await createFeedbackAudit({
      salonId,
      actorUserId,
      actorMembershipId,
      entityType: "Appointment",
      entityId: appointment.id,
      summary: "Automatic feedback request email sent after appointment completion",
      metadata: {
        customerId: appointment.customerId,
        templateType: "feedback_request_template"
      }
    });
  }

  return delivery;
};

export const maybeSendFeedbackRequestForInvoice = async ({
  salonId,
  invoiceId,
  actorUserId = null,
  actorMembershipId = null
}) => {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, salonId },
    include: {
      customer: true,
      appointment: true
    }
  });
  if (!invoice?.customer?.email) {
    return { skipped: true, reason: "missing-recipient" };
  }
  if (String(invoice.status || "").toUpperCase() !== "PAID") {
    return { skipped: true, reason: "invoice-not-paid" };
  }
  if (invoice.appointmentId) {
    const appointmentFeedbackSent = await feedbackAuditExists({
      salonId,
      entityType: "Appointment",
      entityId: invoice.appointmentId
    });
    if (appointmentFeedbackSent) {
      return { skipped: true, reason: "appointment-feedback-already-sent" };
    }
  }

  const alreadySent = await feedbackAuditExists({
    salonId,
    entityType: "Invoice",
    entityId: invoice.id
  });
  if (alreadySent) {
    return { skipped: true, reason: "already-sent" };
  }

  const delivery = await attemptCustomerTemplateEmail({
    salonId,
    toEmail: invoice.customer.email,
    templateType: "feedback_request_template",
    context: {
      invoiceId: invoice.id,
      customerId: invoice.customerId
    }
  });

  if (!delivery.skipped) {
    await createFeedbackAudit({
      salonId,
      actorUserId,
      actorMembershipId,
      entityType: "Invoice",
      entityId: invoice.id,
      summary: "Automatic feedback request email sent after invoice payment",
      metadata: {
        customerId: invoice.customerId,
        templateType: "feedback_request_template"
      }
    });
  }

  return delivery;
};

const sendCampaignEmail = async ({ salonId, campaign, customer }) => {
  if (!customer?.email) {
    return { skipped: true, reason: "missing-email" };
  }
  const variables = await resolveTemplateContext(salonId, {
    customerId: customer.id
  });
  const renderedBody = renderTemplateText(campaign.message || "", variables);
  return sendMail({
    to: customer.email,
    subject: campaign.name || "Salon Campaign",
    html: `<div>${renderedBody}</div>`,
    text: renderedBody
  });
};

export const dispatchCampaign = async ({
  salonId,
  campaignId,
  actorUserId = null,
  actorMembershipId = null
}) => {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, salonId }
  });
  if (!campaign) {
    const error = new Error("Campaign not found");
    error.status = 404;
    throw error;
  }

  const audience = await getCampaignAudience(salonId, campaign.audienceFilter, campaign.audienceMeta || {});
  const reachable = [];
  const skipped = [];

  for (const customer of audience) {
    if (campaign.type === "EMAIL") {
      if (customer.email) reachable.push(customer);
      else skipped.push({ id: customer.id, name: customer.name, reason: "Missing email address" });
      continue;
    }

    if (customer.phone) reachable.push(customer);
    else skipped.push({ id: customer.id, name: customer.name, reason: "Missing phone number" });
  }

  const deliveries = [];
  let whatsappLink = null;

  if (campaign.type === "EMAIL") {
    const results = await Promise.allSettled(
      reachable.map((customer) => sendCampaignEmail({ salonId, campaign, customer }))
    );
    results.forEach((result, index) => {
      const customer = reachable[index];
      if (result.status === "fulfilled") {
        deliveries.push({
          customerId: customer.id,
          customerName: customer.name,
          channel: "EMAIL",
          success: true
        });
      } else {
        deliveries.push({
          customerId: customer.id,
          customerName: customer.name,
          channel: "EMAIL",
          success: false,
          error: result.reason?.message || "Email delivery failed"
        });
      }
    });
  } else if (campaign.type === "WHATSAPP" && reachable[0]?.phone) {
    whatsappLink = buildWhatsAppLink(reachable[0].phone, campaign.message || "");
  }

  const sentCount = deliveries.filter((entry) => entry.success).length;
  const failedCount = deliveries.filter((entry) => !entry.success).length;
  const status = campaign.type === "EMAIL"
    ? sentCount > 0 && failedCount === 0
      ? "SENT"
      : sentCount > 0
        ? "PARTIAL"
        : "FAILED"
    : "SENT";

  const updatedCampaign = await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      status,
      sentAt: new Date()
    }
  });

  await prisma.campaignLog.create({
    data: {
      campaignId: campaign.id,
      eventType: campaign.type === "EMAIL" ? "EMAIL_DISPATCHED" : "SENT_PLACEHOLDER",
      details: `Audience matched ${audience.length}, reachable ${reachable.length}, sent ${sentCount}, failed ${failedCount}, skipped ${skipped.length}`
    }
  });

  await createAuditLog({
    salonId,
    actorUserId,
    actorMembershipId,
    module: "CAMPAIGNS",
    action: campaign.type === "EMAIL" ? "EMAIL_SENT" : "PLACEHOLDER_SENT",
    entityType: "Campaign",
    entityId: campaign.id,
    summary: `Campaign ${campaign.name} processed`,
    metadata: {
      type: campaign.type,
      audienceCount: audience.length,
      reachableCount: reachable.length,
      sentCount,
      failedCount,
      skippedCount: skipped.length
    }
  });

  return {
    campaign: updatedCampaign,
    audienceCount: audience.length,
    reachableCount: reachable.length,
    sentCount,
    failedCount,
    skippedCount: skipped.length,
    skippedPreview: skipped.slice(0, 20),
    deliveryPreview: deliveries.slice(0, 20),
    whatsappLink
  };
};

export const processScheduledCampaigns = async () => {
  const dueCampaigns = await prisma.campaign.findMany({
    where: {
      status: "SCHEDULED",
      scheduledFor: {
        lte: new Date()
      }
    },
    orderBy: { scheduledFor: "asc" }
  });

  const results = [];
  for (const campaign of dueCampaigns) {
    try {
      results.push(await dispatchCampaign({ salonId: campaign.salonId, campaignId: campaign.id }));
    } catch (error) {
      await prisma.campaignLog.create({
        data: {
          campaignId: campaign.id,
          eventType: "SCHEDULE_FAILED",
          details: error.message || "Scheduled campaign dispatch failed"
        }
      });
    }
  }
  return results;
};

export const processAppointmentReminderEmails = async () => {
  const now = new Date();
  const upperBound = new Date(now.getTime() + DEFAULT_REMINDER_LOOKAHEAD_MS);
  const appointments = await prisma.appointment.findMany({
    where: {
      status: {
        in: ["PENDING", "CONFIRMED"]
      },
      startAt: {
        gte: now,
        lte: upperBound
      }
    },
    include: {
      customer: true
    },
    orderBy: { startAt: "asc" }
  });

  const results = [];

  for (const appointment of appointments) {
    if (!appointment.customer?.email) continue;
    const settings = await getSalonAutomationSettings(appointment.salonId, appointment.branchId);
    if (!isReminderAutomationEnabled(settings)) continue;

    const reminderWindowMs = getReminderWindowMs(settings);
    const msUntilStart = new Date(appointment.startAt).getTime() - now.getTime();
    if (msUntilStart < 0 || msUntilStart > reminderWindowMs) continue;

    const reminderMarker = `reminder-window:${reminderWindowMs}`;
    const alreadySent = await alreadySentAppointmentLog(appointment.id, REMINDER_ACTION, reminderMarker);
    if (alreadySent) continue;

    const delivery = await attemptCustomerTemplateEmail({
      salonId: appointment.salonId,
      toEmail: appointment.customer.email,
      templateType: "appointment_reminder",
      context: {
        appointmentId: appointment.id,
        customerId: appointment.customerId
      }
    });

    if (!delivery.skipped) {
      await createReminderLog(
        appointment.id,
        `${reminderMarker}; sent-at:${new Date().toISOString()}`
      );
      results.push({ appointmentId: appointment.id, sent: true });
    }
  }

  return results;
};

let schedulerHandle = null;
let schedulerRunning = false;

const runEmailAutomationPass = async () => {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    await processScheduledCampaigns();
    await processAppointmentReminderEmails();
  } catch (error) {
    console.error("Email automation pass failed", error);
  } finally {
    schedulerRunning = false;
  }
};

export const startEmailScheduler = () => {
  if (schedulerHandle) return schedulerHandle;
  schedulerHandle = setInterval(runEmailAutomationPass, DEFAULT_SCHEDULER_INTERVAL_MS);
  runEmailAutomationPass().catch((error) => {
    console.error("Initial email automation pass failed", error);
  });
  return schedulerHandle;
};
