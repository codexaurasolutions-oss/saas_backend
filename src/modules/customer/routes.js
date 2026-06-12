import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { attemptCustomerTemplateEmail } from "../../lib/emailNotifications.js";
import { createOnlineOrder } from "../../lib/phase3.js";
import { checkStaffAvailability, ensureScopedStaffMembership } from "../../lib/phase2.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { signAccessToken, signRefreshToken } from "../../lib/tokens.js";
import { requireCustomerAuth } from "../../middlewares/rbac.js";
import { schemas, validate } from "../../middlewares/validate.js";
import { buildCatalogLink } from "../../lib/phase3.js";

export const customerRouter = Router();

const getCustomerPortalContext = async (salonId) => {
  const [salon, catalogSetting] = await Promise.all([
    prisma.salon.findUnique({
      where: { id: salonId },
      select: { id: true, name: true, slug: true }
    }),
    prisma.catalogSetting.findFirst({
      where: { salonId, branchId: null },
      select: { customSlug: true }
    })
  ]);

  if (!salon) return null;
  const storefrontSlug = catalogSetting?.customSlug || salon.slug;
  return {
    salonId: salon.id,
    salonName: salon.name,
    salonSlug: salon.slug,
    storefrontSlug,
    catalogLink: buildCatalogLink(storefrontSlug)
  };
};

const ensureCustomerPortalEnabledBySalonId = async (salonId) => {
  const [salon, subscription] = await Promise.all([
    prisma.salon.findUnique({ where: { id: salonId }, select: { featureFlags: true } }),
    prisma.subscription.findFirst({
      where: { salonId, status: { in: ["ACTIVE", "TRIAL"] } },
      include: { plan: true },
      orderBy: { endsAt: "desc" }
    })
  ]);
  const mergedFeatureFlags = {
    ...(subscription?.plan?.featureFlags || {}),
    ...(salon?.featureFlags || {})
  };
  if (mergedFeatureFlags.customerPortal === false) {
    const error = new Error("Customer portal is disabled for this salon");
    error.status = 403;
    throw error;
  }
  return mergedFeatureFlags;
};

const requireCustomerPortalEnabled = async (req, res, next) => {
  try {
    await ensureCustomerPortalEnabledBySalonId(req.user.salonId);
    next();
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message || "Customer portal unavailable" });
  }
};

const includeOrder = {
  items: { include: { product: true } },
  logs: { orderBy: { createdAt: "asc" } },
  branch: true,
  invoice: true
};

customerRouter.post("/register", validate(schemas.customerRegister), asyncHandler(async (req, res) => {
  const salon = await prisma.salon.findUnique({ where: { slug: req.body.salonSlug } });
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  await ensureCustomerPortalEnabledBySalonId(salon.id);
  const email = req.body.email || `${req.body.phone.replace(/[^\d]/g, "")}@customer.local`;
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) return res.status(400).json({ message: "Customer account already exists for this email/phone" });

  const existingCustomer = await prisma.customer.findFirst({
    where: {
      salonId: salon.id,
      OR: [{ phone: req.body.phone }, ...(req.body.email ? [{ email: req.body.email }] : [])]
    }
  });

  const passwordHash = await bcrypt.hash(req.body.password, 10);
  const user = await prisma.user.create({
    data: {
      name: req.body.name,
      email,
      passwordHash,
      systemRole: "CUSTOMER"
    }
  });

  const customer = existingCustomer
    ? await prisma.customer.update({
        where: { id: existingCustomer.id },
        data: { userId: user.id, name: req.body.name, email: req.body.email || existingCustomer.email || null, phone: req.body.phone }
      })
    : await prisma.customer.create({
        data: {
          salonId: salon.id,
          userId: user.id,
          name: req.body.name,
          phone: req.body.phone,
          email: req.body.email || null,
          source: "CUSTOMER_PORTAL"
        }
      });

  res.status(201).json({ id: customer.id, email: user.email });
}));

customerRouter.post("/login", validate(schemas.customerLogin), asyncHandler(async (req, res) => {
  const salon = await prisma.salon.findUnique({ where: { slug: req.body.salonSlug } });
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  await ensureCustomerPortalEnabledBySalonId(salon.id);

  const customer = await prisma.customer.findFirst({
    where: {
      salonId: salon.id,
      user: {
        email: req.body.emailOrPhone
      }
    },
    include: { user: true }
  }) || await prisma.customer.findFirst({
    where: { salonId: salon.id, phone: req.body.emailOrPhone },
    include: { user: true }
  });

  if (!customer?.user || customer.user.systemRole !== "CUSTOMER") return res.status(401).json({ message: "Invalid credentials" });
  const ok = await bcrypt.compare(req.body.password, customer.user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  const accessToken = signAccessToken({ userId: customer.user.id, salonId: salon.id });
  const refreshToken = signRefreshToken({ userId: customer.user.id, salonId: salon.id });
  const portalContext = await getCustomerPortalContext(salon.id);
  res.json({
    accessToken,
    refreshToken,
    user: { id: customer.user.id, name: customer.user.name, systemRole: "CUSTOMER" },
    customer: { id: customer.id, ...portalContext }
  });
}));

customerRouter.post("/logout", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  res.json({ ok: true });
}));

customerRouter.get("/profile", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  const [customer, portalContext] = await Promise.all([
    prisma.customer.findFirst({ where: { id: req.user.customerId, salonId: req.user.salonId } }),
    getCustomerPortalContext(req.user.salonId)
  ]);
  res.json({ ...(customer || {}), portalContext });
}));
customerRouter.patch("/profile", requireCustomerAuth, requireCustomerPortalEnabled, validate(schemas.customerProfile), asyncHandler(async (req, res) => {
  res.json(await prisma.customer.update({
    where: { id: req.user.customerId },
    data: {
      name: req.body.name,
      phone: req.body.phone,
      email: req.body.email || null,
      preferences: req.body.preferences || null,
      allergies: req.body.allergies || null,
      skinNotes: req.body.skinNotes || null
    }
  }));
}));

customerRouter.get("/appointments", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  res.json(await prisma.appointment.findMany({
    where: { salonId: req.user.salonId, customerId: req.user.customerId },
    include: { branch: true, items: { include: { service: true, assignedStaff: { include: { userSalon: { include: { user: true } } } } } } },
    orderBy: { startAt: "desc" }
  }));
}));
customerRouter.get("/appointments/:id", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  const row = await prisma.appointment.findFirst({
    where: { id: req.params.id, salonId: req.user.salonId, customerId: req.user.customerId },
    include: { branch: true, items: { include: { service: true, assignedStaff: { include: { userSalon: { include: { user: true } } } } } }, logs: true }
  });
  if (!row) return res.status(404).json({ message: "Appointment not found" });
  res.json(row);
}));
customerRouter.patch("/appointments/:id/reschedule", requireCustomerAuth, requireCustomerPortalEnabled, validate(schemas.customerReschedule), asyncHandler(async (req, res) => {
  const row = await prisma.appointment.findFirst({
    where: { id: req.params.id, salonId: req.user.salonId, customerId: req.user.customerId },
    include: {
      items: {
        include: {
          assignedStaff: true
        }
      }
    }
  });
  if (!row) return res.status(404).json({ message: "Appointment not found" });
  const setting = await prisma.salonSetting.findFirst({ where: { salonId: req.user.salonId, branchId: row.branchId } }) || await prisma.salonSetting.findFirst({ where: { salonId: req.user.salonId, branchId: null } });
  if (setting?.cancellationPolicy && String(setting.cancellationPolicy).toLowerCase().includes("no reschedule")) {
    return res.status(400).json({ message: "Salon booking rules do not allow customer reschedule." });
  }

  for (const item of row.items) {
    const staffMembershipIds = item.assignedStaff.map((assignment) => assignment.userSalonId);
    for (const staffMembershipId of staffMembershipIds) {
      await ensureScopedStaffMembership(req.user.salonId, staffMembershipId);
    }
    if (staffMembershipIds.length) {
      await checkStaffAvailability({
        salonId: req.user.salonId,
        branchId: row.branchId,
        staffMembershipIds,
        startAt: req.body.startAt,
        endAt: req.body.endAt,
        appointmentIdToExclude: row.id
      });
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.appointmentService.updateMany({
      where: { appointmentId: row.id },
      data: { startAt: new Date(req.body.startAt), endAt: new Date(req.body.endAt) }
    });
    const nextAppointment = await tx.appointment.update({
      where: { id: row.id },
      data: { startAt: new Date(req.body.startAt), endAt: new Date(req.body.endAt), notes: req.body.note || row.notes }
    });
    await tx.appointmentLog.create({ data: { appointmentId: row.id, action: "CUSTOMER_RESCHEDULED", details: req.body.note || "Rescheduled from customer portal" } });
    return nextAppointment;
  });
  res.json(updated);
}));
customerRouter.patch("/appointments/:id/cancel", requireCustomerAuth, requireCustomerPortalEnabled, validate(schemas.customerCancel), asyncHandler(async (req, res) => {
  const row = await prisma.appointment.findFirst({ where: { id: req.params.id, salonId: req.user.salonId, customerId: req.user.customerId } });
  if (!row) return res.status(404).json({ message: "Appointment not found" });
  const updated = await prisma.appointment.update({ where: { id: row.id }, data: { status: "CANCELLED", notes: req.body.note || row.notes } });
  await prisma.appointmentLog.create({ data: { appointmentId: row.id, action: "CUSTOMER_CANCELLED", details: req.body.note || "Cancelled from customer portal", fromStatus: row.status, toStatus: "CANCELLED" } });
  res.json(updated);
}));

customerRouter.get("/invoices", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  res.json(await prisma.invoice.findMany({ where: { salonId: req.user.salonId, customerId: req.user.customerId }, include: { branch: true, payments: true, items: true }, orderBy: { createdAt: "desc" } }));
}));
customerRouter.get("/invoices/:id", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  const row = await prisma.invoice.findFirst({ where: { id: req.params.id, salonId: req.user.salonId, customerId: req.user.customerId }, include: { branch: true, payments: true, items: true } });
  if (!row) return res.status(404).json({ message: "Invoice not found" });
  res.json(row);
}));

customerRouter.get("/packages", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  res.json(await prisma.customerPackage.findMany({ where: { salonId: req.user.salonId, customerId: req.user.customerId }, include: { package: true, usageLogs: true }, orderBy: { createdAt: "desc" } }));
}));
customerRouter.get("/memberships", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  res.json(await prisma.customerMembership.findMany({ where: { salonId: req.user.salonId, customerId: req.user.customerId }, include: { membershipPlan: true, usageLogs: true }, orderBy: { createdAt: "desc" } }));
}));
customerRouter.get("/loyalty", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  const [row, transactions, rule] = await Promise.all([
    prisma.customer.findUnique({ where: { id: req.user.customerId } }),
    prisma.loyaltyTransaction.findMany({
      where: { salonId: req.user.salonId, customerId: req.user.customerId },
      include: { invoice: true, order: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.loyaltyRule.findFirst({
      where: { salonId: req.user.salonId, isActive: true },
      orderBy: { updatedAt: "desc" }
    })
  ]);
  res.json({
    loyaltyPoints: row?.loyaltyPoints || 0,
    totalSpend: row?.totalSpend || 0,
    averageSpend: row?.averageSpend || 0,
    activeRule: rule,
    history: transactions
  });
}));

customerRouter.get("/orders", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  res.json(await prisma.onlineOrder.findMany({ where: { salonId: req.user.salonId, customerId: req.user.customerId }, include: includeOrder, orderBy: { createdAt: "desc" } }));
}));
customerRouter.get("/orders/:id", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  const row = await prisma.onlineOrder.findFirst({ where: { id: req.params.id, salonId: req.user.salonId, customerId: req.user.customerId }, include: includeOrder });
  if (!row) return res.status(404).json({ message: "Order not found" });
  res.json(row);
}));
customerRouter.post("/orders", requireCustomerAuth, requireCustomerPortalEnabled, validate(schemas.createOrder), asyncHandler(async (req, res) => {
  const order = await createOnlineOrder({
    salonId: req.user.salonId,
    body: { ...req.body, customerId: req.user.customerId },
    source: "CUSTOMER_PORTAL"
  });
  await attemptCustomerTemplateEmail({
    salonId: req.user.salonId,
    toEmail: order.customer?.email || req.body.customerEmail || "",
    templateType: "order_confirmation",
    context: { orderId: order.id, customerId: order.customerId }
  });
  res.status(201).json(order);
}));

customerRouter.get("/coupons", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  const [assignedCoupons, activeCoupons, giftCards] = await Promise.all([
    prisma.customerCoupon.findMany({
      where: { salonId: req.user.salonId, customerId: req.user.customerId, isActive: true },
      orderBy: { createdAt: "desc" }
    }),
    prisma.coupon.findMany({
      where: {
        salonId: req.user.salonId,
        isArchived: false,
        OR: [{ customerUsageLimit: null }, { customerUsageLimit: { gt: 0 } }]
      },
      orderBy: { createdAt: "desc" },
      take: 20
    }),
    prisma.giftCard.findMany({
      where: { salonId: req.user.salonId, issuedToCustomerId: req.user.customerId, isActive: true },
      orderBy: { createdAt: "desc" }
    })
  ]);
  res.json({ assignedCoupons, activeCoupons, giftCards });
}));
customerRouter.get("/notifications", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  res.json(await prisma.customerNotification.findMany({ where: { salonId: req.user.salonId, customerId: req.user.customerId }, orderBy: { createdAt: "desc" } }));
}));
customerRouter.patch("/notifications/:id/read", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  const row = await prisma.customerNotification.findFirst({
    where: {
      id: req.params.id,
      salonId: req.user.salonId,
      customerId: req.user.customerId
    }
  });
  if (!row) return res.status(404).json({ message: "Notification not found" });
  res.json(await prisma.customerNotification.update({
    where: { id: row.id },
    data: { isRead: true }
  }));
}));
customerRouter.patch("/notifications/read-all", requireCustomerAuth, requireCustomerPortalEnabled, asyncHandler(async (req, res) => {
  await prisma.customerNotification.updateMany({
    where: {
      salonId: req.user.salonId,
      customerId: req.user.customerId
    },
    data: { isRead: true }
  });
  res.json({ ok: true });
}));

customerRouter.post("/feedback", requireCustomerAuth, requireCustomerPortalEnabled, validate(schemas.customerFeedback), asyncHandler(async (req, res) => {
  let appointment = null;
  if (req.body.appointmentId) {
    appointment = await prisma.appointment.findFirst({
      where: {
        id: req.body.appointmentId,
        salonId: req.user.salonId,
        customerId: req.user.customerId,
        status: "COMPLETED"
      }
    });
    if (!appointment) {
      return res.status(404).json({ message: "Completed appointment not found for feedback" });
    }
  }

  const feedback = await prisma.customerFeedback.create({
    data: {
      salonId: req.user.salonId,
      customerId: req.user.customerId,
      appointmentId: appointment?.id || null,
      rating: req.body.rating,
      message: req.body.message || null
    }
  });

  if (appointment) {
    await prisma.customerNotification.create({
      data: {
        salonId: req.user.salonId,
        customerId: req.user.customerId,
        title: "Feedback received",
        message: "Thanks for sharing your appointment feedback.",
        linkUrl: `/customer/appointments/${appointment.id}`
      }
    });
  }

  res.status(201).json(feedback);
}));
