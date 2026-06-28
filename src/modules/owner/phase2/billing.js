import PDFDocument from "pdfkit";
import { getNotificationToggles } from "../../../lib/emailAutomation.js";
import { attemptCustomerTemplateEmail } from "../../../lib/emailNotifications.js";
import { prisma } from "../../../lib/prisma.js";
import { addInvoicePayment, addInvoiceTip, createPosInvoice, generatePaymentLink, getDayClosingSummary, logPaymentLinkPlaceholder, refundInvoice } from "../../../lib/pos.js";
import { reverseInvoiceLoyalty, createStaffNotification, createCustomerNotification } from "../../../lib/phase4.js";
import { attachBranchStock, normalizeBranchId, toAmount } from "../../../lib/phase2.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const withBranchFilter = (salonId, branchId) => ({ salonId, ...(branchId ? { branchId } : {}) });
const paymentWhere = (salonId, branchId) => ({ salonId, ...(branchId ? { invoice: { is: { branchId } } } : {}) });
const sendRouteError = (res, error, fallbackMessage) => {
  const status = Number(error?.status || error?.response?.status || 500);
  return res.status(status).json({ message: error?.message || fallbackMessage });
};

const attachSalonSettings = async (req, res, next) => {
  if (!req.salonId) return next();
  const settings = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
  req.salonSettings = settings || {};
  req.advancedSettings = typeof settings?.advancedSettings === "object" && settings.advancedSettings ? settings.advancedSettings : {};
  next();
};

const sendInvoiceAutomationEmails = async (salonId, invoice) => {
  const customerId = invoice?.customerId || null;
  const toEmail = invoice?.customer?.email || "";
  const branchId = invoice?.branchId || null;

  const { isOn, emailEnabled } = await getNotificationToggles(salonId, branchId).catch(() => ({ isOn: () => true, emailEnabled: true }));

  // Invoice email (advanceReceivedInvoice toggle)
  if (isOn("advanceReceivedInvoice") && emailEnabled && toEmail) {
    await attemptCustomerTemplateEmail({
      salonId,
      toEmail,
      templateType: "invoice_template",
      context: { invoiceId: invoice?.id, customerId }
    }).catch(() => {});
  }

  // Owner in-app notification (balanceClearedInvoice toggle)
  if (isOn("balanceClearedInvoice") && invoice?.status === "PAID") {
    await createStaffNotification({
      salonId,
      userSalonId: null,
      title: "Invoice Paid",
      message: `Invoice ${invoice.invoiceNumber || ""} has been fully paid.`,
      type: "INVOICE",
      linkUrl: `/admin/invoices/${invoice.id}`
    }).catch(() => {});
  }

  // Customer in-app notification
  if (customerId) {
    await createCustomerNotification({
      salonId,
      customerId,
      title: "Your Invoice",
      message: `Your invoice ${invoice.invoiceNumber || ""} has been created. Total: ${invoice.total || 0}.`
    }).catch(() => {});
  }

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
    if (isOn("membershipPurchase") && emailEnabled) {
      await attemptCustomerTemplateEmail({
        salonId,
        toEmail: membership.customer?.email || toEmail,
        templateType: "membership_purchase_template",
        context: {
          customerId: membership.customerId,
          customerMembershipId: membership.id,
          invoiceId: invoice?.id
        }
      }).catch(() => {});
    }
    // In-app
    if (isOn("membershipPurchase") && membership.customerId) {
      await createCustomerNotification({
        salonId,
        customerId: membership.customerId,
        title: "Membership Activated",
        message: `Your membership "${membership.membershipPlan?.name || ""}" is now active.`
      }).catch(() => {});
    }
  }

  for (const customerPackage of soldPackages) {
    if (isOn("packagePurchase") && emailEnabled) {
      await attemptCustomerTemplateEmail({
        salonId,
        toEmail: customerPackage.customer?.email || toEmail,
        templateType: "package_purchase_template",
        context: {
          customerId: customerPackage.customerId,
          customerPackageId: customerPackage.id,
          invoiceId: invoice?.id
        }
      }).catch(() => {});
    }
    // In-app
    if (isOn("packagePurchase") && customerPackage.customerId) {
      await createCustomerNotification({
        salonId,
        customerId: customerPackage.customerId,
        title: "Package Activated",
        message: `Your package "${customerPackage.package?.name || ""}" is now active.`
      }).catch(() => {});
    }
  }
};

export const registerBillingRoutes = (ownerRouter) => {
  ownerRouter.get("/pos/context", async (req, res, next) => {
    if (req.user?.systemRole === "SUPER_ADMIN") return next();
    const perms = req.user?.permissions || {};
    const flags = req.user?.featureFlags || {};
    const canPos = flags.pos !== false && Array.isArray(perms.pos) && perms.pos.includes("view");
    const canAppt = flags.appointments !== false && Array.isArray(perms.appointments) && perms.appointments.includes("view");
    
    if (!canPos && !canAppt) {
      return res.status(403).json({ message: "You don't have permission to view POS or Appointments context" });
    }
    next();
  }, async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const params = branchId ? { OR: [{ branchId }, { branchId: null }, { branchId: "" }] } : {};
    const [customers, branches, services, staffUsers, products, memberships, packages, coupons, giftCards, settings, advanceTimeline] = await Promise.all([
      prisma.customer.findMany({
        where: { salonId: req.salonId }, 
        orderBy: { createdAt: "desc" },
        include: {
          memberships: { 
            include: { membershipPlan: true },
            orderBy: { createdAt: "desc" }
          },
          packages: { 
            include: { package: { include: { services: { include: { service: true } } } } },
            orderBy: { createdAt: "desc" }
          },
          invoices: {
            select: { id: true, balanceAmount: true, status: true, createdAt: true, total: true, items: { select: { lineTotal: true, itemType: true } } },
            orderBy: { createdAt: "desc" },
            take: 20
          }
        }
      }),
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
      prisma.membershipPlan.findMany({ where: { salonId: req.salonId, isActive: true }, include: { services: { include: { service: true } } }, orderBy: { createdAt: "desc" } }),
      prisma.package.findMany({ where: { salonId: req.salonId, isActive: true }, include: { services: { include: { service: true } } }, orderBy: { createdAt: "desc" } }),
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
      prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: branchId || null } }),
      prisma.customerTimeline.findMany({
        where: { customerId: { in: [] }, eventType: "ADVANCE_PAYMENT" },
        select: { customerId: true, details: true }
      })
    ]);

    // Refetch advance timeline for all customers
    const allAdvanceEntries = await prisma.customerTimeline.findMany({
      where: { customerId: { in: customers.map(c => c.id) }, eventType: "ADVANCE_PAYMENT" },
      select: { customerId: true, details: true }
    });
    const advanceByCustomer = new Map();
    allAdvanceEntries.forEach((entry) => {
      try {
        const details = JSON.parse(entry.details || "{}");
        const amount = Number(details.amount || 0);
        advanceByCustomer.set(entry.customerId, (advanceByCustomer.get(entry.customerId) || 0) + amount);
      } catch (e) {}
    });

    // Sum up advance USED as payment (Payment.mode = 'ADVANCE' on non-advance-invoices)
    // Advance invoices have itemType = 'ADVANCE' and a single "Advance Payment" line item with total = advance amount
    // When advance is USED to pay for a regular service/product, the invoice has type != 'ADVANCE' itemType items
    // AND a payment with mode = 'ADVANCE'. We subtract these to get the remaining available advance.
    const advanceInvoiceIds = new Set(
      (await prisma.invoiceItem.findMany({
        where: { itemType: "ADVANCE" },
        select: { invoiceId: true }
      })).map(i => i.invoiceId)
    );
    const usedAdvanceByCustomer = new Map();
    if (advanceInvoiceIds.size > 0) {
      const usedPayments = await prisma.payment.findMany({
        where: {
          salonId: req.salonId,
          mode: "ADVANCE",
          invoiceId: { notIn: Array.from(advanceInvoiceIds) }
        },
        select: { invoice: { select: { customerId: true } }, amount: true }
      });
      usedPayments.forEach((p) => {
        if (!p.invoice?.customerId) return;
        const cid = p.invoice.customerId;
        usedAdvanceByCustomer.set(cid, (usedAdvanceByCustomer.get(cid) || 0) + Number(p.amount || 0));
      });
    }

    // Enrich customers: compute lastVisitAt from invoices if not set
    const enrichedCustomers = customers.map(c => {
      let lastVisitAt = c.lastVisitAt;
      if (!lastVisitAt && c.invoices && c.invoices.length > 0) {
        const paidInvoice = c.invoices.find(inv => inv.status === "PAID" || inv.status === "PARTIAL");
        lastVisitAt = paidInvoice ? paidInvoice.createdAt : c.invoices[0].createdAt;
      }
      const totalAdvance = advanceByCustomer.get(c.id) || 0;
      const usedAdvance = usedAdvanceByCustomer.get(c.id) || 0;
      const availableAdvance = Math.max(0, totalAdvance - usedAdvance);
      return { ...c, lastVisitAt, advanceAmount: availableAdvance };
    });

    const customerProfile = req.query.customerId
      ? enrichedCustomers.find((row) => row.id === String(req.query.customerId)) || null
      : null;
    res.json({
      customers: enrichedCustomers,
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
      sendInvoiceAutomationEmails(req.salonId, invoice).catch(err => {
        console.error("Failed to send POS invoice automation emails:", err);
      });
      res.status(201).json(invoice);
    } catch (error) {
      return sendRouteError(res, error, "Could not create POS invoice");
    }
  });

  ownerRouter.post("/invoices", requireFeatureEnabled("pos"), requireSalonPermission("pos", "create"), validate(schemas.invoice), async (req, res) => {
    try {
      const invoice = await createPosInvoice({ salonId: req.salonId, actorUser: req.user, body: req.body });
      sendInvoiceAutomationEmails(req.salonId, invoice).catch(err => {
        console.error("Failed to send invoice automation emails:", err);
      });
      res.status(201).json(invoice);
    } catch (error) {
      return sendRouteError(res, error, "Could not create invoice");
    }
  });

  ownerRouter.get("/invoices", requireSalonPermission("invoices", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.lte = end;
    }
    console.log("FETCHING INVOICES FOR SALON:", req.salonId, "BRANCH:", branchId, "DATE:", dateFilter);
    const result = await prisma.invoice.findMany({
      where: {
        ...withBranchFilter(req.salonId, branchId),
        ...(status ? { status } : {}),
        ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}),
        ...(q ? {
          OR: [
            { invoiceNumber: { contains: q } },
            { customer: { is: { name: { contains: q } } } }
          ]
        } : {})
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        items: true,
        payments: true
      },
      orderBy: { createdAt: "desc" }
    });
    console.log("INVOICES FOUND:", result.length);
    res.json(result);
  });


  ownerRouter.get("/invoices/reports/summary", requireSalonPermission("invoices", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const startDate = req.query.startDate;
    const endDate = req.query.endDate;
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateFilter.lte = end;
    }
    
    const rows = await prisma.invoice.findMany({
      where: {
        ...withBranchFilter(req.salonId, branchId),
        ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {})
      },
      select: { status: true }
    });

    res.json({
      totalInvoices: rows.length,
      unpaidInvoices: rows.filter((row) => row.status === "UNPAID").length,
      partialInvoices: rows.filter((row) => row.status === "PARTIAL").length,
      paidInvoices: rows.filter((row) => row.status === "PAID").length,
      cancelledInvoices: rows.filter((row) => row.status === "CANCELLED").length
    });
  });

  ownerRouter.get("/invoices/:id", requireSalonPermission("invoices", "view"), async (req, res) => {
    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { customer: true, items: true, payments: true, branch: true, appointment: true }
    });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    res.json(invoice);
  });

  ownerRouter.patch("/invoices/:id", requireSalonPermission("invoices", "edit"), attachSalonSettings, async (req, res) => {
    const existingInvoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: {
        items: true,
        payments: true,
        customer: true,
        branch: true,
        onlineOrders: true
      }
    });
    if (!existingInvoice) return res.status(404).json({ message: "Invoice not found" });
    if (existingInvoice.status === "CANCELLED" || existingInvoice.status === "REFUNDED") {
      return res.status(400).json({ message: "This invoice cannot be edited" });
    }

    const allowPriceEdit = req.advancedSettings?.allowPriceEditOnBill !== false;
    const allowEditConsumable = req.advancedSettings?.allowEditConsumable !== false;

    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!rawItems.length) return res.status(400).json({ message: "At least one invoice item is required" });

    try {
      const sanitizedItems = [];
      for (const rawItem of rawItems) {
        if (rawItem.itemType === "PRODUCT" && !allowEditConsumable) {
          const existingItem = existingInvoice.items.find((i) => i.id === rawItem.id);
          if (existingItem && (rawItem.qty !== undefined && Number(rawItem.qty) !== existingItem.qty)) {
            return res.status(403).json({ message: "Consumable editing is restricted by salon settings" });
          }
        }
        const qty = Math.max(1, Number(rawItem?.qty || 1));
        const unitPrice = Math.max(0, toAmount(rawItem?.unitPrice || 0));
        if (!allowPriceEdit) {
          const existingItem = existingInvoice.items.find((i) => i.id === rawItem.id);
          if (existingItem && unitPrice !== toAmount(existingItem.unitPrice)) {
            return res.status(403).json({ message: "Price edits on the bill are restricted by salon settings" });
          }
        }
        const taxPct = Math.max(0, toAmount(rawItem?.taxPct || 0));
        const inclusiveTax = req.advancedSettings?.taxMapping?.inclusiveTax === true;
        const lineBase = unitPrice * qty;
        const lineTax = inclusiveTax && taxPct > 0
          ? (lineBase * taxPct) / (100 + taxPct)
          : (lineBase * taxPct) / 100;
        let staffName = rawItem?.staffName || null;
        let staffUserSalonId = rawItem?.staffUserSalonId || rawItem?.staffUserId || null;

        if (staffUserSalonId) {
          const staffMembership = await prisma.userSalon.findFirst({
            where: { id: String(staffUserSalonId), salonId: req.salonId },
            include: { user: true }
          });
          if (!staffMembership) {
            return res.status(400).json({ message: "Selected staff member is invalid" });
          }
          staffUserSalonId = staffMembership.id;
          staffName = staffMembership.user?.name || staffName;
        }

        if (String(rawItem?.itemType) === "PACKAGE" && (rawItem?.isCustom || rawItem?.packageId === "CUSTOM")) {
            const pack = await prisma.package.create({
              data: {
                salonId: req.salonId,
                name: String(rawItem?.serviceName || "Custom Package"),
                price: Math.max(0, toAmount(rawItem?.unitPrice || 0)),
                totalSessions: Array.isArray(rawItem?.customServices) ? rawItem.customServices.length : 1,
                validityDays: Number(rawItem?.validityDays || 30),
                isPublicVisible: false,
                isActive: true
              }
            });
            rawItem.packageId = pack.id;
            if (Array.isArray(rawItem?.customServices) && rawItem.customServices.length > 0) {
              await prisma.packageService.createMany({
                data: rawItem.customServices.map(sid => ({ packageId: pack.id, serviceId: typeof sid === 'object' ? sid.id || sid.serviceId : sid, sessions: typeof sid === 'object' && sid.qty ? Number(sid.qty) : 1 }))
              });
            }
          }

          if (String(rawItem?.itemType) === "MEMBERSHIP" && (rawItem?.isCustom || rawItem?.membershipPlanId === "CUSTOM")) {
            const plan = await prisma.membershipPlan.create({
              data: {
                salonId: req.salonId,
                name: String(rawItem?.serviceName || "Custom Membership"),
                price: Math.max(0, toAmount(rawItem?.unitPrice || 0)),
                validityDays: Number(rawItem?.validityDays || 30),
                benefitType: "DISCOUNT_PERCENT",
                discountValue: 0,
                isPublicVisible: false,
                isActive: true
              }
            });
            rawItem.membershipPlanId = plan.id;
            if (Array.isArray(rawItem?.customServices) && rawItem.customServices.length > 0) {
              await prisma.membershipPlanService.createMany({
                data: rawItem.customServices.map(sid => ({ membershipPlanId: plan.id, serviceId: typeof sid === 'object' ? sid.id || sid.serviceId : sid }))
              });
            }
          }

          sanitizedItems.push({
            id: rawItem?.id ? String(rawItem.id) : null,
            itemType: String(rawItem?.itemType || "SERVICE"),
          serviceName: String(rawItem?.serviceName || rawItem?.productName || "Item"),
          staffName,
          qty,
          unitPrice,
          taxPct,
          lineTotal: inclusiveTax && taxPct > 0 ? lineBase : lineBase + lineTax,
          ...(rawItem?.serviceId ? { serviceId: String(rawItem.serviceId) } : {}),
          ...(rawItem?.productId ? { product: { connect: { id: String(rawItem.productId) } } } : {}),
          ...(rawItem?.membershipPlanId ? { membershipPlan: { connect: { id: String(rawItem.membershipPlanId) } } } : {}),
          ...(rawItem?.packageId ? { package: { connect: { id: String(rawItem.packageId) } } } : {}),
          ...(staffUserSalonId ? { staffUserSalon: { connect: { id: staffUserSalonId } } } : {})
        });
      }

      const inclusiveTax = req.advancedSettings?.taxMapping?.inclusiveTax === true;
      const subtotal = sanitizedItems.reduce((sum, item) => sum + (toAmount(item.unitPrice) * Number(item.qty || 1)), 0);
      const tax = inclusiveTax
        ? sanitizedItems.reduce((sum, item) => {
            const preTax = toAmount(item.unitPrice) * Number(item.qty || 1);
            const tp = toAmount(item.taxPct);
            return sum + (tp > 0 ? (preTax * tp) / (100 + tp) : 0);
          }, 0)
        : sanitizedItems.reduce((sum, item) => sum + (((toAmount(item.unitPrice) * Number(item.qty || 1)) * toAmount(item.taxPct)) / 100), 0);
      const discount = Math.max(0, toAmount(req.body?.discount ?? existingInvoice.discount ?? 0));
      const total = Math.max(0, subtotal + tax - discount);
      const paidAmount = Math.max(0, toAmount(existingInvoice.paidAmount || 0));
      const refundAmount = Math.max(0, toAmount(existingInvoice.refundAmount || 0));
      const additionalPayments = Array.isArray(req.body?.additionalPayments) ? req.body.additionalPayments : [];
      const notes = typeof req.body?.notes === "string" ? req.body.notes.trim() : existingInvoice.notes;

      const updatedInvoice = await prisma.$transaction(async (tx) => {
        const keepIds = sanitizedItems.map((item) => item.id).filter(Boolean);
        await tx.invoiceItem.deleteMany({
          where: {
            invoiceId: existingInvoice.id,
            ...(keepIds.length ? { id: { notIn: keepIds } } : {})
          }
        });

        for (const item of sanitizedItems) {
          const payload = {
            itemType: item.itemType,
            serviceName: item.serviceName,
            staffName: item.staffName,
            qty: item.qty,
            unitPrice: item.unitPrice,
            taxPct: item.taxPct,
            lineTotal: item.lineTotal
          };

          if (item.id) {
            await tx.invoiceItem.update({
              where: { id: item.id },
              data: payload
            });
          } else {
            await tx.invoiceItem.create({
              data: {
                invoiceId: existingInvoice.id,
                ...payload
              }
            });
          }
        }

        const nextBalance = Math.max(0, total - Math.max(0, paidAmount - refundAmount));
        const nextStatus = total <= 0
          ? "PAID"
          : paidAmount >= total
            ? "PAID"
            : paidAmount > 0
              ? "PARTIAL"
              : "UNPAID";

        await tx.invoice.update({
          where: { id: existingInvoice.id },
          data: {
            subtotal,
            tax,
            discount,
            total,
            balanceAmount: nextBalance,
            status: nextStatus,
            notes
          }
        });

        if (existingInvoice.onlineOrders?.length) {
          await tx.onlineOrder.updateMany({
            where: { invoiceId: existingInvoice.id, salonId: req.salonId },
            data: {
              subtotal,
              tax,
              discount,
              total,
              paidAmount
            }
          });
        }

        return tx.invoice.findUnique({
          where: { id: existingInvoice.id },
          include: { customer: true, items: true, payments: true, branch: true, appointment: true }
        });
      });

      let finalInvoice = updatedInvoice;
      for (const payment of additionalPayments) {
        const amount = toAmount(payment?.amount || 0);
        const mode = String(payment?.mode || "CASH");
        if (amount <= 0) continue;
        await addInvoicePayment({
          salonId: req.salonId,
          invoiceId: existingInvoice.id,
          amount,
          mode,
          note: payment?.note || "Collected from POS dashboard edit",
          actorUser: req.user
        });
      }

      if (additionalPayments.some((payment) => toAmount(payment?.amount || 0) > 0)) {
        finalInvoice = await prisma.invoice.findFirst({
          where: { id: existingInvoice.id, salonId: req.salonId },
          include: { customer: true, items: true, payments: true, branch: true, appointment: true }
        });
      }

      res.json(finalInvoice);
    } catch (error) {
      return sendRouteError(res, error, "Could not update invoice");
    }
  });

  ownerRouter.patch("/invoices/:id/cancel", requireSalonPermission("invoices", "edit"), async (req, res) => {
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { payments: true, customer: true, branch: true } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.status === "CANCELLED") return res.status(400).json({ message: "Invoice already cancelled" });
    if (invoice.payments.some((payment) => payment.amount > 0)) return res.status(400).json({ message: "Paid invoice requires refund flow instead of cancel" });
    await prisma.$transaction(async (tx) => {
      await tx.invoice.update({ where: { id: invoice.id }, data: { status: "CANCELLED", balanceAmount: 0 } });
      await reverseInvoiceLoyalty(tx, invoice, req.user);
    });
    await attemptCustomerTemplateEmail({
      salonId: req.salonId,
      toEmail: invoice.customer?.email || "",
      templateType: "invoice_cancel_template",
      context: { invoiceId: invoice.id, customerId: invoice.customerId }
    });
    res.json({ message: "Invoice cancelled and loyalty points reversed" });
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

  
  ownerRouter.get("/invoices/:id", requireSalonPermission("invoices", "view"), async (req, res) => {
    try {
      const inv = await prisma.invoice.findFirst({
        where: { id: req.params.id, salonId: req.salonId },
        include: { 
          customer: true, 
          items: true, 
          payments: true, 
          branch: true 
        }
      });
      if (!inv) return res.status(404).json({ message: "Invoice not found" });
      res.json(inv);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

const sanitizeInvoicePhone = (phone) => {
  if (!phone) return "";
  let clean = phone.trim();
  if (clean.startsWith("+92")) {
    return "+91" + clean.slice(3);
  }
  if (clean.startsWith("92") && clean.length > 10) {
    return "+91" + clean.slice(2);
  }
  return clean;
};

  ownerRouter.get("/invoices/:id/receipt", requireSalonPermission("invoices", "view"), async (req, res) => {
    const inv = await prisma.invoice.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { customer: true, items: true, payments: true, branch: true }
    });
    if (!inv) return res.status(404).json({ message: "Invoice not found" });
    const settings = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: inv.branchId || null } });
    const footer = settings?.invoiceFooter || "Thank you for visiting.";
    const salonName = inv.branch?.name || "My Salon";
    const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const items = inv.items.map((item) => {
      const rate = Number(item.unitPrice || 0);
      const qty = Number(item.qty || 1);
      const amt = Number(item.lineTotal || rate * qty);
      return `<div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px dashed #e2e8f0;">
        <div style="flex:1;">
          <div style="font-weight:600;color:#0f172a;font-size:13px;">${item.serviceName || "Item"}</div>
          <div style="font-size:11px;color:#94a3b8;margin-top:3px;font-family:'Courier New',monospace;">${qty} &times; ${fmt(rate)}</div>
        </div>
        <div style="font-weight:700;color:#0f172a;font-size:13px;text-align:right;min-width:80px;font-family:'Courier New',monospace;">${fmt(amt)}</div>
      </div>`;
    }).join("");

    const subtotal = fmt(inv.subtotal);
    const discountAmt = Number(inv.discount) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;"><span style="color:#22c55e;">Discount</span><span style="color:#22c55e;font-family:'Courier New',monospace;">- ${fmt(inv.discount)}</span></div>` : "";
    const taxAmt = Number(inv.tax) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;"><span style="color:#f59e0b;">Tax</span><span style="color:#f59e0b;font-family:'Courier New',monospace;">+ ${fmt(inv.tax)}</span></div>` : "";
    const paidAmt = Number(inv.paidAmount) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;"><span style="color:#22c55e;">Paid</span><span style="color:#22c55e;font-family:'Courier New',monospace;">${fmt(inv.paidAmount)}</span></div>` : "";
    const balAmt = Number(inv.balanceAmount) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:12px;"><span style="color:#ef4444;">Balance Due</span><span style="color:#ef4444;font-family:'Courier New',monospace;">${fmt(inv.balanceAmount)}</span></div>` : "";

    const paymentRows = (inv.payments || []).map(p =>
      `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:10px;"><span style="color:#94a3b8;text-transform:uppercase;font-weight:600;">${p.mode}</span><span style="color:#64748b;font-family:'Courier New',monospace;">${fmt(p.amount)}</span></div>`
    ).join("");

    const barcode = Array.from({ length: 48 }, (_, i) => {
      const w = [1,2,3,1,2,1,3,2,1,2][i % 10];
      const h = 24 + (i % 4) * 4;
      return `<div style="width:${w}px;height:${h}px;background:#0f172a;border-radius:0.5px;opacity:${0.75 + (i%3)*0.08};"></div>`;
    }).join("");

    const invDate = new Date(inv.createdAt);
    const dateStr = invDate.toLocaleDateString("en-GB", { day:"2-digit", month:"2-digit", year:"numeric" }).replace(/\//g,"-");
    const timeStr = invDate.toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", hour12:true });
    const statusUp = (inv.status || "UNPAID").toUpperCase();
    const statusColor = { PAID: "#166534", UNPAID: "#dc2626", PARTIAL: "#d97706", CANCELLED: "#475569" }[statusUp] || "#475569";
    const statusBg = { PAID: "#dcfce7", UNPAID: "#fef2f2", PARTIAL: "#fffbeb", CANCELLED: "#f1f5f9" }[statusUp] || "#f1f5f9";

    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Invoice ${inv.invoiceNumber}</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap');*{margin:0;padding:0;box-sizing:border-box;}</style>
</head><body style="font-family:'Inter',sans-serif;background:#1e293b;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px;">
<div style="width:380px;max-width:100%;background:#fff;border-radius:16px;box-shadow:0 25px 60px -12px rgba(0,0,0,0.35);overflow:hidden;">
  <div style="padding:0 24px 24px;">
    <div style="text-align:center;padding:20px 0 4px;">
      <div style="font-size:26px;font-weight:900;letter-spacing:3px;color:#0f172a;">${salonName.toUpperCase()}</div>
      <div style="font-size:9px;letter-spacing:3.5px;color:#94a3b8;margin-top:4px;text-transform:uppercase;font-weight:600;">Hair &middot; Lifestyle &middot; Care</div>
      ${inv.branch?.address ? `<div style="font-size:11px;color:#64748b;margin-top:6px;line-height:1.6;">${inv.branch.address}${inv.branch?.phone ? `<br>${sanitizeInvoicePhone(inv.branch.phone)}` : ""}</div>` : ""}
    </div>
    <div style="border-top:1px dashed #cbd5e1;margin:14px 0;"></div>
    <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px;">
      <span style="color:#94a3b8;font-size:11px;font-weight:500;">Invoice No</span><span style="color:#0f172a;font-weight:600;text-align:right;font-family:'Courier New',monospace;">${inv.invoiceNumber || "—"}</span>
      <span style="color:#94a3b8;font-size:11px;font-weight:500;">Date</span><span style="color:#0f172a;font-weight:600;text-align:right;font-family:'Courier New',monospace;">${dateStr}</span>
      <span style="color:#94a3b8;font-size:11px;font-weight:500;">Time</span><span style="color:#0f172a;font-weight:600;text-align:right;font-family:'Courier New',monospace;">${timeStr}</span>
      <span style="color:#94a3b8;font-size:11px;font-weight:500;">Status</span><span style="text-align:right;"><span style="display:inline-flex;align-items:center;border-radius:6px;padding:2px 8px;font-size:10px;font-weight:700;letter-spacing:0.5px;color:${statusColor};background:${statusBg};border:1px solid ${statusColor}22;">${statusUp}</span></span>
    </div>
    <div style="border-top:1px dashed #cbd5e1;margin:14px 0;"></div>
    <div style="margin-bottom:4px;">
      <div style="font-size:9px;color:#94a3b8;letter-spacing:2.5px;text-transform:uppercase;font-weight:700;">Bill To</div>
      <div style="font-weight:700;font-size:14px;color:#0f172a;margin-top:2px;">${inv.customer?.name || "Walk-in Customer"}</div>
      ${inv.customer?.phone ? `<div style="font-size:11px;color:#64748b;margin-top:1px;font-family:'Courier New',monospace;">${sanitizeInvoicePhone(inv.customer.phone)}</div>` : ""}
    </div>
    <div style="border-top:1px dashed #cbd5e1;margin:14px 0;"></div>
    <div>${items || '<div style="text-align:center;color:#94a3b8;font-size:12px;padding:14px 0;">No items</div>'}</div>
    <div style="border-top:1px dashed #cbd5e1;margin:14px 0 0;"></div>
    <div style="margin-top:8px;">
      <div style="display:flex;justify-content:space-between;padding:4px 0;"><span style="color:#64748b;font-size:12px;">Subtotal</span><span style="font-family:'Courier New',monospace;font-size:12px;">${subtotal}</span></div>
      ${discountAmt}${taxAmt}
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding:14px 0 6px;border-top:2px solid #0f172a;margin-top:8px;"><span style="font-weight:800;font-size:14px;color:#0f172a;letter-spacing:0.5px;">Grand Total</span><span style="font-family:'Courier New',monospace;font-weight:900;font-size:22px;color:#0f172a;">${fmt(inv.total)}</span></div>
      ${paidAmt}${balAmt}
      ${paymentRows ? `<div style="border-top:1px dashed #cbd5e1;margin:10px 0 6px;"></div>${paymentRows}` : ""}
    </div>
    <div style="border-top:1px dashed #cbd5e1;margin:16px 0 0;"></div>
    <div style="text-align:center;padding:16px 0 20px;">
      <div style="font-size:15px;font-weight:800;color:#0f172a;letter-spacing:1.5px;margin-bottom:4px;">Thank You!</div>
      <div style="font-size:10px;color:#94a3b8;letter-spacing:2px;font-weight:600;">Visit Again</div>
      <div style="margin:14px auto 0;width:75%;height:36px;display:flex;align-items:flex-end;justify-content:center;gap:1.5px;">${barcode}</div>
      <div style="font-size:9px;color:#cbd5e1;margin-top:8px;letter-spacing:2px;font-family:'Courier New',monospace;">${inv.invoiceNumber || "—"}</div>
    </div>
  </div>
  <svg viewBox="0 0 380 16" preserveAspectRatio="none" style="display:block;width:100%;height:16px;"><polygon points="0,0 19,16 38,0 57,16 76,0 95,16 114,0 133,16 152,0 171,16 190,0 209,16 228,0 247,16 266,0 285,16 304,0 323,16 342,0 361,16 380,0 380,16 0,16" fill="#fff"/><polyline points="0,0 19,16 38,0 57,16 76,0 95,16 114,0 133,16 152,0 171,16 190,0 209,16 228,0 247,16 266,0 285,16 304,0 323,16 342,0 361,16 380,0" fill="none" stroke="#e2e8f0" stroke-width="1"/></svg>
</div>
</body></html>`;
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  });

  ownerRouter.get("/invoices/:id/pdf", requireSalonPermission("invoices", "view"), async (req, res) => {
    const inv = await prisma.invoice.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { items: true, payments: true, customer: true, branch: true, salon: true }
    });
    if (!inv) return res.status(404).json({ error: "Invoice not found" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="invoice-${inv.invoiceNumber}.pdf"`);

    const width = 380; // Match wrap width of 380px exactly!
    const margin = 24;
    const contentWidth = width - margin * 2;
    const docHeight = 580 + (inv.items.length * 45) + ((inv.payments || []).length * 15);
    const pdf = new PDFDocument({ margin: margin, size: [width, docHeight] });
    pdf.pipe(res);

    const salonName = inv.salon?.name || "My Salon";
    const branchName = inv.branch?.name || "";
    const brandName = salonName.toUpperCase();
    const phone = sanitizeInvoicePhone(inv.branch?.phone || inv.salon?.phone || "");
    const currencyCode = inv.salon?.currency || "INR";

    const getCurrencySymbol = (code) => {
      switch (code.toUpperCase()) {
        case "USD": return "$";
        case "EUR": return "€";
        case "GBP": return "£";
        case "AED": return "AED ";
        case "SAR": return "SAR ";
        case "PKR": return "Rs. ";
        case "INR":
        default: return "INR ";
      }
    };
    const symbol = getCurrencySymbol(currencyCode);
    const fmt = (n) => symbol + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let y = margin;

    const drawDashedLine = (yPos) => {
      pdf.moveTo(margin, yPos).lineTo(width - margin, yPos).dash(3, { space: 3 }).strokeColor('#cbd5e1').stroke();
      pdf.undash();
    };

    const drawSolidLine = (yPos, color = '#cbd5e1', w = 1) => {
      pdf.moveTo(margin, yPos).lineTo(width - margin, yPos).lineWidth(w).strokeColor(color).stroke();
    };

    const getStatusColors = (status) => {
      switch (status) {
        case "PAID":
          return { bg: "#dcfce7", text: "#166534" };
        case "UNPAID":
          return { bg: "#fef2f2", text: "#dc2626" };
        case "PARTIAL":
          return { bg: "#fffbeb", text: "#d97706" };
        default:
          return { bg: "#f8fafc", text: "#475569" };
      }
    };

    const drawFakeBarcode = (yPos) => {
      const barcodeW = 180;
      const startX = margin + (contentWidth - barcodeW) / 2;
      pdf.save();
      for (let i = 0; i < 48; i++) {
        const w = [1, 2, 1.5, 1, 2, 1, 1.5, 2, 1, 2][i % 10];
        const h = 20 + (i % 4) * 3;
        const offset = (i * 3.7);
        pdf.fillColor('#0f172a').rect(startX + offset, yPos + (30 - h), w, h).fill();
      }
      pdf.restore();
    };

    const drawFakeQRCode = (xPos, yPos, size) => {
      pdf.save();
      pdf.strokeColor('#cbd5e1').lineWidth(1.5).roundedRect(xPos, yPos, size, size, 4).stroke();
      const fillSize = 6;
      pdf.fillColor('#94a3b8');
      pdf.rect(xPos + 3, yPos + 3, fillSize, fillSize).fill();
      pdf.rect(xPos + size - 3 - fillSize, yPos + 3, fillSize, fillSize).fill();
      pdf.rect(xPos + 3, yPos + size - 3 - fillSize, fillSize, fillSize).fill();
      pdf.rect(xPos + size / 2 - 2, yPos + size / 2 - 2, 4, 4).fill();
      pdf.restore();
    };

    // Header
    pdf.font('Helvetica-Bold').fontSize(22).fillColor('#000000').text(brandName, margin, y, { align: 'center', width: contentWidth });
    y = pdf.y + 4;
    pdf.font('Helvetica').fontSize(10).text('HAIR · LIFESTYLE · CARE', { align: 'center', width: contentWidth });
    y = pdf.y + 6;
    if (branchName) {
      pdf.font('Helvetica-Bold').fontSize(11).text(branchName, { align: 'center', width: contentWidth });
      y = pdf.y + 2;
    }
    if (inv.branch?.address) {
      pdf.font('Helvetica').fontSize(10).text(inv.branch.address, { align: 'center', width: contentWidth });
      y = pdf.y + 2;
    }
    if (phone) {
      pdf.font('Helvetica').fontSize(10).text(`Phone: ${phone}`, { align: 'center', width: contentWidth });
      y = pdf.y + 2;
    }

    y += 8;
    drawDashedLine(y);
    y += 8;

    // Meta section
    const leftCol = margin;
    const rightCol = margin + contentWidth / 2 + 10;
    const invDate = new Date(inv.createdAt);
    const dateStr = invDate.toLocaleDateString("en-GB", { day:"2-digit", month:"2-digit", year:"numeric" }).replace(/\//g, "-");
    const timeStr = invDate.toLocaleTimeString("en-US", { hour:"2-digit", minute:"2-digit", hour12: true });
    const statusUp = (inv.status || "UNPAID").toUpperCase();

    const metaRows = [
      ["Invoice No:", inv.invoiceNumber || "—"],
      ["Date:", dateStr],
      ["Time:", timeStr],
      ["Status:", statusUp]
    ];
    metaRows.forEach(([label, value]) => {
      pdf.font('Helvetica').fontSize(11).text(label, leftCol, y, { width: 90 });
      pdf.font('Helvetica-Bold').fontSize(11).text(String(value), rightCol, y, { width: contentWidth / 2 - 10, align: 'right' });
      y += 16;
    });

    y += 4;
    drawDashedLine(y);
    y += 8;

    // Customer
    pdf.font('Helvetica-Bold').fontSize(11).text('BILL TO:', leftCol, y);
    y = pdf.y + 4;
    pdf.font('Helvetica-Bold').fontSize(12).text(inv.customer?.name || "Walk-in Customer", leftCol, y);
    y = pdf.y + 2;
    if (inv.customer?.phone) {
      pdf.font('Helvetica').fontSize(11).text(sanitizeInvoicePhone(inv.customer.phone), leftCol, y);
      y = pdf.y;
    }

    y += 8;
    drawDashedLine(y);
    y += 8;

    // Items
    if (inv.items.length === 0) {
      pdf.font('Helvetica').fontSize(11).text('No items', margin, y, { align: 'center', width: contentWidth });
      y += 16;
    } else {
      pdf.font('Helvetica-Bold').fontSize(10).text('ITEM', margin, y, { width: contentWidth - 90 });
      pdf.font('Helvetica-Bold').fontSize(10).text('AMOUNT', margin + contentWidth - 80, y, { width: 80, align: 'right' });
      y += 14;
      drawDashedLine(y);
      y += 8;

      inv.items.forEach((item) => {
        const rate = Number(item.unitPrice || 0);
        const qty = Number(item.qty || 1);
        const amt = Number(item.lineTotal || rate * qty);
        const itemName = item.serviceName || item.productName || item.name || "Item";

        pdf.font('Helvetica-Bold').fontSize(11).text(itemName, margin, y, { width: contentWidth - 100 });
        const amountBottom = pdf.y;
        pdf.font('Helvetica-Bold').fontSize(11).text(fmt(amt), margin + contentWidth - 100, y, { width: 100, align: 'right' });
        
        y = amountBottom + 2;
        pdf.font('Helvetica').fontSize(10).text(`${qty} x ${fmt(rate)}`, margin, y, { width: contentWidth - 100 });
        y = pdf.y + 2;

        if (item.staffName) {
          pdf.font('Helvetica').fontSize(9).text(`Staff: ${item.staffName}`, margin, y, { width: contentWidth - 100 });
          y = pdf.y + 2;
        }
        
        if (Number(item.appliedBenefitValue) > 0) {
          const discPct = Number(item.unitPrice) > 0 ? ((Number(item.appliedBenefitValue) / Number(item.unitPrice)) * 100).toFixed(1) : "0";
          pdf.font('Helvetica').fontSize(9).text(`Discount: -${discPct}%`, margin, y, { width: contentWidth - 100 });
          y = pdf.y + 2;
        }
        y += 4;
      });
      y += 4;
    }

    drawDashedLine(y);
    y += 8;

    // Totals
    const subtotal = Number(inv.subtotal || inv.total || 0);
    const discount = Number(inv.discount || 0);
    const tax = Number(inv.tax || 0);
    const grandTotal = Number(inv.total || subtotal);
    const paid = Number(inv.paidAmount || 0);
    const balance = Number(inv.balanceAmount || Math.max(0, grandTotal - paid));

    pdf.font('Helvetica-Bold').fontSize(11).text('Subtotal:', margin, y, { width: 150 });
    pdf.font('Helvetica-Bold').fontSize(11).text(fmt(subtotal), margin + contentWidth - 150, y, { width: 150, align: 'right' });
    y += 16;

    if (discount > 0) {
      pdf.font('Helvetica').fontSize(11).text('Discount:', margin, y, { width: 150 });
      pdf.font('Helvetica-Bold').fontSize(11).text('- ' + fmt(discount), margin + contentWidth - 150, y, { width: 150, align: 'right' });
      y += 16;
    }
    if (tax > 0) {
      pdf.font('Helvetica').fontSize(11).text('Tax:', margin, y, { width: 150 });
      pdf.font('Helvetica-Bold').fontSize(11).text('+ ' + fmt(tax), margin + contentWidth - 150, y, { width: 150, align: 'right' });
      y += 16;
    }

    y += 4;
    drawDashedLine(y);
    y += 8;

    pdf.font('Helvetica-Bold').fontSize(14).text('GRAND TOTAL:', margin, y, { width: 150 });
    pdf.font('Helvetica-Bold').fontSize(16).text(fmt(grandTotal), margin + contentWidth - 180, y - 2, { width: 180, align: 'right' });
    y += 24;

    if (paid > 0) {
      y += 4;
      pdf.font('Helvetica-Bold').fontSize(11).text('Paid Amount:', margin, y, { width: 150 });
      pdf.font('Helvetica-Bold').fontSize(11).text(fmt(paid), margin + contentWidth - 150, y, { width: 150, align: 'right' });
      y += 16;
    }
    if (balance > 0) {
      pdf.font('Helvetica-Bold').fontSize(11).text('Balance Due:', margin, y, { width: 150 });
      pdf.font('Helvetica-Bold').fontSize(11).text(fmt(balance), margin + contentWidth - 150, y, { width: 150, align: 'right' });
      y += 16;
    }

    y += 8;
    drawDashedLine(y);
    y += 8;

    pdf.font('Helvetica-Bold').fontSize(14).text('THANK YOU!', margin, y, { align: 'center', width: contentWidth });
    y = pdf.y + 6;
    pdf.font('Helvetica').fontSize(10).text('Please visit again', margin, y, { align: 'center', width: contentWidth });
    y = pdf.y + 12;

    // Draw Fake Barcode
    drawFakeBarcode(y);
    y += 36;

    pdf.font('Courier').fontSize(9).fillColor('#000000').text(inv.invoiceNumber || "—", margin, y, { align: 'center', width: contentWidth });

    pdf.end();
  });

  // ── Advance Payments ──────────────────────────────────────────────────
  ownerRouter.get("/customers/:id/advance-payments", requireSalonPermission("customers", "view"), async (req, res) => {
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    const entries = await prisma.customerTimeline.findMany({
      where: { customerId: req.params.id, eventType: "ADVANCE_PAYMENT" },
      orderBy: { createdAt: "desc" }
    });
    const mapped = entries.map(entry => {
      let extra = {};
      try {
        if (entry.details) {
          extra = JSON.parse(entry.details);
        }
      } catch (e) {}
      return {
        ...entry,
        amount: extra.amount || 0,
        mode: extra.mode || "",
        remark: extra.remark || ""
      };
    });
    res.json(mapped);
  });

  ownerRouter.post("/advance-payments", requireSalonPermission("customers", "edit"), async (req, res) => {
    try {
    const { customerId, amount, mode, remark, branchId } = req.body;
    if (!customerId || !amount || Number(amount) <= 0) {
      return res.status(400).json({ message: "Customer and a positive amount are required" });
    }
    const customer = await prisma.customer.findFirst({ where: { id: customerId, salonId: req.salonId } });
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const numericAmount = Number(amount);
    const rawMode = (mode || "CASH").toUpperCase();
    const validModes = ["CASH", "CARD", "UPI", "BANK_TRANSFER", "WALLET", "ONLINE", "ADVANCE"];
    const paymentMode = validModes.includes(rawMode) ? rawMode : "CASH";

    // Generate unique invoice number
    const dateKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const countToday = await prisma.invoice.count({ where: { salonId: req.salonId, invoiceNumber: { startsWith: `INV-${dateKey}-` } } });
    const invoiceNumber = `INV-${dateKey}-${String(countToday + 1).padStart(4, "0")}`;

    // Create invoice + payment + timeline entry in a single transaction
    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          salonId: req.salonId,
          ...(branchId ? { branchId } : {}),
          customerId,
          invoiceNumber,
          status: "PAID",
          subtotal: numericAmount,
          discount: 0,
          tax: 0,
          total: numericAmount,
          paidAmount: numericAmount,
          balanceAmount: 0,
          notes: remark || "Advance payment",
          items: {
            create: [{
              serviceName: "Advance Payment",
              qty: 1,
              unitPrice: numericAmount,
              taxPct: 0,
              lineTotal: numericAmount,
              itemType: "ADVANCE"
            }]
          },
          payments: {
            create: [{
              salonId: req.salonId,
              amount: numericAmount,
              mode: paymentMode,
              type: "ADVANCE",
              note: remark || "Advance payment"
            }]
          }
        },
        include: { items: true, payments: true, customer: true, branch: true }
      });

      const entry = await tx.customerTimeline.create({
        data: {
          customerId,
          eventType: "ADVANCE_PAYMENT",
          title: `Advance payment of ${numericAmount.toFixed(2)} (${paymentMode})`,
          details: JSON.stringify({ amount: numericAmount, mode: paymentMode, remark: remark || "", invoiceId: invoice.id, invoiceNumber }),
          referenceId: invoice.id
        }
      });

      return { invoice, entry };
    });

    res.status(201).json({ invoice: result.invoice, entry: result.entry });
    } catch (error) {
      console.error("Advance payment error:", error);
      res.status(500).json({ message: error.message || "Failed to add advance payment" });
    }
  });

  ownerRouter.get("/advance-payments", requireSalonPermission("customers", "view"), async (req, res) => {
    const customerIds = await prisma.customer.findMany({
      where: { salonId: req.salonId },
      select: { id: true }
    });
    const ids = customerIds.map(c => c.id);
    const entries = await prisma.customerTimeline.findMany({
      where: { customerId: { in: ids }, eventType: "ADVANCE_PAYMENT" },
      orderBy: { createdAt: "desc" }
    });
    const mapped = entries.map(entry => {
      let extra = {};
      try {
        if (entry.details) {
          extra = JSON.parse(entry.details);
        }
      } catch (e) {}
      return {
        ...entry,
        amount: extra.amount || 0,
        mode: extra.mode || "",
        remark: extra.remark || ""
      };
    });
    res.json(mapped);
  });

  // Customer Packages for POS redemption
  ownerRouter.get("/customers/:id/packages", requireSalonPermission("pos", "view"), async (req, res) => {
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    const packages = await prisma.customerPackage.findMany({
      where: { salonId: req.salonId, customerId: req.params.id },
      include: {
        package: { include: { services: { include: { service: true } } } }
      },
      orderBy: { createdAt: "desc" }
    });
    res.json(packages);
  });

  // Gift Card Validation for POS redemption
  ownerRouter.post("/gift-cards/validate", requireSalonPermission("pos", "view"), async (req, res) => {
    const { code, customerId } = req.body;
    if (!code) return res.status(400).json({ message: "Gift card code is required" });
    const giftCard = await prisma.giftCard.findFirst({
      where: {
        salonId: req.salonId, code: String(code).trim(), isActive: true,
        ...(customerId ? { OR: [{ issuedToCustomerId: customerId }, { issuedToCustomerId: null }] } : {})
      }
    });
    if (!giftCard) return res.status(404).json({ message: "Gift card not found" });
    if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) {
      return res.status(400).json({ message: "Gift card has expired" });
    }
    if (Number(giftCard.balanceAmount || 0) <= 0) {
      return res.status(400).json({ message: "Gift card has no remaining balance" });
    }
    res.json({
      id: giftCard.id,
      code: giftCard.code,
      balanceAmount: giftCard.balanceAmount,
      originalAmount: giftCard.originalAmount,
      expiresAt: giftCard.expiresAt
    });
  });

  // Add Tip to existing invoice
  ownerRouter.post("/invoices/:id/tip", requireSalonPermission("pos", "edit"), async (req, res) => {
    try {
      const { amount, mode, staffId, note } = req.body;
      if (!amount || Number(amount) <= 0) return res.status(400).json({ message: "Tip amount must be greater than zero" });
      const tipNote = staffId ? `staffId:${staffId}|${note || "Tip"}` : (note || "Tip");
      const payment = await addInvoiceTip({
        salonId: req.salonId,
        invoiceId: req.params.id,
        amount: Number(amount),
        mode: mode || "CASH",
        note: tipNote,
        actorUser: req.user
      });
      res.status(201).json(payment);
    } catch (error) {
      const status = error.status || 500;
      res.status(status).json({ message: error.message || "Failed to add tip" });
    }
  });

  // Apply Gift Card to existing invoice
  ownerRouter.post("/invoices/:id/apply-gift-card", requireSalonPermission("pos", "edit"), async (req, res) => {
    const { giftCardCode } = req.body;
    if (!giftCardCode) return res.status(400).json({ message: "Gift card code is required" });
    
    const invoice = await prisma.invoice.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    
    const giftCard = await prisma.giftCard.findFirst({
      where: { salonId: req.salonId, code: String(giftCardCode).trim(), isActive: true }
    });
    if (!giftCard) return res.status(404).json({ message: "Gift card not found" });
    if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) {
      return res.status(400).json({ message: "Gift card has expired" });
    }
    const gcBalance = Number(giftCard.balanceAmount || 0);
    if (gcBalance <= 0) return res.status(400).json({ message: "Gift card has no remaining balance" });
    
    const invoiceBalance = Math.max(0, Number(invoice.total || 0) - Number(invoice.paidAmount || 0));
    const applyAmount = Math.min(gcBalance, invoiceBalance);
    if (applyAmount <= 0) return res.status(400).json({ message: "No balance to apply" });
    
    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          salonId: req.salonId,
          invoiceId: invoice.id,
          amount: applyAmount,
          mode: "WALLET",
          note: `Gift card ${giftCardCode}`,
          type: "PAYMENT"
        }
      });
      
      const nextPaid = Number(invoice.paidAmount || 0) + applyAmount;
      const nextBalance = Math.max(0, Number(invoice.total || 0) - nextPaid);
      const nextStatus = nextPaid >= Number(invoice.total || 0) ? "PAID" : nextPaid > 0 ? "PARTIAL" : "UNPAID";
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { paidAmount: nextPaid, balanceAmount: nextBalance, status: nextStatus }
      });
      
      const newGcBalance = gcBalance - applyAmount;
      await tx.giftCard.update({
        where: { id: giftCard.id },
        data: { balanceAmount: newGcBalance, isActive: newGcBalance > 0 }
      });
      
      await tx.giftCardRedemption.create({
        data: {
          salonId: req.salonId,
          giftCardId: giftCard.id,
          customerId: invoice.customerId,
          invoiceId: invoice.id,
          amountUsed: applyAmount
        }
      });
      
      return { payment, applyAmount, newGcBalance };
    });
    
    res.json(result);
  });

};



