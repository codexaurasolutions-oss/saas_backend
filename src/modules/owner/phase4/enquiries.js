import { prisma } from "../../../lib/prisma.js";
import { attemptCustomerTemplateEmail } from "../../../lib/emailNotifications.js";
import { createAuditLog, createStaffNotification } from "../../../lib/phase4.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const toDate = (value) => (value ? new Date(value) : null);

export const registerEnquiryRoutes = (ownerRouter) => {
  ownerRouter.get("/enquiries", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    const allAccess = (req.user.permissions?.enquiries || []).includes("view");
    const where = {
      salonId: req.salonId,
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(!allAccess && req.user.membershipId ? { assignedToMembershipId: req.user.membershipId } : {})
    };
    res.json(await prisma.enquiry.findMany({
      where,
      include: { interestedService: true, interestedBranch: true, assignedToMembership: { include: { user: true } }, followUps: { orderBy: { createdAt: "desc" } } },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.post("/enquiries", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "create"), validate(schemas.enquiry), async (req, res) => {
    const row = await prisma.enquiry.create({
      data: {
        salonId: req.salonId,
        name: req.body.name,
        phone: req.body.phone,
        email: req.body.email || null,
        source: req.body.source,
        interestedServiceId: req.body.interestedServiceId || null,
        interestedBranchId: req.body.interestedBranchId || null,
        budget: req.body.budget ?? null,
        priority: req.body.priority || "MEDIUM",
        assignedToMembershipId: req.body.assignedToMembershipId || null,
        createdByMembershipId: req.user.membershipId || null,
        followUpAt: toDate(req.body.followUpAt),
        notes: req.body.notes || null
      }
    });
    if (row.followUpAt) {
      await createStaffNotification({
        salonId: req.salonId,
        userSalonId: row.assignedToMembershipId || null,
        title: "Enquiry follow-up scheduled",
        message: `${row.name} requires follow-up.`,
        type: "ENQUIRY_FOLLOW_UP",
        linkUrl: `/admin/enquiries/${row.id}`
      });
    }
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ENQUIRIES",
      action: "ENQUIRY_CREATED",
      entityType: "Enquiry",
      entityId: row.id,
      summary: `Enquiry created for ${row.name}`
    });
    res.status(201).json(row);
  });

  ownerRouter.get("/enquiries/follow-ups", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    res.json(await prisma.enquiryFollowUp.findMany({
      where: { enquiry: { salonId: req.salonId } },
      include: { enquiry: true, actorMembership: { include: { user: true } } },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.get("/enquiries/reports", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    const rows = await prisma.enquiry.findMany({ where: { salonId: req.salonId }, include: { interestedBranch: true, interestedService: true } });
    const statusBreakdown = rows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});
    const sourceBreakdown = rows.reduce((acc, row) => {
      acc[row.source] = (acc[row.source] || 0) + 1;
      return acc;
    }, {});
    res.json({
      total: rows.length,
      converted: rows.filter((row) => row.status === "CONVERTED").length,
      statusBreakdown,
      sourceBreakdown,
      rows
    });
  });

  ownerRouter.get("/enquiries/:id", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "view"), async (req, res) => {
    const row = await prisma.enquiry.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { interestedService: true, interestedBranch: true, assignedToMembership: { include: { user: true } }, convertedCustomer: true, convertedAppointment: true, followUps: { orderBy: { createdAt: "desc" } } }
    });
    if (!row) return res.status(404).json({ message: "Enquiry not found" });
    res.json(row);
  });

  ownerRouter.patch("/enquiries/:id", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), validate(schemas.enquiry), async (req, res) => {
    const row = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Enquiry not found" });
    const updated = await prisma.enquiry.update({
      where: { id: row.id },
      data: {
        name: req.body.name,
        phone: req.body.phone,
        email: req.body.email || null,
        source: req.body.source,
        interestedServiceId: req.body.interestedServiceId || null,
        interestedBranchId: req.body.interestedBranchId || null,
        budget: req.body.budget ?? null,
        priority: req.body.priority || "MEDIUM",
        assignedToMembershipId: req.body.assignedToMembershipId || null,
        followUpAt: toDate(req.body.followUpAt),
        notes: req.body.notes || null
      }
    });
    res.json(updated);
  });

  ownerRouter.patch("/enquiries/:id/status", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), validate(schemas.enquiryStatus), async (req, res) => {
    const row = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Enquiry not found" });
    const updated = await prisma.enquiry.update({ where: { id: row.id }, data: { status: req.body.status } });
    await prisma.enquiryFollowUp.create({
      data: {
        enquiryId: row.id,
        actorMembershipId: req.user.membershipId || null,
        note: req.body.note || `Status changed to ${req.body.status}`,
        status: req.body.status,
        completedAt: new Date()
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ENQUIRIES",
      action: "STATUS_UPDATED",
      entityType: "Enquiry",
      entityId: updated.id,
      summary: `Enquiry moved to ${updated.status}`
    });
    res.json(updated);
  });

  ownerRouter.post("/enquiries/:id/follow-up", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), validate(schemas.enquiryFollowUp), async (req, res) => {
    const enquiry = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });
    const row = await prisma.enquiryFollowUp.create({
      data: {
        enquiryId: enquiry.id,
        actorMembershipId: req.user.membershipId || null,
        note: req.body.note,
        status: req.body.status || null,
        dueAt: toDate(req.body.dueAt)
      }
    });
    if (req.body.dueAt) {
      await prisma.enquiry.update({ where: { id: enquiry.id }, data: { followUpAt: new Date(req.body.dueAt) } });
    }
    await attemptCustomerTemplateEmail({
      salonId: req.salonId,
      toEmail: enquiry.email || "",
      templateType: "enquiry_follow_up",
      context: {
        customer_name: enquiry.name,
        salon_name: "Skillify ERP"
      }
    });
    res.status(201).json(row);
  });

  ownerRouter.post("/enquiries/:id/convert-to-customer", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), async (req, res) => {
    const enquiry = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });
    const customer = await prisma.customer.create({
      data: {
        salonId: req.salonId,
        name: enquiry.name,
        phone: enquiry.phone,
        email: enquiry.email || null,
        source: `ENQUIRY:${enquiry.source}`,
        notes: enquiry.notes || null
      }
    });
    await prisma.enquiry.update({
      where: { id: enquiry.id },
      data: { convertedCustomerId: customer.id, status: "CONVERTED" }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ENQUIRIES",
      action: "CONVERTED_TO_CUSTOMER",
      entityType: "Enquiry",
      entityId: enquiry.id,
      summary: `${enquiry.name} converted to customer`
    });
    res.status(201).json(customer);
  });

  ownerRouter.post("/enquiries/:id/convert-to-appointment", requireFeatureEnabled("enquiries"), requireSalonPermission("enquiries", "edit"), async (req, res) => {
    const enquiry = await prisma.enquiry.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!enquiry) return res.status(404).json({ message: "Enquiry not found" });
    if (!req.body.customerId || !req.body.branchId || !req.body.startAt || !req.body.endAt) {
      return res.status(400).json({ message: "customerId, branchId, startAt and endAt are required" });
    }
    const appointment = await prisma.appointment.create({
      data: {
        salonId: req.salonId,
        customerId: req.body.customerId,
        branchId: req.body.branchId,
        primaryStaffUserId: req.body.primaryStaffUserId || null,
        createdByMembershipId: req.user.membershipId || null,
        title: enquiry.name,
        bookingChannel: "MANUAL",
        startAt: new Date(req.body.startAt),
        endAt: new Date(req.body.endAt),
        notes: enquiry.notes || null
      }
    });
    await prisma.enquiry.update({
      where: { id: enquiry.id },
      data: { convertedAppointmentId: appointment.id, status: "CONVERTED" }
    });
    res.status(201).json(appointment);
  });

};
