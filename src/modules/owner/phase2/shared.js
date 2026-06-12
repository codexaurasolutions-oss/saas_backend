import { prisma } from "../../../lib/prisma.js";

export const buildAppointmentScope = (req, branchId = null) => {
  const ownOnly = req.user.salonRole === "STAFF" && !(req.user.permissions?.appointments || []).includes("manage_all");
  return {
    salonId: req.salonId,
    ...(branchId ? { branchId } : {}),
    ...(ownOnly ? { items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } } } : {})
  };
};

export const canAccessAppointment = (req, appointment) => {
  if (!appointment) return false;
  const ownOnly = req.user.salonRole === "STAFF" && !(req.user.permissions?.appointments || []).includes("manage_all");
  if (!ownOnly) return true;
  return (appointment.items || []).some((item) =>
    (item.assignedStaff || []).some((assignment) => assignment.userSalonId === req.user.membershipId)
  );
};

export const fetchAppointment = (salonId, id) =>
  prisma.appointment.findFirst({
    where: { id, salonId },
    include: {
      customer: true,
      branch: true,
      primaryStaff: { include: { user: true } },
      items: {
        include: {
          service: { include: { category: true, branch: true } },
          assignedStaff: { include: { userSalon: { include: { user: true } } } }
        }
      },
      logs: { orderBy: { createdAt: "asc" } }
    }
  });

export const logAppointmentChange = async (tx, appointmentId, actorUserId, action, fromStatus, toStatus, details) =>
  tx.appointmentLog.create({
    data: { appointmentId, actorUserId, action, fromStatus, toStatus, details: details || null }
  });

export const nextNumber = async (tx, model, salonId, prefix) => {
  const count = await tx[model].count({ where: { salonId } });
  return `${prefix}-${String(count + 1).padStart(5, "0")}`;
};

export const assignAppointmentItems = async (tx, appointmentId, items) => {
  const existingItems = await tx.appointmentService.findMany({
    where: { appointmentId },
    select: { id: true }
  });
  if (existingItems.length) {
    await tx.appointmentServiceStaff.deleteMany({
      where: { appointmentServiceId: { in: existingItems.map((item) => item.id) } }
    });
  }
  await tx.appointmentService.deleteMany({ where: { appointmentId } });
  for (const item of items) {
    const createdItem = await tx.appointmentService.create({
      data: {
        appointmentId,
        serviceId: item.serviceId,
        startAt: new Date(item.startAt),
        endAt: new Date(item.endAt),
        notes: item.notes || null
      }
    });
    await tx.appointmentServiceStaff.createMany({
      data: item.staffUserIds.map((userSalonId) => ({ appointmentServiceId: createdItem.id, userSalonId })),
      skipDuplicates: true
    });
  }
};
