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
  if (discountType === "PERCENT") {
    const maxPercent = toRuleNumber(couponSettings.maxDiscountPercent, 0);
    if (maxPercent > 0 && discountValue > maxPercent) {
      const error = new Error(`Coupon discount cannot exceed ${maxPercent}% as configured in settings`);
      error.status = 400;
      throw error;
    }
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
    partnerCreditType: body.partnerCreditType || null,
    partnerCreditValue: body.partnerCreditValue != null ? toRuleNumber(body.partnerCreditValue) : null,
    partnerCustomerId: body.partnerCustomerId || null,
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
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    res.json(await prisma.coupon.findMany({ where: { salonId: req.salonId, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) }, include: { branch: true, service: true, product: true }, orderBy: { createdAt: "desc" } }));
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
    if (row.isReferral) {
      return res.status(400).json({ message: "Referral coupons cannot be edited from here. Use the referral management page." });
    }
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

  ownerRouter.delete("/coupons/:id", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "edit"), async (req, res) => {
    const row = await prisma.coupon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Coupon not found" });
    if (row.isReferral) {
      return res.status(400).json({ message: "Referral coupons cannot be deleted from here." });
    }
    await prisma.coupon.delete({ where: { id: row.id } });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "COUPONS",
      action: "COUPON_DELETED",
      entityType: "Coupon",
      entityId: row.id,
      reference: row.code,
      summary: `Coupon ${row.code} deleted`
    });
    res.json({ message: "Coupon deleted" });
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
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const [coupons, redemptions] = await Promise.all([
      prisma.coupon.findMany({ where: { salonId: req.salonId, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) }, orderBy: { createdAt: "desc" } }),
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
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    res.json(await prisma.giftCard.findMany({ where: { salonId: req.salonId, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) }, include: { issuedToCustomer: true, soldInvoice: true, redemptions: true }, orderBy: { createdAt: "desc" } }));
  });

  ownerRouter.post("/gift-cards", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "create"), validate(schemas.giftCard), async (req, res) => {
    const giftCardSettings = await getProgramSettings(req.salonId, "giftCardSettings", { enabled: true, validityDays: 365, minimumAmount: 0, maximumAmount: 0 });
    ensureProgramEnabled(giftCardSettings, "Gift cards");
    const giftCardData = buildGiftCardData(req.body, giftCardSettings);
    const row = await prisma.giftCard.create({
      data: {
        salonId: req.salonId,
        branchId: req.body.branchId || null,
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

    // ── Wire giftCard toggle (issuance notification) ───────────────────────
    if (row.issuedToCustomerId) {
      try {
        const setting = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
        const toggles = setting?.advancedSettings?.notificationSettings?.toggles || {};
        const emailEnabled = setting?.advancedSettings?.notificationSettings?.emailEnabled !== false;
        const whatsappEnabled = setting?.advancedSettings?.notificationSettings?.whatsappEnabled !== false;

        if (toggles.giftCard !== false) {
          await prisma.customerNotification.create({
            data: {
              salonId: req.salonId,
              customerId: row.issuedToCustomerId,
              title: "\uD83C\uDF81 Gift Card Received!",
              message: `You have received a gift card "${row.title}" worth \u20B9${row.balanceAmount}. Code: ${row.code}.`
            }
          }).catch(() => {});

          if (emailEnabled) {
            const recipient = await prisma.customer.findUnique({ where: { id: row.issuedToCustomerId }, select: { email: true } });
            if (recipient?.email) {
              const { attemptCustomerTemplateEmail } = await import("../../../lib/emailNotifications.js");
              await attemptCustomerTemplateEmail({
                salonId: req.salonId,
                toEmail: recipient.email,
                templateType: "gift_card_issued",
                context: { customerId: row.issuedToCustomerId, giftCardCode: row.code, giftCardAmount: row.balanceAmount }
              }).catch(() => {});
            }
          }
          if (whatsappEnabled) {
            const recipient = await prisma.customer.findUnique({ where: { id: row.issuedToCustomerId }, select: { phone: true } });
            if (recipient?.phone) {
              const { attemptCustomerTemplateWhatsApp } = await import("../../../lib/emailNotifications.js");
              await attemptCustomerTemplateWhatsApp({
                salonId: req.salonId,
                toPhone: recipient.phone,
                templateType: "gift_card_issued",
                context: { customerId: row.issuedToCustomerId, giftCardCode: row.code, giftCardAmount: row.balanceAmount },
                customerId: row.issuedToCustomerId
              }).catch(() => {});
            }
          }
        }
      } catch (notifyErr) {
        console.error("[promotions] Gift card issuance notification error (non-blocking):", notifyErr.message);
      }
    }

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

  ownerRouter.get("/customers/:id/gift-cards", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "view"), async (req, res) => {
    const rows = await prisma.giftCard.findMany({
      where: { issuedToCustomerId: req.params.id, salonId: req.salonId },
      orderBy: { createdAt: "desc" }
    });
    res.json(rows);
  });

  ownerRouter.patch("/gift-cards/:id", requireFeatureEnabled("couponsGiftCards"), requireSalonPermission("couponsGiftCards", "edit"), async (req, res) => {
    const row = await prisma.giftCard.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Gift card not found" });
    const newOriginal = req.body.originalAmount != null ? Number(req.body.originalAmount) : Number(row.originalAmount);
    const newBalance = req.body.balanceAmount != null ? Number(req.body.balanceAmount) : Number(row.balanceAmount);
    if (newBalance > newOriginal) return res.status(400).json({ message: "Balance cannot exceed original amount" });
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

    // ── Wire giftCard toggle (redemption notification) ────────────────────
    if (result.redemption.customerId) {
      try {
        const setting = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
        const toggles = setting?.advancedSettings?.notificationSettings?.toggles || {};
        const emailEnabled = setting?.advancedSettings?.notificationSettings?.emailEnabled !== false;
        const whatsappEnabled = setting?.advancedSettings?.notificationSettings?.whatsappEnabled !== false;

        if (toggles.giftCard !== false) {
          await prisma.customerNotification.create({
            data: {
              salonId: req.salonId,
              customerId: result.redemption.customerId,
              title: "\uD83D\uDED8 Gift Card Used",
              message: `Your gift card (${result.updated.code}) was used for \u20B9${req.body.amountUsed}. Remaining balance: \u20B9${result.updated.balanceAmount}.`
            }
          }).catch(() => {});

          if (emailEnabled) {
            const recipient = await prisma.customer.findUnique({ where: { id: result.redemption.customerId }, select: { email: true } });
            if (recipient?.email) {
              const { attemptCustomerTemplateEmail } = await import("../../../lib/emailNotifications.js");
              await attemptCustomerTemplateEmail({
                salonId: req.salonId,
                toEmail: recipient.email,
                templateType: "gift_card_redeemed_template",
                context: {
                  customerId: result.redemption.customerId,
                  giftCardCode: result.updated.code,
                  amountUsed: req.body.amountUsed,
                  balanceAmount: result.updated.balanceAmount
                }
              }).catch(() => {});
            }
          }
          if (whatsappEnabled) {
            const recipient = await prisma.customer.findUnique({ where: { id: result.redemption.customerId }, select: { phone: true } });
            if (recipient?.phone) {
              const { attemptCustomerTemplateWhatsApp } = await import("../../../lib/emailNotifications.js");
              await attemptCustomerTemplateWhatsApp({
                salonId: req.salonId,
                toPhone: recipient.phone,
                templateType: "gift_card_redeemed_template",
                context: {
                  customerId: result.redemption.customerId,
                  giftCardCode: result.updated.code,
                  amountUsed: req.body.amountUsed,
                  balanceAmount: result.updated.balanceAmount
                },
                customerId: result.redemption.customerId
              }).catch(() => {});
            }
          }
        }
      } catch (notifyErr) {
        console.error("[promotions] Gift card redemption notification error (non-blocking):", notifyErr.message);
      }
    }

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

  // ─── Wallet Routes ────────────────────────────────────────────────────────
  ownerRouter.get("/wallets/:customerId", requireSalonPermission("customers", "view"), async (req, res) => {
    const wallet = await prisma.wallet.findFirst({ where: { salonId: req.salonId, customerId: req.params.customerId } });
    if (!wallet) return res.json({ wallet: null, transactions: [] });
    const transactions = await prisma.walletTransaction.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: "desc" }, take: 50 });
    res.json({ wallet, transactions });
  });

  ownerRouter.post("/wallets/:customerId/deposit", requireSalonPermission("customers", "edit"), async (req, res) => {
    const amount = Number(req.body.amount || 0);
    if (amount <= 0) return res.status(400).json({ message: "Amount must be positive" });
    const note = req.body.note || null;
    const wallet = await prisma.$transaction(async (tx) => {
      let w = await tx.wallet.findFirst({ where: { salonId: req.salonId, customerId: req.params.customerId } });
      if (!w) {
        w = await tx.wallet.create({ data: { salonId: req.salonId, customerId: req.params.customerId, balance: amount, totalDeposited: amount, totalUsed: 0 } });
      } else {
        const newBalance = Number(w.balance) + amount;
        const newTotal = Number(w.totalDeposited) + amount;
        w = await tx.wallet.update({ where: { id: w.id }, data: { balance: newBalance, totalDeposited: newTotal } });
      }
      await tx.walletTransaction.create({ data: { salonId: req.salonId, walletId: w.id, customerId: req.params.customerId, type: "DEPOSIT", amount, balanceAfter: Number(w.balance), note, createdByUserId: req.user.id } });
      return w;
    });
    res.json(wallet);
  });

  ownerRouter.post("/wallets/:customerId/deduct", requireSalonPermission("customers", "edit"), async (req, res) => {
    const amount = Number(req.body.amount || 0);
    if (amount <= 0) return res.status(400).json({ message: "Amount must be positive" });
    const note = req.body.note || null;
    const referenceId = req.body.referenceId || null;
    const wallet = await prisma.$transaction(async (tx) => {
      const w = await tx.wallet.findFirst({ where: { salonId: req.salonId, customerId: req.params.customerId } });
      if (!w) return res.status(404).json({ message: "Wallet not found" });
      if (Number(w.balance) < amount) return res.status(400).json({ message: "Insufficient wallet balance" });
      const newBalance = Number(w.balance) - amount;
      const newTotalUsed = Number(w.totalUsed) + amount;
      const updated = await tx.wallet.update({ where: { id: w.id }, data: { balance: newBalance, totalUsed: newTotalUsed } });
      await tx.walletTransaction.create({ data: { salonId: req.salonId, walletId: w.id, customerId: req.params.customerId, type: "DEDUCTION", amount, balanceAfter: newBalance, referenceId, note, createdByUserId: req.user.id } });
      return updated;
    });
    res.json(wallet);
  });
};
