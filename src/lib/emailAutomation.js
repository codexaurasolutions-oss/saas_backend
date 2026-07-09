import { prisma } from "./prisma.js";
import { attemptCustomerTemplateEmail } from "./emailNotifications.js";
import { sendMail } from "./mailer.js";
import { buildWhatsAppLink, getCampaignAudience, renderTemplateText, resolveTemplateContext } from "./phase3.js";
import { createAuditLog, createStaffNotification, createCustomerNotification } from "./phase4.js";

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

/**
 * Central gate: returns true if a named notification toggle is ON (or not explicitly set to false).
 * Also checks the top-level emailEnabled flag for email-type toggles.
 * toggleKey matches the keys in advancedSettings.notificationSettings.toggles.
 */
export const getNotificationToggles = async (salonId, branchId = null) => {
  const settings = await getSalonAutomationSettings(salonId, branchId);
  const toggles = toPlainObject(settings.notificationSettings.toggles);
  const emailEnabled = settings.notificationSettings.emailEnabled !== false;
  const smsEnabled = settings.notificationSettings.smsEnabled !== false;
  const whatsappEnabled = settings.notificationSettings.whatsappEnabled !== false;
  const pushEnabled = settings.notificationSettings.pushEnabled === true;

  /**
   * isOn(key) — returns true if toggle key is ON (default ON if not set).
   */
  const isOn = (key) => toggles[key] !== false;

  return { isOn, emailEnabled, smsEnabled, whatsappEnabled, pushEnabled, toggles };
};

const isEmailAutomationEnabled = (settings) => settings.notificationSettings.emailEnabled !== false;

const isReminderAutomationEnabled = (settings) =>
  isEmailAutomationEnabled(settings) &&
  settings.genericSettings.appointmentBookingEnabled !== false &&
  // respect reminder toggles (default: ON if not set)
  settings.notificationSettings.toggles?.appointmentReminderBeforeDays !== false &&
  settings.notificationSettings.toggles?.appointmentReminderBeforeHours !== false &&
  settings.notificationSettings.toggles?.messageForAppointments !== false &&
  settings.notificationSettings.toggles?.smsForServiceReminder !== false;

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


// ─── Lifecycle notification processor ────────────────────────────────────────
// Runs once per scheduler tick and dispatches birthday, anniversary, loyalty,
// membership, package, and gift card expiry notifications.

export const processLifecycleNotifications = async () => {
  const now = new Date();
  const todayStr = `${now.getMonth() + 1}-${now.getDate()}`; // MM-DD for birthday/anniversary match
  const results = { birthday: 0, anniversary: 0, loyaltyExpiry: 0, membershipExpiry: 0, packageExpiry: 0, giftCardExpiry: 0 };

  // Get all distinct salonIds that have settings
  const salonIds = await prisma.salonSetting.findMany({
    where: { branchId: null },
    select: { salonId: true }
  }).then((rows) => rows.map((r) => r.salonId));

  for (const salonId of salonIds) {
    const { isOn, emailEnabled } = await getNotificationToggles(salonId).catch(() => ({ isOn: () => false, emailEnabled: false }));

    // ── Birthday Offer ────────────────────────────────────────────────────────
    if (isOn("birthdayOffer") && emailEnabled) {
      const birthdayCustomers = await prisma.customer.findMany({
        where: { salonId, dateOfBirth: { not: null } }
      });
      for (const customer of birthdayCustomers) {
        if (!customer.email || !customer.dateOfBirth) continue;
        const bday = new Date(customer.dateOfBirth);
        const bdayStr = `${bday.getMonth() + 1}-${bday.getDate()}`;
        if (bdayStr !== todayStr) continue;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "BIRTHDAY_EMAIL_SENT", entityId: customer.id,
            createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } }
        });
        if (alreadySent) continue;
        await attemptCustomerTemplateEmail({ salonId, toEmail: customer.email, templateType: "birthday_offer_template", context: { customerId: customer.id } }).catch(() => {});
        await createCustomerNotification({ salonId, customerId: customer.id, title: "🎂 Happy Birthday!", message: "Wishing you a wonderful birthday! A special offer awaits you." }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "BIRTHDAY_EMAIL_SENT", entityType: "Customer", entityId: customer.id, summary: "Birthday offer email sent" }).catch(() => {});
        results.birthday++;
      }
    }

    // ── Anniversary Offer ─────────────────────────────────────────────────────
    if (isOn("anniversaryOffer") && emailEnabled) {
      const anniversaryCustomers = await prisma.customer.findMany({
        where: { salonId, anniversary: { not: null } }
      });
      for (const customer of anniversaryCustomers) {
        if (!customer.email || !customer.anniversary) continue;
        const anniv = new Date(customer.anniversary);
        const anniversaryStr = `${anniv.getMonth() + 1}-${anniv.getDate()}`;
        if (anniversaryStr !== todayStr) continue;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "ANNIVERSARY_EMAIL_SENT", entityId: customer.id,
            createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) } }
        });
        if (alreadySent) continue;
        await attemptCustomerTemplateEmail({ salonId, toEmail: customer.email, templateType: "anniversary_offer_template", context: { customerId: customer.id } }).catch(() => {});
        await createCustomerNotification({ salonId, customerId: customer.id, title: "💍 Happy Anniversary!", message: "Wishing you a beautiful anniversary! Enjoy a special offer today." }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "ANNIVERSARY_EMAIL_SENT", entityType: "Customer", entityId: customer.id, summary: "Anniversary offer email sent" }).catch(() => {});
        results.anniversary++;
      }
    }

    // ── Loyalty Expiry Reminder ───────────────────────────────────────────────
    if (isOn("loyaltyExpiryReminder") && emailEnabled) {
      const expiringIn7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const expiringLoyalty = await prisma.loyaltyTransaction.findMany({
        where: { salonId, type: "EARN", expiresAt: { gte: now, lte: expiringIn7Days } },
        include: { customer: true }
      });
      for (const txn of expiringLoyalty) {
        if (!txn.customer?.email) continue;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "LOYALTY_EXPIRY_SENT", entityId: txn.id,
            createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        });
        if (alreadySent) continue;
        await attemptCustomerTemplateEmail({ salonId, toEmail: txn.customer.email, templateType: "loyalty_expiry_template", context: { customerId: txn.customerId } }).catch(() => {});
        await createCustomerNotification({ salonId, customerId: txn.customerId, title: "⚠️ Loyalty Points Expiring", message: `Your loyalty points expire in 7 days. Redeem them now!` }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "LOYALTY_EXPIRY_SENT", entityType: "LoyaltyTransaction", entityId: txn.id, summary: "Loyalty expiry reminder sent" }).catch(() => {});
        results.loyaltyExpiry++;
      }
    }

    // ── Membership Expiry & Renewal ───────────────────────────────────────────
    if (isOn("membershipExpiry") && emailEnabled) {
      const expiringIn3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const expiringMemberships = await prisma.customerMembership.findMany({
        where: { salonId, status: "ACTIVE", endsAt: { gte: now, lte: expiringIn3Days } },
        include: { customer: true, membershipPlan: true }
      });
      for (const mem of expiringMemberships) {
        if (!mem.customer?.email) continue;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "MEMBERSHIP_EXPIRY_SENT", entityId: mem.id,
            createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        });
        if (alreadySent) continue;
        await attemptCustomerTemplateEmail({ salonId, toEmail: mem.customer.email, templateType: "membership_expiry_template", context: { customerId: mem.customerId, customerMembershipId: mem.id } }).catch(() => {});
        await createCustomerNotification({ salonId, customerId: mem.customerId, title: "⚠️ Membership Expiring Soon", message: `Your "${mem.membershipPlan?.name || 'membership'}" expires in 3 days. Renew now!` }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "MEMBERSHIP_EXPIRY_SENT", entityType: "CustomerMembership", entityId: mem.id, summary: "Membership expiry reminder sent" }).catch(() => {});
        results.membershipExpiry++;
      }
    }

    // ── Package Expiry Reminder ───────────────────────────────────────────────
    if (isOn("packageExpiryReminder") && emailEnabled) {
      const expiringIn3Days = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const expiringPackages = await prisma.customerPackage.findMany({
        where: { salonId, status: "ACTIVE", endsAt: { gte: now, lte: expiringIn3Days } },
        include: { customer: true, package: true }
      });
      for (const pkg of expiringPackages) {
        if (!pkg.customer?.email) continue;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "PACKAGE_EXPIRY_SENT", entityId: pkg.id,
            createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        });
        if (alreadySent) continue;
        await attemptCustomerTemplateEmail({ salonId, toEmail: pkg.customer.email, templateType: "package_expiry_template", context: { customerId: pkg.customerId, customerPackageId: pkg.id } }).catch(() => {});
        await createCustomerNotification({ salonId, customerId: pkg.customerId, title: "⚠️ Package Expiring Soon", message: `Your "${pkg.package?.name || 'package'}" expires in 3 days.` }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "PACKAGE_EXPIRY_SENT", entityType: "CustomerPackage", entityId: pkg.id, summary: "Package expiry reminder sent" }).catch(() => {});
        results.packageExpiry++;
      }
    }

    // ── Gift Card Expiry Reminder ─────────────────────────────────────────────
    if (isOn("giftCardExpiryReminder") && emailEnabled) {
      const expiringIn7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      const expiringGiftCards = await prisma.giftCard.findMany({
        where: { salonId, isActive: true, expiresAt: { gte: now, lte: expiringIn7Days } },
        include: { issuedToCustomer: true }
      });
      for (const gc of expiringGiftCards) {
        const customer = gc.issuedToCustomer;
        if (!customer?.email) continue;
        const alreadySent = await prisma.auditLog.findFirst({
          where: { salonId, module: "LIFECYCLE", action: "GIFTCARD_EXPIRY_SENT", entityId: gc.id,
            createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } }
        });
        if (alreadySent) continue;
        await attemptCustomerTemplateEmail({ salonId, toEmail: customer.email, templateType: "gift_card_expiry_template", context: { customerId: customer.id, giftCardId: gc.id } }).catch(() => {});
        await createCustomerNotification({ salonId, customerId: customer.id, title: "🎁 Gift Card Expiring Soon", message: `Your gift card (${gc.code || gc.id}) expires in 7 days. Use it before it expires!` }).catch(() => {});
        await createAuditLog({ salonId, module: "LIFECYCLE", action: "GIFTCARD_EXPIRY_SENT", entityType: "GiftCard", entityId: gc.id, summary: "Gift card expiry reminder sent" }).catch(() => {});
        results.giftCardExpiry++;
      }
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
    await processLifecycleNotifications();
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
