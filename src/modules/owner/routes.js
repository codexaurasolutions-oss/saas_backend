import { Router } from "express";
import bcrypt from "bcryptjs";
import XLSX from "xlsx";
import { prisma } from "../../lib/prisma.js";
import { attachBranchStock, refreshCustomerInsights } from "../../lib/phase2.js";
import { getCampaignAudience, getSalonGenericSettings } from "../../lib/phase3.js";
import { createAuditLog } from "../../lib/phase4.js";
import { patchRouterForAsync } from "../../lib/async-handler.js";
import { requireAuth, requireMaintenanceAccess, requireSalonContext, requireSalonPermission, attachSalonSettings } from "../../middlewares/rbac.js";
import { schemas, validate } from "../../middlewares/validate.js";
import { registerPhase2OwnerRoutes } from "./phase2/index.js";
import { registerPhase3OwnerRoutes } from "./phase3/index.js";
import { registerPhase4OwnerRoutes } from "./phase4/index.js";

export const ownerRouter = Router();
patchRouterForAsync(ownerRouter);
ownerRouter.use(requireAuth, requireMaintenanceAccess, requireSalonContext);

const findScoped = (model, salonId, id) => prisma[model].findFirst({ where: { id, salonId } });
const toAmount = (value) => Number(value || 0);
const normalizeBranchId = (value) => (value ? String(value) : null);
const withBranchFilter = (salonId, branchId) => ({ salonId, ...(branchId ? { branchId } : {}) });
const paymentWhere = (salonId, branchId) => ({ salonId, ...(branchId ? { invoice: { is: { branchId } } } : {}) });

const resolveSalonDefaultTaxRate = async (salonId) => {
  const [salon, settingsRow] = await Promise.all([
    prisma.salon.findUnique({
      where: { id: salonId },
      select: { taxRate: true }
    }),
    prisma.salonSetting.findFirst({
      where: { salonId, branchId: null },
      select: { advancedSettings: true }
    })
  ]);

  const advancedSettings = settingsRow?.advancedSettings && typeof settingsRow.advancedSettings === "object"
    ? settingsRow.advancedSettings
    : {};
  const taxMappingRates = Array.isArray(advancedSettings?.taxMapping?.rates)
    ? advancedSettings.taxMapping.rates
    : [];
  const pnlIncomeTaxes = Array.isArray(advancedSettings?.pnlIncomeTaxes)
    ? advancedSettings.pnlIncomeTaxes
    : [];

  const mappedRate = taxMappingRates.find((row) => row?.active !== false && row?.rate != null)?.rate;
  if (mappedRate != null) return toAmount(mappedRate);

  const pnlRate = pnlIncomeTaxes.find((row) => row?.active !== false && row?.rate != null)?.rate;
  if (pnlRate != null) return toAmount(pnlRate);

  return salon?.taxRate != null ? toAmount(salon.taxRate) : null;
};

const getActivePlanForSalon = async (salonId) => {
  const subscription = await prisma.subscription.findFirst({
    where: { salonId, status: { in: ["ACTIVE", "TRIAL"] } },
    include: { plan: true },
    orderBy: { endsAt: "desc" }
  });
  return subscription?.plan || null;
};

const ensureBranch = async (salonId, branchId) => {
  if (!branchId) return null;
  const branch = await prisma.branch.findFirst({ where: { id: branchId, salonId, isActive: true } });
  if (!branch) {
    const error = new Error("Active branch not found");
    error.status = 400;
    throw error;
  }
  return branch;
};

const ensureServiceCategory = async (salonId, categoryId) => {
  if (!categoryId) return null;
  const category = await findScoped("serviceCategory", salonId, categoryId);
  if (!category || !category.isActive) {
    const error = new Error("Active service category not found");
    error.status = 400;
    throw error;
  }
  return category;
};

const hasPermission = (req, moduleKey, action = "view") => (
  req.user.systemRole === "SUPER_ADMIN" || req.user.permissions?.[moduleKey]?.includes(action)
);

const normalizeDateValue = (value) => (value ? new Date(value) : null);
const sanitizeTagList = (value) => Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
const pickBoolean = (value, fallback) => (typeof value === "boolean" ? value : fallback);
const weekKeyToIndex = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const syncGenericSettingsToPublicChannels = async (salonId, payload) => {
  const generic = payload.advancedSettings?.genericSettings;
  if (!generic || typeof generic !== "object") return;

  const [catalogSettings, ecommerceSettings, appointmentSetting] = await Promise.all([
    prisma.catalogSetting.findFirst({ where: { salonId, branchId: null } }),
    prisma.ecommerceSetting.findUnique({ where: { salonId } }),
    prisma.appointmentSetting.findFirst({ where: { salonId, branchId: null } })
  ]);

  const catalogPayload = {
    showProducts: pickBoolean(generic.showProductsOnHome, catalogSettings?.showProducts ?? true),
    whatsappNumber: payload.whatsappNumber || catalogSettings?.whatsappNumber || null,
    branchDisplaySettings: {
      ...(typeof catalogSettings?.branchDisplaySettings === "object" && catalogSettings.branchDisplaySettings ? catalogSettings.branchDisplaySettings : {}),
      showAllBranchesInCatalogue: pickBoolean(generic.showAllBranchesInCatalogue, false),
      applicableFor: String(generic.applicableFor || "both").toLowerCase(),
      weeklyOff: Array.isArray(generic.weeklyOff) ? generic.weeklyOff : [],
      businessStart: generic.businessStart || "09:00",
      businessEnd: generic.businessEnd || "21:00"
    }
  };

  if (catalogSettings) {
    await prisma.catalogSetting.update({ where: { id: catalogSettings.id }, data: catalogPayload });
  } else {
    await prisma.catalogSetting.create({
      data: {
        salonId,
        branchId: null,
        catalogEnabled: true,
        showServices: true,
        showPackages: true,
        showMemberships: true,
        showStaffPortfolio: true,
        ...catalogPayload
      }
    });
  }

  const ecommercePayload = {
    storeEnabled: pickBoolean(generic.productOrderingEnabled, ecommerceSettings?.storeEnabled ?? false),
    allowOnlinePayment: pickBoolean(generic.onlinePaymentEnabled, ecommerceSettings?.allowOnlinePayment ?? false),
    allowPayAtSalon: pickBoolean(generic.cashOnPickupEnabled, ecommerceSettings?.allowPayAtSalon ?? true),
    allowCod: pickBoolean(generic.cashOnDeliveryEnabled, ecommerceSettings?.allowCod ?? true),
    pickupEnabled: pickBoolean(generic.pickupOrderingEnabled, ecommerceSettings?.pickupEnabled ?? true),
    deliveryEnabled: pickBoolean(generic.homeDeliveryEnabled, ecommerceSettings?.deliveryEnabled ?? false),
    deliveryNote: generic.deliveryDisclaimer || ecommerceSettings?.deliveryNote || null,
    supportPhone: payload.whatsappNumber || ecommerceSettings?.supportPhone || null,
    termsText: payload.cancellationPolicy || ecommerceSettings?.termsText || null
  };

  if (ecommerceSettings) {
    await prisma.ecommerceSetting.update({ where: { id: ecommerceSettings.id }, data: ecommercePayload });
  } else {
    await prisma.ecommerceSetting.create({ data: { salonId, ...ecommercePayload } });
  }

  const appointmentPayload = {
    salonId,
    branchId: null,
    onlineBookingEnabled: generic.businessOpen !== false && generic.appointmentBookingEnabled !== false,
    autoConfirm: appointmentSetting?.autoConfirm ?? true,
    advancePaymentRequired: appointmentSetting?.advancePaymentRequired ?? false
  };

  if (appointmentSetting) {
    await prisma.appointmentSetting.update({ where: { id: appointmentSetting.id }, data: appointmentPayload });
  } else {
    await prisma.appointmentSetting.create({ data: appointmentPayload });
  }
};

const syncAdvancedSettingsToOperationalDefaults = async (salonId, payload) => {
  const advancedSettings = payload.advancedSettings && typeof payload.advancedSettings === "object" ? payload.advancedSettings : {};
  const loyaltySettings = advancedSettings.loyaltySettings && typeof advancedSettings.loyaltySettings === "object" ? advancedSettings.loyaltySettings : null;
  const membershipSettings = advancedSettings.membershipSettings && typeof advancedSettings.membershipSettings === "object" ? advancedSettings.membershipSettings : null;
  const packageSettings = advancedSettings.packageSettings && typeof advancedSettings.packageSettings === "object" ? advancedSettings.packageSettings : null;
  const giftCardSettings = advancedSettings.giftCardSettings && typeof advancedSettings.giftCardSettings === "object" ? advancedSettings.giftCardSettings : null;
  const incentiveSettings = advancedSettings.incentiveSettings && typeof advancedSettings.incentiveSettings === "object" ? advancedSettings.incentiveSettings : null;
  const taxMapping = advancedSettings.taxMapping && typeof advancedSettings.taxMapping === "object" ? advancedSettings.taxMapping : null;
  const rosterManagement = advancedSettings.rosterManagement && typeof advancedSettings.rosterManagement === "object" ? advancedSettings.rosterManagement : null;
  const pnlCategories = Array.isArray(advancedSettings.pnlCategories) ? advancedSettings.pnlCategories : [];
  const pnlIncomeTaxes = Array.isArray(advancedSettings.pnlIncomeTaxes) ? advancedSettings.pnlIncomeTaxes : [];
  const referralSettings = advancedSettings.referralSettings && typeof advancedSettings.referralSettings === "object" ? advancedSettings.referralSettings : null;

  if (loyaltySettings) {
    const existingRule = await prisma.loyaltyRule.findFirst({
      where: { salonId, branchId: null, name: "Settings Default Rule" }
    });

    const earnAmount = toAmount(loyaltySettings.serviceEarning?.amount || 100);
    const earnPoints = Number(loyaltySettings.serviceEarning?.points || 1);
    const pointsPerCurrency = earnAmount > 0 ? earnPoints / earnAmount : 1;

    const svcAmt = toAmount(loyaltySettings.serviceEarning?.amount || 100);
    const svcPts = Number(loyaltySettings.serviceEarning?.points || 1);
    const prodAmt = toAmount(loyaltySettings.productEarning?.amount || 100);
    const prodPts = Number(loyaltySettings.productEarning?.points || 1);
    const pkgAmt = toAmount(loyaltySettings.packageEarning?.amount || 100);
    const pkgPts = Number(loyaltySettings.packageEarning?.points || 1);

    const serviceMultiplier = loyaltySettings.earnIndividually && svcAmt > 0 ? svcPts : null;
    const productMultiplier = loyaltySettings.earnIndividually && prodAmt > 0 ? prodPts : null;

    const redeemPts = Number(loyaltySettings.redeemPoints || 100);
    const redeemAmt = toAmount(loyaltySettings.redeemAmount || 10);
    const redeemRate = redeemPts > 0 ? redeemPts / redeemAmt : 10;

    const rulePayload = {
      pointsPerCurrency,
      serviceMultiplier,
      productMultiplier,
      minRedeemPoints: Number(loyaltySettings.minRedeemPoints ?? 100),
      maxRedeemPercent: loyaltySettings.maxRedeemPercent ?? null,
      expiryDays: loyaltySettings.expiryDays ?? null,
      isActive: loyaltySettings.enabled !== false,
      notes: JSON.stringify({
        earnIndividually: loyaltySettings.earnIndividually,
        skipEarnOnRedemption: loyaltySettings.skipEarnOnRedemption,
        earnOnMembershipApplied: loyaltySettings.earnOnMembershipApplied,
        serviceEarning: loyaltySettings.serviceEarning,
        productEarning: loyaltySettings.productEarning,
        packageEarning: loyaltySettings.packageEarning,
        redeemIndividually: loyaltySettings.redeemIndividually,
        redeemPoints: loyaltySettings.redeemPoints,
        redeemAmount: loyaltySettings.redeemAmount,
        maxRedeemPoints: loyaltySettings.maxRedeemPoints
      })
    };

    if (existingRule) {
      await prisma.loyaltyRule.update({ where: { id: existingRule.id }, data: rulePayload });
    } else {
      await prisma.loyaltyRule.create({
        data: {
          salonId,
          branchId: null,
          name: "Settings Default Rule",
          ...rulePayload
        }
      });
    }
  }

  if (membershipSettings) {
    await prisma.membershipPlan.updateMany({
      where: { salonId },
      data: { isActive: membershipSettings.enabled !== false }
    });
  }

  if (packageSettings) {
    await prisma.package.updateMany({
      where: { salonId },
      data: { isActive: packageSettings.enabled !== false }
    });
  }

  if (giftCardSettings) {
    await prisma.giftCard.updateMany({
      where: { salonId },
      data: { isActive: giftCardSettings.enabled !== false }
    });
  }

  if (incentiveSettings) {
    const existingIncentiveRule = await prisma.incentiveRule.findFirst({
      where: { salonId, name: "Settings Default Incentive" }
    });
    const incentivePayload = {
      targetType: String(incentiveSettings.payoutBasis || "revenue").toUpperCase(),
      minTarget: null,
      incentiveAmount: toAmount(incentiveSettings.defaultAmount ?? 0),
      isActive: incentiveSettings.enabled !== false,
      notes: incentiveSettings.notes || "Managed from Settings > Incentive"
    };

    if (existingIncentiveRule) {
      await prisma.incentiveRule.update({ where: { id: existingIncentiveRule.id }, data: incentivePayload });
    } else {
      await prisma.incentiveRule.create({
        data: {
          salonId,
          name: "Settings Default Incentive",
          ...incentivePayload
        }
      });
    }
  }

  if (taxMapping?.rates?.length) {
    const primaryTax = taxMapping.rates.find((row) => row?.active !== false) || taxMapping.rates[0];
    if (primaryTax) {
      const applicableFor = Array.isArray(primaryTax.applicableFor) ? primaryTax.applicableFor : ["SERVICE", "PRODUCT"];
      if (applicableFor.includes("SERVICE")) {
        await prisma.service.updateMany({
          where: { salonId, isActive: true, taxRate: null },
          data: { taxRate: toAmount(primaryTax.rate ?? 0) }
        });
      }
      if (applicableFor.includes("PRODUCT")) {
        // Products use tax mapping at checkout, no per-product taxPct field needed
      }
    }
  }

  if (pnlIncomeTaxes.length) {
    const primaryIncomeTax = pnlIncomeTaxes.find((row) => row?.active !== false) || pnlIncomeTaxes[0];
    if (primaryIncomeTax) {
      const nextTaxRate = toAmount(primaryIncomeTax.rate ?? 0);
      await prisma.salon.update({
        where: { id: salonId },
        data: { taxRate: nextTaxRate }
      });
      await prisma.service.updateMany({
        where: { salonId, isActive: true, taxRate: null },
        data: { taxRate: nextTaxRate }
      });
    }
  }

  if (rosterManagement?.rows?.length) {
    const rosterDate = rosterManagement.selectedDate ? new Date(rosterManagement.selectedDate) : new Date();
    const weekday = Number.isNaN(rosterDate.getTime()) ? new Date().getDay() : rosterDate.getDay();
    const staffIds = rosterManagement.rows.map((row) => String(row.id)).filter(Boolean);
    const existingMemberships = await prisma.userSalon.findMany({
      where: { salonId, id: { in: staffIds }, isArchived: false },
      select: { id: true, branchId: true }
    });
    const membershipMap = new Map(existingMemberships.map((row) => [row.id, row]));

    for (const row of rosterManagement.rows) {
      const membership = membershipMap.get(String(row.id));
      if (!membership) continue;
      await prisma.staffSchedule.upsert({
        where: { userSalonId_weekday: { userSalonId: membership.id, weekday } },
        update: {
          branchId: membership.branchId || null,
          startTime: row.fromTime || "09:00",
          endTime: row.toTime || "21:00",
          isOffDay: row.isWorking === false
        },
        create: {
          salonId,
          branchId: membership.branchId || null,
          userSalonId: membership.id,
          weekday,
          startTime: row.fromTime || "09:00",
          endTime: row.toTime || "21:00",
          isOffDay: row.isWorking === false
        }
      });
    }
  }

  if (pnlCategories.length) {
    const expenseLikeRows = pnlCategories.filter((row) => {
      const type = String(row?.type || "").trim().toLowerCase();
      return row?.active !== false && type && type !== "income";
    });
    for (const row of expenseLikeRows) {
      const name = String(row.name || "").trim();
      if (!name) continue;
      await prisma.expenseCategory.upsert({
        where: { salonId_name: { salonId, name } },
        update: {
          description: row.type ? `Managed from Settings > PNL Categories (${row.type})` : "Managed from Settings > PNL Categories"
        },
        create: {
          salonId,
          name,
          description: row.type ? `Managed from Settings > PNL Categories (${row.type})` : "Managed from Settings > PNL Categories"
        }
      });
    }
  }

  if (payload.smsSettings || advancedSettings.notificationSettings) {
    const smsSettings = payload.smsSettings && typeof payload.smsSettings === "object" ? payload.smsSettings : {};
    const notificationSettings = advancedSettings.notificationSettings && typeof advancedSettings.notificationSettings === "object"
      ? advancedSettings.notificationSettings
      : {};
    const existingWhatsappSettings = await prisma.whatsAppSetting.findFirst({ where: { salonId } });
    const whatsappPayload = {
      providerName: smsSettings.gatewayProvider ? String(smsSettings.gatewayProvider).replace("_PLACEHOLDER", "") : existingWhatsappSettings?.providerName || null,
      senderName: smsSettings.senderId || existingWhatsappSettings?.senderName || null,
      apiKeyPlaceholder: smsSettings.apiKey ? "Configured from Settings > SMS Center" : existingWhatsappSettings?.apiKeyPlaceholder || null,
      automationEnabled: notificationSettings.whatsappEnabled !== false,
      deliveryStatusEnabled: existingWhatsappSettings?.deliveryStatusEnabled ?? false,
      readStatusEnabled: existingWhatsappSettings?.readStatusEnabled ?? false
    };

    if (existingWhatsappSettings) {
      await prisma.whatsAppSetting.update({ where: { id: existingWhatsappSettings.id }, data: whatsappPayload });
    } else {
      await prisma.whatsAppSetting.create({ data: { salonId, ...whatsappPayload } });
    }
  }

  if (referralSettings) {
    const referralCoupon = await prisma.coupon.findFirst({
      where: { salonId, code: "REFERRAL-DEFAULT" }
    });

    const referrerFixed = toAmount(referralSettings.referrerFixedAmount ?? 0);
    const referrerPct = toAmount(referralSettings.referrerPercentage ?? 0);
    const referrerMax = toAmount(referralSettings.referrerMaxBenefitAmount ?? 0);
    const referredFixed = toAmount(referralSettings.referredFixedAmount ?? 0);
    const referredPct = toAmount(referralSettings.referredPercentage ?? 0);
    const referredMax = toAmount(referralSettings.referredMaxBenefitAmount ?? 0);

    const referredDiscountType = referredFixed > 0 ? "FIXED" : "PERCENT";
    const referredDiscountValue = referredFixed > 0 ? referredFixed : referredPct;

    const referrerDescription = referrerFixed > 0
      ? `Referrer: ₹${referrerFixed} fixed (max ₹${referrerMax})`
      : `Referrer: ${referrerPct}% (max ₹${referrerMax})`;
    const referredDescription = referredFixed > 0
      ? `Referred guest: ₹${referredFixed} fixed (max ₹${referredMax})`
      : `Referred guest: ${referredPct}% (max ₹${referredMax})`;

    const referralPayload = {
      title: "Referral Welcome Offer",
      description: `Auto-managed from Settings > Referrals. ${referrerDescription}. ${referredDescription}. Max limit: ${referralSettings.maxReferLimit || 0}.`,
      discountType: referredDiscountType,
      discountValue: referredDiscountValue,
      minBillAmount: 0,
      usageLimit: referralSettings.maxReferLimit ? Number(referralSettings.maxReferLimit) : null,
      customerUsageLimit: 1,
      startsAt: null,
      endsAt: null,
      isReferral: true,
      isInfluencer: false,
      isBirthday: false,
      isFestival: false,
      isArchived: referralSettings.enabled === false,
      notes: JSON.stringify({
        referrer: { maxBenefit: referrerMax, fixedAmount: referrerFixed, percentage: referrerPct },
        referred: { maxBenefit: referredMax, fixedAmount: referredFixed, percentage: referredPct }
      })
    };

    if (referralCoupon) {
      await prisma.coupon.update({
        where: { id: referralCoupon.id },
        data: referralPayload
      });
    } else {
      await prisma.coupon.create({
        data: {
          salonId,
          code: "REFERRAL-DEFAULT",
          ...referralPayload
        }
      });
    }
  }
};

const buildCustomerData = (payload, salonId) => ({
  name: payload.name,
  phone: payload.phone,
  email: payload.email || null,
  gender: payload.gender || null,
  dateOfBirth: normalizeDateValue(payload.dateOfBirth),
  anniversary: normalizeDateValue(payload.anniversary),
  source: payload.source || null,
  tags: sanitizeTagList(payload.tags),
  notes: payload.notes || null,
  preferences: payload.preferences || null,
  preferredStaffId: payload.preferredStaffId || null,
  allergies: payload.allergies || null,
  skinNotes: payload.skinNotes || null,
  ...(salonId ? { salonId } : {})
});

const formatCustomerReferralCode = (customer) => {
  const assignedCouponCode = customer.coupons?.find((row) => row.code)?.code;
  if (assignedCouponCode) return assignedCouponCode;
  return `RF${String(customer.id || "").slice(-6).toUpperCase()}`;
};

const summarizeCustomerForCrm = (customer) => {
  const activeMembershipCount = (customer.memberships || []).filter((row) => (
    row.status === "ACTIVE" && (!row.endsAt || new Date(row.endsAt) >= new Date())
  )).length;
  const advanceAmount = (customer.appointments || []).reduce((sum, row) => (
    sum + toAmount(row.advancePaidAmount)
  ), 0);
  const balanceAmount = (customer.invoices || []).reduce((sum, row) => {
    if (["CANCELLED", "REFUNDED"].includes(row.status)) return sum;
    return sum + toAmount(row.balanceAmount);
  }, 0);

  return {
    ...customer,
    totalOrders: customer.totalOrders || customer.invoices?.length || 0,
    onlineVisits: customer.orders?.length || 0,
    loyalty: customer.loyaltyPoints || 0,
    referralCode: formatCustomerReferralCode(customer),
    advanceAmount,
    balanceAmount,
    membershipCount: customer.memberships?.length || 0,
    activeMembershipCount,
    packageCount: customer.packages?.length || 0
  };
};
const resolveMembershipPermissions = async (salonId, customRoleId, explicitPermissions) => {
  let role = null;
  if (customRoleId) {
    role = await prisma.customRole.findFirst({ where: { id: customRoleId, salonId } });
    if (!role) {
      const error = new Error("Custom role not found");
      error.status = 400;
      throw error;
    }
  }
  if (explicitPermissions) return explicitPermissions;
  if (role) return role.permissions || {};
  return {};
};

const createLoginUserForSalon = async (salonId, payload) => {
  const { 
    name, email, password, salonRole, branchId: rawBranchId, customRoleId, permissions, 
    phone, profileNote, avatarUrl, roleTitle, showInCatalog, serviceIds = [],
    joiningDate, designation, uanNumber, reportingToId, workingHours,
    bankName, bankBranch, accountNumber, ifscCode,
    firstName, lastName, dateOfBirth, gender, username,
    enableAppointments, showAllStaffAppointments, workExperience, documents
  } = payload;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { status: 400, body: { message: "Email already exists" } };

  const plan = await getActivePlanForSalon(salonId);
  if (plan) {
    const userCount = await prisma.userSalon.count({ where: { salonId } });
    if (userCount >= plan.userLimit) {
      return { status: 403, body: { message: "User limit reached for current plan" } };
    }
  }

  const branchId = normalizeBranchId(rawBranchId);
  if (branchId) await ensureBranch(salonId, branchId);
  const resolvedPermissions = await resolveMembershipPermissions(salonId, customRoleId, permissions);

  if (serviceIds.length) {
    const services = await prisma.service.findMany({ where: { id: { in: serviceIds }, salonId, isActive: true } });
    if (services.length !== serviceIds.length) {
      return { status: 400, body: { message: "One or more assigned services are invalid for this salon" } };
    }
    if (branchId) {
      const invalidService = services.find((service) => service.branchId && service.branchId !== branchId);
      if (invalidService) return { status: 400, body: { message: "Assigned services must belong to the selected branch or be branch-shared" } };
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        systemRole: "SALON_USER"
      }
    });

    const membership = await tx.userSalon.create({
      data: {
        userId: user.id,
        salonId,
        salonRole,
        branchId,
        customRoleId: customRoleId || null,
        phone: phone || null,
        profileNote: profileNote || null,
        avatarUrl: avatarUrl || null,
        roleTitle: roleTitle || null,
        showInCatalog: Boolean(showInCatalog),
        permissions: resolvedPermissions,
        joiningDate: joiningDate ? new Date(joiningDate) : null,
        designation: designation || null,
        uanNumber: uanNumber || null,
        reportingToId: reportingToId || null,
        workingHours: workingHours || null,
        bankName: bankName || null,
        bankBranch: bankBranch || null,
        accountNumber: accountNumber || null,
        ifscCode: ifscCode || null,
        firstName: firstName || null,
        lastName: lastName || null,
        dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null,
        gender: gender || null,
        username: username || null,
        enableAppointments: enableAppointments !== undefined ? Boolean(enableAppointments) : true,
        showAllStaffAppointments: showAllStaffAppointments !== undefined ? Boolean(showAllStaffAppointments) : false,
        workExperience: workExperience || null,
        documents: documents || null
      },
      include: { user: true, branch: true, customRole: true }
    });

    if (serviceIds.length) {
      await tx.staffServiceAssignment.createMany({
        data: serviceIds.map((serviceId) => ({ userSalonId: membership.id, serviceId })),
        skipDuplicates: true
      });
    }

    return tx.userSalon.findUnique({
      where: { id: membership.id },
      include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: { include: { category: true } } } } }
    });
  });

  return { status: 201, body: { membership: created } };
};

ownerRouter.get("/dashboard", requireSalonPermission("dashboard", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoiceWhere = withBranchFilter(req.salonId, branchId);
  const serviceWhere = { salonId: req.salonId, isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) };
  const userWhere = { salonId: req.salonId, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) };
  const branchWhere = { salonId: req.salonId, isActive: true };
  const appointmentWhere = {
    salonId: req.salonId,
    ...(branchId ? { branchId } : {})
  };
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  const activeAppointmentStatuses = ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"];

  const [customers, services, invoices, users, branches, recentInvoices, recentCustomers, allInvoices, recentPayments, todayAppointments, upcomingAppointments, inventoryProducts] = await Promise.all([
    prisma.customer.count({ where: { salonId: req.salonId } }),
    prisma.service.count({ where: serviceWhere }),
    prisma.invoice.count({ where: invoiceWhere }),
    prisma.userSalon.count({ where: userWhere }),
    prisma.branch.count({ where: branchWhere }),
    prisma.invoice.findMany({ where: invoiceWhere, take: 5, include: { customer: true, branch: true }, orderBy: { createdAt: "desc" } }),
    prisma.customer.findMany({ where: { salonId: req.salonId }, take: 5, orderBy: { createdAt: "desc" } }),
    prisma.invoice.findMany({ where: { ...invoiceWhere, status: { in: ["PAID", "PARTIAL"] } }, include: { branch: true } }),
    prisma.payment.findMany({ where: paymentWhere(req.salonId, branchId), take: 5, include: { invoice: true }, orderBy: { createdAt: "desc" } }),
    prisma.appointment.count({
      where: {
        ...appointmentWhere,
        startAt: { gte: startOfDay, lt: endOfDay },
        status: { in: activeAppointmentStatuses }
      }
    }),
    prisma.appointment.count({
      where: {
        ...appointmentWhere,
        startAt: { gte: new Date() },
        status: { in: activeAppointmentStatuses }
      }
    }),
    prisma.product.findMany({
      where: {
        salonId: req.salonId,
        isActive: true,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }, { stockMovements: { some: { branchId } } }] } : {})
      },
      include: { category: true, branch: true }
    })
  ]);

  const todaySales = allInvoices.filter((item) => new Date(item.createdAt) >= startOfDay).reduce((sum, item) => sum + toAmount(item.total), 0);
  const monthlySales = allInvoices.filter((item) => new Date(item.createdAt) >= startOfMonth).reduce((sum, item) => sum + toAmount(item.total), 0);
  const totalPaid = allInvoices.reduce((sum, item) => sum + toAmount(item.paidAmount), 0);
  const totalDue = allInvoices.reduce((sum, item) => sum + Math.max(0, toAmount(item.total) - toAmount(item.paidAmount)), 0);
  const branchScopedProducts = await attachBranchStock(prisma, inventoryProducts, branchId);
  const lowStockAlertCount = branchScopedProducts.filter((product) => toAmount(product.currentStock) <= toAmount(product.minStock)).length;

  res.json({
    customers,
    services,
    invoices,
    users,
    branches,
    branchFilter: branchId,
    todaySales,
    monthlySales,
    paymentSummary: { totalPaid, totalDue },
    upcomingAppointments,
    todayAppointments,
    lowStockAlertCount,
    recentInvoices,
    recentCustomers,
    recentPayments
  });
});

ownerRouter.get("/global-search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    return res.json({ customers: [], appointments: [], services: [] });
  }

  const contains = { contains: q };
  const phoneDigits = q.replace(/\D/g, "");
  const tasks = [];
  const keys = [];

  if (hasPermission(req, "customers")) {
    keys.push("customers");
    tasks.push(prisma.customer.findMany({
      where: {
        salonId: req.salonId,
        OR: [
          { name: contains },
          { phone: { contains: phoneDigits || q } },
          { email: contains }
        ]
      },
      take: 6,
      orderBy: { createdAt: "desc" }
    }));
  }

  if (hasPermission(req, "appointments")) {
    keys.push("appointments");
    tasks.push(prisma.appointment.findMany({
      where: {
        salonId: req.salonId,
        OR: [
          { customer: { is: { OR: [{ name: contains }, { phone: { contains: phoneDigits || q } }] } } },
          { items: { some: { service: { is: { name: contains } } } } }
        ]
      },
      include: { customer: true, branch: true, items: { include: { service: true } } },
      take: 6,
      orderBy: { startAt: "desc" }
    }));
  }

  if (hasPermission(req, "services")) {
    keys.push("services");
    tasks.push(prisma.service.findMany({
      where: {
        salonId: req.salonId,
        isActive: true,
        OR: [
          { name: contains },
          { description: contains },
          { category: { is: { name: contains } } }
        ]
      },
      include: { category: true, branch: true },
      take: 6,
      orderBy: { updatedAt: "desc" }
    }));
  }

  const settled = await Promise.allSettled(tasks);
  const result = { customers: [], appointments: [], services: [] };
  keys.forEach((key, index) => {
    result[key] = settled[index].status === "fulfilled" ? settled[index].value : [];
  });

  res.json({
    customers: result.customers.map((row) => ({
      id: row.id,
      title: row.name,
      subtitle: [row.phone, row.email].filter(Boolean).join(" | "),
      to: `/admin/customers/${row.id}/history`
    })),
    appointments: result.appointments.map((row) => ({
      id: row.id,
      title: row.customer?.name || row.title || "Appointment",
      subtitle: `${row.status} | ${row.startAt ? new Date(row.startAt).toISOString().slice(0, 16).replace("T", " ") : "No date"}${row.branch?.name ? ` | ${row.branch.name}` : ""}`,
      to: `/admin/appointments/${row.id}`
    })),
    services: result.services.map((row) => ({
      id: row.id,
      title: row.name,
      subtitle: `${row.category?.name || "Service"} | ${Number(row.price || 0).toFixed(2)} | ${row.durationMin} min`,
      to: "/admin/services"
    }))
  });
});

ownerRouter.get("/branches", requireSalonPermission("branches", "view"), async (req, res) => {
  const rows = await prisma.branch.findMany({
    where: { salonId: req.salonId, isActive: true },
    include: {
      _count: {
        select: { users: true, services: true, invoices: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  res.json(rows);
});
ownerRouter.post("/branches", requireSalonPermission("branches", "create"), validate(schemas.branch), async (req, res) => {
  const plan = await getActivePlanForSalon(req.salonId);
  if (plan) {
    const branchCount = await prisma.branch.count({ where: { salonId: req.salonId, isActive: true } });
    if (branchCount >= plan.branchLimit) {
      return res.status(403).json({ message: "Branch limit reached for current plan" });
    }
  }
  res.status(201).json(await prisma.branch.create({ data: { ...req.body, email: req.body.email || null, salonId: req.salonId } }));
});
ownerRouter.patch("/branches/:id", requireSalonPermission("branches", "edit"), validate(schemas.branch), async (req, res) => {
  const row = await findScoped("branch", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Branch not found" });
  res.json(await prisma.branch.update({ where: { id: req.params.id }, data: { ...req.body, email: req.body.email || null } }));
});
ownerRouter.patch("/branches/:id/archive", requireSalonPermission("branches", "delete"), async (req, res) => {
  const row = await findScoped("branch", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Branch not found" });
  res.json(await prisma.branch.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/service-categories", requireSalonPermission("services", "view"), async (req, res) => {
  res.json(await prisma.serviceCategory.findMany({ where: { salonId: req.salonId, isActive: true }, orderBy: { createdAt: "desc" } }));
});
ownerRouter.post("/service-categories", requireSalonPermission("services", "create"), validate(schemas.serviceCategory), async (req, res) => {
  res.status(201).json(await prisma.serviceCategory.create({ data: { salonId: req.salonId, ...req.body } }));
});
ownerRouter.patch("/service-categories/:id", requireSalonPermission("services", "edit"), validate(schemas.serviceCategory), async (req, res) => {
  const row = await findScoped("serviceCategory", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service category not found" });
  res.json(await prisma.serviceCategory.update({ where: { id: req.params.id }, data: req.body }));
});
ownerRouter.patch("/service-categories/:id/archive", requireSalonPermission("services", "delete"), async (req, res) => {
  const row = await findScoped("serviceCategory", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service category not found" });
  res.json(await prisma.serviceCategory.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/services", requireSalonPermission("services", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  res.json(await prisma.service.findMany({
    where: { salonId: req.salonId, isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { branch: true, category: true },
    orderBy: { createdAt: "desc" }
  }));
});
ownerRouter.post("/services", requireSalonPermission("services", "create"), validate(schemas.service), async (req, res) => {
  const branchId = normalizeBranchId(req.body.branchId);
  const categoryId = req.body.categoryId ? String(req.body.categoryId) : null;
  if (branchId) await ensureBranch(req.salonId, branchId);
  if (categoryId) await ensureServiceCategory(req.salonId, categoryId);
  const inheritedTaxRate = req.body.taxRate != null ? null : await resolveSalonDefaultTaxRate(req.salonId);
  res.status(201).json(await prisma.service.create({
    data: {
      ...req.body,
      branchId,
      categoryId,
      gender: req.body.gender || null,
      price: toAmount(req.body.price),
      durationMin: Number(req.body.durationMin),
      taxRate: req.body.taxRate != null ? toAmount(req.body.taxRate) : inheritedTaxRate,
      commissionPct: req.body.commissionPct != null ? toAmount(req.body.commissionPct) : null,
      salonId: req.salonId
    },
    include: { branch: true, category: true }
  }));
});
ownerRouter.patch("/services/:id", requireSalonPermission("services", "edit"), validate(schemas.service), async (req, res) => {
  const row = await findScoped("service", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service not found" });
  const branchId = normalizeBranchId(req.body.branchId);
  const categoryId = req.body.categoryId ? String(req.body.categoryId) : null;
  if (branchId) await ensureBranch(req.salonId, branchId);
  if (categoryId) await ensureServiceCategory(req.salonId, categoryId);
  res.json(await prisma.service.update({
    where: { id: req.params.id },
    data: {
      ...req.body,
      branchId,
      categoryId,
      gender: req.body.gender || null,
      price: toAmount(req.body.price),
      durationMin: Number(req.body.durationMin),
      taxRate: req.body.taxRate != null ? toAmount(req.body.taxRate) : null,
      commissionPct: req.body.commissionPct != null ? toAmount(req.body.commissionPct) : null
    },
    include: { branch: true, category: true }
  }));
});
ownerRouter.patch("/services/:id/archive", requireSalonPermission("services", "delete"), async (req, res) => {
  const row = await findScoped("service", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service not found" });
  res.json(await prisma.service.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/customers/export", requireSalonPermission("customers", "view"), async (req, res) => {
  const query = String(req.query.q || "").trim();
  const filter = String(req.query.filter || "").trim();
  const format = String(req.query.format || "xlsx").toLowerCase();
  const branchId = normalizeBranchId(req.query.branchId);
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const rows = await prisma.customer.findMany({
    where: {
      salonId: req.salonId,
      ...(branchId ? { invoices: { some: { branchId } } } : {}),
      ...(query ? {
        OR: [
          { name: { contains: query } },
          { phone: { contains: query } },
          { email: { contains: query } },
          { source: { contains: query } }
        ]
      } : {}),
      ...(filter === "high_spender" ? { totalSpend: { gte: 10000 } } : {}),
      ...(filter === "lost_customer" ? { OR: [{ lastVisitAt: null }, { lastVisitAt: { lte: ninetyDaysAgo } }] } : {}),
      ...(filter === "active_membership" ? { memberships: { some: { status: "ACTIVE", endsAt: { gte: now } } } } : {}),
      ...(filter === "active_package" ? { packages: { some: { status: "ACTIVE", endsAt: { gte: now } } } } : {})
    },
    include: { preferredStaff: { include: { user: true } } },
    orderBy: { createdAt: "desc" }
  });
  const filteredRows = rows.filter((row) => {
    if (filter === "birthday_month") return row.dateOfBirth ? new Date(row.dateOfBirth).getMonth() === now.getMonth() : false;
    if (filter === "anniversary_month") return row.anniversary ? new Date(row.anniversary).getMonth() === now.getMonth() : false;
    return true;
  });

  const wsData = [
    ["Mobile No.", "Name", "Gender", "Email", "Date of Birth", "Anniversary", "GST", "Total Orders", "Total Spend", "Average Spend", "Last Visited", "Created At"]
  ];
  for (const row of filteredRows) {
    wsData.push([
      row.phone || "-",
      row.name || "-",
      row.gender ? row.gender.charAt(0).toUpperCase() + row.gender.slice(1).toLowerCase() : "-",
      row.email || "-",
      row.dateOfBirth ? new Date(row.dateOfBirth).toLocaleDateString() : "-",
      row.anniversary ? new Date(row.anniversary).toLocaleDateString() : "-",
      row.gst || "-",
      row.totalOrders || 0,
      row.totalSpend || 0,
      row.averageSpend || 0,
      row.lastVisitAt ? new Date(row.lastVisitAt).toLocaleDateString() : "-",
      new Date(row.createdAt).toLocaleDateString()
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Customers");
  
  const bookType = ['csv', 'xls', 'xlsx'].includes(format) ? format : 'xlsx';
  const buffer = XLSX.write(wb, { type: "buffer", bookType });

  const mimeTypes = {
    csv: "text/csv",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  };

  res.setHeader("Content-Disposition", `attachment; filename="Customers.${bookType}"`);
  res.setHeader("Content-Type", mimeTypes[bookType]);
  res.send(buffer);
});
ownerRouter.get("/customers", requireSalonPermission("customers", "view"), async (req, res) => {
  const query = String(req.query.q || "").trim();
  const filter = String(req.query.filter || "").trim();
  const branchId = normalizeBranchId(req.query.branchId);
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const rows = await prisma.customer.findMany({
    where: {
      salonId: req.salonId,
      ...(branchId ? { invoices: { some: { branchId } } } : {}),
      ...(query ? {
        OR: [
          { name: { contains: query } },
          { phone: { contains: query } },
          { email: { contains: query } },
          { source: { contains: query } }
        ]
      } : {}),
      ...(filter === "high_spender" ? { totalSpend: { gte: 10000 } } : {}),
      ...(filter === "lost_customer" ? { OR: [{ lastVisitAt: null }, { lastVisitAt: { lte: ninetyDaysAgo } }] } : {}),
      ...(filter === "active_membership" ? { memberships: { some: { status: "ACTIVE", endsAt: { gte: now } } } } : {}),
      ...(filter === "active_package" ? { packages: { some: { status: "ACTIVE", endsAt: { gte: now } } } } : {})
    },
    include: { preferredStaff: { include: { user: true } } },
    orderBy: { createdAt: "desc" }
  });
  const filteredRows = rows.filter((row) => {
    if (filter === "birthday_month") return row.dateOfBirth ? new Date(row.dateOfBirth).getMonth() === now.getMonth() : false;
    if (filter === "anniversary_month") return row.anniversary ? new Date(row.anniversary).getMonth() === now.getMonth() : false;
    return true;
  });
  const detailedRows = await prisma.customer.findMany({
    where: { id: { in: filteredRows.map((row) => row.id) } },
    include: {
      preferredStaff: { include: { user: true } },
      invoices: {
        select: { id: true, balanceAmount: true, status: true, createdAt: true }
      },
      appointments: {
        select: { id: true, advancePaidAmount: true, status: true, startAt: true }
      },
      memberships: {
        select: { id: true, status: true, endsAt: true }
      },
      packages: {
        select: { id: true, status: true, endsAt: true }
      },
      orders: {
        select: { id: true, createdAt: true }
      },
      coupons: {
        select: { code: true, title: true }
      }
    }
  });
  const summaryMap = new Map(detailedRows.map((row) => [row.id, summarizeCustomerForCrm(row)]));
  res.json(filteredRows.map((row) => summaryMap.get(row.id) || summarizeCustomerForCrm(row)));
});
ownerRouter.post("/customers", requireSalonPermission("customers", "create"), validate(schemas.customer), async (req, res) => {
  const plan = await getActivePlanForSalon(req.salonId);
  if (plan) {
    const customerCount = await prisma.customer.count({ where: { salonId: req.salonId } });
    if (customerCount >= plan.customerLimit) {
      return res.status(403).json({ message: "Customer limit reached for current plan" });
    }
  }
  const duplicate = await prisma.customer.findFirst({ where: { salonId: req.salonId, phone: req.body.phone } });
  if (duplicate) return res.status(400).json({ message: "Customer with this phone already exists in this salon" });
  if (req.body.branchId) await ensureBranch(req.salonId, req.body.branchId);
  res.status(201).json(await prisma.customer.create({
    data: buildCustomerData(req.body, req.salonId)
  }));
});
ownerRouter.patch("/customers/:id", requireSalonPermission("customers", "edit"), validate(schemas.customer), async (req, res) => {
  const row = await findScoped("customer", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Customer not found" });
  const duplicate = await prisma.customer.findFirst({
    where: { salonId: req.salonId, phone: req.body.phone, NOT: { id: req.params.id } }
  });
  if (duplicate) return res.status(400).json({ message: "Another customer already uses this phone number" });
  if (req.body.branchId) await ensureBranch(req.salonId, req.body.branchId);
  res.json(await prisma.customer.update({
    where: { id: req.params.id },
    data: buildCustomerData(req.body)
  }));
});
ownerRouter.delete("/customers/:id", requireSalonPermission("customers", "edit"), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, salonId: req.salonId },
    include: {
      _count: {
        select: {
          invoices: true,
          appointments: true,
          memberships: true,
          packages: true,
          orders: true,
          timelineEntries: true,
          coupons: true,
          notifications: true,
          feedback: true,
          loyaltyTransactions: true,
          couponRedemptions: true,
          giftCardsIssued: true,
          giftCardRedemptions: true,
          enquiries: true,
          campaignConversions: true,
          whatsappLogs: true
        }
      }
    }
  });
  if (!customer) return res.status(404).json({ message: "Customer not found" });
  const relatedRecords = Object.values(customer._count || {}).reduce((sum, value) => sum + Number(value || 0), 0);
  if (relatedRecords > 0) {
    return res.status(400).json({
      message: "This customer already has business history. Merge them into another profile instead of deleting."
    });
  }
  await prisma.customer.delete({ where: { id: customer.id } });
  res.json({ ok: true });
});
ownerRouter.post("/customers/merge", requireSalonPermission("customers", "edit"), async (req, res) => {
  const sourceCustomerId = String(req.body.sourceCustomerId || "").trim();
  const targetCustomerId = String(req.body.targetCustomerId || "").trim();
  if (!sourceCustomerId || !targetCustomerId) return res.status(400).json({ message: "sourceCustomerId and targetCustomerId are required" });
  if (sourceCustomerId === targetCustomerId) return res.status(400).json({ message: "Source and target customer must be different" });

  const [sourceCustomer, targetCustomer] = await Promise.all([
    prisma.customer.findFirst({ where: { id: sourceCustomerId, salonId: req.salonId } }),
    prisma.customer.findFirst({ where: { id: targetCustomerId, salonId: req.salonId } })
  ]);
  if (!sourceCustomer || !targetCustomer) return res.status(404).json({ message: "Customer not found" });

  const mergedCustomer = await prisma.$transaction(async (tx) => {
    await tx.invoice.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.appointment.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.customerMembership.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.customerPackage.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.customerTimeline.updateMany({ where: { customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.onlineOrder.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.customerCoupon.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.customerNotification.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.customerFeedback.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.loyaltyTransaction.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.couponRedemption.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.giftCard.updateMany({ where: { salonId: req.salonId, issuedToCustomerId: sourceCustomer.id }, data: { issuedToCustomerId: targetCustomer.id } });
    await tx.giftCardRedemption.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.enquiry.updateMany({ where: { salonId: req.salonId, convertedCustomerId: sourceCustomer.id }, data: { convertedCustomerId: targetCustomer.id } });
    await tx.campaignConversion.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });
    await tx.whatsAppLog.updateMany({ where: { salonId: req.salonId, customerId: sourceCustomer.id }, data: { customerId: targetCustomer.id } });

    const updatedTarget = await tx.customer.update({
      where: { id: targetCustomer.id },
      data: {
        name: targetCustomer.name || sourceCustomer.name,
        email: targetCustomer.email || sourceCustomer.email,
        gender: targetCustomer.gender || sourceCustomer.gender,
        dateOfBirth: targetCustomer.dateOfBirth || sourceCustomer.dateOfBirth,
        anniversary: targetCustomer.anniversary || sourceCustomer.anniversary,
        source: targetCustomer.source || sourceCustomer.source,
        notes: [targetCustomer.notes, sourceCustomer.notes].filter(Boolean).join("\n\n") || null,
        preferences: targetCustomer.preferences || sourceCustomer.preferences,
        preferredStaffId: targetCustomer.preferredStaffId || sourceCustomer.preferredStaffId,
        allergies: targetCustomer.allergies || sourceCustomer.allergies,
        skinNotes: targetCustomer.skinNotes || sourceCustomer.skinNotes,
        tags: [...new Set([...(Array.isArray(targetCustomer.tags) ? targetCustomer.tags : []), ...(Array.isArray(sourceCustomer.tags) ? sourceCustomer.tags : [])])]
      }
    });

    await refreshCustomerInsights(tx, updatedTarget.id);
    await tx.customer.delete({ where: { id: sourceCustomer.id } });
    return updatedTarget;
  });

  res.json(mergedCustomer);
});
ownerRouter.get("/customers/:id", requireSalonPermission("customers", "view"), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, salonId: req.salonId },
    include: {
      invoices: {
        include: { items: true, payments: true, branch: true },
        orderBy: { createdAt: "desc" }
      },
      memberships: {
        include: { membershipPlan: true },
        orderBy: { createdAt: "desc" }
      },
      packages: {
        include: { package: { include: { services: { include: { service: true } } } }, usageLogs: { orderBy: { createdAt: "desc" }, take: 10 } },
        orderBy: { createdAt: "desc" }
      }
    }
  });
  if (!customer) return res.status(404).json({ message: "Customer not found" });
  const followUps = [];
  if (customer.followUpAt) {
    const notesLines = (customer.notes || "").split("\n").filter(l => l.startsWith("[Follow-up"));
    notesLines.forEach(line => {
      const match = line.match(/\[Follow-up (\w+) ([^\]]+)\] (.+)/);
      if (match) {
        followUps.push({ type: match[1], date: match[2], message: match[3], status: "scheduled" });
      }
    });
  }
  const familyMembers = await prisma.customer.findMany({
    where: { salonId: req.salonId, notes: { contains: `familyMemberOf:${customer.id}` } },
    select: { id: true, name: true, phone: true, createdAt: true }
  });
  res.json({ ...customer, followUps, familyMembers });
});

ownerRouter.get("/users/export.csv", requireSalonPermission("staff", "view"), attachSalonSettings, async (req, res) => {
  const accessControl = req.advancedSettings?.accessControl || {};
  if (accessControl.allowStaffExport === false) return res.status(403).json({ message: "Staff export is restricted by salon settings" });
  const branchId = normalizeBranchId(req.query.branchId);
  const rows = await prisma.userSalon.findMany({
    where: { salonId: req.salonId, isArchived: false, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { user: true, branch: true, customRole: true }
  });
  const csv = buildCsv(
    ["Name", "Email", "Phone", "Role", "Branch", "CustomRole", "Joined"],
    rows.map((row) => [row.user?.name || "", row.user?.email || "", row.user?.phone || "", row.salonRole || "", row.branch?.name || "All", row.customRole?.name || "", row.joiningDate ? new Date(row.joiningDate).toLocaleDateString() : ""])
  );
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"staff-export.csv\"");
  res.send(csv);
});
ownerRouter.get("/users", requireSalonPermission("staff", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const showArchived = req.query.archived === "true";
  res.json(await prisma.userSalon.findMany({
    where: { salonId: req.salonId, ...(showArchived ? {} : { isArchived: false }), ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: { include: { category: true } } } } },
    orderBy: { id: "desc" }
  }));
});
ownerRouter.get("/staff-users", requireSalonPermission("staff", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const showArchived = req.query.archived === "true";
  res.json(await prisma.userSalon.findMany({
    where: { salonId: req.salonId, ...(showArchived ? {} : { isArchived: false }), ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: { include: { category: true } } } } },
    orderBy: { id: "desc" }
  }));
});
ownerRouter.get("/custom-roles", requireSalonPermission("staff", "view"), async (req, res) => {
  res.json(await prisma.customRole.findMany({
    where: { salonId: req.salonId },
    orderBy: { createdAt: "desc" }
  }));
});
ownerRouter.post("/custom-roles", requireSalonPermission("staff", "create"), attachSalonSettings, validate(schemas.customRole), async (req, res) => {
  const accessControl = req.advancedSettings?.accessControl || {};
  const isOwner = req.user?.salonRole === "SALON_OWNER";
  if (accessControl.approvalRequiredForRoleEdits && !isOwner) {
    const approvedBy = req.body.approvedBy || req.headers["x-approval-token"];
    if (!approvedBy) return res.status(403).json({ message: "Role creation requires approval. Provide approvedBy or x-approval-token header." });
  }
  const existing = await prisma.customRole.findFirst({ where: { salonId: req.salonId, name: req.body.name } });
  if (existing) return res.status(400).json({ message: "A custom role with this name already exists" });
  res.status(201).json(await prisma.customRole.create({
    data: {
      salonId: req.salonId,
      name: req.body.name,
      description: req.body.description || null,
      permissions: req.body.permissions
    }
  }));
});
ownerRouter.patch("/custom-roles/:id", requireSalonPermission("staff", "edit"), attachSalonSettings, validate(schemas.customRole), async (req, res) => {
  const accessControl = req.advancedSettings?.accessControl || {};
  const isOwner = req.user?.salonRole === "SALON_OWNER";
  if (accessControl.approvalRequiredForRoleEdits && !isOwner) {
    const approvedBy = req.body.approvedBy || req.headers["x-approval-token"];
    if (!approvedBy) return res.status(403).json({ message: "Role edits require approval. Provide approvedBy or x-approval-token header." });
  }
  const role = await prisma.customRole.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!role) return res.status(404).json({ message: "Custom role not found" });
  res.json(await prisma.customRole.update({
    where: { id: role.id },
    data: {
      name: req.body.name,
      description: req.body.description || null,
      permissions: req.body.permissions
    }
  }));
});
ownerRouter.post("/users", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.post("/staff-users", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.patch("/users/:id", requireSalonPermission("staff", "edit"), attachSalonSettings, validate(schemas.userMembershipUpdate), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  const accessControl = req.advancedSettings?.accessControl || {};
  let branchId = req.body.branchId === null ? null : normalizeBranchId(req.body.branchId ?? row.branchId);
  if (accessControl.branchScopedDefault && !branchId) {
    const firstBranch = await prisma.branch.findFirst({ where: { salonId: req.salonId } });
    if (firstBranch) branchId = firstBranch.id;
  }
  const customRoleId = req.body.customRoleId === null ? null : (req.body.customRoleId ?? row.customRoleId ?? null);
  if (branchId) await ensureBranch(req.salonId, branchId);
  const resolvedPermissions = await resolveMembershipPermissions(req.salonId, customRoleId, req.body.permissions);
  if (Array.isArray(req.body.serviceIds) && req.body.serviceIds.length) {
    const services = await prisma.service.findMany({ where: { id: { in: req.body.serviceIds }, salonId: req.salonId, isActive: true } });
    if (services.length !== req.body.serviceIds.length) {
      return res.status(400).json({ message: "One or more assigned services are invalid for this salon" });
    }
    if (branchId) {
      const invalidService = services.find((service) => service.branchId && service.branchId !== branchId);
      if (invalidService) return res.status(400).json({ message: "Assigned services must belong to the selected branch or be branch-shared" });
    }
  }
  const updated = await prisma.$transaction(async (tx) => {
    if (req.body.name) {
      await tx.user.update({ where: { id: row.userId }, data: { name: req.body.name } });
    }
    const membership = await tx.userSalon.update({
      where: { id: req.params.id },
      data: {
        salonRole: req.body.salonRole ?? row.salonRole,
        branchId,
        customRoleId,
        phone: req.body.phone ?? row.phone,
        profileNote: req.body.profileNote ?? row.profileNote,
        avatarUrl: req.body.avatarUrl ?? row.avatarUrl,
        roleTitle: req.body.roleTitle ?? row.roleTitle,
        showInCatalog: req.body.showInCatalog ?? row.showInCatalog,
        isArchived: req.body.isArchived ?? row.isArchived,
        permissions: resolvedPermissions,
        joiningDate: req.body.joiningDate !== undefined ? (req.body.joiningDate ? new Date(req.body.joiningDate) : null) : row.joiningDate,
        designation: req.body.designation !== undefined ? req.body.designation : row.designation,
        uanNumber: req.body.uanNumber !== undefined ? req.body.uanNumber : row.uanNumber,
        reportingToId: req.body.reportingToId !== undefined ? req.body.reportingToId : row.reportingToId,
        workingHours: req.body.workingHours !== undefined ? req.body.workingHours : row.workingHours,
        bankName: req.body.bankName !== undefined ? req.body.bankName : row.bankName,
        bankBranch: req.body.bankBranch !== undefined ? req.body.bankBranch : row.bankBranch,
        accountNumber: req.body.accountNumber !== undefined ? req.body.accountNumber : row.accountNumber,
        ifscCode: req.body.ifscCode !== undefined ? req.body.ifscCode : row.ifscCode,
        firstName: req.body.firstName !== undefined ? req.body.firstName : row.firstName,
        lastName: req.body.lastName !== undefined ? req.body.lastName : row.lastName,
        dateOfBirth: req.body.dateOfBirth !== undefined ? (req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : null) : row.dateOfBirth,
        gender: req.body.gender !== undefined ? req.body.gender : row.gender,
        username: req.body.username !== undefined ? req.body.username : row.username,
        enableAppointments: req.body.enableAppointments !== undefined ? Boolean(req.body.enableAppointments) : row.enableAppointments,
        showAllStaffAppointments: req.body.showAllStaffAppointments !== undefined ? Boolean(req.body.showAllStaffAppointments) : row.showAllStaffAppointments,
        workExperience: req.body.workExperience !== undefined ? req.body.workExperience : row.workExperience,
        documents: req.body.documents !== undefined ? req.body.documents : row.documents
      },
      include: { user: true, branch: true, customRole: true }
    });
    if (Array.isArray(req.body.serviceIds)) {
      await tx.staffServiceAssignment.deleteMany({ where: { userSalonId: req.params.id } });
      if (req.body.serviceIds.length) {
        await tx.staffServiceAssignment.createMany({
          data: req.body.serviceIds.map((serviceId) => ({ userSalonId: req.params.id, serviceId })),
          skipDuplicates: true
        });
      }
    }
    return tx.userSalon.findUnique({
      where: { id: req.params.id },
      include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: { include: { category: true } } } } }
    });
  });
  res.json(updated);
});
ownerRouter.patch("/staff-users/:id", requireSalonPermission("staff", "edit"), validate(schemas.userMembershipUpdate), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "Staff mapping not found" });
  const branchId = req.body.branchId === null ? null : normalizeBranchId(req.body.branchId ?? row.branchId);
  if (branchId) await ensureBranch(req.salonId, branchId);
  res.json(await prisma.userSalon.update({ where: { id: req.params.id }, data: { ...req.body, branchId } }));
});
ownerRouter.get("/roles-permissions", requireSalonPermission("staff", "view"), async (req, res) => {
  res.json(
    await prisma.userSalon.findMany({
      where: { salonId: req.salonId, isArchived: false },
      include: { user: { select: { id: true, name: true, email: true, isActive: true } }, branch: true, customRole: true, serviceAssignments: { include: { service: { include: { category: true } } } } },
      orderBy: { id: "desc" }
    })
  );
});
ownerRouter.post("/users/create-login", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.patch("/users/:id/status", requireSalonPermission("staff", "edit"), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { user: true } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  res.json(await prisma.user.update({ where: { id: row.userId }, data: { isActive: Boolean(req.body.isActive) } }));
});
ownerRouter.patch("/users/:id/archive", requireSalonPermission("staff", "delete"), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  res.json(await prisma.userSalon.update({ where: { id: req.params.id }, data: { isArchived: true } }));
});
ownerRouter.patch("/users/:id/restore", requireSalonPermission("staff", "delete"), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  res.json(await prisma.userSalon.update({ where: { id: req.params.id }, data: { isArchived: false } }));
});

ownerRouter.get("/support-tickets", requireSalonPermission("support", "view"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const status = String(req.query.status || "").trim();
  const priority = String(req.query.priority || "").trim();
  res.json(await prisma.supportTicket.findMany({
    where: {
      salonId: req.salonId,
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(q ? {
        OR: [
          { title: { contains: q } },
          { description: { contains: q } },
          { category: { contains: q } },
          { internalNote: { contains: q } },
          { assignedAgentName: { contains: q } }
        ]
      } : {})
    },
    include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" }
  }));
});
ownerRouter.post("/support-tickets", requireSalonPermission("support", "create"), validate(schemas.supportTicket), async (req, res) => {
  const created = await prisma.$transaction(async (tx) => {
    const { attachmentUrl, ...ticketPayload } = req.body;
    const ticket = await tx.supportTicket.create({ data: { salonId: req.salonId, ...ticketPayload } });
    await tx.supportTicketEvent.create({
      data: {
        ticketId: ticket.id,
        eventType: "CREATED",
        actorName: req.user.name,
        details: "Ticket created by salon"
      }
    });
    if (req.body.description) {
      await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: "SALON",
          authorName: req.user.name,
          message: req.body.description,
          attachmentUrl: attachmentUrl || null
        }
      });
    }
    return tx.supportTicket.findUnique({
      where: { id: ticket.id },
      include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
    });
  });
  res.status(201).json(created);
});
ownerRouter.post("/support-tickets/:id/messages", requireSalonPermission("support", "create"), validate(schemas.supportTicketMessage), async (req, res) => {
  const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!ticket) return res.status(404).json({ message: "Support ticket not found" });
  if (ticket.status === "CLOSED") return res.status(400).json({ message: "Closed tickets cannot receive replies until reopened by support" });

  await prisma.supportTicketMessage.create({
    data: {
      ticketId: ticket.id,
      authorType: "SALON",
      authorName: req.user.name,
      message: req.body.message,
      attachmentUrl: req.body.attachmentUrl || null
    }
  });
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: "OPEN" } });
  await prisma.supportTicketEvent.create({
    data: {
      ticketId: ticket.id,
      eventType: "REPLY_SENT",
      actorName: req.user.name,
      details: req.body.attachmentUrl ? "Salon reply sent with attachment placeholder" : "Salon reply sent",
      fromStatus: ticket.status,
      toStatus: "OPEN"
    }
  });
  res.json(await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } } }));
});

ownerRouter.get("/settings", requireSalonPermission("settings", "view"), async (req, res) => {
  const row = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
  res.json(row);
});
ownerRouter.get("/settings/shifts", requireSalonPermission("settings", "view"), async (req, res) => {
  const row = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null }, select: { advancedSettings: true } });
  const advanced = typeof row?.advancedSettings === "object" ? row.advancedSettings : {};
  res.json(advanced.shiftManagement || { shifts: [] });
});
ownerRouter.get("/settings/designations", requireSalonPermission("settings", "view"), async (req, res) => {
  const row = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null }, select: { advancedSettings: true } });
  const advanced = typeof row?.advancedSettings === "object" ? row.advancedSettings : {};
  res.json(advanced.designations || []);
});
ownerRouter.post("/settings", requireSalonPermission("settings", "edit"), async (req, res) => {
  try {
    const branchId = req.body.branchId || null;
    const sanitizeJson = (val) => {
      if (val === null || val === undefined) return null;
      if (typeof val === "string") {
        try { return JSON.parse(val); } catch { return val; }
      }
      return JSON.parse(JSON.stringify(val));
    };
    const payload = {
      invoicePrefix: req.body.invoicePrefix || undefined,
      invoiceFooter: req.body.invoiceFooter || undefined,
      taxLabel: req.body.taxLabel || undefined,
      paymentModes: sanitizeJson(req.body.paymentModes),
      whatsappNumber: req.body.whatsappNumber || null,
      bookingNotes: req.body.bookingNotes || null,
      cancellationPolicy: req.body.cancellationPolicy || null,
      allowNegativeStock: Boolean(req.body.allowNegativeStock),
      paymentGatewaySettings: sanitizeJson(req.body.paymentGatewaySettings),
      advancedSettings: sanitizeJson(req.body.advancedSettings),
      smsSettings: sanitizeJson(req.body.smsSettings)
    };
    const existing = await prisma.salonSetting.findFirst({
      where: { salonId: req.salonId, branchId }
    });
    const row = existing
      ? await prisma.salonSetting.update({ where: { id: existing.id }, data: payload })
      : await prisma.salonSetting.create({ data: { salonId: req.salonId, ...payload, branchId } });
    if (!branchId) {
      try { await syncGenericSettingsToPublicChannels(req.salonId, payload); } catch (e) { console.error("syncGenericSettings error:", e.message); }
      try { await syncAdvancedSettingsToOperationalDefaults(req.salonId, payload); } catch (e) { console.error("syncAdvancedSettings error:", e.message); }
    }
    await createAuditLog({
      salonId: req.salonId, actorUserId: req.user.userId, actorMembershipId: req.user.membershipId,
      module: "SETTINGS", action: existing ? "SETTINGS_UPDATED" : "SETTINGS_CREATED",
      entityType: "SalonSetting", entityId: row.id,
      summary: branchId ? "Branch-level settings saved" : "Salon settings saved"
    });
    res.status(201).json(row);
  } catch (err) {
    console.error("Settings update error:", err.message);
    res.status(500).json({ message: "Failed to update settings", error: err.message });
  }
});

ownerRouter.post("/settings/crm-segment-preview", requireSalonPermission("settings", "view"), async (req, res) => {
  try {
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];
    const preview = {};
    for (const segment of segments) {
      const segmentId = String(segment?.id || "");
      if (!segmentId) continue;
      if (segment?.active === false) { preview[segmentId] = 0; continue; }
      const filterType = String(segment?.filterType || "ALL_CUSTOMERS");
      try {
        const audience = await getCampaignAudience(req.salonId, filterType, filterType === "SERVICE_BASED_CUSTOMERS" ? { serviceId: segment?.serviceId || "" } : {});
        preview[segmentId] = audience.length;
      } catch { preview[segmentId] = 0; }
    }
    res.json({ preview });
  } catch (err) {
    res.json({ preview: {} });
  }
});

ownerRouter.get("/website/config", requireSalonPermission("settings", "view"), async (req, res) => {
  let config = await prisma.websiteConfig.findUnique({
    where: { salonId: req.salonId }
  });
  if (!config) {
    config = { heroTitle: "", heroSubtitle: "", heroImage: "", sections: "[]" };
  }
  res.json({ ...config, sections: typeof config.sections === "string" ? JSON.parse(config.sections) : (config.sections || []) });
});

ownerRouter.post("/website/config", requireSalonPermission("settings", "edit"), async (req, res) => {
  const { heroTitle, heroSubtitle, heroImage, sections } = req.body;
  const sectionsStr = Array.isArray(sections) ? JSON.stringify(sections) : "[]";
  const config = await prisma.websiteConfig.upsert({
    where: { salonId: req.salonId },
    update: { heroTitle, heroSubtitle, heroImage, sections: sectionsStr },
    create: { salonId: req.salonId, heroTitle, heroSubtitle, heroImage, sections: sectionsStr }
  });
  res.json(config);
});

ownerRouter.get("/reports/trends", requireSalonPermission("reports", "view"), async (req, res) => {
  const range = req.query.range || "7D";
  const filter = String(req.query.filter || "overall").toLowerCase();

  let days = 7;
  if (range === "1D")  days = 1;
  if (range === "14D") days = 14;
  if (range === "1M")  days = 30;
  if (range === "2M")  days = 60;
  if (range === "YTD") days = Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 86400000) || 1;
  if (range === "1Y")  days = 365;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0,0,0,0);

  const invoices = await prisma.invoice.findMany({
    where: {
      salonId: req.salonId,
      status: "PAID",
      createdAt: { gte: startDate }
    },
    include: {
      items: true
    }
  });

  const matchesFilter = (item) => {
    const type = String(item.itemType || "SERVICE").toUpperCase();
    if (filter === "service") return type === "SERVICE";
    if (filter === "product") return type === "PRODUCT";
    if (filter === "stylist") return Boolean(item.staffName);
    return true;
  };

  const filteredInvoices = invoices
    .map((invoice) => ({
      ...invoice,
      items: (invoice.items || []).filter(matchesFilter)
    }))
    .filter((invoice) => invoice.items.length > 0);

  let serviceRev = 0, productRev = 0, packageRev = 0, membershipRev = 0;

  filteredInvoices.forEach(inv => {
    inv.items.forEach(item => {
      const type  = item.itemType || "SERVICE";  // fixed: itemType not type
      const total = Number(item.lineTotal || 0); // fixed: lineTotal not total
      if (type === "SERVICE")    serviceRev    += total;
      if (type === "PRODUCT")    productRev    += total;
      if (type === "PACKAGE")    packageRev    += total;
      if (type === "MEMBERSHIP") membershipRev += total;
    });
  });

  const totalRev = serviceRev + productRev + packageRev + membershipRev;

  const revenueSplit = [
    { name: "Total", value: totalRev, fill: "#6366f1" },
    { name: "Service", value: serviceRev, fill: "#3b82f6" },
    { name: "Product", value: productRev, fill: "#10b981" },
    { name: "Package", value: packageRev, fill: "#f59e0b" },
    { name: "Membership", value: membershipRev, fill: "#ec4899" },
    { name: "Gift Card", value: 0, fill: "#8b5cf6" }
  ];

  // daily trend line
  const dateMap = {};
  const totalDays = Math.max(days, 1);
  for (let i = 0; i < totalDays; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (totalDays - 1 - i));
    const dateStr = d.toISOString().slice(0, 10);
    dateMap[dateStr] = { date: dateStr, total: 0, service: 0, product: 0, package: 0, membership: 0 };
  }

  filteredInvoices.forEach(inv => {
    const dStr = inv.createdAt.toISOString().slice(0, 10);
    if (dateMap[dStr]) {
      inv.items.forEach(item => {
        const type = item.itemType || "SERVICE";
        const t    = Number(item.lineTotal || 0);
        dateMap[dStr].total += t;
        if (type === "SERVICE")    dateMap[dStr].service    += t;
        if (type === "PRODUCT")    dateMap[dStr].product    += t;
        if (type === "PACKAGE")    dateMap[dStr].package    += t;
        if (type === "MEMBERSHIP") dateMap[dStr].membership += t;
      });
    }
  });

  // top services
  const serviceMap = {};
  filteredInvoices.forEach(inv => {
    inv.items.filter(i => (i.itemType || "SERVICE") === "SERVICE").forEach(item => {
      const name = item.serviceName || "Unknown";
      serviceMap[name] = (serviceMap[name] || 0) + Number(item.lineTotal || 0);
    });
  });
  const topServices = Object.entries(serviceMap)
    .map(([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // top staff
  const staffMap = {};
  filteredInvoices.forEach(inv => {
    inv.items.forEach(item => {
      if (!item.staffName) return;
      staffMap[item.staffName] = (staffMap[item.staffName] || 0) + Number(item.lineTotal || 0);
    });
  });
  const topStaff = Object.entries(staffMap)
    .map(([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  res.json({
    filter,
    revenueSplit,
    trendLine:   Object.values(dateMap),
    topServices,
    topStaff,
    summary: {
      totalInvoices: filteredInvoices.length,
      totalRevenue:  totalRev,
      avgBillValue:  filteredInvoices.length ? Math.round(totalRev / filteredInvoices.length) : 0,
    }
  });
});

registerPhase2OwnerRoutes(ownerRouter);
registerPhase3OwnerRoutes(ownerRouter);
registerPhase4OwnerRoutes(ownerRouter);

ownerRouter.get("/memberships/plans", requireSalonPermission("memberships", "view"), async (req, res) => {
  try {
    const plans = await prisma.membershipPlan.findMany({ where: { salonId: req.salonId, isActive: true }, orderBy: { createdAt: "desc" } });
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: "Failed to load membership plans" });
  }
});

ownerRouter.get("/customers/:id/gift-cards", requireSalonPermission("customers", "view"), async (req, res) => {
  try {
    const giftCards = await prisma.giftCard.findMany({
      where: { salonId: req.salonId, issuedToCustomerId: req.params.id },
      orderBy: { createdAt: "desc" }
    });
    res.json(giftCards.map(gc => ({
      id: gc.id,
      code: gc.code,
      title: gc.title,
      originalAmount: Number(gc.originalAmount),
      balance: Number(gc.balanceAmount),
      expiresAt: gc.expiresAt,
      status: gc.isActive ? "ACTIVE" : "INACTIVE",
      createdAt: gc.createdAt
    })));
  } catch (error) {
    res.status(500).json({ error: "Failed to load gift cards" });
  }
});

ownerRouter.get("/customers/:id/advance-payments", requireSalonPermission("customers", "view"), async (req, res) => {
  try {
    const appointments = await prisma.appointment.findMany({
      where: { salonId: req.salonId, customerId: req.params.id, advancePaidAmount: { gt: 0 } },
      select: { id: true, advancePaidAmount: true, createdAt: true, status: true, note: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(appointments.map(a => ({
      id: a.id,
      amount: Number(a.advancePaidAmount),
      mode: "Online",
      remark: a.note || "",
      createdAt: a.createdAt,
      type: a.status === "CANCELLED" ? "refunded" : "advance"
    })));
  } catch (error) {
    res.status(500).json({ error: "Failed to load advance payments" });
  }
});

ownerRouter.post("/advance-payments", requireSalonPermission("customers", "create"), async (req, res) => {
  try {
    const { customerId, amount, mode, remark } = req.body;
    if (!customerId || !amount) return res.status(400).json({ error: "customerId and amount are required" });
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return res.status(400).json({ error: "Invalid amount" });
    const customer = await prisma.customer.findFirst({ where: { id: customerId, salonId: req.salonId } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    const appointment = await prisma.appointment.create({
      data: {
        salonId: req.salonId,
        customerId,
        branchId: null,
        startAt: new Date(),
        endAt: new Date(),
        status: "CONFIRMED",
        advancePaidAmount: numericAmount,
        advancePaymentRequired: true,
        note: remark || `Advance payment: ${numericAmount} (${mode || "Online"})`
      }
    });
    res.json({ id: appointment.id, amount: numericAmount, mode: mode || "Online", remark: remark || "", createdAt: appointment.createdAt });
  } catch (error) {
    res.status(500).json({ error: "Failed to create advance payment" });
  }
});

ownerRouter.post("/follow-ups", requireSalonPermission("customers", "edit"), async (req, res) => {
  try {
    const { customerId, date, time, message, type } = req.body;
    if (!customerId || !date || !message) return res.status(400).json({ error: "customerId, date, and message are required" });
    const customer = await prisma.customer.findFirst({ where: { id: customerId, salonId: req.salonId } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    const followUpDate = time ? new Date(`${date}T${time}`) : new Date(date);
    await prisma.customer.update({
      where: { id: customerId },
      data: {
        followUpAt: followUpDate,
        notes: `${customer.notes || ""}\n[Follow-up ${type || "call"} ${date}${time ? ` ${time}` : ""}] ${message}`.trim()
      }
    });
    res.json({ id: customerId, date: followUpDate, message, type: type || "call", status: "scheduled" });
  } catch (error) {
    res.status(500).json({ error: "Failed to create follow-up" });
  }
});


