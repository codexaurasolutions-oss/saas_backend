import { prisma } from "../../../lib/prisma.js";
import { buildCsv, normalizeBranchId } from "../../../lib/phase2.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { buildAppointmentScope } from "./shared.js";

export const registerOwnerReportRoutes = (ownerRouter) => {
  ownerRouter.get("/reports/appointments", requireFeatureEnabled("reports"), requireSalonPermission("reports", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    res.json(await prisma.appointment.findMany({
      where: buildAppointmentScope(req, branchId),
      include: { customer: true, branch: true, items: { include: { service: true } } },
      orderBy: { startAt: "desc" }
    }));
  });

  ownerRouter.get("/reports/stock", requireFeatureEnabled("reports"), requireSalonPermission("reports", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    res.json(await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, ...(branchId ? { branchId } : {}) },
      include: { product: true },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.get("/reports/stock/export.csv", requireFeatureEnabled("reports"), requireSalonPermission("reports", "view"), async (req, res) => {
    const rows = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId },
      include: { product: true },
      orderBy: { createdAt: "desc" }
    });
    const csv = buildCsv(
      ["Product", "Movement", "Quantity", "Before", "After", "Reference", "CreatedAt"],
      rows.map((row) => [row.product.name, row.movementType, row.quantity, row.stockBefore, row.stockAfter, row.referenceType || "", row.createdAt.toISOString()])
    );
    res.setHeader("Content-Type", "text/csv");
    res.send(csv);
  });

  ownerRouter.get("/financial-reports", requireFeatureEnabled("reports"), requireSalonPermission("reports", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const { period } = req.query;

    let startDate = new Date();
    startDate.setHours(0, 0, 0, 0);
    let endDate = new Date();
    endDate.setHours(23, 59, 59, 999);

    if (period === "thisMonth") {
      startDate = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    } else if (period === "thisQuarter") {
      const quarter = Math.floor(startDate.getMonth() / 3);
      startDate = new Date(startDate.getFullYear(), quarter * 3, 1);
    } else if (period === "thisYear") {
      startDate = new Date(startDate.getFullYear(), 0, 1);
    }

    const dateFilter = { gte: startDate, lte: endDate };
    const branchFilter = branchId ? { branchId } : {};

    const invoices = await prisma.invoice.findMany({
      where: { salonId: req.salonId, ...branchFilter, createdAt: dateFilter, status: { not: "VOID" } },
      include: { items: true }
    });

    const expenses = await prisma.expense.findMany({
      where: { salonId: req.salonId, ...branchFilter, expenseDate: dateFilter, status: "APPROVED" },
      include: { category: true }
    });

    const payments = await prisma.payment.findMany({
      where: { salonId: req.salonId, invoice: { ...branchFilter }, createdAt: dateFilter }
    });

    let revenue = { services: 0, products: 0, memberships: 0, packages: 0, giftCards: 0, total: 0 };
    let payrollCommissions = 0;
    let gst = { taxableTurnover: 0, totalGSTCollected: 0, cgst: 0, sgst: 0, gstRate: 18 };
    let costOfGoodsSold = 0;

    invoices.forEach(inv => {
      const taxAmt = Number(inv.tax || 0);
      const subtotalAmt = Number(inv.subtotal || 0);
      const discountAmt = Number(inv.discount || 0);
      const taxable = Math.max(0, subtotalAmt - discountAmt);
      
      gst.taxableTurnover += taxable;
      gst.totalGSTCollected += taxAmt;
      gst.cgst += taxAmt / 2;
      gst.sgst += taxAmt / 2;

      inv.items.forEach(item => {
        const lineTotal = Number(item.lineTotal || 0);
        revenue.total += lineTotal;
        
        if (item.itemType === "SERVICE") revenue.services += lineTotal;
        else if (item.itemType === "PRODUCT") revenue.products += lineTotal;
        else if (item.itemType === "MEMBERSHIP") revenue.memberships += lineTotal;
        else if (item.itemType === "PACKAGE") revenue.packages += lineTotal;
        else if (item.itemType === "GIFT_CARD") revenue.giftCards += lineTotal;

        payrollCommissions += Number(item.commissionAmount || 0);
      });
    });

    const productIds = invoices.flatMap(inv => inv.items.filter(i => i.itemType === "PRODUCT" && i.productId).map(i => i.productId));
    if (productIds.length > 0) {
      const uniqueProductIds = [...new Set(productIds)];
      const products = await prisma.product.findMany({ where: { id: { in: uniqueProductIds } } });
      const productCostMap = {};
      products.forEach(p => productCostMap[p.id] = Number(p.costPrice || 0));

      invoices.forEach(inv => {
        inv.items.forEach(item => {
          if (item.itemType === "PRODUCT" && item.productId) {
             costOfGoodsSold += (productCostMap[item.productId] || 0) * item.qty;
          }
        });
      });
    }

    const expensesCategorized = { rent: 0, utilities: 0, supplies: 0, marketing: 0, other: 0, total: 0 };
    expenses.forEach(exp => {
      const amt = Number(exp.amount || 0);
      expensesCategorized.total += amt;
      const catName = (exp.category?.name || "Other").toLowerCase();
      if (catName.includes("rent")) expensesCategorized.rent += amt;
      else if (catName.includes("utilit")) expensesCategorized.utilities += amt;
      else if (catName.includes("suppl")) expensesCategorized.supplies += amt;
      else if (catName.includes("market")) expensesCategorized.marketing += amt;
      else expensesCategorized.other += amt;
    });

    const payroll = payrollCommissions;
    const grossProfit = revenue.total - costOfGoodsSold;
    const netProfit = grossProfit - expensesCategorized.total - payroll;

    const totalGrossIncome = revenue.total;
    const grossMargin = totalGrossIncome ? (grossProfit / totalGrossIncome) * 100 : 0;
    const totalExpensesPayroll = expensesCategorized.total + payroll;
    const netMargin = totalGrossIncome ? (netProfit / totalGrossIncome) * 100 : 0;

    let cashFlow = {
      inflows: { CASH: 0, CARD: 0, UPI: 0, BANK_TRANSFER: 0, WALLET: 0, ONLINE: 0, total: 0 },
      outflows: { CASH: 0, CARD: 0, UPI: 0, BANK_TRANSFER: 0, WALLET: 0, ONLINE: 0, total: 0 },
      netCashFlow: 0
    };

    payments.forEach(p => {
      const amt = Number(p.amount || 0);
      const mode = p.mode || "CASH";
      cashFlow.inflows.total += amt;
      if (cashFlow.inflows[mode] !== undefined) cashFlow.inflows[mode] += amt;
      else cashFlow.inflows.ONLINE += amt; 
    });

    expenses.forEach(exp => {
       const amt = Number(exp.amount || 0);
       const mode = exp.paymentMode || "CASH";
       cashFlow.outflows.total += amt;
       if (cashFlow.outflows[mode] !== undefined) cashFlow.outflows[mode] += amt;
       else cashFlow.outflows.ONLINE += amt;
    });

    cashFlow.outflows.CASH += payroll;
    cashFlow.outflows.total += payroll;

    cashFlow.netCashFlow = cashFlow.inflows.total - cashFlow.outflows.total;

    res.json({
      summary: { totalGrossIncome, grossProfit, grossMargin, totalExpensesPayroll, netProfit, netMargin },
      pnl: { revenue, costOfGoodsSold, grossProfit, expenses: expensesCategorized, payroll, netProfit },
      cashFlow,
      gst
    });
  });
};
