import PDFDocument from "pdfkit";
import { attemptCustomerTemplateEmail } from "../../../lib/emailNotifications.js";
import { prisma } from "../../../lib/prisma.js";
import { addInvoicePayment, createPosInvoice, generatePaymentLink, getDayClosingSummary, logPaymentLinkPlaceholder, refundInvoice } from "../../../lib/pos.js";
import { attachBranchStock, normalizeBranchId } from "../../../lib/phase2.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const withBranchFilter = (salonId, branchId) => ({ salonId, ...(branchId ? { branchId } : {}) });
const paymentWhere = (salonId, branchId) => ({ salonId, ...(branchId ? { invoice: { is: { branchId } } } : {}) });
const sendRouteError = (res, error, fallbackMessage) => {
  const status = Number(error?.status || error?.response?.status || 500);
  return res.status(status).json({ message: error?.message || fallbackMessage });
};

const sendInvoiceAutomationEmails = async (salonId, invoice) => {
  const customerId = invoice?.customerId || null;
  const toEmail = invoice?.customer?.email || "";
  await attemptCustomerTemplateEmail({
    salonId,
    toEmail,
    templateType: "invoice_template",
    context: { invoiceId: invoice?.id, customerId }
  });

  const [soldMemberships, soldPackages] = await Promise.all([
    prisma.customerMembership.findMany({
      where: { soldInvoiceId: invoice?.id },
      include: { membershipPlan: true, customer: true }
    }),
    prisma.customerPackage.findMany({
      where: { soldInvoiceId: invoice?.id },
      include: { package: true, customer: true }
    })
  ]);

  for (const membership of soldMemberships) {
    await attemptCustomerTemplateEmail({
      salonId,
      toEmail: membership.customer?.email || toEmail,
      templateType: "membership_purchase_template",
      context: {
        customerId: membership.customerId,
        customerMembershipId: membership.id,
        invoiceId: invoice?.id
      }
    });
  }

  for (const customerPackage of soldPackages) {
    await attemptCustomerTemplateEmail({
      salonId,
      toEmail: customerPackage.customer?.email || toEmail,
      templateType: "package_purchase_template",
      context: {
        customerId: customerPackage.customerId,
        customerPackageId: customerPackage.id,
        invoiceId: invoice?.id
      }
    });
  }
};

export const registerBillingRoutes = (ownerRouter) => {
  ownerRouter.get("/pos/context", requireFeatureEnabled("pos"), requireSalonPermission("pos", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const params = branchId ? { OR: [{ branchId }, { branchId: null }, { branchId: "" }] } : {};
    const [customers, branches, services, staffUsers, products, memberships, packages, coupons, giftCards, settings] = await Promise.all([
      prisma.customer.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } }),
      prisma.branch.findMany({ where: { salonId: req.salonId, isActive: true }, orderBy: { createdAt: "desc" } }),
      prisma.service.findMany({ where: { salonId: req.salonId, isActive: true, ...params }, include: { category: true, branch: true }, orderBy: { createdAt: "desc" } }),
      prisma.userSalon.findMany({
        where: { salonId: req.salonId, isArchived: false, ...params },
        include: { user: true, branch: true, serviceAssignments: { include: { service: { include: { category: true, branch: true } } } } }
      }),
      prisma.product.findMany({
        where: {
          salonId: req.salonId,
          isActive: true,
          ...(branchId ? { OR: [{ branchId }, { branchId: null }, { branchId: "" }, { stockMovements: { some: { branchId } } }] } : {})
        },
        include: { category: true, branch: true },
        orderBy: { createdAt: "desc" }
      }),
      prisma.membershipPlan.findMany({ where: { salonId: req.salonId, isActive: true }, orderBy: { createdAt: "desc" } }),
      prisma.package.findMany({ where: { salonId: req.salonId, isActive: true }, orderBy: { createdAt: "desc" } }),
      prisma.coupon.findMany({
        where: {
          salonId: req.salonId,
          isArchived: false,
          ...(branchId ? { OR: [{ branchId }, { branchId: null }, { branchId: "" }] } : {})
        },
        orderBy: { createdAt: "desc" }
      }),
      prisma.giftCard.findMany({
        where: {
          salonId: req.salonId,
          isActive: true,
          ...(req.query.customerId ? { OR: [{ issuedToCustomerId: String(req.query.customerId) }, { issuedToCustomerId: null }] } : {})
        },
        orderBy: { createdAt: "desc" }
      }),
      prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: branchId || null } })
    ]);
    const customerProfile = req.query.customerId
      ? customers.find((row) => row.id === String(req.query.customerId)) || null
      : null;
    res.json({
      customers,
      branches,
      services,
      staffUsers,
      products: await attachBranchStock(prisma, products, branchId),
      memberships,
      packages,
      coupons,
      giftCards,
      customerProfile,
      settings
    });
  });

  ownerRouter.post("/pos/invoices", requireFeatureEnabled("pos"), requireSalonPermission("pos", "create"), validate(schemas.invoice), async (req, res) => {
    try {
      const invoice = await createPosInvoice({ salonId: req.salonId, actorUser: req.user, body: req.body });
      await sendInvoiceAutomationEmails(req.salonId, invoice);
      res.status(201).json(invoice);
    } catch (error) {
      return sendRouteError(res, error, "Could not create POS invoice");
    }
  });

  ownerRouter.post("/invoices", requireFeatureEnabled("pos"), requireSalonPermission("pos", "create"), validate(schemas.invoice), async (req, res) => {
    try {
      const invoice = await createPosInvoice({ salonId: req.salonId, actorUser: req.user, body: req.body });
      await sendInvoiceAutomationEmails(req.salonId, invoice);
      res.status(201).json(invoice);
    } catch (error) {
      return sendRouteError(res, error, "Could not create invoice");
    }
  });

  ownerRouter.get("/invoices", requireSalonPermission("invoices", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    res.json(await prisma.invoice.findMany({
      where: {
        ...withBranchFilter(req.salonId, branchId),
        ...(status ? { status } : {}),
        ...(q ? {
          OR: [
            { invoiceNumber: { contains: q } },
            { customer: { is: { name: { contains: q } } } }
          ]
        } : {})
      },
      include: { customer: true, items: true, payments: true, branch: true, appointment: true },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.get("/invoices/:id", requireSalonPermission("invoices", "view"), async (req, res) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { customer: true, items: true, payments: true, branch: true, appointment: true }
    });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    res.json(invoice);
  });

  ownerRouter.patch("/invoices/:id/cancel", requireSalonPermission("invoices", "edit"), async (req, res) => {
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { payments: true, customer: true, branch: true } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.status === "CANCELLED") return res.status(400).json({ message: "Invoice already cancelled" });
    if (invoice.payments.some((payment) => payment.amount > 0)) return res.status(400).json({ message: "Paid invoice requires refund flow instead of cancel" });
    const cancelledInvoice = await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED", balanceAmount: 0 } });
    await attemptCustomerTemplateEmail({
      salonId: req.salonId,
      toEmail: invoice.customer?.email || "",
      templateType: "invoice_cancel_template",
      context: { invoiceId: invoice.id, customerId: invoice.customerId }
    });
    res.json(cancelledInvoice);
  });

  ownerRouter.post("/payments", requireSalonPermission("payments", "create"), validate(schemas.payment), async (req, res) => {
    const payment = await addInvoicePayment({
      salonId: req.salonId,
      invoiceId: req.body.invoiceId,
      amount: req.body.amount,
      mode: req.body.mode,
      note: req.body.note,
      actorUser: req.user
    });
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.body.invoiceId, salonId: req.salonId },
      include: { customer: true, branch: true }
    });
    await attemptCustomerTemplateEmail({
      salonId: req.salonId,
      toEmail: invoice?.customer?.email || "",
      templateType: "payment_receipt_template",
      context: { invoiceId: invoice?.id, customerId: invoice?.customerId }
    });
    res.status(201).json(payment);
  });

  ownerRouter.post("/payments/refund", requireSalonPermission("payments", "edit"), validate(schemas.refundPayment), async (req, res) => {
    const invoice = await refundInvoice({
      salonId: req.salonId,
      invoiceId: req.body.invoiceId,
      amount: req.body.amount,
      note: req.body.note,
      actorUser: req.user
    });
    await attemptCustomerTemplateEmail({
      salonId: req.salonId,
      toEmail: invoice?.customer?.email || "",
      templateType: "invoice_refund_template",
      context: { invoiceId: invoice?.id, customerId: invoice?.customerId }
    });
    res.json(invoice);
  });

  ownerRouter.get("/payments", requireSalonPermission("payments", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const q = String(req.query.q || "").trim();
    const mode = String(req.query.mode || "").trim();
    const type = String(req.query.type || "").trim();
    res.json(await prisma.payment.findMany({
      where: {
        ...paymentWhere(req.salonId, branchId),
        ...(mode ? { mode } : {}),
        ...(type ? { type } : {}),
        ...(q ? {
          OR: [
            { note: { contains: q } },
            { invoice: { is: { invoiceNumber: { contains: q } } } },
            { invoice: { is: { customer: { is: { name: { contains: q } } } } } }
          ]
        } : {})
      },
      include: { invoice: { include: { customer: true, branch: true } } },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.post("/invoices/:id/payment-link", requireSalonPermission("payments", "edit"), validate(schemas.paymentLink), async (req, res) => {
    const invoice = await generatePaymentLink({
      salonId: req.salonId,
      invoiceId: req.params.id,
      expiresAt: req.body.expiresAt,
      gatewayName: req.body.gatewayName,
      note: req.body.note
    });
    const frontendBase = process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173";
    res.status(201).json({
      invoiceId: invoice.id,
      paymentLinkToken: invoice.paymentLinkToken,
      paymentLinkStatus: invoice.paymentLinkStatus,
      paymentLinkUrl: `${frontendBase}/pay/${invoice.paymentLinkToken}`
    });
  });

  ownerRouter.post("/invoices/:id/payment-link/log", requireSalonPermission("payments", "edit"), validate(schemas.paymentLinkLog), async (req, res) => {
    try {
      const paymentLog = await logPaymentLinkPlaceholder({
        salonId: req.salonId,
        invoiceId: req.params.id,
        status: req.body.status,
        note: req.body.note,
        gatewayRef: req.body.gatewayRef
      });
      res.status(201).json(paymentLog);
    } catch (error) {
      return sendRouteError(res, error, "Could not update payment link placeholder");
    }
  });

  ownerRouter.post("/invoices/:id/payment-reminder", requireSalonPermission("payments", "edit"), async (req, res) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { customer: true, branch: true }
    });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    const note = `Payment reminder placeholder sent on ${new Date().toLocaleString()} for ${invoice.invoiceNumber}`;
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        notes: [invoice.notes, note].filter(Boolean).join("\n")
      }
    });
    await attemptCustomerTemplateEmail({
      salonId: req.salonId,
      toEmail: invoice.customer?.email || "",
      templateType: "invoice_template",
      context: { invoiceId: invoice.id, customerId: invoice.customerId }
    });
    res.status(201).json({
      invoiceId: updated.id,
      invoiceNumber: updated.invoiceNumber,
      channelHints: ["WHATSAPP_PLACEHOLDER", "SMS_PLACEHOLDER", "EMAIL_PLACEHOLDER"],
      reminderPreview: `Reminder: pending balance ${updated.balanceAmount} on invoice ${updated.invoiceNumber}`
    });
  });

  ownerRouter.get("/pos/day-closing", requireFeatureEnabled("pos"), requireSalonPermission("payments", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    res.json(await getDayClosingSummary({ salonId: req.salonId, branchId, date: req.query.date ? String(req.query.date) : undefined }));
  });

  ownerRouter.get("/invoices/:id/receipt", requireSalonPermission("invoices", "view"), async (req, res) => {
    const inv = await prisma.invoice.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { customer: true, items: true, payments: true, branch: true }
    });
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const settings = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: inv.branchId || null } });
    const footer = settings?.invoiceFooter || "Thank you for visiting.";
    const items = inv.items.map((item) => `<tr><td>${item.serviceName}</td><td>${item.itemType}</td><td>${item.staffName || "-"}</td><td>${item.qty}</td><td>${item.unitPrice}</td><td>${item.lineTotal}</td></tr>`).join("");
    const appliedBenefits = [inv.couponCode ? `<p><strong>Coupon:</strong> ${inv.couponCode}</p>` : "", inv.giftVoucherCode ? `<p><strong>Gift Card:</strong> ${inv.giftVoucherCode}</p>` : "", inv.loyaltyPointsUsed ? `<p><strong>Loyalty Points Redeemed:</strong> ${inv.loyaltyPointsUsed}</p>` : ""].join("");
    const html = `<!doctype html><html><body style="font-family:Segoe UI, sans-serif;padding:24px;"><h2>Invoice ${inv.invoiceNumber}</h2><p><strong>Customer:</strong> ${inv.customer.name}</p><p><strong>Branch:</strong> ${inv.branch?.name || "Main salon"}</p>${appliedBenefits}<table border="1" cellspacing="0" cellpadding="8" style="border-collapse:collapse;width:100%;max-width:760px;"><tr><th>Item</th><th>Type</th><th>Staff</th><th>Qty</th><th>Unit</th><th>Total</th></tr>${items}</table><p><strong>Subtotal:</strong> ${inv.subtotal}</p><p><strong>Tax:</strong> ${inv.tax}</p><p><strong>Discount:</strong> ${inv.discount}</p><p><strong>Grand Total:</strong> ${inv.total}</p><p><strong>Paid:</strong> ${inv.paidAmount}</p><p><strong>Refunded:</strong> ${inv.refundAmount}</p><p><strong>Status:</strong> ${inv.status}</p><p>${footer}</p></body></html>`;
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  ownerRouter.get("/invoices/:id/pdf", requireSalonPermission("invoices", "view"), async (req, res) => {
    const inv = await prisma.invoice.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { items: true, payments: true, customer: true, branch: true }
    });
    if (!inv) return res.status(404).json({ error: "Invoice not found" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="invoice-${inv.invoiceNumber}.pdf"`);

    // Create a modern Thermal POS Receipt PDF
    const width = 300;
    const margin = 20;
    const docHeight = 500 + (inv.items.length * 30);
    const pdf = new PDFDocument({ margin: margin, size: [width, docHeight] });
    pdf.pipe(res);

    const salonName = inv.branch?.name || "Styluxe Unisex Salon";
    const brandName = "STYLUXE";
    const phone = inv.branch?.phone || "9044700447";

    // Header
    pdf.font('Helvetica-Bold').fontSize(24).fillColor('#0f172a').text(brandName, margin, margin, { align: 'center' });
    pdf.font('Helvetica').fontSize(8).fillColor('#94a3b8').text('HAIR . LIFESTYLE . CARE', { align: 'center', characterSpacing: 2 });
    pdf.moveDown(0.5);

    pdf.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(salonName, { align: 'center' });
    pdf.font('Helvetica').fontSize(8).fillColor('#64748b').text("Panchsheel Enclave, Hyderabad", { align: 'center' });
    if (phone) pdf.text(`Phone: +91 ${phone}`, { align: 'center' });
    
    // Dashed line helper
    const drawDashedLine = (yPos) => {
      pdf.moveTo(margin, yPos).lineTo(width - margin, yPos).dash(3, { space: 3 }).strokeColor('#cbd5e1').stroke();
      pdf.undash();
    }

    let y = pdf.y + 10;
    drawDashedLine(y);
    y += 10;

    // Meta
    pdf.fillColor('#94a3b8').fontSize(9).font('Helvetica');
    pdf.text('Invoice No', margin, y, { continued: true });
    pdf.fillColor('#0f172a').font('Helvetica-Bold').text(inv.invoiceNumber, { align: 'right' });
    y += 15;
    
    pdf.fillColor('#94a3b8').font('Helvetica').text('Date', margin, y, { continued: true });
    pdf.fillColor('#0f172a').font('Helvetica-Bold').text(new Date(inv.createdAt).toLocaleDateString('en-GB').replace(/\//g, '-'), { align: 'right' });
    y += 15;

    pdf.fillColor('#94a3b8').font('Helvetica').text('Time', margin, y, { continued: true });
    pdf.fillColor('#0f172a').font('Helvetica-Bold').text(new Date(inv.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }), { align: 'right' });
    y += 15;

    pdf.fillColor('#94a3b8').font('Helvetica').text('Status', margin, y, { continued: true });
    pdf.fillColor(inv.status === 'PAID' ? '#166534' : (inv.status === 'UNPAID' ? '#991b1b' : '#92400e')).font('Helvetica-Bold').text(inv.status, { align: 'right' });
    y += 15;

    drawDashedLine(y);
    y += 10;

    // Customer
    pdf.fillColor('#94a3b8').fontSize(8).font('Helvetica').text('BILL TO', margin, y);
    y += 12;
    pdf.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(inv.customer?.name || "Walk-in Customer", margin, y);
    if (inv.customer?.phone) {
        y += 14;
        pdf.fillColor('#64748b').fontSize(10).font('Helvetica').text(inv.customer.phone, margin, y);
    }
    y += 15;

    drawDashedLine(y);
    y += 10;

    // Items
    const fmt = (n) => Number(n || 0).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    if (inv.items.length === 0) {
        pdf.fillColor('#94a3b8').fontSize(10).font('Helvetica').text('No items', margin, y, { align: 'center' });
        y += 20;
    } else {
        inv.items.forEach(item => {
            pdf.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(item.serviceName || item.productName || "Item", margin, y);
            
            const rate = Number(item.unitPrice || 0);
            const qty = Number(item.qty || 1);
            const amt = Number(item.lineTotal || rate * qty);

            pdf.fillColor('#94a3b8').fontSize(9).font('Courier').text(`${qty} x ${rate.toFixed(2)}`, margin, y + 12);
            pdf.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(fmt(amt), margin, y, { align: 'right' });
            
            y += 26;
        });
    }

    drawDashedLine(y);
    y += 10;

    // Totals
    pdf.fillColor('#64748b').fontSize(10).font('Helvetica').text('Subtotal', margin, y, { continued: true });
    pdf.fillColor('#0f172a').font('Courier').text(fmt(inv.subtotal), { align: 'right' });
    y += 16;

    if (Number(inv.discount) > 0) {
        pdf.fillColor('#22c55e').font('Helvetica').text('Discount', margin, y, { continued: true });
        pdf.font('Courier').text('- ' + fmt(inv.discount), { align: 'right' });
        y += 16;
    }
    if (Number(inv.tax) > 0) {
        pdf.fillColor('#f59e0b').font('Helvetica').text('Tax', margin, y, { continued: true });
        pdf.font('Courier').text('+ ' + fmt(inv.tax), { align: 'right' });
        y += 16;
    }

    y += 4;
    pdf.moveTo(margin, y).lineTo(width - margin, y).strokeColor('#0f172a').lineWidth(2).stroke();
    y += 10;

    pdf.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text('Grand Total', margin, y, { continued: true });
    pdf.font('Courier-Bold').fontSize(16).text('Rs ' + fmt(inv.total), { align: 'right' });
    y += 24;

    const paid = Number(inv.paidAmount || 0);
    const balance = Number(inv.balanceAmount || 0);

    if (paid > 0) {
        pdf.fillColor('#22c55e').fontSize(10).font('Helvetica').text('Paid', margin, y, { continued: true });
        pdf.font('Courier').text('Rs ' + fmt(paid), { align: 'right' });
        y += 16;
    }
    if (balance > 0) {
        pdf.fillColor('#ef4444').fontSize(10).font('Helvetica').text('Balance Due', margin, y, { continued: true });
        pdf.font('Courier').text('Rs ' + fmt(balance), { align: 'right' });
        y += 16;
    }

    drawDashedLine(y);
    y += 15;

    // Footer
    pdf.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text('Thank You!', margin, y, { align: 'center' });
    y += 18;
    pdf.fillColor('#94a3b8').fontSize(8).font('Helvetica').text('VISIT AGAIN . POWERED BY SKILLIFY', margin, y, { align: 'center', characterSpacing: 1 });
    y += 15;
    
    // Fake barcode
    pdf.rect(50, y, 200, 25).fillColor('#0f172a').fillOpacity(0.8).fill();
    y += 35;

    pdf.fillColor('#cbd5e1').fontSize(8).font('Courier').text(inv.invoiceNumber, margin, y, { align: 'center' });

    pdf.end();
  });


};

