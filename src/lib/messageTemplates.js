import { prisma } from "./prisma.js";
import { renderTemplateText, resolveTemplateContext } from "./phase3.js";

export const defaultMessageTemplates = {
  appointment_confirmation: {
    title: "Appointment Confirmation",
    content: "Hi {{customer_name}}, your appointment at {{salon_name}} is confirmed for {{appointment_date_time}}.",
    variables: ["customer_name", "salon_name", "appointment_date_time", "appointment_status", "branch_name"]
  },
  appointment_update: {
    title: "Appointment Update",
    content: "Hi {{customer_name}}, your appointment at {{salon_name}} is now {{appointment_status}} for {{appointment_date_time}} at {{branch_name}}.",
    variables: ["customer_name", "salon_name", "appointment_status", "appointment_date_time", "branch_name"]
  },
  appointment_reminder: {
    title: "Appointment Reminder",
    content: "Reminder: {{customer_name}}, your appointment at {{salon_name}} is on {{appointment_date_time}}.",
    variables: ["customer_name", "salon_name", "appointment_date_time"]
  },
  order_confirmation: {
    title: "Order Confirmation",
    content: "Hi {{customer_name}}, your order {{order_number}} at {{salon_name}} has been received. Total: {{order_amount}}.",
    variables: ["customer_name", "salon_name", "order_number", "order_amount"]
  },
  order_status_update: {
    title: "Order Update",
    content: "Hi {{customer_name}}, your order {{order_number}} at {{salon_name}} is now {{order_status}}.",
    variables: ["customer_name", "salon_name", "order_number", "order_status", "order_amount"]
  },
  invoice_template: {
    title: "Invoice Ready",
    content: "Hi {{customer_name}}, your invoice {{invoice_number}} for {{salon_name}} is ready. Total: {{invoice_amount}}. Balance: {{invoice_balance}}. {{payment_link}}",
    variables: ["customer_name", "salon_name", "invoice_number", "invoice_amount", "invoice_balance", "payment_link", "branch_name"]
  },
  payment_receipt_template: {
    title: "Payment Update",
    content: "Hi {{customer_name}}, we received your payment for invoice {{invoice_number}}. Paid: {{invoice_paid_amount}}. Balance: {{invoice_balance}}.",
    variables: ["customer_name", "invoice_number", "invoice_paid_amount", "invoice_balance", "invoice_amount", "salon_name"]
  },
  invoice_cancel_template: {
    title: "Invoice Cancelled",
    content: "Hi {{customer_name}}, your invoice {{invoice_number}} at {{salon_name}} has been cancelled.",
    variables: ["customer_name", "invoice_number", "salon_name", "branch_name"]
  },
  invoice_refund_template: {
    title: "Refund Processed",
    content: "Hi {{customer_name}}, a refund has been processed for invoice {{invoice_number}} at {{salon_name}}. Refunded: {{invoice_refund_amount}}.",
    variables: ["customer_name", "invoice_number", "salon_name", "invoice_refund_amount", "branch_name"]
  },
  membership_purchase_template: {
    title: "Membership Activated",
    content: "Hi {{customer_name}}, your membership {{membership_name}} is now active at {{salon_name}}. Price: {{membership_price}}. Valid till {{membership_expiry}}.",
    variables: ["customer_name", "salon_name", "membership_name", "membership_price", "membership_expiry"]
  },
  package_purchase_template: {
    title: "Package Activated",
    content: "Hi {{customer_name}}, your package {{package_name}} is now active at {{salon_name}}. Price: {{package_price}}. Remaining sessions: {{package_balance}}.",
    variables: ["customer_name", "salon_name", "package_name", "package_price", "package_balance"]
  },
  birthday_template: {
    title: "Birthday Message",
    content: "Happy Birthday {{customer_name}} from {{salon_name}}.",
    variables: ["customer_name", "salon_name"]
  },
  anniversary_template: {
    title: "Anniversary Message",
    content: "Happy Anniversary {{customer_name}} from {{salon_name}}.",
    variables: ["customer_name", "salon_name"]
  },
  campaign_template: {
    title: "Campaign Message",
    content: "Hi {{customer_name}}, explore the latest offers at {{salon_name}}: {{catalog_link}}",
    variables: ["customer_name", "salon_name", "catalog_link"]
  },
  membership_expiry_template: {
    title: "Membership Expiry",
    content: "Hi {{customer_name}}, your membership expires on {{membership_expiry}}.",
    variables: ["customer_name", "membership_expiry"]
  },
  package_expiry_template: {
    title: "Package Balance",
    content: "Hi {{customer_name}}, your remaining package balance is {{package_balance}}.",
    variables: ["customer_name", "package_balance"]
  },
  feedback_request_template: {
    title: "Feedback Request",
    content: "Hi {{customer_name}}, please share your feedback for {{salon_name}}.",
    variables: ["customer_name", "salon_name"]
  }
};

export const normalizeTemplateType = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

const sanitizeTemplateVariables = (variables, fallbackVariables = []) => {
  const normalizedFallback = Array.isArray(fallbackVariables) ? fallbackVariables : [];
  if (!Array.isArray(variables) || !variables.length) return normalizedFallback;

  const cleaned = variables
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  const looksLikeTemplateKeyList = cleaned.every((value) => Object.hasOwn(defaultMessageTemplates, normalizeTemplateType(value)));
  const hasRealVariables = cleaned.some((value) => value.includes("_") || /[A-Z]/.test(value));
  if (looksLikeTemplateKeyList) return normalizedFallback;
  return hasRealVariables ? cleaned : normalizedFallback;
};

export const ensureMessageTemplate = async (salonId, type) => {
  const normalizedType = normalizeTemplateType(type);
  const fallback = defaultMessageTemplates[normalizedType];
  if (!fallback) {
    const error = new Error("Template type not found");
    error.status = 404;
    throw error;
  }
  const existing = await prisma.messageTemplate.findUnique({
    where: { salonId_type: { salonId, type: normalizedType } }
  });
  if (existing) {
    const safeVariables = sanitizeTemplateVariables(existing.variables, fallback.variables);
    const needsDefaultTitle = !existing.title?.trim();
    const needsDefaultContent = !existing.content?.trim();
    const needsVariableRepair = JSON.stringify(safeVariables) !== JSON.stringify(existing.variables || []);
    if (needsDefaultTitle || needsDefaultContent || needsVariableRepair) {
      return prisma.messageTemplate.update({
        where: { id: existing.id },
        data: {
          title: needsDefaultTitle ? fallback.title : existing.title,
          content: needsDefaultContent ? fallback.content : existing.content,
          variables: safeVariables
        }
      });
    }
    return { ...existing, variables: safeVariables };
  }
  return prisma.messageTemplate.create({
    data: {
      salonId,
      type: normalizedType,
      title: fallback.title,
      content: fallback.content,
      variables: fallback.variables || []
    }
  });
};

export const renderMessageTemplate = async ({ salonId, type, context = {}, extraVariables = {} }) => {
  const template = await ensureMessageTemplate(salonId, type);
  const resolvedVariables = await resolveTemplateContext(salonId, context);
  const variables = { ...resolvedVariables, ...extraVariables };
  return {
    template,
    variables,
    content: renderTemplateText(template.content, variables)
  };
};
