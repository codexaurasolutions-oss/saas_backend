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

const buildPaymentWhere = (req, branchId) => ({
  salonId: req.salonId,
  invoice: { is: buildInvoiceWhere(req, branchId) }
});

const buildAppointmentWhere = (req, branchId) => {
  const start = parseDateSafe(req.query.start, false);
  const end = parseDateSafe(req.query.end, true);
  const stylistId = req.query.stylistId;
  const status = req.query.status;
  const date = req.query.date ? parseDateSafe(req.query.date, false) : null;
  return {
    salonId: req.salonId,
    ...(branchId ? { branchId } : {}),
    ...(isOwnScopedStaff(req, "reports")
      ? { items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } } }
      : stylistId
        ? { items: { some: { assignedStaff: { some: { userSalonId: stylistId } } } } }
        : {}),
    ...(status ? { status } : {}),
    ...(date
      ? { startAt: { gte: date, lte: new Date(date.getTime() + 86399999) } }
      : (start || end
        ? {
            startAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {})
            }
          }
        : {}))
  };
};

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

reportsRouter.get("/sales-summary-dashboard", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const start = parseDateSafe(req.query.start, false);
  const end = parseDateSafe(req.query.end, true);

  const salonSettings = await prisma.salonSetting.findFirst({
    where: { salonId: req.salonId, branchId: null }
  });
  const advancedSettings = salonSettings?.advancedSettings && typeof salonSettings.advancedSettings === "object"
    ? salonSettings.advancedSettings
    : {};
  const inclusiveTax = advancedSettings?.taxMapping?.inclusiveTax === true;

  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, branchId),
    include: { customer: true, payments: true, items: true }
  });

  let grossSale = 0;
  let grossCount = invoices.length;

  let serviceNet = 0;
  let serviceCount = 0;
  let serviceTaxInclusive = 0;
  let serviceTaxExclusive = 0;
  let serviceWalletUsed = 0;
  let serviceTotalWithTaxes = 0;

  let productNet = 0;
  let productCount = 0;
  let productTaxInclusive = 0;
  let productTaxExclusive = 0;
  let productWalletUsed = 0;
  let productTotalWithTaxes = 0;

  let packageNet = 0;
  let packageCount = 0;
  let packageTaxInclusive = 0;
  let packageTaxExclusive = 0;
  let packageTotalWithTaxes = 0;

  let membershipNet = 0;
  let membershipCount = 0;
  let membershipTaxInclusive = 0;
  let membershipTaxExclusive = 0;
  let membershipTopupWithoutTaxes = 0;
  let membershipTotalWithTaxes = 0;

  let giftCardNet = 0;
  let giftCardCount = 0;

  const serviceSalesMap = {};
  const productSalesMap = {};
  const stylistSalesMap = {};
  const packageSalesMap = {};
  const membershipSalesMap = {};

  const customersWithServiceOrProduct = new Set();
  const allFootfallCustomerIds = new Set();

  invoices.forEach((inv) => {
    const total = toAmount(inv.total);
    grossSale += total;
    if (inv.customerId) {
      allFootfallCustomerIds.add(inv.customerId);
    }

    inv.items.forEach((item) => {
      const lineTotal = toAmount(item.lineTotal);
      const qty = Number(item.qty || 1);
      const unitPrice = toAmount(item.unitPrice);
      const taxPct = toAmount(item.taxPct);
      const walletUsed = toAmount(item.membershipWalletUsed);
      const preTax = unitPrice * qty;

      let itemTax = 0;
      if (taxPct > 0) {
        if (inclusiveTax) {
          itemTax = (preTax * taxPct) / (100 + taxPct);
        } else {
          itemTax = (preTax * taxPct) / 100;
        }
      }

      const staffName = item.staffName || "Unassigned";
      stylistSalesMap[staffName] = (stylistSalesMap[staffName] || 0) + lineTotal;

      if (item.itemType === "SERVICE") {
        serviceNet += lineTotal;
        serviceCount += qty;
        serviceSalesMap[item.serviceName || "Service"] = (serviceSalesMap[item.serviceName || "Service"] || 0) + lineTotal;
        if (inv.customerId) customersWithServiceOrProduct.add(inv.customerId);

        serviceTotalWithTaxes += lineTotal;
        serviceWalletUsed += walletUsed;
        if (inclusiveTax) {
          serviceTaxInclusive += itemTax;
        } else {
          serviceTaxExclusive += itemTax;
        }
      } else if (item.itemType === "PRODUCT") {
        productNet += lineTotal;
        productCount += qty;
        productSalesMap[item.productName || "Product"] = (productSalesMap[item.productName || "Product"] || 0) + lineTotal;
        if (inv.customerId) customersWithServiceOrProduct.add(inv.customerId);

        productTotalWithTaxes += lineTotal;
        productWalletUsed += walletUsed;
        if (inclusiveTax) {
          productTaxInclusive += itemTax;
        } else {
          productTaxExclusive += itemTax;
        }
      } else if (item.itemType === "PACKAGE") {
        packageNet += lineTotal;
        packageCount += qty;
        packageSalesMap[item.serviceName || "Package"] = (packageSalesMap[item.serviceName || "Package"] || 0) + lineTotal;

        packageTotalWithTaxes += lineTotal;
        if (inclusiveTax) {
          packageTaxInclusive += itemTax;
        } else {
          packageTaxExclusive += itemTax;
        }
      } else if (item.itemType === "MEMBERSHIP") {
        membershipNet += lineTotal;
        membershipCount += qty;
        membershipSalesMap[item.serviceName || "Membership"] = (membershipSalesMap[item.serviceName || "Membership"] || 0) + lineTotal;

        membershipTotalWithTaxes += lineTotal;
        const membershipTax = (preTax * taxPct) / 100;
        membershipTaxExclusive += membershipTax;
        membershipTopupWithoutTaxes += preTax;
      } else if (item.itemType === "GIFT_CARD") {
        giftCardNet += lineTotal;
        giftCardCount += qty;
      }
    });
  });

  let totalDiscount = invoices.reduce((sum, inv) => sum + toAmount(inv.discount), 0);
  let totalRedemption = 0;
  invoices.forEach(inv => {
    inv.items.forEach(item => {
      totalRedemption += toAmount(item.membershipWalletUsed) + toAmount(item.packageSessionsUsed);
    });
  });

  let onlineCollection = 0;
  let offlineCollection = 0;
  invoices.forEach((inv) => {
    inv.payments.forEach((p) => {
      const amt = toAmount(p.amount);
      const modeUpper = String(p.mode || "").toUpperCase();
      if (modeUpper === "ONLINE" || modeUpper.includes("UPI") || modeUpper.includes("CARD") || modeUpper.includes("NET") || modeUpper.includes("BANK")) {
        onlineCollection += amt;
      } else {
        offlineCollection += amt;
      }
    });
  });

  const totalGuestFootfall = allFootfallCustomerIds.size;
  const newGuests = await prisma.customer.findMany({
    where: {
      salonId: req.salonId,
      ...(start || end ? {
        createdAt: {
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      } : {})
    },
    select: { id: true }
  });
  const newGuestIds = new Set(newGuests.map(g => g.id));
  let newGuestFootfall = 0;
  allFootfallCustomerIds.forEach(cid => {
    if (newGuestIds.has(cid)) newGuestFootfall++;
  });
  const repetitiveGuestFootfall = Math.max(0, totalGuestFootfall - newGuestFootfall);
  const footfallPurchasedPct = totalGuestFootfall > 0 ? Math.round((customersWithServiceOrProduct.size / totalGuestFootfall) * 100) : 0;

  const formatTop5 = (map) => {
    return Object.entries(map)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);
  };

  const topServices = formatTop5(serviceSalesMap);
  const topProducts = formatTop5(productSalesMap);
  const topStylists = formatTop5(stylistSalesMap);
  const topPackages = formatTop5(packageSalesMap);
  const topMemberships = formatTop5(membershipSalesMap);

  const clientCountMap = {};
  invoices.forEach((inv) => {
    const dStr = new Date(inv.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    clientCountMap[dStr] = (clientCountMap[dStr] || 0) + 1;
  });
  const clientCountList = Object.entries(clientCountMap).map(([name, value]) => ({ name, value })).slice(-10);

  const avgBillValue = grossCount > 0 ? Math.round(grossSale / grossCount) : 0;
  const avgServiceBillValue = serviceCount > 0 ? Math.round(serviceNet / serviceCount) : 0;
  const avgProductBillValue = productCount > 0 ? Math.round(productNet / productCount) : 0;

  res.json({
    cards: {
      grossSale: { value: grossSale, count: grossCount },
      serviceNetSale: {
        value: serviceNet,
        count: serviceCount,
        details: {
          totalServiceSaleWithTaxes: serviceTotalWithTaxes,
          inclusiveTaxes: serviceTaxInclusive,
          exclusiveTaxes: serviceTaxExclusive,
          membershipRedemption: serviceWalletUsed
        }
      },
      productNetSale: {
        value: productNet,
        count: productCount,
        details: {
          totalProductSaleWithTaxes: productTotalWithTaxes,
          inclusiveTaxes: productTaxInclusive,
          exclusiveTaxes: productTaxExclusive,
          membershipRedemption: productWalletUsed
        }
      },
      packageNetSale: {
        value: packageNet,
        count: packageCount,
        details: {
          totalPackageSaleWithTaxes: packageTotalWithTaxes,
          inclusiveTaxes: packageTaxInclusive,
          exclusiveTaxes: packageTaxExclusive
        }
      },
      membershipNetSale: {
        value: membershipNet,
        count: membershipCount,
        details: {
          totalMembershipSaleWithTaxes: membershipTotalWithTaxes,
          topupAmountWithoutTaxes: membershipTopupWithoutTaxes,
          inclusiveTaxes: membershipTaxInclusive,
          exclusiveTaxes: membershipTaxExclusive
        }
      },
      giftCardNetSale: { value: giftCardNet, count: giftCardCount }
    },
    revenueSources: {
      serviceSale: serviceNet,
      productSale: productNet,
      totalSale: serviceNet + productNet
    },
    adjustments: {
      discount: totalDiscount,
      totalRedemption: totalRedemption
    },
    collection: {
      online: onlineCollection,
      offline: offlineCollection
    },
    footfall: {
      totalGuestFootfall,
      newGuestFootfall,
      repetitiveGuestFootfall,
      purchasedPct: footfallPurchasedPct
    },
    topServices,
    topProducts,
    topStylists,
    topPackages,
    topMemberships,
    clientCount: clientCountList,
    averageSale: {
      totalGrossSale: grossSale,
      totalTransactions: grossCount,
      avgBillValue,
      avgServiceBillValue,
      avgProductBillValue
    }
  });
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
  const start = parseDateSafe(req.query.start, false);
  const end = parseDateSafe(req.query.end, true);
  const rows = await prisma.customerMembership.findMany({
    where: {
      ...(isOwnScopedStaff(req, "reports")
        ? { salonId: req.salonId, soldInvoice: { is: { items: { some: { staffUserSalonId: req.user.membershipId } } } } }
        : { salonId: req.salonId }),
      ...(start || end ? {
        createdAt: {
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      } : {})
    },
    include: { membershipPlan: true, customer: true, soldInvoice: true, usageLogs: true },
    orderBy: { createdAt: "desc" }
  });
  res.json(rows);
});

reportsRouter.get("/packages", async (req, res) => {
  const start = parseDateSafe(req.query.start, false);
  const end = parseDateSafe(req.query.end, true);
  const rows = await prisma.customerPackage.findMany({
    where: {
      ...(isOwnScopedStaff(req, "reports")
        ? { salonId: req.salonId, soldInvoice: { is: { items: { some: { staffUserSalonId: req.user.membershipId } } } } }
        : { salonId: req.salonId }),
      ...(start || end ? {
        createdAt: {
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      } : {})
    },
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
      : { salonId: req.salonId, invoices: { some: {} } },
    include: {
      invoices: { include: { payments: true, items: true } },
      memberships: { include: { membershipPlan: true, usageLogs: true } },
      packages: { include: { package: true, usageLogs: true } }
    },
    orderBy: { totalSpend: "desc" }
  });

  // Only include customers with at least one purchase
  const customersWithPurchases = customers.filter((c) => c.invoices.length > 0);

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

  // Helper: return null instead of 0 when there's no data for this column
  const nullIfZero = (value) => (value === 0 || value === undefined || value === null) ? null : value;

  const rows = customersWithPurchases.map((c, idx) => {
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
      "TAXES": nullIfZero(totalTax),
      "GIFT CARD": nullIfZero(gcByCustomer[c.id]),
      "COUPON": nullIfZero(cpByCustomer[c.id]),
      "REFERRAL": null,
      "LOYALTY": nullIfZero(loyByCustomer[c.id]),
      "BALANCE PENDING": nullIfZero(balancePending),
      "ADVANCE UTILIZED": nullIfZero(advanceUtilized),
      "PACKAGE REDEMPTION": nullIfZero(pkgRedemption),
      "BALANCE CLEARED": nullIfZero(balanceCleared),
      "MEMBERSHIP REDEMPTION": nullIfZero(memRedemption),
      "ONLINE": nullIfZero(onlineTotal),
      "OFFLINE": nullIfZero(offlineTotal),
      "TOTAL": toAmount(c.totalSpend)
    };
  });

  // Add a TOTAL row at the end
  const totalRow = {
    "SR. NO.": null,
    "GUEST NAME": "TOTAL",
    "GUEST NUMBER": null,
    "COUNT": rows.reduce((sum, r) => sum + (r["COUNT"] || 0), 0),
    "TAXES": rows.reduce((sum, r) => sum + (r["TAXES"] || 0), 0),
    "GIFT CARD": rows.reduce((sum, r) => sum + (r["GIFT CARD"] || 0), 0),
    "COUPON": rows.reduce((sum, r) => sum + (r["COUPON"] || 0), 0),
    "REFERRAL": rows.reduce((sum, r) => sum + (r["REFERRAL"] || 0), 0),
    "LOYALTY": rows.reduce((sum, r) => sum + (r["LOYALTY"] || 0), 0),
    "BALANCE PENDING": rows.reduce((sum, r) => sum + (r["BALANCE PENDING"] || 0), 0),
    "ADVANCE UTILIZED": rows.reduce((sum, r) => sum + (r["ADVANCE UTILIZED"] || 0), 0),
    "PACKAGE REDEMPTION": rows.reduce((sum, r) => sum + (r["PACKAGE REDEMPTION"] || 0), 0),
    "BALANCE CLEARED": rows.reduce((sum, r) => sum + (r["BALANCE CLEARED"] || 0), 0),
    "MEMBERSHIP REDEMPTION": rows.reduce((sum, r) => sum + (r["MEMBERSHIP REDEMPTION"] || 0), 0),
    "ONLINE": rows.reduce((sum, r) => sum + (r["ONLINE"] || 0), 0),
    "OFFLINE": rows.reduce((sum, r) => sum + (r["OFFLINE"] || 0), 0),
    "TOTAL": rows.reduce((sum, r) => sum + (r["TOTAL"] || 0), 0)
  };

  res.json([...rows, totalRow]);
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
