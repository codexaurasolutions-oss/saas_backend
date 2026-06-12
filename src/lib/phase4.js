import { prisma } from "./prisma.js";

const toNumber = (value) => Number(value || 0);
const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const getNotificationSettings = async (salonId) => {
  const row = await prisma.salonSetting.findFirst({
    where: { salonId, branchId: null },
    select: { advancedSettings: true }
  });
  return asObject(asObject(row?.advancedSettings).notificationSettings);
};

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
}) => {
  const settings = await getNotificationSettings(salonId);
  const channelsEnabled = [settings.emailEnabled, settings.smsEnabled, settings.whatsappEnabled, settings.pushEnabled]
    .some((value) => value !== false);
  if (!channelsEnabled) return null;

  return prisma.notification.create({
    data: {
      salonId,
      userSalonId,
      title,
      message,
      type,
      linkUrl,
      metadata: {
        ...(asObject(metadata)),
        notificationChannels: {
          emailEnabled: settings.emailEnabled !== false,
          smsEnabled: settings.smsEnabled !== false,
          whatsappEnabled: settings.whatsappEnabled !== false,
          pushEnabled: settings.pushEnabled === true
        }
      }
    }
  });
};

export const createCustomerNotification = async ({
  salonId,
  customerId,
  title,
  message,
  linkUrl = null
}) => {
  const settings = await getNotificationSettings(salonId);
  const channelsEnabled = [settings.emailEnabled, settings.smsEnabled, settings.whatsappEnabled, settings.pushEnabled]
    .some((value) => value !== false);
  if (!channelsEnabled) return null;

  return prisma.customerNotification.create({
    data: {
      salonId,
      customerId,
      title,
      message,
      linkUrl
    }
  });
};

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

  return prisma.$transaction(async (tx) => {
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
