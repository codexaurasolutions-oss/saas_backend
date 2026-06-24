import { prisma } from "../../../lib/prisma.js";
import { getNotificationToggles } from "../../../lib/emailAutomation.js";
import { convertOrderToInvoice, createOnlineOrder, reverseOrderStock } from "../../../lib/phase3.js";
import { createStaffNotification } from "../../../lib/phase4.js";
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
  ownerRouter.get("/ecommerce/products", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "view"), async (req, res) => {
    res.json(await prisma.product.findMany({
      where: { salonId: req.salonId, isActive: true },
      include: { category: true, branch: true },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.patch("/ecommerce/products/:id/visibility", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "edit"), validate(schemas.onlineVisibility), async (req, res) => {
    const row = await prisma.product.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Product not found" });
    res.json(await prisma.product.update({ where: { id: row.id }, data: { isOnlineVisible: req.body.isOnlineVisible } }));
  });

  ownerRouter.get("/ecommerce/settings", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "view"), async (req, res) => {
    res.json(await prisma.ecommerceSetting.findUnique({ where: { salonId: req.salonId } }));
  });
  ownerRouter.post("/ecommerce/settings", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "edit"), validate(schemas.ecommerceSettings), async (req, res) => {
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
  });
  ownerRouter.get("/ecommerce/preview", requireFeatureEnabled("ecommerce"), requireSalonPermission("ecommerce", "view"), async (req, res) => {
    const salon = await prisma.salon.findUnique({ where: { id: req.salonId } });
    const products = await prisma.product.findMany({
      where: { salonId: req.salonId, isActive: true, isOnlineVisible: true },
      include: { category: true, branch: true },
      orderBy: { createdAt: "desc" }
    });
    res.json({ slug: salon.slug, products });
  });

  ownerRouter.get("/orders", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "view"), async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    res.json(await prisma.onlineOrder.findMany({
      where: { salonId: req.salonId, ...(status ? { status } : {}) },
      include: includeOrder,
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.get("/orders/reports/summary", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "view"), async (req, res) => {
    const rows = await prisma.onlineOrder.findMany({ where: { salonId: req.salonId }, include: { items: true } });
    res.json({
      totalOrders: rows.length,
      newOrders: rows.filter((row) => row.status === "NEW").length,
      completedOrders: rows.filter((row) => row.status === "COMPLETED").length,
      cancelledOrders: rows.filter((row) => row.status === "CANCELLED").length,
      totalSales: rows.filter((row) => row.status !== "CANCELLED").reduce((sum, row) => sum + Number(row.total || 0), 0)
    });
  });
  ownerRouter.get("/orders/:id", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "view"), async (req, res) => {
    const row = await prisma.onlineOrder.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: includeOrder });
    if (!row) return res.status(404).json({ message: "Order not found" });
    res.json(row);
  });
  ownerRouter.patch("/orders/:id/status", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "edit"), validate(schemas.orderStatus), async (req, res) => {
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
      await tx.onlineOrderStatusLog.create({
        data: {
          orderId: row.id,
          actorName: req.user.name,
          fromStatus: row.status,
          toStatus: req.body.status,
          note: req.body.note || null
        }
      });

      // Customer in-app notification — gated by toggle
      const { isOn } = await getNotificationToggles(req.salonId).catch(() => ({ isOn: () => true }));
      const toggleKey = req.body.status === "CONFIRMED" ? "orderConfirmed"
        : req.body.status === "CANCELLED" ? "orderRejected"
        : "messageForOrders";

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

      // Staff in-app notification for new/confirmed orders
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

      return tx.onlineOrder.findUnique({ where: { id: row.id }, include: includeOrder });
    });
    res.json(updated);
  });
  ownerRouter.patch("/orders/:id/cancel", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "edit"), validate(schemas.appointmentNote), async (req, res) => {
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

      // Owner in-app notification
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
  });
  ownerRouter.post("/orders/:id/convert-to-invoice", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "edit"), async (req, res) => {
    res.status(201).json(await convertOrderToInvoice({ salonId: req.salonId, orderId: req.params.id, actorUser: req.user }));
  });

  ownerRouter.post("/orders", requireFeatureEnabled("onlineOrders"), requireSalonPermission("orders", "create"), validate(schemas.createOrder), async (req, res) => {
    res.status(201).json(await createOnlineOrder({ salonId: req.salonId, body: req.body, actorName: req.user.name, source: "OWNER_PANEL" }));
  });
};
