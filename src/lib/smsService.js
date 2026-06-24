import { prisma } from "./prisma.js";

/**
 * SMS Provider interface.
 * Each provider implements send({ to, message, senderId }).
 * To add a real provider, set SMS_PROVIDER env var to its name and
 * implement the matching module below.
 */

const PLACEHOLDER_RESULT = async ({ to, message }) => {
  console.log(`[SMS STUB] would send to ${to}: ${message.slice(0, 80)}...`);
  return { success: true, provider: "stub", messageId: `stub_${Date.now()}` };
};

const providers = {
  stub: { send: PLACEHOLDER_RESULT },
  twilio: { send: PLACEHOLDER_RESULT },
  msg91: { send: PLACEHOLDER_RESULT },
  gupshup: { send: PLACEHOLDER_RESULT }
};

const getProvider = (name) => providers[String(name || "stub").toLowerCase()] || providers.stub;

export const sendSms = async ({ salonId, to, message, senderId }) => {
  if (!to || !message) {
    return { success: false, error: "to and message are required" };
  }
  const settings = await prisma.salonSetting.findFirst({
    where: { salonId, branchId: null },
    select: { smsSettings: true }
  });
  const smsSettings = settings?.smsSettings && typeof settings.smsSettings === "object"
    ? settings.smsSettings
    : { gatewayProvider: "stub", senderId: null, apiKey: null };

  const providerName = smsSettings.gatewayProvider || "stub";
  const provider = getProvider(providerName);

  try {
    const result = await provider.send({
      to,
      message,
      senderId: senderId || smsSettings.senderId || null
    });
    await prisma.auditLog.create({
      data: {
        salonId,
        module: "SMS",
        action: "SMS_SENT",
        entityType: "SMS",
        entityId: result.messageId || null,
        summary: `SMS sent to ${to} via ${providerName}`,
        metadata: { provider: providerName, messageLength: message.length }
      }
    }).catch(() => {});
    return { success: true, ...result };
  } catch (error) {
    await prisma.auditLog.create({
      data: {
        salonId,
        module: "SMS",
        action: "SMS_FAILED",
        entityType: "SMS",
        entityId: null,
        summary: `SMS failed to ${to}: ${error.message || "unknown error"}`,
        metadata: { provider: providerName, error: error.message }
      }
    }).catch(() => {});
    return { success: false, error: error.message || "SMS send failed" };
  }
};

export const getSmsSettings = async (salonId) => {
  const settings = await prisma.salonSetting.findFirst({
    where: { salonId, branchId: null },
    select: { smsSettings: true }
  });
  return settings?.smsSettings && typeof settings.smsSettings === "object"
    ? settings.smsSettings
    : { gatewayProvider: "stub", senderId: null, apiKey: null };
};
