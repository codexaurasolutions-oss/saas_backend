import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { attachBranchStock, buildCsv, isOwnScopedStaff, normalizeBranchId, toAmount } from "../../lib/phase2.js";
import { requireAuth, requireFeatureEnabled, requireSalonContext, requireSalonPermission } from "../../middlewares/rbac.js";
import { registerExtendedReports } from "./routes-extended.js";

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireSalonContext, requireFeatureEnabled("reports"), requireSalonPermission("reports", "view"));

const buildSpreadsheetHtml = (headers, rows) => `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; }
      th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; }
      th { background: #f1f5f9; }
    </style>
  </head>
  <body>
    <table>
      <thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((row) => `<tr>${row.map((cell) => `<td>${String(cell ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
  </body>
</html>`;

const buildInvoiceWhere = (req, branchId) => ({
  salonId: req.salonId,
  ...(branchId ? { branchId } : {}),
  ...(isOwnScopedStaff(req, "reports") ? { items: { some: { staffUserSalonId: req.user.membershipId } } } : {})
});

const buildPaymentWhere = (req, branchId) => ({
  salonId: req.salonId,
  invoice: { is: buildInvoiceWhere(req, branchId) }
});

const buildAppointmentWhere = (req, branchId) => ({
  salonId: req.salonId,
  ...(branchId ? { branchId } : {}),
  ...(isOwnScopedStaff(req, "reports")
    ? { items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } } }
    : {})
});

reportsRouter.get("/sales-summary", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, branchId),
    include: { branch: true, payments: true, items: true }
  });

  const totalSales = invoices.reduce((sum, invoice) => sum + toAmount(invoice.total), 0);
  const totalPaid = invoices.reduce((sum, invoice) => sum + toAmount(invoice.paidAmount), 0);
  const totalDue = invoices.reduce((sum, invoice) => sum + Math.max(0, toAmount(invoice.total) - toAmount(invoice.paidAmount) - toAmount(invoice.refundAmount)), 0);
  const byStatus = invoices.reduce((acc, invoice) => {
    acc[invoice.status] = (acc[invoice.status] || 0) + 1;
    return acc;
  }, {});
  const byBranch = invoices.reduce((acc, invoice) => {
    const key = invoice.branch?.name || "Unassigned";
    acc[key] = (acc[key] || 0) + toAmount(invoice.total);
    return acc;
  }, {});

  res.json({ count: invoices.length, totalSales, totalPaid, totalDue, byStatus, byBranch });
});

reportsRouter.get("/sales-summary-list", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, branchId),
    include: { customer: true, branch: true, payments: true, items: true },
    orderBy: { createdAt: "desc" }
  });

  res.json(
    invoices.map((invoice, idx) => {
      const dateObj = new Date(invoice.createdAt);
      const total = toAmount(invoice.total);
      const paid = toAmount(invoice.paidAmount);
      const refunded = toAmount(invoice.refundAmount);
      const due = Math.max(0, total - paid - refunded);
      const paymentModes = invoice.payments?.map((payment) => payment.mode).filter(Boolean).join(", ") || "-";

      return {
        "SR. NO.": idx + 1,
        "DATE": dateObj.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-"),
        "TIME": dateObj.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
        "INVOICE NO": invoice.invoiceNumber || "-",
        "GUEST NAME": invoice.customer?.name || "Walk-in",
        "GUEST NUMBER": invoice.customer?.phone || "-",
        "ITEMS": Array.isArray(invoice.items) ? invoice.items.length : 0,
        "GROSS AMOUNT": total,
        "DISCOUNT": toAmount(invoice.discount),
        "TAX": toAmount(invoice.tax),
        "NET TOTAL": total,
        "PAID AMOUNT": paid,
        "DUE AMOUNT": due,
        "PAYMENT MODE": paymentModes
      };
    })
  );
});

reportsRouter.get("/payment-modes", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const payments = await prisma.payment.findMany({
    where: buildPaymentWhere(req, branchId),
    include: { invoice: { include: { branch: true } } }
  });

  const modes = payments.reduce((acc, payment) => {
    acc[payment.mode] = (acc[payment.mode] || 0) + toAmount(payment.amount);
    return acc;
  }, {});
  const byBranch = payments.reduce((acc, payment) => {
    const key = payment.invoice?.branch?.name || "Unassigned";
    acc[key] = (acc[key] || 0) + toAmount(payment.amount);
    return acc;
  }, {});

  res.json({ modes, byBranch, paymentCount: payments.length });
});

reportsRouter.get("/appointments", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const rows = await prisma.appointment.findMany({
    where: buildAppointmentWhere(req, branchId),
    include: { customer: true, branch: true, items: { include: { service: true } } },
    orderBy: { startAt: "desc" }
  });
  res.json(rows);
});

const sendStaffPerformance = async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const appointments = await prisma.appointment.findMany({
    where: buildAppointmentWhere(req, branchId),
    include: { items: { include: { assignedStaff: { include: { userSalon: { include: { user: true } } } }, service: true } } }
  });
  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, branchId),
    include: { items: true }
  });

  const summary = {};
  appointments.forEach((appointment) => {
    appointment.items.forEach((item) => {
      item.assignedStaff.forEach((assignment) => {
        const key = assignment.userSalonId;
        if (!summary[key]) summary[key] = { staffId: key, staffName: assignment.userSalon.user.name, appointments: 0, completedAppointments: 0, revenue: 0, commission: 0, quantity: 0 };
        summary[key].appointments += 1;
        if (appointment.status === "COMPLETED") summary[key].completedAppointments += 1;
      });
    });
  });

  invoices.forEach((invoice) => {
    invoice.items.forEach((item) => {
      if (!item.staffUserSalonId) return;
      const row = summary[item.staffUserSalonId] || (summary[item.staffUserSalonId] = {
        staffId: item.staffUserSalonId,
        staffName: item.staffName || "Assigned Staff",
        appointments: 0,
        completedAppointments: 0,
        revenue: 0,
        commission: 0,
        quantity: 0
      });
      if (!row.staffName && item.staffName) row.staffName = item.staffName;
      row.revenue += toAmount(item.lineTotal);
      row.commission += toAmount(item.commissionAmount);
      row.quantity += Number(item.qty || 0);
    });
  });

  const rows = Object.values(summary).sort((a, b) => b.revenue - a.revenue);
  res.json(isOwnScopedStaff(req, "reports") ? rows.filter((row) => row.staffId === req.user.membershipId) : rows);
};

reportsRouter.get("/staff-performance", sendStaffPerformance);
reportsRouter.get("/staff-services", sendStaffPerformance);

reportsRouter.get("/product-sales", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const rows = await prisma.invoiceItem.findMany({
    where: {
      itemType: "PRODUCT",
      invoice: { is: buildInvoiceWhere(req, branchId) },
      ...(isOwnScopedStaff(req, "reports") ? { staffUserSalonId: req.user.membershipId } : {})
    },
    include: { product: { include: { category: true } }, invoice: true }
  });
  const grouped = {};
  rows.forEach((row) => {
    const key = row.productId || row.serviceName;
    if (!grouped[key]) grouped[key] = { productId: row.productId, "Product": row.product?.name || row.serviceName, "Category": row.product?.category?.name || "-", qty: 0, sales: 0 };
    grouped[key].qty += Number(row.qty || 0);
    grouped[key].sales += toAmount(row.lineTotal);
  });
  const result = Object.values(grouped).sort((a, b) => b.sales - a.sales);
  res.json(result.map(r => ({ ...r, "Qty": r.qty, "Sales": r.sales })));
});

reportsRouter.get("/service-sales", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const rows = await prisma.invoiceItem.findMany({
    where: {
      itemType: "SERVICE",
      invoice: { is: buildInvoiceWhere(req, branchId) },
      ...(isOwnScopedStaff(req, "reports") ? { staffUserSalonId: req.user.membershipId } : {})
    },
    include: { invoice: { include: { customer: true, payments: true } }, staffUserSalon: { include: { user: true } } }
  });

  const serviceIds = [...new Set(rows.map(r => r.serviceId).filter(Boolean))];
  const services = serviceIds.length > 0 ? await prisma.service.findMany({ where: { id: { in: serviceIds } }, include: { category: true } }) : [];
  const serviceMap = {};
  services.forEach(s => { serviceMap[s.id] = s; });

  res.json(rows.map((row, idx) => {
    const inv = row.invoice;
    const svc = serviceMap[row.serviceId];
    const dateObj = new Date(inv?.createdAt || Date.now());
    const paymentModes = inv?.payments?.map(p => p.mode).filter(Boolean).join(", ") || "";
    const taxAmt = toAmount(inv?.tax) || (toAmount(row.unitPrice) * toAmount(row.taxPct) / 100);
    const isComplimentary = toAmount(inv?.total) === 0;

    return {
      "SR. NO.": idx + 1,
      "DATE": dateObj.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-"),
      "TIME": dateObj.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      "GUEST NAME": inv?.customer?.name || "Walk-in",
      "GUEST NUMBER": inv?.customer?.phone || "-",
      "STAFF": row.staffUserSalon?.user?.name || row.staffName || "-",
      "INVOICE NO": inv?.invoiceNumber || "-",
      "SERVICE": svc?.name || row.serviceName || "-",
      "CATEGORY": svc?.category?.name || "-",
      "DURATION": svc?.durationMin || "-",
      "QTY": Number(row.qty || 0),
      "UNIT PRICE": toAmount(row.unitPrice),
      "DISCOUNT": 0,
      "COMPLIMENTARY": isComplimentary ? toAmount(row.lineTotal) : 0,
      "REDEMPTION AMOUNT": toAmount(row.membershipWalletUsed) + toAmount(row.packageSessionsUsed),
      "REDEMPTION SOURCES": [row.membershipWalletUsed ? "Membership" : "", row.packageSessionsUsed ? "Package" : ""].filter(Boolean).join(", ") || "-",
      "TAX": taxAmt,
      "SUBTOTAL": toAmount(row.lineTotal) - taxAmt,
      "TOTAL": toAmount(row.lineTotal),
      "PAYMENT MODE": paymentModes
    };
  }));
});

reportsRouter.get("/memberships", async (req, res) => {
  const rows = await prisma.customerMembership.findMany({
    where: isOwnScopedStaff(req, "reports")
      ? { salonId: req.salonId, soldInvoice: { is: { items: { some: { staffUserSalonId: req.user.membershipId } } } } }
      : { salonId: req.salonId },
    include: { membershipPlan: true, customer: true, soldInvoice: true, usageLogs: true },
    orderBy: { createdAt: "desc" }
  });
  res.json(rows);
});

reportsRouter.get("/packages", async (req, res) => {
  const rows = await prisma.customerPackage.findMany({
    where: isOwnScopedStaff(req, "reports")
      ? { salonId: req.salonId, soldInvoice: { is: { items: { some: { staffUserSalonId: req.user.membershipId } } } } }
      : { salonId: req.salonId },
    include: { package: true, customer: true, soldInvoice: true, usageLogs: true },
    orderBy: { createdAt: "desc" }
  });
  res.json(rows);
});

reportsRouter.get("/stock", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  if (req.query.summary === "products") {
    const products = await prisma.product.findMany({
      where: { salonId: req.salonId, isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
      include: { category: true, branch: true },
      orderBy: { name: "asc" }
    });
    return res.json(await attachBranchStock(prisma, products, branchId));
  }

  res.json(await prisma.stockMovement.findMany({
    where: { salonId: req.salonId, ...(branchId ? { branchId } : {}) },
    include: { product: true },
    orderBy: { createdAt: "desc" }
  }));
});

reportsRouter.get("/low-stock", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const products = await prisma.product.findMany({
    where: {
      salonId: req.salonId,
      isActive: true,
      ...(branchId ? { OR: [{ branchId }, { branchId: null }, { stockMovements: { some: { branchId } } }] } : {})
    },
    include: { category: true, branch: true },
    orderBy: { name: "asc" }
  });
  const rows = await attachBranchStock(prisma, products, branchId);
  res.json(rows.filter((product) => toAmount(product.currentStock) <= toAmount(product.minStock)));
});

reportsRouter.get("/customers", async (req, res) => {
  const customers = await prisma.customer.findMany({
    where: isOwnScopedStaff(req, "reports")
      ? {
          salonId: req.salonId,
          OR: [
            { appointments: { some: { items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } } } } },
            { invoices: { some: { items: { some: { staffUserSalonId: req.user.membershipId } } } } }
          ]
        }
      : { salonId: req.salonId },
    include: {
      invoices: { include: { payments: true, items: true } },
      memberships: { include: { membershipPlan: true, usageLogs: true } },
      packages: { include: { package: true, usageLogs: true } }
    },
    orderBy: { totalSpend: "desc" }
  });

  const giftCardRedemptions = await prisma.giftCardRedemption.findMany({
    where: { salonId: req.salonId },
    include: { giftCard: true }
  });
  const couponRedemptions = await prisma.couponRedemption.findMany({
    where: { coupon: { salonId: req.salonId } }
  });
  const loyaltyTxns = await prisma.loyaltyTransaction.findMany({
    where: { salonId: req.salonId }
  });

  const gcByCustomer = {};
  giftCardRedemptions.forEach(r => {
    if (!gcByCustomer[r.customerId]) gcByCustomer[r.customerId] = 0;
    gcByCustomer[r.customerId] += toAmount(r.amountUsed);
  });
  const cpByCustomer = {};
  couponRedemptions.forEach(r => {
    if (!cpByCustomer[r.customerId]) cpByCustomer[r.customerId] = 0;
    cpByCustomer[r.customerId] += toAmount(r.amountSaved);
  });
  const loyByCustomer = {};
  loyaltyTxns.forEach(r => {
    if (!loyByCustomer[r.customerId]) loyByCustomer[r.customerId] = 0;
    loyByCustomer[r.customerId] += toAmount(r.points);
  });

  res.json(customers.map((c, idx) => {
    let totalTax = 0, balancePending = 0, advanceUtilized = 0, balanceCleared = 0, onlineTotal = 0, offlineTotal = 0;
    c.invoices.forEach(inv => {
      totalTax += toAmount(inv.tax);
      balancePending += Math.max(0, toAmount(inv.total) - toAmount(inv.paidAmount) - toAmount(inv.refundAmount));
      inv.payments.forEach(p => {
        const amt = toAmount(p.amount);
        if (p.mode === "ONLINE") onlineTotal += amt;
        else offlineTotal += amt;
        if (p.type === "ADVANCE") advanceUtilized += amt;
        if (p.type === "BALANCE") balanceCleared += amt;
      });
    });

    let pkgRedemption = 0;
    c.packages.forEach(pkg => { pkg.usageLogs.forEach(l => { pkgRedemption += toAmount(l.sessionsUsed); }); });
    let memRedemption = 0;
    c.memberships.forEach(mem => { mem.usageLogs.forEach(l => { memRedemption += toAmount(l.amountUsed); }); });

    return {
      "SR. NO.": idx + 1,
      "GUEST NAME": c.name,
      "GUEST NUMBER": c.phone,
      "COUNT": c.invoices.length,
      "TAXES": totalTax,
      "GIFT CARD": gcByCustomer[c.id] || 0,
      "COUPON": cpByCustomer[c.id] || 0,
      "REFERRAL": 0,
      "LOYALTY": loyByCustomer[c.id] || 0,
      "BALANCE PENDING": balancePending,
      "ADVANCE UTILIZED": advanceUtilized,
      "PACKAGE REDEMPTION": pkgRedemption,
      "BALANCE CLEARED": balanceCleared,
      "MEMBERSHIP REDEMPTION": memRedemption,
      "ONLINE": onlineTotal,
      "OFFLINE": offlineTotal,
      "TOTAL": toAmount(c.totalSpend)
    };
  }));
});

reportsRouter.get("/branch-sales", async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, null),
    include: { branch: true }
  });
  const grouped = invoices.reduce((acc, invoice) => {
    const key = invoice.branch?.name || "Unassigned";
    if (!acc[key]) acc[key] = { branch: key, sales: 0, paid: 0, count: 0 };
    acc[key].sales += toAmount(invoice.total);
    acc[key].paid += toAmount(invoice.paidAmount);
    acc[key].count += 1;
    return acc;
  }, {});
  res.json(Object.values(grouped));
});

reportsRouter.get("/cancelled-invoices", async (req, res) => {
  res.json(await prisma.invoice.findMany({
    where: { ...buildInvoiceWhere(req, null), status: { in: ["CANCELLED", "REFUNDED"] } },
    include: { customer: true, branch: true, payments: true },
    orderBy: { createdAt: "desc" }
  }));
});

reportsRouter.get("/export.csv", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, branchId),
    include: { customer: true, branch: true },
    orderBy: { createdAt: "desc" }
  });

  const csv = buildCsv(
    ["Invoice", "Customer", "Branch", "Status", "Total", "Paid", "Refunded", "CreatedAt"],
    invoices.map((invoice) => [
      invoice.invoiceNumber,
      invoice.customer?.name || "Walk-in",
      invoice.branch?.name || "Main salon",
      invoice.status,
      toAmount(invoice.total).toFixed(2),
      toAmount(invoice.paidAmount).toFixed(2),
      toAmount(invoice.refundAmount).toFixed(2),
      new Date(invoice.createdAt).toISOString()
    ])
  );

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=\"reports-export.csv\"");
  res.send(csv);
});

reportsRouter.get("/export.xls", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, branchId),
    include: { customer: true, branch: true },
    orderBy: { createdAt: "desc" }
  });

  const rows = invoices.map((invoice) => [
    invoice.invoiceNumber,
    invoice.customer?.name || "Walk-in",
    invoice.branch?.name || "Main salon",
    invoice.status,
    toAmount(invoice.total).toFixed(2),
    toAmount(invoice.paidAmount).toFixed(2),
    toAmount(invoice.refundAmount).toFixed(2),
    new Date(invoice.createdAt).toISOString()
  ]);

  const html = buildSpreadsheetHtml(
    ["Invoice", "Customer", "Branch", "Status", "Total", "Paid", "Refunded", "CreatedAt"],
    rows
  );

  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"reports-export.xls\"");
  res.send(html);
});

registerExtendedReports(reportsRouter, prisma, buildInvoiceWhere);
