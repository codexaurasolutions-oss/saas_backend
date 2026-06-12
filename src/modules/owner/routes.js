import { Router } from "express";
import bcrypt from "bcryptjs";
import XLSX from "xlsx";
import { prisma } from "../../lib/prisma.js";
import { attachBranchStock } from "../../lib/phase2.js";
import { createAuditLog } from "../../lib/phase4.js";
import { patchRouterForAsync } from "../../lib/async-handler.js";
import { requireAuth, requireMaintenanceAccess, requireSalonContext, requireSalonPermission } from "../../middlewares/rbac.js";
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

  const [catalogSettings, ecommerceSettings] = await Promise.all([
    prisma.catalogSetting.findFirst({ where: { salonId, branchId: null } }),
    prisma.ecommerceSetting.findUnique({ where: { salonId } })
  ]);

  const catalogPayload = {
    showProducts: pickBoolean(generic.showProductsOnHome, catalogSettings?.showProducts ?? true),
    whatsappNumber: payload.whatsappNumber || catalogSettings?.whatsappNumber || null,
    branchDisplaySettings: {
      ...(typeof catalogSettings?.branchDisplaySettings === "object" && catalogSettings.branchDisplaySettings ? catalogSettings.branchDisplaySettings : {}),
      showAllBranchesInCatalogue: pickBoolean(generic.showAllBranchesInCatalogue, false)
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
    const rulePayload = {
      pointsPerCurrency: toAmount(loyaltySettings.pointsPerCurrency ?? 1),
      minRedeemPoints: Number(loyaltySettings.minRedeemPoints ?? 100),
      maxRedeemPercent: loyaltySettings.maxRedeemPercent ?? null,
      expiryDays: loyaltySettings.expiryDays ?? null,
      isActive: loyaltySettings.enabled !== false,
      notes: "Managed from Settings > Loyalty"
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
      await prisma.service.updateMany({
        where: { salonId, isActive: true, taxRate: null },
        data: { taxRate: toAmount(primaryTax.rate ?? 0) }
      });
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
      await prisma.product.updateMany({
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
    const discountType = String(referralSettings.referredRewardMode || "fixed").toLowerCase() === "percent" ? "PERCENT" : "FIXED";
    const discountValue = toAmount(referralSettings.referredRewardValue ?? 0);
    const referralPayload = {
      title: "Referral Welcome Offer",
      description: `Auto-managed from Settings > Referrals. Referrer reward: ${referralSettings.referrerRewardValue || 0} ${referralSettings.referrerRewardMode || "fixed"}. Max limit: ${referralSettings.maxReferLimit || 0}.`,
      discountType,
      discountValue,
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
      notes: "Managed automatically from Settings > Referrals"
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
    bankName, bankBranch, accountNumber, ifscCode
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
        ifscCode: ifscCode || null
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
  res.status(201).json(await prisma.service.create({
    data: {
      ...req.body,
      branchId,
      categoryId,
      gender: req.body.gender || null,
      price: toAmount(req.body.price),
      durationMin: Number(req.body.durationMin),
      taxRate: req.body.taxRate != null ? toAmount(req.body.taxRate) : null,
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
  res.json(filteredRows);
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
ownerRouter.get("/customers/:id", requireSalonPermission("customers", "view"), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, salonId: req.salonId },
    include: {
      invoices: {
        include: { items: true, payments: true, branch: true },
        orderBy: { createdAt: "desc" }
      }
    }
  });
  if (!customer) return res.status(404).json({ message: "Customer not found" });
  res.json(customer);
});

ownerRouter.get("/users", requireSalonPermission("staff", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  res.json(await prisma.userSalon.findMany({
    where: { salonId: req.salonId, isArchived: false, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: { include: { category: true } } } } },
    orderBy: { id: "desc" }
  }));
});
ownerRouter.get("/staff-users", requireSalonPermission("staff", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  res.json(await prisma.userSalon.findMany({
    where: { salonId: req.salonId, isArchived: false, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
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
ownerRouter.post("/custom-roles", requireSalonPermission("staff", "create"), validate(schemas.customRole), async (req, res) => {
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
ownerRouter.patch("/custom-roles/:id", requireSalonPermission("staff", "edit"), validate(schemas.customRole), async (req, res) => {
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
ownerRouter.patch("/users/:id", requireSalonPermission("staff", "edit"), validate(schemas.userMembershipUpdate), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  const branchId = req.body.branchId === null ? null : normalizeBranchId(req.body.branchId ?? row.branchId);
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
        ifscCode: req.body.ifscCode !== undefined ? req.body.ifscCode : row.ifscCode
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
ownerRouter.post("/settings", requireSalonPermission("settings", "edit"), validate(schemas.salonSettings), async (req, res) => {
  const branchId = req.body.branchId || null;
  const payload = {
    invoicePrefix: req.body.invoicePrefix,
    invoiceFooter: req.body.invoiceFooter,
    taxLabel: req.body.taxLabel,
    paymentModes: req.body.paymentModes,
    whatsappNumber: req.body.whatsappNumber || null,
    bookingNotes: req.body.bookingNotes || null,
    cancellationPolicy: req.body.cancellationPolicy || null,
    allowNegativeStock: Boolean(req.body.allowNegativeStock),
    paymentGatewaySettings: req.body.paymentGatewaySettings || null,
    advancedSettings: req.body.advancedSettings || null,
    smsSettings: req.body.smsSettings || null
  };
  const existing = await prisma.salonSetting.findFirst({
    where: { salonId: req.salonId, branchId }
  });
  const row = existing
    ? await prisma.salonSetting.update({
        where: { id: existing.id },
        data: payload
      })
    : await prisma.salonSetting.create({
        data: { salonId: req.salonId, ...payload, branchId }
      });
  if (!branchId) {
    await syncGenericSettingsToPublicChannels(req.salonId, payload);
    await syncAdvancedSettingsToOperationalDefaults(req.salonId, payload);
  }
  await createAuditLog({
    salonId: req.salonId,
    actorUserId: req.user.userId,
    actorMembershipId: req.user.membershipId,
    module: "SETTINGS",
    action: existing ? "SETTINGS_UPDATED" : "SETTINGS_CREATED",
    entityType: "SalonSetting",
    entityId: row.id,
    summary: branchId ? "Branch-level settings saved" : "Salon settings saved",
    metadata: {
      branchId,
      paymentModes: payload.paymentModes,
      allowNegativeStock: payload.allowNegativeStock,
      paymentLinkEnabled: payload.paymentGatewaySettings?.paymentLinkEnabled ?? null
    }
  });
  res.status(201).json(row);
});

ownerRouter.get("/website/config", requireSalonPermission("settings", "view"), async (req, res) => {
  let config = await prisma.websiteConfig.findUnique({
    where: { salonId: req.salonId }
  });
  if (!config) {
    config = { heroTitle: "", heroSubtitle: "", heroImage: "" };
  }
  res.json(config);
});

ownerRouter.post("/website/config", requireSalonPermission("settings", "edit"), async (req, res) => {
  const { heroTitle, heroSubtitle, heroImage } = req.body;
  const config = await prisma.websiteConfig.upsert({
    where: { salonId: req.salonId },
    update: { heroTitle, heroSubtitle, heroImage },
    create: { salonId: req.salonId, heroTitle, heroSubtitle, heroImage }
  });
  res.json(config);
});

ownerRouter.get("/reports/trends", requireSalonPermission("reports", "view"), async (req, res) => {
  const range = req.query.range || "7D";

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

  let serviceRev = 0, productRev = 0, packageRev = 0, membershipRev = 0;

  invoices.forEach(inv => {
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

  invoices.forEach(inv => {
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
  invoices.forEach(inv => {
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
  invoices.forEach(inv => {
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
    revenueSplit,
    trendLine:   Object.values(dateMap),
    topServices,
    topStaff,
    summary: {
      totalInvoices: invoices.length,
      totalRevenue:  totalRev,
      avgBillValue:  invoices.length ? Math.round(totalRev / invoices.length) : 0,
    }
  });
});

registerPhase2OwnerRoutes(ownerRouter);
registerPhase3OwnerRoutes(ownerRouter);
registerPhase4OwnerRoutes(ownerRouter);

