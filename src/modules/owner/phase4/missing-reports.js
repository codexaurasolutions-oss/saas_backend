import { prisma } from "../../../lib/prisma.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { appendTotalRow, isOwnScopedStaff, normalizeBranchId, toAmount } from "../../../lib/phase2.js";

const parseDateSafe = (val, isEnd = false) => {
  if (!val) return null;
  const suffix = isEnd ? "T23:59:59.999Z" : "T00:00:00.000Z";
  const d = new Date(val + suffix);
  return isNaN(d.getTime()) ? null : d;
};

const buildInvoiceWhere = (req, branchId) => {
  const start = parseDateSafe(req.query.start, false);
  const end = parseDateSafe(req.query.end, true);
  const stylistId = req.query.stylistId;
  const productId = req.query.productId;
  const serviceId = req.query.serviceId;
  const categoryId = req.query.categoryId;
  const customerId = req.query.customerId;
  const status = req.query.status;
  const date = req.query.date ? parseDateSafe(req.query.date, false) : null;

  const dateFilter = date
    ? { createdAt: { gte: date, lte: new Date(date.getTime() + 86399999) } }
    : (start || end
      ? {
          createdAt: {
            ...(start ? { gte: start } : {}),
            ...(end ? { lte: end } : {})
          }
        }
      : {});

  const itemsFilter = {};
  if (stylistId) itemsFilter.staffUserSalonId = stylistId;
  if (productId) itemsFilter.productId = productId;
  if (serviceId) itemsFilter.serviceId = serviceId;

  const useItemFilter = Object.keys(itemsFilter).length > 0;

  return {
    salonId: req.salonId,
    ...(branchId ? { branchId } : {}),
    ...(isOwnScopedStaff(req, "reports") ? { items: { some: { staffUserSalonId: req.user.membershipId } } } : {}),
    ...(useItemFilter ? { items: { some: itemsFilter } } : {}),
    ...(categoryId ? { items: { some: { product: { categoryId } } } } : {}),
    ...(customerId ? { customerId } : {}),
    ...(status ? { status } : {}),
    ...dateFilter
  };
};

const buildDateRange = (req) => {
  const { start, end, date } = req.query || {};
  if (date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const endDate = new Date(d);
    endDate.setHours(23, 59, 59, 999);
    return { startDate: d, endDate };
  }
  const startDate = start ? new Date(start) : (() => { const d = new Date(); d.setDate(d.getDate() - 30); d.setHours(0,0,0,0); return d; })();
  const endDate = end ? new Date(end) : new Date();
  endDate.setHours(23,59,59,999);
  return { startDate, endDate };
};

const buildReportFilters = (req) => {
  return {
    stylistId: req.query?.stylistId || null,
    productId: req.query?.productId || null,
    serviceId: req.query?.serviceId || null,
    categoryId: req.query?.categoryId || null,
    customerId: req.query?.customerId || null,
    vendorId: req.query?.vendorId || null,
    transactionId: req.query?.transactionId || null,
    vendorInvoiceId: req.query?.vendorInvoiceId || null,
    status: req.query?.status || null
  };
};

const safeName = (s) => String(s || "").replace(/[\\]/g, "\\\\").replace(/[\\"]/g, '\\"').replace(/\\n/g, " ");

export const registerMissingReportRoutes = (ownerRouter) => {
  // ============ Service Reminder ============
  ownerRouter.get("/reports/service-reminder", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const branchId = normalizeBranchId(req.query.branchId);
    const customers = await prisma.customer.findMany({
      where: { salonId: req.salonId, appointments: { some: { salonId: req.salonId, status: "COMPLETED", startAt: { gte: startDate, lte: endDate } } } },
      include: { appointments: { where: { status: "COMPLETED", startAt: { gte: startDate, lte: endDate } }, include: { items: { include: { service: true } }, branch: true }, orderBy: { startAt: "desc" }, take: 1 } },
      take: 200
    });
    const rows = customers.map((c) => {
      const last = c.appointments[0];
      const lastItems = last?.items || [];
      const lastService = lastItems.find(i => i.service)?.service?.name || "-";
      const lastServiceId = lastItems.find(i => i.service)?.serviceId || null;
      const dueDate = last ? new Date(new Date(last.startAt).getTime() + 30 * 86400000) : null;
      const today = new Date();
      const status = dueDate && dueDate < today ? "Overdue" : "Upcoming";
      return { id: c.id, customerId: c.id, customer: c, lastService, lastServiceId, dueDate, status, lastVisit: last?.startAt };
    });
    res.json(rows.map((r, idx) => ({
      "SR. NO.": idx + 1,
      "Customer": r.customer?.name || "-",
      "Phone": r.customer?.phone || "-",
      "Last Service": r.lastService,
      "Service": r.lastService,
      "Due Date": r.dueDate ? r.dueDate.toISOString().slice(0,10) : "-",
      "Status": r.status
    })));
  });

  // ============ Feedback ============
  ownerRouter.get("/reports/feedback", requireFeatureEnabled("feedback"), requireSalonPermission("feedback", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const feedback = await prisma.customerFeedback.findMany({
      where: { salonId: req.salonId, createdAt: { gte: startDate, lte: endDate } },
      include: { customer: true, service: true, staffUserSalon: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    res.json(feedback.map((f, idx) => ({
      "SR. NO.": idx + 1,
      "Date": f.createdAt,
      "Customer": f.customer?.name || "Walk-in",
      "Phone": f.customer?.phone || "-",
      "Staff": f.staffUserSalon?.user?.name || "-",
      "Service": f.service?.name || "-",
      "Rating": f.rating,
      "Comment": f.comment || "-",
      "Status": f.status || "-"
    })));
  });

  // ============ Incentive Report ============
  ownerRouter.get("/reports/incentive", requireFeatureEnabled("incentives"), requireSalonPermission("incentives", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const payrollItems = await prisma.payrollItem.findMany({
      where: { payrollRun: { salonId: req.salonId, periodStart: { gte: startDate }, periodEnd: { lte: endDate } } },
      include: { payrollRun: true, membership: { include: { userSalon: { include: { user: true } } } } },
      orderBy: { totalPayout: "desc" },
      take: 200
    });
    const mapped = payrollItems.map((item, idx) => ({
      "SR. NO.": idx + 1,
      "Staff": item.membership?.userSalon?.user?.name || "-",
      "Month": item.payrollRun ? new Date(item.payrollRun.periodStart).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "-",
      "Revenue Generated": item.baseSalary + item.commissionAmount + item.incentiveAmount,
      "Commission %": item.payrollRun?.commissionPercent || 0,
      "Commission Amt": item.commissionAmount,
      "Bonus": item.incentiveAmount,
      "Total": item.totalPayout
    }));
    res.json(appendTotalRow(mapped, "Staff", "TOTAL", ["Revenue Generated", "Commission Amt", "Bonus", "Total"]));
  });

  // ============ Staff Attendance ============
  ownerRouter.get("/reports/staff-attendance", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const { stylistId } = buildReportFilters(req);
    const attendance = await prisma.attendanceRecord.findMany({
      where: { salonId: req.salonId, attendanceDate: { gte: startDate, lte: endDate }, ...(stylistId ? { userSalonId: stylistId } : {}) },
      include: { userSalon: { include: { user: true } } },
      orderBy: { attendanceDate: "desc" },
      take: 500
    });
    const grouped = {};
    attendance.forEach((a) => {
      const key = a.userSalonId;
      if (!grouped[key]) {
        grouped[key] = {
          staff: a.userSalon?.user?.name || "Unknown",
          designation: a.userSalon?.designation || "-",
          phone: a.userSalon?.user?.phone || "-",
          totalWorkingHours: 0,
          days: 0
        };
      }
      grouped[key].totalWorkingHours += toAmount(a.workedMinutes || 0) / 60;
      grouped[key].days += 1;
    });
    const rows = Object.values(grouped).map((s, idx) => ({
      "SR. NO.": idx + 1,
      "Staff": s.staff,
      "Designation": s.designation,
      "Staff Number": s.phone,
      "Total Working Hours": s.totalWorkingHours.toFixed(1)
    }));
    res.json(rows);
  });

  // ============ Membership Redemption ============
  ownerRouter.get("/reports/membership-redemption", requireFeatureEnabled("memberships"), requireSalonPermission("memberships", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const { customerId, stylistId } = buildReportFilters(req);
    const usage = await prisma.membershipUsage.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        customerMembership: {
          salonId: req.salonId,
          ...(customerId ? { customerId } : {})
        }
      },
      include: { customerMembership: { include: { customer: true, membershipPlan: true } }, assignedStaff: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const filtered = stylistId ? usage.filter((u) => u.assignedStaff?.userSalonId === stylistId) : usage;
    res.json(filtered.map((u, idx) => ({
      "Date": u.createdAt,
      "Customer": u.customerMembership?.customer?.name || "-",
      "Membership": u.customerMembership?.membershipPlan?.name || "-",
      "Service Redeemed": u.serviceName || "-",
      "Sessions Used": u.sessionsUsed || 1,
      "Remaining": u.sessionsRemaining || 0
    })));
  });

  // ============ Inter-Store Membership Report ============
  ownerRouter.get("/reports/inter-store-membership", requireFeatureEnabled("memberships"), requireSalonPermission("memberships", "view"), async (req, res) => {
    const usage = await prisma.membershipUsage.findMany({
      where: { customerMembership: { salonId: req.salonId, homeBranchId: { not: null } } },
      include: {
        customerMembership: {
          include: {
            customer: true,
            membershipPlan: true,
            homeBranch: true
          }
        },
        branch: true
      },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = usage.map((u, idx) => ({
      "Date": u.createdAt,
      "Customer": u.customerMembership?.customer?.name || "-",
      "Home Branch": u.customerMembership?.homeBranch?.name || "-",
      "Redeemed Branch": u.branch?.name || "-",
      "Service": u.serviceName || "-",
      "Value Transfer": u.amountUsed || 0
    }));
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Value Transfer"]));
  });

  // ============ Package Redemption ============
  ownerRouter.get("/reports/package-redemption", requireFeatureEnabled("packages"), requireSalonPermission("packages", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const { customerId, stylistId } = buildReportFilters(req);
    const usage = await prisma.packageUsage.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        customerPackage: {
          salonId: req.salonId,
          ...(customerId ? { customerId } : {})
        }
      },
      include: { customerPackage: { include: { customer: true, package: true } }, assignedStaff: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const filtered = stylistId ? usage.filter((u) => u.assignedStaff?.userSalonId === stylistId) : usage;
    res.json(filtered.map((u, idx) => ({
      "Date": u.createdAt,
      "Customer": u.customerPackage?.customer?.name || "-",
      "Package": u.customerPackage?.package?.name || "-",
      "Service Redeemed": u.serviceName || "-",
      "Sessions Used": u.sessionsUsed || 1,
      "Remaining": u.sessionsRemaining || 0
    })));
  });

  // ============ Gift Card Sold Report ============
  ownerRouter.get("/reports/gift-card-sold", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const cards = await prisma.giftCard.findMany({
      where: { salonId: req.salonId, createdAt: { gte: startDate, lte: endDate } },
      include: { customer: true, branch: true },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = cards.map((c, idx) => ({
      "Date": c.createdAt,
      "Code": c.code,
      "Customer": c.customer?.name || "-",
      "Value": c.originalAmount,
      "Expiry": c.expiresAt ? c.expiresAt.toISOString().slice(0,10) : "-",
      "Branch": c.branch?.name || "-"
    }));
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Value"]));
  });

  // ============ Gift Card Redemption ============
  ownerRouter.get("/reports/gift-card-redemption", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const redemptions = await prisma.giftCardRedemption.findMany({
      where: { createdAt: { gte: startDate, lte: endDate }, giftCard: { salonId: req.salonId } },
      include: { giftCard: true, invoice: true },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = redemptions.map((r, idx) => ({
      "Date": r.createdAt,
      "Code": r.giftCard?.code || "-",
      "Amount Used": r.amountUsed,
      "Invoice #": r.invoice?.invoiceNumber || "-",
      "Remaining Balance": r.giftCard ? r.giftCard.balanceAmount : 0
    }));
    res.json(appendTotalRow(mapped, "Code", "TOTAL", ["Amount Used", "Remaining Balance"]));
  });

  // ============ Advance Received ============
  ownerRouter.get("/reports/advance-received", requireFeatureEnabled("invoices"), requireSalonPermission("invoices", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const payments = await prisma.payment.findMany({
      where: { salonId: req.salonId, type: "ADVANCE", createdAt: { gte: startDate, lte: endDate } },
      include: { invoice: { include: { customer: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = payments.map((p, idx) => ({
      "Date": p.createdAt,
      "Customer": p.invoice?.customer?.name || "-",
      "Invoice #": p.invoice?.invoiceNumber || "-",
      "Advance Amount": p.amount,
      "Mode": p.mode,
      "Staff": p.invoice?.salesByUserId || "-"
    }));
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Advance Amount"]));
  });

  // ============ Balance Received ============
  ownerRouter.get("/reports/balance-received", requireFeatureEnabled("invoices"), requireSalonPermission("invoices", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const payments = await prisma.payment.findMany({
      where: { salonId: req.salonId, type: "BALANCE", createdAt: { gte: startDate, lte: endDate } },
      include: { invoice: { include: { customer: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = payments.map((p, idx) => ({
      "Date": p.createdAt,
      "Customer": p.invoice?.customer?.name || "-",
      "Invoice #": p.invoice?.invoiceNumber || "-",
      "Balance Amt": p.amount,
      "Mode": p.mode,
      "Collected By": p.invoice?.salesByUserId || "-"
    }));
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Balance Amt"]));
  });

  // ============ Coupon Redemption ============
  ownerRouter.get("/reports/coupon-redemption", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const redemptions = await prisma.couponRedemption.findMany({
      where: { createdAt: { gte: startDate, lte: endDate }, coupon: { salonId: req.salonId } },
      include: { coupon: true, customer: true, invoice: true },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = redemptions.map((r, idx) => ({
      "Date": r.createdAt,
      "Code": r.coupon?.code || "-",
      "Customer": r.customer?.name || "-",
      "Invoice #": r.invoice?.invoiceNumber || "-",
      "Discount Applied": r.amountSaved
    }));
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Discount Applied"]));
  });

  // ============ Tip Report ============
  ownerRouter.get("/reports/tip", requireFeatureEnabled("invoices"), requireSalonPermission("invoices", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const tips = await prisma.payment.findMany({
      where: { salonId: req.salonId, type: "TIP", createdAt: { gte: startDate, lte: endDate } },
      include: { invoice: { include: { customer: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = tips.map((p, idx) => ({
      "SR. NO.": idx + 1,
      "Date": p.createdAt,
      "Customer": p.invoice?.customer?.name || "-",
      "Phone": p.invoice?.customer?.phone || "-",
      "Invoice #": p.invoice?.invoiceNumber || "-",
      "Staff": p.invoice?.salesByUserId || "-",
      "Tip Amount": p.amount,
      "Payment Mode": p.mode
    }));
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Tip Amount"]));
  });

  // ============ Complimentary Report ============
  ownerRouter.get("/reports/complimentary", requireFeatureEnabled("invoices"), requireSalonPermission("invoices", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const invoices = await prisma.invoice.findMany({
      where: { ...buildInvoiceWhere(req, normalizeBranchId(req.query.branchId)), status: "PAID", total: 0, createdAt: { gte: startDate, lte: endDate } },
      include: { customer: true, branch: true, items: { include: { service: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = invoices.map((inv, idx) => {
      const firstService = inv.items.find(i => i.service)?.service?.name || "-";
      return {
        "Date": inv.createdAt,
        "Service": firstService,
        "Staff": inv.items[0]?.staffName || "-",
        "Customer": inv.customer?.name || "-",
        "Reason": inv.notes || "Complimentary",
        "Value": inv.subtotal
      };
    });
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Value"]));
  });

  // ============ GST Returns Report ============
  ownerRouter.get("/reports/gst-returns", requireFeatureEnabled("invoices"), requireSalonPermission("invoices", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: { ...buildInvoiceWhere(req, branchId), status: "PAID", createdAt: { gte: startDate, lte: endDate } },
      include: { customer: true, branch: true, items: true },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = invoices.map((inv, idx) => ({
      "SR. NO.": idx + 1,
      "Invoice Date": inv.createdAt,
      "Invoice No": inv.invoiceNumber,
      "Customer": inv.customer?.name || "-",
      "Customer GSTN": inv.customer?.gstNumber || "-",
      "HSN/SAC": inv.items[0]?.taxPct ? "HSN" : "SAC",
      "Amount": inv.subtotal,
      "Qty": inv.items.reduce((s, i) => s + (i.qty || 1), 0),
      "Discount": inv.discount,
      "Taxable Amount": inv.subtotal - inv.discount,
      "Invoice Amount": inv.total
    }));
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Qty", "Amount", "Discount", "Taxable Amount", "Invoice Amount"]));
  });

  // ============ GST Outwards Report ============
  ownerRouter.get("/reports/gst-outwards", requireFeatureEnabled("invoices"), requireSalonPermission("invoices", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: { ...buildInvoiceWhere(req, branchId), status: "PAID", tax: { gt: 0 }, createdAt: { gte: startDate, lte: endDate } },
      include: { customer: true, branch: true, items: true },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const mapped = invoices.map((inv, idx) => ({
      "Invoice #": inv.invoiceNumber,
      "Date": inv.createdAt,
      "Customer": inv.customer?.name || "-",
      "Taxable Amt": inv.subtotal - inv.discount,
      "Tax Rate": inv.items[0]?.taxPct ? `${inv.items[0].taxPct}%` : "0%",
      "Tax Amt": inv.tax,
      "Total": inv.total
    }));
    res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Taxable Amt", "Tax Amt", "Total"]));
  });

  // ============ Guest Followups ============
  ownerRouter.get("/reports/guest-followups", requireFeatureEnabled("customers"), requireSalonPermission("customers", "view"), async (req, res) => {
    const customers = await prisma.customer.findMany({
      where: { salonId: req.salonId, lastVisitAt: { not: null } },
      include: { timeline: { where: { eventType: "FOLLOW_UP" }, orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { lastVisitAt: "asc" },
      take: 200
    });
    const today = new Date();
    res.json(customers.map((c) => {
      const lastVisit = c.lastVisitAt ? new Date(c.lastVisitAt) : null;
      const daysSince = lastVisit ? Math.floor((today - lastVisit) / 86400000) : 0;
      const followUpStatus = c.timeline?.[0]?.status || "PENDING";
      return {
        "Customer": c.name,
        "Phone": c.phone,
        "Last Visit": c.lastVisitAt ? c.lastVisitAt.toISOString().slice(0,10) : "-",
        "Days Since": daysSince,
        "Follow-up Status": followUpStatus
      };
    }));
  });

  // ============ Material Received (Purchase Orders Received) ============
  ownerRouter.get("/reports/material-received", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const { vendorId, productId, transactionId, vendorInvoiceId } = buildReportFilters(req);
    const orders = await prisma.purchaseOrder.findMany({
      where: {
        salonId: req.salonId,
        status: { in: ["RECEIVED", "PARTIALLY_RECEIVED"] },
        receivedAt: { gte: startDate, lte: endDate },
        ...(vendorId ? { vendorId } : {}),
        ...(transactionId ? { OR: [{ transactionId: { contains: transactionId, mode: "insensitive" } }, { orderNumber: { contains: transactionId, mode: "insensitive" } }] } : {}),
        ...(vendorInvoiceId ? { vendorInvoiceId: { contains: vendorInvoiceId, mode: "insensitive" } } : {})
      },
      include: { vendor: true, items: { include: { product: true } } },
      orderBy: { receivedAt: "desc" },
      take: 500
    });
    const rows = [];
    orders.forEach((o) => {
      o.items.forEach((item) => {
        if (productId && item.productId !== productId) return;
        rows.push({
          "Date": o.receivedAt,
          "Transaction Id": o.transactionId || o.orderNumber || "-",
          "Vendor Invoice Id": o.vendorInvoiceId || "-",
          "Product": item.product?.name || "-",
          "Vendor": o.vendor?.name || "-",
          "Qty": item.quantityReceived,
          "Unit Cost": item.unitCost,
          "Total Cost": item.quantityReceived * Number(item.unitCost),
          "PO #": o.orderNumber
        });
      });
    });
    res.json(appendTotalRow(rows, "Product", "TOTAL", ["Qty", "Total Cost"]));
  });

  // ============ Reconcile Stock ============
  ownerRouter.get("/reports/reconcile-stock", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const reconciliations = await prisma.stockReconciliation.findMany({
      where: { salonId: req.salonId, createdAt: { gte: startDate, lte: endDate } },
      include: { items: { include: { product: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const rows = [];
    reconciliations.forEach((r) => {
      r.items.forEach((item) => {
        rows.push({
          "Product": item.product?.name || "-",
          "System Stock": item.systemStock,
          "Physical Count": item.physicalStock,
          "Variance": item.variance,
          "Date": r.createdAt,
          "Staff": r.createdByUserId || "-"
        });
      });
    });
    res.json(rows);
  });

  // ============ Consumable Tracking ============
  ownerRouter.get("/reports/consumable-tracking", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const movements = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, movementType: "CONSUMABLE_USAGE", createdAt: { gte: startDate, lte: endDate } },
      include: { product: true },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    const grouped = {};
    movements.forEach((m) => {
      const key = m.productId;
      if (!grouped[key]) {
        grouped[key] = {
          product: m.product?.name || "Unknown",
          service: m.note || "General",
          qtyPerService: 0,
          totalUsed: 0,
          cost: 0
        };
      }
      grouped[key].qtyPerService += 1;
      grouped[key].totalUsed += Math.abs(Number(m.quantity || 0));
      grouped[key].cost += Math.abs(Number(m.quantity || 0)) * Number(m.product?.costPrice || 0);
    });
    const mapped = Object.values(grouped).map((g, idx) => ({
      "Product": g.product,
      "Service": g.service,
      "Qty Used Per Service": g.qtyPerService,
      "Total Used": g.totalUsed,
      "Cost": g.cost
    }));
    res.json(appendTotalRow(mapped, "Product", "TOTAL", ["Qty Used Per Service", "Total Used", "Cost"]));
  });

  // ============ Total Consumed ============
  ownerRouter.get("/reports/total-consumed", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const movements = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, movementType: "CONSUMABLE_USAGE", createdAt: { gte: startDate, lte: endDate } },
      include: { product: { include: { category: true } } },
      orderBy: { createdAt: "desc" }
    });
    const grouped = {};
    movements.forEach((m) => {
      const key = m.productId;
      if (!grouped[key]) {
        grouped[key] = {
          product: m.product?.name || "Unknown",
          category: m.product?.category?.name || "-",
          totalQuantity: 0,
          value: 0
        };
      }
      const qty = Math.abs(Number(m.quantity || 0));
      grouped[key].totalQuantity += qty;
      grouped[key].value += qty * Number(m.product?.costPrice || 0);
    });
    const mapped = Object.values(grouped).map((g, idx) => ({
      "Product": g.product,
      "Category": g.category,
      "Total Quantity Consumed": g.totalQuantity,
      "Value": g.value
    }));
    res.json(appendTotalRow(mapped, "Product", "TOTAL", ["Total Quantity Consumed", "Value"]));
  });

  // ============ Purchase Order Report ============
  ownerRouter.get("/reports/purchase-order", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const orders = await prisma.purchaseOrder.findMany({
      where: { salonId: req.salonId, orderedAt: { gte: startDate, lte: endDate } },
      include: { vendor: true, items: { include: { product: true } } },
      orderBy: { orderedAt: "desc" },
      take: 500
    });
    const rows = [];
    orders.forEach((o) => {
      o.items.forEach((item) => {
        rows.push({
          "PO #": o.orderNumber,
          "Date": o.orderedAt,
          "Vendor": o.vendor?.name || "-",
          "Products": item.product?.name || "-",
          "Amount": Number(item.quantityOrdered) * Number(item.unitCost),
          "Status": o.status,
          "Received On": o.receivedAt ? o.receivedAt.toISOString().slice(0,10) : "-"
        });
      });
    });
    res.json(appendTotalRow(rows, "PO #", "TOTAL", ["Amount"]));
  });

  // ============ Inventory Transaction Report ============
  ownerRouter.get("/reports/inventory-transaction", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const { productId, stylistId } = buildReportFilters(req);
    const movements = await prisma.stockMovement.findMany({
      where: {
        salonId: req.salonId,
        createdAt: { gte: startDate, lte: endDate },
        ...(productId ? { productId } : {}),
        ...(stylistId ? { userSalonId: stylistId } : {})
      },
      include: { product: true, branch: true, userSalon: { include: { user: true } } },
      orderBy: { createdAt: "desc" },
      take: 500
    });
    res.json(movements.map((m, idx) => ({
      "Date": m.createdAt,
      "Product": m.product?.name || "-",
      "Type": m.movementType,
      "Qty": m.quantity,
      "Reference": m.referenceType ? `${m.referenceType}${m.referenceId ? ` #${m.referenceId.slice(-6)}` : ""}` : "-",
      "Branch": m.branch?.name || "-",
      "Staff": m.userSalon?.user?.name || "-"
    })));
  });

  // ============ PnL Report ============
  ownerRouter.get("/reports/pnl", requireFeatureEnabled("advancedReports"), requireSalonPermission("advancedReports", "view"), async (req, res) => {
    const { startDate, endDate } = buildDateRange(req);
    const branchId = normalizeBranchId(req.query.branchId);

    // Revenue
    const invoices = await prisma.invoice.findMany({
      where: { ...buildInvoiceWhere(req, branchId), status: "PAID", createdAt: { gte: startDate, lte: endDate } },
      include: { items: { include: { product: { include: { category: true } } } } }
    });
    const revenue = invoices.reduce((s, inv) => s + toAmount(inv.subtotal) - toAmount(inv.discount), 0);

    // Cost of Sales: products sold use actual costPrice from Product table
    const productCogs = invoices.reduce((s, inv) => s + inv.items
      .filter(i => i.itemType === "PRODUCT" && i.product)
      .reduce((a, i) => a + toAmount(i.qty || 1) * toAmount(i.product?.costPrice || 0), 0), 0);
    // Services: estimate consumable cost as a fraction of service revenue
    const consumableCogs = invoices.reduce((s, inv) => s + inv.items
      .filter(i => i.itemType === "SERVICE")
      .reduce((a, i) => a + toAmount(i.qty || 1) * toAmount(i.unitPrice || 0) * 0.05, 0), 0);
    const totalCogs = productCogs + consumableCogs;

    // Expenses grouped by category
    const expenses = await prisma.expense.findMany({
      where: { salonId: req.salonId, status: "APPROVED", expenseDate: { gte: startDate, lte: endDate } },
      include: { category: true }
    });
    const expenseByCategory = {};
    expenses.forEach((e) => {
      const cat = e.category?.name || "Other Expenses";
      expenseByCategory[cat] = (expenseByCategory[cat] || 0) + toAmount(e.amount);
    });
    const totalExpenses = Object.values(expenseByCategory).reduce((s, v) => s + v, 0);

    const grossProfit = revenue - totalCogs;
    const netProfitBeforeTax = grossProfit - totalExpenses;
    // Simplified income tax estimate: 0% below threshold, 25% above 5L in period
    const incomeTax = netProfitBeforeTax > 500000 ? Math.round(netProfitBeforeTax * 0.25) : 0;
    const netProfit = netProfitBeforeTax - incomeTax;

    const line = (name, profit = 0, loss = 0, isHeader = false, isTotal = false) => ({
      "NAME": name,
      "PROFIT": profit || 0,
      "LOSS": loss || 0,
      "_isHeader": isHeader,
      "_isTotal": isTotal
    });

    const rows = [
      line("Revenue", revenue, 0, true),
      line("Cost of Sales", 0, 0, true),
      line("Cosmetics", 0, productCogs),
      line("Cost of Consumable Goods", 0, consumableCogs),
      line("Gross Profit", grossProfit, 0, true),
      line("General and Administrative Expenses", 0, 0, true),
      ...Object.entries(expenseByCategory).map(([name, amount]) => line(name, 0, amount)),
      line("Profit before expense", netProfitBeforeTax, 0, true),
      line("Net profit before Income tax", netProfitBeforeTax, 0, true),
      line("Income tax", 0, incomeTax),
      line("Net Profit/Loss", netProfit, 0, false, true)
    ];

    res.json({
      title: `PNL Report for ${startDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}`,
      columns: ["NAME", "PROFIT", "LOSS"],
      rows,
      summary: { revenue, cogs: totalCogs, grossProfit, totalExpenses, netProfitBeforeTax, incomeTax, netProfit }
    });
  });
};
