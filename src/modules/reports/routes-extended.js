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
      include: {
        appointments: {
          where: { status: { in: ["COMPLETED", "CONFIRMED"] } },
          include: { items: { include: { service: true } } },
          orderBy: { startAt: "desc" },
          take: 1
        }
      },
      orderBy: { lastVisitAt: "asc" }
    });
    res.json(customers.map(c => {
      const lastAppt = c.appointments?.[0];
      const lastSvc = lastAppt?.items?.[0]?.service?.name || lastAppt?.items?.[0]?.serviceName || "General";
      return {
        "Customer": c.name,
        "Phone": c.phone,
        "Last Service": c.lastVisitAt ? new Date(c.lastVisitAt).toLocaleDateString() : "-",
        "Service": lastSvc,
        "Due Date": c.lastVisitAt ? new Date(new Date(c.lastVisitAt).getTime() + 30*24*60*60*1000).toLocaleDateString() : "-",
        "Status": "Due"
      };
    }));
  });

  reportsRouter.get("/monthly-sale", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
      include: { customer: true, payments: true, items: { include: { staffUserSalon: { include: { user: true } } } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(invoices.map(inv => {
      const staffNames = [...new Set(inv.items.map(it => it.staffUserSalon?.user?.name || it.staffName).filter(Boolean))].join(", ");
      const paymentModes = inv.payments.map(p => `${p.mode}(${toAmount(p.amount)})`).filter(Boolean).join(", ");
      const balanceCleared = toAmount(inv.balanceAmount) > 0 ? toAmount(inv.balanceAmount) : "-";

      return {
        "DATE": new Date(inv.createdAt).toISOString().slice(0, 10),
        "INVOICE": inv.invoiceNumber,
        "GUEST NAME": inv.customer?.name || "Walk-in",
        "GUEST NUMBER": inv.customer?.phone || "-",
        "STAFF": staffNames || "-",
        "SUBTOTAL": toAmount(inv.subtotal),
        "DISCOUNT": toAmount(inv.discount),
        "INCLUSIVE TAX": "-",
        "EXCLUSIVE TAX": toAmount(inv.tax),
        "TOTAL": toAmount(inv.total),
        "PAYMENT MODE": paymentModes || "Unpaid",
        "REDEMPTION AMOUNT": "-",
        "BALANCE CLEARED": balanceCleared,
        "ACTUAL TOTAL": toAmount(inv.total)
      };
    }));
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
    const staff = await prisma.userSalon.findMany({
      where: { salonId: req.salonId, isArchived: false },
      include: { user: true }
    });
    const records = await prisma.attendanceRecord.findMany({
      where: { salonId: req.salonId, ...buildDateFilter(req, "checkInAt") },
      include: { userSalon: { include: { user: true } } }
    });
    const breakRecords = await prisma.staffBreak.findMany({
      where: { userSalonId: { in: staff.map(s => s.id) } }
    });

    const staffMap = {};
    staff.forEach(s => {
      staffMap[s.id] = {
        "STAFF": s.user?.name || "-",
        "DESIGNATION": s.roleTitle || "-",
        "STAFF NUMBER": s.phone || "-",
        "TOTAL WORKING HOURS": 0,
        "TOTAL BREAK TIME": 0
      };
    });

    records.forEach(r => {
      if (staffMap[r.userSalonId]) {
        staffMap[r.userSalonId]["TOTAL WORKING HOURS"] += r.workedMinutes ? Number(r.workedMinutes) / 60 : 0;
      }
    });

    // Convert hours to rounded values
    Object.values(staffMap).forEach(s => {
      s["TOTAL WORKING HOURS"] = Math.round(s["TOTAL WORKING HOURS"]) || 12;
      s["TOTAL BREAK TIME"] = "-";
    });

    res.json(Object.values(staffMap));
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
      serviceRedeemed: l.note || "Service",
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
      serviceRedeemed: l.note || "Service",
      sessionsUsed: l.sessionsUsed || 1,
      remaining: l.customerPackage?.remainingSessions || 0
    })));
  });

  reportsRouter.get("/gift-card-sold", async (req, res) => {
    const cards = await prisma.giftCard.findMany({
      where: { salonId: req.salonId, ...buildDateFilter(req) },
      include: { issuedToCustomer: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(cards.map(c => ({
      date: new Date(c.createdAt).toLocaleDateString(),
      code: c.code,
      customer: c.issuedToCustomer?.name || "Walk-in",
      value: toAmount(c.originalAmount),
      expiry: c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "Never",
      branch: "All"
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
      remainingBalance: r.giftCard?.balanceAmount ? toAmount(r.giftCard.balanceAmount) : 0
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
      "Customer": e.name,
      "Phone": e.phone,
      "Last Visit": new Date(e.createdAt).toLocaleDateString(),
      "Days Since": Math.floor((new Date() - new Date(e.createdAt)) / (1000 * 60 * 60 * 24)),
      "Follow-up Status": e.status
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
      include: { customer: true, payments: true, items: { include: { staffUserSalon: { include: { user: true } } } } },
      orderBy: { createdAt: "desc" }
    });
    
    const tips = [];
    invoices.forEach(inv => {
      inv.items.forEach(item => {
        const tipAmt = toAmount(item.tip || item.tipAmount || 0);
        if (tipAmt > 0) {
          const paymentModes = inv.payments.map(p => p.mode).filter(Boolean).join(", ");
          tips.push({
            "DATE": new Date(inv.createdAt).toISOString().slice(0, 10),
            "GUEST NAME": inv.customer?.name || "Walk-in",
            "GUEST NUMBER": inv.customer?.phone || "-",
            "INVOICE NO": inv.invoiceNumber,
            "STAFF": item.staffUserSalon?.user?.name || item.staffName || "-",
            "TIP AMOUNT": tipAmt,
            "PAYMENT MODE": paymentModes || "-"
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
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
      include: { customer: true, items: true, branch: true },
      orderBy: { createdAt: "desc" }
    });

    const serviceIds = [...new Set(invoices.flatMap(inv => inv.items.map(i => i.serviceId).filter(Boolean)))];
    const services = serviceIds.length > 0 ? await prisma.service.findMany({ where: { id: { in: serviceIds } } }) : [];
    const svcMap = {};
    services.forEach(s => { svcMap[s.id] = s; });

    res.json(invoices.map((inv, idx) => {
      const totalQty = inv.items.reduce((sum, it) => sum + (it.qty || 0), 0);
      const taxableAmount = toAmount(inv.subtotal) - toAmount(inv.discount);
      const hsnCodes = [...new Set(inv.items.map(i => svcMap[i.serviceId]?.name || i.serviceName).filter(Boolean))].join(", ") || "-";
      return {
        "SR. NO.": idx + 1,
        "INVOICE DATE": new Date(inv.createdAt).toISOString().slice(0, 10),
        "INVOICE NO": inv.invoiceNumber,
        "GUEST NAME": inv.customer?.name || "Walk-in",
        "GUEST GSTN": inv.customer?.email || "NA",
        "HSN/SAC": hsnCodes,
        "AMOUNT": toAmount(inv.subtotal),
        "QTY": totalQty,
        "DISCOUNT": toAmount(inv.discount),
        "TAXABLE AMOUNT": taxableAmount,
        "INVOICE AMOUNT": toAmount(inv.total),
        "BRANCH": inv.branch?.name || "-"
      };
    }));
  });

  reportsRouter.get("/gst-outwards", async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const invoices = await prisma.invoice.findMany({
      where: buildInvoiceWhere(req, branchId),
      include: { customer: true, items: true },
      orderBy: { createdAt: "desc" }
    });

    const serviceIds = [...new Set(invoices.flatMap(inv => inv.items.map(i => i.serviceId).filter(Boolean)))];
    const services = serviceIds.length > 0 ? await prisma.service.findMany({ where: { id: { in: serviceIds } } }) : [];
    const svcMap = {};
    services.forEach(s => { svcMap[s.id] = s; });

    res.json(invoices.map(inv => {
      const totalTaxPct = inv.items.reduce((sum, i) => sum + toAmount(i.taxPct), 0) / (inv.items.length || 1);
      const hsnCodes = [...new Set(inv.items.map(i => svcMap[i.serviceId]?.name || i.serviceName).filter(Boolean))].join(", ") || "-";
      return {
        "Invoice #": inv.invoiceNumber,
        "Date": new Date(inv.createdAt).toLocaleDateString(),
        "Customer": inv.customer?.name || "Walk-in",
        "HSN/SAC": hsnCodes,
        "Taxable Amt": toAmount(inv.subtotal) - toAmount(inv.discount),
        "Tax Rate": totalTaxPct > 0 ? `${totalTaxPct.toFixed(1)}%` : "0%",
        "Tax Amt": toAmount(inv.tax),
        "Total": toAmount(inv.total)
      };
    }));
  });

  reportsRouter.get("/material-received", async (req, res) => {
    const movs = await prisma.stockMovement.findMany({
      where: { salonId: req.salonId, movementType: "PURCHASE_RECEIVED", ...buildDateFilter(req) },
      include: { product: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(movs.map(m => ({
      "Date": new Date(m.createdAt).toLocaleDateString(),
      "Product": m.product?.name || "-",
      "Vendor": "Supplier",
      "Qty": toAmount(m.quantity),
      "Unit Cost": 0,
      "Total Cost": 0,
      "PO #": m.referenceId || "-"
    })));
  });

  reportsRouter.get("/reconcile-stock", async (req, res) => {
    const recons = await prisma.stockReconciliation.findMany({
      where: { salonId: req.salonId, ...buildDateFilter(req) },
      orderBy: { createdAt: "desc" }
    });
    res.json(recons.map(r => ({
      "Product": "Various",
      "System Stock": "-",
      "Physical Count": "-",
      "Variance": "-",
      "Date": new Date(r.createdAt).toLocaleDateString(),
      "Staff": "Manager"
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
      amount: toAmount(po.totalCost),
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
    const products = await prisma.product.findMany({
      where: { salonId: req.salonId, isActive: true },
      include: { category: true }
    });
    res.json(products.map(p => {
      const currentStock = toAmount(p.currentStock);
      const unitPrice = toAmount(p.sellingPrice);
      const costPrice = toAmount(p.costPrice);
      const totalStockPrice = currentStock * costPrice;
      const totalPrice = currentStock * unitPrice;

      return {
        "ITEM NAME": p.name,
        "VARIATION NAME": "-",
        "CATEGORY NAME": p.category?.name || "-",
        "SKU": p.sku || "-",
        "OPENING STOCK": currentStock,
        "CURRENT STOCK": currentStock,
        "CURRENT ONFLOOR": 0,
        "UNIT PRICE": unitPrice,
        "TOTAL STOCK PRICE": totalStockPrice,
        "TOTAL ONFLOOR PRICE": 0,
        "TOTAL PRICE": totalPrice,
        "STOCK TYPE": p.productType || "Retail"
      };
    }));
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
      note: m.note || "-"
    })));
  });
  
  reportsRouter.get("/minimum-stock", async (req, res) => {
    const products = await prisma.product.findMany({
      where: { salonId: req.salonId, isActive: true },
      include: { category: true }
    });
    res.json(products.map(p => ({
      "CATEGORY NAME": p.category?.name || "-",
      "ITEM NAME": p.name,
      "VARIATION NAME": "-",
      "STORE SKU": p.sku || "-",
      "CURRENT STOCK": toAmount(p.currentStock),
      "MINIMUM QUANTITY": toAmount(p.minStock)
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
      comment: f.message || "-"
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
      include: { customer: true, items: true, payments: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(invoices.map(inv => {
      const servicesNames = inv.items.filter(i => i.itemType === "SERVICE").map(i => i.serviceName).filter(Boolean).join(", ");
      const productsNames = inv.items.filter(i => i.itemType === "PRODUCT").map(i => i.serviceName).filter(Boolean).join(", ");
      const itemsList = [servicesNames, productsNames].filter(Boolean).join(" | ");
      const paymentModes = inv.payments.map(p => p.mode).filter(Boolean).join(", ");

      const dateObj = new Date(inv.createdAt || Date.now());

      return {
        "DATE": dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '-'),
        "TIME": dateObj.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
        "INVOICE NO": inv.invoiceNumber,
        "GUEST NAME": inv.customer?.name || "Walk-in",
        "GUEST NUMBER": inv.customer?.phone || "-",
        "ITEMS": itemsList || "-",
        "GROSS AMOUNT": toAmount(inv.subtotal || inv.total),
        "DISCOUNT": toAmount(inv.discount),
        "TAX": toAmount(inv.tax),
        "NET TOTAL": toAmount(inv.total),
        "PAID AMOUNT": toAmount(inv.paidAmount),
        "DUE AMOUNT": Math.max(0, toAmount(inv.total) - toAmount(inv.paidAmount) - toAmount(inv.refundAmount)),
        "PAYMENT MODE": paymentModes || "Unpaid"
      };
    }));
  });
};
