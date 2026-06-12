import { prisma } from "./prisma.js";
import { attemptCustomerTemplateEmail } from "./emailNotifications.js";

const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const DEFAULT_INTERVAL_MS = Number(process.env.APPOINTMENT_REMINDER_INTERVAL_MS || 15 * 60 * 1000);
const LOOKAHEAD_DAYS = Number(process.env.APPOINTMENT_REMINDER_LOOKAHEAD_DAYS || 30);

let schedulerHandle = null;
let schedulerRunning = false;

const getReminderConfig = (advancedSettings) => {
  const genericSettings = asObject(asObject(advancedSettings).genericSettings);
  return {
    appointmentReminderDays: Number(genericSettings.appointmentReminderDays ?? 1),
    appointmentReminderHours: Number(genericSettings.appointmentReminderHours ?? 1)
  };
};

const computeReminderAt = (startAt, config) => {
  const daysMs = Math.max(0, config.appointmentReminderDays) * 24 * 60 * 60 * 1000;
  const hoursMs = Math.max(0, config.appointmentReminderHours) * 60 * 60 * 1000;
  return new Date(new Date(startAt).getTime() - daysMs - hoursMs);
};

export const runAppointmentReminderSweep = async () => {
  if (schedulerRunning) return { skipped: true, reason: "already_running" };
  schedulerRunning = true;
  try {
    const now = new Date();
    const horizon = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000);
    const appointments = await prisma.appointment.findMany({
      where: {
        status: { in: ["PENDING", "CONFIRMED"] },
        startAt: { gte: now, lte: horizon }
      },
      include: {
        customer: true,
        branch: true,
        salon: { select: { id: true } },
        logs: {
          where: { action: "APPOINTMENT_REMINDER_EMAIL_SENT" },
          orderBy: { createdAt: "desc" },
          take: 1
        }
      },
      orderBy: { startAt: "asc" }
    });

    let sentCount = 0;
    for (const appointment of appointments) {
      if (appointment.logs?.length) continue;
      const salonSetting = await prisma.salonSetting.findFirst({
        where: { salonId: appointment.salonId, branchId: null },
        select: { advancedSettings: true }
      });
      const config = getReminderConfig(salonSetting?.advancedSettings);
      const reminderAt = computeReminderAt(appointment.startAt, config);
      if (now < reminderAt) continue;

      const result = await attemptCustomerTemplateEmail({
        salonId: appointment.salonId,
        toEmail: appointment.customer?.email || "",
        templateType: "appointment_reminder",
        context: { appointmentId: appointment.id, customerId: appointment.customerId },
        extraVariables: { appointment_status: appointment.status }
      });

      if (result?.sent) {
        sentCount += 1;
        await prisma.appointmentLog.create({
          data: {
            appointmentId: appointment.id,
            action: "APPOINTMENT_REMINDER_EMAIL_SENT",
            details: `Reminder sent at ${now.toISOString()}`
          }
        });
      }
    }

    return { sentCount };
  } finally {
    schedulerRunning = false;
  }
};

export const startAppointmentReminderScheduler = () => {
  if (process.env.DISABLE_APPOINTMENT_REMINDER_SCHEDULER === "true") return null;
  if (schedulerHandle) return schedulerHandle;

  setTimeout(() => {
    void runAppointmentReminderSweep();
  }, 5000);

  schedulerHandle = setInterval(() => {
    void runAppointmentReminderSweep();
  }, DEFAULT_INTERVAL_MS);

  return schedulerHandle;
};
