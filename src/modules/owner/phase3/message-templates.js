import { prisma } from "../../../lib/prisma.js";
import { buildWhatsAppLink, renderTemplateText, resolveTemplateContext } from "../../../lib/phase3.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const defaultTemplates = {
  appointment_confirmation: {
    title: "Appointment Confirmation",
    content: "Hi {{customer_name}}, your appointment at {{salon_name}} is confirmed for {{appointment_date_time}}.",
    variables: ["customer_name", "salon_name", "appointment_date_time"]
  },
  appointment_reminder: {
    title: "Appointment Reminder",
    content: "Reminder: {{customer_name}}, your appointment at {{salon_name}} is on {{appointment_date_time}}.",
    variables: ["customer_name", "salon_name", "appointment_date_time"]
  },
  appointment_cancelled: {
    title: "Appointment Cancelled",
    content: "Hi {{customer_name}}, your appointment at {{salon_name}} scheduled for {{appointment_date_time}} has been cancelled.",
    variables: ["customer_name", "salon_name", "appointment_date_time"]
  },
  order_confirmation: {
    title: "Order Confirmation",
    content: "Hi {{customer_name}}, your order {{order_number}} at {{salon_name}} has been received. Total: {{order_amount}}.",
    variables: ["customer_name", "salon_name", "order_number", "order_amount"]
  },
  invoice_template: {
    title: "Invoice Message",
    content: "Hi {{customer_name}}, your invoice amount is {{invoice_amount}}.",
    variables: ["customer_name", "invoice_amount", "payment_link"]
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
  },
  enquiry_follow_up: {
    title: "Enquiry Follow Up",
    content: "Hi {{customer_name}}, thank you for your enquiry with {{salon_name}}. Our team has shared a follow-up update for you.",
    variables: ["customer_name", "salon_name"]
  },
  feedback_follow_up: {
    title: "Feedback Follow Up",
    content: "Hi {{customer_name}}, thank you for sharing your feedback with {{salon_name}}. Our team has added an update and will stay in touch.",
    variables: ["customer_name", "salon_name"]
  }
};

const normalizeTemplateType = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

const sanitizeTemplateVariables = (variables, fallbackVariables = []) => {
  const normalizedFallback = Array.isArray(fallbackVariables) ? fallbackVariables : [];
  if (!Array.isArray(variables) || !variables.length) return normalizedFallback;

  const cleaned = variables
    .filter((value) => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  const looksLikeTemplateKeyList = cleaned.every((value) => Object.hasOwn(defaultTemplates, normalizeTemplateType(value)));
  const hasRealVariables = cleaned.some((value) => value.includes("_") || /[A-Z]/.test(value));
  if (looksLikeTemplateKeyList) return normalizedFallback;
  return hasRealVariables ? cleaned : normalizedFallback;
};

const ensureTemplate = async (salonId, type) => {
  const normalizedType = normalizeTemplateType(type);
  const fallback = defaultTemplates[normalizedType];
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
    if (
      needsDefaultTitle ||
      needsDefaultContent ||
      needsVariableRepair
    ) {
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

export const registerMessageTemplateRoutes = (ownerRouter) => {
  ownerRouter.get("/message-templates", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "view"), async (req, res) => {
    const rows = await Promise.all(Object.keys(defaultTemplates).map((type) => ensureTemplate(req.salonId, type)));
    res.json(rows);
  });
  ownerRouter.get("/message-templates/:type", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "view"), async (req, res) => {
    res.json(await ensureTemplate(req.salonId, req.params.type));
  });
  ownerRouter.patch("/message-templates/:type", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "edit"), validate(schemas.messageTemplate), async (req, res) => {
    const row = await ensureTemplate(req.salonId, req.params.type);
    res.json(await prisma.messageTemplate.update({
      where: { id: row.id },
      data: {
        title: req.body.title,
        content: req.body.content,
        variables: req.body.variables || row.variables || []
      }
    }));
  });
  ownerRouter.post("/message-templates/:type/preview", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "view"), validate(schemas.messageTemplatePreview), async (req, res) => {
    const row = await ensureTemplate(req.salonId, req.params.type);
    const variables = await resolveTemplateContext(req.salonId, req.body);
    const content = renderTemplateText(row.content, variables);
    const whatsappLink = buildWhatsAppLink(req.body.phone || variables.customer_phone || "", content);
    res.json({
      template: row,
      variables,
      preview: content,
      whatsappLink
    });
  });
  ownerRouter.post("/message-templates/:type/reset", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "edit"), async (req, res) => {
    const normalizedType = normalizeTemplateType(req.params.type);
    const fallback = defaultTemplates[normalizedType];
    if (!fallback) return res.status(404).json({ message: "Template type not found" });
    const row = await ensureTemplate(req.salonId, normalizedType);
    res.json(await prisma.messageTemplate.update({
      where: { id: row.id },
      data: { title: fallback.title, content: fallback.content, variables: fallback.variables || [] }
    }));
  });
};
