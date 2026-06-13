import { toAmount, normalizeBranchId, isOwnScopedStaff } from "../../lib/phase2.js";

export const registerExtendedReports = (reportsRouter, prisma, buildInvoiceWhere) => {
const buildDateFilter = (req, field = "createdAt") => {
  const filter = {};
  if (req.query.start) filter.gte = new Date(req.query.start);
  if (req.query.end) {
    const end = new Date(req.query.end);
    end.setUTCHours(23, 59, 59, 999);
    filter.lte = end;
  }
  return Object.keys(filter).length > 0 ? { [field]: filter } : {};
};


  reportsRouter.get("/service-reminder", async (req, res) => {
    const customers = await prisma.customer.findMany({
      where: { salonId: req.salonId, lastVisitAt: { not: null } },
      orderBy: { lastVisitAt: "asc" }
    });
    res.json(customers.map(c => ({
      customer: c.name,
      phone: c.phone,
      lastService: c.lastVisitAt,
      service: "General Reminder",
      dueDate: new Date(new Date(c.lastVisitAt).getTime() + 30*24*60*60*1000),
      status: "Due"
    })));
  });

  reportsRouter.get("/monthly-sale", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
    });
    const grouped = {};
    invoices.forEach(inv => {
      const month = new Date(inv.createdAt).toISOString().slice(0, 7);
      if (!grouped[month]) grouped[month] = { month, invoices: 0, grossSales: 0, discounts: 0, netSales: 0, paid: 0, due: 0 };
      grouped[month].invoices++;
      grouped[month].grossSales += toAmount(inv.subtotal);
      grouped[month].discounts += toAmount(inv.discount);
      grouped[month].netSales += toAmount(inv.total);
      grouped[month].paid += toAmount(inv.paidAmount);
      grouped[month].due += Math.max(0, toAmount(inv.total) - toAmount(inv.paidAmount) - toAmount(inv.refundAmount));
    });
    res.json(Object.values(grouped).sort((a,b) => b.month.localeCompare(a.month)));
  });

  reportsRouter.get("/day-wise", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
      include: { payments: true }
    });
    const grouped = {};
    invoices.forEach(inv => {
      const date = new Date(inv.createdAt).toISOString().slice(0, 10);
      if (!grouped[date]) grouped[date] = { date, invoices: 0, cash: 0, card: 0, upi: 0, online: 0, total: 0 };
      grouped[date].invoices++;
      grouped[date].total += toAmount(inv.total);
      inv.payments.forEach(p => {
        const amt = toAmount(p.amount);
        if (p.mode === "CASH") grouped[date].cash += amt;
        else if (p.mode === "CARD") grouped[date].card += amt;
        else if (p.mode === "UPI") grouped[date].upi += amt;
        else grouped[date].online += amt;
      });
    });
    res.json(Object.values(grouped).sort((a,b) => b.date.localeCompare(a.date)));
  });

  reportsRouter.get("/staff-attendance", async (req, res) => {
    const records = await prisma.attendanceRecord.findMany({
      where: { salonId: req.salonId, ...buildDateFilter(req, "date") },
      include: { staff: { include: { user: true } } },
      orderBy: { date: "desc" }
    });
    res.json(records.map(r => ({
      staff: r.staff?.user?.name || "Unknown",
      date: new Date(r.date).toISOString().slice(0, 10),
      checkIn: r.checkInAt ? new Date(r.checkInAt).toLocaleTimeString() : "-",
      checkOut: r.checkOutAt ? new Date(r.checkOutAt).toLocaleTimeString() : "-",
      hours: r.totalMinutes ? (r.totalMinutes / 60).toFixed(1) : "0",
      status: r.status
    })));
  });

  reportsRouter.get("/membership-redemption", async (req, res) => {
    const logs = await prisma.membershipUsage.findMany({
      where: { customerMembership: { salonId: req.salonId }, ...buildDateFilter(req) },
      include: { customerMembership: { include: { customer: true, membershipPlan: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(logs.map(l => ({
      date: new Date(l.createdAt).toLocaleDateString(),
      customer: l.customerMembership?.customer?.name,
      membership: l.customerMembership?.membershipPlan?.name,
      serviceRedeemed: l.notes || "Service",
      sessionsUsed: l.amountUsed ? toAmount(l.amountUsed) : 1,
      remaining: l.customerMembership?.remainingWalletValue ? toAmount(l.customerMembership.remainingWalletValue) : "-"
    })));
  });

  reportsRouter.get("/package-redemption", async (req, res) => {
    const logs = await prisma.packageUsage.findMany({
      where: { customerPackage: { salonId: req.salonId }, ...buildDateFilter(req) },
      include: { customerPackage: { include: { customer: true, package: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(logs.map(l => ({
      date: new Date(l.createdAt).toLocaleDateString(),
      customer: l.customerPackage?.customer?.name,
      package: l.customerPackage?.package?.name,
      serviceRedeemed: l.notes || "Service",
      sessionsUsed: l.sessionsUsed || 1,
      remaining: l.customerPackage?.remainingSessions || 0
    })));
  });

  reportsRouter.get("/gift-card-sold", async (req, res) => {
    const cards = await prisma.giftCard.findMany({
      where: { salonId: req.salonId, ...buildDateFilter(req) },
      include: { issuedTo: true, branch: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(cards.map(c => ({
      date: new Date(c.createdAt).toLocaleDateString(),
      code: c.code,
      customer: c.issuedTo?.name || "Walk-in",
      value: toAmount(c.initialValue),
      expiry: c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "Never",
      branch: c.branch?.name || "All"
    })));
  });

  reportsRouter.get("/gift-card-redemption", async (req, res) => {
    const redemptions = await prisma.giftCardRedemption.findMany({
      where: { giftCard: { salonId: req.salonId }, ...buildDateFilter(req) },
      include: { giftCard: true, invoice: true, customer: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(redemptions.map(r => ({
      date: new Date(r.createdAt).toLocaleDateString(),
      code: r.giftCard?.code,
      customer: r.customer?.name || "Walk-in",
      amountUsed: toAmount(r.amountUsed),
      invoiceNumber: r.invoice?.invoiceNumber,
      remainingBalance: r.giftCard?.currentValue ? toAmount(r.giftCard.currentValue) : 0
    })));
  });

  reportsRouter.get("/advance-received", async (req, res) => {
    const payments = await prisma.payment.findMany({
      where: { salonId: req.salonId, type: "ADVANCE", ...buildDateFilter(req) },
      include: { invoice: { include: { customer: true, items: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(payments.map(p => ({
      date: new Date(p.createdAt).toLocaleDateString(),
      customer: p.invoice?.customer?.name || "Walk-in",
      invoiceNumber: p.invoice?.invoiceNumber,
      advanceAmount: toAmount(p.amount),
      mode: p.mode,
      staff: p.invoice?.items?.[0]?.staffName || "System"
    })));
  });

  reportsRouter.get("/balance-received", async (req, res) => {
    const payments = await prisma.payment.findMany({
      where: { salonId: req.salonId, type: "BALANCE", ...buildDateFilter(req) },
      include: { invoice: { include: { customer: true, items: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(payments.map(p => ({
      date: new Date(p.createdAt).toLocaleDateString(),
      customer: p.invoice?.customer?.name || "Walk-in",
      invoiceNumber: p.invoice?.invoiceNumber,
      balanceAmt: toAmount(p.amount),
      mode: p.mode,
      collectedBy: p.invoice?.items?.[0]?.staffName || "System"
    })));
  });

  reportsRouter.get("/guest-collection", async (req, res) => {
    const customers = await prisma.customer.findMany({
      where: { salonId: req.salonId },
      orderBy: { totalSpend: "desc" },
      include: { appointments: true }
    });
    res.json(customers.map(c => ({
      customer: c.name,
      phone: c.phone,
      email: c.email || "-",
      totalVisits: c.appointments?.length || 0,
      lastVisit: c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString() : "-",
      totalSpend: toAmount(c.totalSpend),
      loyaltyPts: c.loyaltyPoints || 0
    })));
  });

  reportsRouter.get("/guest-followups", async (req, res) => {
    const enquiries = await prisma.enquiry.findMany({
      where: { salonId: req.salonId, ...buildDateFilter(req) },
      orderBy: { createdAt: "desc" }
    });
    res.json(enquiries.map(e => ({
      customer: e.name,
      phone: e.phone,
      lastVisit: new Date(e.createdAt).toLocaleDateString(),
      daysSince: Math.floor((new Date() - new Date(e.createdAt)) / (1000 * 60 * 60 * 24)),
      followUpStatus: e.status
    })));
  });

  reportsRouter.get("/inventory-transaction", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const movs = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, ...(branchId ? { branchId } : {}), ...buildDateFilter(req) },
      include: { product: true, branch: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(movs.map(m => ({
      date: new Date(m.createdAt).toLocaleDateString(),
      product: m.product?.name,
      type: m.movementType,
      qty: toAmount(m.quantity),
      reference: m.referenceType || m.referenceId || "-",
      branch: m.branch?.name || "Main",
      staff: "System"
    })));
  });

  reportsRouter.get("/tip-report", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
      include: { customer: true, items: { include: { staffUserSalon: { include: { user: true } } } } },
      orderBy: { createdAt: "desc" }
    });
    
    const tips = [];
    invoices.forEach(inv => {
      inv.items.forEach(item => {
        if (toAmount(item.tipAmount) > 0) {
          tips.push({
            date: new Date(inv.createdAt).toLocaleDateString(),
            staff: item.staffUserSalon?.user?.name || item.staffName || "-",
            customer: inv.customer?.name || "Walk-in",
            invoiceNumber: inv.invoiceNumber,
            tipAmount: toAmount(item.tipAmount)
          });
        }
      });
    });
    res.json(tips);
  });

  reportsRouter.get("/complimentary", async (req, res) => {
    const invoices = await prisma.invoice.findMany({
      where: { salonId: req.salonId, total: 0, status: "PAID", ...buildDateFilter(req) },
      include: { customer: true, items: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(invoices.map(inv => ({
      date: new Date(inv.createdAt).toLocaleDateString(),
      service: inv.items.map(i => i.serviceName).join(", ") || "-",
      staff: inv.items[0]?.staffName || "-",
      customer: inv.customer?.name || "Walk-in",
      reason: inv.notes || "Complimentary",
      value: toAmount(inv.subtotal)
    })));
  });

  reportsRouter.get("/gst-returns", async (req, res) => {
    res.json([]);
  });

  reportsRouter.get("/gst-outwards", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
      include: { customer: true, items: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(invoices.map(inv => ({
      invoiceNumber: inv.invoiceNumber,
      date: new Date(inv.createdAt).toLocaleDateString(),
      customer: inv.customer?.name || "Walk-in",
      taxableAmt: toAmount(inv.subtotal),
      taxRate: inv.items[0]?.taxPct ? `${toAmount(inv.items[0].taxPct)}%` : "0%",
      taxAmt: toAmount(inv.tax),
      total: toAmount(inv.total)
    })));
  });

  reportsRouter.get("/material-received", async (req, res) => {
    const movs = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, movementType: "PURCHASE_RECEIVED", ...buildDateFilter(req) },
      include: { product: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(movs.map(m => ({
      date: new Date(m.createdAt).toLocaleDateString(),
      product: m.product?.name,
      vendor: "Supplier",
      qty: toAmount(m.quantity),
      unitCost: 0,
      totalCost: 0,
      poNumber: m.referenceId || "-"
    })));
  });

  reportsRouter.get("/reconcile-stock", async (req, res) => {
    const recons = await prisma.stockReconciliation.findMany({
      where: { salonId: req.salonId, ...buildDateFilter(req) },
      orderBy: { createdAt: "desc" }
    });
    res.json(recons.map(r => ({
      product: "Various",
      systemStock: "-",
      physicalCount: "-",
      variance: "-",
      date: new Date(r.createdAt).toLocaleDateString(),
      staff: "Manager"
    })));
  });

  reportsRouter.get("/consumable-tracking", async (req, res) => {
    const movs = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, movementType: "CONSUMABLE_USAGE", ...buildDateFilter(req) },
      include: { product: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(movs.map(m => ({
      product: m.product?.name,
      service: m.referenceType || "General",
      qtyUsedPerService: toAmount(m.quantity),
      totalUsed: toAmount(m.quantity),
      cost: 0
    })));
  });

  reportsRouter.get("/total-consumed", async (req, res) => {
    res.json([]);
  });

  reportsRouter.get("/purchase-order", async (req, res) => {
    const pos = await prisma.purchaseOrder.findMany({
      where: { salonId: req.salonId, ...buildDateFilter(req) },
      include: { vendor: true, items: { include: { product: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(pos.map(po => ({
      poNumber: po.orderNumber,
      date: new Date(po.createdAt).toLocaleDateString(),
      vendor: po.vendor?.name || "-",
      products: po.items.map(i => i.product?.name).join(", "),
      amount: toAmount(po.totalAmount),
      status: po.status,
      receivedOn: po.receivedAt ? new Date(po.receivedAt).toLocaleDateString() : "-"
    })));
  });

  reportsRouter.get("/incentive-report", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
      include: { items: { include: { staffUserSalon: { include: { user: true } } } } }
    });
    
    const summary = {};
    invoices.forEach(inv => {
      const month = new Date(inv.createdAt).toISOString().slice(0, 7);
      inv.items.forEach(item => {
        const staffName = item.staffUserSalon?.user?.name || item.staffName;
        if (!staffName) return;
        
        const key = `${staffName}_${month}`;
        if (!summary[key]) {
          summary[key] = { staff: staffName, month, revenue: 0, commission: 0 };
        }
        summary[key].revenue += toAmount(item.lineTotal);
        summary[key].commission += toAmount(item.commissionAmount);
      });
    });

    res.json(Object.values(summary).map(s => ({
      staff: s.staff,
      month: s.month,
      revenueGenerated: s.revenue,
      commissionPct: s.revenue > 0 ? ((s.commission / s.revenue) * 100).toFixed(1) + "%" : "0%",
      commissionAmt: s.commission,
      bonus: 0,
      total: s.commission
    })).sort((a,b) => b.month.localeCompare(a.month)));
  });

  reportsRouter.get("/inter-store-membership", async (req, res) => {
    res.json([]);
  });
  
  reportsRouter.get("/daily-stock", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const movs = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, ...(branchId ? { branchId } : {}), ...buildDateFilter(req) },
      include: { product: { include: { category: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(movs.map(m => ({
      product: m.product?.name,
      category: m.product?.category?.name || "-",
      openingStock: toAmount(m.stockBefore),
      received: m.movementType === "STOCK_IN" ? toAmount(m.quantity) : 0,
      consumed: m.movementType === "STOCK_OUT" ? Math.abs(toAmount(m.quantity)) : 0,
      sold: m.movementType === "POS_SALE" ? Math.abs(toAmount(m.quantity)) : 0,
      closing: toAmount(m.stockAfter)
    })));
  });
  
  reportsRouter.get("/stock-transaction", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const movs = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, ...(branchId ? { branchId } : {}), ...buildDateFilter(req) },
      include: { product: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(movs.map(m => ({
      date: new Date(m.createdAt).toLocaleDateString(),
      product: m.product?.name,
      type: m.movementType,
      qty: toAmount(m.quantity),
      staff: "System",
      note: m.notes || "-"
    })));
  });
  
  reportsRouter.get("/minimum-stock", async (req, res) => {
    const products = await prisma.product.findMany({
      where: { salonId: req.salonId, isActive: true },
      include: { category: true }
    });
    res.json(products.filter(p => toAmount(p.currentStock) <= toAmount(p.minStock)).map(p => ({
      product: p.name,
      category: p.category?.name || "-",
      currentStock: toAmount(p.currentStock),
      minStock: toAmount(p.minStock),
      deficit: toAmount(p.minStock) - toAmount(p.currentStock),
      status: "Low Stock"
    })));
  });

  reportsRouter.get("/feedback", async (req, res) => {
    const fb = await prisma.customerFeedback.findMany({
      where: { salonId: req.salonId },
      include: { customer: true, staffUserSalon: { include: { user: true } }, service: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(fb.map(f => ({
      date: new Date(f.createdAt).toLocaleDateString(),
      customer: f.customer?.name || "Guest",
      staff: f.staffUserSalon?.user?.name || "-",
      service: f.service?.name || "-",
      rating: f.rating,
      comment: f.comments || "-"
    })));
  });

  reportsRouter.get("/pnl-report", async (req, res) => {
    const invoices = await prisma.invoice.findMany({ where: { salonId: req.salonId, status: { not: "CANCELLED" }, ...buildDateFilter(req) } });
    const expenses = await prisma.expense.findMany({ where: { salonId: req.salonId, status: { in: ["APPROVED", "PAID"] }, ...buildDateFilter(req) } });
    
    const grouped = {};
    invoices.forEach(inv => {
      const m = new Date(inv.createdAt).toISOString().slice(0, 7);
      if (!grouped[m]) grouped[m] = { month: m, revenue: 0, cogs: 0, gp: 0, exp: 0, np: 0, margin: 0 };
      grouped[m].revenue += toAmount(inv.total);
    });
    expenses.forEach(e => {
      const m = new Date(e.expenseDate || e.createdAt).toISOString().slice(0, 7);
      if (!grouped[m]) grouped[m] = { month: m, revenue: 0, cogs: 0, gp: 0, exp: 0, np: 0, margin: 0 };
      grouped[m].exp += toAmount(e.amount);
    });

    res.json(Object.values(grouped).map(g => {
      g.gp = g.revenue - g.cogs;
      g.np = g.gp - g.exp;
      g.margin = g.revenue > 0 ? ((g.np / g.revenue) * 100).toFixed(1) + "%" : "0%";
      return {
        month: g.month,
        revenue: g.revenue,
        cogs: g.cogs,
        grossProfit: g.gp,
        expenses: g.exp,
        netProfit: g.np,
        marginPercentage: g.margin
      };
    }).sort((a,b) => b.month.localeCompare(a.month)));
  });

  reportsRouter.get("/coupon-redemption", async (req, res) => {
    const redemptions = await prisma.couponRedemption.findMany({
      where: { coupon: { salonId: req.salonId }, ...buildDateFilter(req) },
      include: { coupon: true, invoice: true, customer: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(redemptions.map(r => ({
      date: new Date(r.createdAt).toLocaleDateString(),
      code: r.coupon?.code || "-",
      customer: r.customer?.name || "Walk-in",
      invoiceNumber: r.invoice?.invoiceNumber || "-",
      discountApplied: toAmount(r.amountSaved)
    })));
  });
  reportsRouter.get("/sales-summary-list", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
      include: { customer: true, items: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(invoices.map(inv => ({
      date: new Date(inv.createdAt).toLocaleDateString(),
      invoiceNumber: inv.invoiceNumber,
      customer: inv.customer?.name || "Walk-in",
      services: inv.items.filter(i => i.itemType === "SERVICE").length,
      products: inv.items.filter(i => i.itemType === "PRODUCT").length,
      discount: toAmount(inv.discount),
      tax: toAmount(inv.tax),
      total: toAmount(inv.total),
      paid: toAmount(inv.paidAmount),
      due: Math.max(0, toAmount(inv.total) - toAmount(inv.paidAmount) - toAmount(inv.refundAmount))
    })));
  });
};
