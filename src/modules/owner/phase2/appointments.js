import crypto from "crypto";
import { prisma } from "../../../lib/prisma.js";
import { attemptCustomerTemplateEmail } from "../../../lib/emailNotifications.js";
import { checkStaffAvailability, ensureScopedBranch, ensureScopedCustomer, ensureScopedService, ensureScopedStaffMembership, getSalonSetting, logCustomerTimeline, normalizeBranchId, toAmount } from "../../../lib/phase2.js";
import { attachSalonSettings, requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";
import { assignAppointmentItems, buildAppointmentScope, canAccessAppointment, fetchAppointment, logAppointmentChange, nextNumber } from "./shared.js";

const sendRouteError = (res, error, fallbackMessage) => {
  const status = error?.status || error?.response?.status || 500;
  const message = error?.message || fallbackMessage;
  return res.status(status).json({ message });
};

const notifyAppointmentEmail = async (salonId, appointment, templateType, extraVariables = {}) => {
  await attemptCustomerTemplateEmail({
    salonId,
    toEmail: appointment?.customer?.email || "",
    templateType,
    context: { appointmentId: appointment?.id, customerId: appointment?.customerId },
    extraVariables
  });
};

export const registerAppointmentRoutes = (ownerRouter) => {
  ownerRouter.get("/appointments", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const status = req.query.status ? String(req.query.status) : null;
    const bookingChannel = req.query.bookingChannel ? String(req.query.bookingChannel) : null;
    const customerId = req.query.customerId ? String(req.query.customerId) : null;
    const from = req.query.from ? new Date(String(req.query.from)) : null;
    const to = req.query.to ? new Date(String(req.query.to)) : null;
    const rangeWhere = (from || to)
      ? {
          AND: [
            ...(to ? [{ startAt: { lte: to } }] : []),
            ...(from ? [{ endAt: { gte: from } }] : [])
          ]
        }
      : {};
    res.json(await prisma.appointment.findMany({
      where: {
        ...buildAppointmentScope(req, branchId),
        ...(status ? { status } : {}),
        ...(bookingChannel ? { bookingChannel } : {}),
        ...(customerId ? { customerId } : {}),
        ...rangeWhere
      },
      include: {
        customer: true,
        branch: true,
        primaryStaff: { include: { user: true } },
        items: { include: { service: true, assignedStaff: { include: { userSalon: { include: { user: true } } } } } }
      },
      orderBy: { startAt: "asc" }
    }));
  });

  ownerRouter.get("/appointments/calendar", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const from = req.query.from ? new Date(String(req.query.from)) : new Date();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
    res.json(await prisma.appointment.findMany({
      where: {
        ...buildAppointmentScope(req, branchId),
        AND: [
          { startAt: { lte: to } },
          { endAt: { gte: from } }
        ]
      },
      include: {
        customer: true,
        primaryStaff: { include: { user: true } },
        items: { include: { service: true, assignedStaff: { include: { userSalon: { include: { user: true } } } } } }
      },
      orderBy: { startAt: "asc" }
    }));
  });

  ownerRouter.get("/appointments/:id", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "view"), async (req, res) => {
    const appointment = await fetchAppointment(req.salonId, req.params.id);
    if (!appointment) return res.status(404).json({ message: "Appointment not found" });
    if (!canAccessAppointment(req, appointment)) return res.status(403).json({ message: "You can only view your assigned appointments" });
    res.json(appointment);
  });

  ownerRouter.post("/appointments", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "create"), attachSalonSettings, validate(schemas.appointment), async (req, res) => {
    try {
      const body = req.body;
      await ensureScopedCustomer(req.salonId, body.customerId);
      await ensureScopedBranch(req.salonId, body.branchId);

      for (const item of body.items) {
        if (!req.advancedSettings?.allowBackdatedAppointments) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          if (new Date(item.startAt) < today) {
            return res.status(400).json({ message: "Backdated appointments are restricted by salon settings" });
          }
        }
        const service = await ensureScopedService(req.salonId, item.serviceId);
        if (service.branchId && service.branchId !== body.branchId) {
          return res.status(400).json({ message: `${service.name} does not belong to the selected branch` });
        }
        for (const staffUserId of item.staffUserIds) {
          const membership = await ensureScopedStaffMembership(req.salonId, staffUserId);
          const assignedServiceIds = membership.serviceAssignments.map((assignment) => assignment.serviceId);
          if (assignedServiceIds.length && !assignedServiceIds.includes(item.serviceId)) {
            return res.status(400).json({ message: `${membership.user.name} is not assigned to ${service.name}` });
          }
        }
        await checkStaffAvailability({
          salonId: req.salonId,
          branchId: body.branchId,
          staffMembershipIds: item.staffUserIds,
          startAt: item.startAt,
          endAt: item.endAt
        });
      }

      const settings = await prisma.appointmentSetting.findFirst({ where: { salonId: req.salonId, branchId: body.branchId } })
        || await prisma.appointmentSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });

      const createdId = await prisma.$transaction(async (tx) => {
        const appointment = await tx.appointment.create({
          data: {
            salonId: req.salonId,
            branchId: body.branchId,
            customerId: body.customerId,
            primaryStaffUserId: body.primaryStaffUserId || body.items[0]?.staffUserIds?.[0] || null,
            createdByMembershipId: req.user.membershipId || null,
            title: body.title || null,
            bookingChannel: body.bookingChannel,
            status: body.status || (settings?.autoConfirm !== false ? "CONFIRMED" : "PENDING"),
            startAt: new Date(body.startAt),
            endAt: new Date(body.endAt),
            notes: body.notes || null,
            customerPreferences: body.customerPreferences || null,
            isWalkIn: Boolean(body.isWalkIn),
            approvalStatus: settings?.autoConfirm === false ? "PENDING" : "APPROVED",
            advancePaymentRequired: body.advancePaymentRequired ?? settings?.advancePaymentRequired ?? false,
            advancePaidAmount: body.advancePaidAmount || 0,
            selfCancelToken: crypto.randomBytes(18).toString("hex"),
            selfRescheduleToken: crypto.randomBytes(18).toString("hex"),
            roomResourceNote: body.roomResourceNote || null
          }
        });
        await assignAppointmentItems(tx, appointment.id, body.items);
        await logAppointmentChange(tx, appointment.id, req.user.id, "CREATED", null, appointment.status, "Appointment created");
        await logCustomerTimeline(tx, body.customerId, "APPOINTMENT", "Appointment booked", `Booking on ${new Date(body.startAt).toLocaleString()}`, appointment.id);
        return appointment.id;
      });

      const createdAppointment = await fetchAppointment(req.salonId, createdId);
      await notifyAppointmentEmail(req.salonId, createdAppointment, "appointment_confirmation", {
        appointment_status: createdAppointment?.status || "CONFIRMED"
      });
      res.status(201).json(createdAppointment);
    } catch (error) {
      return sendRouteError(res, error, "Could not create appointment");
    }
  });

  ownerRouter.patch("/appointments/:id", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "edit"), attachSalonSettings, validate(schemas.appointment), async (req, res) => {
    try {
      const existing = await fetchAppointment(req.salonId, req.params.id);
      if (!existing) return res.status(404).json({ message: "Appointment not found" });
      if (!canAccessAppointment(req, existing)) return res.status(403).json({ message: "You can only edit your assigned appointments" });

      await ensureScopedCustomer(req.salonId, req.body.customerId);
      await ensureScopedBranch(req.salonId, req.body.branchId);

      for (const item of req.body.items) {
        if (!req.advancedSettings?.allowBackdatedAppointments) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          if (new Date(item.startAt) < today) {
            return res.status(400).json({ message: "Backdated appointments are restricted by salon settings" });
          }
        }
        const service = await ensureScopedService(req.salonId, item.serviceId);
        if (service.branchId && service.branchId !== req.body.branchId) {
          return res.status(400).json({ message: `${service.name} does not belong to the selected branch` });
        }
        for (const staffUserId of item.staffUserIds) {
          const membership = await ensureScopedStaffMembership(req.salonId, staffUserId);
          const assignedServiceIds = membership.serviceAssignments.map((assignment) => assignment.serviceId);
          if (assignedServiceIds.length && !assignedServiceIds.includes(item.serviceId)) {
            return res.status(400).json({ message: `${membership.user.name} is not assigned to ${service.name}` });
          }
        }
        await checkStaffAvailability({
          salonId: req.salonId,
          branchId: req.body.branchId,
          staffMembershipIds: item.staffUserIds,
          startAt: item.startAt,
          endAt: item.endAt,
          appointmentIdToExclude: existing.id
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: { id: existing.id },
          data: {
            branchId: req.body.branchId,
            customerId: req.body.customerId,
            primaryStaffUserId: req.body.primaryStaffUserId || req.body.items[0]?.staffUserIds?.[0] || null,
            title: req.body.title || null,
            bookingChannel: req.body.bookingChannel,
            status: req.body.status || existing.status,
            startAt: new Date(req.body.startAt),
            endAt: new Date(req.body.endAt),
            notes: req.body.notes || null,
            customerPreferences: req.body.customerPreferences || null,
            isWalkIn: Boolean(req.body.isWalkIn),
            advancePaymentRequired: Boolean(req.body.advancePaymentRequired),
            advancePaidAmount: req.body.advancePaidAmount || 0,
            roomResourceNote: req.body.roomResourceNote || null
          }
        });
        await assignAppointmentItems(tx, existing.id, req.body.items);
        await logAppointmentChange(tx, existing.id, req.user.id, "UPDATED", existing.status, req.body.status || existing.status, "Appointment updated");
      });

      const updatedAppointment = await fetchAppointment(req.salonId, existing.id);
      await notifyAppointmentEmail(req.salonId, updatedAppointment, "appointment_update", {
        appointment_status: updatedAppointment?.status || req.body.status || existing.status
      });
      res.json(updatedAppointment);
    } catch (error) {
      return sendRouteError(res, error, "Could not update appointment");
    }
  });

  ownerRouter.patch("/appointments/:id/status", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "edit"), validate(schemas.appointmentStatus), async (req, res) => {
    const appointment = await prisma.appointment.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!appointment) return res.status(404).json({ message: "Appointment not found" });
    const fullAppointment = await fetchAppointment(req.salonId, appointment.id);
    if (!canAccessAppointment(req, fullAppointment)) return res.status(403).json({ message: "You can only update your assigned appointments" });
    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({ where: { id: appointment.id }, data: { status: req.body.status } });
      await logAppointmentChange(tx, appointment.id, req.user.id, "STATUS_CHANGED", appointment.status, req.body.status, req.body.note || null);
    });
    const updatedAppointment = await fetchAppointment(req.salonId, appointment.id);
    await notifyAppointmentEmail(req.salonId, updatedAppointment, "appointment_update", {
      appointment_status: req.body.status
    });
    res.json(updatedAppointment);
  });

  ownerRouter.post("/appointments/:id/cancel", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "edit"), validate(schemas.appointmentNote), async (req, res) => {
    const appointment = await fetchAppointment(req.salonId, req.params.id);
    if (!appointment) return res.status(404).json({ message: "Appointment not found" });
    if (!canAccessAppointment(req, appointment)) return res.status(403).json({ message: "You can only cancel your assigned appointments" });
    if (appointment.status === "CANCELLED") return res.status(400).json({ message: "Appointment already cancelled" });

    await prisma.$transaction(async (tx) => {
      await tx.appointment.update({ where: { id: appointment.id }, data: { status: "CANCELLED" } });
      await logAppointmentChange(tx, appointment.id, req.user.id, "CANCELLED", appointment.status, "CANCELLED", req.body.note || "Appointment cancelled");
    });

    const cancelledAppointment = await fetchAppointment(req.salonId, appointment.id);
    await notifyAppointmentEmail(req.salonId, cancelledAppointment, "appointment_update", {
      appointment_status: "CANCELLED"
    });
    res.json(cancelledAppointment);
  });

  ownerRouter.post("/appointments/:id/reschedule", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "edit"), attachSalonSettings, validate(schemas.appointmentReschedule), async (req, res) => {
    try {
      const appointment = await fetchAppointment(req.salonId, req.params.id);
      if (!appointment) return res.status(404).json({ message: "Appointment not found" });
      if (!canAccessAppointment(req, appointment)) return res.status(403).json({ message: "You can only reschedule your assigned appointments" });

      const items = appointment.items.map((item) => ({
        serviceId: item.serviceId,
        staffUserIds: item.assignedStaff.map((assignment) => assignment.userSalonId),
        startAt: req.body.startAt,
        endAt: req.body.endAt,
        notes: item.notes || ""
      }));

      for (const item of items) {
        if (!req.advancedSettings?.allowBackdatedAppointments) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          if (new Date(item.startAt) < today) {
            return res.status(400).json({ message: "Backdated appointments are restricted by salon settings" });
          }
        }
        const service = await ensureScopedService(req.salonId, item.serviceId);
        for (const staffUserId of item.staffUserIds) {
          const membership = await ensureScopedStaffMembership(req.salonId, staffUserId);
          const assignedServiceIds = membership.serviceAssignments.map((assignment) => assignment.serviceId);
          if (assignedServiceIds.length && !assignedServiceIds.includes(item.serviceId)) {
            return res.status(400).json({ message: `${membership.user.name} is not assigned to ${service.name}` });
          }
        }
        await checkStaffAvailability({
          salonId: req.salonId,
          branchId: req.body.branchId || appointment.branchId,
          staffMembershipIds: item.staffUserIds,
          startAt: item.startAt,
          endAt: item.endAt,
          appointmentIdToExclude: appointment.id
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            branchId: req.body.branchId || appointment.branchId,
            startAt: new Date(req.body.startAt),
            endAt: new Date(req.body.endAt),
            status: appointment.status === "CANCELLED" ? "CONFIRMED" : appointment.status
          }
        });
        await tx.appointmentService.updateMany({
          where: { appointmentId: appointment.id },
          data: {
            startAt: new Date(req.body.startAt),
            endAt: new Date(req.body.endAt)
          }
        });
        await logAppointmentChange(tx, appointment.id, req.user.id, "RESCHEDULED", appointment.status, appointment.status, req.body.note || "Appointment rescheduled");
      });

      const rescheduledAppointment = await fetchAppointment(req.salonId, appointment.id);
      await notifyAppointmentEmail(req.salonId, rescheduledAppointment, "appointment_update", {
        appointment_status: rescheduledAppointment?.status || "CONFIRMED"
      });
      res.json(rescheduledAppointment);
    } catch (error) {
      return sendRouteError(res, error, "Could not reschedule appointment");
    }
  });

  ownerRouter.get("/appointments/:id/self-links", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "view"), async (req, res) => {
    const appointment = await prisma.appointment.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!appointment) return res.status(404).json({ message: "Appointment not found" });
    const frontendBase = process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173";
    res.json({
      cancelUrl: `${frontendBase}/self/appointments/${appointment.selfCancelToken}/cancel`,
      rescheduleUrl: `${frontendBase}/self/appointments/${appointment.selfRescheduleToken}/reschedule`,
      approvalStatus: appointment.approvalStatus || "APPROVED"
    });
  });

  ownerRouter.post("/appointments/:id/convert-to-invoice", requireFeatureEnabled("appointments"), requireSalonPermission("pos", "create"), async (req, res) => {
    const appointment = await prisma.appointment.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { items: { include: { service: true, assignedStaff: { include: { userSalon: { include: { user: true } } } } } } }
    });
    if (!appointment) return res.status(404).json({ message: "Appointment not found" });
    if (appointment.status !== "COMPLETED") return res.status(400).json({ message: "Only completed appointments can convert to invoice" });

    const invoice = await prisma.$transaction(async (tx) => {
      const settings = await getSalonSetting(tx, req.salonId, appointment.branchId);
      const invoiceNumber = await nextNumber(tx, "invoice", req.salonId, settings?.invoicePrefix || "INV");
      const items = appointment.items.map((item) => {
        const unitPrice = toAmount(item.service.price);
        const taxPct = toAmount(item.service.taxRate || 0);
        const lineTotal = unitPrice + (unitPrice * taxPct) / 100;
        const firstStaff = item.assignedStaff[0]?.userSalonId || null;
        return {
          serviceId: item.serviceId,
          staffUserSalonId: firstStaff,
          serviceName: item.service.name,
          staffName: item.assignedStaff.map((assignment) => assignment.userSalon.user.name).join(", "),
          qty: 1,
          unitPrice,
          taxPct,
          lineTotal
        };
      });
      const subtotal = items.reduce((sum, item) => sum + toAmount(item.unitPrice) * item.qty, 0);
      const tax = items.reduce((sum, item) => sum + (toAmount(item.unitPrice) * item.qty * toAmount(item.taxPct)) / 100, 0);
      const total = subtotal + tax;

      const created = await tx.invoice.create({
        data: {
          salonId: req.salonId,
          branchId: appointment.branchId,
          customerId: appointment.customerId,
          appointmentId: appointment.id,
          invoiceNumber,
          subtotal,
          discount: 0,
          tax,
          total,
          paidAmount: 0,
          balanceAmount: total,
          status: "UNPAID",
          items: { create: items }
        }
      });

      await tx.appointment.update({ where: { id: appointment.id }, data: { convertedInvoiceId: created.id } });
      await logCustomerTimeline(tx, appointment.customerId, "INVOICE", "Appointment converted to invoice", created.invoiceNumber, created.id);
      return created;
    });

    await attemptCustomerTemplateEmail({
      salonId: req.salonId,
      toEmail: appointment?.customer?.email || "",
      templateType: "invoice_template",
      context: { invoiceId: invoice.id, customerId: appointment.customerId },
      extraVariables: {
        appointment_status: appointment.status
      }
    });
    res.status(201).json(invoice);
  });

  ownerRouter.get("/appointment-settings", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    res.json(await getSalonSetting(prisma, req.salonId, branchId));
  });

  ownerRouter.post("/appointment-settings", requireFeatureEnabled("appointments"), requireSalonPermission("appointments", "edit"), validate(schemas.appointmentSettings), async (req, res) => {
    const branchId = req.body.branchId || null;
    const existing = await prisma.appointmentSetting.findFirst({ where: { salonId: req.salonId, branchId } });
    const payload = {
      salonId: req.salonId,
      branchId,
      autoConfirm: req.body.autoConfirm ?? true,
      advancePaymentRequired: req.body.advancePaymentRequired ?? false,
      onlineBookingEnabled: req.body.onlineBookingEnabled ?? false
    };
    res.status(201).json(existing
      ? await prisma.appointmentSetting.update({ where: { id: existing.id }, data: payload })
      : await prisma.appointmentSetting.create({ data: payload }));
  });

  ownerRouter.get("/staff-schedule", requireSalonPermission("staffSchedule", "view"), async (req, res) => {
    res.json(await prisma.staffSchedule.findMany({
      where: { userSalon: { salonId: req.salonId } },
      include: { userSalon: { include: { user: true, branch: true } } },
      orderBy: [{ userSalonId: "asc" }, { weekday: "asc" }]
    }));
  });

  ownerRouter.post("/staff-schedule", requireSalonPermission("staffSchedule", "edit"), validate(schemas.staffSchedule), async (req, res) => {
    const membership = await ensureScopedStaffMembership(req.salonId, req.body.userSalonId);
    res.status(201).json(await prisma.staffSchedule.upsert({
      where: { userSalonId_weekday: { userSalonId: membership.id, weekday: req.body.weekday } },
      update: { branchId: req.body.branchId || null, startTime: req.body.startTime, endTime: req.body.endTime, isOffDay: Boolean(req.body.isOffDay) },
      create: { salonId: req.salonId, branchId: req.body.branchId || null, userSalonId: membership.id, weekday: req.body.weekday, startTime: req.body.startTime, endTime: req.body.endTime, isOffDay: Boolean(req.body.isOffDay) }
    }));
  });

  ownerRouter.post("/staff-breaks", requireSalonPermission("staffSchedule", "edit"), validate(schemas.staffBreak), async (req, res) => {
    const membership = await ensureScopedStaffMembership(req.salonId, req.body.userSalonId);
    res.status(201).json(await prisma.staffBreak.create({
      data: {
        userSalonId: membership.id,
        weekday: req.body.weekday,
        startTime: req.body.startTime,
        endTime: req.body.endTime
      }
    }));
  });

  ownerRouter.get("/staff-availability", requireSalonPermission("staffSchedule", "view"), async (req, res) => {
    const branchId = normalizeBranchId(req.query.branchId);
    const serviceId = req.query.serviceId ? String(req.query.serviceId) : null;
    const startAt = req.query.startAt ? new Date(String(req.query.startAt)) : null;
    const endAt = req.query.endAt ? new Date(String(req.query.endAt)) : null;
    const memberships = await prisma.userSalon.findMany({
      where: {
        salonId: req.salonId,
        isArchived: false,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
        ...(serviceId ? { serviceAssignments: { some: { serviceId } } } : {})
      },
      include: { user: true, serviceAssignments: true, staffSchedules: true, staffBreaks: true }
    });

    const results = [];
    for (const membership of memberships) {
      let available = true;
      let reason = null;
      if (startAt && endAt) {
        try {
          await checkStaffAvailability({
            salonId: req.salonId,
            branchId,
            staffMembershipIds: [membership.id],
            startAt,
            endAt
          });
        } catch (error) {
          available = false;
          reason = error.message;
        }
      }
      results.push({ id: membership.id, name: membership.user.name, salonRole: membership.salonRole, available, reason });
    }
    res.json(results);
  });
};
