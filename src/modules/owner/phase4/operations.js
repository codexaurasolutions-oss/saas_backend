import { prisma } from "../../../lib/prisma.js";
import { calculatePayrollItem, createAuditLog, createStaffNotification } from "../../../lib/phase4.js";
import { buildCsv } from "../../../lib/phase2.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";
import ExcelJS from "exceljs";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";
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
const DEFAULT_ATTENDANCE_SETTINGS = {
  officeStartTime: "09:00",
  officeEndTime: "18:00",
  lateAfterTime: "09:15",
  halfDayMinutes: 240,
  minimumWorkingMinutes: 480,
  overtimeEnabled: false,
  overtimeThresholdMinutes: 480,
  checkoutSelfieRequired: false,
  allowManualAttendanceEdits: true
};
const startOfAttendanceDay = (value = new Date()) => {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
};
const endOfAttendanceDay = (value = new Date()) => {
  const date = startOfAttendanceDay(value);
  date.setDate(date.getDate() + 1);
  return date;
};
const parseTimeOnDate = (dateValue, timeValue) => {
  const base = startOfAttendanceDay(dateValue);
  const [hours, minutes] = String(timeValue || "00:00").split(":").map((part) => Number(part || 0));
  base.setHours(hours, minutes, 0, 0);
  return base;
};
const roundMinutesDiff = (startAt, endAt) => Math.max(0, Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000));
const toDecimalNumber = (value) => value == null ? null : Number(value);
const haversineDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};
const mergeAttendanceSettings = (rawSettings) => ({
  ...DEFAULT_ATTENDANCE_SETTINGS,
  ...(rawSettings && typeof rawSettings === "object" ? rawSettings : {})
});
const getAttendanceSettings = async (salonId) => {
  const row = await prisma.salonSetting.findFirst({ where: { salonId, branchId: null } });
  return mergeAttendanceSettings(row?.advancedSettings?.attendanceSettings);
};
const resolveAttendanceStatus = ({ attendanceDate, checkInAt, checkOutAt, workedMinutes, settings }) => {
  if (!checkInAt) return "ABSENT";
  if (!checkOutAt) return "WORKING";
  const lateAfter = parseTimeOnDate(attendanceDate, settings.lateAfterTime);
  const halfDayThreshold = Number(settings.halfDayMinutes || DEFAULT_ATTENDANCE_SETTINGS.halfDayMinutes);
  const minWork = Number(settings.minimumWorkingMinutes || DEFAULT_ATTENDANCE_SETTINGS.minimumWorkingMinutes);
  if (workedMinutes < halfDayThreshold) return "HALF_DAY";
  if (new Date(checkInAt) > lateAfter) return "LATE";
  if (workedMinutes >= minWork) return "COMPLETED_SHIFT";
  return "PRESENT";
};
const validateGeofence = ({ branch, latitude, longitude }) => {
  const branchLatitude = toDecimalNumber(branch?.latitude);
  const branchLongitude = toDecimalNumber(branch?.longitude);
  const radius = Number(branch?.geofenceRadiusMeters || 75);
  if (branchLatitude == null || branchLongitude == null || (Number(branchLatitude) === 0 && Number(branchLongitude) === 0)) {
    return { distance: 0, geoStatus: "SKIPPED" };
  }
  const distance = haversineDistanceMeters(branchLatitude, branchLongitude, Number(latitude), Number(longitude));
  return {
    distance,
    geoStatus: distance <= radius ? "INSIDE" : "OUTSIDE"
  };
};
const addDays = (value, days) => {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
};
const getPeriodWindow = (period, referenceDate = new Date()) => {
  const anchor = startOfAttendanceDay(referenceDate);
  if (period === "weekly") {
    const start = new Date(anchor);
    const day = start.getDay();
    const diffToMonday = day === 0 ? -6 : 1 - day;
    start.setDate(start.getDate() + diffToMonday);
    return { start, end: addDays(start, 7), label: "Weekly" };
  }
  if (period === "monthly") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    return { start, end, label: "Monthly" };
  }
  return { start: anchor, end: addDays(anchor, 1), label: "Daily" };
};
const formatDateLabel = (value) => new Date(value).toLocaleDateString("en-GB");
const formatDateTimeLabel = (value) => value ? new Date(value).toLocaleString("en-GB") : "-";
const formatWorkedHours = (minutes) => {
  if (minutes == null) return "-";
  const hrs = Math.floor(Number(minutes) / 60);
  const mins = Number(minutes) % 60;
  return `${hrs}h ${mins}m`;
};
const toYmd = (value) => {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const buildAttendanceReportDataset = async ({ salonId, branchId, period, referenceDate }) => {
  const { start, end, label } = getPeriodWindow(period, referenceDate);
  const [staffRows, attendanceRows, leaveRows] = await Promise.all([
    prisma.userSalon.findMany({
      where: {
        salonId,
        isArchived: false,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
        user: { isActive: true }
      },
      include: { user: true, branch: true },
      orderBy: { id: "asc" }
    }),
    prisma.attendanceRecord.findMany({
      where: {
        salonId,
        ...(branchId ? { branchId } : {}),
        attendanceDate: { gte: start, lt: end }
      },
      include: { userSalon: { include: { user: true, branch: true } }, branch: true },
      orderBy: [{ attendanceDate: "asc" }, { checkInAt: "asc" }]
    }),
    prisma.leaveRequest.findMany({
      where: {
        salonId,
        status: "APPROVED",
        startDate: { lt: end },
        endDate: { gte: start }
      }
    })
  ]);

  const attendanceMap = new Map(
    attendanceRows.map((row) => {
      const dayKey = toYmd(row.checkInAt || row.attendanceDate);
      return [`${row.userSalonId}:${dayKey}`, row];
    })
  );
  const leaveSet = new Set();
  leaveRows.forEach((row) => {
    for (let cursor = startOfAttendanceDay(row.startDate); cursor < end; cursor = addDays(cursor, 1)) {
      if (cursor >= startOfAttendanceDay(start) && cursor >= startOfAttendanceDay(row.startDate) && cursor <= startOfAttendanceDay(row.endDate)) {
        leaveSet.add(`${row.userSalonId}:${toYmd(cursor)}`);
      }
    }
  });

  const rows = [];
  for (let cursor = new Date(start); cursor < end; cursor = addDays(cursor, 1)) {
    const dayKey = toYmd(cursor);
    for (const staff of staffRows) {
      const attendanceRow = attendanceMap.get(`${staff.id}:${dayKey}`) || null;
      const leaveKey = `${staff.id}:${dayKey}`;
      if (attendanceRow) {
        rows.push({
          date: new Date(cursor),
          staffName: attendanceRow.userSalon?.user?.name || staff.user?.name || staff.id,
          staffCode: staff.id,
          branchName: attendanceRow.branch?.name || staff.branch?.name || "",
          status: attendanceRow.status,
          checkInAt: attendanceRow.checkInAt,
          checkOutAt: attendanceRow.checkOutAt,
          workedMinutes: attendanceRow.workedMinutes,
          workedHours: formatWorkedHours(attendanceRow.workedMinutes),
          geoStatus: attendanceRow.geoStatus,
          verificationMethod: attendanceRow.verificationMethod,
          gpsLocation: attendanceRow.checkInLatitude != null && attendanceRow.checkInLongitude != null
            ? `${attendanceRow.checkInLatitude}, ${attendanceRow.checkInLongitude}`
            : "-",
          selfie: attendanceRow.checkInSelfieUrl || attendanceRow.checkOutSelfieUrl || "",
          adminRemark: attendanceRow.adminRemark || "",
          note: attendanceRow.note || ""
        });
      } else if (leaveSet.has(leaveKey)) {
        rows.push({
          date: new Date(cursor),
          staffName: staff.user?.name || staff.id,
          staffCode: staff.id,
          branchName: staff.branch?.name || "",
          status: "LEAVE",
          checkInAt: null,
          checkOutAt: null,
          workedMinutes: 0,
          workedHours: "0h 0m",
          geoStatus: "NOT_CAPTURED",
          verificationMethod: "MANUAL",
          gpsLocation: "-",
          selfie: "",
          adminRemark: "",
          note: "Approved leave"
        });
      } else {
        rows.push({
          date: new Date(cursor),
          staffName: staff.user?.name || staff.id,
          staffCode: staff.id,
          branchName: staff.branch?.name || "",
          status: "ABSENT",
          checkInAt: null,
          checkOutAt: null,
          workedMinutes: 0,
          workedHours: "0h 0m",
          geoStatus: "NOT_CAPTURED",
          verificationMethod: "MANUAL",
          gpsLocation: "-",
          selfie: "",
          adminRemark: "",
          note: ""
        });
      }
    }
  }

  const statusSummary = rows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});

  return {
    period,
    label,
    start,
    end,
    rows,
    summary: {
      totalRows: rows.length,
      totalStaff: staffRows.length,
      present: rows.filter((row) => ["PRESENT", "LATE", "HALF_DAY", "COMPLETED_SHIFT", "WORKING"].includes(row.status)).length,
      absent: statusSummary.ABSENT || 0,
      leave: statusSummary.LEAVE || 0,
      late: statusSummary.LATE || 0,
      halfDay: statusSummary.HALF_DAY || 0,
      completedShift: statusSummary.COMPLETED_SHIFT || 0,
      working: statusSummary.WORKING || 0
    }
  };
};
const buildAttendanceExportRows = (rows) => rows.map((row, index) => ({
  "SR. NO.": index + 1,
  DATE: formatDateLabel(row.date),
  STAFF: row.staffName,
  "STAFF ID": row.staffCode,
  BRANCH: row.branchName || "-",
  STATUS: row.status,
  "CHECK-IN": formatDateTimeLabel(row.checkInAt),
  "CHECK-OUT": formatDateTimeLabel(row.checkOutAt),
  "WORKING HOURS": row.workedHours,
  "GEO STATUS": row.geoStatus,
  "VERIFICATION": row.verificationMethod,
  "GPS LOCATION": row.gpsLocation,
  SELFIE: row.selfie || "-",
  REMARK: row.adminRemark || "-",
  NOTE: row.note || "-"
}));

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
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const rows = await prisma.expense.findMany({ where: { salonId: req.salonId, ...(branchId ? { branchId } : {}) }, include: { category: true, branch: true }, orderBy: { expenseDate: "desc" } });
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
    const { accountMode, paymentMode, amount, note } = req.body || {};
    if (!accountMode || !["CASH", "BANK", "WALLET"].includes(String(accountMode))) {
      return res.status(400).json({ message: "accountMode must be CASH, BANK, or WALLET" });
    }
    if (!paymentMode || !["CASH", "CARD", "UPI", "BANK_TRANSFER", "WALLET", "ONLINE"].includes(String(paymentMode))) {
      return res.status(400).json({ message: "Invalid paymentMode" });
    }
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 9999999) {
      return res.status(400).json({ message: "Amount must be a positive number (max 9999999)" });
    }
    const sanitizedNote = String(note || "").trim().slice(0, 500);
    const injections = getInjections();
    const newInjection = {
      id: "inj-" + crypto.randomUUID(),
      salonId: req.salonId,
      accountMode: String(accountMode),
      paymentMode: String(paymentMode),
      amount: numAmount,
      note: sanitizedNote,
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
    const status = String(req.query.status || "").trim();
    const date = String(req.query.date || "").trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const skip = (page - 1) * limit;
    const where = {
      salonId: req.salonId,
      ...(branchId ? { branchId } : {}),
      ...(status ? { status } : {}),
      ...(date ? { attendanceDate: { gte: startOfAttendanceDay(date), lt: endOfAttendanceDay(date) } } : {}),
      ...(q ? { userSalon: { is: { user: { is: { name: { contains: q, mode: "insensitive" } } } } } } : {})
    };
    const [rows, total] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where,
        include: { userSalon: { include: { user: true } }, branch: true },
        orderBy: [{ attendanceDate: "desc" }, { checkInAt: "desc" }],
        skip,
        take: limit
      }),
      prisma.attendanceRecord.count({ where })
    ]);
    res.json({ rows, total, page, limit, totalPages: Math.ceil(total / limit) });
  });
  ownerRouter.get("/attendance/settings", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    res.json(await getAttendanceSettings(req.salonId));
  });
  ownerRouter.post("/attendance/settings", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "edit"), validate(schemas.attendanceSettings), async (req, res) => {
    const existing = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
    const advancedSettings = {
      ...(existing?.advancedSettings || {}),
      attendanceSettings: {
        ...mergeAttendanceSettings(existing?.advancedSettings?.attendanceSettings),
        ...req.body
      }
    };
    const row = existing
      ? await prisma.salonSetting.update({ where: { id: existing.id }, data: { advancedSettings } })
      : await prisma.salonSetting.create({ data: { salonId: req.salonId, branchId: null, advancedSettings } });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ATTENDANCE",
      action: "SETTINGS_UPDATED",
      entityType: "SalonSetting",
      entityId: row.id,
      summary: "Attendance settings updated",
      metadata: { attendanceSettings: advancedSettings.attendanceSettings }
    });
    res.status(201).json(advancedSettings.attendanceSettings);
  });
  ownerRouter.get("/attendance/summary", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    try {
      const targetDate = startOfAttendanceDay(req.query.date || new Date());
      const targetEnd = endOfAttendanceDay(targetDate);
      const branchId = req.query.branchId ? String(req.query.branchId) : null;
      const staffBranchFilter = branchId ? { OR: [{ branchId }, { branchId: null }] } : {};
      const recordBranchFilter = branchId ? { branchId } : {};
      const [allStaff, records, leaves] = await Promise.all([
        prisma.userSalon.findMany({
          where: { salonId: req.salonId, isArchived: false, ...staffBranchFilter, user: { isActive: true } },
          include: { user: true }
        }),
        prisma.attendanceRecord.findMany({
          where: { salonId: req.salonId, ...recordBranchFilter, attendanceDate: { gte: targetDate, lt: targetEnd } }
        }),
        prisma.leaveRequest.findMany({
          where: {
            salonId: req.salonId,
            status: "APPROVED",
            startDate: { lt: targetEnd },
            endDate: { gte: targetDate }
          }
        })
      ]);
      const leaveSet = new Set(leaves.map((row) => row.userSalonId));
      const recordMap = new Map(records.map((row) => [row.userSalonId, row]));
      const absentToday = allStaff.filter((row) => !leaveSet.has(row.id) && !recordMap.has(row.id)).length;
      res.json({
        totalStaff: allStaff.length,
        presentToday: records.filter((row) => ["PRESENT", "LATE", "HALF_DAY", "WORKING", "COMPLETED_SHIFT"].includes(row.status)).length,
        absentToday,
        lateStaff: records.filter((row) => row.status === "LATE").length,
        currentlyWorking: records.filter((row) => !row.checkOutAt && row.status !== "LEAVE").length,
        completedShift: records.filter((row) => Boolean(row.checkOutAt)).length,
        onLeave: leaveSet.size
      });
    } catch (err) {
      console.error("attendance summary error:", err);
      res.json({ totalStaff: 0, presentToday: 0, absentToday: 0, lateStaff: 0, currentlyWorking: 0, completedShift: 0, onLeave: 0 });
    }
  });
  ownerRouter.get("/attendance/day-sheet", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    try {
    const targetDate = startOfAttendanceDay(req.query.date || new Date());
    if (isNaN(targetDate.getTime())) return res.json({ date: new Date(), rows: [] });
    const targetEnd = endOfAttendanceDay(targetDate);
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const staffRows = await prisma.userSalon.findMany({
      where: {
        salonId: req.salonId,
        isArchived: false,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}),
        user: { isActive: true }
      },
      include: { user: true, branch: true },
      orderBy: { id: "asc" }
    });
    const attendanceRows = await prisma.attendanceRecord.findMany({
      where: {
        salonId: req.salonId,
        ...(branchId ? { branchId } : {}),
        attendanceDate: { gte: targetDate, lt: targetEnd }
      },
      include: { branch: true }
    });
    const leaveRows = await prisma.leaveRequest.findMany({
      where: {
        salonId: req.salonId,
        status: "APPROVED",
        startDate: { lt: targetEnd },
        endDate: { gte: targetDate }
      }
    });
    const attendanceMap = new Map(attendanceRows.map((row) => [row.userSalonId, row]));
    const leaveSet = new Set(leaveRows.map((row) => row.userSalonId));
    const rows = staffRows.map((staff) => {
      const attendanceRow = attendanceMap.get(staff.id) || null;
      if (attendanceRow) {
        return {
          type: "ATTENDANCE",
          userSalonId: staff.id,
          staffName: staff.user?.name || staff.id,
          branchName: attendanceRow.branch?.name || staff.branch?.name || "",
          status: attendanceRow.status,
          checkInAt: attendanceRow.checkInAt,
          checkOutAt: attendanceRow.checkOutAt,
          workedMinutes: attendanceRow.workedMinutes,
          attendanceId: attendanceRow.id
        };
      }
      if (leaveSet.has(staff.id)) {
        return {
          type: "LEAVE",
          userSalonId: staff.id,
          staffName: staff.user?.name || staff.id,
          branchName: staff.branch?.name || "",
          status: "LEAVE",
          checkInAt: null,
          checkOutAt: null,
          workedMinutes: null,
          attendanceId: null
        };
      }
      return {
        type: "ABSENT",
        userSalonId: staff.id,
        staffName: staff.user?.name || staff.id,
        branchName: staff.branch?.name || "",
        status: "ABSENT",
        checkInAt: null,
        checkOutAt: null,
        workedMinutes: null,
        attendanceId: null
      };
    });
    res.json({ date: targetDate, rows });
    } catch (err) {
      console.error("day-sheet error:", err);
      res.json({ date: new Date(), rows: [] });
    }
  });
  ownerRouter.get("/attendance/reports", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    try {
    const period = ["daily", "weekly", "monthly"].includes(String(req.query.period || "").toLowerCase())
      ? String(req.query.period).toLowerCase()
      : "daily";
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const refDate = req.query.date || new Date();
    if (isNaN(new Date(refDate).getTime())) return res.json({ period, rows: [], summary: {} });
    res.json(await buildAttendanceReportDataset({
      salonId: req.salonId,
      branchId,
      period,
      referenceDate: refDate
    }));
    } catch (err) {
      console.error("attendance/reports error:", err.message, err.stack);
      res.json({ period: req.query.period || "daily", rows: [], summary: {} });
    }
  });
  ownerRouter.get("/attendance/reports/export.xlsx", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    try {
    const period = ["daily", "weekly", "monthly"].includes(String(req.query.period || "").toLowerCase())
      ? String(req.query.period).toLowerCase()
      : "daily";
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const report = await buildAttendanceReportDataset({
      salonId: req.salonId,
      branchId,
      period,
      referenceDate: req.query.date || new Date()
    });
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Attendance Report");
    const exportRows = buildAttendanceExportRows(report.rows);
    worksheet.columns = Object.keys(exportRows[0] || {
      "SR. NO.": "",
      DATE: "",
      STAFF: "",
      "STAFF ID": "",
      BRANCH: "",
      STATUS: "",
      "CHECK-IN": "",
      "CHECK-OUT": "",
      "WORKING HOURS": "",
      "GEO STATUS": "",
      VERIFICATION: "",
      "GPS LOCATION": "",
      SELFIE: "",
      REMARK: "",
      NOTE: ""
    }).map((header) => ({ header, key: header, width: Math.max(14, header.length + 4) }));
    worksheet.addRows(exportRows);
    worksheet.insertRow(1, [`${report.label} Attendance Report`]);
    worksheet.insertRow(2, [`Range: ${formatDateLabel(report.start)} - ${formatDateLabel(addDays(report.end, -1))}`]);
    worksheet.insertRow(3, [`Total Staff: ${report.summary.totalStaff} | Present: ${report.summary.present} | Absent: ${report.summary.absent} | Leave: ${report.summary.leave}`]);
    worksheet.mergeCells("A1:D1");
    worksheet.mergeCells("A2:D2");
    worksheet.mergeCells("A3:F3");
    worksheet.getRow(4).font = { bold: true };
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-${period}-report.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
    } catch (err) {
      console.error("attendance export xlsx error:", err);
      res.status(500).json({ message: "Failed to generate Excel report" });
    }
  });
  ownerRouter.get("/attendance/reports/export.pdf", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    try {
    const period = ["daily", "weekly", "monthly"].includes(String(req.query.period || "").toLowerCase())
      ? String(req.query.period).toLowerCase()
      : "daily";
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const report = await buildAttendanceReportDataset({
      salonId: req.salonId,
      branchId,
      period,
      referenceDate: req.query.date || new Date()
    });
    const doc = new PDFDocument({ margin: 36, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="attendance-${period}-report.pdf"`);
    doc.pipe(res);
    doc.fontSize(16).text(`${report.label} Attendance Report`, { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(10).text(`Range: ${formatDateLabel(report.start)} - ${formatDateLabel(addDays(report.end, -1))}`);
    doc.text(`Total Staff: ${report.summary.totalStaff} | Present: ${report.summary.present} | Absent: ${report.summary.absent} | Leave: ${report.summary.leave}`);
    doc.text(`Late: ${report.summary.late} | Half Day: ${report.summary.halfDay} | Working: ${report.summary.working} | Completed Shift: ${report.summary.completedShift}`);
    doc.moveDown(0.8);
    const exportRows = buildAttendanceExportRows(report.rows);
    const colWidths = [25, 65, 85, 55, 50, 65, 40, 45, 40];
    const headers = ["#", "DATE", "STAFF", "STATUS", "CHECK-IN", "CHECK-OUT", "HOURS", "BRANCH", "GEO"];
    const tableTop = doc.y;
    const rowHeight = 18;
    const startX = 36;

    const drawTableRow = (y, cells, isHeader = false) => {
      let x = startX;
      doc.fontSize(isHeader ? 8 : 7).fillColor(isHeader ? "#334155" : "#1e293b");
      cells.forEach((cell, i) => {
        if (isHeader) {
          doc.rect(x, y, colWidths[i], rowHeight).fillAndStroke("#f1f5f9", "#cbd5e1");
          doc.fillColor("#334155");
        }
        doc.text(String(cell || "-").substring(0, 20), x + 3, y + 4, { width: colWidths[i] - 6, height: rowHeight - 6, lineBreak: false });
        x += colWidths[i];
      });
    };

    drawTableRow(tableTop, headers, true);
    let pageOffset = 0;
    let isFirstOnPage = true;
    exportRows.forEach((row) => {
      const y = tableTop + (pageOffset + 1) * rowHeight;
      if (y > 730) {
        doc.addPage();
        drawTableRow(36, headers, true);
        pageOffset = 0;
        isFirstOnPage = false;
      }
      const currentY = tableTop + (pageOffset + 1) * rowHeight;
      const bgColor = pageOffset % 2 === 0 ? "#ffffff" : "#f8fafc";
      let x = startX;
      colWidths.forEach((w) => { doc.rect(x, currentY, w, rowHeight).fill(bgColor); x += w; });
      drawTableRow(currentY, [row["SR. NO."], row.DATE, row.STAFF, row.STATUS, row["CHECK-IN"], row["CHECK-OUT"], row["WORKING HOURS"], row.BRANCH, row["GEO STATUS"]]);
      pageOffset++;
    });

    doc.end();
    } catch (err) {
      console.error("attendance export pdf error:", err);
      res.status(500).json({ message: "Failed to generate PDF report" });
    }
  });
  ownerRouter.get("/attendance/records/:id", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    const row = await prisma.attendanceRecord.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: {
        userSalon: { include: { user: true, branch: true } },
        branch: true,
        createdByMembership: { include: { user: true } },
        manualEditedByMembership: { include: { user: true } }
      }
    });
    if (!row) return res.status(404).json({ message: "Attendance record not found" });
    const auditLogs = await prisma.auditLog.findMany({
      where: { salonId: req.salonId, module: "ATTENDANCE", entityType: "AttendanceRecord", entityId: row.id },
      include: { actorMembership: { include: { user: true } } },
      orderBy: { createdAt: "desc" }
    });
    res.json({ ...row, auditLogs });
  });
  ownerRouter.post("/attendance", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "create"), validate(schemas.attendance), async (req, res) => {
    try {
    const settings = await getAttendanceSettings(req.salonId);
    const attendanceDate = startOfAttendanceDay(req.body.attendanceDate || req.body.checkInAt || new Date());
    const checkInAt = toDate(req.body.checkInAt) || new Date();
    const checkOutAt = toDate(req.body.checkOutAt);
    const workedMinutes = checkOutAt ? roundMinutesDiff(checkInAt, checkOutAt) : null;
    const status = req.body.status || resolveAttendanceStatus({ attendanceDate, checkInAt, checkOutAt, workedMinutes, settings });
    const created = await prisma.attendanceRecord.create({
      data: {
        salonId: req.salonId,
        branchId: req.body.branchId || null,
        userSalonId: req.body.userSalonId,
        createdByMembershipId: req.user.membershipId || null,
        attendanceDate,
        status,
        verificationMethod: req.body.verificationMethod || "MANUAL",
        geoStatus: req.body.geoStatus || "NOT_CAPTURED",
        checkInAt,
        checkOutAt,
        workedMinutes,
        note: req.body.note || null,
        adminRemark: req.body.adminRemark || null,
        checkInLatitude: req.body.checkInLatitude,
        checkInLongitude: req.body.checkInLongitude,
        checkInAccuracyMeters: req.body.checkInAccuracyMeters,
        checkInSelfieUrl: req.body.checkInSelfieUrl || null,
        checkOutLatitude: req.body.checkOutLatitude,
        checkOutLongitude: req.body.checkOutLongitude,
        checkOutAccuracyMeters: req.body.checkOutAccuracyMeters,
        checkOutSelfieUrl: req.body.checkOutSelfieUrl || null
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ATTENDANCE",
      action: "MANUAL_CREATE",
      entityType: "AttendanceRecord",
      entityId: created.id,
      summary: `Attendance manually created for ${created.userSalonId}`,
      metadata: {
        attendanceDate: created.attendanceDate,
        status: created.status,
        branchId: created.branchId,
        verificationMethod: created.verificationMethod
      }
    });
    res.status(201).json(created);
    } catch (err) {
      if (err?.code === "P2002") return res.status(409).json({ message: "An attendance record already exists for this staff member on this date." });
      console.error("manual attendance create error:", err);
      res.status(500).json({ message: "Could not create attendance record" });
    }
  });
  ownerRouter.post("/attendance/check-in", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "create"), validate(schemas.attendance), async (req, res) => {
    try {
      res.status(201).json(await prisma.attendanceRecord.create({
        data: {
          salonId: req.salonId,
          branchId: req.body.branchId || null,
          userSalonId: req.body.userSalonId,
          createdByMembershipId: req.user.membershipId || null,
          attendanceDate: startOfAttendanceDay(new Date()),
          status: "WORKING",
          checkInAt: new Date(),
          note: req.body.note || null
        }
      }));
    } catch (e) {
      if (e.code === "P2002") return res.status(409).json({ message: "Attendance already marked for this staff member today." });
      throw e;
    }
  });
  const requireSelfAttendancePermission = (action) => (req, res, next) => {
    if (req.user.systemRole === "SUPER_ADMIN" || req.user.systemRole === "SALON_OWNER" || req.user.salonRole === "SALON_OWNER") return next();
    const perms = req.user.permissions || {};
    if (perms["attendance"]?.includes(action) || perms["myAttendance"]?.includes(action)) return next();
    return res.status(403).json({ message: `No permission: attendance.${action}` });
  };

  ownerRouter.post("/attendance/check-in-self", requireFeatureEnabled("attendance"), requireSelfAttendancePermission("create"), validate(schemas.attendanceSelfAction), async (req, res) => {
    try {
      const membership = await prisma.userSalon.findFirst({
        where: { id: req.user.membershipId, salonId: req.salonId, isArchived: false },
        include: { branch: true }
      });
      if (!membership) return res.status(404).json({ message: "Staff profile not found" });
      if (!membership.attendanceEnabled) {
        return res.status(400).json({ message: "Attendance biometric is not configured by the salon owner yet." });
      }
      if (!req.body.selfieUrl) return res.status(400).json({ message: "Camera permission is required." });

      // Server-side face verification
      if (req.body.selfieUrl && membership.attendanceEnrollmentPhotoUrl) {
        try {
          const { verifySelfie } = await import("../../../lib/faceVerification.js");
          const faceResult = await verifySelfie({
            selfieUrl: req.body.selfieUrl,
            enrollmentPhotoUrl: membership.attendanceEnrollmentPhotoUrl
          });
          if (!faceResult.valid) {
            return res.status(400).json({ message: faceResult.error || "Face verification failed." });
          }
        } catch (faceErr) {
          console.error("[attendance] Face verification error:", faceErr.message);
          // Don't block check-in if face verification service is unavailable
        }
      }
      if (!membership.branchId || !membership.branch) {
        const fallbackBranch = await prisma.branch.findFirst({
          where: { salonId: req.salonId, isActive: true },
          orderBy: { createdAt: "asc" }
        });
        if (fallbackBranch) {
          await prisma.userSalon.update({ where: { id: membership.id }, data: { branchId: fallbackBranch.id } });
          membership.branchId = fallbackBranch.id;
          membership.branch = fallbackBranch;
        } else {
          return res.status(400).json({ message: "No active branch found. Please create a branch first." });
        }
      }
      const existing = await prisma.attendanceRecord.findFirst({
        where: {
          salonId: req.salonId,
          userSalonId: membership.id,
          attendanceDate: { gte: startOfAttendanceDay(new Date()), lt: endOfAttendanceDay(new Date()) }
        }
      });
      if (existing) return res.status(409).json({ message: "Attendance has already been marked today." });
      const { distance, geoStatus } = validateGeofence({
        branch: membership.branch,
        latitude: req.body.latitude,
        longitude: req.body.longitude
      });
      if (geoStatus === "OUTSIDE") return res.status(400).json({ message: "You are outside the salon premises." });
      const now = new Date();
      const created = await prisma.attendanceRecord.create({
        data: {
          salonId: req.salonId,
          branchId: membership.branchId,
          userSalonId: membership.id,
          createdByMembershipId: membership.id,
          attendanceDate: startOfAttendanceDay(now),
          status: "WORKING",
          verificationMethod: req.body.selfieUrl ? "SELFIE_GPS" : "GPS_ONLY",
          geoStatus,
          checkInAt: now,
          checkInLatitude: req.body.latitude,
          checkInLongitude: req.body.longitude,
          checkInAccuracyMeters: req.body.accuracyMeters,
          checkInSelfieUrl: req.body.selfieUrl || null,
          note: req.body.note || null,
          adminRemark: `Check-in distance ${Math.round(distance)}m`
        },
        include: { branch: true, userSalon: { include: { user: true } } }
      });
      createAuditLog({
        salonId: req.salonId,
        actorUserId: req.user.userId,
        actorMembershipId: membership.id,
        module: "ATTENDANCE",
        action: "CHECK_IN",
        entityType: "AttendanceRecord",
        entityId: created.id,
        summary: `Self check-in by ${membership.user?.name || "staff"}`,
        metadata: { verificationMethod: created.verificationMethod, geoStatus, distance: Math.round(distance) }
      }).catch(() => {});
      res.status(201).json(created);
    } catch (e) {
      if (e.code === "P2002") return res.status(409).json({ message: "Attendance already marked for today." });
      if (e.status && e.message) return res.status(e.status).json({ message: e.message });
      console.error("self check-in error:", e);
      res.status(500).json({ message: "Failed to record attendance" });
    }
  });
  ownerRouter.post("/attendance/check-out", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "edit"), validate(schemas.attendance), async (req, res) => {
    try {
      const today = startOfAttendanceDay(new Date());
      const tomorrow = endOfAttendanceDay(new Date());
      const row = await prisma.attendanceRecord.findFirst({
        where: { salonId: req.salonId, userSalonId: req.body.userSalonId, checkOutAt: null, attendanceDate: { gte: today, lt: tomorrow } },
        orderBy: { checkInAt: "desc" }
      });
      if (!row || row.checkOutAt) return res.status(404).json({ message: "Open attendance record not found" });
      const checkOutAt = new Date();
      if (new Date(checkOutAt) <= new Date(row.checkInAt)) return res.status(400).json({ message: "Check-out time cannot be before check-in time." });
      const workedMinutes = roundMinutesDiff(row.checkInAt, checkOutAt);
      const settings = await getAttendanceSettings(req.salonId);
      const overtimeThreshold = Number(settings.overtimeThresholdMinutes || DEFAULT_ATTENDANCE_SETTINGS.overtimeThresholdMinutes);
      const overtimeMinutes = settings.overtimeEnabled && workedMinutes > overtimeThreshold ? workedMinutes - overtimeThreshold : 0;
      const status = resolveAttendanceStatus({ attendanceDate: row.attendanceDate, checkInAt: row.checkInAt, checkOutAt, workedMinutes, settings });
      res.json(await prisma.attendanceRecord.update({ where: { id: row.id }, data: { checkOutAt, workedMinutes, overtimeMinutes, status, note: req.body.note || row.note } }));
    } catch (err) {
      console.error("admin check-out error:", err);
      res.status(500).json({ message: "Failed to complete check-out" });
    }
  });
  ownerRouter.post("/attendance/check-out-self", requireFeatureEnabled("attendance"), requireSelfAttendancePermission("edit"), validate(schemas.attendanceSelfAction), async (req, res) => {
    try {
      const [membership, settings] = await Promise.all([
        prisma.userSalon.findFirst({
          where: { id: req.user.membershipId, salonId: req.salonId, isArchived: false },
          include: { branch: true }
        }),
        getAttendanceSettings(req.salonId)
      ]);
      if (!membership) return res.status(404).json({ message: "Staff profile not found" });
      if (!membership.attendanceEnabled) {
        return res.status(400).json({ message: "Attendance biometric is not configured by the salon owner yet." });
      }
      if (!membership.branchId || !membership.branch) {
        const fallbackBranch = await prisma.branch.findFirst({
          where: { salonId: req.salonId, isActive: true },
          orderBy: { createdAt: "asc" }
        });
        if (fallbackBranch) {
          await prisma.userSalon.update({ where: { id: membership.id }, data: { branchId: fallbackBranch.id } });
          membership.branchId = fallbackBranch.id;
          membership.branch = fallbackBranch;
        } else {
          return res.status(400).json({ message: "No active branch found. Please create a branch first." });
        }
      }
      if (settings.checkoutSelfieRequired && !req.body.selfieUrl) return res.status(400).json({ message: "Camera selfie is required." });

      // Server-side face verification for checkout selfie
      if (req.body.selfieUrl && membership.attendanceEnrollmentPhotoUrl && settings.checkoutSelfieRequired) {
        try {
          const { verifySelfie } = await import("../../../lib/faceVerification.js");
          const faceResult = await verifySelfie({
            selfieUrl: req.body.selfieUrl,
            enrollmentPhotoUrl: membership.attendanceEnrollmentPhotoUrl
          });
          if (!faceResult.valid) {
            return res.status(400).json({ message: faceResult.error || "Face verification failed." });
          }
        } catch (faceErr) {
          console.error("[attendance] Checkout face verification error:", faceErr.message);
        }
      }
      const today = startOfAttendanceDay(new Date());
      const tomorrow = endOfAttendanceDay(new Date());
      const row = await prisma.attendanceRecord.findFirst({
        where: { salonId: req.salonId, userSalonId: membership.id, checkOutAt: null, attendanceDate: { gte: today, lt: tomorrow } },
        orderBy: { checkInAt: "desc" }
      });
      if (!row) return res.status(404).json({ message: "Open attendance record not found" });
      const { distance, geoStatus } = validateGeofence({
        branch: membership.branch,
        latitude: req.body.latitude,
        longitude: req.body.longitude
      });
      if (geoStatus === "OUTSIDE") return res.status(400).json({ message: "You are outside the salon premises." });
      const checkOutAt = new Date();
      if (new Date(checkOutAt) <= new Date(row.checkInAt)) return res.status(400).json({ message: "Check-out time cannot be before check-in time." });
      const workedMinutes = roundMinutesDiff(row.checkInAt, checkOutAt);
      const overtimeThreshold = Number(settings.overtimeThresholdMinutes || DEFAULT_ATTENDANCE_SETTINGS.overtimeThresholdMinutes);
      const overtimeMinutes = settings.overtimeEnabled && workedMinutes > overtimeThreshold ? workedMinutes - overtimeThreshold : 0;
      const status = resolveAttendanceStatus({ attendanceDate: row.attendanceDate, checkInAt: row.checkInAt, checkOutAt, workedMinutes, settings });
      const updated = await prisma.attendanceRecord.update({
        where: { id: row.id },
        data: {
          checkOutAt,
          workedMinutes,
          overtimeMinutes,
          status,
          geoStatus,
          checkOutLatitude: req.body.latitude,
          checkOutLongitude: req.body.longitude,
          checkOutAccuracyMeters: req.body.accuracyMeters,
          checkOutSelfieUrl: req.body.selfieUrl || null,
          note: req.body.note || row.note,
          adminRemark: row.adminRemark ? `${row.adminRemark} | Check-out distance ${Math.round(distance)}m` : `Check-out distance ${Math.round(distance)}m`
        }
      });
      createAuditLog({
        salonId: req.salonId,
        actorUserId: req.user.userId,
        actorMembershipId: membership.id,
        module: "ATTENDANCE",
        action: "CHECK_OUT",
        entityType: "AttendanceRecord",
        entityId: updated.id,
        summary: `Self check-out by ${membership.user?.name || "staff"}`,
        metadata: { status, workedMinutes, distance: Math.round(distance) }
      }).catch(() => {});
      res.json(updated);
    } catch (err) {
      if (err.status && err.message) return res.status(err.status).json({ message: err.message });
      console.error("self check-out error:", err);
      res.status(500).json({ message: "Failed to complete check-out" });
    }
  });
  ownerRouter.get("/my-attendance", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    res.json(await prisma.attendanceRecord.findMany({
      where: { salonId: req.salonId, userSalonId: req.user.membershipId },
      include: { branch: true },
      orderBy: [{ attendanceDate: "desc" }, { checkInAt: "desc" }]
    }));
  });
  ownerRouter.patch("/attendance/:id/manual-update", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "edit"), validate(schemas.attendanceManualUpdate), async (req, res) => {
    const settings = await getAttendanceSettings(req.salonId);
    if (!settings.allowManualAttendanceEdits) return res.status(403).json({ message: "Manual attendance edits are disabled." });
    const row = await prisma.attendanceRecord.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Attendance record not found" });
    const nextCheckInAt = req.body.checkInAt !== undefined ? toDate(req.body.checkInAt) : row.checkInAt;
    const nextCheckOutAt = req.body.checkOutAt !== undefined ? toDate(req.body.checkOutAt) : row.checkOutAt;
    const nextAttendanceDate = req.body.attendanceDate ? startOfAttendanceDay(req.body.attendanceDate) : row.attendanceDate;
    const workedMinutes = nextCheckOutAt ? roundMinutesDiff(nextCheckInAt, nextCheckOutAt) : null;
    const status = req.body.status || resolveAttendanceStatus({
      attendanceDate: nextAttendanceDate,
      checkInAt: nextCheckInAt,
      checkOutAt: nextCheckOutAt,
      workedMinutes,
      settings
    });
    const updated = await prisma.attendanceRecord.update({
      where: { id: row.id },
      data: {
        attendanceDate: nextAttendanceDate,
        checkInAt: nextCheckInAt,
        checkOutAt: nextCheckOutAt,
        workedMinutes,
        status,
        note: req.body.note ?? row.note,
        adminRemark: req.body.adminRemark ?? row.adminRemark,
        manualEdited: true,
        manualEditedAt: new Date(),
        manualEditedByMembershipId: req.user.membershipId || null,
        verificationMethod: "MANUAL"
      }
    });
    const staffProfile = await prisma.userSalon.findFirst({
      where: { id: updated.userSalonId },
      include: { user: true }
    });
    const staffName = staffProfile?.user?.name || "Unknown";
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "ATTENDANCE",
      action: "MANUAL_UPDATE",
      entityType: "AttendanceRecord",
      entityId: updated.id,
      summary: `Attendance manually updated for ${staffName}`,
      metadata: {
        reason: req.body.reason,
        previousValue: {
          attendanceDate: row.attendanceDate,
          checkInAt: row.checkInAt,
          checkOutAt: row.checkOutAt,
          workedMinutes: row.workedMinutes,
          status: row.status,
          note: row.note,
          adminRemark: row.adminRemark
        },
        updatedValue: {
          attendanceDate: updated.attendanceDate,
          checkInAt: updated.checkInAt,
          checkOutAt: updated.checkOutAt,
          workedMinutes: updated.workedMinutes,
          status: updated.status,
          note: updated.note,
          adminRemark: updated.adminRemark
        }
      }
    });
    res.json(updated);
  });
  ownerRouter.get("/attendance/:staffId", requireFeatureEnabled("attendance"), requireSalonPermission("attendance", "view"), async (req, res) => {
    res.json(await prisma.attendanceRecord.findMany({
      where: { salonId: req.salonId, userSalonId: req.params.staffId },
      include: { branch: true },
      orderBy: [{ attendanceDate: "desc" }, { checkInAt: "desc" }]
    }));
  });

  ownerRouter.get("/leaves", requireFeatureEnabled("leaves"), requireSalonPermission("leaves", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const branchId = req.query.branchId ? String(req.query.branchId) : null;
    const userSalonFilter = branchId && q
      ? { userSalon: { is: { OR: [{ branchId }, { branchId: null }], user: { is: { name: { contains: q, mode: "insensitive" } } } } } }
      : branchId
        ? { userSalon: { is: { OR: [{ branchId }, { branchId: null }] } } }
        : q
          ? { userSalon: { is: { user: { is: { name: { contains: q, mode: "insensitive" } } } } } }
          : {};
    res.json(await prisma.leaveRequest.findMany({
      where: {
        salonId: req.salonId,
        ...(status ? { status } : {}),
        ...userSalonFilter
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
    const updated = await prisma.leaveRequest.update({ where: { id: row.id }, data: { status: "APPROVED", note: req.body.note || row.note, approvedByMembershipId: req.user.membershipId || null } });
    try {
      const startDate = new Date(row.startDate);
      const endDate = new Date(row.endDate);
      const days = [];
      const cursor = new Date(startDate);
      while (cursor <= endDate) {
        days.push(startOfAttendanceDay(cursor));
        cursor.setDate(cursor.getDate() + 1);
      }
      const userSalon = await prisma.userSalon.findFirst({ where: { id: row.userSalonId }, select: { branchId: true } });
    for (const day of days) {
        const existing = await prisma.attendanceRecord.findFirst({
          where: { salonId: row.salonId, userSalonId: row.userSalonId, attendanceDate: day }
        });
        if (existing) {
          if (existing.status !== "LEAVE") {
            await prisma.attendanceRecord.update({ where: { id: existing.id }, data: { status: "LEAVE", note: `Leave approved: ${row.reason || "N/A"}` } });
          }
        } else {
          await prisma.attendanceRecord.create({
            data: {
              salonId: row.salonId,
              userSalonId: row.userSalonId,
              branchId: userSalon?.branchId || null,
              createdByMembershipId: req.user.membershipId || null,
              attendanceDate: day,
              status: "LEAVE",
              verificationMethod: "MANUAL",
              checkInAt: day,
              note: `Auto-created: Leave approved (${row.reason || "N/A"})`
            }
          });
        }
      }
    } catch (err) {
      console.error("leave approval attendance error:", err);
    }
    res.json(updated);
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
        membershipSales: invoices.filter(i => i.itemType === "MEMBERSHIP").map(i => ({ price: Number(i.lineTotal || 0) })),
        packageSales: invoices.filter(i => i.itemType === "PACKAGE").map(i => ({ price: Number(i.lineTotal || 0) })),
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
  ownerRouter.get("/notifications/unread-count", requireFeatureEnabled("notifications"), requireSalonPermission("notifications", "view"), async (req, res) => {
    const count = await prisma.notification.count({
      where: {
        salonId: req.salonId,
        isRead: false,
        OR: [{ userSalonId: null }, { userSalonId: req.user.membershipId || "" }]
      }
    });
    res.json({ count });
  });
  ownerRouter.get("/notifications/stream", requireFeatureEnabled("notifications"), requireSalonPermission("notifications", "view"), async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const salonId = req.salonId;
    const membershipId = req.user.membershipId || null;

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sendEvent({ type: "connected", timestamp: new Date().toISOString() });

    const intervalId = setInterval(async () => {
      try {
        const count = await prisma.notification.count({
          where: {
            salonId,
            isRead: false,
            OR: [{ userSalonId: null }, { userSalonId: membershipId || "" }]
          }
        });
        sendEvent({ type: "unread_count", count });
      } catch {
        sendEvent({ type: "error", message: "Failed to fetch unread count" });
      }
    }, 15000);

    req.on("close", () => {
      clearInterval(intervalId);
    });
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
