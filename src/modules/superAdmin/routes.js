import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireSystemRole } from "../../middlewares/rbac.js";
import { validate, schemas } from "../../middlewares/validate.js";
import { defaultOwnerPermissions } from "../../lib/permissions.js";
import { approveDemoLead, resendDemoInvite } from "../../lib/demoInvites.js";
import { convertDemoToPaid, sendTrialReminder } from "../../lib/subscriptionLifecycle.js";
import { runExpiredDemoCleanup } from "../../lib/trialCleanup.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { createAuditLog } from "../../lib/phase4.js";

export const superAdminRouter = Router();
superAdminRouter.use(requireAuth, requireSystemRole("SUPER_ADMIN"));

const toAmount = (value) => Number(value || 0);
const toDate = (value) => (value ? new Date(value) : null);
const defaultFeatureFlags = {
  pos: true,
  appointments: false,
  inventory: false,
  crm: true,
  campaigns: false,
  campaignTemplates: false,
  campaignAnalytics: false,
  ecommerce: false,
  digitalCatalog: false,
  catalogAnalytics: false,
  feedback: false,
  reports: true,
  memberships: false,
  packages: false,
  loyalty: false,
  couponsGiftCards: false,
  whatsapp: false,
  enquiries: false,
  expenses: false,
  attendance: false,
  leaves: false,
  customerPortal: false,
  publicCatalog: true,
  onlineOrders: false,
  messageTemplates: false,
  notifications: true,
  auditLogs: true,
  advancedReports: true
};
const fullFeatureFlags = (featureFlags) => ({ ...defaultFeatureFlags, ...(featureFlags || {}) });

superAdminRouter.get("/dashboard", asyncHandler(async (req, res) => {
  const period = String(req.query.period || "month");
  const now = new Date();
  const start = new Date(now);
  if (period === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (period === "year") {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
  }

  const [totalSalons, activeSalons, trialSalons, expiredSalons, suspendedSalons, demoLeadsCount, plans, subscriptions, recentSalons, recentPayments, supportTicketsCount] = await Promise.all([
    prisma.salon.count(),
    prisma.salon.count({ where: { status: "ACTIVE" } }),
    prisma.salon.count({ where: { status: "TRIAL" } }),
    prisma.salon.count({ where: { status: "EXPIRED" } }),
    prisma.salon.count({ where: { status: "SUSPENDED" } }),
    prisma.demoLead.count(),
    prisma.plan.findMany(),
    prisma.subscription.findMany({ include: { plan: true, salon: true } }),
    prisma.salon.findMany({ take: 5, orderBy: { createdAt: "desc" } }),
    prisma.payment.findMany({ where: { createdAt: { gte: start } }, take: 5, orderBy: { createdAt: "desc" } }),
    prisma.supportTicket.count()
  ]);

  const totalSubscriptionRevenue = subscriptions.reduce((sum, sub) => sum + Math.max(0, toAmount(sub.plan?.monthlyPrice || 0) - toAmount(sub.manualDiscount || 0)), 0);
  const monthlySubscriptionRevenue = subscriptions
    .filter((sub) => new Date(sub.startsAt) >= start)
    .reduce((sum, sub) => sum + Math.max(0, toAmount(sub.plan?.monthlyPrice || 0) - toAmount(sub.manualDiscount || 0)), 0);

  const activePlansSummary = plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    monthlyPrice: Number(plan.monthlyPrice),
    yearlyPrice: Number(plan.yearlyPrice)
  }));
  const expiredSubscriptionsSummary = subscriptions.filter((sub) => sub.status === "EXPIRED").length;

  res.json({
    totalSalons,
    activeSalons,
    trialSalons,
    expiredSalons,
    suspendedSalons,
    demoLeadsCount,
    plansCount: plans.length,
    totalSubscriptionRevenue,
    monthlySubscriptionRevenue,
    supportTicketsCount,
    activePlansSummary,
    expiredSubscriptionsSummary,
    recentSalons,
    recentPayments,
    period
  });
}));

superAdminRouter.post("/salons", validate(schemas.salon), asyncHandler(async (req, res) => {
  const { ownerName, ownerEmail, ownerPassword, featureFlags, trialStartsAt, trialEndsAt, taxRate, ...salonData } = req.body;

  const salon = await prisma.$transaction(async (tx) => {
    const createdSalon = await tx.salon.create({
      data: {
        ...salonData,
        taxRate: taxRate != null ? toAmount(taxRate) : null,
        trialStartsAt: toDate(trialStartsAt),
        trialEndsAt: toDate(trialEndsAt),
        featureFlags: fullFeatureFlags(featureFlags)
      }
    });

    if (ownerEmail && ownerName && ownerPassword) {
      const owner = await tx.user.create({
        data: {
          name: ownerName,
          email: ownerEmail,
          passwordHash: await bcrypt.hash(ownerPassword, 10),
          systemRole: "SALON_USER"
        }
      });

      await tx.userSalon.create({
        data: {
          userId: owner.id,
          salonId: createdSalon.id,
          salonRole: "SALON_OWNER",
          permissions: defaultOwnerPermissions
        }
      });
    }

    return createdSalon;
  });

  res.status(201).json(salon);
}));

superAdminRouter.get("/salons", asyncHandler(async (req, res) => {
  const q = req.query.q ? String(req.query.q).trim() : "";
  const status = req.query.status ? String(req.query.status) : "";
  res.json(
    await prisma.salon.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(q ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { slug: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
            { city: { contains: q, mode: "insensitive" } },
            { country: { contains: q, mode: "insensitive" } }
          ]
        } : {})
      },
      include: {
        subscriptions: { include: { plan: true, history: { orderBy: { createdAt: "desc" } } } },
        users: { include: { user: true } }
      },
      orderBy: { createdAt: "desc" }
    })
  );
}));
superAdminRouter.get("/salons/:id", asyncHandler(async (req, res) =>
  res.json(
    await prisma.salon.findUnique({
      where: { id: req.params.id },
      include: {
        subscriptions: { include: { plan: true, history: { orderBy: { createdAt: "desc" } } } },
        users: { include: { user: true, branch: true } },
        branches: true,
        services: true,
        customers: true
      }
    })
  )
));
superAdminRouter.patch("/salons/:id", validate(schemas.salon), asyncHandler(async (req, res) => {
  const { ownerName, ownerEmail, ownerPassword, trialStartsAt, trialEndsAt, taxRate, ...data } = req.body;
  res.json(await prisma.salon.update({
    where: { id: req.params.id },
    data: {
      ...data,
      taxRate: taxRate != null ? toAmount(taxRate) : null,
      trialStartsAt: trialStartsAt ? new Date(trialStartsAt) : null,
      trialEndsAt: trialEndsAt ? new Date(trialEndsAt) : null
    }
  }));
}));
superAdminRouter.patch("/salons/:id/archive", asyncHandler(async (req, res) => res.json(await prisma.salon.update({ where: { id: req.params.id }, data: { status: "EXPIRED" } }))));
superAdminRouter.patch("/salons/:id/status", asyncHandler(async (req, res) => res.json(await prisma.salon.update({ where: { id: req.params.id }, data: { status: req.body.status } }))));
superAdminRouter.patch("/salons/:id/features", asyncHandler(async (req, res) => res.json(await prisma.salon.update({ where: { id: req.params.id }, data: { featureFlags: fullFeatureFlags(req.body.featureFlags) } }))));
superAdminRouter.post("/salons/:id/impersonate", asyncHandler(async (req, res) => {
  const salon = await prisma.salon.findUnique({ where: { id: req.params.id } });
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  await createAuditLog({
    actorUserId: req.user.userId,
    module: "SUPPORT",
    action: "OWNER_IMPERSONATION_REQUESTED",
    entityType: "SALON",
    entityId: salon.id,
    reference: salon.slug || salon.id,
    summary: `Support impersonation requested for ${salon.name}`,
    metadata: {
      actorUserId: req.user.userId,
      actorName: req.user.name,
      placeholder: true
    }
  });
  res.json({ message: "Owner impersonation placeholder ready for support workflow.", salonId: salon.id });
}));

superAdminRouter.post("/plans", validate(schemas.plan), asyncHandler(async (req, res) => {
  const {
    name,
    monthlyPrice,
    yearlyPrice,
    trialDays,
    branchLimit,
    userLimit,
    customerLimit,
    invoiceLimit,
    storageLimit,
    isCustom,
    featureFlags
  } = req.body;

  const plan = await prisma.plan.create({
    data: {
      name,
      trialDays,
      branchLimit,
      userLimit,
      customerLimit,
      invoiceLimit,
      featureFlags,
      monthlyPrice: toAmount(monthlyPrice),
      yearlyPrice: toAmount(yearlyPrice),
      storageLimit: storageLimit != null ? Number(storageLimit) : null,
      isCustom: Boolean(isCustom)
    }
  });
  res.status(201).json(plan);
}));
superAdminRouter.get("/plans", asyncHandler(async (req, res) => res.json(await prisma.plan.findMany({ orderBy: { createdAt: "desc" } }))));
superAdminRouter.patch("/plans/:id", validate(schemas.plan), asyncHandler(async (req, res) => {
  const {
    name,
    monthlyPrice,
    yearlyPrice,
    trialDays,
    branchLimit,
    userLimit,
    customerLimit,
    invoiceLimit,
    storageLimit,
    isCustom,
    featureFlags
  } = req.body;

  res.json(await prisma.plan.update({
    where: { id: req.params.id },
    data: {
      name,
      trialDays,
      branchLimit,
      userLimit,
      customerLimit,
      invoiceLimit,
      featureFlags,
      monthlyPrice: toAmount(monthlyPrice),
      yearlyPrice: toAmount(yearlyPrice),
      storageLimit: storageLimit != null ? Number(storageLimit) : null,
      isCustom: Boolean(isCustom)
    }
  }));
}));

superAdminRouter.post("/subscriptions", validate(schemas.subscription), asyncHandler(async (req, res) => {
  const sub = await prisma.$transaction(async (tx) => {
    const created = await tx.subscription.create({
      data: {
        ...req.body,
        manualDiscount: req.body.manualDiscount != null ? toAmount(req.body.manualDiscount) : null,
        startsAt: new Date(req.body.startsAt),
        endsAt: new Date(req.body.endsAt)
      }
    });
    await tx.subscriptionHistory.create({
      data: {
        subscriptionId: created.id,
        action: "CREATED",
        createdBy: req.user.name,
        toStatus: created.status,
        toPaymentStatus: created.paymentStatus || "PENDING",
        notes: created.notes || null
      }
    });
    return tx.subscription.findUnique({
      where: { id: created.id },
      include: { salon: true, plan: true, history: { orderBy: { createdAt: "desc" } } }
    });
  });
  res.status(201).json(sub);
}));
superAdminRouter.get("/subscriptions", asyncHandler(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : "";
  const paymentStatus = req.query.paymentStatus ? String(req.query.paymentStatus) : "";
  const q = req.query.q ? String(req.query.q).trim() : "";
  res.json(await prisma.subscription.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(paymentStatus ? { paymentStatus } : {}),
      ...(q ? {
        OR: [
          { salon: { is: { name: { contains: q, mode: "insensitive" } } } },
          { plan: { is: { name: { contains: q, mode: "insensitive" } } } },
          { notes: { contains: q, mode: "insensitive" } }
        ]
      } : {})
    },
    include: { salon: true, plan: true, history: { orderBy: { createdAt: "desc" } } },
    orderBy: { startsAt: "desc" }
  }));
}));
superAdminRouter.patch("/subscriptions/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.subscription.findUnique({
    where: { id: req.params.id },
    include: { plan: true }
  });
  if (!existing) return res.status(404).json({ message: "Subscription not found" });

  const nextPlan = req.body.planId && req.body.planId !== existing.planId
    ? await prisma.plan.findUnique({ where: { id: req.body.planId } })
    : existing.plan;

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.subscription.update({
      where: { id: req.params.id },
      data: {
        ...(req.body.status ? { status: req.body.status } : {}),
        ...(req.body.paymentStatus ? { paymentStatus: req.body.paymentStatus } : {}),
        ...(req.body.notes !== undefined ? { notes: req.body.notes } : {}),
        ...(req.body.manualDiscount !== undefined ? { manualDiscount: toAmount(req.body.manualDiscount) } : {}),
        ...(req.body.planId ? { planId: req.body.planId } : {}),
        ...(req.body.endsAt ? { endsAt: new Date(req.body.endsAt) } : {})
      }
    });

    const planChanged = req.body.planId && req.body.planId !== existing.planId;
    const oldMonthly = toAmount(existing.plan?.monthlyPrice || 0);
    const nextMonthly = toAmount(nextPlan?.monthlyPrice || 0);
    const action = planChanged
      ? nextMonthly > oldMonthly
        ? "UPGRADED"
        : nextMonthly < oldMonthly
          ? "DOWNGRADED"
          : "PLAN_CHANGED"
      : "UPDATED";

    await tx.subscriptionHistory.create({
      data: {
        subscriptionId: row.id,
        action,
        createdBy: req.user.name,
        fromStatus: existing.status,
        toStatus: row.status,
        fromPaymentStatus: existing.paymentStatus || "PENDING",
        toPaymentStatus: row.paymentStatus || "PENDING",
        notes: req.body.notes ?? row.notes ?? null
      }
    });

    return tx.subscription.findUnique({
      where: { id: row.id },
      include: { salon: true, plan: true, history: { orderBy: { createdAt: "desc" } } }
    });
  });

  res.json(updated);
}));
superAdminRouter.post("/subscriptions/:id/send-trial-reminder", asyncHandler(async (req, res) => {
  const result = await sendTrialReminder({
    subscriptionId: req.params.id,
    actorName: req.user.name
  });
  if (result.error) return res.status(result.error.status).json({ message: result.error.message });
  return res.json(result);
}));
superAdminRouter.post("/subscriptions/:id/convert-demo", validate(schemas.convertSubscription), asyncHandler(async (req, res) => {
  const result = await convertDemoToPaid({
    subscriptionId: req.params.id,
    actorName: req.user.name,
    planId: req.body.planId,
    endsAt: req.body.endsAt,
    paymentStatus: req.body.paymentStatus,
    manualDiscount: req.body.manualDiscount,
    notes: req.body.notes
  });
  if (result.error) return res.status(result.error.status).json({ message: result.error.message });
  return res.json(result);
}));
superAdminRouter.post("/subscriptions/run-demo-cleanup", asyncHandler(async (req, res) => {
  const result = await runExpiredDemoCleanup({
    actorName: req.user.name
  });
  return res.json(result);
}));

superAdminRouter.get("/demo-leads", asyncHandler(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : "";
  const q = req.query.q ? String(req.query.q).trim() : "";
  res.json(
    await prisma.demoLead.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(q ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { phone: { contains: q, mode: "insensitive" } },
            { message: { contains: q, mode: "insensitive" } }
          ]
        } : {})
      },
      include: {
        salon: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true
          }
        }
      },
      orderBy: { createdAt: "desc" }
    })
  );
}));
superAdminRouter.post("/demo-leads/:id/approve", validate(schemas.demoLeadReview), asyncHandler(async (req, res) => {
  const result = await approveDemoLead({
    leadId: req.params.id,
    actorName: req.user.name,
    planId: req.body.planId,
    trialDays: req.body.trialDays || 7,
    salonName: req.body.salonName,
    businessType: req.body.businessType,
    reviewNote: req.body.reviewNote
  });
  if (result.error) return res.status(result.error.status).json({ message: result.error.message });
  return res.status(201).json(result);
}));
superAdminRouter.post("/demo-leads/:id/reject", validate(schemas.demoLeadReject), asyncHandler(async (req, res) => {
  const lead = await prisma.demoLead.findUnique({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ message: "Demo lead not found" });
  if (lead.status === "APPROVED") {
    return res.status(400).json({ message: "Approved demo leads cannot be rejected directly." });
  }
  const updated = await prisma.demoLead.update({
    where: { id: req.params.id },
    data: {
      status: "REJECTED",
      reviewedAt: new Date(),
      reviewedByName: req.user.name,
      reviewNote: req.body.reviewNote
    }
  });
  return res.json(updated);
}));
superAdminRouter.post("/demo-leads/:id/resend-invite", asyncHandler(async (req, res) => {
  const result = await resendDemoInvite({ leadId: req.params.id });
  if (result.error) return res.status(result.error.status).json({ message: result.error.message });
  return res.json(result);
}));
superAdminRouter.get("/support-tickets", asyncHandler(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : "";
  const priority = req.query.priority ? String(req.query.priority) : "";
  const q = req.query.q ? String(req.query.q).trim() : "";
  res.json(await prisma.supportTicket.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(q ? {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
          { category: { contains: q, mode: "insensitive" } },
          { salon: { is: { name: { contains: q, mode: "insensitive" } } } }
        ]
      } : {})
    },
    include: { salon: true, messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" }
  }));
}));
superAdminRouter.patch("/support-tickets/:id", asyncHandler(async (req, res) => {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ message: "Support ticket not found" });

  if (ticket.status === "CLOSED") {
    const requestedStatus = req.body.status;
    if (!requestedStatus || !["OPEN", "PENDING"].includes(requestedStatus)) {
      return res.status(400).json({ message: "Closed tickets are read-only unless reopened first" });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.supportTicket.update({ where: { id: req.params.id }, data: req.body });
    const eventMessages = [];
    if (req.body.status && req.body.status !== ticket.status) {
      eventMessages.push({
        ticketId: row.id,
        eventType: "STATUS_CHANGED",
        actorName: req.user.name,
        details: `Ticket moved from ${ticket.status} to ${req.body.status}`,
        fromStatus: ticket.status,
        toStatus: req.body.status
      });
    }
    if (req.body.assignedAgentName !== undefined && req.body.assignedAgentName !== ticket.assignedAgentName) {
      eventMessages.push({
        ticketId: row.id,
        eventType: "AGENT_ASSIGNED",
        actorName: req.user.name,
        details: req.body.assignedAgentName ? `Assigned to ${req.body.assignedAgentName}` : "Agent assignment cleared"
      });
    }
    if (req.body.internalNote !== undefined && req.body.internalNote !== ticket.internalNote) {
      eventMessages.push({
        ticketId: row.id,
        eventType: "NOTE_UPDATED",
        actorName: req.user.name,
        details: "Internal support note updated"
      });
    }
    if (eventMessages.length) {
      await tx.supportTicketEvent.createMany({ data: eventMessages });
    }
    return tx.supportTicket.findUnique({
      where: { id: row.id },
      include: { salon: true, messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
    });
  });
  res.json(updated);
}));
superAdminRouter.post("/support-tickets/:id/messages", asyncHandler(async (req, res) => {
  const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ message: "Support ticket not found" });
  await prisma.$transaction(async (tx) => {
    await tx.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        authorType: "SUPER_ADMIN",
        authorName: req.user.name,
        message: req.body.message,
        attachmentUrl: req.body.attachmentUrl || null
      }
    });
    await tx.supportTicket.update({ where: { id: ticket.id }, data: { status: req.body.status || "PENDING" } });
    await tx.supportTicketEvent.create({
      data: {
        ticketId: ticket.id,
        eventType: "REPLY_SENT",
        actorName: req.user.name,
        details: req.body.attachmentUrl ? "Support reply sent with attachment placeholder" : "Support reply sent",
        fromStatus: ticket.status,
        toStatus: req.body.status || "PENDING"
      }
    });
  });
  res.json(await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { salon: true, messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } } }));
}));
superAdminRouter.get("/settings", asyncHandler(async (req, res) => {
  const settings = await prisma.globalSetting.findFirst();
  res.json(settings || { maintenanceMode: false, invoicePrefix: "INV", systemName: "Skillify Clone SaaS" });
}));
superAdminRouter.post("/settings", asyncHandler(async (req, res) => {
  const {
    systemName,
    globalLogo,
    maintenanceMode,
    taxLabel,
    defaultCurrency,
    defaultCountry,
    defaultCity,
    defaultTimezone,
    currencyOptions,
    notificationDefaults,
    whatsappNumber,
    smsProviderName,
    emailProviderName,
    whatsappProviderName,
    contactEmail,
    supportEmail,
    notificationEmail,
    termsUrl,
    termsContent,
    privacyUrl,
    privacyContent,
    demoBookingUrl,
    blogTitle,
    blogIntro,
    backupPolicyNote,
    invoicePrefix
  } = req.body;
  const data = {
    systemName,
    globalLogo: globalLogo || null,
    maintenanceMode: Boolean(maintenanceMode),
    taxLabel,
    defaultCurrency,
    defaultCountry: defaultCountry || null,
    defaultCity: defaultCity || null,
    defaultTimezone: defaultTimezone || null,
    currencyOptions: currencyOptions || [],
    notificationDefaults: notificationDefaults || {},
    whatsappNumber: whatsappNumber || null,
    smsProviderName: smsProviderName || null,
    emailProviderName: emailProviderName || null,
    whatsappProviderName: whatsappProviderName || null,
    contactEmail: contactEmail || null,
    supportEmail: supportEmail || null,
    notificationEmail: notificationEmail || null,
    termsUrl: termsUrl || null,
    termsContent: termsContent || null,
    privacyUrl: privacyUrl || null,
    privacyContent: privacyContent || null,
    demoBookingUrl: demoBookingUrl || null,
    blogTitle: blogTitle || null,
    blogIntro: blogIntro || null,
    backupPolicyNote: backupPolicyNote || null,
    invoicePrefix
  };
  const existing = await prisma.globalSetting.findFirst();
  if (!existing) {
    const created = await prisma.globalSetting.create({ data });
    return res.status(201).json(created);
  }
  const updated = await prisma.globalSetting.update({ where: { id: existing.id }, data });
  return res.json(updated);
}));
superAdminRouter.get("/audit-logs", asyncHandler(async (req, res) => {
  const q = req.query.q ? String(req.query.q).trim().toLowerCase() : "";
  const type = req.query.type ? String(req.query.type).trim() : "";
  const [salons, subscriptions, payments, tickets, leads] = await Promise.all([
    prisma.salon.findMany({ take: 10, orderBy: { createdAt: "desc" } }),
    prisma.subscription.findMany({ take: 10, orderBy: { startsAt: "desc" }, include: { salon: true, plan: true } }),
    prisma.payment.findMany({ take: 10, orderBy: { createdAt: "desc" }, include: { invoice: true } }),
    prisma.supportTicket.findMany({ take: 10, orderBy: { updatedAt: "desc" }, include: { salon: true } }),
    prisma.demoLead.findMany({ take: 10, orderBy: { createdAt: "desc" } })
  ]);

  const logs = [
    ...salons.map((salon) => ({
      id: `salon-${salon.id}`,
      type: "SALON_CREATED",
      action: `Salon ${salon.name} created`,
      meta: { salonId: salon.id, status: salon.status },
      createdAt: salon.createdAt
    })),
    ...subscriptions.map((subscription) => ({
      id: `subscription-${subscription.id}`,
      type: "SUBSCRIPTION_UPDATED",
      action: `${subscription.salon?.name || "Salon"} assigned ${subscription.plan?.name || "plan"} (${subscription.status})`,
      meta: { subscriptionId: subscription.id, status: subscription.status, paymentStatus: subscription.paymentStatus },
      createdAt: subscription.startsAt
    })),
    ...payments.map((payment) => ({
      id: `payment-${payment.id}`,
      type: "PAYMENT_RECORDED",
      action: `Payment ${payment.mode} recorded for invoice ${payment.invoice?.invoiceNumber || "-"}`,
      meta: { paymentId: payment.id, invoiceId: payment.invoiceId, amount: Number(payment.amount) },
      createdAt: payment.createdAt
    })),
    ...tickets.map((ticket) => ({
      id: `ticket-${ticket.id}`,
      type: "SUPPORT_ACTIVITY",
      action: `Support ticket ${ticket.title} is ${ticket.status}`,
      meta: { ticketId: ticket.id, salon: ticket.salon?.name || "Global" },
      createdAt: ticket.updatedAt
    })),
    ...leads.map((lead) => ({
      id: `lead-${lead.id}`,
      type: "DEMO_LEAD",
      action: `Demo request from ${lead.name}`,
      meta: { leadId: lead.id, email: lead.email },
      createdAt: lead.createdAt
    }))
  ]
    .filter((row) => {
      if (type && row.type !== type) return false;
      if (!q) return true;
      const haystack = `${row.type} ${row.action} ${JSON.stringify(row.meta || {})}`.toLowerCase();
      return haystack.includes(q);
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 30);

  res.json(logs);
}));

superAdminRouter.get("/product-requirements", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.priority) where.priority = req.query.priority;
  if (req.query.branchId) where.branchId = req.query.branchId;
  if (req.query.q) {
    where.OR = [
      { productName: { contains: req.query.q, mode: "insensitive" } },
      { description: { contains: req.query.q, mode: "insensitive" } },
      { vendor: { contains: req.query.q, mode: "insensitive" } }
    ];
  }
  const rows = await prisma.productRequirement.findMany({ where, orderBy: { createdAt: "desc" } });
  res.json(rows);
}));

superAdminRouter.post("/product-requirements", asyncHandler(async (req, res) => {
  const row = await prisma.productRequirement.create({ data: {
    productName: req.body.productName,
    description: req.body.description || null,
    category: req.body.category || null,
    quantity: req.body.requiredQty || req.body.quantity || 1,
    unitPrice: req.body.unitCost || req.body.unitPrice || null,
    priority: req.body.priority || "MEDIUM",
    status: req.body.status || "PENDING",
    vendor: req.body.vendor || null
  }});
  res.status(201).json(row);
}));

superAdminRouter.patch("/product-requirements/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.productRequirement.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Not found" });
  const data = {};
  if (req.body.productName !== undefined) data.productName = req.body.productName;
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.category !== undefined) data.category = req.body.category;
  if (req.body.requiredQty !== undefined || req.body.quantity !== undefined) data.quantity = req.body.requiredQty || req.body.quantity;
  if (req.body.unitCost !== undefined || req.body.unitPrice !== undefined) data.unitPrice = req.body.unitCost || req.body.unitPrice;
  if (req.body.priority !== undefined) data.priority = req.body.priority;
  if (req.body.status !== undefined) data.status = req.body.status;
  if (req.body.vendor !== undefined) data.vendor = req.body.vendor;
  res.json(await prisma.productRequirement.update({ where: { id: req.params.id }, data }));
}));

superAdminRouter.delete("/product-requirements/:id", asyncHandler(async (req, res) => {
  await prisma.productRequirement.delete({ where: { id: req.params.id } });
  res.json({ message: "Deleted" });
}));

superAdminRouter.get("/staff-requirements", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.urgency) where.urgency = req.query.urgency;
  if (req.query.branchId) where.branchId = req.query.branchId;
  if (req.query.department) where.department = req.query.department;
  if (req.query.q) {
    where.OR = [
      { title: { contains: req.query.q, mode: "insensitive" } },
      { description: { contains: req.query.q, mode: "insensitive" } },
      { department: { contains: req.query.q, mode: "insensitive" } },
      { skills: { contains: req.query.q, mode: "insensitive" } }
    ];
  }
  const rows = await prisma.staffRequirement.findMany({ where, orderBy: { createdAt: "desc" } });
  res.json(rows);
}));

superAdminRouter.post("/staff-requirements", asyncHandler(async (req, res) => {
  const skillsStr = Array.isArray(req.body.skills) ? req.body.skills.join(",") : (req.body.skills || null);
  const row = await prisma.staffRequirement.create({ data: {
    salonId: req.body.salonId || null,
    branchId: req.body.branchId || null,
    title: req.body.title,
    description: req.body.description || null,
    department: req.body.department || null,
    position: req.body.position || null,
    salary: req.body.salary || null,
    shift: req.body.shift || "Full-Time",
    urgency: req.body.urgency || "MEDIUM",
    skills: skillsStr,
    count: Number(req.body.quantity) || Number(req.body.count) || 1,
    priority: req.body.priority || "MEDIUM",
    status: req.body.status || "OPEN"
  }});
  res.status(201).json(row);
}));

superAdminRouter.patch("/staff-requirements/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.staffRequirement.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Not found" });
  const data = {};
  if (req.body.title !== undefined) data.title = req.body.title;
  if (req.body.description !== undefined) data.description = req.body.description;
  if (req.body.department !== undefined) data.department = req.body.department;
  if (req.body.position !== undefined) data.position = req.body.position;
  if (req.body.salary !== undefined) data.salary = req.body.salary;
  if (req.body.shift !== undefined) data.shift = req.body.shift;
  if (req.body.urgency !== undefined) data.urgency = req.body.urgency;
  if (req.body.priority !== undefined) data.priority = req.body.priority;
  if (req.body.status !== undefined) data.status = req.body.status;
  if (req.body.branchId !== undefined) data.branchId = req.body.branchId || null;
  if (req.body.salonId !== undefined) data.salonId = req.body.salonId || null;
  if (req.body.quantity !== undefined || req.body.count !== undefined) data.count = Number(req.body.quantity) || Number(req.body.count);
  if (req.body.skills !== undefined) data.skills = Array.isArray(req.body.skills) ? req.body.skills.join(",") : (req.body.skills || null);
  res.json(await prisma.staffRequirement.update({ where: { id: req.params.id }, data }));
}));

superAdminRouter.delete("/staff-requirements/:id", asyncHandler(async (req, res) => {
  await prisma.staffRequirement.delete({ where: { id: req.params.id } });
  res.json({ message: "Deleted" });
}));

superAdminRouter.get("/branches/limit-info", asyncHandler(async (req, res) => {
  const { salonId } = req.query;
  if (!salonId) return res.status(400).json({ message: "salonId is required" });

  const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { id: true, name: true } });
  if (!salon) return res.status(404).json({ message: "Salon not found" });

  const branchCount = await prisma.branch.count({ where: { salonId } });

  const subscription = await prisma.subscription.findFirst({
    where: { salonId },
    include: { plan: { select: { id: true, name: true, branchLimit: true } } },
    orderBy: { startsAt: "desc" }
  });

  const plan = subscription?.plan || null;
  const branchLimit = plan?.branchLimit ?? 9999;
  const remaining = Math.max(0, branchLimit - branchCount);

  res.json({ salon, branchCount, branchLimit, remaining, planName: plan?.name || "No Plan" });
}));

superAdminRouter.get("/branches", asyncHandler(async (req, res) => {
  const where = {};
  if (req.query.salonId) where.salonId = req.query.salonId;
  if (req.query.isActive !== undefined) where.isActive = req.query.isActive === "true";
  if (req.query.q) {
    where.OR = [
      { name: { contains: req.query.q, mode: "insensitive" } },
      { email: { contains: req.query.q, mode: "insensitive" } },
      { phone: { contains: req.query.q, mode: "insensitive" } }
    ];
  }
  const rows = await prisma.branch.findMany({
    where,
    include: { salon: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" }
  });
  res.json(rows);
}));

superAdminRouter.post("/branches", asyncHandler(async (req, res) => {
  const { salonId, name, phone, email, address, businessHours, weeklyOff, latitude, longitude, geofenceRadiusMeters } = req.body;
  if (!salonId || !name) return res.status(400).json({ message: "salonId and name are required" });

  const salon = await prisma.salon.findUnique({ where: { id: salonId } });
  if (!salon) return res.status(404).json({ message: "Salon not found" });

  const branchCount = await prisma.branch.count({ where: { salonId } });
  const subscription = await prisma.subscription.findFirst({
    where: { salonId },
    include: { plan: { select: { branchLimit: true } } },
    orderBy: { startsAt: "desc" }
  });
  const branchLimit = subscription?.plan?.branchLimit ?? 9999;

  if (branchCount >= branchLimit) {
    return res.status(400).json({ message: `Branch limit reached. Your ${subscription?.plan?.name || "plan"} allows ${branchLimit} branches. ${branchCount} already exist. Upgrade your plan to add more branches.` });
  }

  const existing = await prisma.branch.findFirst({ where: { salonId, name: { equals: name, mode: "insensitive" } } });
  if (existing) return res.status(409).json({ message: `A branch named "${name}" already exists in this salon.` });

  const row = await prisma.branch.create({ data: {
    salonId,
    name,
    phone: phone || null,
    email: email || null,
    address: address || null,
    businessHours: businessHours || null,
    weeklyOff: weeklyOff || null,
    latitude: latitude != null ? Number(latitude) : null,
    longitude: longitude != null ? Number(longitude) : null,
    geofenceRadiusMeters: geofenceRadiusMeters != null ? Number(geofenceRadiusMeters) : 200
  }});

  res.status(201).json(row);
}));

superAdminRouter.patch("/branches/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.branch.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Branch not found" });
  const data = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  if (req.body.phone !== undefined) data.phone = req.body.phone || null;
  if (req.body.email !== undefined) data.email = req.body.email || null;
  if (req.body.address !== undefined) data.address = req.body.address || null;
  if (req.body.businessHours !== undefined) data.businessHours = req.body.businessHours || null;
  if (req.body.weeklyOff !== undefined) data.weeklyOff = req.body.weeklyOff || null;
  if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
  if (req.body.latitude !== undefined) data.latitude = req.body.latitude != null ? Number(req.body.latitude) : null;
  if (req.body.longitude !== undefined) data.longitude = req.body.longitude != null ? Number(req.body.longitude) : null;
  if (req.body.geofenceRadiusMeters !== undefined) data.geofenceRadiusMeters = Number(req.body.geofenceRadiusMeters) || 200;
  try {
    res.json(await prisma.branch.update({ where: { id: req.params.id }, data }));
  } catch (err) {
    if (err?.code === "P2002") {
      return res.status(409).json({ message: `A branch named "${req.body.name}" already exists in this salon.` });
    }
    throw err;
  }
}));

superAdminRouter.delete("/branches/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.branch.findUnique({
    where: { id: req.params.id },
    include: {
      _count: { select: { users: true, services: true, invoices: true, appointments: true, products: true } }
    }
  });
  if (!existing) return res.status(404).json({ message: "Branch not found" });
  const counts = existing._count;
  const deps = [];
  if (counts.users > 0) deps.push(`${counts.users} staff`);
  if (counts.services > 0) deps.push(`${counts.services} services`);
  if (counts.invoices > 0) deps.push(`${counts.invoices} invoices`);
  if (counts.appointments > 0) deps.push(`${counts.appointments} appointments`);
  if (counts.products > 0) deps.push(`${counts.products} products`);
  if (deps.length > 0) {
    return res.status(400).json({ message: `Cannot delete branch "${existing.name}" — it has ${deps.join(", ")}. Archive or reassign them first.` });
  }
  await prisma.branch.delete({ where: { id: req.params.id } });
  res.json({ message: "Deleted" });
}));

const AVAILABLE_PAGES = [
  { key: "dashboard", label: "Dashboard", group: "Platform Command" },
  { key: "salons", label: "Salons Control", group: "Platform Command" },
  { key: "branches", label: "Branch Management", group: "Platform Command" },
  { key: "plans", label: "Plans Catalog", group: "Platform Command" },
  { key: "subscriptions", label: "Customer Management", group: "Platform Command" },
  { key: "staff", label: "Staff Management", group: "Platform Command" },
  { key: "demo-leads", label: "Demo Pipeline", group: "Operations" },
  { key: "support-tickets", label: "Support Queue", group: "Operations" },
  { key: "traffic", label: "Traffic Analytics", group: "Operations" },
  { key: "staff-requirements", label: "Staff Requirements", group: "Operations" },
  { key: "product-requirements", label: "Product Requirements", group: "Operations" },
  { key: "settings", label: "Global Settings", group: "System" },
  { key: "audit-logs", label: "Platform Logs", group: "System" }
];

superAdminRouter.get("/available-pages", asyncHandler(async (req, res) => {
  res.json(AVAILABLE_PAGES);
}));

superAdminRouter.get("/staff", asyncHandler(async (req, res) => {
  const users = await prisma.user.findMany({
    where: { systemRole: "SUPER_ADMIN" },
    select: { id: true, name: true, email: true, isActive: true, createdAt: true, pagePermissions: true },
    orderBy: { createdAt: "desc" }
  });
  res.json(users);
}));

superAdminRouter.post("/staff", asyncHandler(async (req, res) => {
  const { name, email, password, pagePermissions } = req.body;
  if (!name || !email || !password) return res.status(400).json({ message: "Name, email, and password are required." });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return res.status(409).json({ message: "A user with this email already exists." });

  const user = await prisma.user.create({
    data: {
      name,
      email,
      passwordHash: await bcrypt.hash(password, 10),
      systemRole: "SUPER_ADMIN",
      pagePermissions: pagePermissions || []
    },
    select: { id: true, name: true, email: true, isActive: true, createdAt: true, pagePermissions: true }
  });
  res.status(201).json(user);
}));

superAdminRouter.patch("/staff/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Staff not found" });

  const data = {};
  if (req.body.name !== undefined) data.name = req.body.name;
  if (req.body.pagePermissions !== undefined) data.pagePermissions = req.body.pagePermissions;
  if (req.body.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
  if (req.body.password && req.body.password.trim()) {
    data.passwordHash = await bcrypt.hash(req.body.password, 10);
  }

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data,
    select: { id: true, name: true, email: true, isActive: true, createdAt: true, pagePermissions: true }
  });
  res.json(updated);
}));

superAdminRouter.delete("/staff/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Staff not found" });
  if (existing.systemRole !== "SUPER_ADMIN") return res.status(400).json({ message: "Cannot delete non-super-admin users from here." });
  await prisma.user.delete({ where: { id: req.params.id } });
  res.json({ message: "Deleted" });
}));
