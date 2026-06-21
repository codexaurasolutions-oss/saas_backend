import { prisma } from "./prisma.js";

export const toAmount = (value) => Number(value || 0);
export const normalizeBranchId = (value) => (value ? String(value) : null);
export const toDate = (value) => (value ? new Date(value) : null);

export const timeToMinutes = (value) => {
  if (!value) return null;
  const [hours = "0", minutes = "0"] = String(value).split(":");
  return Number(hours) * 60 + Number(minutes);
};

export const dateToMinutes = (value) => {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
};

export const overlap = (startA, endA, startB, endB) => new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB);

const timeWindowOverlap = (windowStartA, windowEndA, windowStartB, windowEndB) => windowStartA < windowEndB && windowEndA > windowStartB;

export const logCustomerTimeline = async (tx, customerId, eventType, title, details, referenceId = null) => {
  await tx.customerTimeline.create({
    data: { customerId, eventType, title, details: details || null, referenceId: referenceId || null }
  });
};

export const refreshCustomerInsights = async (tx, customerId) => {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    include: {
      invoices: {
        where: { status: { in: ["PAID", "PARTIAL", "REFUNDED"] } },
        orderBy: { createdAt: "desc" }
      },
      appointments: {
        where: { status: { in: ["COMPLETED", "IN_PROGRESS", "CHECKED_IN"] } },
        orderBy: { startAt: "desc" }
      }
    }
  });
  if (!customer) return;

  const totalSpend = customer.invoices.reduce((sum, invoice) => sum + Math.max(0, toAmount(invoice.paidAmount) - toAmount(invoice.refundAmount)), 0);
  const visitCount = Math.max(customer.invoices.length, customer.appointments.length);
  const lastVisitAt = customer.appointments[0]?.startAt || customer.invoices[0]?.createdAt || null;

  await tx.customer.update({
    where: { id: customerId },
    data: {
      totalSpend,
      averageSpend: visitCount ? totalSpend / visitCount : 0,
      lastVisitAt
    }
  });
};

export const getSalonSetting = async (tx, salonId, branchId = null) => {
  const normalizedBranchId = normalizeBranchId(branchId);
  return (
    await tx.salonSetting.findFirst({
      where: { salonId, branchId: normalizedBranchId }
    })
  ) || (
    await tx.salonSetting.findFirst({
      where: { salonId, branchId: null }
    })
  );
};

export const getBranchStockBalance = async (tx, salonId, productId, branchId) => {
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId) return null;
  const latestMovement = await tx.stockMovement.findFirst({
    where: { salonId, productId, branchId: normalizedBranchId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  if (latestMovement) {
    return toAmount(latestMovement.stockAfter);
  }

  const product = await tx.product.findFirst({
    where: { id: productId, salonId }
  });
  if (!product) return 0;
  return normalizeBranchId(product.branchId) === normalizedBranchId ? toAmount(product.currentStock) : 0;
};

export const attachBranchStock = async (tx, rows, branchId) => {
  const normalizedBranchId = normalizeBranchId(branchId);
  if (!normalizedBranchId || !rows.length) return rows;

  const ids = rows.map((row) => row.id);
  const movements = await tx.stockMovement.findMany({
    where: { salonId: rows[0].salonId, branchId: normalizedBranchId, productId: { in: ids } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }]
  });
  const balanceMap = new Map();
  for (const movement of movements) {
    if (!balanceMap.has(movement.productId)) {
      balanceMap.set(movement.productId, toAmount(movement.stockAfter));
    }
  }

  return rows.map((row) => ({
    ...row,
    currentStock: balanceMap.has(row.id)
      ? balanceMap.get(row.id)
      : (normalizeBranchId(row.branchId) === normalizedBranchId ? toAmount(row.currentStock) : 0)
  }));
};

export const createStockMovement = async (tx, {
  salonId,
  branchId = null,
  productId,
  quantity,
  movementType,
  createdByUserId = null,
  referenceType = null,
  referenceId = null,
  note = null,
  allowNegativeStock = false
}) => {
  const product = await tx.product.findFirst({
    where: { id: productId, salonId }
  });
  if (!product) {
    const error = new Error("Product not found");
    error.status = 404;
    throw error;
  }

  const currentStock = toAmount(product.currentStock);
  const delta = toAmount(quantity);
  const nextStock = currentStock + delta;
  const negativeAllowed = allowNegativeStock || product.allowNegativeStock;
  const effectiveBranchId = normalizeBranchId(branchId || product.branchId);
  const branchStockBefore = effectiveBranchId
    ? await getBranchStockBalance(tx, salonId, product.id, effectiveBranchId)
    : currentStock;
  const branchStockAfter = branchStockBefore + delta;

  if ((nextStock < 0 || branchStockAfter < 0) && !negativeAllowed) {
    const error = new Error(`Insufficient stock for ${product.name}`);
    error.status = 400;
    throw error;
  }

  await tx.product.update({
    where: { id: product.id },
    data: { currentStock: nextStock }
  });

  return tx.stockMovement.create({
    data: {
      salonId,
      branchId: effectiveBranchId,
      productId: product.id,
      createdByUserId,
      movementType,
      quantity: delta,
      stockBefore: effectiveBranchId ? branchStockBefore : currentStock,
      stockAfter: effectiveBranchId ? branchStockAfter : nextStock,
      referenceType,
      referenceId,
      note
    }
  });
};

export const ensureScopedBranch = async (salonId, branchId) => {
  if (!branchId) return null;
  const branch = await prisma.branch.findFirst({ where: { id: branchId, salonId, isActive: true } });
  if (!branch) {
    const error = new Error("Branch not found");
    error.status = 400;
    throw error;
  }
  return branch;
};

export const ensureScopedCustomer = async (salonId, customerId) => {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, salonId } });
  if (!customer) {
    const error = new Error("Customer not found");
    error.status = 404;
    throw error;
  }
  return customer;
};

export const ensureScopedStaffMembership = async (salonId, membershipId) => {
  if (!membershipId) return null;
  const membership = await prisma.userSalon.findFirst({
    where: { id: membershipId, salonId, isArchived: false, user: { isActive: true } },
    include: {
      user: true,
      serviceAssignments: true,
      staffSchedules: true,
      staffBreaks: true
    }
  });
  if (!membership) {
    const error = new Error("Staff user not found");
    error.status = 404;
    throw error;
  }
  return membership;
};

export const ensureScopedService = async (salonId, serviceId) => {
  const service = await prisma.service.findFirst({
    where: { id: serviceId, salonId, isActive: true }
  });
  if (!service) {
    const error = new Error("Service not found");
    error.status = 404;
    throw error;
  }
  return service;
};

export const checkStaffAvailability = async ({
  salonId,
  branchId,
  staffMembershipIds,
  startAt,
  endAt,
  appointmentIdToExclude = null
}) => {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const weekday = start.getDay();
  const startMinutes = dateToMinutes(start);
  const endMinutes = dateToMinutes(end);

  for (const membershipId of staffMembershipIds) {
    const membership = await ensureScopedStaffMembership(salonId, membershipId);
    if (branchId && membership.branchId && membership.branchId !== branchId) {
      const error = new Error(`${membership.user.name} belongs to another branch`);
      error.status = 400;
      throw error;
    }

    const salonSetting = await getSalonSetting(prisma, salonId, branchId);
    const rosterRows = salonSetting?.advancedSettings?.rosterManagement?.rows;
    const rosterRow = Array.isArray(rosterRows) ? rosterRows.find(r => r.id === membershipId) : null;

    if (rosterRow) {
      if (!rosterRow.isWorking) {
        const error = new Error(`${membership.user.name} is off on this day`);
        error.status = 400;
        throw error;
      }
      const rosterStart = timeToMinutes(rosterRow.fromTime || "09:00");
      const rosterEnd = timeToMinutes(rosterRow.toTime || "21:00");
      if (startMinutes < rosterStart || endMinutes > rosterEnd) {
        const error = new Error(`${membership.user.name} is outside working hours (${rosterRow.fromTime} - ${rosterRow.toTime})`);
        error.status = 400;
        throw error;
      }
    } else {
      const schedule = membership.staffSchedules.find((item) => item.weekday === weekday);
      if (schedule) {
        if (schedule.isOffDay) {
          const error = new Error(`${membership.user.name} is off on this day`);
          error.status = 400;
          throw error;
        }
        const scheduleStart = timeToMinutes(schedule.startTime);
        const scheduleEnd = timeToMinutes(schedule.endTime);
        if (startMinutes < scheduleStart || endMinutes > scheduleEnd) {
          const error = new Error(`${membership.user.name} is outside working hours`);
          error.status = 400;
          throw error;
        }
      }
    }

    const breakWindow = membership.staffBreaks.find((item) => {
      if (item.weekday !== weekday) return false;
      const breakStart = timeToMinutes(item.startTime);
      const breakEnd = timeToMinutes(item.endTime);
      return timeWindowOverlap(breakStart, breakEnd, startMinutes, endMinutes);
    });
    if (breakWindow) {
      const error = new Error(`${membership.user.name} has a scheduled break in this slot`);
      error.status = 400;
      throw error;
    }

    const conflicting = await prisma.appointment.findFirst({
      where: {
        salonId,
        status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"] },
        NOT: appointmentIdToExclude ? { id: appointmentIdToExclude } : undefined,
        items: { some: { assignedStaff: { some: { userSalonId: membershipId } } } },
        startAt: { lt: end },
        endAt: { gt: start }
      }
    });
    if (conflicting) {
      const error = new Error(`${membership.user.name} is already booked for this time`);
      error.status = 400;
      throw error;
    }
  }
};

export const buildCsv = (header, rows) =>
  [header, ...rows]
    .map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, "\"\"")}"`).join(","))
    .join("\n");

export const isOwnScopedStaff = (req, moduleKey) =>
  req.user?.salonRole === "STAFF" && !((req.user?.permissions?.[moduleKey] || []).includes("manage_all"));
