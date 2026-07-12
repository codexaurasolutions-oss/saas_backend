import { prisma } from "./prisma.js";

/**
 * WhatsApp Business Cloud API service.
 *
 * Required env vars:
 *   WHATSAPP_PHONE_NUMBER_ID  — Phone number ID from Meta Business Suite
 *   WHATSAPP_ACCESS_TOKEN     — Permanent access token from Meta
 *   WHATSAPP_BUSINESS_NAME    — Business display name (optional, for logging)
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v18.0";
const WHATSAPP_BASE_URL = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;
const WHATSAPP_TIMEOUT_MS = Number(process.env.WHATSAPP_TIMEOUT_MS || 15000);

/* ── Core send function ────────────────────────────────────────────── */
const sendWhatsAppMessage = async ({ to, message, templateName, templateParams, imageUrl }) => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp credentials missing: set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN");
  }

  const phone = String(to).replace(/[^\d]/g, "");

  let body;
  if (templateName) {
    // Template message (for first contact or outside 24hr window)
    body = {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en_US" },
        components: templateParams?.length ? [{ type: "body", parameters: templateParams.map((p) => ({ type: "text", text: p })) }] : []
      }
    };
  } else if (imageUrl) {
    // Image message
    body = {
      messaging_product: "whatsapp",
      to: phone,
      type: "image",
      image: { link: imageUrl, caption: message || "" }
    };
  } else {
    // Text message (within 24hr customer-service window)
    body = {
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body: message || "" }
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHATSAPP_TIMEOUT_MS);

  try {
    const res = await fetch(`${WHATSAPP_BASE_URL}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const data = await res.json();
    if (!res.ok) {
      const errMsg = data.error?.message || `WhatsApp API HTTP ${res.status}`;
      throw new Error(errMsg);
    }

    const messageId = data.messages?.[0]?.id || null;
    return { success: true, provider: "whatsapp_cloud", messageId };
  } finally {
    clearTimeout(timer);
  }
};

/* ── Public API ────────────────────────────────────────────────────── */
export const sendWhatsApp = async ({ salonId, to, message, customerId, campaignId, templateName, templateParams, imageUrl }) => {
  if (!to) return { success: false, error: "Phone number required" };

  const result = { success: false, provider: "whatsapp_cloud", messageId: null };

  try {
    const sendResult = await sendWhatsAppMessage({ to, message, templateName, templateParams, imageUrl });
    result.success = true;
    result.messageId = sendResult.messageId;

    await prisma.auditLog.create({
      data: {
        salonId,
        module: "WHATSAPP",
        action: "WHATSAPP_SENT",
        entityType: "WhatsAppLog",
        entityId: sendResult.messageId,
        summary: `WhatsApp sent to ${to}`,
        metadata: { provider: "whatsapp_cloud", messageId: sendResult.messageId }
      }
    }).catch(() => {});
  } catch (error) {
    result.error = error.message;
    await prisma.auditLog.create({
      data: {
        salonId,
        module: "WHATSAPP",
        action: "WHATSAPP_FAILED",
        entityType: "WhatsAppLog",
        entityId: null,
        summary: `WhatsApp failed to ${to}: ${error.message}`,
        metadata: { error: error.message }
      }
    }).catch(() => {});
  }

  return result;
};

export const sendWhatsAppBulk = async ({ salonId, recipients, message, templateName, templateParams }) => {
  if (!recipients?.length) return { sent: 0, failed: 0, results: [] };

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const phone = recipient.phone || recipient;
    const customerId = recipient.customerId || null;
    const campaignId = recipient.campaignId || null;

    const result = await sendWhatsApp({ salonId, to: phone, message, customerId, campaignId, templateName, templateParams });

    await prisma.whatsAppLog.create({
      data: {
        salonId,
        customerId,
        campaignId,
        phone,
        templateType: templateName || "manual",
        message: message || "",
        status: result.success ? "SENT" : "FAILED",
        metadata: { channel: "WHATSAPP", messageId: result.messageId, error: result.error }
      }
    }).catch(() => {});

    if (result.success) sent++;
    else failed++;
    results.push({ phone, ...result });
  }

  return { sent, failed, results };
};

export const getWhatsAppSettings = async (salonId) => {
  const settings = await prisma.whatsAppSetting.findFirst({ where: { salonId } });
  return settings || null;
};

export const isWhatsAppConfigured = () => {
  return Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN);
};
