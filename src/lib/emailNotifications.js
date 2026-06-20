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
};
