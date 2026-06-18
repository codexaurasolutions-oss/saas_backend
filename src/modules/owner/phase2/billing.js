import PDFDocument from "pdfkit";
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

export const registerBillingRoutes = (ownerRouter) => {
  ownerRouter.get("/pos/context", requireFeatureEnabled("pos"), requireSalonPermission("pos", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const params = branchId ? { OR: [{ branchId }, { branchId: null }] } : {};
    const [customers, branches, services, staffUsers, products, memberships, packages, customerPackages, coupons, giftCards, settings] = await Promise.all([
      prisma.customer.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } }),
      prisma.branch.findMany({ where: { salonId: req.salonId, isActive: true }, orderBy: { createdAt: "desc" } }),
      prisma.service.findMany({ where: { salonId: req.salonId, isActive: true, ...params }, include: { category: true }, orderBy: { createdAt: "desc" } }),
      prisma.userSalon.findMany({
        where: { salonId: req.salonId, isArchived: false, ...params },
        include: { user: true, branch: true, serviceAssignments: true }
      }),
      prisma.product.findMany({
        where: {
          salonId: req.salonId,
          isActive: true,
          ...(branchId ? { OR: [{ branchId }, { branchId: null }, { stockMovements: { some: { branchId } } }] } : {})
        },
        include: { category: true, branch: true },
        orderBy: { createdAt: "desc" }
      }),
      prisma.customerMembership.findMany({ where: { salonId: req.salonId, status: "ACTIVE", customerId: req.query.customerId ? String(req.query.customerId) : undefined }, include: { membershipPlan: true } }),
      prisma.package.findMany({ where: { salonId: req.salonId, isActive: true }, include: { services: { include: { service: true } } }, orderBy: { createdAt: "desc" } }),
      prisma.customerPackage.findMany({ where: { salonId: req.salonId, status: "ACTIVE", customerId: req.query.customerId ? String(req.query.customerId) : undefined }, include: { package: { include: { services: { include: { service: true } } } }, usageLogs: true } }),
      prisma.coupon.findMany({
        where: {
          salonId: req.salonId,
          isArchived: false,
          ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {})
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
      customerPackages,
      coupons,
      giftCards,
      customerProfile,
      settings
    });
  });

  ownerRouter.post("/pos/invoices", requireFeatureEnabled("pos"), requireSalonPermission("pos", "create"), validate(schemas.invoice), async (req, res) => {
    try {
      res.status(201).json(await createPosInvoice({ salonId: req.salonId, actorUser: req.user, body: req.body }));
    } catch (error) {
      return sendRouteError(res, error, "Could not create POS invoice");
    }
  });

  ownerRouter.post("/invoices", requireFeatureEnabled("pos"), requireSalonPermission("pos", "create"), validate(schemas.invoice), async (req, res) => {
    try {
      res.status(201).json(await createPosInvoice({ salonId: req.salonId, actorUser: req.user, body: req.body }));
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
            { invoiceNumber: { contains: q, mode: "insensitive" } },
            { customer: { is: { name: { contains: q, mode: "insensitive" } } } }
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
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { payments: true } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.status === "CANCELLED") return res.status(400).json({ message: "Invoice already cancelled" });
    if (invoice.payments.some((payment) => payment.amount > 0)) return res.status(400).json({ message: "Paid invoice requires refund flow instead of cancel" });
    res.json(await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED", balanceAmount: 0 } }));
  });

  ownerRouter.post("/payments", requireSalonPermission("payments", "create"), validate(schemas.payment), async (req, res) => {
    res.status(201).json(await addInvoicePayment({
      salonId: req.salonId,
      invoiceId: req.body.invoiceId,
      amount: req.body.amount,
      mode: req.body.mode,
      note: req.body.note,
      actorUser: req.user
    }));
  });

  ownerRouter.post("/payments/refund", requireSalonPermission("payments", "edit"), validate(schemas.refundPayment), async (req, res) => {
    res.json(await refundInvoice({
      salonId: req.salonId,
      invoiceId: req.body.invoiceId,
      amount: req.body.amount,
      note: req.body.note,
      actorUser: req.user
    }));
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
            { note: { contains: q, mode: "insensitive" } },
            { invoice: { is: { invoiceNumber: { contains: q, mode: "insensitive" } } } },
            { invoice: { is: { customer: { is: { name: { contains: q, mode: "insensitive" } } } } } }
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
      include: { customer: true, items: true, payments: true, branch: true }
    });
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const settings = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: inv.branchId || null } });
    const footer = settings?.invoiceFooter || "Thank you for visiting.";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename=\"${inv.invoiceNumber}.pdf\"`);
    const pdf = new PDFDocument({ margin: 40, size: "A4" });
    pdf.pipe(res);
    pdf.fontSize(22).text(`Invoice ${inv.invoiceNumber}`);
    pdf.moveDown(0.5);
    pdf.fontSize(11).text(`Customer: ${inv.customer.name}`);
    pdf.text(`Branch: ${inv.branch?.name || "Main salon"}`);
    pdf.text(`Status: ${inv.status}`);
    if (inv.couponCode) pdf.text(`Coupon: ${inv.couponCode}`);
    if (inv.giftVoucherCode) pdf.text(`Gift Card: ${inv.giftVoucherCode}`);
    if (inv.loyaltyPointsUsed) pdf.text(`Loyalty Points Redeemed: ${inv.loyaltyPointsUsed}`);
    pdf.text(`Created: ${new Date(inv.createdAt).toLocaleString()}`);
    pdf.moveDown();
    pdf.fontSize(12).text("Items", { underline: true });
    pdf.moveDown(0.5);
    inv.items.forEach((item, index) => {
      pdf.fontSize(10).text(`${index + 1}. ${item.serviceName} | Type: ${item.itemType} | Staff: ${item.staffName || "-"} | Qty: ${item.qty} | Unit: ${item.unitPrice} | Tax: ${item.taxPct}% | Line: ${item.lineTotal}`);
      pdf.moveDown(0.3);
    });
    pdf.moveDown();
    pdf.fontSize(12).text("Payments", { underline: true });
    pdf.moveDown(0.5);
    if (inv.payments.length) {
      inv.payments.forEach((payment, index) => {
        pdf.fontSize(10).text(`${index + 1}. ${payment.mode} | Amount: ${payment.amount} | Type: ${payment.type} | Note: ${payment.note || "-"} | Date: ${new Date(payment.createdAt).toLocaleString()}`);
        pdf.moveDown(0.3);
      });
    } else {
      pdf.fontSize(10).text("No payments recorded yet.");
    }
    pdf.moveDown();
    pdf.fontSize(11).text(`Subtotal: ${inv.subtotal}`);
    pdf.text(`Tax: ${inv.tax}`);
    pdf.text(`Discount: ${inv.discount}`);
    pdf.text(`Grand Total: ${inv.total}`);
    pdf.text(`Paid Amount: ${inv.paidAmount}`);
    pdf.text(`Refunded: ${inv.refundAmount}`);
    pdf.moveDown();
    pdf.fontSize(10).text(footer);
    pdf.end();
  });
};
