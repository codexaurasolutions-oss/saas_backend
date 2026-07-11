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

  if (ownerEmail && (!ownerName || !ownerPassword)) {
    return res.status(400).json({ message: "Owner name, email, and password are all required to create an owner account." });
  }

  try {
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
  } catch (err) {
    if (err?.code === "P2002") {
      const field = err?.meta?.target?.[0] || "field";
      return res.status(409).json({ message: `A salon with this ${field} already exists. Please choose a different ${field}.` });
    }
    throw err;
  }
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
    isPopular,
    featureFlags
  } = req.body;

  try {
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
        isCustom: Boolean(isCustom),
        isPopular: Boolean(isPopular)
      }
    });
    res.status(201).json(plan);
  } catch (err) {
    if (err?.code === "P2002") {
      return res.status(409).json({ message: `A plan named "${name}" already exists. Please choose a different name.` });
    }
    throw err;
  }
}));
superAdminRouter.get("/plans", asyncHandler(async (req, res) => {
  const plans = await prisma.plan.findMany({ orderBy: { createdAt: "desc" } });
  return res.json(plans);
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
    isPopular,
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
      isCustom: Boolean(isCustom),
      isPopular: Boolean(isPopular)
    }
  }));
}));

superAdminRouter.delete("/plans/:id", asyncHandler(async (req, res) => {
  const plan = await prisma.plan.findUnique({ where: { id: req.params.id }, include: { subscriptions: { where: { status: { in: ["ACTIVE", "TRIAL"] } } } } });
  if (!plan) return res.status(404).json({ message: "Plan not found" });
  if (plan.subscriptions.length > 0) return res.status(400).json({ message: `Cannot delete "${plan.name}" — ${plan.subscriptions.length} active subscription(s) use this plan. Reassign them first.` });
  await prisma.plan.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
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

superAdminRouter.delete("/subscriptions/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.subscription.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ message: "Subscription not found" });

  await prisma.$transaction([
    prisma.subscriptionHistory.deleteMany({ where: { subscriptionId: req.params.id } }),
    prisma.subscription.delete({ where: { id: req.params.id } })
  ]);
  res.json({ success: true, message: "Subscription deleted successfully." });
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
  if (lead.status === "CONVERTED") {
    return res.status(400).json({ message: "Converted demo leads cannot be canceled directly." });
  }
  const updated = await prisma.demoLead.update({
    where: { id: req.params.id },
    data: {
      status: "CANCELED",
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
    data: { status: "CONNECTED" }
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
      status: "IN_PROGRESS",
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

superAdminRouter.patch("/demo-leads/:id/status", asyncHandler(async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["NEW", "CONNECTED", "IN_PROGRESS", "CONVERTED", "CANCELED"];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ message: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
  }
  const lead = await prisma.demoLead.findUnique({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ message: "Demo lead not found" });

  const updated = await prisma.demoLead.update({
    where: { id: req.params.id },
    data: {
      status,
      ...(status === "CONVERTED" ? { reviewedAt: new Date(), reviewedByName: req.user.name } : {}),
      ...(status === "CANCELED" ? { reviewedAt: new Date(), reviewedByName: req.user.name } : {})
    }
  });
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

  const allowedFields = ["status", "priority", "internalNote", "assignedAgentName", "category"];
  const safeData = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) safeData[key] = req.body[key];
  }

  if (Object.keys(safeData).length === 0) {
    return res.status(400).json({ message: "No valid fields to update" });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.supportTicket.update({ where: { id: req.params.id }, data: safeData });
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
  const ticket = await prisma.supportTicket.findUnique({ where: { id: req.params.id }, include: { salon: true } });
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

  if (ticket.salon?.email && req.body.message) {
    const frontendUrl = process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173";
    const salonEmail = ticket.salon.email;
    const ticketTitle = ticket.title;
    const replyMessage = req.body.message;
    const agentName = req.user.name;
    const newStatus = req.body.status || "PENDING";
    try {
      await sendMail({
        to: salonEmail,
        subject: `ReSpark Support: New reply on "${ticketTitle}"`,
        text: `Hi,\n\nSupport has replied to your ticket "${ticketTitle}".\n\nStatus: ${newStatus}\nAgent: ${agentName}\n\nMessage:\n${replyMessage}\n\nView your ticket: ${frontendUrl}/admin/support-tickets\n\nBest regards,\nReSpark Support Team`,
        html: `
          <div style="font-family:Arial,sans-serif;padding:32px;background:#f7f4ef;color:#18212c;">
            <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:24px;padding:32px;border:1px solid rgba(24,33,44,0.08);">
              <p style="font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#0f766e;margin:0 0 12px;">ReSpark Support</p>
              <h2 style="margin:0 0 14px;font-size:24px;line-height:1.25;color:#0f172a;">New Reply on Your Ticket</h2>
              <p style="font-size:16px;line-height:1.7;">Hi,</p>
              <p style="font-size:16px;line-height:1.7;">Support has replied to your ticket <strong>"${ticketTitle}"</strong>.</p>
              <div style="background:#f0fdfa;padding:18px 20px;border-radius:18px;margin:20px 0;border-left:4px solid #0f766e;">
                <p style="margin:0 0 8px;font-size:15px;"><strong>Status:</strong> ${newStatus}</p>
                <p style="margin:0 0 8px;font-size:15px;"><strong>Agent:</strong> ${agentName}</p>
              </div>
              <div style="background:#f8fafc;padding:18px 20px;border-radius:12px;margin:20px 0;border:1px solid #e2e8f0;">
                <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#64748b;">MESSAGE</p>
                <p style="margin:0;font-size:15px;line-height:1.7;white-space:pre-wrap;">${replyMessage}</p>
              </div>
              <p style="margin:28px 0;"><a href="${frontendUrl}/admin/support-tickets" style="display:inline-block;background:linear-gradient(135deg,#0f766e,#14b8a6);color:#ffffff;text-decoration:none;padding:14px 24px;border-radius:999px;font-weight:bold;">View Ticket</a></p>
              <p style="font-size:13px;color:#516170;margin-top:24px;">Best regards,<br/><strong>ReSpark Support Team</strong></p>
            </div>
          </div>
        `
      });
    } catch (err) {
      console.error("Support reply email failed:", err);
    }
  }

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

superAdminRouter.post("/migrate-demo-lead-statuses", asyncHandler(async (req, res) => {
  if (req.query.key !== "respark-pipeline-migration-2026") {
    return res.status(403).json({ message: "Invalid migration key" });
  }
  const oldStatusMap = {
    PENDING: "NEW",
    CONTACTED: "CONNECTED",
    MEETING_SCHEDULED: "IN_PROGRESS",
    APPROVED: "CONVERTED",
    REJECTED: "CANCELED"
  };
  let migrated = 0;
  for (const [oldStatus, newStatus] of Object.entries(oldStatusMap)) {
    const result = await prisma.demoLead.updateMany({
      where: { status: oldStatus },
      data: { status: newStatus }
    });
    migrated += result.count;
  }
  res.json({ message: `Migration complete. ${migrated} leads updated.`, oldStatusMap });
}));

superAdminRouter.get("/traffic-analytics", asyncHandler(async (req, res) => {
  const period = req.query.period || "7d";
  const salonFilter = req.query.salonId || "";
  const now = new Date();
  let since = new Date();
  if (period === "today") since.setHours(0, 0, 0, 0);
  else if (period === "7d") since.setDate(now.getDate() - 7);
  else if (period === "30d") since.setDate(now.getDate() - 30);
  else if (period === "90d") since.setDate(now.getDate() - 90);
  else since.setDate(now.getDate() - 7);

  const whereBase = { createdAt: { gte: since } };
  const where = salonFilter ? { ...whereBase, salonId: salonFilter } : whereBase;

  const [totalVisits, uniqueIps, visitsBySalon, visitsByDay, visitsByPath, topReferrers] = await Promise.all([
    prisma.websiteVisit.count({ where }),
    prisma.websiteVisit.findMany({ where, select: { ip: true }, distinct: ["ip"] }).then((r) => r.length),
    prisma.websiteVisit.groupBy({ by: ["salonId"], where, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 20 }),
    prisma.websiteVisit.groupBy({ by: ["createdAt"], where, _count: { id: true }, orderBy: { createdAt: "asc" } }).then((rows) => {
      const dayMap = {};
      for (const row of rows) {
        const day = new Date(row.createdAt).toISOString().slice(0, 10);
        dayMap[day] = (dayMap[day] || 0) + row._count.id;
      }
      return Object.entries(dayMap).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date));
    }),
    prisma.websiteVisit.groupBy({ by: ["path"], where, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 10 }),
    prisma.websiteVisit.groupBy({ by: ["referrer"], where: { ...where, referrer: { not: null } }, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 10 })
  ]);

  const salonIds = visitsBySalon.map((v) => v.salonId);
  const salons = salonIds.length ? await prisma.salon.findMany({ where: { id: { in: salonIds } }, select: { id: true, name: true, slug: true } }) : [];
  const salonMap = Object.fromEntries(salons.map((s) => [s.id, s]));

  const topPages = visitsBySalon.map((v) => ({
    salon: salonMap[v.salonId] || { name: "Unknown", slug: "-" },
    visits: v._count.id
  }));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayCount = await prisma.websiteVisit.count({ where: { createdAt: { gte: todayStart }, ...(salonFilter ? { salonId: salonFilter } : {}) } });

  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const yesterdayCount = await prisma.websiteVisit.count({ where: { createdAt: { gte: yesterdayStart, lt: todayStart }, ...(salonFilter ? { salonId: salonFilter } : {}) } });

  res.json({
    summary: {
      totalVisits,
      uniqueVisitors: uniqueIps,
      todayVisits: todayCount,
      yesterdayVisits: yesterdayCount,
      period
    },
    topPages,
    visitsByDay,
    topPaths: visitsByPath.map((v) => ({ path: v.path, count: v._count.id })),
    topReferrers: topReferrers.map((v) => ({ referrer: v.referrer, count: v._count.id }))
  });
}));

superAdminRouter.get("/global-search", asyncHandler(async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 2) return res.json({ results: [] });

  const term = { contains: q, mode: "insensitive" };
  const safe = (promise) => promise.catch(() => []);

  const [salons, demoLeads, plans, users, subscriptions] = await Promise.all([
    safe(prisma.salon.findMany({
      where: { OR: [{ name: term }, { slug: term }, { email: term }, { phone: term }] },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, slug: true, email: true, phone: true }
    })),
    safe(prisma.demoLead.findMany({
      where: { OR: [{ name: term }, { email: term }, { phone: term }, { company: term }] },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, email: true, phone: true, company: true, status: true }
    })),
    safe(prisma.plan.findMany({
      where: { name: term },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, monthlyPrice: true, yearlyPrice: true }
    })),
    safe(prisma.user.findMany({
      where: { OR: [{ name: term }, { email: term }] },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, email: true, systemRole: true }
    })),
    safe(prisma.subscription.findMany({
      where: { OR: [{ salon: { name: term } }, { salon: { slug: term } }] },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { salon: { select: { name: true, slug: true } }, plan: { select: { name: true } } }
    }))
  ]);

  const results = [];
  salons.forEach(s => results.push({ id: s.id, title: s.name, subtitle: `Slug: ${s.slug} • Email: ${s.email || "N/A"} • Phone: ${s.phone || "N/A"}`, module: "Salons", icon: "building", to: `/super-admin/salons?q=${encodeURIComponent(s.slug)}` }));
  demoLeads.forEach(l => results.push({ id: l.id, title: l.name, subtitle: `Company: ${l.company || "N/A"} • Email: ${l.email} • Status: ${l.status}`, module: "Demo Leads", icon: "user-check", to: `/super-admin/demo-leads?q=${encodeURIComponent(l.email)}` }));
  plans.forEach(p => results.push({ id: p.id, title: p.name, subtitle: `Monthly: ₹${p.monthlyPrice} • Yearly: ₹${p.yearlyPrice}`, module: "Subscription Plans", icon: "award", to: `/super-admin/plans` }));
  users.forEach(u => results.push({ id: u.id, title: u.name, subtitle: `Email: ${u.email} • Role: ${u.systemRole}`, module: "Platform Users", icon: "user", to: `/super-admin/salons` }));
  subscriptions.forEach(sub => results.push({ id: sub.id, title: `Subscription: ${sub.salon?.name || "Salon"}`, subtitle: `Plan: ${sub.plan?.name || "N/A"} • Status: ${sub.status} • Payment: ${sub.paymentStatus || "PENDING"}`, module: "Subscription Contracts", icon: "file-text", to: `/super-admin/subscriptions?q=${encodeURIComponent(sub.salon?.slug || "")}` }));

  results.sort((a, b) => a.title.toLowerCase().indexOf(q.toLowerCase()) - b.title.toLowerCase().indexOf(q.toLowerCase()));
  res.json({ results: results.slice(0, 20) });
}));

// ─────────────────────────────────────────────
// Staff Management (Super Admin Staff accounts)
// ─────────────────────────────────────────────

const AVAILABLE_PAGES = [
  { key: "dashboard", label: "Dashboard", path: "/super-admin/dashboard" },
  { key: "salons", label: "Salons Control", path: "/super-admin/salons" },
  { key: "plans", label: "Plans Catalog", path: "/super-admin/plans" },
  { key: "subscriptions", label: "Customer Management", path: "/super-admin/subscriptions" },
  { key: "demo-leads", label: "Demo Pipeline", path: "/super-admin/demo-leads" },
  { key: "support-tickets", label: "Support Queue", path: "/super-admin/support-tickets" },
  { key: "traffic", label: "Traffic Analytics", path: "/super-admin/traffic" },
  { key: "settings", label: "Global Settings", path: "/super-admin/settings" },
  { key: "audit-logs", label: "Platform Logs", path: "/super-admin/audit-logs" },
  { key: "staff", label: "Staff Management", path: "/super-admin/staff" }
];

superAdminRouter.get("/available-pages", asyncHandler(async (req, res) => {
  res.json(AVAILABLE_PAGES);
}));

superAdminRouter.get("/staff", asyncHandler(async (req, res) => {
  const q = req.query.q ? String(req.query.q).trim() : "";
  const staff = await prisma.user.findMany({
    where: {
      systemRole: "SUPER_ADMIN",
      isDemoAccount: false,
      pagePermissions: { not: null },
      ...(q ? {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } }
        ]
      } : {})
    },
    select: {
      id: true,
      email: true,
      name: true,
      isActive: true,
      pagePermissions: true,
      createdAt: true
    },
    orderBy: { createdAt: "desc" }
  });
  res.json(staff);
}));

superAdminRouter.post("/staff", asyncHandler(async (req, res) => {
  const { name, email, password, pagePermissions } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: "Name, email, and password are required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters." });
  }
  if (!Array.isArray(pagePermissions) || pagePermissions.length === 0) {
    return res.status(400).json({ message: "At least one page permission is required." });
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (existing) {
    return res.status(409).json({ message: "A user with this email already exists." });
  }

  const validKeys = AVAILABLE_PAGES.map(p => p.key);
  const invalidPerms = pagePermissions.filter(p => !validKeys.includes(p));
  if (invalidPerms.length > 0) {
    return res.status(400).json({ message: `Invalid page permissions: ${invalidPerms.join(", ")}` });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const staff = await prisma.user.create({
    data: {
      name: name.trim(),
      email: email.toLowerCase().trim(),
      passwordHash,
      systemRole: "SUPER_ADMIN",
      pagePermissions: pagePermissions,
      isActive: true
    },
    select: {
      id: true,
      email: true,
      name: true,
      isActive: true,
      pagePermissions: true,
      createdAt: true
    }
  });

  await createAuditLog({
    actorUserId: req.user.userId,
    module: "STAFF",
    action: "STAFF_CREATED",
    entityType: "USER",
    entityId: staff.id,
    reference: staff.email,
    summary: `Staff account created: ${staff.name} (${staff.email})`,
    metadata: { pagePermissions }
  });

  res.status(201).json(staff);
}));

superAdminRouter.get("/staff/:id", asyncHandler(async (req, res) => {
  const staff = await prisma.user.findFirst({
    where: { id: req.params.id, systemRole: "SUPER_ADMIN", pagePermissions: { not: null } },
    select: {
      id: true,
      email: true,
      name: true,
      isActive: true,
      pagePermissions: true,
      createdAt: true
    }
  });
  if (!staff) return res.status(404).json({ message: "Staff member not found." });
  res.json(staff);
}));

superAdminRouter.patch("/staff/:id", asyncHandler(async (req, res) => {
  const { name, email, password, pagePermissions, isActive } = req.body;

  const existing = await prisma.user.findFirst({
    where: { id: req.params.id, systemRole: "SUPER_ADMIN", pagePermissions: { not: null } }
  });
  if (!existing) return res.status(404).json({ message: "Staff member not found." });

  if (email && email.toLowerCase().trim() !== existing.email) {
    const dup = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (dup) return res.status(409).json({ message: "A user with this email already exists." });
  }

  if (pagePermissions !== undefined) {
    if (!Array.isArray(pagePermissions) || pagePermissions.length === 0) {
      return res.status(400).json({ message: "At least one page permission is required." });
    }
    const validKeys = AVAILABLE_PAGES.map(p => p.key);
    const invalidPerms = pagePermissions.filter(p => !validKeys.includes(p));
    if (invalidPerms.length > 0) {
      return res.status(400).json({ message: `Invalid page permissions: ${invalidPerms.join(", ")}` });
    }
  }

  const updateData = {};
  if (name) updateData.name = name.trim();
  if (email) updateData.email = email.toLowerCase().trim();
  if (password) {
    if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters." });
    updateData.passwordHash = await bcrypt.hash(password, 10);
  }
  if (pagePermissions !== undefined) updateData.pagePermissions = pagePermissions;
  if (isActive !== undefined) updateData.isActive = isActive;

  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: updateData,
    select: {
      id: true,
      email: true,
      name: true,
      isActive: true,
      pagePermissions: true,
      createdAt: true
    }
  });

  await createAuditLog({
    actorUserId: req.user.userId,
    module: "STAFF",
    action: "STAFF_UPDATED",
    entityType: "USER",
    entityId: updated.id,
    reference: updated.email,
    summary: `Staff account updated: ${updated.name} (${updated.email})`,
    metadata: { updatedFields: Object.keys(updateData) }
  });

  res.json(updated);
}));

superAdminRouter.delete("/staff/:id", asyncHandler(async (req, res) => {
  const existing = await prisma.user.findFirst({
    where: { id: req.params.id, systemRole: "SUPER_ADMIN", pagePermissions: { not: null } }
  });
  if (!existing) return res.status(404).json({ message: "Staff member not found." });

  await prisma.user.delete({ where: { id: req.params.id } });

  await createAuditLog({
    actorUserId: req.user.userId,
    module: "STAFF",
    action: "STAFF_DELETED",
    entityType: "USER",
    entityId: existing.id,
    reference: existing.email,
    summary: `Staff account deleted: ${existing.name} (${existing.email})`
  });

  res.json({ message: "Staff member deleted successfully." });
}));
