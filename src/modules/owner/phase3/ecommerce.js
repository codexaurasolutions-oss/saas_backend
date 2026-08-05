import { prisma } from "../../../lib/prisma.js";
import { asyncHandler } from "../../../lib/async-handler.js";
import { getNotificationToggles } from "../../../lib/emailAutomation.js";
import { attemptCustomerTemplateEmail, attemptCustomerTemplateWhatsApp } from "../../../lib/emailNotifications.js";
import { convertOrderToInvoice, createOnlineOrder, reverseOrderStock } from "../../../lib/phase3.js";
import { createCustomerNotification, createStaffNotification } from "../../../lib/phase4.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const includeOrder = {
  customer: true,
  branch: true,
  items: { include: { product: true } },
  logs: { orderBy: { createdAt: "asc" } },
  invoice: true
};

export const registerEcommerceRoutes = (ownerRouter) => {
  ownerRouter.get("/ecommerce/products", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "view"), asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const where = { salonId: req.salonId, isActive: true };
    const [rows, total] = await Promise.all([
      prisma.product.findMany({ where, include: { category: true, branch: true }, orderBy: { createdAt: "desc" }, skip, take: limit }),
      prisma.product.count({ where })
    ]);
    res.json({ products: rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  }));

  ownerRouter.patch("/ecommerce/products/:id/visibility", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "edit"), validate(schemas.onlineVisibility), asyncHandler(async (req, res) => {
    const row = await prisma.product.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Product not found" });
    res.json(await prisma.product.update({ where: { id: row.id }, data: { isOnlineVisible: req.body.isOnlineVisible } }));
  }));

  ownerRouter.get("/ecommerce/services", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "view"), asyncHandler(async (req, res) => {
    res.json(await prisma.service.findMany({
      where: { salonId: req.salonId, isActive: true },
      include: { category: true, staffAssignments: { include: { user: { select: { id: true, name: true } } } } },
      orderBy: { position: "asc" }
    }));
  }));

  ownerRouter.patch("/ecommerce/services/:id/website-visibility", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "edit"), asyncHandler(async (req, res) => {
    const row = await prisma.service.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Service not found" });
    res.json(await prisma.service.update({ where: { id: row.id }, data: { showOnWebsite: req.body.showOnWebsite === true } }));
  }));

  ownerRouter.get("/ecommerce/settings", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "view"), asyncHandler(async (req, res) => {
    res.json(await prisma.ecommerceSetting.findUnique({ where: { salonId: req.salonId } }));
  }));
  ownerRouter.post("/ecommerce/settings", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "edit"), validate(schemas.ecommerceSettings), asyncHandler(async (req, res) => {
    const existing = await prisma.ecommerceSetting.findUnique({ where: { salonId: req.salonId } });
    const payload = {
      storeEnabled: req.body.storeEnabled ?? false,
      allowCod: req.body.allowCod ?? true,
      allowPayAtSalon: req.body.allowPayAtSalon ?? true,
      allowOnlinePayment: req.body.allowOnlinePayment ?? false,
      pickupEnabled: req.body.pickupEnabled ?? true,
      deliveryEnabled: req.body.deliveryEnabled ?? false,
      deliveryNote: req.body.deliveryNote || null,
      supportPhone: req.body.supportPhone || null,
      termsText: req.body.termsText || null
    };
    const row = existing
      ? await prisma.ecommerceSetting.update({ where: { id: existing.id }, data: payload })
      : await prisma.ecommerceSetting.create({ data: { salonId: req.salonId, ...payload } });
    res.status(201).json(row);
  }));
  ownerRouter.get("/ecommerce/preview", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "view"), asyncHandler(async (req, res) => {
    const salon = await prisma.salon.findUnique({ where: { id: req.salonId } });
    if (!salon) return res.status(404).json({ message: "Salon not found" });
    const products = await prisma.product.findMany({
      where: { salonId: req.salonId, isActive: true, isOnlineVisible: true },
      include: { category: true, branch: true },
      orderBy: { createdAt: "desc" }
    });
    const services = await prisma.service.findMany({
      where: { salonId: req.salonId, isActive: true, showOnWebsite: true },
      include: { category: true },
      orderBy: { position: "asc" }
    });
    res.json({ slug: salon.slug, products, services });
  }));

  ownerRouter.get("/orders", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "view"), asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const where = { salonId: req.salonId, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      prisma.onlineOrder.findMany({ where, include: includeOrder, orderBy: { createdAt: "desc" }, skip, take: limit }),
      prisma.onlineOrder.count({ where })
    ]);
    res.json({ orders: rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  }));
  ownerRouter.get("/orders/reports/summary", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "view"), asyncHandler(async (req, res) => {
    const [statusCounts, salesAgg] = await Promise.all([
      prisma.onlineOrder.groupBy({
        by: ["status"],
        where: { salonId: req.salonId },
        _count: true
      }),
      prisma.onlineOrder.aggregate({
        where: { salonId: req.salonId, status: { not: "CANCELLED" } },
        _sum: { total: true }
      })
    ]);
    const counts = Object.fromEntries(statusCounts.map(r => [r.status, r._count]));
    res.json({
      totalOrders: statusCounts.reduce((s, r) => s + r._count, 0),
      newOrders: counts.NEW || 0,
      completedOrders: counts.COMPLETED || 0,
      cancelledOrders: counts.CANCELLED || 0,
      totalSales: Number(salesAgg._sum?.total || 0)
    });
  }));
  ownerRouter.get("/orders/:id", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "view"), asyncHandler(async (req, res) => {
    const row = await prisma.onlineOrder.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: includeOrder });
    if (!row) return res.status(404).json({ message: "Order not found" });
    res.json(row);
  }));
  ownerRouter.patch("/orders/:id/status", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "edit"), validate(schemas.orderStatus), asyncHandler(async (req, res) => {
    const row = await prisma.onlineOrder.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { items: true } });
    if (!row) return res.status(404).json({ message: "Order not found" });
    if (row.status === "CANCELLED") return res.status(400).json({ message: "Cancelled order cannot change status" });

    const updated = await prisma.$transaction(async (tx) => {
      const order = await tx.onlineOrder.update({
        where: { id: row.id },
        data: {
          status: req.body.status,
          paymentStatus: req.body.paymentStatus || row.paymentStatus,
          completedAt: req.body.status === "COMPLETED" ? new Date() : row.completedAt
        }
      });
      if (row.status !== req.body.status) {
        await tx.onlineOrderStatusLog.create({
          data: {
            orderId: row.id,
            actorName: req.user.name,
            fromStatus: row.status,
            toStatus: req.body.status,
            note: req.body.note || null
          }
        });
      }

      const { isOn, emailEnabled, whatsappEnabled } = await getNotificationToggles(req.salonId).catch(() => ({ isOn: () => true, emailEnabled: true, whatsappEnabled: false }));
      const toggleKey = req.body.status === "CONFIRMED" ? "orderConfirmed"
        : req.body.status === "CANCELLED" ? "orderRejected"
        : "messageForOrders";
      const customer = row.customerId
        ? await tx.customer.findUnique({ where: { id: row.customerId }, select: { email: true, phone: true } })
        : null;

      if (row.customerId && isOn("messageForOrders") && isOn(toggleKey)) {
        await tx.customerNotification.create({
          data: {
            salonId: req.salonId,
            customerId: row.customerId,
            title: `Order ${order.orderNumber} updated`,
            message: `Order status is now ${req.body.status}.`,
            linkUrl: `/customer/orders/${row.id}`
          }
        });
      }

      if (isOn("orderPlacedToStaff") && ["CONFIRMED", "PROCESSING"].includes(req.body.status)) {
        await createStaffNotification({
          salonId: req.salonId,
          userSalonId: null,
          title: `Order ${order.orderNumber} ${req.body.status}`,
          message: `An order has been ${req.body.status.toLowerCase()}.`,
          type: "ORDER",
          linkUrl: `/admin/orders/${row.id}`
        }).catch(() => {});
      }

      if (row.customerId && order.invoiceId && isOn("messageForOrders") && isOn("orderInvoiceLink")) {
        await createCustomerNotification({
          salonId: req.salonId,
          customerId: row.customerId,
          title: `Invoice ready for ${order.orderNumber}`,
          message: "Your order invoice is ready to view.",
          linkUrl: `/customer/invoices/${order.invoiceId}`
        }).catch(() => {});
        if (emailEnabled && customer?.email) {
          await attemptCustomerTemplateEmail({
            salonId: req.salonId,
            toEmail: customer.email,
            templateType: "invoice_template",
            context: { invoiceId: order.invoiceId, customerId: row.customerId }
          }).catch(() => {});
        }
        if (whatsappEnabled && customer?.phone) {
          await attemptCustomerTemplateWhatsApp({
            salonId: req.salonId,
            toPhone: customer.phone,
            templateType: "invoice_template",
            context: { invoiceId: order.invoiceId, customerId: row.customerId },
            customerId: row.customerId
          }).catch(() => {});
        }
      }

      if (row.customerId && req.body.status === "COMPLETED" && isOn("messageForOrders") && isOn("orderFeedbackLink")) {
        await createCustomerNotification({
          salonId: req.salonId,
          customerId: row.customerId,
          title: `How was order ${order.orderNumber}?`,
          message: "Your order is complete. Please share your feedback.",
          linkUrl: `/customer/orders/${row.id}`
        }).catch(() => {});
        if (emailEnabled && customer?.email) {
          await attemptCustomerTemplateEmail({
            salonId: req.salonId,
            toEmail: customer.email,
            templateType: "feedback_request_template",
            context: { customerId: row.customerId }
          }).catch(() => {});
        }
        if (whatsappEnabled && customer?.phone) {
          await attemptCustomerTemplateWhatsApp({
            salonId: req.salonId,
            toPhone: customer.phone,
            templateType: "feedback_request_template",
            context: { customerId: row.customerId },
            customerId: row.customerId
          }).catch(() => {});
        }
      }

      return tx.onlineOrder.findUnique({ where: { id: row.id }, include: includeOrder });
    });
    res.json(updated);
  }));
  ownerRouter.patch("/orders/:id/cancel", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "edit"), validate(schemas.appointmentNote), asyncHandler(async (req, res) => {
    const row = await prisma.onlineOrder.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { items: true } });
    if (!row) return res.status(404).json({ message: "Order not found" });
    if (row.status === "CANCELLED") return res.status(400).json({ message: "Order already cancelled" });

    const updated = await prisma.$transaction(async (tx) => {
      if (row.stockDeductedAt) {
        await reverseOrderStock(tx, row, req.user.name, req.body.note || "Order cancelled");
      }
      const order = await tx.onlineOrder.update({
        where: { id: row.id },
        data: {
          status: "CANCELLED",
          cancelledAt: new Date()
        }
      });

      const { isOn } = await getNotificationToggles(req.salonId).catch(() => ({ isOn: () => true }));

      if (row.customerId && isOn("messageForOrders") && isOn("orderRejected")) {
        await tx.customerNotification.create({
          data: {
            salonId: req.salonId,
            customerId: row.customerId,
            title: `Order ${order.orderNumber} cancelled`,
            message: req.body.note || "Your order was cancelled.",
            linkUrl: `/customer/orders/${row.id}`
          }
        });
      }

      if (isOn("orderRejected")) {
        await createStaffNotification({
          salonId: req.salonId,
          userSalonId: null,
          title: `Order ${order.orderNumber} Cancelled`,
          message: req.body.note || "An order has been cancelled.",
          type: "ORDER",
          linkUrl: `/admin/orders/${row.id}`
        }).catch(() => {});
      }

      return tx.onlineOrder.findUnique({ where: { id: row.id }, include: includeOrder });
    });
    res.json(updated);
  }));
  ownerRouter.post("/orders/:id/convert-to-invoice", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "edit"), asyncHandler(async (req, res) => {
    const invoice = await convertOrderToInvoice({ salonId: req.salonId, orderId: req.params.id, actorUser: req.user });
    const { isOn, emailEnabled, whatsappEnabled } = await getNotificationToggles(req.salonId, invoice.branchId || null).catch(() => ({ isOn: () => true, emailEnabled: true, whatsappEnabled: false }));
    if (invoice.customerId && isOn("messageForOrders") && isOn("orderInvoiceLink")) {
      await createCustomerNotification({
        salonId: req.salonId,
        customerId: invoice.customerId,
        title: `Invoice ${invoice.invoiceNumber} ready`,
        message: "Your online order invoice is ready to view.",
        linkUrl: `/customer/invoices/${invoice.id}`
      }).catch(() => {});
      if (emailEnabled && invoice.customer?.email) {
        await attemptCustomerTemplateEmail({
          salonId: req.salonId,
          toEmail: invoice.customer.email,
          templateType: "invoice_template",
          context: { invoiceId: invoice.id, customerId: invoice.customerId }
        }).catch(() => {});
      }
      if (whatsappEnabled && invoice.customer?.phone) {
        await attemptCustomerTemplateWhatsApp({
          salonId: req.salonId,
          toPhone: invoice.customer.phone,
          templateType: "invoice_template",
          context: { invoiceId: invoice.id, customerId: invoice.customerId },
          customerId: invoice.customerId,
          branchId: invoice.branchId
        }).catch(() => {});
      }
    }
    res.status(201).json(invoice);
  }));

  ownerRouter.post("/orders", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "create"), validate(schemas.createOrder), asyncHandler(async (req, res) => {
    const order = await createOnlineOrder({ salonId: req.salonId, body: req.body, actorName: req.user.name, source: "OWNER_PANEL" });
    const { isOn } = await getNotificationToggles(req.salonId, order.branchId || null).catch(() => ({ isOn: () => true }));
    if ((order.couponCode || order.giftCardCode) && isOn("onlineRedeemablePurchaseToOwner")) {
      await createStaffNotification({
        salonId: req.salonId,
        userSalonId: null,
        title: "Online redeemable purchase",
        message: `Order ${order.orderNumber} used ${order.couponCode ? `coupon ${order.couponCode}` : `gift card ${order.giftCardCode}`}.`,
        type: "ORDER",
        linkUrl: `/admin/orders/${order.id}`
      }).catch(() => {});
    }
    res.status(201).json(order);
  }));
};
