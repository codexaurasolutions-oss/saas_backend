import nodemailer from "nodemailer";

let transporter;

const CONNECTION_TIMEOUT_MS = Number(process.env.SMTP_TIMEOUT_MS || 5000);
const SEND_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

const smtpConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_FROM);

const createTransporter = () => {
  if (smtpConfigured()) {
    const isGmail = (process.env.SMTP_HOST || "").toLowerCase().includes("gmail") || 
                    (process.env.SMTP_SERVICE || "").toLowerCase() === "gmail";

    if (isGmail) {
      return nodemailer.createTransport({
        service: "gmail",
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        connectionTimeout: CONNECTION_TIMEOUT_MS,
        greetingTimeout: CONNECTION_TIMEOUT_MS,
        socketTimeout: SEND_TIMEOUT_MS,
        auth: process.env.SMTP_USER
          ? {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS || ""
            }
          : undefined,
        tls: { rejectUnauthorized: false }
      });
    }

    const isZoho = (process.env.SMTP_HOST || "").toLowerCase().includes("zoho");
    if (isZoho) {
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST || "smtp.zoho.in",
        port: Number(process.env.SMTP_PORT) || 465,
        secure: process.env.SMTP_SECURE !== "false",
        connectionTimeout: 20000,
        greetingTimeout: 20000,
        socketTimeout: SEND_TIMEOUT_MS,
        auth: process.env.SMTP_USER
          ? {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS || ""
            }
          : undefined,
        tls: { rejectUnauthorized: false }
      });
    }

    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT),
      secure: process.env.SMTP_SECURE === "true",
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: CONNECTION_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
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
  port: process.env.SMTP_PORT || null,
  from: process.env.SMTP_FROM || null,
  user: process.env.SMTP_USER || null,
  timeout: CONNECTION_TIMEOUT_MS
});

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

const pendingEmails = [];

export const getPendingEmails = () => pendingEmails;

export const retryPendingEmails = async () => {
  if (pendingEmails.length === 0) return;
  const batch = [...pendingEmails];
  pendingEmails.length = 0;
  let sent = 0;
  for (const job of batch) {
    try {
      await sendMail(job);
      sent++;
    } catch {
      pendingEmails.push(job);
    }
  }
  console.log(`[mailer] Retry batch: ${sent}/${batch.length} sent, ${pendingEmails.length} still pending`);
};

export const sendMail = async (options) => {
  if (!smtpConfigured()) {
    console.log(`[mailer] SMTP not configured, email logged for ${options.to}: ${options.subject || "(no subject)"}`);
    return { mode: "json", messageId: null, preview: "SMTP not configured" };
  }

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const mail = await getMailer().sendMail({
        from: process.env.SMTP_FROM || '"SalonNest" <govardhan@salonnest.in>',
        ...options,
        text: options.text || stripHtml(options.html || ""),
        attachments: options.attachments || []
      });

      if (attempt > 0) console.log(`[mailer] Email sent on attempt ${attempt + 1} to ${options.to}`);
      console.log(`[mailer] Email sent to ${options.to}: ${options.subject || "(no subject)"} | id=${mail.messageId || "none"}`);
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
        await sleep(2000 * (attempt + 1));
      }
    }
  }

  console.error(`[mailer] All ${MAX_RETRIES + 1} attempts failed for ${options.to}. Queuing for retry.`);
  pendingEmails.push({ ...options, _queuedAt: Date.now() });
  return { mode: mailerMode(), messageId: null, queued: true };
};
