import { createOnlineOrder, createPublicAppointment, ensurePublicStoreEnabled, getPublicCatalogData, resolvePublicSalonBySlug, trackCatalogEvent, validateCartAgainstStock } from "../../lib/phase3.js";
import { attemptCustomerTemplateEmail, attemptCustomerTemplateWhatsApp } from "../../lib/emailNotifications.js";
import { sendOrderConfirmationEmail } from "../../lib/orderEmail.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { rateLimit } from "../../lib/rate-limiter.js";
import { schemas, validate } from "../../middlewares/validate.js";
import { prisma } from "../../lib/prisma.js";
import crypto from "crypto";

export const registerPublicPhase3Routes = (publicRouter) => {
  publicRouter.get("/salon/:slug", asyncHandler(async (req, res) => {
    res.json(await getPublicCatalogData(req.params.slug));
  }));
  publicRouter.get("/salon/:slug/services", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, services: data.services });
  }));
  publicRouter.get("/salon/:slug/packages", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, packages: data.packages });
  }));
  publicRouter.get("/salon/:slug/memberships", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, memberships: data.memberships });
  }));
  publicRouter.get("/salon/:slug/products", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, products: data.products });
  }));
  publicRouter.get("/salon/:slug/offers", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, offers: data.offers });
  }));
  publicRouter.post("/salon/:slug/analytics/event", validate(schemas.catalogEvent), asyncHandler(async (req, res) => {
    const event = await trackCatalogEvent({ slug: req.params.slug, body: req.body });
    res.status(201).json({ ok: true, eventId: event?.id || null });
  }));
  publicRouter.post("/salon/:slug/book", validate(schemas.publicBooking), asyncHandler(async (req, res) => {
    const appointment = await createPublicAppointment({ slug: req.params.slug, body: req.body });
    await attemptCustomerTemplateEmail({
      salonId: appointment.salonId,
      toEmail: appointment.customer?.email || "",
      templateType: "appointment_confirmation",
      context: {
        appointmentId: appointment.id,
        customerId: appointment.customerId
      }
    }).catch(() => {});
    await attemptCustomerTemplateWhatsApp({
      salonId: appointment.salonId,
      toPhone: appointment.customer?.phone || "",
      templateType: "appointment_confirmation",
      context: {
        appointmentId: appointment.id,
        customerId: appointment.customerId
      },
      customerId: appointment.customerId
    }).catch(() => {});
    res.status(201).json(appointment);
  }));
  publicRouter.post("/salon/:slug/cart/validate", rateLimit({ windowMs: 60_000, max: 10, message: "Too many requests. Please try again later." }), validate(schemas.cartValidate), asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    await ensurePublicStoreEnabled(salon.id);
    const products = await validateCartAgainstStock(salon.id, req.body.items);
    res.json({ ok: true, products });
  }));
  publicRouter.post("/salon/:slug/orders", rateLimit({ windowMs: 60_000, max: 5, message: "Too many order attempts. Please try again later." }), validate(schemas.createOrder), asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    await ensurePublicStoreEnabled(salon.id);
    const order = await createOnlineOrder({ salonId: salon.id, body: req.body, source: "PUBLIC_STORE" });
    sendOrderConfirmationEmail({ order, salonId: salon.id }).catch(() => {});
    res.status(201).json(order);
  }));

  publicRouter.get("/salon/:slug/storefront-services", asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    const { branchId } = req.query;
    const where = { salonId: salon.id, isActive: true, showOnWebsite: true };
    if (branchId) where.branchId = branchId;
    const services = (await prisma.service.findMany({
      where,
      include: {
        category: true,
        branch: { select: { id: true, name: true } },
        staffAssignments: { include: { userSalon: { include: { user: { select: { id: true, name: true } } } } } }
      },
      orderBy: { position: "asc" }
    })).map(s => ({
      ...s,
      staffAssignments: (s.staffAssignments || []).map(sa => ({
        ...sa,
        user: sa.userSalon?.user || null,
        avatarUrl: sa.userSalon?.avatarUrl || null,
      }))
    }));
    const branches = await prisma.branch.findMany({
      where: { salonId: salon.id, isArchived: false },
      select: { id: true, name: true },
      orderBy: { name: "asc" }
    });
    res.json({ services, branches });
  }));

  publicRouter.get("/salon/:slug/booked-slots", asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    const { branchId, date } = req.query;
    if (!branchId || !date) {
      return res.status(400).json({ message: "branchId and date are required" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: "date must be in YYYY-MM-DD format" });
    }
    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const appointments = await prisma.appointment.findMany({
      where: {
        salonId: salon.id,
        branchId,
        status: { in: ["PENDING", "CONFIRMED", "IN_PROGRESS"] },
        startAt: { gte: dayStart, lt: dayEnd }
      },
      include: {
        items: { include: { service: { select: { id: true, name: true } } } }
      }
    });
    const bookedSlots = appointments.map(a => ({
      startAt: a.startAt,
      endAt: a.endAt,
      services: a.items.map(i => ({ serviceId: i.serviceId, serviceName: i.service?.name || "Service" }))
    }));
    res.json({ bookedSlots });
  }));

  publicRouter.post("/salon/:slug/service-bookings", rateLimit({ windowMs: 60_000, max: 5, message: "Too many booking attempts. Please try again later." }), asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    const { serviceId, customerName, customerPhone, customerEmail, preferredDate, preferredTime, staffId, note } = req.body;

    if (!serviceId || !customerName || !customerPhone || !preferredDate || !preferredTime) {
      return res.status(400).json({ message: "Missing required fields: serviceId, customerName, customerPhone, preferredDate, preferredTime" });
    }
    if (typeof customerName !== "string" || customerName.trim().length < 1 || customerName.length > 200) {
      return res.status(400).json({ message: "customerName must be 1-200 characters" });
    }
    if (typeof customerPhone !== "string" || customerPhone.trim().length < 5 || customerPhone.length > 20) {
      return res.status(400).json({ message: "customerPhone must be 5-20 characters" });
    }
    if (customerEmail && (typeof customerEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))) {
      return res.status(400).json({ message: "Invalid email format" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(preferredDate)) {
      return res.status(400).json({ message: "preferredDate must be in YYYY-MM-DD format" });
    }
    if (!/^\d{2}:\d{2}$/.test(preferredTime)) {
      return res.status(400).json({ message: "preferredTime must be in HH:MM format" });
    }
    if (staffId) {
      const staffExists = await prisma.userSalon.findFirst({ where: { id: staffId, salonId: salon.id, isArchived: false }, select: { id: true } });
      if (!staffExists) return res.status(400).json({ message: "Invalid staff member for this salon" });
    }
    if (note && typeof note === "string" && note.length > 1000) {
      return res.status(400).json({ message: "note must be under 1000 characters" });
    }

    const service = await prisma.service.findFirst({
      where: { id: serviceId, salonId: salon.id, isActive: true, showOnWebsite: true }
    });
    if (!service) return res.status(404).json({ message: "Service not found or not available for booking" });

    const defaultBranch = await prisma.branch.findFirst({ where: { salonId: salon.id, isArchived: false } });
    const branchId = service.branchId || defaultBranch?.id;
    if (!branchId) return res.status(400).json({ message: "No branch available for booking" });

    const branchExists = await prisma.branch.findFirst({ where: { id: branchId, salonId: salon.id, isArchived: false }, select: { id: true } });
    if (!branchExists) return res.status(400).json({ message: "Invalid branch for this salon" });

    const startAt = new Date(`${preferredDate}T${preferredTime}:00Z`);
    const endAt = new Date(startAt.getTime() + (service.durationMin || 30) * 60000);

    if (isNaN(startAt.getTime())) {
      return res.status(400).json({ message: "Invalid date or time format" });
    }

    const orderNumber = `SB-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    const salePrice = Number(service.salePrice);
    const basePrice = Number(service.price);
    const servicePrice = (salePrice > 0 && salePrice < basePrice) ? salePrice : basePrice;

    const result = await prisma.$transaction(async (tx) => {
      if (staffId) {
        const conflict = await tx.$queryRaw`
          SELECT id FROM "Appointment"
          WHERE "salonId" = ${salon.id}
            AND "branchId" = ${branchId}
            AND "primaryStaffUserId" = ${staffId}
            AND "status" IN ('PENDING', 'CONFIRMED', 'IN_PROGRESS')
            AND "startAt" < ${endAt}
            AND "endAt" > ${startAt}
          FOR UPDATE
          LIMIT 1
        `;
        if (conflict.length > 0) {
          throw new Error("STAFF_CONFLICT");
        }
      }

      let customer = await tx.customer.findFirst({ where: { salonId: salon.id, phone: customerPhone } });
      if (!customer) {
        customer = await tx.customer.create({
          data: { salonId: salon.id, name: customerName.trim(), phone: customerPhone.trim(), email: customerEmail || null, source: "ONLINE_BOOKING" }
        });
      } else {
        const updates = {};
        if (customerName.trim() && customer.name !== customerName.trim()) updates.name = customerName.trim();
        if (customerEmail && customer.email !== customerEmail) updates.email = customerEmail;
        if (Object.keys(updates).length > 0) {
          await tx.customer.update({ where: { id: customer.id }, data: updates });
        }
      }

      const order = await tx.onlineOrder.create({
        data: {
          salonId: salon.id,
          customerId: customer.id,
          branchId,
          orderNumber,
          status: "NEW",
          paymentStatus: "PENDING",
          fulfillmentMethod: "APPOINTMENT",
          source: "SERVICE_BOOKING",
          customerName: customerName.trim(),
          customerPhone: customerPhone.trim(),
          customerEmail: customerEmail || null,
          note: JSON.stringify({ serviceId: service.id, serviceName: service.name, preferredDate, preferredTime, staffId: staffId || null, userNote: note || null }),
          subtotal: servicePrice,
          discount: 0,
          tax: 0,
          total: servicePrice,
          logs: {
            create: { fromStatus: null, toStatus: "NEW", actorName: "Customer", note: `Booking created for ${service.name} on ${preferredDate} at ${preferredTime}` }
          }
        },
        include: { logs: true }
      });

      const appointment = await tx.appointment.create({
        data: {
          salonId: salon.id,
          branchId,
          customerId: customer.id,
          primaryStaffUserId: staffId || null,
          bookingChannel: "ONLINE",
          status: "PENDING",
          startAt,
          endAt,
          notes: note || `Online booking: ${service.name}`,
          items: {
            create: {
              serviceId: service.id,
              startAt,
              endAt,
              notes: `Booked via website`
            }
          },
          logs: {
            create: { action: "CREATED", fromStatus: null, toStatus: "PENDING", details: "Online service booking created" }
          }
        },
        include: { items: true }
      });

      return { order, appointment };
    }).catch(err => {
      if (err.message === "STAFF_CONFLICT") return null;
      throw err;
    });

    if (!result) {
      return res.status(409).json({ message: "This time slot is already booked for the selected staff. Please choose a different time." });
    }

    res.status(201).json({
      order: result.order,
      appointment: result.appointment,
      message: "Service booking created successfully"
    });
  }));

  publicRouter.get("/salon/:slug/track-booking", rateLimit({ windowMs: 60_000, max: 10, message: "Too many requests. Please try again later." }), asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    const { bookingNumber, phone } = req.query;
    if (!bookingNumber) return res.status(400).json({ message: "bookingNumber is required" });
    if (!phone) return res.status(400).json({ message: "phone is required for verification" });
    const order = await prisma.onlineOrder.findFirst({
      where: { salonId: salon.id, orderNumber: bookingNumber, customerPhone: phone },
      include: { logs: { orderBy: { createdAt: "asc" } }, customer: { select: { id: true, name: true } } }
    });
    if (!order) return res.status(404).json({ message: "Booking not found" });
    let serviceInfo = null;
    try { serviceInfo = JSON.parse(order.note); } catch {}
    const { note, ...orderWithoutNote } = order;
    res.json({ ...orderWithoutNote, serviceInfo });
  }));

  publicRouter.get("/salon/:slug/my-bookings", asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ message: "phone is required" });
    const orders = await prisma.onlineOrder.findMany({
      where: { salonId: salon.id, customerPhone: phone, source: "SERVICE_BOOKING" },
      include: { logs: { orderBy: { createdAt: "asc" } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    const enriched = orders.map(o => {
      let serviceInfo = null;
      try { serviceInfo = JSON.parse(o.note); } catch {}
      const { note, ...rest } = o;
      return { ...rest, serviceInfo };
    });
    res.json(enriched);
  }));

  publicRouter.patch("/salon/:slug/my-bookings/:orderNumber/cancel", asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ message: "phone is required" });
    const order = await prisma.onlineOrder.findFirst({
      where: { salonId: salon.id, orderNumber: req.params.orderNumber, customerPhone: phone, source: "SERVICE_BOOKING" }
    });
    if (!order) return res.status(404).json({ message: "Booking not found" });
    if (order.status === "CANCELLED") return res.status(400).json({ message: "Booking already cancelled" });
    if (order.status === "COMPLETED") return res.status(400).json({ message: "Cannot cancel completed booking" });

    const cancelled = await prisma.$transaction(async (tx) => {
      const updated = await tx.onlineOrder.update({
        where: { id: order.id },
        data: { status: "CANCELLED", cancelledAt: new Date() }
      });
      let serviceInfo = null;
      try { serviceInfo = JSON.parse(order.note); } catch {}
      if (serviceInfo?.preferredDate && serviceInfo?.preferredTime) {
        const startAt = new Date(`${serviceInfo.preferredDate}T${serviceInfo.preferredTime}:00Z`);
        await tx.appointment.updateMany({
          where: {
            salonId: salon.id,
            customerId: order.customerId,
            branchId: order.branchId,
            startAt,
            status: { in: ["PENDING", "CONFIRMED"] }
          },
          data: { status: "CANCELLED" }
        });
      } else {
        await tx.appointment.updateMany({
          where: { salonId: salon.id, customerId: order.customerId, status: { in: ["PENDING", "CONFIRMED"] } },
          data: { status: "CANCELLED" }
        });
      }
      await tx.onlineOrderStatusLog.create({
        data: { orderId: order.id, actorName: "Customer", fromStatus: order.status, toStatus: "CANCELLED", note: "Cancelled by customer" }
      });
      return updated;
    });

    res.json({ message: "Booking cancelled successfully", order: cancelled });
  }));
};
