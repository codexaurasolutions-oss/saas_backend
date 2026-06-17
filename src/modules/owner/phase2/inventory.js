import { prisma } from "../../../lib/prisma.js";
import { attachBranchStock, createStockMovement, normalizeBranchId, toAmount } from "../../../lib/phase2.js";
import { attachSalonSettings, requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";
import { nextNumber } from "./shared.js";

export const registerInventoryRoutes = (ownerRouter) => {
  ownerRouter.get("/inventory/categories", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "view"), async (req, res) => {
    res.json(await prisma.productCategory.findMany({
      where: { salonId: req.salonId, isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
    }));
  });

  ownerRouter.post("/inventory/categories", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "create"), validate(schemas.productCategory), async (req, res) => {
    res.status(201).json(await prisma.productCategory.create({
      data: {
        salonId: req.salonId,
        name: req.body.name,
        description: req.body.description || null,
        imageUrl: req.body.imageUrl || null,
        sortOrder: req.body.sortOrder || 0,
        isPublicVisible: req.body.isPublicVisible !== false
      }
    }));
  });

  ownerRouter.patch("/inventory/categories/:id", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "edit"), validate(schemas.productCategory), async (req, res) => {
    const category = await prisma.productCategory.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!category) return res.status(404).json({ message: "Category not found" });
    res.json(await prisma.productCategory.update({
      where: { id: category.id },
      data: {
        name: req.body.name,
        description: req.body.description || null,
        imageUrl: req.body.imageUrl || null,
        sortOrder: req.body.sortOrder || 0,
        isPublicVisible: req.body.isPublicVisible !== false
      }
    }));
  });

  ownerRouter.patch("/inventory/categories/:id/archive", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "delete"), async (req, res) => {
    const category = await prisma.productCategory.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!category) return res.status(404).json({ message: "Category not found" });
    res.json(await prisma.productCategory.update({ where: { id: category.id }, data: { isActive: false } }));
  });

  ownerRouter.get("/inventory/products", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const q = req.query.q ? String(req.query.q).trim() : "";
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : null;
    const productType = req.query.productType ? String(req.query.productType) : null;
    const rows = await prisma.product.findMany({
      where: {
        salonId: req.salonId,
        isActive: true,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }, { stockMovements: { some: { branchId } } }] } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(productType ? { productType } : {}),
        ...(q ? {
          OR: [
            { name: { contains: q } },
            { sku: { contains: q } },
            { barcode: { contains: q } }
          ]
        } : {})
      },
      include: { category: true, branch: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(await attachBranchStock(prisma, rows, branchId));
  });

  ownerRouter.post("/inventory/products", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "create"), async (req, res) => {
    res.status(201).json(await prisma.product.create({
      data: {
        salonId: req.salonId,
        branchId: req.body.branchId || null,
        categoryId: req.body.categoryId || null,
        name: req.body.name,
        imageUrl: req.body.imageUrl || null,
        sku: req.body.sku || null,
        barcode: req.body.barcode || null,
        productType: req.body.productType || "RETAIL",
        costPrice: req.body.costPrice || 0,
        sellingPrice: req.body.sellingPrice || 0,
        salePrice: req.body.salePrice || null,
        minStock: req.body.minStock || 0,
        expiryDate: req.body.expiryDate ? new Date(req.body.expiryDate) : null,
        allowNegativeStock: Boolean(req.body.allowNegativeStock),
        position: req.body.position || 0,
        targetGroup: req.body.targetGroup || "BOTH",
        hideFromCatalogue: Boolean(req.body.hideFromCatalogue),
        nonDiscountable: Boolean(req.body.nonDiscountable),
        description: req.body.description || null,
        videoLink: req.body.videoLink || null,
        benefits: req.body.benefits || null,
        variations: req.body.variations || null
      }
    }));
  });

  ownerRouter.patch("/inventory/products/:id", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "edit"), async (req, res) => {
    const product = await prisma.product.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(await prisma.product.update({
      where: { id: product.id },
      data: {
        branchId: req.body.branchId !== undefined ? req.body.branchId : product.branchId,
        categoryId: req.body.categoryId !== undefined ? req.body.categoryId : product.categoryId,
        name: req.body.name || product.name,
        imageUrl: req.body.imageUrl !== undefined ? req.body.imageUrl : product.imageUrl,
        sku: req.body.sku !== undefined ? req.body.sku : product.sku,
        barcode: req.body.barcode !== undefined ? req.body.barcode : product.barcode,
        productType: req.body.productType || product.productType,
        costPrice: req.body.costPrice !== undefined ? req.body.costPrice : product.costPrice,
        sellingPrice: req.body.sellingPrice !== undefined ? req.body.sellingPrice : product.sellingPrice,
        salePrice: req.body.salePrice !== undefined ? req.body.salePrice : product.salePrice,
        minStock: req.body.minStock !== undefined ? req.body.minStock : product.minStock,
        expiryDate: req.body.expiryDate !== undefined ? (req.body.expiryDate ? new Date(req.body.expiryDate) : null) : product.expiryDate,
        allowNegativeStock: req.body.allowNegativeStock !== undefined ? Boolean(req.body.allowNegativeStock) : product.allowNegativeStock,
        position: req.body.position !== undefined ? req.body.position : product.position,
        targetGroup: req.body.targetGroup || product.targetGroup,
        hideFromCatalogue: req.body.hideFromCatalogue !== undefined ? Boolean(req.body.hideFromCatalogue) : product.hideFromCatalogue,
        nonDiscountable: req.body.nonDiscountable !== undefined ? Boolean(req.body.nonDiscountable) : product.nonDiscountable,
        description: req.body.description !== undefined ? req.body.description : product.description,
        videoLink: req.body.videoLink !== undefined ? req.body.videoLink : product.videoLink,
        benefits: req.body.benefits !== undefined ? req.body.benefits : product.benefits,
        variations: req.body.variations !== undefined ? req.body.variations : product.variations
      }
    }));
  });

  ownerRouter.patch("/inventory/products/:id/archive", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "delete"), async (req, res) => {
    const product = await prisma.product.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!product) return res.status(404).json({ message: "Product not found" });
    res.json(await prisma.product.update({ where: { id: product.id }, data: { isActive: false } }));
  });

  ownerRouter.post("/inventory/stock-movements", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "edit"), attachSalonSettings, validate(schemas.stockMovement), async (req, res) => {
    if (req.body.movementType === "CONSUMABLE_USAGE" && req.advancedSettings?.allowEditConsumable === false) {
      return res.status(403).json({ message: "Consumable editing is restricted by salon settings" });
    }
    const sign = ["STOCK_OUT", "CONSUMABLE_USAGE"].includes(req.body.movementType) ? -1 : 1;
    const movement = await prisma.$transaction((tx) => createStockMovement(tx, {
      salonId: req.salonId,
      branchId: req.body.branchId || null,
      productId: req.body.productId,
      quantity: sign * req.body.quantity,
      movementType: req.body.movementType,
      createdByUserId: req.user.id,
      note: req.body.note || null
    }));
    res.status(201).json(movement);
  });

  ownerRouter.get("/inventory/stock-movements", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const productId = req.query.productId ? String(req.query.productId) : null;
    const movementType = req.query.movementType ? String(req.query.movementType) : null;
    res.json(await prisma.stockMovement.findMany({
      where: {
        salonId: req.salonId,
        ...(branchId ? { branchId } : {}),
        ...(productId ? { productId } : {}),
        ...(movementType ? { movementType } : {})
      },
      include: { product: true },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.get("/inventory/low-stock", requireFeatureEnabled("inventory"), requireSalonPermission("inventory", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const q = req.query.q ? String(req.query.q).trim() : "";
    const categoryId = req.query.categoryId ? String(req.query.categoryId) : null;
    const rows = await prisma.product.findMany({
      where: {
        salonId: req.salonId,
        isActive: true,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }, { stockMovements: { some: { branchId } } }] } : {}),
        ...(categoryId ? { categoryId } : {}),
        ...(q ? {
          OR: [
            { name: { contains: q } },
            { sku: { contains: q } },
            { barcode: { contains: q } }
          ]
        } : {})
      },
      include: { category: true, branch: true }
    });
    const scopedRows = await attachBranchStock(prisma, rows, branchId);
    res.json(scopedRows.filter((item) => toAmount(item.currentStock) <= toAmount(item.minStock)));
  });

  ownerRouter.get("/purchases/vendors", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "view"), async (req, res) => {
    res.json(await prisma.vendor.findMany({
      where: { salonId: req.salonId },
      orderBy: { createdAt: "desc" },
      include: {
        items: {
          where: { isActive: true },
          include: { product: { select: { id: true, name: true } } }
        }
      }
    }));
  });

  ownerRouter.get("/purchases/vendors/:id", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "view"), async (req, res) => {
    const vendor = await prisma.vendor.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: {
        items: {
          include: { product: { select: { id: true, name: true } } }
        }
      }
    });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    res.json(vendor);
  });

  ownerRouter.post("/purchases/vendors", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "create"), validate(schemas.vendor), async (req, res) => {
    res.status(201).json(await prisma.vendor.create({ data: { salonId: req.salonId, ...req.body, branchId: req.body.branchId || null } }));
  });

  ownerRouter.patch("/purchases/vendors/:id", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "edit"), validate(schemas.vendor), async (req, res) => {
    const vendor = await prisma.vendor.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    res.json(await prisma.vendor.update({
      where: { id: vendor.id },
      data: { ...req.body, branchId: req.body.branchId || null }
    }));
  });

  ownerRouter.get("/purchases/vendors/:id/items", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "view"), async (req, res) => {
    const items = await prisma.vendorItem.findMany({
      where: { vendorId: req.params.id, salonId: req.salonId },
      include: { product: { select: { id: true, name: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json(items);
  });

  ownerRouter.post("/purchases/vendors/:id/items", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "edit"), validate(schemas.vendorItem), async (req, res) => {
    const vendor = await prisma.vendor.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!vendor) return res.status(404).json({ message: "Vendor not found" });
    const product = await prisma.product.findFirst({ where: { id: req.body.productId, salonId: req.salonId } });
    if (!product) return res.status(404).json({ message: "Product not found" });
    const existing = await prisma.vendorItem.findFirst({ where: { vendorId: vendor.id, productId: product.id } });
    if (existing) {
      res.json(await prisma.vendorItem.update({
        where: { id: existing.id },
        data: { price: req.body.price, isActive: req.body.isActive ?? true }
      }));
    } else {
      res.status(201).json(await prisma.vendorItem.create({
        data: { salonId: req.salonId, vendorId: vendor.id, productId: product.id, price: req.body.price, isActive: req.body.isActive ?? true }
      }));
    }
  });

  ownerRouter.patch("/purchases/vendor-items/:itemId", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "edit"), async (req, res) => {
    const item = await prisma.vendorItem.findFirst({ where: { id: req.params.itemId, salonId: req.salonId } });
    if (!item) return res.status(404).json({ message: "Vendor item not found" });
    res.json(await prisma.vendorItem.update({
      where: { id: item.id },
      data: { ...req.body }
    }));
  });

  ownerRouter.delete("/purchases/vendor-items/:itemId", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "delete"), async (req, res) => {
    const item = await prisma.vendorItem.findFirst({ where: { id: req.params.itemId, salonId: req.salonId } });
    if (!item) return res.status(404).json({ message: "Vendor item not found" });
    await prisma.vendorItem.delete({ where: { id: item.id } });
    res.json({ message: "Vendor item deleted" });
  });

  ownerRouter.get("/purchases/orders", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "view"), async (req, res) => {
    res.json(await prisma.purchaseOrder.findMany({
      where: { salonId: req.salonId },
      include: { vendor: true, branch: true, items: { include: { product: true } } },
      orderBy: { orderedAt: "desc" }
    }));
  });

  ownerRouter.post("/purchases/orders", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "create"), attachSalonSettings, validate(schemas.purchaseOrder), async (req, res) => {
    const allowPOPriceEdit = req.advancedSettings?.allowPOPriceEdit !== false;

    if (!allowPOPriceEdit) {
      for (const item of req.body.items) {
        const product = await prisma.product.findFirst({ where: { id: item.productId, salonId: req.salonId } });
        if (product && toAmount(item.unitCost) !== toAmount(product.costPrice)) {
          return res.status(400).json({ message: "Price edits in PO drafts are restricted by salon settings" });
        }
      }
    }

    const order = await prisma.$transaction(async (tx) => {
      const orderNumber = await nextNumber(tx, "purchaseOrder", req.salonId, "PO");
      const totalCost = req.body.items.reduce((sum, item) => sum + toAmount(item.unitCost) * toAmount(item.quantityOrdered), 0);
      return tx.purchaseOrder.create({
        data: {
          salonId: req.salonId,
          branchId: req.body.branchId,
          vendorId: req.body.vendorId,
          createdByUserId: req.user.id,
          orderNumber,
          notes: req.body.notes || null,
          status: "DRAFT",
          totalCost,
          items: {
            create: req.body.items.map((item) => ({
              productId: item.productId,
              quantityOrdered: item.quantityOrdered,
              unitCost: item.unitCost,
              expiryDate: item.expiryDate ? new Date(item.expiryDate) : null
            }))
          }
        },
        include: { items: true }
      });
    });
    res.status(201).json(order);
  });

  ownerRouter.patch("/purchases/orders/:id/approve", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "approve"), async (req, res) => {
    const order = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!order) return res.status(404).json({ message: "Purchase order not found" });
    if (order.status !== "DRAFT") return res.status(400).json({ message: "Only DRAFT orders can be approved" });
    res.json(await prisma.purchaseOrder.update({ where: { id: order.id }, data: { status: "ORDERED" } }));
  });

  ownerRouter.patch("/purchases/orders/:id/reject", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "approve"), async (req, res) => {
    const order = await prisma.purchaseOrder.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!order) return res.status(404).json({ message: "Purchase order not found" });
    if (order.status !== "DRAFT") return res.status(400).json({ message: "Only DRAFT orders can be rejected" });
    res.json(await prisma.purchaseOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } }));
  });

  ownerRouter.post("/purchases/orders/:id/receive", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "edit"), attachSalonSettings, validate(schemas.purchaseReceive), async (req, res) => {
    const order = await prisma.purchaseOrder.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { items: true }
    });
    if (!order) return res.status(404).json({ message: "Purchase order not found" });

    const allowPriceEditWhilePOSettlement = req.advancedSettings?.allowPriceEditWhilePOSettlement !== false;
    if (!allowPriceEditWhilePOSettlement) {
      for (const item of req.body.items) {
        if (item.unitCost != null) {
          const orderItem = order.items.find((entry) => entry.id === item.purchaseOrderItemId);
          if (orderItem && toAmount(item.unitCost) !== toAmount(orderItem.unitCost)) {
            return res.status(400).json({ message: "Price edits during PO settlement are restricted by salon settings" });
          }
        }
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      for (const item of req.body.items) {
        const orderItem = order.items.find((entry) => entry.id === item.purchaseOrderItemId);
        if (!orderItem) throw new Error("Invalid purchase order item");
        const nextReceived = toAmount(orderItem.quantityReceived) + toAmount(item.quantityReceived);
        await tx.purchaseOrderItem.update({ 
          where: { id: orderItem.id }, 
          data: { 
            quantityReceived: nextReceived,
            ...(item.unitCost != null ? { unitCost: item.unitCost } : {})
          } 
        });
        await createStockMovement(tx, {
          salonId: req.salonId,
          branchId: order.branchId,
          productId: orderItem.productId,
          quantity: item.quantityReceived,
          movementType: "PURCHASE_RECEIVED",
          createdByUserId: req.user.id,
          referenceType: "PURCHASE_ORDER",
          referenceId: order.id
        });
      }
      const freshItems = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: order.id } });
      const allReceived = freshItems.every((item) => toAmount(item.quantityReceived) >= toAmount(item.quantityOrdered));
      return tx.purchaseOrder.update({
        where: { id: order.id },
        data: { status: allReceived ? "RECEIVED" : "PARTIALLY_RECEIVED", receivedAt: new Date() },
        include: { items: true, vendor: true, branch: true }
      });
    });
    res.json(updated);
  });

  ownerRouter.post("/purchases/transfers", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "create"), validate(schemas.stockTransfer), async (req, res) => {
    if (req.body.fromBranchId === req.body.toBranchId) {
      return res.status(400).json({ message: "Destination branch must be different from the source branch" });
    }
    const transfer = await prisma.$transaction(async (tx) => {
      const created = await tx.stockTransfer.create({
        data: {
          salonId: req.salonId,
          fromBranchId: req.body.fromBranchId,
          toBranchId: req.body.toBranchId,
          createdByUserId: req.user.id,
          note: req.body.note || null,
          items: { create: req.body.items }
        },
        include: { items: true }
      });
      for (const item of req.body.items) {
        await createStockMovement(tx, {
          salonId: req.salonId,
          branchId: req.body.fromBranchId,
          productId: item.productId,
          quantity: -item.quantity,
          movementType: "TRANSFER_OUT",
          createdByUserId: req.user.id,
          referenceType: "TRANSFER",
          referenceId: created.id
        });
        await createStockMovement(tx, {
          salonId: req.salonId,
          branchId: req.body.toBranchId,
          productId: item.productId,
          quantity: item.quantity,
          movementType: "TRANSFER_IN",
          createdByUserId: req.user.id,
          referenceType: "TRANSFER",
          referenceId: created.id
        });
      }
      return created;
    });
    res.status(201).json(transfer);
  });

  ownerRouter.post("/purchases/reconciliation", requireFeatureEnabled("inventory"), requireSalonPermission("purchases", "edit"), validate(schemas.stockReconciliation), async (req, res) => {
    const result = await prisma.$transaction(async (tx) => {
      const reconciliation = await tx.stockReconciliation.create({
        data: { salonId: req.salonId, branchId: req.body.branchId, note: req.body.note || null }
      });
      for (const item of req.body.items) {
        const product = await tx.product.findFirst({ where: { id: item.productId, salonId: req.salonId } });
        if (!product) throw new Error("Product not found");
        const systemStock = toAmount(product.currentStock);
        const physicalStock = toAmount(item.physicalStock);
        const variance = physicalStock - systemStock;
        await tx.stockReconciliationItem.create({
          data: { reconciliationId: reconciliation.id, productId: product.id, systemStock, physicalStock, variance }
        });
        if (variance !== 0) {
          await createStockMovement(tx, {
            salonId: req.salonId,
            branchId: req.body.branchId,
            productId: product.id,
            quantity: variance,
            movementType: "RECONCILIATION",
            createdByUserId: req.user.id,
            referenceType: "RECONCILIATION",
            referenceId: reconciliation.id,
            note: req.body.note || null
          });
        }
      }
      return tx.stockReconciliation.findUnique({ where: { id: reconciliation.id }, include: { items: true } });
    });
    res.status(201).json(result);
  });
};

