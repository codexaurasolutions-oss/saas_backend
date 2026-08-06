import { prisma } from "../../../lib/prisma.js";
import { buildWhatsAppLink, renderTemplateText, resolveTemplateContext } from "../../../lib/phase3.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const defaultTemplates = {
  appointment_confirmation: {
    title: "Appointment Confirmed - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour appointment at {{salon_name}} is confirmed!\nDate & Time: {{appointment_date_time}}\n\nWe look forward to seeing you!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "appointment_date_time"]
  },
  appointment_reminder: {
    title: "Appointment Reminder - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nThis is a friendly reminder about your upcoming appointment at {{salon_name}}.\nDate & Time: {{appointment_date_time}}\n\nSee you soon!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "appointment_date_time"]
  },
  appointment_cancelled: {
    title: "Appointment Cancelled - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour appointment at {{salon_name}} scheduled for {{appointment_date_time}} has been cancelled.\n\nNeed to rebook? Contact us anytime.\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "appointment_date_time"]
  },
  order_confirmation: {
    title: "Order Confirmed - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour order #{{order_number}} at {{salon_name}} has been confirmed!\nTotal: {{order_amount}}\n\nWe'll notify you when it's ready.\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "order_number", "order_amount"]
  },
  invoice_template: {
    title: "Invoice from {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour invoice #{{invoice_number}} from {{salon_name}} is ready.\nAmount: {{invoice_amount}}\n\nView details: {{invoice_link}}\n\nThank you for visiting us!\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "invoice_number", "invoice_amount", "invoice_link", "payment_link"]
  },
  invoice_refund_template: {
    title: "Refund Processed - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nA refund of {{invoice_amount}} has been processed against your invoice #{{invoice_number}} at {{salon_name}}.\n\nThe refund will reflect in your account within 5-7 business days.\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "invoice_number", "invoice_amount"]
  },
  invoice_cancel_template: {
    title: "Invoice Cancelled - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour invoice #{{invoice_number}} at {{salon_name}} has been cancelled.\n\nIf you have any questions, please reach out to us.\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "invoice_number"]
  },
  payment_receipt_template: {
    title: "Payment Received - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nWe've received your payment of {{invoice_amount}} for invoice #{{invoice_number}} at {{salon_name}}.\n\nPayment link: {{payment_link}}\n\nThank you!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "invoice_number", "invoice_amount", "payment_link"]
  },
  membership_purchase_template: {
    title: "Membership Activated - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nGreat news! Your membership \"{{membership_name}}\" at {{salon_name}} is now active.\n\nValid until: {{membership_expiry}}\n\nEnjoy your exclusive benefits!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "membership_name", "membership_expiry"]
  },
  membership_expiry_template: {
    title: "Membership Expiring Soon - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour membership \"{{membership_name}}\" at {{salon_name}} is expiring on {{membership_expiry}}.\n\nRenew now to keep enjoying your exclusive benefits!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "membership_name", "membership_expiry"]
  },
  membership_renewal_template: {
    title: "Membership Renewed - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nGreat news! Your membership at {{salon_name}} has been successfully renewed!\nNew expiry: {{membership_expiry}}\n\nEnjoy your continued benefits!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "membership_expiry"]
  },
  package_purchase_template: {
    title: "Package Activated - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour package \"{{package_name}}\" at {{salon_name}} is now active!\nSessions remaining: {{package_balance}}\n\nBook your appointment to use your sessions.\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "package_name", "package_balance"]
  },
  package_expiry_template: {
    title: "Package Expiring Soon - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour package \"{{package_name}}\" at {{salon_name}} is expiring soon!\nSessions remaining: {{package_balance}}\n\nBook your appointment today to use your remaining sessions.\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "package_name", "package_balance"]
  },
  feedback_request_template: {
    title: "How Was Your Visit? - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nThank you for visiting {{salon_name}}! We'd love to hear about your experience.\n\nShare your feedback here: {{feedback_link}}\n\nYour opinion matters to us!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "feedback_link"]
  },
  birthday_template: {
    title: "Happy Birthday! - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nWishing you a very happy birthday from all of us at {{salon_name}}!\n\nA special birthday offer awaits you — visit us to claim it!\n\nHave a wonderful day!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name"]
  },
  birthday_offer_template: {
    title: "Happy Birthday! - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nWishing you a very happy birthday from all of us at {{salon_name}}!\n\nA special birthday offer awaits you — visit us to claim it!\n\nHave a wonderful day!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name"]
  },
  anniversary_template: {
    title: "Happy Anniversary! - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nHappy anniversary from {{salon_name}}!\n\nWe have a special anniversary offer just for you — come celebrate with us!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name"]
  },
  anniversary_offer_template: {
    title: "Happy Anniversary! - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nHappy anniversary from {{salon_name}}!\n\nWe have a special anniversary offer just for you — come celebrate with us!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name"]
  },
  campaign_template: {
    title: "Special Offer - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nExplore the latest offers at {{salon_name}}!\n{{catalog_link}}\n\nWe look forward to seeing you!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "catalog_link"]
  },
  enquiry_follow_up: {
    title: "Follow Up - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nThank you for your enquiry with {{salon_name}}. Our team has an update for you.\n\nFeel free to reach out if you have any questions.\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name"]
  },
  feedback_follow_up: {
    title: "Feedback Update - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nThank you for sharing your feedback with {{salon_name}}. We've reviewed it and our team has an update for you.\n\nYour feedback helps us serve you better!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name"]
  },
  loyalty_earning_template: {
    title: "Loyalty Points Earned - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYou just earned {{points_earned}} loyalty points at {{salon_name}}!\nYour new balance: {{new_balance}} points.\n\nKeep visiting to earn more rewards!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "points_earned", "new_balance"]
  },
  loyalty_expiry_template: {
    title: "Loyalty Points Expiring Soon - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour loyalty points at {{salon_name}} are expiring soon!\n\nDon't let them go to waste — book your next visit today to use them.\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name"]
  },
  referral_code_sms: {
    title: "Your Referral Code - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nHere is your referral code for {{salon_name}}: {{referral_code}}\n\nShare it with friends — both of you will be rewarded when they visit us!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "referral_code"]
  },
  referrer_reward_sms: {
    title: "Referral Reward Received! - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nGreat news! You earned {{points_earned}} loyalty points at {{salon_name}} for referring a friend!\nNew balance: {{new_balance}} points.\n\nKeep sharing and keep earning!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "points_earned", "new_balance"]
  },
  gift_card_issued: {
    title: "Gift Card Received - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYou have received a gift card from {{salon_name}}!\nCode: {{gift_card_code}}\nBalance: {{gift_card_amount}}\n\nUse it on your next visit!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "gift_card_code", "gift_card_amount"]
  },
  gift_card_expiry_template: {
    title: "Gift Card Expiring Soon - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour gift card at {{salon_name}} is expiring soon!\n\nRedeem it before it expires — visit us today!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name"]
  },
  gift_card_redeemed_template: {
    title: "Gift Card Used - {{salon_name}}",
    content: "Hi {{customer_name}},\n\nYour gift card ({{gift_card_code}}) was used for {{amount_used}} at {{salon_name}}.\nRemaining balance: {{balance_amount}}\n\nThank you!\n\n- {{salon_name}} Team",
    variables: ["customer_name", "salon_name", "gift_card_code", "amount_used", "balance_amount"]
  },
  welcome_email: {
    title: "Welcome to {{salon_name}}!",
    content: "Hi {{customer_name}},\n\nWelcome to {{salon_name}}! We're thrilled to have you.\n\nHere's what you can do:\n- Book appointments online\n- View your invoices and history\n- Earn loyalty points on every visit\n- Get exclusive offers and updates\n\nIf you have any questions, feel free to reach out to us.\n\nWe look forward to seeing you!\n\n- {{salon_name}} Team",
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
