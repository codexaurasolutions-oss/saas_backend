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
    include: { product: true, invoice: true }
  });
  const grouped = {};
  rows.forEach((row) => {
    const key = row.productId || row.serviceName;
    if (!grouped[key]) grouped[key] = { productId: row.productId, name: row.product?.name || row.serviceName, qty: 0, sales: 0 };
    grouped[key].qty += Number(row.qty || 0);
    grouped[key].sales += toAmount(row.lineTotal);
  });
  res.json(Object.values(grouped).sort((a, b) => b.sales - a.sales));
});

reportsRouter.get("/service-sales", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const rows = await prisma.invoiceItem.findMany({
    where: {
      itemType: "SERVICE",
      invoice: { is: buildInvoiceWhere(req, branchId) },
      ...(isOwnScopedStaff(req, "reports") ? { staffUserSalonId: req.user.membershipId } : {})
    }
  });
  const grouped = {};
  rows.forEach((row) => {
    const key = row.serviceId || row.serviceName;
    if (!grouped[key]) grouped[key] = { serviceId: row.serviceId, name: row.serviceName, qty: 0, sales: 0 };
    grouped[key].qty += Number(row.qty || 0);
    grouped[key].sales += toAmount(row.lineTotal);
  });
  res.json(Object.values(grouped).sort((a, b) => b.sales - a.sales));
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
  res.json(await prisma.customer.findMany({
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
      memberships: { include: { membershipPlan: true } },
      packages: { include: { package: true } },
      appointments: true,
      invoices: true
    },
    orderBy: { totalSpend: "desc" }
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

registerExtendedReports(reportsRouter, prisma, buildInvoiceWhere);

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
