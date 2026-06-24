import { prisma } from "../../../lib/prisma.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { toAmount } from "../../../lib/phase2.js";

const cuid = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const ensureArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
};

export const registerSettingsModelRoutes = (ownerRouter) => {
  // ============ SHIFT MANAGEMENT ============
  ownerRouter.get("/shifts", requireFeatureEnabled("inventory"), async (req, res) => {
    const shifts = await prisma.shift.findMany({
      where: { salonId: req.salonId },
      include: { days: true, breaks: true },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
    });
    res.json(shifts);
  });

  ownerRouter.post("/shifts", requireFeatureEnabled("inventory"), async (req, res) => {
    const { name, active = true, sameForAllDays = true, startTime, endTime, breakLabel, sortOrder = 0, days = [], breaks = [] } = req.body;
    if (!name) return res.status(400).json({ message: "name is required" });
    const shift = await prisma.shift.create({
      data: {
        salonId: req.salonId,
        name,
        active,
        sameForAllDays,
        startTime: sameForAllDays ? startTime : null,
        endTime: sameForAllDays ? endTime : null,
        breakLabel,
        sortOrder,
        days: sameForAllDays
          ? { create: ensureArray(days).map((d) => ({ dayOfWeek: Number(d.dayOfWeek), active: d.active !== false, startTime: d.startTime || startTime, endTime: d.endTime || endTime })) }
          : [],
        breaks: { create: ensureArray(breaks).map((b) => ({ name: b.name || "Break", active: b.active !== false, fromTime: b.fromTime, toTime: b.toTime })) }
      },
      include: { days: true, breaks: true }
    });
    res.status(201).json(shift);
  });

  ownerRouter.patch("/shifts/:id", requireFeatureEnabled("inventory"), async (req, res) => {
    const shift = await prisma.shift.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!shift) return res.status(404).json({ message: "Shift not found" });
    const { name, active, sameForAllDays, startTime, endTime, breakLabel, sortOrder, days, breaks } = req.body;
    const updated = await prisma.$transaction(async (tx) => {
      if (days !== undefined) {
        await tx.shiftDay.deleteMany({ where: { shiftId: shift.id } });
        if (sameForAllDays) {
          await tx.shiftDay.createMany({
            data: ensureArray(days).map((d) => ({
              shiftId: shift.id,
              dayOfWeek: Number(d.dayOfWeek),
              active: d.active !== false,
              startTime: d.startTime || startTime,
              endTime: d.endTime || endTime
            }))
          });
        }
      }
      if (breaks !== undefined) {
        await tx.shiftBreak.deleteMany({ where: { shiftId: shift.id } });
        await tx.shiftBreak.createMany({
          data: ensureArray(breaks).map((b) => ({
            shiftId: shift.id,
            name: b.name || "Break",
            active: b.active !== false,
            fromTime: b.fromTime,
            toTime: b.toTime
          }))
        });
      }
      return tx.shift.update({
        where: { id: shift.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(active !== undefined ? { active } : {}),
          ...(sameForAllDays !== undefined ? { sameForAllDays } : {}),
          ...(startTime !== undefined ? { startTime: sameForAllDays ? startTime : null } : {}),
          ...(endTime !== undefined ? { endTime: sameForAllDays ? endTime : null } : {}),
          ...(breakLabel !== undefined ? { breakLabel } : {}),
          ...(sortOrder !== undefined ? { sortOrder } : {})
        },
        include: { days: true, breaks: true }
      });
    });
    res.json(updated);
  });

  ownerRouter.delete("/shifts/:id", requireFeatureEnabled("inventory"), async (req, res) => {
    const shift = await prisma.shift.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!shift) return res.status(404).json({ message: "Shift not found" });
    await prisma.shift.delete({ where: { id: shift.id } });
    res.json({ success: true });
  });

  // ============ TAX RATES ============
  ownerRouter.get("/tax-rates", requireSalonPermission("settings", "view"), async (req, res) => {
    const rates = await prisma.taxRate.findMany({
      where: { salonId: req.salonId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
    });
    res.json(rates);
  });

  ownerRouter.post("/tax-rates", requireSalonPermission("settings", "edit"), async (req, res) => {
    if (!req.body?.label || req.body?.rate === undefined) {
      return res.status(400).json({ message: "label and rate are required" });
    }
    const code = String(req.body.code || req.body.label.toUpperCase().replace(/\s+/g, "").slice(0, 8));
    const taxRate = await prisma.taxRate.create({
      data: {
        salonId: req.salonId,
        label: String(req.body.label),
        code,
        rate: Number(req.body.rate),
        active: req.body.active !== false,
        applicableFor: Array.isArray(req.body.applicableFor) ? req.body.applicableFor.join(",") : "SERVICE,PRODUCT,MEMBERSHIP,PACKAGE",
        sortOrder: Number(req.body.sortOrder || 0)
      }
    });
    res.status(201).json(taxRate);
  });

  ownerRouter.patch("/tax-rates/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const taxRate = await prisma.taxRate.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!taxRate) return res.status(404).json({ message: "Tax rate not found" });
    const updated = await prisma.taxRate.update({
      where: { id: taxRate.id },
      data: {
        ...(req.body.label !== undefined ? { label: String(req.body.label) } : {}),
        ...(req.body.code !== undefined ? { code: String(req.body.code) } : {}),
        ...(req.body.rate !== undefined ? { rate: Number(req.body.rate) } : {}),
        ...(req.body.active !== undefined ? { active: Boolean(req.body.active) } : {}),
        ...(Array.isArray(req.body.applicableFor) ? { applicableFor: req.body.applicableFor.join(",") } : {}),
        ...(req.body.sortOrder !== undefined ? { sortOrder: Number(req.body.sortOrder) } : {})
      }
    });
    res.json(updated);
  });

  ownerRouter.delete("/tax-rates/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const taxRate = await prisma.taxRate.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!taxRate) return res.status(404).json({ message: "Tax rate not found" });
    await prisma.taxRate.delete({ where: { id: taxRate.id } });
    res.json({ success: true });
  });

  // ============ FEEDBACK TYPES ============
  ownerRouter.get("/feedback-types", requireSalonPermission("settings", "view"), async (req, res) => {
    const types = await prisma.feedbackType.findMany({
      where: { salonId: req.salonId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
    });
    res.json(types);
  });

  ownerRouter.post("/feedback-types", requireSalonPermission("settings", "edit"), async (req, res) => {
    if (!req.body?.name) return res.status(400).json({ message: "name is required" });
    const slug = String(req.body.slug || req.body.name.toLowerCase().replace(/\s+/g, "-").slice(0, 32));
    const type = await prisma.feedbackType.create({
      data: {
        salonId: req.salonId,
        name: String(req.body.name),
        slug,
        active: req.body.active !== false,
        sortOrder: Number(req.body.sortOrder || 0)
      }
    });
    res.status(201).json(type);
  });

  ownerRouter.patch("/feedback-types/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const type = await prisma.feedbackType.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!type) return res.status(404).json({ message: "Feedback type not found" });
    const updated = await prisma.feedbackType.update({
      where: { id: type.id },
      data: {
        ...(req.body.name !== undefined ? { name: String(req.body.name) } : {}),
        ...(req.body.slug !== undefined ? { slug: String(req.body.slug) } : {}),
        ...(req.body.active !== undefined ? { active: Boolean(req.body.active) } : {}),
        ...(req.body.sortOrder !== undefined ? { sortOrder: Number(req.body.sortOrder) } : {})
      }
    });
    res.json(updated);
  });

  ownerRouter.delete("/feedback-types/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const type = await prisma.feedbackType.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!type) return res.status(404).json({ message: "Feedback type not found" });
    await prisma.feedbackType.delete({ where: { id: type.id } });
    res.json({ success: true });
  });

  // ============ DESIGNATIONS ============
  ownerRouter.get("/designations", requireSalonPermission("settings", "view"), async (req, res) => {
    const designations = await prisma.designation.findMany({
      where: { salonId: req.salonId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }]
    });
    res.json(designations);
  });

  ownerRouter.post("/designations", requireSalonPermission("settings", "edit"), async (req, res) => {
    if (!req.body?.name) return res.status(400).json({ message: "name is required" });
    const designation = await prisma.designation.create({
      data: {
        salonId: req.salonId,
        name: String(req.body.name),
        description: req.body.description || null,
        active: req.body.active !== false,
        sortOrder: Number(req.body.sortOrder || 0)
      }
    });
    res.status(201).json(designation);
  });

  ownerRouter.patch("/designations/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const designation = await prisma.designation.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!designation) return res.status(404).json({ message: "Designation not found" });
    const updated = await prisma.designation.update({
      where: { id: designation.id },
      data: {
        ...(req.body.name !== undefined ? { name: String(req.body.name) } : {}),
        ...(req.body.description !== undefined ? { description: req.body.description } : {}),
        ...(req.body.active !== undefined ? { active: Boolean(req.body.active) } : {}),
        ...(req.body.sortOrder !== undefined ? { sortOrder: Number(req.body.sortOrder) } : {})
      }
    });
    res.json(updated);
  });

  ownerRouter.delete("/designations/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const designation = await prisma.designation.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!designation) return res.status(404).json({ message: "Designation not found" });
    await prisma.designation.delete({ where: { id: designation.id } });
    res.json({ success: true });
  });

  // ============ REFERRAL RULES ============
  ownerRouter.get("/referrals/rule", requireSalonPermission("settings", "view"), async (req, res) => {
    const rule = await prisma.referralRule.findUnique({ where: { salonId: req.salonId } });
    res.json(rule || {
      enabled: false,
      maxReferLimit: 1000,
      referrerMaxBenefitAmount: 500,
      referrerFixedAmount: 0,
      referrerPercentage: 10,
      referredMaxBenefitAmount: 500,
      referredFixedAmount: 0,
      referredPercentage: 10
    });
  });

  ownerRouter.post("/referrals/rule", requireSalonPermission("settings", "edit"), async (req, res) => {
    const data = {
      enabled: Boolean(req.body.enabled),
      maxReferLimit: Number(req.body.maxReferLimit || 1000),
      referrerMaxBenefitAmount: toAmount(req.body.referrerMaxBenefitAmount),
      referrerFixedAmount: toAmount(req.body.referrerFixedAmount),
      referrerPercentage: toAmount(req.body.referrerPercentage),
      referredMaxBenefitAmount: toAmount(req.body.referredMaxBenefitAmount),
      referredFixedAmount: toAmount(req.body.referredFixedAmount),
      referredPercentage: toAmount(req.body.referredPercentage),
      notes: req.body.notes || null
    };
    const rule = await prisma.referralRule.upsert({
      where: { salonId: req.salonId },
      create: { salonId: req.salonId, ...data },
      update: data
    });
    res.json(rule);
  });

  // ============ REFERRAL CODES ============
  ownerRouter.get("/referrals/codes", requireSalonPermission("customers", "view"), async (req, res) => {
    const codes = await prisma.referralCode.findMany({
      where: { salonId: req.salonId },
      include: { customer: true, referee: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(codes);
  });

  ownerRouter.post("/referrals/codes", requireSalonPermission("customers", "edit"), async (req, res) => {
    if (!req.body?.customerId || !req.body?.code) {
      return res.status(400).json({ message: "customerId and code are required" });
    }
    const code = await prisma.referralCode.create({
      data: {
        salonId: req.salonId,
        customerId: String(req.body.customerId),
        code: String(req.body.code).toUpperCase(),
        status: "ACTIVE"
      }
    });
    res.status(201).json(code);
  });

  // ============ TAX SLABS (PNL Income Taxes) ============
  ownerRouter.get("/tax-slabs", requireSalonPermission("settings", "view"), async (req, res) => {
    const slabs = await prisma.taxSlab.findMany({
      where: { salonId: req.salonId },
      orderBy: [{ sortOrder: "asc" }, { slabFrom: "asc" }]
    });
    res.json(slabs);
  });

  ownerRouter.post("/tax-slabs", requireSalonPermission("settings", "edit"), async (req, res) => {
    if (req.body?.slabFrom === undefined || req.body?.slabTo === undefined || req.body?.rate === undefined) {
      return res.status(400).json({ message: "slabFrom, slabTo, and rate are required" });
    }
    const slab = await prisma.taxSlab.create({
      data: {
        salonId: req.salonId,
        name: req.body.name || `Slab ${req.body.slabFrom}-${req.body.slabTo}`,
        slabFrom: toAmount(req.body.slabFrom),
        slabTo: toAmount(req.body.slabTo),
        rate: toAmount(req.body.rate),
        active: req.body.active !== false,
        sortOrder: Number(req.body.sortOrder || 0)
      }
    });
    res.status(201).json(slab);
  });

  ownerRouter.patch("/tax-slabs/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const slab = await prisma.taxSlab.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!slab) return res.status(404).json({ message: "Tax slab not found" });
    const updated = await prisma.taxSlab.update({
      where: { id: slab.id },
      data: {
        ...(req.body.name !== undefined ? { name: req.body.name } : {}),
        ...(req.body.slabFrom !== undefined ? { slabFrom: toAmount(req.body.slabFrom) } : {}),
        ...(req.body.slabTo !== undefined ? { slabTo: toAmount(req.body.slabTo) } : {}),
        ...(req.body.rate !== undefined ? { rate: toAmount(req.body.rate) } : {}),
        ...(req.body.active !== undefined ? { active: Boolean(req.body.active) } : {}),
        ...(req.body.sortOrder !== undefined ? { sortOrder: Number(req.body.sortOrder) } : {})
      }
    });
    res.json(updated);
  });

  ownerRouter.delete("/tax-slabs/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const slab = await prisma.taxSlab.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!slab) return res.status(404).json({ message: "Tax slab not found" });
    await prisma.taxSlab.delete({ where: { id: slab.id } });
    res.json({ success: true });
  });

  // ============ PNL CATEGORIES ============
  ownerRouter.get("/pnl-categories", requireSalonPermission("settings", "view"), async (req, res) => {
    const categories = await prisma.pnlCategory.findMany({
      where: { salonId: req.salonId },
      orderBy: [{ sequenceNumber: "asc" }, { createdAt: "asc" }]
    });
    res.json(categories);
  });

  ownerRouter.post("/pnl-categories", requireSalonPermission("settings", "edit"), async (req, res) => {
    if (!req.body?.name) return res.status(400).json({ message: "name is required" });
    const category = await prisma.pnlCategory.create({
      data: {
        salonId: req.salonId,
        name: String(req.body.name),
        type: req.body.type === "EXPENSE" ? "EXPENSE" : "INCOME",
        sequenceNumber: Number(req.body.sequenceNumber || 0),
        active: req.body.active !== false
      }
    });
    res.status(201).json(category);
  });

  ownerRouter.patch("/pnl-categories/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const category = await prisma.pnlCategory.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!category) return res.status(404).json({ message: "Category not found" });
    const updated = await prisma.pnlCategory.update({
      where: { id: category.id },
      data: {
        ...(req.body.name !== undefined ? { name: String(req.body.name) } : {}),
        ...(req.body.type !== undefined ? { type: req.body.type === "EXPENSE" ? "EXPENSE" : "INCOME" } : {}),
        ...(req.body.sequenceNumber !== undefined ? { sequenceNumber: Number(req.body.sequenceNumber) } : {}),
        ...(req.body.active !== undefined ? { active: Boolean(req.body.active) } : {})
      }
    });
    res.json(updated);
  });

  ownerRouter.delete("/pnl-categories/:id", requireSalonPermission("settings", "edit"), async (req, res) => {
    const category = await prisma.pnlCategory.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!category) return res.status(404).json({ message: "Category not found" });
    await prisma.pnlCategory.delete({ where: { id: category.id } });
    res.json({ success: true });
  });
};
