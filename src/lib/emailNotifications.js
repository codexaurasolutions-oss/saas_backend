import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { renderTemplateText, resolveTemplateContext } from "./phase3.js";

const normalizeTemplateType = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

const fallbackTemplates = {
  invoice_template: {
    title: "Invoice Update",
    content: "Hi {{customer_name}}, your invoice amount is {{invoice_amount}}."
  },
  invoice_refund_template: {
    title: "Invoice Refund",
    content: "Hi {{customer_name}}, a refund has been processed against your invoice."
  },
  invoice_cancel_template: {
    title: "Invoice Cancelled",
    content: "Hi {{customer_name}}, your invoice has been cancelled."
  },
  membership_purchase_template: {
    title: "Membership Activated",
    content: "Hi {{customer_name}}, your membership is now active."
  },
  package_purchase_template: {
    title: "Package Activated",
    content: "Hi {{customer_name}}, your package is now active."
  },
  payment_receipt_template: {
    title: "Payment Receipt",
    content: "Hi {{customer_name}}, we have received your payment for {{invoice_amount}}."
  },
  appointment_confirmation: {
    title: "Appointment Confirmation",
    content: "Hi {{customer_name}}, your appointment at {{salon_name}} is confirmed for {{appointment_date_time}}."
  },
  appointment_reminder: {
    title: "Appointment Reminder",
    content: "Reminder: {{customer_name}}, your appointment at {{salon_name}} is on {{appointment_date_time}}."
  },
  appointment_cancelled: {
    title: "Appointment Cancelled",
    content: "Hi {{customer_name}}, your appointment at {{salon_name}} scheduled for {{appointment_date_time}} has been cancelled."
  },
  order_confirmation: {
    title: "Order Confirmation",
    content: "Hi {{customer_name}}, your order {{order_number}} at {{salon_name}} has been received. Total: {{order_amount}}."
  },
  enquiry_follow_up: {
    title: "Enquiry Follow Up",
    content: "Hi {{customer_name}}, thank you for your enquiry with {{salon_name}}. Our team has shared a follow-up update for you."
  },
  feedback_follow_up: {
    title: "Feedback Follow Up",
    content: "Hi {{customer_name}}, thank you for sharing your feedback with {{salon_name}}. Our team has added an update and will stay in touch."
  },
  feedback_request_template: {
    title: "Feedback Request",
    content: "Hi {{customer_name}}, thank you for your visit at {{salon_name}}! We'd love to hear from you. Share your feedback here: {{feedback_link}}"
  },
  birthday_offer_template: {
    title: "Happy Birthday!",
    content: "Hi {{customer_name}}, wishing you a very happy birthday from all of us at {{salon_name}}! 🎂 A special birthday offer awaits you — visit us to claim it."
  },
  anniversary_offer_template: {
    title: "Happy Anniversary!",
    content: "Hi {{customer_name}}, happy anniversary from {{salon_name}}! 💍 We have a special offer just for you — come celebrate with us."
  },
  loyalty_earning_template: {
    title: "Loyalty Points Earned",
    content: "Hi {{customer_name}}, you just earned {{points_earned}} loyalty points at {{salon_name}}! 🌟 Your new balance is {{new_balance}} points."
  },
  loyalty_expiry_template: {
    title: "Loyalty Points Expiring Soon",
    content: "Hi {{customer_name}}, your loyalty points at {{salon_name}} are expiring soon! Don't let them go to waste — book your next visit today."
  },
  membership_expiry_template: {
    title: "Membership Expiring Soon",
    content: "Hi {{customer_name}}, your membership at {{salon_name}} is expiring on {{membership_expiry}}. Renew now to keep enjoying your exclusive benefits!"
  },
  membership_renewal_template: {
    title: "Membership Renewed",
    content: "Hi {{customer_name}}, great news! Your membership at {{salon_name}} has been successfully renewed until {{membership_expiry}}. Enjoy your continued benefits! 🎉"
  },
  package_expiry_template: {
    title: "Package Expiring Soon",
    content: "Hi {{customer_name}}, your package at {{salon_name}} is expiring soon! You have {{package_balance}} sessions remaining — book your appointment today."
  },
  gift_card_issued: {
    title: "Gift Card Received",
    content: "Hi {{customer_name}}, you have received a gift card from {{salon_name}}! 🎁 Code: {{gift_card_code}} | Balance: ₹{{gift_card_amount}}. Use it on your next visit!"
  },
  gift_card_expiry_template: {
    title: "Gift Card Expiring Soon",
    content: "Hi {{customer_name}}, your gift card at {{salon_name}} is expiring soon! Redeem it before it expires."
  },
  gift_card_redeemed_template: {
    title: "Gift Card Used",
    content: "Hi {{customer_name}}, your gift card ({{gift_card_code}}) was used for ₹{{amount_used}} at {{salon_name}}. Remaining balance: ₹{{balance_amount}}."
  },
  referral_code_sms: {
    title: "Your Referral Code",
    content: "Hi {{customer_name}}, here is your referral code for {{salon_name}}: {{referral_code}} 🎁 Share it with friends — both of you will be rewarded when they visit us!"
  },
  referrer_reward_sms: {
    title: "Referral Reward Received!",
    content: "Hi {{customer_name}}, great news! You earned {{points_earned}} loyalty points at {{salon_name}} for referring a friend. 🎉 Keep sharing and keep earning!"
  }
};

const resolveMessageTemplate = async (salonId, templateType) => {
  const normalizedType = normalizeTemplateType(templateType);
  const existing = await prisma.messageTemplate.findUnique({
    where: { salonId_type: { salonId, type: normalizedType } }
  });
  if (existing) return existing;
  const fallback = fallbackTemplates[normalizedType];
  if (!fallback) return null;
  return prisma.messageTemplate.create({
    data: {
      salonId,
      type: normalizedType,
      title: fallback.title,
      content: fallback.content,
      variables: []
    }
  });
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
