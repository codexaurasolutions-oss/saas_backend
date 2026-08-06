import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { renderTemplateText, resolveTemplateContext } from "./phase3.js";
import { sendWhatsApp, isWhatsAppConfigured } from "./whatsappService.js";

const normalizeTemplateType = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

const fallbackTemplates = {
  invoice_template: {
    title: "Invoice from {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour invoice #{{invoice_number}} from {{salon_name}} is ready.\nAmount: {{invoice_amount}}\n\nView details: {{invoice_link}}\n\nThank you for visiting us!\n- {{salon_name}} Team"
  },
  invoice_refund_template: {
    title: "Refund Processed - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nA refund of {{invoice_amount}} has been processed against your invoice #{{invoice_number}} at {{salon_name}}.\n\nThe refund will reflect in your account within 5-7 business days.\n\n- {{salon_name}} Team"
  },
  invoice_cancel_template: {
    title: "Invoice Cancelled - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour invoice #{{invoice_number}} at {{salon_name}} has been cancelled.\n\nIf you have any questions, please reach out to us.\n\n- {{salon_name}} Team"
  },
  membership_purchase_template: {
    title: "Membership Activated - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nGreat news! Your membership \"{{membership_name}}\" at {{salon_name}} is now active.\n\nValid until: {{membership_expiry}}\n\nEnjoy your exclusive benefits! 🎉\n\n- {{salon_name}} Team"
  },
  package_purchase_template: {
    title: "Package Activated - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour package \"{{package_name}}\" at {{salon_name}} is now active!\nSessions remaining: {{package_balance}}\n\nBook your appointment to use your sessions.\n\n- {{salon_name}} Team"
  },
  payment_receipt_template: {
    title: "Payment Received - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nWe've received your payment of {{invoice_amount}} for invoice #{{invoice_number}} at {{salon_name}}.\n\nPayment link: {{payment_link}}\n\nThank you! 🙏\n\n- {{salon_name}} Team"
  },
  appointment_confirmation: {
    title: "Appointment Confirmed - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour appointment at {{salon_name}} is confirmed!\nDate & Time: {{appointment_date_time}}\n\nWe look forward to seeing you!\n\n- {{salon_name}} Team"
  },
  appointment_reminder: {
    title: "Appointment Reminder - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nThis is a friendly reminder about your upcoming appointment at {{salon_name}}.\nDate & Time: {{appointment_date_time}}\n\nSee you soon! 😊\n\n- {{salon_name}} Team"
  },
  appointment_cancelled: {
    title: "Appointment Cancelled - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour appointment at {{salon_name}} scheduled for {{appointment_date_time}} has been cancelled.\n\nNeed to rebook? Contact us anytime.\n\n- {{salon_name}} Team"
  },
  order_confirmation: {
    title: "Order Confirmed - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour order #{{order_number}} at {{salon_name}} has been confirmed!\nTotal: {{order_amount}}\n\nWe'll notify you when it's ready.\n\n- {{salon_name}} Team"
  },
  enquiry_follow_up: {
    title: "Follow Up - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nThank you for your enquiry with {{salon_name}}. Our team has an update for you.\n\nFeel free to reach out if you have any questions.\n\n- {{salon_name}} Team"
  },
  feedback_follow_up: {
    title: "Feedback Update - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nThank you for sharing your feedback with {{salon_name}}. We've reviewed it and our team has an update for you.\n\nYour feedback helps us serve you better! 🙏\n\n- {{salon_name}} Team"
  },
  feedback_request_template: {
    title: "How Was Your Visit? - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nThank you for visiting {{salon_name}}! We'd love to hear about your experience.\n\nShare your feedback here: {{feedback_link}}\n\nYour opinion matters to us! ⭐\n\n- {{salon_name}} Team"
  },
  birthday_offer_template: {
    title: "Happy Birthday! 🎂 - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nWishing you a very happy birthday from all of us at {{salon_name}}! 🎂🎉\n\nA special birthday offer awaits you — visit us to claim it!\n\nHave a wonderful day! 🎁\n\n- {{salon_name}} Team"
  },
  anniversary_offer_template: {
    title: "Happy Anniversary! 💍 - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nHappy anniversary from {{salon_name}}! 💍\n\nWe have a special anniversary offer just for you — come celebrate with us!\n\n- {{salon_name}} Team"
  },
  loyalty_earning_template: {
    title: "Loyalty Points Earned ⭐ - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYou just earned {{points_earned}} loyalty points at {{salon_name}}! ⭐\nYour new balance: {{new_balance}} points.\n\nKeep visiting to earn more rewards!\n\n- {{salon_name}} Team"
  },
  loyalty_expiry_template: {
    title: "Loyalty Points Expiring Soon ⚠️ - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour loyalty points at {{salon_name}} are expiring soon! ⚠️\n\nDon't let them go to waste — book your next visit today to use them.\n\n- {{salon_name}} Team"
  },
  membership_expiry_template: {
    title: "Membership Expiring Soon ⚠️ - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour membership \"{{membership_name}}\" at {{salon_name}} is expiring on {{membership_expiry}}.\n\nRenew now to keep enjoying your exclusive benefits!\n\n- {{salon_name}} Team"
  },
  membership_renewal_template: {
    title: "Membership Renewed 🎉 - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nGreat news! Your membership at {{salon_name}} has been successfully renewed!\nNew expiry: {{membership_expiry}}\n\nEnjoy your continued benefits! 🎉\n\n- {{salon_name}} Team"
  },
  package_expiry_template: {
    title: "Package Expiring Soon ⚠️ - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour package \"{{package_name}}\" at {{salon_name}} is expiring soon!\nSessions remaining: {{package_balance}}\n\nBook your appointment today to use your remaining sessions.\n\n- {{salon_name}} Team"
  },
  gift_card_issued: {
    title: "Gift Card Received 🎁 - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYou have received a gift card from {{salon_name}}! 🎁\nCode: {{gift_card_code}}\nBalance: {{gift_card_amount}}\n\nUse it on your next visit!\n\n- {{salon_name}} Team"
  },
  gift_card_expiry_template: {
    title: "Gift Card Expiring Soon 🎁 - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour gift card at {{salon_name}} is expiring soon! 🎁\n\nRedeem it before it expires — visit us today!\n\n- {{salon_name}} Team"
  },
  gift_card_redeemed_template: {
    title: "Gift Card Used 🎁 - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour gift card ({{gift_card_code}}) was used for {{amount_used}} at {{salon_name}}.\nRemaining balance: {{balance_amount}}\n\nThank you! 🎁\n\n- {{salon_name}} Team"
  },
  referral_code_sms: {
    title: "Your Referral Code 🎁 - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nHere is your referral code for {{salon_name}}: {{referral_code}} 🎁\n\nShare it with friends — both of you will be rewarded when they visit us!\n\n- {{salon_name}} Team"
  },
  referrer_reward_sms: {
    title: "Referral Reward Received! 🎉 - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nGreat news! You earned {{points_earned}} loyalty points at {{salon_name}} for referring a friend! 🎉\nNew balance: {{new_balance}} points.\n\nKeep sharing and keep earning!\n\n- {{salon_name}} Team"
  },
  welcome_email: {
    title: "Welcome to {{salon_name}}! 🎉",
    content: "Hi {{customer_name}},\n\nWelcome to {{salon_name}}! We're thrilled to have you.\n\nHere's what you can do:\n- Book appointments online\n- View your invoices and history\n- Earn loyalty points on every visit\n- Get exclusive offers and updates\n\nIf you have any questions, feel free to reach out to us.\n\nWe look forward to seeing you!\n\n- {{salon_name}} Team"
  }
};

/**
 * Resolve message template for sending.
 * Always uses latest fallbackTemplates content (not stale DB content).
 * DB templates are only for UI editing in the template manager.
 */
const resolveMessageTemplate = async (salonId, templateType) => {
  const normalizedType = normalizeTemplateType(templateType);
  const fallback = fallbackTemplates[normalizedType];
  if (!fallback) return null;

  // Ensure DB record exists (for UI/template manager)
  const existing = await prisma.messageTemplate.findUnique({
    where: { salonId_type: { salonId, type: normalizedType } }
  }).catch(() => null);

  if (!existing) {
    await prisma.messageTemplate.create({
      data: { salonId, type: normalizedType, title: fallback.title, content: fallback.content, variables: [] }
    }).catch(() => {});
  }

  // Always return latest fallback content for sending
  return { ...existing, title: fallback.title, content: fallback.content, type: normalizedType };
};

export const attemptCustomerTemplateEmail = async ({ salonId, toEmail, templateType, context = {} }) => {
  if (!toEmail) {
    return { skipped: true, reason: "missing-recipient" };
  }

  try {
    const template = await resolveMessageTemplate(salonId, templateType);
    if (!template?.content) {
      return { skipped: true, reason: "missing-template" };
    }

    const variables = await resolveTemplateContext(salonId, context);
    const html = renderTemplateText(template.content, variables);
    const subject = template.title || "Salon update";
    const delivery = await sendMail({
      to: toEmail,
      subject,
      html: `<div>${html}</div>`,
      text: html
    });

    return {
      skipped: false,
      templateType: template.type,
      delivery
    };
  } catch (error) {
    console.error(`[emailNotifications] Failed to send email of type ${templateType} to ${toEmail}:`, error);
    return {
      skipped: true,
      reason: "delivery-error",
      error: error.message
    };
  }
};

/**
 * Send a WhatsApp message using the same message template system.
 * Logs to WhatsAppLog for every attempt.
 */
export const attemptCustomerTemplateWhatsApp = async ({ salonId, toPhone, templateType, context = {}, customerId = null, branchId = null }) => {
  if (!toPhone) return { skipped: true, reason: "missing-phone" };
  if (!isWhatsAppConfigured()) return { skipped: true, reason: "whatsapp-not-configured" };

  try {
    const template = await resolveMessageTemplate(salonId, templateType);
    if (!template?.content) return { skipped: true, reason: "missing-template" };

    const variables = await resolveTemplateContext(salonId, context);
    const messageBody = renderTemplateText(template.content, variables);

    const result = await sendWhatsApp({
      salonId,
      to: toPhone,
      message: messageBody,
      customerId
    });

    await prisma.whatsAppLog.create({
      data: {
        salonId,
        customerId,
        phone: toPhone,
        templateType: template.type,
        message: messageBody,
        status: result.success ? "SENT" : "FAILED",
        metadata: {
          channel: "WHATSAPP_TRANSACTIONAL",
          branchId,
          context,
          messageId: result.messageId,
          error: result.error
        }
      }
    }).catch(() => {});

    return {
      skipped: false,
      templateType: template.type,
      success: result.success,
      messageId: result.messageId,
      error: result.error
    };
  } catch (error) {
    console.error(`[emailNotifications] WhatsApp failed for type ${templateType} to ${toPhone}:`, error);
    return { skipped: true, reason: "delivery-error", error: error.message };
  }
};

/**
 * Dispatch a transactional notification to a customer across all enabled channels.
 * Handles email + WhatsApp based on salon notification settings.
 * @param {Object} opts
 * @param {string} opts.salondId
 * @param {string} opts.templateType - e.g. "appointment_confirmation"
 * @param {string} [opts.toEmail]
 * @param {string} [opts.toPhone]
 * @param {string} [opts.customerId]
 * @param {string} [opts.branchId]
 * @param {Object} [opts.context] - template variables context
 * @param {Object} [opts.toggles] - from getNotificationToggles (pass to avoid re-fetching)
 */
export const dispatchTransactionalNotification = async ({ salonId, templateType, toEmail, toPhone, customerId, branchId = null, context = {}, toggles = null }) => {
  const toggleData = toggles || await (await import("./emailAutomation.js")).getNotificationToggles(salonId, branchId);
  const { isOn, emailEnabled, whatsappEnabled } = toggleData;

  const results = { email: null, whatsapp: null };

  if (toEmail && emailEnabled) {
    results.email = await attemptCustomerTemplateEmail({ salonId, toEmail, templateType, context }).catch(() => null);
  }

  if (toPhone && whatsappEnabled) {
    results.whatsapp = await attemptCustomerTemplateWhatsApp({ salonId, toPhone, templateType, context, customerId, branchId }).catch(() => null);
  }

  return results;
};
