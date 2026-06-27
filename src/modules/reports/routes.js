import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { appendTotalRow, attachBranchStock, buildCsv, isOwnScopedStaff, normalizeBranchId, toAmount } from "../../lib/phase2.js";
import { requireAuth, requireFeatureEnabled, requireSalonContext, requireSalonPermission } from "../../middlewares/rbac.js";

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

  const itemsFilters = [];
  if (stylistId) itemsFilters.push({ staffUserSalonId: stylistId });
  if (productId) itemsFilters.push({ productId });
  if (serviceId) itemsFilters.push({ serviceId });
  if (categoryId) itemsFilters.push({ product: { categoryId } });
  if (isOwnScopedStaff(req, "reports")) {
    itemsFilters.push({ staffUserSalonId: req.user.membershipId });
  }

  return {
    salonId: req.salonId,
    ...(branchId ? { branchId } : {}),
    ...(itemsFilters.length > 0 ? { items: { some: { AND: itemsFilters } } } : {}),
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

  const mapped = invoices.map((invoice, idx) => {
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
  });

  res.json(appendTotalRow(mapped, "GUEST NAME", "TOTAL", ["ITEMS", "GROSS AMOUNT", "DISCOUNT", "TAX", "NET TOTAL", "PAID AMOUNT", "DUE AMOUNT"]));
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
  const mapped = rows.map((r) => {
    const total = r.items?.reduce((s, i) => s + toAmount(i.lineTotal || i.unitPrice || 0), 0) || 0;
    const services = r.items?.map((i) => i.service?.name || i.serviceName).filter(Boolean).join(", ") || "-";
    const staff = r.items?.flatMap((i) => i.assignedStaff || []).map((a) => a.userSalon?.user?.name).filter(Boolean).join(", ") || "-";
    return {
      Date: r.startAt,
      Customer: r.customer?.name || "Walk-in",
      Service: services,
      Staff: staff,
      Branch: r.branch?.name || "-",
      Status: r.status || "-",
      Amount: total
    };
  });
  res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Amount"]));
});

const sendStaffPerformance = async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, branchId),
    include: { items: true, customer: true, payments: true }
  });

  const summary = {};
  const uniqueGuests = {};

  invoices.forEach((invoice) => {
    if (invoice.customerId) {
      invoice.items.forEach((item) => {
        if (!item.staffUserSalonId) return;
        const guestSet = uniqueGuests[item.staffUserSalonId] || (uniqueGuests[item.staffUserSalonId] = new Set());
        guestSet.add(invoice.customerId);
      });
    }

    invoice.items.forEach((item) => {
      if (!item.staffUserSalonId) return;
      const row = summary[item.staffUserSalonId] || (summary[item.staffUserSalonId] = {
        staffId: item.staffUserSalonId,
        staffName: item.staffName || "Assigned Staff",
        totalServicesDone: 0,
        uniqueGuestCount: 0,
        servicesWithoutTax: 0,
        productsWithoutTax: 0,
        averageRetailSale: 0,
        packagesRevenue: 0,
        packagesSold: 0,
        membershipsSold: 0,
        membershipsRevenue: 0,
        giftCardRevenue: 0,
        discount: 0,
        totalWithoutTax: 0,
        complimentaryAmount: 0,
        redemptionAmount: 0,
        averageBillValue: 0,
        invoiceCount: 0,
        invoiceIds: new Set()
      });
      if (!row.staffName && item.staffName) row.staffName = item.staffName;

      const qty = Number(item.qty || 0);
      const unitPrice = toAmount(item.unitPrice);
      const preTax = unitPrice * qty;
      const lineTotal = toAmount(item.lineTotal);
      const isComplimentary = toAmount(invoice.total) === 0;
      const redemption = toAmount(item.membershipWalletUsed) + toAmount(item.packageSessionsUsed);

      row.totalServicesDone += qty;
      row.totalWithoutTax += preTax;
      row.redemptionAmount += redemption;
      row.discount += toAmount(invoice.discount); // will be deduped per invoice below
      if (isComplimentary) row.complimentaryAmount += lineTotal;
      row.invoiceIds.add(invoice.id);

      if (item.itemType === "SERVICE") row.servicesWithoutTax += preTax;
      if (item.itemType === "PRODUCT") row.productsWithoutTax += preTax;
      if (item.itemType === "PACKAGE") { row.packagesRevenue += lineTotal; row.packagesSold += qty; }
      if (item.itemType === "MEMBERSHIP") { row.membershipsRevenue += lineTotal; row.membershipsSold += qty; }
      if (item.itemType === "GIFT_CARD") row.giftCardRevenue += lineTotal;
    });
  });

  // Deduplicate discount per invoice (it was added once per item above)
  Object.keys(summary).forEach((staffId) => {
    const row = summary[staffId];
    row.uniqueGuestCount = uniqueGuests[staffId]?.size || 0;
    row.invoiceCount = row.invoiceIds.size;
    row.averageRetailSale = row.invoiceCount > 0 ? Math.round(row.totalWithoutTax / row.invoiceCount) : 0;
    row.averageBillValue = row.invoiceCount > 0 ? Math.round(row.totalWithoutTax / row.invoiceCount) : 0;
    row.discount = Math.round(row.discount);
    delete row.invoiceIds;
  });

  const rows = Object.values(summary).sort((a, b) => b.totalWithoutTax - a.totalWithoutTax);
  const filtered = isOwnScopedStaff(req, "reports") ? rows.filter((row) => row.staffId === req.user.membershipId) : rows;
  const mapped = filtered.map((r, idx) => ({
    "SR. NO.": idx + 1,
    "STAFF": r.staffName,
    "TOTAL SERVICES DONE": r.totalServicesDone,
    "UNIQUE GUEST COUNT": r.uniqueGuestCount,
    "SERVICES WITHOUT TAX": r.servicesWithoutTax,
    "PRODUCTS WITHOUT TAX": r.productsWithoutTax,
    "AVERAGE RETAIL SALE": r.averageRetailSale,
    "PACKAGES REVENUE": r.packagesRevenue,
    "PACKAGES SOLD": r.packagesSold,
    "MEMBERSHIP SOLD": r.membershipsSold,
    "MEMBERSHIP REVENUE": r.membershipsRevenue,
    "GIFTCARD REVENUE": r.giftCardRevenue,
    "DISCOUNT": r.discount,
    "TOTAL WITHOUT TAX": r.totalWithoutTax,
    "COMPLIMENTARY AMOUNT": r.complimentaryAmount,
    "REDEMPTION AMOUNT": r.redemptionAmount,
    "AVERAGE BILL VALUE": r.averageBillValue
  }));
  res.json(appendTotalRow(mapped, "STAFF", "TOTAL", [
    "TOTAL SERVICES DONE", "UNIQUE GUEST COUNT", "SERVICES WITHOUT TAX", "PRODUCTS WITHOUT TAX",
    "AVERAGE RETAIL SALE", "PACKAGES REVENUE", "PACKAGES SOLD", "MEMBERSHIP SOLD", "MEMBERSHIP REVENUE",
    "GIFTCARD REVENUE", "DISCOUNT", "TOTAL WITHOUT TAX", "COMPLIMENTARY AMOUNT", "REDEMPTION AMOUNT",
    "AVERAGE BILL VALUE"
  ]));
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
    include: {
      product: { include: { category: true } },
      invoice: { include: { customer: true, payments: true } },
      staffUserSalon: { include: { user: true } }
    },
    orderBy: { id: "desc" }
  });

  const productIds = [...new Set(rows.map(r => r.productId).filter(Boolean))];
  const products = productIds.length > 0
    ? await prisma.product.findMany({ where: { id: { in: productIds } }, include: { category: true } })
    : [];
  const productMap = {};
  products.forEach(p => { productMap[p.id] = p; });

  const group = (req.query.group || "none").toLowerCase();
  const groupData = (req.query.groupData || "none").toLowerCase();

  const grouped = new Map();
  rows.forEach((row) => {
    const product = productMap[row.productId] || row.product;
    const productName = product?.name || row.serviceName || "Uncategorized Product";
    const categoryName = product?.category?.name || "-";

    let key;
    if (group === "product") key = row.productId || `name:${productName}`;
    else if (group === "service") return;
    else key = row.id;

    if (!grouped.has(key)) {
      grouped.set(key, {
        firstRow: row,
        productId: row.productId,
        productName,
        categoryName,
        qty: 0,
        sales: 0,
        unitPrices: new Set(),
        redemption: 0,
        complimentary: 0,
        tax: 0,
        subtotal: 0,
        groupDate: null,
        groupCategory: categoryName
      });
    }
    const acc = grouped.get(key);
    acc.qty += Number(row.qty || 0);
    const lineTotal = toAmount(row.lineTotal);
    const unitPrice = toAmount(row.unitPrice);
    acc.sales += lineTotal;
    acc.unitPrices.add(unitPrice);
    if (toAmount(row.invoice?.total) === 0) acc.complimentary += lineTotal;
    acc.redemption += toAmount(row.membershipWalletUsed) + toAmount(row.packageSessionsUsed);
    const taxAmt = toAmount(row.invoice?.tax) || (unitPrice * Number(row.qty || 0) * toAmount(row.taxPct) / 100);
    acc.tax += taxAmt;
    acc.subtotal += Math.max(0, lineTotal - taxAmt);
    if (groupData === "date" && !acc.groupDate) {
      acc.groupDate = new Date(row.invoice?.createdAt || Date.now()).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-");
    }
  });

  const result = Array.from(grouped.values());
  if (group === "product") result.sort((a, b) => b.sales - a.sales);

  const mapped = result.map((acc, idx) => {
    const row = acc.firstRow;
    const inv = row.invoice;
    const dateObj = new Date(inv?.createdAt || Date.now());
    const paymentModes = inv?.payments?.map(p => p.mode).filter(Boolean).join(", ") || "";
    const unitPriceDisplay = acc.unitPrices.size === 1
      ? Array.from(acc.unitPrices)[0]
      : "Mixed";
    return {
      "SR. NO.": idx + 1,
      "DATE": dateObj.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-"),
      "TIME": dateObj.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      "GUEST NAME": inv?.customer?.name || "Walk-in",
      "GUEST NUMBER": inv?.customer?.phone || "-",
      "INVOICE NO": inv?.invoiceNumber || "-",
      "PRODUCT": acc.productName,
      "CATEGORY": acc.categoryName,
      "QTY": acc.qty,
      "UNIT PRICE": unitPriceDisplay,
      "COMPLIMENTARY": acc.complimentary,
      "REDEMPTION AMOUNT": acc.redemption,
      "TAX": acc.tax,
      "SUBTOTAL": acc.subtotal,
      "TOTAL": acc.sales,
      "PAYMENT MODE": paymentModes
    };
  });

  res.json(appendTotalRow(mapped, "PRODUCT", "TOTAL", ["QTY", "UNIT PRICE", "COMPLIMENTARY", "REDEMPTION AMOUNT", "TAX", "SUBTOTAL", "TOTAL"]));
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

  const mapped = rows.map((row, idx) => {
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
  });

  res.json(appendTotalRow(mapped, "GUEST NAME", "TOTAL", ["QTY", "UNIT PRICE", "DISCOUNT", "COMPLIMENTARY", "REDEMPTION AMOUNT", "TAX", "SUBTOTAL", "TOTAL"]));
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
  const mapped = rows.map((r) => ({
    Date: r.createdAt,
    Customer: r.customer?.name || "-",
    "Membership Plan": r.membershipPlan?.name || "-",
    Price: r.pricePaid ?? toAmount(r.soldInvoice?.total),
    Validity: r.validUntil ? new Date(r.validUntil).toISOString().slice(0, 10) : (r.membershipPlan?.validityDays ? `${r.membershipPlan.validityDays} days` : "-"),
    Branch: r.soldInvoice?.branchName || "-"
  }));
  res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Price"]));
});

reportsRouter.get("/packages", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const start = parseDateSafe(req.query.start, false);
  const end = parseDateSafe(req.query.end, true);
  const rows = await prisma.customerPackage.findMany({
    where: {
      salonId: req.salonId,
      ...(branchId ? { branchId } : {}),
      ...(isOwnScopedStaff(req, "reports")
        ? { soldInvoice: { is: { items: { some: { staffUserSalonId: req.user.membershipId } } } } }
        : {}),
      ...(start || end ? {
        createdAt: {
          ...(start ? { gte: start } : {}),
          ...(end ? { lte: end } : {})
        }
      } : {})
    },
    include: {
      package: { include: { services: true } },
      customer: true,
      soldInvoice: { include: { items: { include: { staffUserSalon: { include: { user: true } } } }, payments: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  const mapped = rows.map((r, idx) => {
    const inv = r.soldInvoice;
    const packageItem = inv?.items?.find(i => i.itemType === "PACKAGE" && i.packageId === r.packageId);
    const staff = packageItem?.staffUserSalon?.user?.name || packageItem?.staffName || "-";
    const purchaseDate = r.createdAt ? new Date(r.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : "-";
    const businessDate = inv?.createdAt ? new Date(inv.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : purchaseDate;
    const expiryDate = r.validUntil ? new Date(r.validUntil).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-") : "-";
    const subtotal = toAmount(packageItem?.lineTotal) || toAmount(inv?.subtotal) || toAmount(r.pricePaid);
    const tax = toAmount(inv?.tax) || 0;
    const total = toAmount(inv?.total) || toAmount(r.pricePaid);
    const paymentModes = inv?.payments?.map(p => p.mode).filter(Boolean).join(", ") || "-";
    const purchaseSource = inv?.invoiceNumber?.toString().toUpperCase().startsWith("PCK") ? "POS" : "Online";

    return {
      "SR. NO.": idx + 1,
      "INVOICE NO.": inv?.invoiceNumber || "-",
      "PURCHASE DATE": purchaseDate,
      "BUSINESS DATE": businessDate,
      "EXPIRY DATE": expiryDate,
      "GUEST NAME": r.customer?.name || "-",
      "GUEST NUMBER": r.customer?.phone || "-",
      "STAFF": staff,
      "PACKAGE NAME": r.package?.name || "-",
      "SUBTOTAL": subtotal,
      "TAX": tax,
      "TOTAL": total,
      "PAYMENT MODE": paymentModes,
      "PURCHASE SOURCE": purchaseSource
    };
  });
  res.json(appendTotalRow(mapped, "PACKAGE NAME", "TOTAL", ["SUBTOTAL", "TAX", "TOTAL"]));
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

  if (req.query.format === "daily-stock") {
    const products = await prisma.product.findMany({
      where: { salonId: req.salonId, isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }, { stockMovements: { some: { branchId } } }] } : {}) },
      include: { category: true, branch: true },
      orderBy: { name: "asc" }
    });
    const rows = await attachBranchStock(prisma, products, branchId);
    const mapped = rows.map((p, idx) => ({
      "SR. NO.": idx + 1,
      "ITEM NAME": p.name,
      "VARIATION NAME": p.variationName || "-",
      "CATEGORY NAME": p.category?.name || "-",
      "SKU": p.sku || "-",
      "OPENING STOCK": p.openingStock ?? "-",
      "CURRENT STOCK": toAmount(p.currentStock),
      "CURRENT ONFLOOR": toAmount(p.currentOnFloor),
      "UNIT PRICE": toAmount(p.price),
      "TOTAL STOCK PRICE": toAmount(p.currentStock) * toAmount(p.price),
      "TOTAL ONFLOOR PRICE": toAmount(p.currentOnFloor) * toAmount(p.price),
      "TOTAL PRICE": toAmount(p.currentStock) * toAmount(p.price),
      "STOCK TYPE": p.stockType || "-"
    }));
    return res.json(appendTotalRow(mapped, "ITEM NAME", "TOTAL", ["CURRENT STOCK", "CURRENT ONFLOOR", "TOTAL STOCK PRICE", "TOTAL ONFLOOR PRICE", "TOTAL PRICE"]));
  }

  res.json(await prisma.stockMovement.findMany({
    where: { salonId: req.salonId, ...(branchId ? { branchId } : {}) },
    include: { product: true },
    orderBy: { createdAt: "desc" }
  }));
});

reportsRouter.get("/low-stock", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const productId = req.query.productId;
  const products = await prisma.product.findMany({
    where: {
      salonId: req.salonId,
      isActive: true,
      ...(productId ? { id: productId } : {}),
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
    include: { branch: true, payments: true }
  });
  const grouped = invoices.reduce((acc, invoice) => {
    const key = invoice.branch?.name || "Unassigned";
    if (!acc[key]) acc[key] = { branch: key, sales: 0, paid: 0, cash: 0, card: 0, upi: 0, online: 0, count: 0 };
    acc[key].sales += toAmount(invoice.total);
    acc[key].paid += toAmount(invoice.paidAmount);
    acc[key].count += 1;
    invoice.payments?.forEach(p => {
      const amt = toAmount(p.amount);
      const mode = (p.mode || "").toUpperCase();
      if (mode === "CASH") acc[key].cash += amt;
      else if (mode === "CARD") acc[key].card += amt;
      else if (mode === "UPI") acc[key].upi += amt;
      if (p.mode === "ONLINE" || mode === "ONLINE") acc[key].online += amt;
    });
    return acc;
  }, {});
  const result = Object.values(grouped);
  const mapped = result.map(r => ({ Date: r.branch, Invoices: r.count, Cash: r.cash, Card: r.card, UPI: r.upi, Online: r.online, Total: r.sales }));
  res.json(appendTotalRow(mapped, "Date", "TOTAL", ["Invoices", "Cash", "Card", "UPI", "Online", "Total"]));
});

reportsRouter.get("/cancelled-invoices", async (req, res) => {
  const invoices = await prisma.invoice.findMany({
    where: { ...buildInvoiceWhere(req, null), status: { in: ["CANCELLED", "REFUNDED"] } },
    include: { customer: true, branch: true, payments: true },
    orderBy: { createdAt: "desc" }
  });
  const mapped = invoices.map((inv, idx) => ({
    Invoice: inv.invoiceNumber || "-",
    Customer: inv.customer?.name || "Walk-in",
    Branch: inv.branch?.name || "-",
    Status: inv.status || "-",
    Total: toAmount(inv.total),
    Paid: toAmount(inv.paidAmount),
    Refunded: toAmount(inv.refundAmount)
  }));
  res.json(appendTotalRow(mapped, "Customer", "TOTAL", ["Total", "Paid", "Refunded"]));
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

reportsRouter.get("/day-wise", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoices = await prisma.invoice.findMany({
    where: buildInvoiceWhere(req, branchId),
    include: { items: true, payments: true },
    orderBy: { createdAt: "asc" }
  });

  const grouped = {};
  invoices.forEach((invoice) => {
    const dateKey = new Date(invoice.createdAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).replace(/ /g, "-");
    if (!grouped[dateKey]) {
      grouped[dateKey] = {
        date: dateKey,
        serviceRevenue: 0,
        productRevenue: 0,
        membershipRevenue: 0,
        packageRevenue: 0,
        giftCardRevenue: 0,
        inclusiveTax: 0,
        exclusiveTax: 0,
        totalTax: 0,
        discount: 0,
        advanceAdded: 0,
        totalRevenue: 0,
        online: 0,
        offline: 0,
        balance: 0,
        invoiceCount: 0
      };
    }
    const g = grouped[dateKey];
    g.invoiceCount += 1;
    g.discount += toAmount(invoice.discount);
    g.totalRevenue += toAmount(invoice.total);
    g.balance += Math.max(0, toAmount(invoice.total) - toAmount(invoice.paidAmount) - toAmount(invoice.refundAmount));

    invoice.items.forEach((item) => {
      const lineTotal = toAmount(item.lineTotal);
      const qty = Number(item.qty || 1);
      const unitPrice = toAmount(item.unitPrice);
      const preTax = unitPrice * qty;
      const taxPct = toAmount(item.taxPct);
      let itemTax = 0;
      if (taxPct > 0) itemTax = lineTotal - preTax; // approximate

      if (item.itemType === "SERVICE") g.serviceRevenue += lineTotal;
      if (item.itemType === "PRODUCT") g.productRevenue += lineTotal;
      if (item.itemType === "MEMBERSHIP") g.membershipRevenue += lineTotal;
      if (item.itemType === "PACKAGE") g.packageRevenue += lineTotal;
      if (item.itemType === "GIFT_CARD") g.giftCardRevenue += lineTotal;

      g.totalTax += itemTax;
      // rough split: if taxPct looks inclusive vs exclusive based on lineTotal vs preTax
      if (Math.abs(lineTotal - preTax) < 0.01) {
        g.inclusiveTax += itemTax;
      } else {
        g.exclusiveTax += itemTax;
      }
    });

    invoice.payments.forEach((p) => {
      const amt = toAmount(p.amount);
      const modeUpper = String(p.mode || "").toUpperCase();
      if (modeUpper === "ONLINE" || modeUpper.includes("UPI") || modeUpper.includes("CARD") || modeUpper.includes("NET") || modeUpper.includes("BANK")) {
        g.online += amt;
      } else if (modeUpper === "ADVANCE") {
        g.advanceAdded += amt;
      } else {
        g.offline += amt;
      }
    });
  });

  const result = Object.values(grouped).map((g, idx) => ({
    "SR. NO.": idx + 1,
    "DATE": g.date,
    "SERVICE REVENUE": g.serviceRevenue,
    "PRODUCT REVENUE": g.productRevenue,
    "MEMBERSHIP REVENUE": g.membershipRevenue,
    "PACKAGE REVENUE": g.packageRevenue,
    "GIFTCARD REVENUE": g.giftCardRevenue,
    "INCLUSIVE TAX": g.inclusiveTax,
    "EXCLUSIVE TAX": g.exclusiveTax,
    "TOTAL TAX": g.totalTax,
    "DISCOUNT": g.discount,
    "ADVANCE ADDED": g.advanceAdded,
    "TOTAL REVENUE": g.totalRevenue,
    "ONLINE": g.online,
    "OFFLINE": g.offline,
    "BALANCE": g.balance
  }));

  res.json(appendTotalRow(result, "DATE", "TOTAL", [
    "SERVICE REVENUE", "PRODUCT REVENUE", "MEMBERSHIP REVENUE", "PACKAGE REVENUE", "GIFTCARD REVENUE",
    "INCLUSIVE TAX", "EXCLUSIVE TAX", "TOTAL TAX", "DISCOUNT", "ADVANCE ADDED", "TOTAL REVENUE",
    "ONLINE", "OFFLINE", "BALANCE"
  ]));
});

// Service Reminder report
reportsRouter.get("/service-reminder", async (req, res) => {
  const salonId = req.salonId;
  const { start, end } = req.query;

  const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { serviceReminderDays: true } });
  const reminderDays = salon?.serviceReminderDays || 30;

  const sinceDate = start ? parseDateSafe(start) : new Date(Date.now() - reminderDays * 24 * 60 * 60 * 1000);
  const untilDate = end ? parseDateSafe(end, true) : new Date();

  const customers = await prisma.customer.findMany({
    where: { salonId, isDeleted: false },
    include: {
      invoices: {
        where: { salonId, createdAt: { gte: sinceDate, lte: untilDate } },
        include: { items: { include: { service: true } } },
        orderBy: { createdAt: "desc" },
        take: 1
      }
    }
  });

  const rows = [];
  for (const customer of customers) {
    const lastInvoice = customer.invoices[0];
    if (!lastInvoice) continue;
    const lastService = lastInvoice.items?.[0]?.service?.name || lastInvoice.items?.[0]?.serviceName || "-";
    const lastDate = lastInvoice.createdAt;
    const dueDate = new Date(lastDate);
    dueDate.setDate(dueDate.getDate() + reminderDays);
    const isDue = dueDate <= new Date();

    rows.push({
      "Customer": customer.name || "-",
      "Phone": customer.phone || "-",
      "Last Service": lastService,
      "Service Date": lastDate ? new Date(lastDate).toLocaleDateString() : "-",
      "Due Date": dueDate.toLocaleDateString(),
      "Status": isDue ? "Due" : "Upcoming"
    });
  }

  res.json(rows);
});

// Feedback report
reportsRouter.get("/feedback", async (req, res) => {
  const salonId = req.salonId;
  const { start, end } = req.query;
  const where = { salonId };
  if (start || end) {
    where.createdAt = {};
    if (start) where.createdAt.gte = parseDateSafe(start);
    if (end) where.createdAt.lte = parseDateSafe(end, true);
  }

  const feedbacks = await prisma.customerFeedback.findMany({
    where,
    include: {
      customer: { select: { name: true } },
      staffUserSalon: { include: { user: { select: { name: true } } } },
      service: { select: { name: true } },
      branch: { select: { name: true } }
    },
    orderBy: { createdAt: "desc" }
  });

  const rows = feedbacks.map((f) => ({
    "Date": f.createdAt ? new Date(f.createdAt).toLocaleDateString() : "-",
    "Customer": f.customer?.name || "-",
    "Staff": f.staffUserSalon?.user?.name || "-",
    "Service": f.service?.name || "-",
    "Rating": f.rating || 0,
    "Comment": f.message || "-"
  }));

  res.json(rows);
});

// Incentive report
reportsRouter.get("/incentive", async (req, res) => {
  const salonId = req.salonId;
  const { start, end, basedOn } = req.query;

  const startDt = start ? parseDateSafe(start) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const endDt = end ? parseDateSafe(end, true) : new Date();

  const rules = await prisma.incentiveRule.findMany({
    where: { salonId, isActive: true },
    orderBy: { createdAt: "desc" }
  });

  const invoices = await prisma.invoice.findMany({
    where: {
      salonId,
      status: { not: "CANCELLED" },
      createdAt: { gte: startDt, lte: endDt }
    },
    include: {
      items: true,
      assignedStaff: { include: { userSalon: { include: { user: { select: { name: true } } } } } }
    }
  });

  const staffRevenue = {};
  invoices.forEach((inv) => {
    const staffEntries = inv.assignedStaff || [];
    const total = toAmount(inv.total);
    const perStaff = staffEntries.length > 0 ? total / staffEntries.length : total;

    staffEntries.forEach((entry) => {
      const name = entry.userSalon?.user?.name || "Unknown";
      if (!staffRevenue[name]) staffRevenue[name] = { revenue: 0, commission: 0, incentive: 0 };
      staffRevenue[name].revenue += perStaff;
    });

    if (staffEntries.length === 0) {
      const name = "Unassigned";
      if (!staffRevenue[name]) staffRevenue[name] = { revenue: 0, commission: 0, incentive: 0 };
      staffRevenue[name].revenue += total;
    }
  });

  const rows = Object.entries(staffRevenue).map(([staffName, data]) => {
    let incentiveAmt = 0;
    let commissionPct = 0;
    for (const rule of rules) {
      if (data.revenue >= toAmount(rule.minTarget || 0)) {
        incentiveAmt += toAmount(rule.incentiveAmount);
      }
    }

    return {
      "Staff": staffName,
      "Revenue Generated": data.revenue,
      "Commission %": commissionPct,
      "Commission Amt": data.commission,
      "Bonus": incentiveAmt,
      "Total": data.commission + incentiveAmt
    };
  });

  res.json(rows);
});

// (extended reports routes were removed — the registration stub has been deleted)
