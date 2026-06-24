import { prisma } from "./prisma.js";

const toNumber = (value) => Number(value || 0);

export const createAuditLog = async ({
  salonId = null,
  actorUserId = null,
  actorMembershipId = null,
  module,
  action,
  entityType = null,
  entityId = null,
  reference = null,
  summary = null,
  metadata = null
}) => prisma.auditLog.create({
  data: {
    salonId,
    actorUserId,
    actorMembershipId,
    module,
    action,
    entityType,
    entityId,
    reference,
    summary,
    metadata
  }
});

export const createStaffNotification = async ({
  salonId,
  userSalonId = null,
  title,
  message,
  type = null,
  linkUrl = null,
  metadata = null
}) => prisma.notification.create({
  data: {
    salonId,
    userSalonId,
    title,
    message,
    type,
    linkUrl,
    metadata
  }
});

export const createCustomerNotification = async ({
  salonId,
  customerId,
  title,
  message,
  linkUrl = null
}) => prisma.customerNotification.create({
  data: {
    salonId,
    customerId,
    title,
    message,
    linkUrl
  }
});

export const getActiveLoyaltyRule = async (salonId, branchId = null) => {
  const exact = branchId
    ? await prisma.loyaltyRule.findFirst({
        where: { salonId, branchId, isActive: true },
        orderBy: { updatedAt: "desc" }
      })
    : null;
  if (exact) return exact;
  return prisma.loyaltyRule.findFirst({
    where: { salonId, branchId: null, isActive: true },
    orderBy: { updatedAt: "desc" }
  });
};

export const getCustomerValidLoyaltyBalance = async (customerId) => {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { loyaltyPoints: true }
  });
  return customer?.loyaltyPoints || 0;
};

export const recordLoyaltyTransaction = async ({
  salonId,
  branchId = null,
  customerId,
  invoiceId = null,
  orderId = null,
  createdByMembershipId = null,
  type,
  points,
  expiresAt = null,
  note = null,
  metadata = null
}) => {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { loyaltyPoints: true }
  });
  const nextBalance = (customer?.loyaltyPoints || 0) + points;
  if (nextBalance < 0) {
    const error = new Error("Customer does not have enough loyalty points");
    error.status = 400;
    throw error;
  }

  const tx_result = await prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: customerId },
      data: { loyaltyPoints: nextBalance }
    });
    return tx.loyaltyTransaction.create({
      data: {
        salonId,
        branchId,
        customerId,
        invoiceId,
        orderId,
        createdByMembershipId,
        type,
        points,
        balanceAfter: nextBalance,
        expiresAt,
        note,
        metadata
      }
    });
  });

  // ── Notification dispatch (non-blocking) ─────────────────────────────────
  if (points > 0) {
    try {
      const setting = await prisma.salonSetting.findFirst({
        where: { salonId, branchId: null }
      });
      const toggles = setting?.advancedSettings?.notificationSettings?.toggles || {};
      const emailEnabled = setting?.advancedSettings?.notificationSettings?.emailEnabled !== false;
      const isReferralTransaction = type === "BONUS" || (note && /refer/i.test(note));

      if (toggles.loyaltyEarning !== false) {
        await prisma.customerNotification.create({
          data: {
            salonId,
            customerId,
            title: "\uD83C\uDF1F Loyalty Points Earned!",
            message: `You earned ${points} loyalty points! Your new balance is ${nextBalance} points.`
          }
        }).catch(() => {});

        if (emailEnabled) {
          const recipient = await prisma.customer.findUnique({ where: { id: customerId }, select: { email: true } });
          if (recipient?.email) {
            const { attemptCustomerTemplateEmail } = await import("./emailNotifications.js");
            await attemptCustomerTemplateEmail({
              salonId,
              toEmail: recipient.email,
              templateType: "loyalty_earning_template",
              context: { customerId, pointsEarned: points, newBalance: nextBalance }
            }).catch(() => {});
          }
        }
      }

      if (isReferralTransaction && toggles.referrerRewardSMS !== false) {
        await prisma.customerNotification.create({
          data: {
            salonId,
            customerId,
            title: "\uD83C\uDF89 Referral Reward Received!",
            message: `You earned ${points} bonus points for referring a friend! Balance: ${nextBalance} pts.`
          }
        }).catch(() => {});

        if (emailEnabled) {
          const recipient = await prisma.customer.findUnique({ where: { id: customerId }, select: { email: true } });
          if (recipient?.email) {
            const { attemptCustomerTemplateEmail } = await import("./emailNotifications.js");
            await attemptCustomerTemplateEmail({
              salonId,
              toEmail: recipient.email,
              templateType: "referrer_reward_sms",
              context: { customerId, pointsEarned: points, note: note || "Referral Reward" }
            }).catch(() => {});
          }
        }
      }
    } catch (notifyErr) {
      console.error("[phase4] Loyalty notification error (non-blocking):", notifyErr.message);
    }
  }

  return tx_result;
};

export const reverseInvoiceLoyalty = async (tx, invoice, actorUser = null) => {
  if (!invoice || !invoice.customerId) return;

  const customer = await tx.customer.findUnique({
    where: { id: invoice.customerId },
    select: { loyaltyPoints: true }
  });
  const currentBalance = Number(customer?.loyaltyPoints || 0);
  let runningBalance = currentBalance;

  const earnedTransactions = await tx.loyaltyTransaction.findMany({
    where: { invoiceId: invoice.id, type: "EARN" }
  });
  const redeemedTransactions = await tx.loyaltyTransaction.findMany({
    where: { invoiceId: invoice.id, type: "REDEEM" }
  });

  // Return redeemed points
  for (const t of redeemedTransactions) {
    runningBalance += Math.abs(Number(t.points || 0));
    await tx.customer.update({ where: { id: invoice.customerId }, data: { loyaltyPoints: runningBalance } });
    await tx.loyaltyTransaction.create({
      data: {
        salonId: invoice.salonId,
        branchId: invoice.branchId,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        createdByMembershipId: actorUser?.membershipId || null,
        type: "ADJUST",
        points: Math.abs(Number(t.points || 0)),
        balanceAfter: runningBalance,
        note: "Refund/Cancel reversal of redeemed points",
        metadata: { reversalOf: t.id, reason: "refund_or_cancel" }
      }
    });
  }

  // Deduct earned points (clamp at 0 if not enough)
  for (const t of earnedTransactions) {
    const earnedPoints = Math.abs(Number(t.points || 0));
    const deductPoints = Math.min(earnedPoints, runningBalance);
    if (deductPoints <= 0) continue;
    runningBalance -= deductPoints;
    await tx.customer.update({ where: { id: invoice.customerId }, data: { loyaltyPoints: runningBalance } });
    await tx.loyaltyTransaction.create({
      data: {
        salonId: invoice.salonId,
        branchId: invoice.branchId,
        customerId: invoice.customerId,
        invoiceId: invoice.id,
        createdByMembershipId: actorUser?.membershipId || null,
        type: "ADJUST",
        points: -deductPoints,
        balanceAfter: runningBalance,
        note: "Refund/Cancel reversal of earned points",
        metadata: { reversalOf: t.id, reason: "refund_or_cancel", originalPoints: earnedPoints }
      }
    });
  }
};

export const calculateLoyaltyEarnPoints = ({ rule, invoiceSubtotal = 0, items = [] }) => {
  if (!rule) return 0;
  const baseRate = toNumber(rule.pointsPerCurrency || 0);
  let points = Math.floor(toNumber(invoiceSubtotal) * baseRate);
  const serviceItems = items.filter((item) => item.itemType === "SERVICE").length;
  const productItems = items.filter((item) => item.itemType === "PRODUCT").length;
  if (serviceItems && rule.serviceMultiplier != null) {
    points += Math.floor(serviceItems * toNumber(rule.serviceMultiplier));
  }
  if (productItems && rule.productMultiplier != null) {
    points += Math.floor(productItems * toNumber(rule.productMultiplier));
  }
  return Math.max(0, points);
};

export const validateCouponForContext = async ({
  salonId,
  code,
  customerId = null,
  branchId = null,
  serviceIds = [],
  productIds = [],
  subtotal = 0
}) => {
  const coupon = await prisma.coupon.findFirst({
    where: { salonId, code, isArchived: false }
  });
  if (!coupon) {
    const error = new Error("Coupon not found");
    error.status = 404;
    throw error;
  }

  const now = new Date();
  if (coupon.startsAt && new Date(coupon.startsAt) > now) {
    const error = new Error("Coupon is not active yet");
    error.status = 400;
    throw error;
  }
  if (coupon.endsAt && new Date(coupon.endsAt) < now) {
    const error = new Error("Coupon has expired");
    error.status = 400;
    throw error;
  }
  if (coupon.usageLimit != null && coupon.usageCount >= coupon.usageLimit) {
    const error = new Error("Coupon usage limit reached");
    error.status = 400;
    throw error;
  }
  if (coupon.minBillAmount != null && subtotal < toNumber(coupon.minBillAmount)) {
    const error = new Error("Minimum bill amount not reached for this coupon");
    error.status = 400;
    throw error;
  }
  if (coupon.branchId && coupon.branchId !== branchId) {
    const error = new Error("Coupon is not valid for this branch");
    error.status = 400;
    throw error;
  }
  if (coupon.serviceId && !serviceIds.includes(coupon.serviceId)) {
    const error = new Error("Coupon is not valid for the selected services");
    error.status = 400;
    throw error;
  }
  if (coupon.productId && !productIds.includes(coupon.productId)) {
    const error = new Error("Coupon is not valid for the selected products");
    error.status = 400;
    throw error;
  }
  if (customerId && coupon.customerUsageLimit != null) {
    const used = await prisma.couponRedemption.count({
      where: { couponId: coupon.id, customerId }
    });
    if (used >= coupon.customerUsageLimit) {
      const error = new Error("Customer usage limit reached for this coupon");
      error.status = 400;
      throw error;
    }
  }

  const discountAmount = coupon.discountType === "PERCENT"
    ? Math.min(subtotal, subtotal * (toNumber(coupon.discountValue) / 100))
    : Math.min(subtotal, toNumber(coupon.discountValue));

  return { coupon, discountAmount };
};

export const redeemGiftCardAmount = async ({
  salonId,
  giftCardId,
  customerId = null,
  invoiceId = null,
  orderId = null,
  amountUsed
}) => {
  const giftCard = await prisma.giftCard.findFirst({
    where: { id: giftCardId, salonId, isActive: true }
  });
  if (!giftCard) {
    const error = new Error("Gift card not found");
    error.status = 404;
    throw error;
  }
  if (giftCard.expiresAt && new Date(giftCard.expiresAt) < new Date()) {
    const error = new Error("Gift card has expired");
    error.status = 400;
    throw error;
  }
  const remaining = toNumber(giftCard.balanceAmount);
  if (remaining < toNumber(amountUsed)) {
    const error = new Error("Gift card balance is not enough");
    error.status = 400;
    throw error;
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.giftCard.update({
      where: { id: giftCard.id },
      data: { balanceAmount: remaining - toNumber(amountUsed) }
    });
    const redemption = await tx.giftCardRedemption.create({
      data: {
        salonId,
        giftCardId: giftCard.id,
        customerId,
        invoiceId,
        orderId,
        amountUsed: toNumber(amountUsed)
      }
    });
    return { updated, redemption };
  });
};

export const calculatePayrollItem = ({
  invoices = [],
  membershipSales = [],
  packageSales = [],
  attendanceRecords = [],
  leaveRequests = [],
  baseSalary = 0
}) => {
  const commissionAmount = invoices.reduce((sum, invoice) => sum + toNumber(invoice.commissionAmount || 0), 0);
  const membershipRevenue = membershipSales.reduce((sum, row) => sum + toNumber(row.price || 0), 0);
  const packageRevenue = packageSales.reduce((sum, row) => sum + toNumber(row.price || 0), 0);
  const incentiveAmount = Math.round((membershipRevenue + packageRevenue) * 0.02);
  const missedCheckouts = attendanceRecords.filter((row) => !row.checkOutAt).length;
  const rejectedLeaves = leaveRequests.filter((row) => row.status === "REJECTED").length;
  const attendanceDeduction = missedCheckouts * 250;
  const leaveDeduction = rejectedLeaves * 500;
  const netAmount = toNumber(baseSalary) + commissionAmount + incentiveAmount - attendanceDeduction - leaveDeduction;

  return {
    baseSalary: toNumber(baseSalary),
    commissionAmount,
    incentiveAmount,
    adjustmentAmount: 0,
    attendanceDeduction,
    leaveDeduction,
    netAmount
  };
};
