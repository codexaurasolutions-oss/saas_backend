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
import { sendMail } from "../../lib/mailer.js";

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
  payroll: false,
  incentives: false,
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
superAdminRouter.get("/plans", asyncHandler(async (req, res) => {
  const plans = await prisma.plan.findMany({ orderBy: { createdAt: "desc" } });
  return res.json(plans.slice(0, 1));
}));
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

superAdminRouter.post("/demo-leads/:id/contacted", asyncHandler(async (req, res) => {
  const lead = await prisma.demoLead.findUnique({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ message: "Demo lead not found" });
  const updated = await prisma.demoLead.update({
    where: { id: req.params.id },
    data: { status: "CONTACTED" }
  });
  return res.json(updated);
}));

superAdminRouter.post("/demo-leads/:id/schedule-meeting", asyncHandler(async (req, res) => {
  const { meetingScheduledAt, meetingLink } = req.body;
  if (!meetingScheduledAt || !meetingLink) {
    return res.status(400).json({ message: "meetingScheduledAt and meetingLink are required" });
  }
  const lead = await prisma.demoLead.findUnique({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ message: "Demo lead not found" });

  const updated = await prisma.demoLead.update({
    where: { id: req.params.id },
    data: {
      status: "MEETING_SCHEDULED",
      meetingScheduledAt: new Date(meetingScheduledAt),
      meetingLink
    }
  });

  const formattedDate = new Date(meetingScheduledAt).toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short"
  });

  try {
    await sendMail({
      to: lead.email,
      subject: "Meeting Scheduled: ReSpark Product Demo Walkthrough",
      text: `Hi ${lead.name},\n\nWe have scheduled a meeting to demonstrate the ReSpark software with you.\n\nDate & Time: ${formattedDate}\nMeeting Link: ${meetingLink}\n\nWe look forward to meeting you!\n\nBest regards,\nReSpark Team`,
      html: `
        <div style="font-family:Arial,sans-serif;padding:32px;background:#f7f4ef;color:#18212c;">
          <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid rgba(24,33,44,0.08);">
            <p style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#c2410c;margin:0 0 12px;">ReSpark Walkthrough</p>
            <h2 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#0f766e;">ReSpark Product Demo Meeting</h2>
            <p style="font-size:16px;line-height:1.7;">Hi <strong>${lead.name}</strong>,</p>
            <p style="font-size:16px;line-height:1.7;">We have scheduled a meeting for your ReSpark product demo walkthrough.</p>
            <div style="background:#fff7ed;padding:18px 20px;border-radius:18px;margin:20px 0;border-left:4px solid #c2410c;">
              <p style="margin:0 0 8px;font-size:15px;"><strong>Date & Time:</strong> ${formattedDate}</p>
              <p style="margin:0;font-size:15px;"><strong>Meeting Link:</strong> <a href="${meetingLink}" style="color:#0f766e;font-weight:bold;text-decoration:underline;">Join Meeting</a></p>
            </div>
            <p style="font-size:16px;line-height:1.7;">We look forward to showing you how ReSpark can optimize your salon operations!</p>
            <p style="margin-top:24px;font-size:14px;color:#516170;">Best regards,<br/><strong>ReSpark Team</strong></p>
          </div>
        </div>
      `
    });
  } catch (err) {
    console.error("Email send failed for demo meeting schedule:", err);
  }

  return res.json(updated);
}));

superAdminRouter.post("/demo-leads/:id/send-purchase-link", asyncHandler(async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ message: "planId is required" });
  const lead = await prisma.demoLead.findUnique({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ message: "Demo lead not found" });

  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) return res.status(404).json({ message: "Plan not found" });

  const updated = await prisma.demoLead.update({
    where: { id: req.params.id },
    data: { selectedPlanId: planId }
  });

  const frontendUrl = process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173";
  const checkoutUrl = `${frontendUrl}/demo-checkout/${lead.id}/${planId}`;

  try {
    await sendMail({
      to: lead.email,
      subject: `Select your ReSpark Subscription Plan: ${plan.name}`,
      text: `Hi ${lead.name},\n\nThank you for attending the ReSpark product walkthrough. Please use the secure link below to purchase your subscription for the ${plan.name} plan:\n\n${checkoutUrl}\n\nBest regards,\nReSpark Team`,
      html: `
        <div style="font-family:Arial,sans-serif;padding:32px;background:#f7f4ef;color:#18212c;">
          <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid rgba(24,33,44,0.08);">
            <p style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#0f766e;margin:0 0 12px;">ReSpark Subscription Setup</p>
            <h2 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#c2410c;">Complete your ReSpark Subscription</h2>
            <p style="font-size:16px;line-height:1.7;">Hi <strong>${lead.name}</strong>,</p>
            <p style="font-size:16px;line-height:1.7;">Thank you for attending the product demo. We hope you are excited to scale your salon with ReSpark!</p>
            <p style="font-size:16px;line-height:1.7;">Please use the secure link below to review your selected <strong>${plan.name}</strong> plan and complete your checkout:</p>
            <p style="margin:28px 0;"><a href="${checkoutUrl}" style="display:inline-block;background:linear-gradient(135deg,#c2410c,#0f766e);color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:999px;font-weight:bold;">Proceed to Subscription Checkout</a></p>
            <p style="font-size:13px;color:#516170;">If the button doesn't work, copy and paste this link in your browser:<br/><a href="${checkoutUrl}" style="color:#0f766e;">${checkoutUrl}</a></p>
            <p style="margin-top:24px;font-size:14px;color:#516170;">Best regards,<br/><strong>ReSpark Team</strong></p>
          </div>
        </div>
      `
    });
  } catch (err) {
    console.error("Email send failed for demo purchase link:", err);
  }

  return res.json(updated);
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
  res.json(settings || { maintenanceMode: false, invoicePrefix: "INV", systemName: "ReSpark Clone SaaS" });
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
    privacyUrl,
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
    privacyUrl: privacyUrl || null,
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
