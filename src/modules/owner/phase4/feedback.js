import { prisma } from "../../../lib/prisma.js";
import { attemptCustomerTemplateEmail } from "../../../lib/emailNotifications.js";
import { createAuditLog, createStaffNotification } from "../../../lib/phase4.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

export const registerFeedbackRoutes = (ownerRouter) => {
  ownerRouter.get("/feedback", requireFeatureEnabled("feedback"), requireSalonPermission("feedback", "view"), async (req, res) => {
    const where = {
      salonId: req.salonId,
      ...(req.query.status ? { status: String(req.query.status) } : {}),
      ...(req.query.staffUserSalonId ? { staffUserSalonId: String(req.query.staffUserSalonId) } : {}),
      ...(req.query.branchId ? { branchId: String(req.query.branchId) } : {})
    };
    res.json(await prisma.customerFeedback.findMany({
      where,
      include: { customer: true, appointment: true, invoice: true, branch: true, service: true, staffUserSalon: { include: { user: true } } },
      orderBy: { createdAt: "desc" }
    }));
  });

  ownerRouter.get("/feedback/reports", requireFeatureEnabled("feedback"), requireSalonPermission("feedback", "view"), async (req, res) => {
    const rows = await prisma.customerFeedback.findMany({
      where: { salonId: req.salonId },
      include: { branch: true, service: true, staffUserSalon: { include: { user: true } } }
    });
    const averageRating = rows.length ? rows.reduce((sum, row) => sum + row.rating, 0) / rows.length : 0;
    res.json({
      summary: {
        total: rows.length,
        averageRating,
        negativeCount: rows.filter((row) => row.rating <= 2).length
      },
      rows
    });
  });

  ownerRouter.get("/feedback/settings", requireFeatureEnabled("feedback"), requireSalonPermission("feedback", "view"), async (req, res) => {
    const setting = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
    res.json({
      whatsappNumber: setting?.whatsappNumber || "",
      bookingNotes: setting?.bookingNotes || "",
      cancellationPolicy: setting?.cancellationPolicy || ""
    });
  });

  ownerRouter.get("/feedback/:id", requireFeatureEnabled("feedback"), requireSalonPermission("feedback", "view"), async (req, res) => {
    const row = await prisma.customerFeedback.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { customer: true, appointment: true, invoice: true, branch: true, service: true, staffUserSalon: { include: { user: true } } }
    });
    if (!row) return res.status(404).json({ message: "Feedback not found" });
    res.json(row);
  });

  ownerRouter.post("/feedback", requireFeatureEnabled("feedback"), requireSalonPermission("feedback", "create"), async (req, res) => {
    const row = await prisma.customerFeedback.create({
      data: {
        salonId: req.salonId,
        customerId: req.body.customerId,
        appointmentId: req.body.appointmentId || null,
        invoiceId: req.body.invoiceId || null,
        branchId: req.body.branchId || null,
        serviceId: req.body.serviceId || null,
        staffUserSalonId: req.body.staffUserSalonId || null,
        rating: req.body.rating,
        message: req.body.message || null,
        status: req.body.status || "NEW",
        complaintFollowUpStatus: req.body.complaintFollowUpStatus || null,
        internalNotes: req.body.internalNotes || null,
        requestSource: req.body.requestSource || "OWNER_PANEL"
      }
    });
    if (row.rating <= 2) {
      await createStaffNotification({
        salonId: req.salonId,
        title: "Negative feedback received",
        message: "A customer submitted low-rated feedback that needs attention.",
        type: "FEEDBACK_ALERT",
        linkUrl: `/admin/feedback/${row.id}`
      });
    }
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "FEEDBACK",
      action: "FEEDBACK_CREATED",
      entityType: "CustomerFeedback",
      entityId: row.id,
      summary: "Feedback entry created"
    });
    res.status(201).json(row);
  });

  ownerRouter.patch("/feedback/:id/status", requireFeatureEnabled("feedback"), requireSalonPermission("feedback", "edit"), validate(schemas.feedbackStatus), async (req, res) => {
    const row = await prisma.customerFeedback.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Feedback not found" });
    const updated = await prisma.customerFeedback.update({
      where: { id: row.id },
      data: {
        status: req.body.status,
        internalNotes: req.body.internalNotes ?? row.internalNotes,
        complaintFollowUpStatus: req.body.complaintFollowUpStatus ?? row.complaintFollowUpStatus
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "FEEDBACK",
      action: "STATUS_UPDATED",
      entityType: "CustomerFeedback",
      entityId: updated.id,
      summary: `Feedback moved to ${updated.status}`
    });
    res.json(updated);
  });

  ownerRouter.post("/feedback/:id/follow-up", requireFeatureEnabled("feedback"), requireSalonPermission("feedback", "edit"), validate(schemas.feedbackFollowUp), async (req, res) => {
    const row = await prisma.customerFeedback.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { customer: true }
    });
    if (!row) return res.status(404).json({ message: "Feedback not found" });
    const updated = await prisma.customerFeedback.update({
      where: { id: row.id },
      data: {
        internalNotes: [row.internalNotes, req.body.note].filter(Boolean).join("\n")
      }
    });
    await attemptCustomerTemplateEmail({
      salonId: req.salonId,
      toEmail: row.customer?.email || "",
      templateType: "feedback_follow_up",
      context: {
        customerId: row.customerId,
        customer_name: row.customer?.name || "Customer"
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "FEEDBACK",
      action: "FOLLOW_UP_ADDED",
      entityType: "CustomerFeedback",
      entityId: updated.id,
      summary: "Feedback follow-up note added"
    });
    res.json(updated);
  });
};
