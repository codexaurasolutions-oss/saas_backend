import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";
import { renderMessageTemplate } from "./messageTemplates.js";

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const getNotificationSettings = async (salonId) => {
  const row = await prisma.salonSetting.findFirst({
    where: { salonId, branchId: null },
    select: { advancedSettings: true }
  });
  return asObject(asObject(row?.advancedSettings).notificationSettings);
};

const nl2br = (value) => String(value || "").replace(/\n/g, "<br />");

export const sendCustomerTemplateEmail = async ({
  salonId,
  toEmail,
  templateType,
  context = {},
  extraVariables = {},
  subject = null
}) => {
  if (!toEmail) return { sent: false, reason: "missing_email" };
  const settings = await getNotificationSettings(salonId);
  if (settings.emailEnabled === false) return { sent: false, reason: "email_disabled" };

  const { template, variables, content } = await renderMessageTemplate({
    salonId,
    type: templateType,
    context,
    extraVariables
  });

  const finalSubject = subject || template.title || "Skillify update";
  const delivery = await sendMail({
    to: toEmail,
    subject: finalSubject,
    text: content,
    html: `<div style="font-family:Arial,sans-serif;padding:24px;background:#f7f4ef;color:#18212c;"><div style="max-width:620px;margin:0 auto;background:#fff;border-radius:24px;padding:28px;"><h2 style="margin-top:0;">${finalSubject}</h2><p style="font-size:15px;line-height:1.7;margin:0;">${nl2br(content)}</p></div></div>`
  });

  return {
    sent: true,
    delivery,
    subject: finalSubject,
    variables,
    content
  };
};

export const attemptCustomerTemplateEmail = async (payload) => {
  try {
    return await sendCustomerTemplateEmail(payload);
  } catch (error) {
    console.error("Customer email automation failed:", error?.message || error);
    return { sent: false, reason: "send_failed", error: error?.message || "Unknown email failure" };
  }
};
