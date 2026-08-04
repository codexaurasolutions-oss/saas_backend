import { prisma } from "../../../lib/prisma.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";

const toNumber = (value) => Number(value || 0);
const normalizeBranchId = (value) => (value ? String(value) : null);

const parseDateWhere = (query, field = "createdAt") => {
  const start = query.start ? new Date(String(query.start)) : null;
  const end = query.end ? new Date(String(query.end)) : null;
  return start || end
    ? { [field]: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } }
    : {};
};

const branchScope = (req) => {
  const branchId = normalizeBranchId(req.query.branchId);
  return branchId ? { branchId } : {};
};

export const registerAdvancedReportRoutes = (ownerRouter) => {
  ownerRouter.get("/reports/advanced", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const bs = branchScope(req);
    const [expenses, feedback, enquiries, couponRedemptions, giftCardRedemptions] = await Promise.all([
      prisma.expense.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query, "expenseDate") } }),
      prisma.customerFeedback.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query) } }),
      prisma.enquiry.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query) } }),
      prisma.couponRedemption.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query) } }),
      prisma.giftCardRedemption.findMany({ where: { salonId: req.salonId, ...bs, ...parseDateWhere(req.query) } })
    ]);
    res.json({
      summaryCards: {
        expenses: expenses.reduce((sum, row) => sum + toNumber(row.amount), 0),
        payroll: 0,
        averageFeedback: feedback.length ? feedback.reduce((sum, row) => sum + row.rating, 0) / feedback.length : 0,
        enquiries: enquiries.length,
        couponSavings: couponRedemptions.reduce((sum, row) => sum + toNumber(row.amountSaved), 0),
        giftCardUse: giftCardRedemptions.reduce((sum, row) => sum + toNumber(row.amountUsed), 0)
      }
    });
  });

  ownerRouter.get("/reports/profit-loss", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const bs = branchScope(req);
    const [invoices, expenses] = await Promise.all([
      prisma.invoice.findMany({ where: { salonId: req.salonId, ...bs, status: { notIn: ["CANCELLED", "STARTED"] }, ...parseDateWhere(req.query) } }),
      prisma.expense.findMany({ where: { salonId: req.salonId, ...bs, status: { in: ["APPROVED", "PAID"] }, ...parseDateWhere(req.query, "expenseDate") } })
    ]);
    const revenue = invoices.reduce((sum, row) => sum + toNumber(row.total), 0);
    const costs = expenses.reduce((sum, row) => sum + toNumber(row.amount), 0);
    res.json({ revenue, expenses: costs, profit: revenue - costs, invoices, expenseRows: expenses });
  });

  ownerRouter.get("/reports/campaign-roi", requireFeatureEnabled("campaigns"), requireSalonPermission("campaignAnalytics", "view"), async (req, res) => {
    const bs = branchScope(req);
    const campaigns = await prisma.campaign.findMany({
      where: { salonId: req.salonId, ...bs },
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



  ownerRouter.get("/reports/tax", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const bs = branchScope(req);
    const invoices = await prisma.invoice.findMany({ where: { salonId: req.salonId, ...bs, status: { notIn: ["CANCELLED", "STARTED"] }, ...parseDateWhere(req.query) }, orderBy: { createdAt: "desc" } });
    res.json({
      taxCollected: invoices.reduce((sum, row) => sum + toNumber(row.tax), 0),
      rows: invoices.map((row) => ({ invoiceNumber: row.invoiceNumber, total: row.total, tax: row.tax, createdAt: row.createdAt }))
    });
  });

  ownerRouter.get("/reports/export", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const moduleKey = String(req.query.module || "profit-loss");
    const bs = branchScope(req);
    let rows = [];
    if (moduleKey === "expenses") {
      rows = await prisma.expense.findMany({ where: { salonId: req.salonId, ...bs }, orderBy: { expenseDate: "desc" } });
    } else if (moduleKey === "campaigns") {
      rows = await prisma.campaign.findMany({
        where: { salonId: req.salonId, ...bs },
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
        where: { salonId: req.salonId, ...bs },
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
        where: { salonId: req.salonId, ...bs },
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
        where: { salonId: req.salonId, ...bs },
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
        where: { salonId: req.salonId, ...bs },
        include: { customer: true, branch: true, service: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        customer: row.customer?.name || "",
        branch: row.branch?.name || "",
        service: row.service?.name || "",
        rating: row.rating,
        status: row.complaintFollowUpStatus || row.status,
        comment: row.message || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "enquiries") {
      rows = await prisma.enquiry.findMany({
        where: { salonId: req.salonId, ...bs },
        include: { interestedBranch: true, assignedToMembership: { include: { user: true } }, interestedService: true },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        id: row.id,
        customerName: row.name,
        source: row.source,
        service: row.interestedService?.name || "",
        branch: row.interestedBranch?.name || "",
        priority: row.priority,
        status: row.status,
        assignedTo: row.assignedToMembership?.user?.name || "",
        createdAt: row.createdAt
      }));
    } else if (moduleKey === "payroll") {
      rows = [];
    } else if (moduleKey === "tax") {
      rows = await prisma.invoice.findMany({
        where: { salonId: req.salonId, ...bs, status: { not: "CANCELLED" } },
        orderBy: { createdAt: "desc" }
      });
      rows = rows.map((row) => ({
        invoiceNumber: row.invoiceNumber,
        total: row.total,
        tax: row.tax,
        createdAt: row.createdAt
      }));
    } else {
      rows = await prisma.invoice.findMany({ where: { salonId: req.salonId, ...bs }, orderBy: { createdAt: "desc" } });
    }

    const csv = [
      Object.keys(rows[0] || {}).join(","),
      ...rows.map((row) => Object.values(row).map((value) => JSON.stringify(value ?? "")).join(","))
    ].join("\n");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"${moduleKey}-report.csv\"`);
    res.send(csv);
  });

  ownerRouter.get("/financial-reports", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const bs = branchScope(req);
    const period = req.query.period || "thisMonth";
    const now = new Date();
    let start = new Date(now);
    if (period === "today") start.setHours(0, 0, 0, 0);
    else if (period === "thisMonth") { start.setDate(1); start.setHours(0, 0, 0, 0); }
    else if (period === "thisQuarter") { start.setMonth(Math.floor(now.getMonth() / 3) * 3, 1); start.setHours(0, 0, 0, 0); }
    else if (period === "thisYear") { start.setMonth(0, 1); start.setHours(0, 0, 0, 0); }
    else if (period === "custom" && req.query.start) { start = new Date(req.query.start); }
    else { start.setDate(1); start.setHours(0, 0, 0, 0); }

    const dateFilter = { gte: start };
    const [invoices, expenses, payments] = await Promise.all([
      prisma.invoice.findMany({ where: { salonId: req.salonId, ...bs, status: { notIn: ["CANCELLED", "STARTED"] }, createdAt: dateFilter } }),
      prisma.expense.findMany({ where: { salonId: req.salonId, ...bs, status: { in: ["APPROVED", "PAID"] }, expenseDate: dateFilter } }),
      prisma.payment.findMany({ where: { salonId: req.salonId, ...bs, createdAt: dateFilter } })
    ]);

    const totalRevenue = invoices.reduce((s, r) => s + toNumber(r.total), 0);
    const totalTax = invoices.reduce((s, r) => s + toNumber(r.tax), 0);
    const totalExpenses = expenses.reduce((s, r) => s + toNumber(r.amount), 0);
    const serviceRevenue = invoices.reduce((s, r) => s + toNumber(r.total) - toNumber(r.productTotal || 0), 0);
    const productRevenue = invoices.reduce((s, r) => s + toNumber(r.productTotal || 0), 0);

    const inflows = { CASH: 0, CARD: 0, UPI: 0, BANK_TRANSFER: 0, WALLET: 0, ONLINE: 0 };
    payments.forEach(p => { const m = (p.mode || "CASH").toUpperCase(); if (inflows[m] !== undefined) inflows[m] += toNumber(p.amount); });
    const inflowTotal = Object.values(inflows).reduce((a, b) => a + b, 0);

    const outflows = { CASH: 0, CARD: 0, UPI: 0, BANK_TRANSFER: 0, WALLET: 0, ONLINE: 0 };
    expenses.forEach(e => { const m = (e.paymentMode || "CASH").toUpperCase(); if (outflows[m] !== undefined) outflows[m] += toNumber(e.amount); });
    const outflowTotal = Object.values(outflows).reduce((a, b) => a + b, 0);

    const expenseByCategory = {};
    expenses.forEach(e => { const cat = e.categoryName || "Other"; expenseByCategory[cat] = (expenseByCategory[cat] || 0) + toNumber(e.amount); });

    res.json({
      summary: {
        totalGrossIncome: totalRevenue,
        grossProfit: totalRevenue - totalExpenses,
        grossMargin: totalRevenue ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0,
        totalExpensesPayroll: totalExpenses,
        netProfit: totalRevenue - totalExpenses,
        netMargin: totalRevenue ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0
      },
      pnl: {
        revenue: { services: serviceRevenue, products: productRevenue, memberships: 0, packages: 0, giftCards: 0, total: totalRevenue },
        costOfGoodsSold: 0,
        grossProfit: totalRevenue,
        expenses: { rent: expenseByCategory["Rent"] || 0, utilities: expenseByCategory["Utilities"] || 0, supplies: expenseByCategory["Supplies"] || 0, marketing: expenseByCategory["Marketing"] || 0, other: totalExpenses, total: totalExpenses },
        payroll: expenseByCategory["Payroll"] || 0,
        netProfit: totalRevenue - totalExpenses
      },
      cashFlow: {
        inflows: { ...inflows, total: inflowTotal },
        outflows: { ...outflows, total: outflowTotal },
        netCashFlow: inflowTotal - outflowTotal
      },
      gst: {
        taxableTurnover: totalRevenue - totalTax,
        totalGSTCollected: totalTax,
        gstByRate: [{ rate: "default", amount: totalTax }],
        hsnSummary: []
      }
    });
  });
};
