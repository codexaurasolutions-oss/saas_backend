import { prisma } from "./prisma.js";
import { sendMail } from "./mailer.js";

/**
 * SalonNest - Automated Executive Daily & Weekly Salon Owner Digest Emails
 */

// Helper to format currency
const fmtCurrency = (val, currency = "INR") => {
  const num = Number(val || 0);
  return `${currency} ${num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/**
 * Calculate metrics for a single day (default: today)
 */
export async function calculateDailyMetrics(salonId, date = new Date()) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  const [salon, revenueAggr, invoiceCount, appointmentCount, completedApptCount, newCustomers, expenseAggr] = await Promise.all([
    prisma.salon.findUnique({ where: { id: salonId }, select: { id: true, name: true, slug: true, currency: true } }),
    prisma.invoice.aggregate({
      _sum: { total: true },
      where: { salonId, status: "PAID", createdAt: { gte: startOfDay, lte: endOfDay } }
    }),
    prisma.invoice.count({
      where: { salonId, status: "PAID", createdAt: { gte: startOfDay, lte: endOfDay } }
    }),
    prisma.appointment.count({
      where: { salonId, startAt: { gte: startOfDay, lte: endOfDay } }
    }),
    prisma.appointment.count({
      where: { salonId, startAt: { gte: startOfDay, lte: endOfDay }, status: "COMPLETED" }
    }),
    prisma.customer.count({
      where: { salonId, createdAt: { gte: startOfDay, lte: endOfDay } }
    }),
    prisma.expense.aggregate({
      _sum: { amount: true },
      where: { salonId, expenseDate: { gte: startOfDay, lte: endOfDay } }
    })
  ]);

  const totalSales = Number(revenueAggr._sum.total || 0);
  const totalExpenses = Number(expenseAggr._sum.amount || 0);
  const netIncome = totalSales - totalExpenses;
  const avgTicket = invoiceCount > 0 ? (totalSales / invoiceCount) : 0;
  const completionRate = appointmentCount > 0 ? Math.round((completedApptCount / appointmentCount) * 100) : 100;

  return {
    salon,
    dateStr: startOfDay.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }),
    totalSales,
    totalExpenses,
    netIncome,
    avgTicket,
    completionRate,
    invoiceCount,
    appointmentCount,
    completedApptCount,
    newCustomers
  };
}

/**
 * Calculate metrics for the last 7 days
 */
export async function calculateWeeklyMetrics(salonId, date = new Date()) {
  const endOfWeek = new Date(date);
  endOfWeek.setHours(23, 59, 59, 999);

  const startOfWeek = new Date(date);
  startOfWeek.setDate(startOfWeek.getDate() - 6);
  startOfWeek.setHours(0, 0, 0, 0);

  // Previous week for growth comparison
  const prevEndOfWeek = new Date(startOfWeek);
  prevEndOfWeek.setMilliseconds(-1);

  const prevStartOfWeek = new Date(prevEndOfWeek);
  prevStartOfWeek.setDate(prevStartOfWeek.getDate() - 6);
  prevStartOfWeek.setHours(0, 0, 0, 0);

  const [salon, currentRevenue, prevRevenue, invoiceCount, apptCount, completedCount, newCustomers, expenseAggr] = await Promise.all([
    prisma.salon.findUnique({ where: { id: salonId }, select: { id: true, name: true, slug: true, currency: true } }),
    prisma.invoice.aggregate({
      _sum: { total: true },
      where: { salonId, status: "PAID", createdAt: { gte: startOfWeek, lte: endOfWeek } }
    }),
    prisma.invoice.aggregate({
      _sum: { total: true },
      where: { salonId, status: "PAID", createdAt: { gte: prevStartOfWeek, lte: prevEndOfWeek } }
    }),
    prisma.invoice.count({
      where: { salonId, status: "PAID", createdAt: { gte: startOfWeek, lte: endOfWeek } }
    }),
    prisma.appointment.count({
      where: { salonId, startAt: { gte: startOfWeek, lte: endOfWeek } }
    }),
    prisma.appointment.count({
      where: { salonId, startAt: { gte: startOfWeek, lte: endOfWeek }, status: "COMPLETED" }
    }),
    prisma.customer.count({
      where: { salonId, createdAt: { gte: startOfWeek, lte: endOfWeek } }
    }),
    prisma.expense.aggregate({
      _sum: { amount: true },
      where: { salonId, expenseDate: { gte: startOfWeek, lte: endOfWeek } }
    })
  ]);

  const totalSales = Number(currentRevenue._sum.total || 0);
  const prevSales = Number(prevRevenue._sum.total || 0);
  const totalExpenses = Number(expenseAggr._sum.amount || 0);
  const netIncome = totalSales - totalExpenses;
  const avgTicket = invoiceCount > 0 ? (totalSales / invoiceCount) : 0;
  const completionRate = apptCount > 0 ? Math.round((completedCount / apptCount) * 100) : 100;

  let growthPct = 0;
  if (prevSales > 0) {
    growthPct = Math.round(((totalSales - prevSales) / prevSales) * 100);
  } else if (totalSales > 0) {
    growthPct = 100;
  }

  return {
    salon,
    startDateStr: startOfWeek.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    endDateStr: endOfWeek.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    totalSales,
    prevSales,
    growthPct,
    totalExpenses,
    netIncome,
    avgTicket,
    completionRate,
    invoiceCount,
    apptCount,
    completedCount,
    newCustomers
  };
}

/**
 * Build Executive PDF-Style HTML template for Daily Digest
 */
export function buildDailyDigestHtml({ ownerName, metrics }) {
  const { salon, dateStr, totalSales, totalExpenses, netIncome, avgTicket, completionRate, invoiceCount, appointmentCount, completedApptCount, newCustomers } = metrics;
  const currency = salon?.currency || "INR";
  const frontendUrl = process.env.FRONTEND_APP_URL || "https://salonnest-frontend.vercel.app";

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Business Report - ${salon?.name || "SalonNest"}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 30px 0;">
    <tr>
      <td align="center">
        <div style="max-width: 650px; width: 100%; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #cbd5e1; box-shadow: 0 20px 40px rgba(15,23,42,0.08);">
          
          <!-- PDF Report Style Header -->
          <div style="background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%); padding: 40px 36px; color: #ffffff; position: relative;">
            <table role="presentation" width="100%">
              <tr>
                <td>
                  <span style="display: inline-block; background: rgba(99,102,241,0.25); border: 1px solid rgba(165,180,252,0.4); color: #c7d2fe; padding: 6px 14px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 12px;">
                    EXECUTIVE DAILY REPORT
                  </span>
                  <h1 style="margin: 0 0 6px; font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">${salon?.name || "SalonNest Partner"}</h1>
                  <p style="margin: 0; font-size: 14px; color: #94a3b8; font-weight: 500;">Period: ${dateStr}</p>
                </td>
                <td align="right" valign="top">
                  <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 12px 18px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15); text-align: right;">
                    <span style="display: block; font-size: 10px; color: #cbd5e1; text-transform: uppercase; font-weight: 700; letter-spacing: 1px;">Platform</span>
                    <span style="font-size: 16px; font-weight: 900; color: #38bdf8;">SalonNest ERP</span>
                  </div>
                </td>
              </tr>
            </table>
          </div>

          <!-- Executive Summary Content -->
          <div style="padding: 36px 36px 20px;">
            <p style="margin: 0 0 8px; font-size: 17px; font-weight: 700; color: #0f172a;">Dear ${ownerName || "Salon Owner"},</p>
            <p style="margin: 0 0 28px; font-size: 15px; color: #475569; line-height: 1.6;">
              Below is your official daily business metrics summary and financial performance statement for <strong>${salon?.name || "your salon"}</strong>.
            </p>

            <!-- KPI Summary Cards Grid -->
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
              <tr>
                <td width="49%" valign="top">
                  <div style="background: linear-gradient(180deg, #ecfdf5 0%, #f0fdf4 100%); border: 1px solid #a7f3d0; padding: 20px; border-radius: 16px; border-left: 5px solid #10b981;">
                    <span style="font-size: 11px; font-weight: 800; color: #047857; text-transform: uppercase; letter-spacing: 1px;">Today's Revenue</span>
                    <div style="font-size: 26px; font-weight: 900; color: #065f46; margin: 6px 0 2px;">${fmtCurrency(totalSales, currency)}</div>
                    <span style="font-size: 12px; color: #059669; font-weight: 600;">Avg Ticket: ${fmtCurrency(avgTicket, currency)}</span>
                  </div>
                </td>
                <td width="2%"></td>
                <td width="49%" valign="top">
                  <div style="background: linear-gradient(180deg, #eff6ff 0%, #f0f9ff 100%); border: 1px solid #bfdbfe; padding: 20px; border-radius: 16px; border-left: 5px solid #3b82f6;">
                    <span style="font-size: 11px; font-weight: 800; color: #1d4ed8; text-transform: uppercase; letter-spacing: 1px;">Net Profit Today</span>
                    <div style="font-size: 26px; font-weight: 900; color: #1e40af; margin: 6px 0 2px;">${fmtCurrency(netIncome, currency)}</div>
                    <span style="font-size: 12px; color: #2563eb; font-weight: 600;">Expenses: ${fmtCurrency(totalExpenses, currency)}</span>
                  </div>
                </td>
              </tr>
            </table>

            <!-- Detailed Breakdown Table -->
            <div style="background: #f8fafc; border-radius: 16px; border: 1px solid #e2e8f0; padding: 24px; margin-bottom: 28px;">
              <h3 style="margin: 0 0 16px; font-size: 14px; font-weight: 800; color: #334155; text-transform: uppercase; letter-spacing: 1px;">📊 Operations & Customer Activity</h3>
              
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size: 14px;">
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">Invoices Generated & Paid</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #0f172a;">${invoiceCount} Invoices</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">Appointments Completed</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #0f172a;">${completedApptCount} of ${appointmentCount} (${completionRate}%)</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">New Clients Onboarded</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #16a34a;">+${newCustomers} New Clients</td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">Operational Expenses</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #dc2626;">${fmtCurrency(totalExpenses, currency)}</td>
                </tr>
              </table>
            </div>

            <!-- CTA Portal Button -->
            <div style="text-align: center; margin: 36px 0 16px;">
              <a href="${frontendUrl}/admin/dashboard" target="_blank" style="background: linear-gradient(135deg, #4f46e5 0%, #3b82f6 100%); color: #ffffff; padding: 16px 40px; border-radius: 12px; text-decoration: none; font-weight: 800; font-size: 15px; display: inline-block; box-shadow: 0 8px 20px rgba(79,70,229,0.3);">
                Access SalonNest Owner Panel →
              </a>
            </div>
          </div>

          <!-- Executive Footer -->
          <div style="background: #f8fafc; padding: 24px 36px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 13px; color: #64748b; line-height: 1.5;">
            <p style="margin: 0 0 6px;"><strong>SalonNest Executive Automated Reporting Service</strong></p>
            <p style="margin: 0;">This email is automatically compiled for salon owners. Confidential & Proprietary to ${salon?.name || "SalonNest"}.</p>
          </div>

        </div>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * Build Executive PDF-Style HTML template for Weekly Digest
 */
export function buildWeeklyDigestHtml({ ownerName, metrics }) {
  const { salon, startDateStr, endDateStr, totalSales, prevSales, growthPct, totalExpenses, netIncome, avgTicket, completionRate, invoiceCount, apptCount, completedCount, newCustomers } = metrics;
  const currency = salon?.currency || "INR";
  const frontendUrl = process.env.FRONTEND_APP_URL || "https://salonnest-frontend.vercel.app";
  const isPositiveGrowth = growthPct >= 0;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Weekly Business Report - ${salon?.name || "SalonNest"}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0f172a;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 30px 0;">
    <tr>
      <td align="center">
        <div style="max-width: 650px; width: 100%; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #cbd5e1; box-shadow: 0 20px 40px rgba(15,23,42,0.08);">
          
          <!-- PDF Report Style Header -->
          <div style="background: linear-gradient(135deg, #065f46 0%, #047857 50%, #0f172a 100%); padding: 40px 36px; color: #ffffff;">
            <table role="presentation" width="100%">
              <tr>
                <td>
                  <span style="display: inline-block; background: rgba(52,211,153,0.25); border: 1px solid rgba(167,243,208,0.4); color: #a7f3d0; padding: 6px 14px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: 2px; text-transform: uppercase; margin-bottom: 12px;">
                    EXECUTIVE WEEKLY REPORT
                  </span>
                  <h1 style="margin: 0 0 6px; font-size: 26px; font-weight: 800; color: #ffffff; letter-spacing: -0.5px;">${salon?.name || "SalonNest Partner"}</h1>
                  <p style="margin: 0; font-size: 14px; color: #a7f3d0; font-weight: 500;">7-Day Cycle: ${startDateStr} – ${endDateStr}</p>
                </td>
                <td align="right" valign="top">
                  <div style="background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); padding: 12px 18px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.15); text-align: right;">
                    <span style="display: block; font-size: 10px; color: #a7f3d0; text-transform: uppercase; font-weight: 700; letter-spacing: 1px;">Platform</span>
                    <span style="font-size: 16px; font-weight: 900; color: #34d399;">SalonNest ERP</span>
                  </div>
                </td>
              </tr>
            </table>
          </div>

          <!-- Executive Summary Content -->
          <div style="padding: 36px 36px 20px;">
            <p style="margin: 0 0 8px; font-size: 17px; font-weight: 700; color: #0f172a;">Dear ${ownerName || "Salon Owner"},</p>
            <p style="margin: 0 0 28px; font-size: 15px; color: #475569; line-height: 1.6;">
              Below is your 7-day business performance report and weekly revenue statement for <strong>${salon?.name || "your salon"}</strong>.
            </p>

            <!-- Major Revenue Growth Banner -->
            <div style="background: linear-gradient(180deg, #f0fdf4 0%, #dcfce7 100%); border: 1px solid #86efac; border-radius: 16px; padding: 24px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 11px; font-weight: 800; color: #166534; text-transform: uppercase; letter-spacing: 1.5px;">7-Day Gross Sales</span>
              <div style="font-size: 32px; font-weight: 900; color: #14532d; margin: 6px 0 10px;">${fmtCurrency(totalSales, currency)}</div>
              <span style="display: inline-block; padding: 6px 16px; border-radius: 999px; font-size: 13px; font-weight: 800; background: ${isPositiveGrowth ? "#ffffff" : "#fee2e2"}; color: ${isPositiveGrowth ? "#15803d" : "#b91c1c"}; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                ${isPositiveGrowth ? "▲ +" : "▼ "}${growthPct}% Growth vs Previous Week (${fmtCurrency(prevSales, currency)})
              </span>
            </div>

            <!-- Detailed Breakdown Table -->
            <div style="background: #f8fafc; border-radius: 16px; border: 1px solid #e2e8f0; padding: 24px; margin-bottom: 28px;">
              <h3 style="margin: 0 0 16px; font-size: 14px; font-weight: 800; color: #334155; text-transform: uppercase; letter-spacing: 1px;">📈 7-Day Performance Metrics</h3>
              
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size: 14px;">
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">Weekly Net Profit</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #047857;">${fmtCurrency(netIncome, currency)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">Average Order Ticket Size</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #0f172a;">${fmtCurrency(avgTicket, currency)}</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">Invoices Settled</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #0f172a;">${invoiceCount} Invoices</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">Appointments Fulfilled</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #0f172a;">${completedCount} of ${apptCount} (${completionRate}%)</td>
                </tr>
                <tr style="border-bottom: 1px solid #e2e8f0;">
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">New Customers Gained</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #16a34a;">+${newCustomers} New Clients</td>
                </tr>
                <tr>
                  <td style="padding: 12px 0; color: #475569; font-weight: 500;">Total Weekly Expenses</td>
                  <td style="padding: 12px 0; font-weight: 800; text-align: right; color: #dc2626;">${fmtCurrency(totalExpenses, currency)}</td>
                </tr>
              </table>
            </div>

            <!-- CTA Portal Button -->
            <div style="text-align: center; margin: 36px 0 16px;">
              <a href="${frontendUrl}/admin/dashboard" target="_blank" style="background: linear-gradient(135deg, #059669 0%, #0d9488 100%); color: #ffffff; padding: 16px 40px; border-radius: 12px; text-decoration: none; font-weight: 800; font-size: 15px; display: inline-block; box-shadow: 0 8px 20px rgba(5,150,105,0.3);">
                View Full Analytics & Reports →
              </a>
            </div>
          </div>

          <!-- Executive Footer -->
          <div style="background: #f8fafc; padding: 24px 36px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 13px; color: #64748b; line-height: 1.5;">
            <p style="margin: 0 0 6px;"><strong>SalonNest Executive Automated Reporting Service</strong></p>
            <p style="margin: 0;">This email is automatically compiled for salon owners. Confidential & Proprietary to ${salon?.name || "SalonNest"}.</p>
          </div>

        </div>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

/**
 * Dispatch Daily Digest Email to a specific Salon Owner or all Salon Owners
 */
export async function sendDailyDigestForSalon(salonId, overrideOwnerEmail = null) {
  const owners = await prisma.userSalon.findMany({
    where: { salonId, salonRole: "SALON_OWNER" },
    include: { user: true, salon: true }
  });

  if (owners.length === 0 && !overrideOwnerEmail) return { success: false, reason: "no-owners-found" };

  const metrics = await calculateDailyMetrics(salonId);

  const results = [];
  for (const item of owners) {
    const recipientEmail = overrideOwnerEmail || item.user.email;
    const html = buildDailyDigestHtml({ ownerName: item.user.name, metrics });

    try {
      await sendMail({
        to: recipientEmail,
        subject: `📊 Executive Daily Report (${metrics.dateStr}): ${metrics.salon?.name || "Salon Performance"}`,
        html
      });
      results.push({ email: recipientEmail, success: true });
    } catch (err) {
      console.error(`[Daily Digest Error] Failed for ${recipientEmail}:`, err.message);
      results.push({ email: recipientEmail, success: false, error: err.message });
    }
  }

  return { success: true, count: results.length, details: results };
}

/**
 * Dispatch Weekly Digest Email to a specific Salon Owner
 */
export async function sendWeeklyDigestForSalon(salonId, overrideOwnerEmail = null) {
  const owners = await prisma.userSalon.findMany({
    where: { salonId, salonRole: "SALON_OWNER" },
    include: { user: true, salon: true }
  });

  if (owners.length === 0 && !overrideOwnerEmail) return { success: false, reason: "no-owners-found" };

  const metrics = await calculateWeeklyMetrics(salonId);

  const results = [];
  for (const item of owners) {
    const recipientEmail = overrideOwnerEmail || item.user.email;
    const html = buildWeeklyDigestHtml({ ownerName: item.user.name, metrics });

    try {
      await sendMail({
        to: recipientEmail,
        subject: `📈 Executive Weekly Report (${metrics.startDateStr} - ${metrics.endDateStr}): ${metrics.salon?.name || "Salon Performance"}`,
        html
      });
      results.push({ email: recipientEmail, success: true });
    } catch (err) {
      console.error(`[Weekly Digest Error] Failed for ${recipientEmail}:`, err.message);
      results.push({ email: recipientEmail, success: false, error: err.message });
    }
  }

  return { success: true, count: results.length, details: results };
}

/**
 * Send Daily Digest to ALL Salon Owners in the system
 */
export async function sendDailyDigestsToAllOwners() {
  const salonOwners = await prisma.userSalon.findMany({
    where: { salonRole: "SALON_OWNER" },
    select: { salonId: true }
  });

  const uniqueSalonIds = [...new Set(salonOwners.map((s) => s.salonId))];
  const results = [];

  for (const salonId of uniqueSalonIds) {
    try {
      const res = await sendDailyDigestForSalon(salonId);
      results.push({ salonId, ...res });
    } catch (err) {
      console.error(`[Global Daily Digest Error] Salon ${salonId}:`, err.message);
    }
  }

  return results;
}

/**
 * Send Weekly Digest to ALL Salon Owners in the system
 */
export async function sendWeeklyDigestsToAllOwners() {
  const salonOwners = await prisma.userSalon.findMany({
    where: { salonRole: "SALON_OWNER" },
    select: { salonId: true }
  });

  const uniqueSalonIds = [...new Set(salonOwners.map((s) => s.salonId))];
  const results = [];

  for (const salonId of uniqueSalonIds) {
    try {
      const res = await sendWeeklyDigestForSalon(salonId);
      results.push({ salonId, ...res });
    } catch (err) {
      console.error(`[Global Weekly Digest Error] Salon ${salonId}:`, err.message);
    }
  }

  return results;
}
