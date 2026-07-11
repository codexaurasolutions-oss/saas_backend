import nodemailer from "nodemailer";

let transporter;

const DEFAULT_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 10000);
const MAX_RETRIES = 1;

const smtpConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_FROM);

const createTransporter = () => {
  if (smtpConfigured()) {
    const isGmail = (process.env.SMTP_HOST || "").toLowerCase().includes("gmail") || 
                    (process.env.SMTP_SERVICE || "").toLowerCase() === "gmail";

    if (isGmail) {
      return nodemailer.createTransport({
        service: "gmail",
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
export const mailerStatus = () => ({
  mode: mailerMode(),
  smtpConfigured: smtpConfigured(),
  host: process.env.SMTP_HOST || null,
  from: process.env.SMTP_FROM || null,
  timeout: DEFAULT_TIMEOUT_MS
});

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripHtml = (html) => {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

export const sendMail = async (options) => {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const headers = {
        "X-Mailer": "ReSpark Mailer v1.0",
        "X-Priority": "3",
        "X-MSMail-Priority": "Normal",
        "List-Unsubscribe": `<mailto:support@respark.in?subject=unsubscribe>`,
        "Reply-To": process.env.SMTP_FROM || "ReSpark <no-reply@respark.local>",
        ...options.headers
      };
      const mail = await withTimeout(
        getMailer().sendMail({
          from: process.env.SMTP_FROM || "ReSpark <no-reply@respark.local>",
          ...options,
          headers,
          text: options.text || stripHtml(options.html || ""),
          attachments: options.attachments || []
        }),
        DEFAULT_TIMEOUT_MS
      );
      if (attempt > 0) console.log(`[mailer] Email sent on attempt ${attempt + 1} to ${options.to}`);
      return {
        mode: mailerMode(),
        messageId: mail.messageId || null,
        preview: typeof mail.message === "string" ? mail.message : null
      };
    } catch (err) {
      lastError = err;
      console.error(`[mailer] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${options.to}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        transporter = null;
        await sleep(1000 * (attempt + 1));
      }
    }
  }
  console.error(`[mailer] All ${MAX_RETRIES + 1} attempts failed for ${options.to}. Giving up.`);
  throw lastError;
};
