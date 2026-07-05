import nodemailer from "nodemailer";

let transporter;

const DEFAULT_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 10000);

const smtpConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_FROM);

const createTransporter = () => {
  if (smtpConfigured()) {
    const isGmail = (process.env.SMTP_HOST || "").toLowerCase().includes("gmail") || 
                    (process.env.SMTP_SERVICE || "").toLowerCase() === "gmail";

    if (isGmail) {
      return nodemailer.createTransport({
        service: "gmail",
        auth: process.env.SMTP_USER
          ? {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS || ""
            }
          : undefined
      });
    }

    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: String(process.env.SMTP_SECURE || "false") === "true",
      connectionTimeout: DEFAULT_TIMEOUT_MS,
      greetingTimeout: DEFAULT_TIMEOUT_MS,
      socketTimeout: DEFAULT_TIMEOUT_MS,
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS || ""
          }
        : undefined
    });
  }

  return nodemailer.createTransport({
    jsonTransport: true
  });
};

export const getMailer = () => {
  if (!transporter) transporter = createTransporter();
  return transporter;
};

export const mailerMode = () => (smtpConfigured() ? "smtp" : "json");

const withTimeout = async (promise, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Email delivery timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export const sendMail = async (options) => {
  const mail = await withTimeout(
    getMailer().sendMail({
      from: process.env.SMTP_FROM || "ReSpark <no-reply@respark.local>",
      ...options
    }),
    DEFAULT_TIMEOUT_MS
  );

  return {
    mode: mailerMode(),
    messageId: mail.messageId || null,
    preview: typeof mail.message === "string" ? mail.message : null
  };
};
