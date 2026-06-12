import { prisma } from "../../../lib/prisma.js";
import { attachSalonSettings, requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";

const toNumber = (value) => Number(value || 0);

const parseDateWhere = (req, field = "createdAt") => {
  const isRestricted = req.advancedSettings?.allowReportDateRestriction;
  if (isRestricted) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { [field]: { gte: today, lt: tomorrow } };
  }

  const query = req.query;
  const start = query.start ? new Date(String(query.start)) : null;
  const end = query.end ? new Date(String(query.end)) : null;
  return start || end
    ? { [field]: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } }
    : {};
};

export const registerAdvancedReportRoutes = (ownerRouter) => {
  ownerRouter.get("/reports/advanced", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), attachSalonSettings, async (req, res) => {
    const [expenses, payrollRuns, feedback, enquiries, couponRedemptions, giftCardRedemptions] = await Promise.all([
      prisma.expense.findMany({ where: { salonId: req.salonId, ...parseDateWhere(req, "expenseDate") } }),
      prisma.payrollRun.findMany({ where: { salonId: req.salonId, ...parseDateWhere(req) } }),
      prisma.customerFeedback.findMany({ where: { salonId: req.salonId, ...parseDateWhere(req) } }),
      prisma.enquiry.findMany({ where: { salonId: req.salonId, ...parseDateWhere(req) } }),
      prisma.couponRedemption.findMany({ where: { salonId: req.salonId, ...parseDateWhere(req) } }),
      prisma.giftCardRedemption.findMany({ where: { salonId: req.salonId, ...parseDateWhere(req) } })
    ]);
    res.json({
      summaryCards: {
        expenses: expenses.reduce((sum, row) => sum + toNumber(row.amount), 0),
        payroll: payrollRuns.reduce((sum, row) => sum + toNumber(row.totalNet), 0),
        averageFeedback: feedback.length ? feedback.reduce((sum, row) => sum + row.rating, 0) / feedback.length : 0,
        enquiries: enquiries.length,
        couponSavings: couponRedemptions.reduce((sum, row) => sum + toNumber(row.amountSaved), 0),
        giftCardUse: giftCardRedemptions.reduce((sum, row) => sum + toNumber(row.amountUsed), 0)
      }
    });
  });

  ownerRouter.get("/reports/profit-loss", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), attachSalonSettings, async (req, res) => {
    const [invoices, expenses] = await Promise.all([
      prisma.invoice.findMany({ where: { salonId: req.salonId, status: { not: "CANCELLED" }, ...parseDateWhere(req) } }),
      prisma.expense.findMany({ where: { salonId: req.salonId, status: { in: ["APPROVED", "PAID"] }, ...parseDateWhere(req, "expenseDate") } })
    ]);
    const revenue = invoices.reduce((sum, row) => sum + toNumber(row.total), 0);
    const costs = expenses.reduce((sum, row) => sum + toNumber(row.amount), 0);
    res.json({ revenue, expenses: costs, profit: revenue - costs, invoices, expenseRows: expenses });
  });

  ownerRouter.get("/reports/campaign-roi", requireFeatureEnabled("campaigns"), requireSalonPermission("campaignAnalytics", "view"), async (req, res) => {
    const campaigns = await prisma.campaign.findMany({
      where: { salonId: req.salonId },
      include: { conversions: true, logs: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      revenue: campaign.conversions.reduce((sum, row) => sum + toNumber(row.revenueAmount), 0),
      conversions: campaign.conversions.length,
      sends: campaign.logs.filter((row) => row.eventType.includes("SENT")).length
    })));
  });

  ownerRouter.get("/reports/payroll", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "view"), attachSalonSettings, async (req, res) => {
    res.json(await prisma.payrollRun.findMany({ where: { salonId: req.salonId, ...parseDateWhere(req) }, include: { items: { include: { userSalon: { include: { user: true } } } } }, orderBy: { createdAt: "desc" } }));
  });

  ownerRouter.get("/reports/tax", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), attachSalonSettings, async (req, res) => {
    const invoices = await prisma.invoice.findMany({ where: { salonId: req.salonId, status: { not: "CANCELLED" }, ...parseDateWhere(req) }, orderBy: { createdAt: "desc" } });
    res.json({
      taxCollected: invoices.reduce((sum, row) => sum + toNumber(row.tax), 0),
      rows: invoices.map((row) => ({ invoiceNumber: row.invoiceNumber, total: row.total, tax: row.tax, createdAt: row.createdAt }))
    });
  });

  ownerRouter.get("/reports/export", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), attachSalonSettings, async (req, res) => {
    if (req.advancedSettings?.allowReportDownloading === false) {
      return res.status(403).json({ message: "Report downloading is restricted by salon settings" });
    }
    const moduleKey = String(req.query.module || "profit-loss");
    let rows = [];
    if (moduleKey === "expenses") {
      rows = await prisma.expense.findMany({ where: { salonId: req.salonId }, orderBy: { expenseDate: "desc" } });
    } else if (moduleKey === "campaigns") {
      rows = await prisma.campaign.findMany({
        where: { salonId: req.salonId },
        include: { conversions: true, logs: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        status: row.status,
        audienceFilter: row.audienceFilter,
        conversions: row.conversions.length,
        sends: row.logs.filter((entry) => entry.eventType.includes("SENT")).length,
        revenue: row.conversions.reduce((sum, entry) => sum + toNumber(entry.revenueAmount), 0),
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "loyalty") {
      rows = await prisma.loyaltyTransaction.findMany({
        where: { salonId: req.salonId },
        include: { customer: true, invoice: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        customer: row.customer?.name || "",
        type: row.type,
        points: row.points,
        balanceAfter: row.balanceAfter,
        invoiceNumber: row.invoice?.invoiceNumber || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "coupons") {
      rows = await prisma.couponRedemption.findMany({
        where: { salonId: req.salonId },
        include: { coupon: true, customer: true, invoice: true, order: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        couponCode: row.coupon?.code || "",
        customer: row.customer?.name || "",
        amountSaved: row.amountSaved,
        invoiceNumber: row.invoice?.invoiceNumber || "",
        orderNumber: row.order?.orderNumber || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "gift-cards") {
      rows = await prisma.giftCardRedemption.findMany({
        where: { salonId: req.salonId },
        include: { giftCard: true, customer: true, invoice: true, order: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        giftCardCode: row.giftCard?.code || "",
        customer: row.customer?.name || "",
        amountUsed: row.amountUsed,
        invoiceNumber: row.invoice?.invoiceNumber || "",
        orderNumber: row.order?.orderNumber || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "feedback") {
      rows = await prisma.customerFeedback.findMany({
        where: { salonId: req.salonId },
        include: { customer: true, branch: true, service: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        customer: row.customer?.name || "",
        branch: row.branch?.name || "",
        service: row.service?.name || "",
        rating: row.rating,
        status: row.followUpStatus,
        comment: row.comment || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "enquiries") {
      rows = await prisma.enquiry.findMany({
        where: { salonId: req.salonId },
        include: { branch: true, assignedUserSalon: { include: { user: true } } },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        customerName: row.name,
        source: row.source,
        service: row.interestedService || "",
        branch: row.branch?.name || "",
        priority: row.priority,
        status: row.status,
        assignedTo: row.assignedUserSalon?.user?.name || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "payroll") {
      rows = await prisma.payrollRun.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } });
    } else if (moduleKey === "tax") {
      rows = await prisma.invoice.findMany({
        where: { salonId: req.salonId, status: { not: "CANCELLED" } },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        invoiceNumber: row.invoiceNumber,
        total: row.total,
        tax: row.tax,
        createdAt: row.createdAt
      }));
    } else {
      rows = await prisma.invoice.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } });
    }

    const csv = [
      Object.keys(rows[0] || {}).join(","),
      ...rows.map((row) => Object.values(row).map((value) => JSON.stringify(value ?? "")).join(","))
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${moduleKey}-report.csv\"`);
    res.send(csv);
  });
};
