import { prisma } from "../../../lib/prisma.js";
import { calculatePayrollItem, createAuditLog, createStaffNotification } from "../../../lib/phase4.js";
import { buildCsv } from "../../../lib/phase2.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const INJECTIONS_FILE = path.join(__dirname, "../../../../data/injections.json");

const getInjections = () => {
  try {
    if (!fs.existsSync(INJECTIONS_FILE)) {
      fs.mkdirSync(path.dirname(INJECTIONS_FILE), { recursive: true });
      fs.writeFileSync(INJECTIONS_FILE, JSON.stringify([]));
      return [];
    }
    const data = fs.readFileSync(INJECTIONS_FILE, "utf8");
    return JSON.parse(data || "[]");
  } catch (err) {
    return [];
  }
};

const saveInjections = (injections) => {
  try {
    fs.mkdirSync(path.dirname(INJECTIONS_FILE), { recursive: true });
    fs.writeFileSync(INJECTIONS_FILE, JSON.stringify(injections, null, 2));
  } catch (err) {
    // ignore
  }
};

const toDate = (value) => (value ? new Date(value) : null);

export const registerOperationsRoutes = (ownerRouter) => {
  ownerRouter.get("/expense-categories", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "view"), async (req, res) => {
    res.json(await prisma.expenseCategory.findMany({ where: { salonId: req.salonId }, orderBy: { name: "asc" } }));
  });
  ownerRouter.post("/expense-categories", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "create"), validate(schemas.expenseCategory), async (req, res) => {
    res.status(201).json(await prisma.expenseCategory.create({ data: { salonId: req.salonId, name: req.body.name, description: req.body.description || null } }));
  });

  ownerRouter.get("/expenses", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    res.json(await prisma.expense.findMany({
      where: {
        salonId: req.salonId,
        ...(status ? { status } : {}),
        ...(branchId ? { branchId } : {}),
        ...(q ? {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { notes: { contains: q, mode: "insensitive" } }
          ]
        } : {})
      },
      include: { branch: true, category: true, vendor: true, createdByMembership: { include: { user: true } }, approvedByMembership: { include: { user: true } } },
      orderBy: { expenseDate: "desc" }
    }));
  });
  ownerRouter.post("/expenses", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "create"), validate(schemas.expense), async (req, res) => {
    const row = await prisma.expense.create({
      data: {
        salonId: req.salonId,
        branchId: req.body.branchId || null,
        categoryId: req.body.categoryId || null,
        vendorId: req.body.vendorId || null,
        createdByMembershipId: req.user.membershipId || null,
        title: req.body.title,
        amount: req.body.amount,
        expenseDate: new Date(req.body.expenseDate),
        paymentMode: req.body.paymentMode || null,
        status: req.body.status || "PENDING",
        notes: req.body.notes || null,
        receiptUrl: req.body.receiptUrl || null,
        attachmentUrl: req.body.attachmentUrl || null
      }
    });
    res.status(201).json(row);
  });

  ownerRouter.get("/expenses/reports", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "view"), async (req, res) => {
    const rows = await prisma.expense.findMany({ where: { salonId: req.salonId }, include: { category: true, branch: true }, orderBy: { expenseDate: "desc" } });
    res.json({
      total: rows.reduce((sum, row) => sum + Number(row.amount || 0), 0),
      approved: rows.filter((row) => row.status === "APPROVED" || row.status === "PAID"),
      rows
    });
  });

  ownerRouter.get("/expenses/accounts", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "view"), async (req, res) => {
    const injections = getInjections().filter(inj => inj.salonId === req.salonId);
    res.json({ injections });
  });

  ownerRouter.post("/expenses/accounts/injections", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "create"), async (req, res) => {
    const injections = getInjections();
    const newInjection = {
      id: "inj-" + Math.random().toString(36).substr(2, 9),
      salonId: req.salonId,
      accountMode: req.body.accountMode,
      paymentMode: req.body.paymentMode,
      amount: Number(req.body.amount),
      note: req.body.note,
      createdAt: new Date().toISOString()
    };
    injections.push(newInjection);
    saveInjections(injections);
    res.status(201).json(newInjection);
  });

  ownerRouter.get("/expenses/:id", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "view"), async (req, res) => {
    const row = await prisma.expense.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { branch: true, category: true, vendor: true } });
    if (!row) return res.status(404).json({ message: "Expense not found" });
    res.json(row);
  });
  ownerRouter.patch("/expenses/:id", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "edit"), validate(schemas.expense), async (req, res) => {
    const row = await prisma.expense.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Expense not found" });
    res.json(await prisma.expense.update({
      where: { id: row.id },
      data: {
        branchId: req.body.branchId || null,
        categoryId: req.body.categoryId || null,
        vendorId: req.body.vendorId || null,
        title: req.body.title,
        amount: req.body.amount,
        expenseDate: new Date(req.body.expenseDate),
        paymentMode: req.body.paymentMode || null,
        status: req.body.status || row.status,
        notes: req.body.notes || null,
        receiptUrl: req.body.receiptUrl || null,
        attachmentUrl: req.body.attachmentUrl || null
      }
    }));
  });
  ownerRouter.patch("/expenses/:id/approve", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "approve"), validate(schemas.expenseApproval), async (req, res) => {
    const row = await prisma.expense.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Expense not found" });
    const updated = await prisma.expense.update({
      where: { id: row.id },
      data: { status: "APPROVED", approvalNote: req.body.approvalNote || null, approvedByMembershipId: req.user.membershipId || null }
    });
    await createAuditLog({ salonId: req.salonId, actorUserId: req.user.userId, actorMembershipId: req.user.membershipId, module: "EXPENSES", action: "APPROVED", entityType: "Expense", entityId: updated.id, summary: `Expense ${updated.title} approved` });
    res.json(updated);
  });
  ownerRouter.patch("/expenses/:id/reject", requireFeatureEnabled("expenses"), requireSalonPermission("expenses", "approve"), validate(schemas.expenseApproval), async (req, res) => {
    const row = await prisma.expense.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Expense not found" });
    res.json(await prisma.expense.update({ where: { id: row.id }, data: { status: "REJECTED", approvalNote: req.body.approvalNote || null, approvedByMembershipId: req.user.membershipId || null } }));
  });

  ownerRouter.get("/attendance", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    res.json(await prisma.attendanceRecord.findMany({
      where: {
        salonId: req.salonId,
        ...(branchId ? { branchId } : {}),
        ...(q ? { userSalon: { is: { user: { is: { name: { contains: q, mode: "insensitive" } } } } } } : {})
      },
      include: { userSalon: { include: { user: true } }, branch: true },
      orderBy: { checkInAt: "desc" }
    }));
  });
  ownerRouter.post("/attendance", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "create"), validate(schemas.attendance), async (req, res) => {
    res.status(201).json(await prisma.attendanceRecord.create({
      data: {
        salonId: req.salonId,
        branchId: req.body.branchId || null,
        userSalonId: req.body.userSalonId,
        createdByMembershipId: req.user.membershipId || null,
        checkInAt: toDate(req.body.checkInAt) || new Date(),
        checkOutAt: toDate(req.body.checkOutAt),
        note: req.body.note || null
      }
    }));
  });
  ownerRouter.post("/attendance/check-in", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "create"), validate(schemas.attendance), async (req, res) => {
    res.status(201).json(await prisma.attendanceRecord.create({
      data: {
        salonId: req.salonId,
        branchId: req.body.branchId || null,
        userSalonId: req.body.userSalonId,
        createdByMembershipId: req.user.membershipId || null,
        checkInAt: new Date(),
        note: req.body.note || null
      }
    }));
  });
  ownerRouter.post("/attendance/check-out", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "edit"), validate(schemas.attendance), async (req, res) => {
    const row = await prisma.attendanceRecord.findFirst({ where: { salonId: req.salonId, userSalonId: req.body.userSalonId }, orderBy: { checkInAt: "desc" } });
    if (!row || row.checkOutAt) return res.status(404).json({ message: "Open attendance record not found" });
    const checkOutAt = new Date();
    const workedMinutes = Math.max(0, Math.round((checkOutAt.getTime() - new Date(row.checkInAt).getTime()) / 60000));
    res.json(await prisma.attendanceRecord.update({ where: { id: row.id }, data: { checkOutAt, workedMinutes, note: req.body.note || row.note } }));
  });

  ownerRouter.get("/attendance/:staffId", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    res.json(await prisma.attendanceRecord.findMany({ where: { salonId: req.salonId, userSalonId: req.params.staffId }, orderBy: { checkInAt: "desc" } }));
  });

  ownerRouter.get("/leaves", requireFeatureEnabled("leaves"), requireSalonPermission("leaves", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    res.json(await prisma.leaveRequest.findMany({
      where: {
        salonId: req.salonId,
        ...(status ? { status } : {}),
        ...(q ? { userSalon: { is: { user: { is: { name: { contains: q, mode: "insensitive" } } } } } } : {})
      },
      include: { userSalon: { include: { user: true } }, approvedByMembership: { include: { user: true } } },
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.post("/leaves", requireFeatureEnabled("leaves"), requireSalonPermission("leaves", "create"), validate(schemas.leaveRequest), async (req, res) => {
    const userSalonId = req.body.userSalonId || req.user.membershipId;
    res.status(201).json(await prisma.leaveRequest.create({
      data: {
        salonId: req.salonId,
        userSalonId,
        startDate: new Date(req.body.startDate),
        endDate: new Date(req.body.endDate),
        reason: req.body.reason || null,
        note: req.body.note || null
      }
    }));
  });
  ownerRouter.get("/leaves/:id", requireFeatureEnabled("leaves"), requireSalonPermission("leaves", "view"), async (req, res) => {
    const row = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { userSalon: { include: { user: true } } } });
    if (!row) return res.status(404).json({ message: "Leave request not found" });
    res.json(row);
  });
  ownerRouter.patch("/leaves/:id/approve", requireFeatureEnabled("leaves"), requireSalonPermission("leaves", "approve"), validate(schemas.leaveStatus), async (req, res) => {
    const row = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Leave request not found" });
    res.json(await prisma.leaveRequest.update({ where: { id: row.id }, data: { status: "APPROVED", note: req.body.note || row.note, approvedByMembershipId: req.user.membershipId || null } }));
  });
  ownerRouter.patch("/leaves/:id/reject", requireFeatureEnabled("leaves"), requireSalonPermission("leaves", "approve"), validate(schemas.leaveStatus), async (req, res) => {
    const row = await prisma.leaveRequest.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Leave request not found" });
    res.json(await prisma.leaveRequest.update({ where: { id: row.id }, data: { status: "REJECTED", note: req.body.note || row.note, approvedByMembershipId: req.user.membershipId || null } }));
  });

  ownerRouter.get("/incentives", requireFeatureEnabled("incentives"), requireSalonPermission("incentives", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    res.json(await prisma.incentiveRule.findMany({
      where: {
        salonId: req.salonId,
        ...(q ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { targetType: { contains: q, mode: "insensitive" } },
            { notes: { contains: q, mode: "insensitive" } }
          ]
        } : {})
      },
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.post("/incentives", requireFeatureEnabled("incentives"), requireSalonPermission("incentives", "create"), validate(schemas.incentiveRule), async (req, res) => {
    res.status(201).json(await prisma.incentiveRule.create({
      data: {
        salonId: req.salonId,
        createdByMembershipId: req.user.membershipId || null,
        name: req.body.name,
        targetType: req.body.targetType,
        minTarget: req.body.minTarget ?? null,
        incentiveAmount: req.body.incentiveAmount,
        isActive: req.body.isActive ?? true,
        notes: req.body.notes || null
      }
    }));
  });

  ownerRouter.get("/payroll", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "view"), async (req, res) => {
    const status = String(req.query.status || "").trim();
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    res.json(await prisma.payrollRun.findMany({
      where: {
        salonId: req.salonId,
        ...(status ? { status } : {}),
        ...(branchId ? { branchId } : {})
      },
      include: { branch: true, items: { include: { userSalon: { include: { user: true } } } } },
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.post("/payroll", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "create"), validate(schemas.payrollRun), async (req, res) => {
    res.status(201).json(await prisma.payrollRun.create({
      data: {
        salonId: req.salonId,
        branchId: req.body.branchId || null,
        generatedByMembershipId: req.user.membershipId || null,
        periodStart: new Date(req.body.periodStart),
        periodEnd: new Date(req.body.periodEnd),
        notes: req.body.notes || null
      }
    }));
  });
  ownerRouter.post("/payroll/calculate", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "edit"), async (req, res) => {
    const runId = req.body.runId;
    const run = await prisma.payrollRun.findFirst({ where: { id: runId, salonId: req.salonId } });
    if (!run) return res.status(404).json({ message: "Payroll run not found" });
    const staffMembers = await prisma.userSalon.findMany({ where: { salonId: req.salonId, isArchived: false } });
    await prisma.payrollItem.deleteMany({ where: { payrollRunId: run.id } });

    const items = [];
    for (const member of staffMembers) {
      const invoices = await prisma.invoiceItem.findMany({
        where: { invoice: { salonId: req.salonId, createdAt: { gte: run.periodStart, lte: run.periodEnd } }, staffUserSalonId: member.id }
      });
      const attendanceRecords = await prisma.attendanceRecord.findMany({
        where: { salonId: req.salonId, userSalonId: member.id, checkInAt: { gte: run.periodStart, lte: run.periodEnd } }
      });
      const leaveRequests = await prisma.leaveRequest.findMany({
        where: { salonId: req.salonId, userSalonId: member.id, createdAt: { gte: run.periodStart, lte: run.periodEnd } }
      });
      const item = calculatePayrollItem({
        invoices,
        membershipSales: [],
        packageSales: [],
        attendanceRecords,
        leaveRequests,
        baseSalary: 50000
      });
      items.push({ salonId: req.salonId, payrollRunId: run.id, userSalonId: member.id, ...item });
    }

    if (items.length) {
      await prisma.payrollItem.createMany({ data: items });
    }
    const totals = items.reduce((acc, row) => ({
      totalBaseSalary: acc.totalBaseSalary + Number(row.baseSalary || 0),
      totalCommission: acc.totalCommission + Number(row.commissionAmount || 0),
      totalIncentive: acc.totalIncentive + Number(row.incentiveAmount || 0),
      totalAdjustments: acc.totalAdjustments + Number(row.adjustmentAmount || 0),
      totalNet: acc.totalNet + Number(row.netAmount || 0)
    }), { totalBaseSalary: 0, totalCommission: 0, totalIncentive: 0, totalAdjustments: 0, totalNet: 0 });

    res.json(await prisma.payrollRun.update({ where: { id: run.id }, data: { status: "CALCULATED", ...totals }, include: { items: true } }));
  });
  ownerRouter.get("/payroll/:id", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "view"), async (req, res) => {
    const row = await prisma.payrollRun.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { branch: true, items: { include: { userSalon: { include: { user: true } } } } } });
    if (!row) return res.status(404).json({ message: "Payroll run not found" });
    res.json(row);
  });
  ownerRouter.patch("/payroll/:id/approve", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "approve"), validate(schemas.payrollStatus), async (req, res) => {
    const row = await prisma.payrollRun.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Payroll run not found" });
    const updated = await prisma.payrollRun.update({ where: { id: row.id }, data: { status: "APPROVED", approvedByMembershipId: req.user.membershipId || null, notes: req.body.note || row.notes } });
    await createAuditLog({ salonId: req.salonId, actorUserId: req.user.userId, actorMembershipId: req.user.membershipId, module: "PAYROLL", action: "APPROVED", entityType: "PayrollRun", entityId: updated.id, summary: "Payroll run approved" });
    res.json(updated);
  });
  ownerRouter.patch("/payroll/:id/mark-paid", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "pay"), validate(schemas.payrollStatus), async (req, res) => {
    const row = await prisma.payrollRun.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Payroll run not found" });
    res.json(await prisma.payrollRun.update({ where: { id: row.id }, data: { status: "PAID", paidAt: new Date(), notes: req.body.note || row.notes } }));
  });
  ownerRouter.get("/payroll/reports", requireFeatureEnabled("payroll"), requireSalonPermission("payroll", "view"), async (req, res) => {
    const rows = await prisma.payrollRun.findMany({ where: { salonId: req.salonId }, include: { items: true }, orderBy: { createdAt: "desc" } });
    res.json({ totalNet: rows.reduce((sum, row) => sum + Number(row.totalNet || 0), 0), rows });
  });

  ownerRouter.get("/notifications", requireFeatureEnabled("notifications"), requireSalonPermission("notifications", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const type = String(req.query.type || "").trim();
    const isRead = req.query.isRead === "true" ? true : req.query.isRead === "false" ? false : undefined;
    res.json(await prisma.notification.findMany({
      where: {
        salonId: req.salonId,
        AND: [
          { OR: [{ userSalonId: null }, { userSalonId: req.user.membershipId || "" }] },
          ...(q ? [{
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { message: { contains: q, mode: "insensitive" } },
              { type: { contains: q, mode: "insensitive" } },
              { linkUrl: { contains: q, mode: "insensitive" } }
            ]
          }] : [])
        ],
        ...(type ? { type } : {}),
        ...(isRead !== undefined ? { isRead } : {})
      },
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.get("/notifications/export.csv", requireFeatureEnabled("notifications"), requireSalonPermission("notifications", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const type = String(req.query.type || "").trim();
    const isRead = req.query.isRead === "true" ? true : req.query.isRead === "false" ? false : undefined;
    const rows = await prisma.notification.findMany({
      where: {
        salonId: req.salonId,
        AND: [
          { OR: [{ userSalonId: null }, { userSalonId: req.user.membershipId || "" }] },
          ...(q ? [{
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { message: { contains: q, mode: "insensitive" } },
              { type: { contains: q, mode: "insensitive" } },
              { linkUrl: { contains: q, mode: "insensitive" } }
            ]
          }] : [])
        ],
        ...(type ? { type } : {}),
        ...(isRead !== undefined ? { isRead } : {})
      },
      orderBy: { createdAt: "desc" }
    });
    const csv = buildCsv(
      ["Title", "Message", "Type", "Read", "Link", "Created At"],
      rows.map((row) => [row.title, row.message, row.type, row.isRead ? "Yes" : "No", row.linkUrl || "", row.createdAt ? new Date(row.createdAt).toISOString() : ""])
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"notifications-export.csv\"");
    res.send(csv);
  });
  ownerRouter.patch("/notifications/:id/read", requireFeatureEnabled("notifications"), requireSalonPermission("notifications", "edit"), async (req, res) => {
    const row = await prisma.notification.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Notification not found" });
    res.json(await prisma.notification.update({ where: { id: row.id }, data: { isRead: true } }));
  });
  ownerRouter.patch("/notifications/read-all", requireFeatureEnabled("notifications"), requireSalonPermission("notifications", "edit"), async (req, res) => {
    await prisma.notification.updateMany({ where: { salonId: req.salonId, OR: [{ userSalonId: null }, { userSalonId: req.user.membershipId || "" }] }, data: { isRead: true } });
    res.json({ ok: true });
  });
  ownerRouter.post("/notifications/test-placeholder", requireFeatureEnabled("notifications"), requireSalonPermission("notifications", "create"), validate(schemas.notificationTest), async (req, res) => {
    res.status(201).json(await createStaffNotification({
      salonId: req.salonId,
      userSalonId: req.body.userSalonId || null,
      title: req.body.title,
      message: req.body.message,
      linkUrl: req.body.linkUrl || null,
      type: "TEST"
    }));
  });

  ownerRouter.get("/audit-logs", requireFeatureEnabled("auditLogs"), requireSalonPermission("auditLogs", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    res.json(await prisma.auditLog.findMany({
      where: {
        salonId: req.salonId,
        ...(req.query.module ? { module: String(req.query.module) } : {}),
        ...(req.query.action ? { action: String(req.query.action) } : {}),
        ...(q ? {
          OR: [
            { module: { contains: q, mode: "insensitive" } },
            { action: { contains: q, mode: "insensitive" } },
            { entityType: { contains: q, mode: "insensitive" } },
            { entityId: { contains: q, mode: "insensitive" } },
            { summary: { contains: q, mode: "insensitive" } },
            { reference: { contains: q, mode: "insensitive" } }
          ]
        } : {})
      },
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.get("/audit-logs/export.csv", requireFeatureEnabled("auditLogs"), requireSalonPermission("auditLogs", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const rows = await prisma.auditLog.findMany({
      where: {
        salonId: req.salonId,
        ...(req.query.module ? { module: String(req.query.module) } : {}),
        ...(req.query.action ? { action: String(req.query.action) } : {}),
        ...(q ? {
          OR: [
            { module: { contains: q, mode: "insensitive" } },
            { action: { contains: q, mode: "insensitive" } },
            { entityType: { contains: q, mode: "insensitive" } },
            { entityId: { contains: q, mode: "insensitive" } },
            { summary: { contains: q, mode: "insensitive" } },
            { reference: { contains: q, mode: "insensitive" } }
          ]
        } : {})
      },
      orderBy: { createdAt: "desc" }
    });
    const csv = buildCsv(
      ["Module", "Action", "Entity Type", "Entity Id", "Summary", "Reference", "Created At"],
      rows.map((row) => [row.module, row.action, row.entityType || "", row.entityId || "", row.summary || "", row.reference || "", row.createdAt ? new Date(row.createdAt).toISOString() : ""])
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"audit-logs-export.csv\"");
    res.send(csv);
  });
};
