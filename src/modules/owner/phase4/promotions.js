import { prisma } from "../../../lib/prisma.js";
import { createAuditLog, redeemGiftCardAmount, validateCouponForContext } from "../../../lib/phase4.js";
import { ensureProgramEnabled, getProgramSettings, toRuleNumber } from "../../../lib/settingsRules.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const toDate = (value) => (value ? new Date(value) : null);
const addDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return date;
};

const buildCouponData = (body, couponSettings) => {
  const discountType = body.discountType;
  const discountValue = toRuleNumber(body.discountValue);
  const maxPercent = toRuleNumber(couponSettings.maxDiscountPercent, 0);
  if (discountType === "PERCENT" && maxPercent > 0 && discountValue > maxPercent) {
    const error = new Error(`Coupon discount cannot exceed ${maxPercent}% as configured in settings`);
    error.status = 400;
    throw error;
  }
  const settingsMinBill = toRuleNumber(couponSettings.minimumBillAmount, 0);
  const minBillAmount = Math.max(toRuleNumber(body.minBillAmount, 0), settingsMinBill);
  return {
    branchId: body.branchId || null,
    serviceId: body.serviceId || null,
    productId: body.productId || null,
    code: body.code,
    title: body.title,
    description: body.description || null,
    discountType,
    discountValue,
    minBillAmount,
    usageLimit: body.usageLimit ?? null,
    customerUsageLimit: body.customerUsageLimit ?? null,
    startsAt: toDate(body.startsAt),
    endsAt: toDate(body.endsAt),
    isReferral: body.isReferral ?? false,
    isInfluencer: body.isInfluencer ?? false,
    isBirthday: body.isBirthday ?? false,
    isFestival: body.isFestival ?? false,
    isArchived: body.isArchived ?? false,
    notes: body.notes || null
  };
};

const buildGiftCardData = (body, giftCardSettings) => {
  const originalAmount = toRuleNumber(body.originalAmount);
  const minimumAmount = toRuleNumber(giftCardSettings.minimumAmount, 0);
  const maximumAmount = toRuleNumber(giftCardSettings.maximumAmount, 0);
  if (minimumAmount > 0 && originalAmount < minimumAmount) {
    const error = new Error(`Gift card amount must be at least ${minimumAmount}`);
    error.status = 400;
    throw error;
  }
  if (maximumAmount > 0 && originalAmount > maximumAmount) {
    const error = new Error(`Gift card amount cannot exceed ${maximumAmount}`);
    error.status = 400;
    throw error;
  }
  const validityDays = toRuleNumber(giftCardSettings.validityDays, 0);
  return {
    originalAmount,
    balanceAmount: body.balanceAmount ?? originalAmount,
    expiresAt: toDate(body.expiresAt) || (validityDays > 0 ? addDays(validityDays) : null)
  };
};

export const registerPromotionRoutes = (ownerRouter) => {
  ownerRouter.get("/coupons", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    res.json(await prisma.coupon.findMany({ where: { salonId: req.salonId }, include: { branch: true, service: true, product: true }, orderBy: { createdAt: "desc" } }));
  });

  ownerRouter.post("/coupons", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "create"), validate(schemas.coupon), async (req, res) => {
    const couponSettings = await getProgramSettings(req.salonId, "couponSettings", { enabled: true, maxDiscountPercent: 0, minimumBillAmount: 0 });
    ensureProgramEnabled(couponSettings, "Coupons");
    const row = await prisma.coupon.create({
      data: {
        salonId: req.salonId,
        ...buildCouponData(req.body, couponSettings)
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "COUPONS",
      action: "COUPON_CREATED",
      entityType: "Coupon",
      entityId: row.id,
      reference: row.code,
      summary: `Coupon ${row.code} created`
    });
    res.status(201).json(row);
  });

  ownerRouter.patch("/coupons/:id", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "edit"), validate(schemas.coupon), async (req, res) => {
    const couponSettings = await getProgramSettings(req.salonId, "couponSettings", { enabled: true, maxDiscountPercent: 0, minimumBillAmount: 0 });
    ensureProgramEnabled(couponSettings, "Coupons");
    const row = await prisma.coupon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Coupon not found" });
    const updated = await prisma.coupon.update({
      where: { id: row.id },
      data: buildCouponData(req.body, couponSettings)
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "COUPONS",
      action: "COUPON_UPDATED",
      entityType: "Coupon",
      entityId: updated.id,
      reference: updated.code,
      summary: `Coupon ${updated.code} updated`
    });
    res.json(updated);
  });

  ownerRouter.post("/coupons/validate", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), validate(schemas.couponValidate), async (req, res) => {
    const couponSettings = await getProgramSettings(req.salonId, "couponSettings", { enabled: true });
    ensureProgramEnabled(couponSettings, "Coupons");
    const result = await validateCouponForContext({
      salonId: req.salonId,
      code: req.body.code,
      customerId: req.body.customerId || null,
      branchId: req.body.branchId || null,
      serviceIds: req.body.serviceIds || [],
      productIds: req.body.productIds || [],
      subtotal: req.body.subtotal
    });
    res.json({ valid: true, ...result });
  });

  ownerRouter.get("/coupons/reports", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    const [coupons, redemptions] = await Promise.all([
      prisma.coupon.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } }),
      prisma.couponRedemption.findMany({
        where: { salonId: req.salonId },
        include: { coupon: true, customer: true, invoice: true, order: true },
        orderBy: { createdAt: "desc" }
      })
    ]);
    res.json({
      coupons,
      redemptions,
      totalSavings: redemptions.reduce((sum, row) => sum + Number(row.amountSaved || 0), 0)
    });
  });

  ownerRouter.get("/gift-cards", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    res.json(await prisma.giftCard.findMany({ where: { salonId: req.salonId }, include: { issuedToCustomer: true, soldInvoice: true, redemptions: true }, orderBy: { createdAt: "desc" } }));
  });

  ownerRouter.post("/gift-cards", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "create"), validate(schemas.giftCard), async (req, res) => {
    const giftCardSettings = await getProgramSettings(req.salonId, "giftCardSettings", { enabled: true, validityDays: 365, minimumAmount: 0, maximumAmount: 0 });
    ensureProgramEnabled(giftCardSettings, "Gift cards");
    const giftCardData = buildGiftCardData(req.body, giftCardSettings);
    const row = await prisma.giftCard.create({
      data: {
        salonId: req.salonId,
        issuedToCustomerId: req.body.customerId || null,
        soldInvoiceId: req.body.soldInvoiceId || null,
        linkedCampaignId: req.body.linkedCampaignId || null,
        createdByMembershipId: req.user.membershipId || null,
        code: req.body.code,
        title: req.body.title,
        originalAmount: giftCardData.originalAmount,
        balanceAmount: giftCardData.balanceAmount,
        expiresAt: giftCardData.expiresAt,
        isActive: req.body.isActive ?? true,
        note: req.body.note || null
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "GIFT_CARDS",
      action: "GIFT_CARD_CREATED",
      entityType: "GiftCard",
      entityId: row.id,
      reference: row.code,
      summary: `Gift card ${row.code} created`
    });
    res.status(201).json(row);
  });

  ownerRouter.get("/gift-cards/:id", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    const row = await prisma.giftCard.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { issuedToCustomer: true, soldInvoice: true, redemptions: { include: { customer: true, invoice: true, order: true }, orderBy: { createdAt: "desc" } } }
    });
    if (!row) return res.status(404).json({ message: "Gift card not found" });
    res.json(row);
  });

  ownerRouter.patch("/gift-cards/:id", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "edit"), async (req, res) => {
    const row = await prisma.giftCard.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Gift card not found" });
    const updated = await prisma.giftCard.update({
      where: { id: row.id },
      data: {
        code: req.body.code ?? row.code,
        title: req.body.title ?? row.title,
        originalAmount: req.body.originalAmount != null ? Number(req.body.originalAmount) : row.originalAmount,
        balanceAmount: req.body.balanceAmount != null ? Number(req.body.balanceAmount) : row.balanceAmount,
        expiresAt: req.body.expiresAt != null ? (req.body.expiresAt ? new Date(req.body.expiresAt) : null) : row.expiresAt,
        isActive: req.body.isActive ?? row.isActive,
        note: req.body.note != null ? req.body.note : row.note
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "GIFT_CARDS",
      action: "GIFT_CARD_UPDATED",
      entityType: "GiftCard",
      entityId: updated.id,
      reference: updated.code,
      summary: `Gift card ${updated.code} updated`
    });
    res.json(updated);
  });

  ownerRouter.delete("/gift-cards/:id", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "edit"), async (req, res) => {
    const row = await prisma.giftCard.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Gift card not found" });
    const hasRedemptions = await prisma.giftCardRedemption.count({ where: { giftCardId: row.id } });
    if (hasRedemptions > 0) {
      return res.status(400).json({ message: "Cannot delete a gift card that has been redeemed. Deactivate it instead." });
    }
    await prisma.giftCard.delete({ where: { id: row.id } });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "GIFT_CARDS",
      action: "GIFT_CARD_DELETED",
      entityType: "GiftCard",
      entityId: row.id,
      reference: row.code,
      summary: `Gift card ${row.code} deleted`
    });
    res.json({ message: "Gift card deleted" });
  });

  ownerRouter.post("/gift-cards/redeem", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "edit"), validate(schemas.giftCardRedeem), async (req, res) => {
    const giftCardSettings = await getProgramSettings(req.salonId, "giftCardSettings", { enabled: true });
    ensureProgramEnabled(giftCardSettings, "Gift cards");
    const giftCardId = req.body.giftCardId || req.body.id;
    if (!giftCardId) return res.status(400).json({ message: "giftCardId: Gift card is required" });
    const result = await redeemGiftCardAmount({
      salonId: req.salonId,
      giftCardId,
      customerId: req.body.customerId || null,
      invoiceId: req.body.invoiceId || null,
      orderId: req.body.orderId || null,
      amountUsed: req.body.amountUsed
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "GIFT_CARDS",
      action: "GIFT_CARD_REDEEMED",
      entityType: "GiftCardRedemption",
      entityId: result.redemption.id,
      summary: `Gift card redeemed for ${req.body.amountUsed}`
    });
    res.status(201).json({ ok: true, giftCard: result.updated, redemption: result.redemption });
  });

  ownerRouter.get("/gift-cards/reports", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    const redemptions = await prisma.giftCardRedemption.findMany({
      where: { salonId: req.salonId },
      include: { giftCard: true, customer: true, invoice: true, order: true },
      orderBy: { createdAt: "desc" }
    });
    res.json({
      redemptions,
      totalRedeemed: redemptions.reduce((sum, row) => sum + Number(row.amountUsed || 0), 0)
    });
  });
};
