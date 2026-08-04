import nodemailer from "nodemailer";

let transporter = null;

const CONNECTION_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 30000);
const SEND_TIMEOUT_MS = 30000;
const MAX_RETRIES = 2;

const smtpConfigured = () =>
  !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_PORT &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.SMTP_FROM
  );

const createTransporter = () => {
  if (!smtpConfigured()) {
    console.warn("[mailer] SMTP is not configured.");
    return nodemailer.createTransport({
      jsonTransport: true,
    });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: String(process.env.SMTP_SECURE) === "true",

    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },

    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });

  return transporter;
};

export const getMailer = () => {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
};

export const verifyMailer = async () => {
  try {
    await getMailer().verify();
    console.log("✅ SMTP Connected Successfully");
    return true;
  } catch (err) {
    console.error("❌ SMTP Verify Failed");
    console.error(err);
    return false;
  }
};

const stripHtml = (html) => {
  if (!html) return "";

  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const sendMail = async (options) => {
  if (!smtpConfigured()) {
    console.log("[mailer] SMTP not configured.");
    return;
  }

  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      const info = await getMailer().sendMail({
        from: process.env.SMTP_FROM,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || stripHtml(options.html),
        attachments: options.attachments || [],
      });

      console.log("✅ Email Sent:", info.messageId);

      return info;
    } catch (err) {
      lastError = err;

      console.error(
        `[mailer] Attempt ${attempt}/${MAX_RETRIES + 1} failed`
      );

      console.error(err);

      transporter = null;

      if (attempt <= MAX_RETRIES) {
        await sleep(2000);
      }
    }
  }

  throw lastError;
};

export const mailerStatus = () => ({
  configured: smtpConfigured(),
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  user: process.env.SMTP_USER,
  from: process.env.SMTP_FROM,
});
