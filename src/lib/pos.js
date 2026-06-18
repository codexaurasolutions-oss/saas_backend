import crypto from "crypto";
import { prisma } from "./prisma.js";
import { createStockMovement, ensureScopedBranch, ensureScopedCustomer, ensureScopedService, ensureScopedStaffMembership, getSalonSetting, logCustomerTimeline, refreshCustomerInsights, toAmount } from "./phase2.js";
import { calculateLoyaltyEarnPoints, getCustomerValidLoyaltyBalance, reverseInvoiceLoyalty } from "./phase4.js";

const normalizeStatus = (paidAmount, total, refundAmount = 0, cancelled = false) => {
  if (cancelled) return "CANCELLED";
  if (refundAmount >= total && total > 0) return "REFUNDED";
  if (paidAmount >= total && total > 0) return "PAID";
  if (paidAmount > 0) return "PARTIAL";
  return "UNPAID";
};

export const createInvoiceNumber = async (tx, salonId, branchId) => {
  const count = await tx.invoice.count({ where: { salonId } });
  const settings = await getSalonSetting(tx, salonId, branchId);
  const prefix = settings?.invoicePrefix || "INV";
  return `${prefix}-${String(count + 1).padStart(5, "0")}`;
};

const ensureProduct = async (salonId, branchId, productId) => {
  const product = await prisma.product.findFirst({
    where: { id: productId, salonId, isActive: true }
  });
  if (!product) {
    const error = new Error("Product not found");
    error.status = 404;
    throw error;
  }
  if (branchId && product.branchId && product.branchId !== branchId) {
    const error = new Error("Product belongs to a different branch");
    error.status = 400;
    throw error;
  }
  return product;
};

const ensureActiveCustomerMembership = async (salonId, customerId, membershipId) => {
  if (!membershipId) return null;
  const membership = await prisma.customerMembership.findFirst({
    where: { id: membershipId, salonId, customerId },
    include: { membershipPlan: { include: { services: true } } }
  });
  if (!membership || membership.status !== "ACTIVE" || new Date(membership.endsAt) < new Date()) {
    const error = new Error("Active membership not found");
    error.status = 400;
    throw error;
  }
  return membership;
};

const ensureActiveCustomerPackage = async (salonId, customerPackageId) => {
  const customerPackage = await prisma.customerPackage.findFirst({
    where: { id: customerPackageId, salonId },
    include: { package: true }
  });
  if (!customerPackage || customerPackage.status !== "ACTIVE" || new Date(customerPackage.endsAt) < new Date()) {
    const error = new Error("Active package not found");
    error.status = 400;
    throw error;
  }
  return customerPackage;
};

const ensureMembershipPlan = async (salonId, planId) => {
  const plan = await prisma.membershipPlan.findFirst({ where: { id: planId, salonId, isActive: true } });
  if (!plan) {
    const error = new Error("Membership plan not found");
    error.status = 404;
    throw error;
  }
  return plan;
};

const ensurePackagePlan = async (salonId, packageId) => {
  const pack = await prisma.package.findFirst({ where: { id: packageId, salonId, isActive: true } });
  if (!pack) {
    const error = new Error("Package not found");
    error.status = 404;
    throw error;
  }
  return pack;
};

const createPaymentRows = async (tx, salonId, invoiceId, payments) => {
  if (!payments.length) return [];
  await tx.payment.createMany({
    data: payments.map((payment) => ({
      salonId,
      invoiceId,
      amount: toAmount(payment.amount),
      mode: payment.mode,
      note: payment.note || null,
      type: payment.type || "PAYMENT",
      onlineStatus: payment.onlineStatus || null,
      gatewayName: payment.gatewayName || null,
      gatewayRef: payment.gatewayRef || null
    }))
  });
  return tx.payment.findMany({ where: { invoiceId } });
};

const buildInvoiceNotes = ({ notes, couponCode, giftVoucherCode, loyaltyPointsUsed }) => {
  const lines = [];
  if (notes) lines.push(notes);
  if (couponCode) lines.push(`Coupon applied: ${couponCode}`);
  if (giftVoucherCode) lines.push(`Gift card applied: ${giftVoucherCode}`);
  if (Number(loyaltyPointsUsed || 0) > 0) lines.push(`Loyalty points redeemed: ${Number(loyaltyPointsUsed)}`);
  return lines.join("\n").trim() || null;
};

export const createPosInvoice = async ({ salonId, actorUser, body }) => {
  await ensureScopedCustomer(salonId, body.customerId);
  await ensureScopedBranch(salonId, body.branchId);
  const membership = await ensureActiveCustomerMembership(salonId, body.customerId, body.appliedMembershipId);

  const salonSettings = await prisma.salonSetting.findFirst({ where: { salonId, branchId: null } });
  const advancedSettings = typeof salonSettings?.advancedSettings === "object" ? salonSettings.advancedSettings : {};
  const allowPriceEdit = advancedSettings?.allowPriceEditOnBill !== false;
  const allowFutureBackdatedBills = advancedSettings?.allowFutureBackdatedBills === true;
  const allowEditConsumable = advancedSettings?.allowEditConsumable !== false;
  const membershipSettings = typeof advancedSettings?.membershipSettings === "object" ? advancedSettings.membershipSettings : {};
  const inclusiveTax = advancedSettings?.taxMapping?.inclusiveTax === true;

  if (!allowFutureBackdatedBills && body.invoiceDate) {
    const invoiceDate = new Date(body.invoiceDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (invoiceDate >= tomorrow || invoiceDate < yesterday) {
      const error = new Error("Future or backdated bills are restricted by salon settings");
      error.status = 400;
      throw error;
    }
  }

  const itemDrafts = [];
  for (const item of body.items) {
    const itemType = item.itemType || (item.productId ? "PRODUCT" : item.membershipPlanId ? "MEMBERSHIP" : item.packageId ? "PACKAGE" : "SERVICE");
    if (itemType === "SERVICE") {
      const service = await ensureScopedService(salonId, item.serviceId);
      const staffMembership = item.staffUserId ? await ensureScopedStaffMembership(salonId, item.staffUserId) : null;
      if (staffMembership?.serviceAssignments?.length) {
        const hasAssignment = staffMembership.serviceAssignments.some((assignment) => assignment.serviceId === service.id);
        if (!hasAssignment) {
          const error = new Error("Selected staff member is not assigned to this service");
          error.status = 400;
          throw error;
        }
      }

      let unitPrice = item.unitPrice != null ? toAmount(item.unitPrice) : toAmount(service.price);
      if (!allowPriceEdit && unitPrice !== toAmount(service.price)) {
        const error = new Error("Price edits on the bill are restricted by salon settings");
        error.status = 400;
        throw error;
      }
      let appliedBenefitType = null;
      let appliedBenefitValue = 0;
      let membershipWalletUsed = 0;

      if (membership) {
        const serviceAllowed = !membership.membershipPlan.serviceSpecificOnly
          || membership.membershipPlan.services.some((entry) => entry.serviceId === service.id);
        if (serviceAllowed) {
          if (membership.membershipPlan.benefitType === "DISCOUNT_PERCENT") {
            appliedBenefitType = "MEMBERSHIP_PERCENT";
            appliedBenefitValue = (unitPrice * toAmount(membership.membershipPlan.discountValue)) / 100;
            unitPrice = Math.max(0, unitPrice - appliedBenefitValue);
          } else if (membership.membershipPlan.benefitType === "DISCOUNT_AMOUNT") {
            appliedBenefitType = "MEMBERSHIP_FIXED";
            appliedBenefitValue = Math.min(unitPrice, toAmount(membership.membershipPlan.discountValue));
            unitPrice = Math.max(0, unitPrice - appliedBenefitValue);
          } else if (membership.membershipPlan.benefitType === "WALLET_VALUE") {
            membershipWalletUsed = Math.min(unitPrice, toAmount(membership.remainingWalletValue));
            unitPrice = Math.max(0, unitPrice - membershipWalletUsed);
            appliedBenefitType = membershipWalletUsed ? "MEMBERSHIP_WALLET" : null;
            appliedBenefitValue = membershipWalletUsed;
          }
        }
      }

      const qty = Number(item.qty || 1);
      const taxPct = toAmount(item.taxPct != null ? item.taxPct : service.taxRate || 0);
      const preTax = unitPrice * qty;
      const lineTotal = inclusiveTax && taxPct > 0
        ? preTax
        : preTax + (preTax * taxPct) / 100;
      const commissionAmount = service.commissionPct ? (preTax * toAmount(service.commissionPct)) / 100 : 0;

      itemDrafts.push({
        itemType,
        serviceId: service.id,
        staffUserSalonId: staffMembership?.id || null,
        serviceName: service.name,
        staffName: staffMembership?.user.name || item.staffName || null,
        qty,
        unitPrice,
        taxPct,
        lineTotal,
        appliedBenefitType,
        appliedBenefitValue,
        membershipWalletUsed,
        commissionAmount
      });
      continue;
    }

    if (itemType === "PRODUCT") {
      const product = await ensureProduct(salonId, body.branchId, item.productId);
      const qty = Number(item.qty || 1);
      const unitPrice = item.unitPrice != null ? toAmount(item.unitPrice) : toAmount(product.sellingPrice);
      if (!allowPriceEdit && unitPrice !== toAmount(product.sellingPrice)) {
        const error = new Error("Price edits on the bill are restricted by salon settings");
        error.status = 400;
        throw error;
      }
      const taxPct = toAmount(item.taxPct || 0);
      const preTax = unitPrice * qty;
      itemDrafts.push({
        itemType,
        productId: product.id,
        staffUserSalonId: null,
        serviceName: product.name,
        staffName: item.staffName || null,
        batchNumber: item.batchNumber || null,
        qty,
        unitPrice,
        taxPct,
        lineTotal: inclusiveTax && taxPct > 0
          ? preTax
          : preTax + (preTax * taxPct) / 100,
        commissionAmount: 0
      });
      continue;
    }

    if (itemType === "MEMBERSHIP") {
      let plan;
      if (item.isCustom || item.membershipPlanId === "CUSTOM") {
        plan = await prisma.membershipPlan.create({
          data: {
            salonId,
            name: item.serviceName || "Custom Membership",
            price: toAmount(item.unitPrice),
            validityDays: Number(item.validityDays || 30),
            benefitType: "DISCOUNT_PERCENTAGE",
            discountValue: 0,
            isPublicVisible: false,
            isActive: true
          }
        });
        if (item.customServices && item.customServices.length > 0) {
          await prisma.membershipPlanService.createMany({
            data: item.customServices.map(sid => ({ membershipPlanId: plan.id, serviceId: sid }))
          });
        }
      } else {
        plan = await ensureMembershipPlan(salonId, item.membershipPlanId);
      }
      const qty = 1;
      const taxPct = toAmount(item.taxPct || 0);
      const preTax = toAmount(plan.price) * qty;
      itemDrafts.push({
        itemType,
        membershipPlanId: plan.id,
        staffUserSalonId: item.staffUserId || null,
        serviceName: plan.name,
        staffName: item.staffName || null,
        qty,
        unitPrice: toAmount(plan.price),
        taxPct,
        lineTotal: preTax + (preTax * taxPct) / 100,
        commissionAmount: 0
      });
      continue;
    }

    if (itemType === "PACKAGE") {
      let pack;
      if (item.isCustom || item.packageId === "CUSTOM") {
        pack = await prisma.package.create({
          data: {
            salonId,
            name: item.serviceName || "Custom Package",
            price: toAmount(item.unitPrice),
            totalSessions: item.customServices ? item.customServices.length : 1,
            validityDays: Number(item.validityDays || 30),
            isPublicVisible: false,
            isActive: true
          }
        });
        if (item.customServices && item.customServices.length > 0) {
          await prisma.packageService.createMany({
            data: item.customServices.map(sid => ({ packageId: pack.id, serviceId: sid }))
          });
        }
      } else {
        pack = await ensurePackagePlan(salonId, item.packageId);
      }
      const qty = 1;
      const taxPct = toAmount(item.taxPct || 0);
      const preTax = toAmount(pack.price) * qty;
      itemDrafts.push({
        itemType,
        packageId: pack.id,
        staffUserSalonId: item.staffUserId || null,
        serviceName: pack.name,
        staffName: item.staffName || null,
        qty,
        unitPrice: toAmount(pack.price),
        taxPct,
        lineTotal: preTax + (preTax * taxPct) / 100,
        commissionAmount: 0
      });
    }

    if (itemType === "GIFT_CARD") {
      const gcAmount = toAmount(item.unitPrice);
      const validityDays = Number(item.validityDays || 365);
      const qty = Number(item.qty || 1);
      const taxPct = toAmount(item.taxPct || 0);
      const preTax = gcAmount * qty;
      itemDrafts.push({
        itemType,
        serviceName: item.serviceName || "Gift Card",
        staffName: item.staffName || null,
        qty,
        unitPrice: gcAmount,
        taxPct,
        lineTotal: preTax + (preTax * taxPct) / 100,
        commissionAmount: 0,
        validityDays,
        gcCode: item.gcCode || null
      });
    }
  }

  const soldMembershipCount = itemDrafts.filter((item) => item.itemType === "MEMBERSHIP").length;
  if (soldMembershipCount > 0 && membershipSettings.allowMultipleActivePlans === false) {
    if (soldMembershipCount > 1) {
      const error = new Error("Only one membership can be sold in a single invoice when multiple active plans are disabled");
      error.status = 400;
      throw error;
    }
    const existingActiveMembership = await prisma.customerMembership.findFirst({
      where: {
        salonId,
        customerId: body.customerId,
        status: "ACTIVE",
        endsAt: { gte: new Date() }
      },
      include: { membershipPlan: true }
    });
    if (existingActiveMembership) {
      const error = new Error(`Customer already has an active membership: ${existingActiveMembership.membershipPlan?.name || "membership"}`);
      error.status = 400;
      throw error;
    }
  }

  const subtotal = itemDrafts.reduce((sum, item) => sum + toAmount(item.unitPrice) * Number(item.qty || 1), 0);
  const lineTax = inclusiveTax
    ? itemDrafts.reduce((sum, item) => {
        const preTax = toAmount(item.unitPrice) * Number(item.qty || 1);
        const taxPct = toAmount(item.taxPct);
        return sum + (taxPct > 0 ? (preTax * taxPct) / (100 + taxPct) : 0);
      }, 0)
    : itemDrafts.reduce((sum, item) => sum + ((toAmount(item.unitPrice) * Number(item.qty || 1)) * toAmount(item.taxPct)) / 100, 0);
  const manualDiscount = toAmount(body.discount);
  const extraTax = toAmount(body.tax);
  let coupon = null;
  let couponDiscount = 0;
  if (body.couponCode) {
    coupon = await prisma.coupon.findFirst({
      where: { salonId, code: body.couponCode, isArchived: false }
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
    if (coupon.minBillAmount != null && subtotal < toAmount(coupon.minBillAmount)) {
      const error = new Error("Minimum bill amount not reached for this coupon");
      error.status = 400;
      throw error;
    }
    if (coupon.branchId && coupon.branchId !== body.branchId) {
      const error = new Error("Coupon is not valid for this branch");
      error.status = 400;
      throw error;
    }
    if (coupon.serviceId && !itemDrafts.some((item) => item.serviceId === coupon.serviceId)) {
      const error = new Error("Coupon is not valid for the selected services");
      error.status = 400;
      throw error;
    }
    if (coupon.productId && !itemDrafts.some((item) => item.productId === coupon.productId)) {
      const error = new Error("Coupon is not valid for the selected products");
      error.status = 400;
      throw error;
    }
    if (body.customerId && coupon.customerUsageLimit != null) {
      const used = await prisma.couponRedemption.count({
        where: { couponId: coupon.id, customerId: body.customerId }
      });
      if (used >= coupon.customerUsageLimit) {
        const error = new Error("Customer usage limit reached for this coupon");
        error.status = 400;
        throw error;
      }
    }
    couponDiscount = coupon.discountType === "PERCENT"
      ? Math.min(subtotal, subtotal * (toAmount(coupon.discountValue) / 100))
      : Math.min(subtotal, toAmount(coupon.discountValue));
  }

  const loyaltyRule = body.loyaltyPointsUsed
    ? await prisma.loyaltyRule.findFirst({
        where: { salonId, isActive: true, OR: [{ branchId: body.branchId || null }, { branchId: null }] },
        orderBy: [{ branchId: "desc" }, { updatedAt: "desc" }]
      })
    : null;
  const loyaltyBalance = body.loyaltyPointsUsed ? await getCustomerValidLoyaltyBalance(body.customerId) : 0;
  let loyaltyDiscount = 0;
  if (Number(body.loyaltyPointsUsed || 0) > 0) {
    if (!loyaltyRule) {
      const error = new Error("No active loyalty rule found");
      error.status = 400;
      throw error;
    }
    const requestedPoints = Math.max(0, Number(body.loyaltyPointsUsed || 0));
    if (requestedPoints > loyaltyBalance) {
      const error = new Error("Customer does not have enough loyalty points");
      error.status = 400;
      throw error;
    }
    if (requestedPoints < Number(loyaltyRule.minRedeemPoints || 0)) {
      const error = new Error("Minimum loyalty redeem points not reached");
      error.status = 400;
      throw error;
    }
    const subtotalAfterCoupon = Math.max(0, subtotal - manualDiscount - couponDiscount);
    let redeemPointsPerRupee;
    try {
      const notes = JSON.parse(loyaltyRule.notes || "{}");
      const rPts = Number(notes.redeemPoints || 0);
      const rAmt = toNumber(notes.redeemAmount || 0);
      redeemPointsPerRupee = rAmt > 0 ? rPts / rAmt : null;
    } catch { redeemPointsPerRupee = null; }
    const pointsPerCurrency = redeemPointsPerRupee || toNumber(loyaltyRule.pointsPerCurrency) || 1;
    const pointsToCurrency = requestedPoints / pointsPerCurrency;
    let maxRedeemAmount = loyaltyRule.maxRedeemPercent != null
      ? (subtotalAfterCoupon * toAmount(loyaltyRule.maxRedeemPercent)) / 100
      : subtotalAfterCoupon;
    try {
      const notes = JSON.parse(loyaltyRule.notes || "{}");
      const maxPts = Number(notes.maxRedeemPoints || 0);
      if (maxPts > 0) {
        const maxFromPts = maxPts / pointsPerCurrency;
        maxRedeemAmount = Math.min(maxRedeemAmount, maxFromPts);
      }
    } catch {}
    loyaltyDiscount = Math.min(pointsToCurrency, maxRedeemAmount, subtotalAfterCoupon);
  }

  let giftCard = null;
  let giftCardPayment = 0;
  if (body.giftVoucherCode) {
    giftCard = await prisma.giftCard.findFirst({
      where: {
        salonId,
        code: body.giftVoucherCode,
        isActive: true,
        ...(body.customerId ? { OR: [{ issuedToCustomerId: body.customerId }, { issuedToCustomerId: null }] } : {})
      }
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
    giftCardPayment = Math.min(
      Math.max(0, subtotal + lineTax + extraTax - manualDiscount - couponDiscount - loyaltyDiscount),
      toAmount(giftCard.balanceAmount)
    );
  }

  const discount = manualDiscount + couponDiscount + loyaltyDiscount;
  const total = Math.max(0, subtotal + lineTax + extraTax - discount);
  const autoPayments = giftCardPayment > 0
    ? [{ mode: "WALLET", amount: giftCardPayment, note: `Gift card ${body.giftVoucherCode}`, type: "PAYMENT" }]
    : [];
  const allPayments = [...autoPayments, ...(body.payments || [])];
  const initialPaidAmount = allPayments.reduce((sum, payment) => sum + toAmount(payment.amount), 0);

  return prisma.$transaction(async (tx) => {
    const invoiceNumber = await createInvoiceNumber(tx, salonId, body.branchId || null);
    const invoice = await tx.invoice.create({
      data: {
        salonId,
        branchId: body.branchId || null,
        customerId: body.customerId,
        appointmentId: body.appointmentId || null,
        invoiceNumber,
        status: normalizeStatus(initialPaidAmount, total),
        subtotal,
        discount,
        tax: lineTax + extraTax,
        total,
        paidAmount: initialPaidAmount,
        balanceAmount: Math.max(0, total - initialPaidAmount),
        notes: buildInvoiceNotes(body),
        couponCode: coupon?.code || null,
        giftVoucherCode: giftCard?.code || null,
        loyaltyPointsUsed: loyaltyDiscount > 0 ? Number(body.loyaltyPointsUsed || 0) : null,
        items: {
          create: itemDrafts.map((item) => ({
            serviceId: item.serviceId || null,
            productId: item.productId || null,
            membershipPlanId: item.membershipPlanId || null,
            packageId: item.packageId || null,
            staffUserSalonId: item.staffUserSalonId || null,
            serviceName: item.serviceName,
            staffName: item.staffName,
            batchNumber: item.batchNumber || null,
            qty: item.qty,
            unitPrice: item.unitPrice,
            taxPct: item.taxPct,
            lineTotal: item.lineTotal,
            itemType: item.itemType,
            appliedBenefitType: item.appliedBenefitType || null,
            appliedBenefitValue: item.appliedBenefitValue || null,
            membershipWalletUsed: item.membershipWalletUsed || null,
            commissionAmount: item.commissionAmount || null
          }))
        }
      },
      include: { items: true }
    });

    await createPaymentRows(tx, salonId, invoice.id, allPayments);

    for (const item of itemDrafts) {
      if (item.itemType === "PRODUCT") {
        await createStockMovement(tx, {
          salonId,
          branchId: body.branchId || null,
          productId: item.productId,
          quantity: -Number(item.qty || 1),
          movementType: "POS_SALE",
          createdByUserId: actorUser.id,
          referenceType: "INVOICE",
          referenceId: invoice.id
        });
      }

      if (item.itemType === "MEMBERSHIP") {
        const plan = await tx.membershipPlan.findUnique({ where: { id: item.membershipPlanId } });
        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + Number(plan.validityDays) * 24 * 60 * 60 * 1000);
        await tx.customerMembership.create({
          data: {
            salonId,
            customerId: body.customerId,
            membershipPlanId: plan.id,
            soldInvoiceId: invoice.id,
            startsAt,
            endsAt,
            remainingWalletValue: plan.benefitType === "WALLET_VALUE" ? plan.walletValue : null
          }
        });
      }

      if (item.itemType === "PACKAGE") {
        const pack = await tx.package.findUnique({ where: { id: item.packageId } });
        const startsAt = new Date();
        const endsAt = new Date(startsAt.getTime() + Number(pack.validityDays) * 24 * 60 * 60 * 1000);
        await tx.customerPackage.create({
          data: {
            salonId,
            customerId: body.customerId,
            packageId: pack.id,
            soldInvoiceId: invoice.id,
            startsAt,
            endsAt,
            remainingSessions: Number(pack.totalSessions)
          }
        });
      }

      if (item.itemType === "GIFT_CARD") {
        const gcAmount = toAmount(item.unitPrice);
        const validityDays = Number(item.validityDays || 365);
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + validityDays);
        const gcCode = item.gcCode || `GC-${Date.now().toString(36).toUpperCase()}`;
        const gcTitle = item.serviceName || "Gift Card";
        await tx.giftCard.create({
          data: {
            salonId,
            issuedToCustomerId: body.customerId || null,
            soldInvoiceId: invoice.id,
            createdByMembershipId: actorUser.membershipId || null,
            code: gcCode,
            title: gcTitle,
            originalAmount: gcAmount,
            balanceAmount: gcAmount,
            expiresAt,
            isActive: true,
            note: item.note || null
          }
        });
      }
    }

    for (const item of body.items) {
      if (item.itemType === "SERVICE" && Array.isArray(item.consumableItems) && item.consumableItems.length > 0) {
        if (!allowEditConsumable) continue;
        for (const ci of item.consumableItems) {
          if (!ci.productId || Number(ci.qty) <= 0) continue;
          await createStockMovement(tx, {
            salonId,
            branchId: body.branchId || null,
            productId: ci.productId,
            quantity: -Number(ci.qty),
            movementType: "CONSUMABLE_USAGE",
            createdByUserId: actorUser.id,
            referenceType: "INVOICE",
            referenceId: invoice.id
          });
        }
      }
    }

    if (membership) {
      const walletUsed = itemDrafts.reduce((sum, item) => sum + toAmount(item.membershipWalletUsed), 0);
      if (walletUsed > 0) {
        await tx.customerMembership.update({
          where: { id: membership.id },
          data: { remainingWalletValue: Math.max(0, toAmount(membership.remainingWalletValue) - walletUsed) }
        });
        await tx.membershipUsage.create({
          data: {
            customerMembershipId: membership.id,
            invoiceId: invoice.id,
            amountUsed: walletUsed,
            note: "Applied in POS invoice"
          }
        });
      }
    }

    for (const redemption of body.packageRedemptions || []) {
      const customerPackage = await ensureActiveCustomerPackage(salonId, redemption.customerPackageId);
      const sessionsUsed = Number(redemption.sessionsUsed || 1);
      if (customerPackage.remainingSessions < sessionsUsed) {
        const error = new Error(`Package ${customerPackage.package.name} does not have enough sessions`);
        error.status = 400;
        throw error;
      }
      await tx.customerPackage.update({
        where: { id: customerPackage.id },
        data: {
          remainingSessions: customerPackage.remainingSessions - sessionsUsed,
          status: customerPackage.remainingSessions - sessionsUsed <= 0 ? "FULLY_USED" : customerPackage.status
        }
      });
      await tx.packageUsage.create({
        data: {
          customerPackageId: customerPackage.id,
          invoiceId: invoice.id,
          serviceId: redemption.serviceId,
          sessionsUsed,
          note: redemption.note || "Redeemed in POS"
        }
      });
    }

    if (coupon && couponDiscount > 0) {
      await tx.couponRedemption.create({
        data: {
          salonId,
          couponId: coupon.id,
          customerId: body.customerId,
          invoiceId: invoice.id,
          amountSaved: couponDiscount
        }
      });
      await tx.coupon.update({
        where: { id: coupon.id },
        data: { usageCount: { increment: 1 } }
      });
    }

    if (giftCard && giftCardPayment > 0) {
      await tx.giftCard.update({
        where: { id: giftCard.id },
        data: { balanceAmount: Math.max(0, toAmount(giftCard.balanceAmount) - giftCardPayment) }
      });
      await tx.giftCardRedemption.create({
        data: {
          salonId,
          giftCardId: giftCard.id,
          customerId: body.customerId,
          invoiceId: invoice.id,
          amountUsed: giftCardPayment
        }
      });
    }

    const currentCustomer = await tx.customer.findUnique({
      where: { id: body.customerId },
      select: { loyaltyPoints: true }
    });
    let runningLoyaltyBalance = Number(currentCustomer?.loyaltyPoints || 0);
    if (loyaltyDiscount > 0) {
      const redeemedPoints = Number(body.loyaltyPointsUsed || 0);
      runningLoyaltyBalance -= redeemedPoints;
      await tx.customer.update({
        where: { id: body.customerId },
        data: { loyaltyPoints: runningLoyaltyBalance }
      });
      await tx.loyaltyTransaction.create({
        data: {
          salonId,
          branchId: body.branchId || null,
          customerId: body.customerId,
          invoiceId: invoice.id,
          createdByMembershipId: actorUser.membershipId || null,
          type: "REDEEM",
          points: -redeemedPoints,
          balanceAfter: runningLoyaltyBalance,
          note: `Redeemed on invoice ${invoice.invoiceNumber}`
        }
      });
    }

    const earnedPoints = calculateLoyaltyEarnPoints({
      rule: loyaltyRule,
      invoiceSubtotal: Math.max(0, subtotal - discount),
      items: itemDrafts
    });
    if (earnedPoints > 0 && loyaltyRule) {
      const skipEarnOnRedemption = (() => {
        try { return JSON.parse(loyaltyRule.notes || "{}").skipEarnOnRedemption === true; } catch { return false; }
      })();
      const isRedeeming = Number(body.loyaltyPointsUsed || 0) > 0;
      if (!(skipEarnOnRedemption && isRedeeming)) {
        runningLoyaltyBalance += earnedPoints;
        const expiresAt = loyaltyRule.expiryDays
          ? new Date(Date.now() + Number(loyaltyRule.expiryDays) * 24 * 60 * 60 * 1000)
          : null;
        await tx.customer.update({
          where: { id: body.customerId },
          data: { loyaltyPoints: runningLoyaltyBalance }
        });
        await tx.loyaltyTransaction.create({
          data: {
            salonId,
            branchId: body.branchId || null,
            customerId: body.customerId,
            invoiceId: invoice.id,
            createdByMembershipId: actorUser.membershipId || null,
            type: "EARN",
            points: earnedPoints,
            balanceAfter: runningLoyaltyBalance,
            expiresAt,
            note: `Earned from invoice ${invoice.invoiceNumber}`
          }
        });
      }
    }

    if (loyaltyRule && Number(loyaltyRule.birthdayPoints || 0) > 0) {
      const customer = await tx.customer.findUnique({ where: { id: body.customerId }, select: { dateOfBirth: true } });
      if (customer?.dateOfBirth) {
        const today = new Date();
        const dob = new Date(customer.dateOfBirth);
        if (dob.getUTCDate() === today.getUTCDate() && dob.getUTCMonth() === today.getUTCMonth()) {
          const bdayPoints = Number(loyaltyRule.birthdayPoints);
          runningLoyaltyBalance += bdayPoints;
          const expiresAt = loyaltyRule.expiryDays
            ? new Date(Date.now() + Number(loyaltyRule.expiryDays) * 24 * 60 * 60 * 1000)
            : null;
          await tx.customer.update({
            where: { id: body.customerId },
            data: { loyaltyPoints: runningLoyaltyBalance }
          });
          await tx.loyaltyTransaction.create({
            data: {
              salonId,
              branchId: body.branchId || null,
              customerId: body.customerId,
              invoiceId: invoice.id,
              createdByMembershipId: actorUser.membershipId || null,
              type: "BONUS",
              points: bdayPoints,
              balanceAfter: runningLoyaltyBalance,
              expiresAt,
              note: `Birthday bonus for ${customer.dateOfBirth.toISOString().slice(0, 10)}`
            }
          });
        }
      }
    }

    if (body.appointmentId) {
      await tx.appointment.update({
        where: { id: body.appointmentId },
        data: { convertedInvoiceId: invoice.id }
      });
    }

    await logCustomerTimeline(tx, body.customerId, "INVOICE", "POS invoice created", invoice.invoiceNumber, invoice.id);
    await refreshCustomerInsights(tx, body.customerId);
    return tx.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true, customer: true, branch: true, payments: true }
    });
  });
};

export const addInvoicePayment = async ({ salonId, invoiceId, amount, mode, note, actorUser }) => {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, salonId },
      include: { payments: true }
    });
    if (!invoice) {
      const error = new Error("Invoice not found");
      error.status = 404;
      throw error;
    }
    if (["CANCELLED", "REFUNDED"].includes(invoice.status)) {
      const error = new Error("This invoice cannot accept more payments");
      error.status = 400;
      throw error;
    }
    const nextPaid = toAmount(invoice.paidAmount) + toAmount(amount);
    if (nextPaid > toAmount(invoice.total)) {
      const error = new Error("Payment exceeds invoice total");
      error.status = 400;
      throw error;
    }
    const payment = await tx.payment.create({
      data: {
        salonId,
        invoiceId: invoice.id,
        amount: toAmount(amount),
        mode,
        note: note || null,
        type: "PAYMENT"
      }
    });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        paidAmount: nextPaid,
        balanceAmount: Math.max(0, toAmount(invoice.total) - nextPaid),
        status: normalizeStatus(nextPaid, toAmount(invoice.total), toAmount(invoice.refundAmount))
      }
    });
    return payment;
  });
};

export const refundInvoice = async ({ salonId, invoiceId, amount, note, actorUser }) => {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId, salonId },
      include: { items: true, payments: true }
    });
    if (!invoice) {
      const error = new Error("Invoice not found");
      error.status = 404;
      throw error;
    }
    if (toAmount(amount) > toAmount(invoice.paidAmount) - toAmount(invoice.refundAmount)) {
      const error = new Error("Refund exceeds available paid amount");
      error.status = 400;
      throw error;
    }

    await tx.payment.create({
      data: {
        salonId,
        invoiceId: invoice.id,
        amount: -Math.abs(toAmount(amount)),
        mode: "ONLINE",
        note: note || "Refund",
        type: "REFUND"
      }
    });

    for (const item of invoice.items) {
      if (item.itemType === "PRODUCT" && item.productId) {
        await createStockMovement(tx, {
          salonId,
          branchId: invoice.branchId,
          productId: item.productId,
          quantity: Number(item.qty || 1),
          movementType: "PRODUCT_RETURN",
          createdByUserId: actorUser.id,
          referenceType: "REFUND",
          referenceId: invoice.id
        });
      }
    }

    const packageUsages = await tx.packageUsage.findMany({ where: { invoiceId: invoice.id } });
    for (const usage of packageUsages) {
      const customerPackage = await tx.customerPackage.findUnique({ where: { id: usage.customerPackageId } });
      if (customerPackage) {
        await tx.customerPackage.update({
          where: { id: customerPackage.id },
          data: {
            remainingSessions: customerPackage.remainingSessions + usage.sessionsUsed,
            status: "ACTIVE"
          }
        });
      }
    }

    const membershipUsages = await tx.membershipUsage.findMany({ where: { invoiceId: invoice.id } });
    for (const usage of membershipUsages) {
      const customerMembership = await tx.customerMembership.findUnique({ where: { id: usage.customerMembershipId } });
      if (customerMembership && usage.amountUsed) {
        await tx.customerMembership.update({
          where: { id: customerMembership.id },
          data: { remainingWalletValue: toAmount(customerMembership.remainingWalletValue) + toAmount(usage.amountUsed) }
        });
      }
    }

    await tx.customerMembership.updateMany({
      where: { soldInvoiceId: invoice.id },
      data: { status: "CANCELLED" }
    });
    await tx.customerPackage.updateMany({
      where: { soldInvoiceId: invoice.id },
      data: { status: "CANCELLED" }
    });

    await reverseInvoiceLoyalty(tx, invoice, actorUser);

    const nextRefundAmount = toAmount(invoice.refundAmount) + toAmount(amount);
    const nextStatus = normalizeStatus(toAmount(invoice.paidAmount), toAmount(invoice.total), nextRefundAmount, false);
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        refundAmount: nextRefundAmount,
        balanceAmount: Math.max(0, toAmount(invoice.total) - Math.max(0, toAmount(invoice.paidAmount) - nextRefundAmount)),
        status: nextStatus
      }
    });
    await refreshCustomerInsights(tx, invoice.customerId);
    return tx.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true, customer: true, branch: true, payments: true }
    });
  });
};

export const generatePaymentLink = async ({ salonId, invoiceId, expiresAt, gatewayName, note }) => {
  const token = crypto.randomBytes(20).toString("hex");
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, salonId } });
  if (!invoice) {
    const error = new Error("Invoice not found");
    error.status = 404;
    throw error;
  }
  return prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      paymentLinkToken: token,
      paymentLinkStatus: "PENDING",
      paymentLinkExpiresAt: expiresAt ? new Date(expiresAt) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      notes: note ? `${invoice.notes || ""}\nPayment Link: ${note}`.trim() : invoice.notes
    }
  });
};

export const logPaymentLinkPlaceholder = async ({ salonId, invoiceId, status, note, gatewayRef }) => {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: invoiceId, salonId } });
    if (!invoice) {
      const error = new Error("Invoice not found");
      error.status = 404;
      throw error;
    }

    const normalizedStatus = status === "PAID_PLACEHOLDER" ? "PAID" : status;
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        paymentLinkStatus: normalizedStatus,
        notes: [invoice.notes, note ? `Payment Link ${status}: ${note}` : `Payment Link ${status}`].filter(Boolean).join("\n")
      }
    });

    return tx.payment.create({
      data: {
        salonId,
        invoiceId: invoice.id,
        amount: 0,
        mode: "ONLINE",
        note: note || `Payment link ${status.toLowerCase()} placeholder`,
        type: status === "FAILED" ? "PAYMENT_LINK_FAILED" : status === "SENT" ? "PAYMENT_LINK_SENT" : "PAYMENT_LINK_PAID_PLACEHOLDER",
        onlineStatus: normalizedStatus,
        gatewayRef: gatewayRef || null
      }
    });
  });
};

export const getDayClosingSummary = async ({ salonId, branchId, date }) => {
  const start = new Date(date || new Date());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const invoices = await prisma.invoice.findMany({
    where: {
      salonId,
      ...(branchId ? { branchId } : {}),
      createdAt: { gte: start, lt: end }
    },
    include: { payments: true }
  });

  const payments = invoices.flatMap((invoice) => invoice.payments);
  const paymentSummary = payments.reduce((acc, payment) => {
    acc[payment.mode] = (acc[payment.mode] || 0) + toAmount(payment.amount);
    return acc;
  }, {});

  return {
    invoiceCount: invoices.length,
    grossSales: invoices.reduce((sum, invoice) => sum + toAmount(invoice.total), 0),
    paidAmount: invoices.reduce((sum, invoice) => sum + toAmount(invoice.paidAmount), 0),
    refunds: invoices.reduce((sum, invoice) => sum + toAmount(invoice.refundAmount), 0),
    cashDrawer: toAmount(paymentSummary.CASH || 0),
    paymentSummary
  };
};
