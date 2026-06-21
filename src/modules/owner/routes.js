import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { attachBranchStock, buildCsv } from "../../lib/phase2.js";
import { createAuditLog } from "../../lib/phase4.js";
import { patchRouterForAsync } from "../../lib/async-handler.js";
import { requireAuth, requireMaintenanceAccess, requireSalonContext, requireSalonPermission } from "../../middlewares/rbac.js";
import { schemas, validate } from "../../middlewares/validate.js";
import multer from "multer";

import { registerPhase2OwnerRoutes } from "./phase2/index.js";
import { registerPhase3OwnerRoutes } from "./phase3/index.js";
import { registerPhase4OwnerRoutes } from "./phase4/index.js";
import { getCampaignAudience } from "../../lib/phase3.js";

export const ownerRouter = Router();
patchRouterForAsync(ownerRouter);
ownerRouter.use(requireAuth, requireMaintenanceAccess, requireSalonContext);

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

const findScoped = (model, salonId, id) => prisma[model].findFirst({ where: { id, salonId } });
const toAmount = (value) => Number(value || 0);
const normalizeBranchId = (value) => (value ? String(value) : null);
const withBranchFilter = (salonId, branchId) => ({ salonId, ...(branchId ? { branchId } : {}) });
const paymentWhere = (salonId, branchId) => ({ salonId, ...(branchId ? { invoice: { is: { branchId } } } : {}) });

const getActivePlanForSalon = async (salonId) => {
  const subscription = await prisma.subscription.findFirst({
    where: { salonId, status: { in: ["ACTIVE", "TRIAL"] } },
    include: { plan: true },
    orderBy: { endsAt: "desc" }
  });
  return subscription?.plan || null;
};

const ensureBranch = async (salonId, branchId) => {
  if (!branchId) return null;
  const branch = await prisma.branch.findFirst({ where: { id: branchId, salonId, isActive: true } });
  if (!branch) {
    const error = new Error("Active branch not found");
    error.status = 400;
    throw error;
  }
  return branch;
};

const normalizeDateValue = (value) => (value ? new Date(value) : null);
const sanitizeTagList = (value) => Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
const buildCustomerData = (payload, salonId) => ({
  name: payload.name,
  phone: payload.phone,
  email: payload.email || null,
  gender: payload.gender || null,
  dateOfBirth: normalizeDateValue(payload.dateOfBirth),
  anniversary: normalizeDateValue(payload.anniversary),
  source: payload.source || null,
  tags: sanitizeTagList(payload.tags),
  notes: payload.notes || null,
  preferences: payload.preferences || null,
  preferredStaffId: payload.preferredStaffId || null,
  allergies: payload.allergies || null,
  skinNotes: payload.skinNotes || null,
  ...(salonId ? { salonId } : {})
});

const updateCustomerHandler = async (req, res) => {
  const row = await findScoped("customer", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Customer not found" });

  if (req.body.phone) {
    const duplicate = await prisma.customer.findFirst({
      where: { salonId: req.salonId, phone: req.body.phone, NOT: { id: req.params.id } }
    });
    if (duplicate) return res.status(400).json({ message: "Another customer already uses this phone number" });
  }

  if (req.body.branchId) await ensureBranch(req.salonId, req.body.branchId);

  res.json(await prisma.customer.update({
    where: { id: req.params.id },
    data: buildCustomerData(req.body)
  }));
};

const resolveMembershipPermissions = async (salonId, customRoleId, explicitPermissions) => {
  let role = null;
  if (customRoleId) {
    role = await prisma.customRole.findFirst({ where: { id: customRoleId, salonId } });
    if (!role) {
      const error = new Error("Custom role not found");
      error.status = 400;
      throw error;
    }
  }
  if (explicitPermissions) return explicitPermissions;
  if (role) return role.permissions || {};
  return {};
};

const createLoginUserForSalon = async (salonId, payload) => {
  const {
    name, email, password, salonRole, branchId: rawBranchId, customRoleId, permissions,
    phone, profileNote, avatarUrl, roleTitle, showInCatalog, serviceIds = [],
    joiningDate, designation, uanNumber, reportingToId, workingHours,
    bankName, bankBranch, accountNumber, ifscCode
  } = payload;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { status: 400, body: { message: "Email already exists" } };

  const plan = await getActivePlanForSalon(salonId);
  if (plan) {
    const userCount = await prisma.userSalon.count({ where: { salonId } });
    if (userCount >= plan.userLimit) {
      return { status: 403, body: { message: "User limit reached for current plan" } };
    }
  }

  const branchId = normalizeBranchId(rawBranchId);
  if (branchId) await ensureBranch(salonId, branchId);
  const resolvedPermissions = await resolveMembershipPermissions(salonId, customRoleId, permissions);

  if (serviceIds.length) {
    const services = await prisma.service.findMany({ where: { id: { in: serviceIds }, salonId, isActive: true } });
    if (services.length !== serviceIds.length) {
      return { status: 400, body: { message: "One or more assigned services are invalid for this salon" } };
    }
    if (branchId) {
      const invalidService = services.find((service) => service.branchId && service.branchId !== branchId);
      if (invalidService) return { status: 400, body: { message: "Assigned services must belong to the selected branch or be branch-shared" } };
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name,
        email,
        passwordHash: await bcrypt.hash(password, 10),
        systemRole: "SALON_USER"
      }
    });

    const membership = await tx.userSalon.create({
      data: {
        userId: user.id,
        salonId,
        salonRole,
        branchId,
        customRoleId: customRoleId || null,
        phone: phone || null,
        profileNote: profileNote || null,
        avatarUrl: avatarUrl || null,
        roleTitle: roleTitle || null,
        showInCatalog: Boolean(showInCatalog),
        permissions: resolvedPermissions,
        joiningDate: joiningDate ? new Date(joiningDate) : null,
        designation: designation || null,
        uanNumber: uanNumber || null,
        reportingToId: reportingToId || null,
        workingHours: workingHours || null,
        bankName: bankName || null,
        bankBranch: bankBranch || null,
        accountNumber: accountNumber || null,
        ifscCode: ifscCode || null
      },
      include: { user: true, branch: true, customRole: true }
    });

    if (serviceIds.length) {
      await tx.staffServiceAssignment.createMany({
        data: serviceIds.map((serviceId) => ({ userSalonId: membership.id, serviceId })),
        skipDuplicates: true
      });
    }

    return tx.userSalon.findUnique({
      where: { id: membership.id },
      include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: true } } }
    });
  });

  return { status: 201, body: { membership: created } };
};

ownerRouter.get("/dashboard", requireSalonPermission("dashboard", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  const invoiceWhere = withBranchFilter(req.salonId, branchId);
  const serviceWhere = { salonId: req.salonId, isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) };
  const userWhere = { salonId: req.salonId, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) };
  const branchWhere = { salonId: req.salonId, isActive: true };
  const appointmentWhere = {
    salonId: req.salonId,
    ...(branchId ? { branchId } : {})
  };
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  const activeAppointmentStatuses = ["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS"];

  const [customers, services, invoices, users, branches, recentInvoices, recentCustomers, allInvoices, recentPayments, todayAppointments, upcomingAppointments, inventoryProducts] = await Promise.all([
    prisma.customer.count({ where: { salonId: req.salonId } }),
    prisma.service.count({ where: serviceWhere }),
    prisma.invoice.count({ where: invoiceWhere }),
    prisma.userSalon.count({ where: userWhere }),
    prisma.branch.count({ where: branchWhere }),
    prisma.invoice.findMany({ where: invoiceWhere, take: 5, include: { customer: true, branch: true }, orderBy: { createdAt: "desc" } }),
    prisma.customer.findMany({ where: { salonId: req.salonId }, take: 5, orderBy: { createdAt: "desc" } }),
    prisma.invoice.findMany({ where: { ...invoiceWhere, status: { in: ["PAID", "PARTIAL"] } }, include: { branch: true } }),
    prisma.payment.findMany({ where: paymentWhere(req.salonId, branchId), take: 5, include: { invoice: true }, orderBy: { createdAt: "desc" } }),
    prisma.appointment.count({
      where: {
        ...appointmentWhere,
        startAt: { gte: startOfDay, lt: endOfDay },
        status: { in: activeAppointmentStatuses }
      }
    }),
    prisma.appointment.count({
      where: {
        ...appointmentWhere,
        startAt: { gte: new Date() },
        status: { in: activeAppointmentStatuses }
      }
    }),
    prisma.product.findMany({
      where: {
        salonId: req.salonId,
        isActive: true,
        ...(branchId ? { OR: [{ branchId }, { branchId: null }, { stockMovements: { some: { branchId } } }] } : {})
      },
      include: { category: true, branch: true }
    })
  ]);

  const todaySales = allInvoices.filter((item) => new Date(item.createdAt) >= startOfDay).reduce((sum, item) => sum + toAmount(item.total), 0);
  const monthlySales = allInvoices.filter((item) => new Date(item.createdAt) >= startOfMonth).reduce((sum, item) => sum + toAmount(item.total), 0);
  const totalPaid = allInvoices.reduce((sum, item) => sum + toAmount(item.paidAmount), 0);
  const totalDue = allInvoices.reduce((sum, item) => sum + Math.max(0, toAmount(item.total) - toAmount(item.paidAmount)), 0);
  const branchScopedProducts = await attachBranchStock(prisma, inventoryProducts, branchId);
  const lowStockAlertCount = branchScopedProducts.filter((product) => toAmount(product.currentStock) <= toAmount(product.minStock)).length;

  res.json({
    customers,
    services,
    invoices,
    users,
    branches,
    branchFilter: branchId,
    todaySales,
    monthlySales,
    paymentSummary: { totalPaid, totalDue },
    upcomingAppointments,
    todayAppointments,
    lowStockAlertCount,
    recentInvoices,
    recentCustomers,
    recentPayments
  });
});

ownerRouter.get("/branches", requireSalonPermission("branches", "view"), async (req, res) => {
  const rows = await prisma.branch.findMany({
    where: { salonId: req.salonId, isActive: true },
    include: {
      _count: {
        select: { users: true, services: true, invoices: true }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  res.json(rows);
});
ownerRouter.post("/branches", requireSalonPermission("branches", "create"), validate(schemas.branch), async (req, res) => {
  const plan = await getActivePlanForSalon(req.salonId);
  if (plan) {
    const branchCount = await prisma.branch.count({ where: { salonId: req.salonId, isActive: true } });
    if (branchCount >= plan.branchLimit) {
      return res.status(403).json({ message: "Branch limit reached for current plan" });
    }
  }
  res.status(201).json(await prisma.branch.create({ data: { ...req.body, email: req.body.email || null, salonId: req.salonId } }));
});
ownerRouter.patch("/branches/:id", requireSalonPermission("branches", "edit"), validate(schemas.branch), async (req, res) => {
  const row = await findScoped("branch", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Branch not found" });
  res.json(await prisma.branch.update({ where: { id: req.params.id }, data: { ...req.body, email: req.body.email || null } }));
});
ownerRouter.patch("/branches/:id/archive", requireSalonPermission("branches", "delete"), async (req, res) => {
  const row = await findScoped("branch", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Branch not found" });
  res.json(await prisma.branch.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/service-categories/export", requireSalonPermission("services", "view"), async (req, res) => {
  const categories = await prisma.serviceCategory.findMany({
    where: { salonId: req.salonId, isActive: true, parentId: null },
    include: {
      children: {
        where: { isActive: true },
        include: {
          services: { where: { isActive: true } }
        }
      },
      services: { where: { isActive: true } }
    }
  });

  const headers = ["Category", "Subcategory", "ServiceName", "Price", "DurationMin", "TaxRate", "CommissionPct"];
  const rows = [];

  for (const cat of categories) {
    for (const svc of cat.services || []) {
      rows.push([
        cat.name,
        "",
        svc.name,
        svc.price,
        svc.durationMin,
        svc.taxRate || "",
        svc.commissionPct || ""
      ]);
    }
    for (const sub of cat.children || []) {
      for (const svc of sub.services || []) {
        rows.push([
          cat.name,
          sub.name,
          svc.name,
          svc.price,
          svc.durationMin,
          svc.taxRate || "",
          svc.commissionPct || ""
        ]);
      }
    }
  }

  const csv = buildCsv(headers, rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"service-categories-export.csv\"");
  res.send(csv);
});

ownerRouter.post("/service-categories/import", requireSalonPermission("services", "create"), upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file provided" });
  }

  const csvString = req.file.buffer.toString("utf8");
  
  const lines = csvString.split(/\r?\n/).map(line => {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }).filter(line => line.length > 0 && line.some(col => col.length > 0));

  if (lines.length <= 1) {
    return res.status(400).json({ message: "CSV file is empty or missing headers" });
  }

  const headers = lines[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, ""));
  
  const catIdx = headers.indexOf("category");
  const subIdx = headers.indexOf("subcategory");
  const nameIdx = headers.indexOf("servicename") !== -1 ? headers.indexOf("servicename") : headers.indexOf("name");
  const priceIdx = headers.indexOf("price");
  const durationIdx = headers.indexOf("durationmin") !== -1 ? headers.indexOf("durationmin") : headers.indexOf("duration");
  const taxIdx = headers.indexOf("taxrate");
  const commIdx = headers.indexOf("commissionpct") !== -1 ? headers.indexOf("commissionpct") : headers.indexOf("commission");

  if (catIdx === -1 || nameIdx === -1 || priceIdx === -1) {
    return res.status(400).json({ message: "CSV must contain Category, ServiceName, and Price columns" });
  }

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.length === 0) continue;

    const categoryName = row[catIdx];
    const serviceName = row[nameIdx];
    const price = Number(row[priceIdx] || 0);

    if (!categoryName || !serviceName) {
      errorCount++;
      errors.push(`Row ${i + 1}: Category name and Service name are required`);
      continue;
    }

    try {
      let parentCategory = await prisma.serviceCategory.findFirst({
        where: { salonId: req.salonId, name: categoryName, parentId: null, isActive: true }
      });

      if (!parentCategory) {
        parentCategory = await prisma.serviceCategory.create({
          data: { salonId: req.salonId, name: categoryName }
        });
      }

      const subcategoryName = subIdx !== -1 ? row[subIdx] : null;
      let targetCategoryId = parentCategory.id;

      if (subcategoryName) {
        let subCategory = await prisma.serviceCategory.findFirst({
          where: { salonId: req.salonId, name: subcategoryName, parentId: parentCategory.id, isActive: true }
        });

        if (!subCategory) {
          subCategory = await prisma.serviceCategory.create({
            data: { salonId: req.salonId, name: subcategoryName, parentId: parentCategory.id }
          });
        }
        targetCategoryId = subCategory.id;
      }

      const durationMin = durationIdx !== -1 ? Number(row[durationIdx] || 30) : 30;
      const taxRate = taxIdx !== -1 ? Number(row[taxIdx] || 0) : null;
      const commissionPct = commIdx !== -1 ? Number(row[commIdx] || 0) : null;

      const existingService = await prisma.service.findFirst({
        where: { salonId: req.salonId, name: serviceName, categoryId: targetCategoryId, isActive: true }
      });

      if (existingService) {
        await prisma.service.update({
          where: { id: existingService.id },
          data: {
            price,
            durationMin,
            taxRate,
            commissionPct
          }
        });
      } else {
        await prisma.service.create({
          data: {
            salonId: req.salonId,
            categoryId: targetCategoryId,
            name: serviceName,
            price,
            durationMin,
            taxRate,
            commissionPct
          }
        });
      }
      successCount++;
    } catch (e) {
      errorCount++;
      errors.push(`Row ${i + 1}: ${e.message}`);
    }
  }

  res.json({
    message: `Import completed: ${successCount} processed successfully, ${errorCount} errors.`,
    successCount,
    errorCount,
    errors
  });
});

ownerRouter.get("/service-categories", requireSalonPermission("services", "view"), async (req, res) => {
  res.json(await prisma.serviceCategory.findMany({ where: { salonId: req.salonId, isActive: true, parentId: null }, include: { children: { where: { isActive: true }, include: { services: { where: { isActive: true } } } }, services: { where: { isActive: true } }, }, orderBy: { createdAt: "desc" } }));
});
ownerRouter.post("/service-categories", requireSalonPermission("services", "create"), async (req, res) => {
  const { name, parentId } = req.body;
  if (!name || name.length < 2) return res.status(400).json({ message: "Name must be at least 2 characters" });
  const where = { salonId: req.salonId, name: name.trim(), isActive: true, parentId: parentId || null };
  const existing = await prisma.serviceCategory.findFirst({ where });
  if (existing) return res.status(409).json({ message: "Category with this name already exists" });
  const data = { salonId: req.salonId, name: name.trim() };
  if (parentId) data.parentId = parentId;
  res.status(201).json(await prisma.serviceCategory.create({ data, include: { children: true } }));
});
ownerRouter.patch("/service-categories/:id", requireSalonPermission("services", "edit"), validate(schemas.serviceCategory), async (req, res) => {
  const row = await findScoped("serviceCategory", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service category not found" });
  res.json(await prisma.serviceCategory.update({ where: { id: req.params.id }, data: req.body }));
});
ownerRouter.patch("/service-categories/:id/archive", requireSalonPermission("services", "delete"), async (req, res) => {
  const row = await findScoped("serviceCategory", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service category not found" });
  res.json(await prisma.serviceCategory.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/services", requireSalonPermission("services", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  res.json(await prisma.service.findMany({
    where: { salonId: req.salonId, isActive: true, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { branch: true, category: true },
    orderBy: { createdAt: "desc" }
  }));
});
ownerRouter.post("/services", requireSalonPermission("services", "create"), validate(schemas.service), async (req, res) => {
  // Gender field added to prisma schema to prevent service creation 500 error
  const branchId = normalizeBranchId(req.body.branchId);
  if (branchId) await ensureBranch(req.salonId, branchId);
  const categoryId = req.body.categoryId || null;
  const salonSettings = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
  const taxRows = Array.isArray(salonSettings?.advancedSettings?.taxMapping?.rates)
    ? salonSettings.advancedSettings.taxMapping.rates
    : [];
  const defaultServiceTax = taxRows.find((row) => row?.active !== false && Array.isArray(row?.applicableFor) && row.applicableFor.includes("SERVICE"));
  const explicitTaxRate = req.body.taxRate != null ? toAmount(req.body.taxRate) : null;
  const { gender, ...createData } = req.body;
  res.status(201).json(await prisma.service.create({
    data: {
      ...createData,
      branchId,
      categoryId,
      price: toAmount(req.body.price),
      durationMin: Number(req.body.durationMin),
      taxRate: explicitTaxRate ?? (defaultServiceTax?.rate != null ? toAmount(defaultServiceTax.rate) : null),
      commissionPct: req.body.commissionPct != null ? toAmount(req.body.commissionPct) : null,
      salonId: req.salonId
    },
    include: { branch: true, category: true }
  }));
});
ownerRouter.patch("/services/:id", requireSalonPermission("services", "edit"), validate(schemas.service), async (req, res) => {
  const row = await findScoped("service", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service not found" });
  const branchId = normalizeBranchId(req.body.branchId);
  if (branchId) await ensureBranch(req.salonId, branchId);
  const { gender, ...updateData } = req.body;
  const salonSettings = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
  const taxRows = Array.isArray(salonSettings?.advancedSettings?.taxMapping?.rates)
    ? salonSettings.advancedSettings.taxMapping.rates
    : [];
  const defaultServiceTax = taxRows.find((taxRow) => taxRow?.active !== false && Array.isArray(taxRow?.applicableFor) && taxRow.applicableFor.includes("SERVICE"));
  const explicitTaxRate = req.body.taxRate != null ? toAmount(req.body.taxRate) : null;
  res.json(await prisma.service.update({
    where: { id: req.params.id },
    data: {
      ...updateData,
      branchId,
      categoryId: req.body.categoryId !== undefined ? req.body.categoryId : row.categoryId,
      price: toAmount(req.body.price),
      durationMin: Number(req.body.durationMin),
      taxRate: explicitTaxRate ?? (defaultServiceTax?.rate != null ? toAmount(defaultServiceTax.rate) : row.taxRate),
      commissionPct: req.body.commissionPct != null ? toAmount(req.body.commissionPct) : null
    },
    include: { branch: true, category: true }
  }));
});
ownerRouter.patch("/services/:id/archive", requireSalonPermission("services", "delete"), async (req, res) => {
  const row = await findScoped("service", req.salonId, req.params.id);
  if (!row) return res.status(404).json({ message: "Service not found" });
  res.json(await prisma.service.update({ where: { id: req.params.id }, data: { isActive: false } }));
});

ownerRouter.get("/customers/export", requireSalonPermission("customers", "view"), async (req, res) => {
  const { format } = req.query;
  const customers = await prisma.customer.findMany({
    where: { salonId: req.salonId },
    orderBy: { name: "asc" }
  });
  
  const headers = ["Name", "Phone", "Email", "Gender", "DateOfBirth", "Anniversary", "Source", "Tags", "Notes", "CreatedAt"];
  const rows = customers.map(c => [
    c.name || "",
    c.phone || "",
    c.email || "",
    c.gender || "",
    c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : "",
    c.anniversary ? c.anniversary.toISOString().slice(0, 10) : "",
    c.source || "",
    Array.isArray(c.tags) ? c.tags.join("; ") : "",
    c.notes || "",
    c.createdAt ? c.createdAt.toISOString() : ""
  ]);

  const csv = buildCsv(headers, rows);
  
  if (String(format).toLowerCase() === "xls" || String(format).toLowerCase() === "xlsx" || String(format).toLowerCase() === "excel") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=\"customers-export.xlsx\"");
  } else {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"customers-export.csv\"");
  }
  res.send(csv);
});

ownerRouter.post("/customers/import", requireSalonPermission("customers", "create"), upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file provided" });
  }

  const csvString = req.file.buffer.toString("utf8");
  
  const lines = csvString.split(/\r?\n/).map(line => {
    const result = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' || char === "'") {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }).filter(line => line.length > 0 && line.some(col => col.length > 0));

  if (lines.length <= 1) {
    return res.status(400).json({ message: "CSV file is empty or missing headers" });
  }

  const headers = lines[0].map(h => String(h).toLowerCase().replace(/[^a-z0-9]/g, ""));
  
  const nameIdx = headers.indexOf("name");
  const phoneIdx = headers.indexOf("phone") !== -1 ? headers.indexOf("phone") : headers.indexOf("mobileno");
  const emailIdx = headers.indexOf("email");
  const genderIdx = headers.indexOf("gender");
  const dobIdx = headers.indexOf("dateofbirth") !== -1 ? headers.indexOf("dateofbirth") : headers.indexOf("dob");
  const anniversaryIdx = headers.indexOf("anniversary");
  const sourceIdx = headers.indexOf("source");
  const tagsIdx = headers.indexOf("tags");
  const notesIdx = headers.indexOf("notes");

  if (phoneIdx === -1) {
    return res.status(400).json({ message: "CSV must contain a 'Phone' or 'Mobile No' column" });
  }

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.length === 0) continue;
    
    const phone = row[phoneIdx];
    if (!phone) {
      errorCount++;
      errors.push(`Row ${i + 1}: Phone number is missing`);
      continue;
    }

    const name = nameIdx !== -1 ? (row[nameIdx] || "Guest") : "Guest";
    const email = emailIdx !== -1 ? row[emailIdx] : null;
    const gender = genderIdx !== -1 ? String(row[genderIdx]).toLowerCase() : null;
    const dateOfBirth = dobIdx !== -1 && row[dobIdx] ? new Date(row[dobIdx]) : null;
    const anniversary = anniversaryIdx !== -1 && row[anniversaryIdx] ? new Date(row[anniversaryIdx]) : null;
    const source = sourceIdx !== -1 ? row[sourceIdx] : null;
    const notes = notesIdx !== -1 ? row[notesIdx] : null;
    
    let tags = [];
    if (tagsIdx !== -1 && row[tagsIdx]) {
      tags = row[tagsIdx].split(";").map(t => t.trim()).filter(Boolean);
    }

    try {
      const duplicate = await prisma.customer.findFirst({
        where: { salonId: req.salonId, phone }
      });

      if (duplicate) {
        await prisma.customer.update({
          where: { id: duplicate.id },
          data: {
            name,
            email: email || duplicate.email,
            gender: gender || duplicate.gender,
            dateOfBirth: (dateOfBirth && !isNaN(dateOfBirth.getTime())) ? dateOfBirth : duplicate.dateOfBirth,
            anniversary: (anniversary && !isNaN(anniversary.getTime())) ? anniversary : duplicate.anniversary,
            source: source || duplicate.source,
            tags: tags.length > 0 ? Array.from(new Set([...duplicate.tags, ...tags])) : duplicate.tags,
            notes: notes || duplicate.notes
          }
        });
      } else {
        await prisma.customer.create({
          data: {
            salonId: req.salonId,
            name,
            phone,
            email,
            gender,
            dateOfBirth: (dateOfBirth && !isNaN(dateOfBirth.getTime())) ? dateOfBirth : null,
            anniversary: (anniversary && !isNaN(anniversary.getTime())) ? anniversary : null,
            source,
            tags,
            notes
          }
        });
      }
      successCount++;
    } catch (e) {
      errorCount++;
      errors.push(`Row ${i + 1}: ${e.message}`);
    }
  }

  res.json({
    message: `Import completed: ${successCount} processed successfully, ${errorCount} errors.`,
    successCount,
    errorCount,
    errors
  });
});

ownerRouter.get("/customers", requireSalonPermission("customers", "view"), async (req, res) => {
  const query = String(req.query.q || "").trim();
  const filter = String(req.query.filter || "").trim();
  const branchId = normalizeBranchId(req.query.branchId);
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const rows = await prisma.customer.findMany({
    where: {
      salonId: req.salonId,
      ...(branchId ? { invoices: { some: { branchId } } } : {}),
      ...(query ? {
        OR: [
          { name: { contains: query } },
          { phone: { contains: query } },
          { email: { contains: query } },
          { source: { contains: query } }
        ]
      } : {}),
      ...(filter === "high_spender" ? { totalSpend: { gte: 10000 } } : {}),
      ...(filter === "lost_customer" ? { OR: [{ lastVisitAt: null }, { lastVisitAt: { lte: ninetyDaysAgo } }] } : {}),
      ...(filter === "active_membership" ? { memberships: { some: { status: "ACTIVE", endsAt: { gte: now } } } } : {}),
      ...(filter === "active_package" ? { packages: { some: { status: "ACTIVE", endsAt: { gte: now } } } } : {})
    },
    include: {
      preferredStaff: { include: { user: true } },
      invoices: {
        select: { balanceAmount: true }
      },
      timelineEntries: {
        where: { eventType: "ADVANCE_PAYMENT" },
        select: { details: true }
      },
      _count: {
        select: {
          invoices: true,
          memberships: true,
          packages: true
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });
  const filteredRows = rows.filter((row) => {
    if (filter === "birthday_month") return row.dateOfBirth ? new Date(row.dateOfBirth).getMonth() === now.getMonth() : false;
    if (filter === "anniversary_month") return row.anniversary ? new Date(row.anniversary).getMonth() === now.getMonth() : false;
    return true;
  });
  const mapped = filteredRows.map(row => {
    const balanceAmount = (row.invoices || []).reduce((sum, inv) => sum + Number(inv.balanceAmount || 0), 0);
    const advanceAmount = (row.timelineEntries || []).reduce((sum, entry) => {
      try {
        const details = JSON.parse(entry.details || "{}");
        return sum + Number(details.amount || 0);
      } catch (e) {
        return sum;
      }
    }, 0);

    const namePart = (row.name || "GUEST").trim().split(" ")[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
    const phonePart = (row.phone || "0000").replace(/[^0-9]/g, "").slice(-4);
    const referralCode = `${namePart}${phonePart}`;

    const { invoices, timelineEntries, ...rest } = row;
    return {
      ...rest,
      totalOrders: row._count?.invoices || 0,
      membershipCount: row._count?.memberships || 0,
      packageCount: row._count?.packages || 0,
      advanceAmount,
      balanceAmount,
      referralCode
    };
  });
  res.json(mapped);
});
ownerRouter.post("/customers", requireSalonPermission("customers", "create"), validate(schemas.customer), async (req, res) => {
  const plan = await getActivePlanForSalon(req.salonId);
  if (plan) {
    const customerCount = await prisma.customer.count({ where: { salonId: req.salonId } });
    if (customerCount >= plan.customerLimit) {
      return res.status(403).json({ message: "Customer limit reached for current plan" });
    }
  }
  const duplicate = await prisma.customer.findFirst({ where: { salonId: req.salonId, phone: req.body.phone } });
  if (duplicate) return res.status(400).json({ message: "Customer with this phone already exists in this salon" });
  if (req.body.branchId) await ensureBranch(req.salonId, req.body.branchId);
  res.status(201).json(await prisma.customer.create({
    data: buildCustomerData(req.body, req.salonId)
  }));
});
ownerRouter.patch("/customers/:id", requireSalonPermission("customers", "edit"), validate(schemas.customerPatch), updateCustomerHandler);
ownerRouter.put("/customers/:id", requireSalonPermission("customers", "edit"), validate(schemas.customerPatch), updateCustomerHandler);
ownerRouter.get("/customers/:id", requireSalonPermission("customers", "view"), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.params.id, salonId: req.salonId },
    include: {
      invoices: {
        include: { items: true, payments: true, branch: true },
        orderBy: { createdAt: "desc" }
      },
      memberships: {
        include: { membershipPlan: true },
        orderBy: { createdAt: "desc" }
      },
      packages: {
        include: {
          package: {
            include: {
              services: {
                include: {
                  service: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: "desc" }
      }
    }
  });
  if (!customer) return res.status(404).json({ message: "Customer not found" });
  
  const balanceAmount = customer.invoices.reduce((sum, inv) => sum + Number(inv.balanceAmount || 0), 0);
  const [advanceTimelineEntries, followUpEntries, staffDirectory] = await Promise.all([
    prisma.customerTimeline.findMany({
      where: { customerId: req.params.id, eventType: "ADVANCE_PAYMENT" }
    }),
    prisma.customerTimeline.findMany({
      where: { customerId: req.params.id, eventType: "FOLLOW_UP" },
      orderBy: { createdAt: "desc" }
    }),
    prisma.userSalon.findMany({
      where: { salonId: req.salonId, isArchived: false },
      include: { user: true }
    })
  ]);
  const staffNameMap = new Map(staffDirectory.map((row) => [row.id, row.user?.name || row.user?.email || row.id]));
  const followUps = followUpEntries.map((entry) => {
    try {
      const details = JSON.parse(entry.details || "{}");
      const staffName = details.staffName || (details.staffUserId ? staffNameMap.get(details.staffUserId) : "");
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        eventType: entry.eventType,
        title: entry.title,
        message: details.message || entry.title,
        note: details.message || entry.title,
        date: details.date || "",
        time: details.time || "",
        type: details.type || "call",
        status: details.status || "SCHEDULED",
        staffUserId: details.staffUserId || "",
        staffName: staffName || "",
        scheduledFor: details.time ? `${details.date || ""}T${details.time}` : (details.date || "")
      };
    } catch (e) {
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        eventType: entry.eventType,
        title: entry.title,
        message: entry.title,
        note: entry.title,
        date: "",
        time: "",
        type: "call",
        status: "SCHEDULED",
        staffUserId: "",
        staffName: ""
      };
    }
  });
  const timelineEntries = advanceTimelineEntries;
  const advanceAmount = timelineEntries.reduce((sum, entry) => {
    try {
      const details = JSON.parse(entry.details || "{}");
      return sum + Number(details.amount || 0);
    } catch (e) {
      return sum;
    }
  }, 0);

  const familyMembers = await prisma.customer.findMany({
    where: { salonId: req.salonId, notes: { contains: `familyMemberOf:${req.params.id}` } }
  });

  const totalOrders = customer.invoices.length;
  const namePart = (customer.name || "GUEST").trim().split(" ")[0].replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const phonePart = (customer.phone || "0000").replace(/[^0-9]/g, "").slice(-4);
  const referralCode = `${namePart}${phonePart}`;

  res.json({
    ...customer,
    totalOrders,
    advanceAmount,
    balanceAmount,
    familyMembers,
    referralCode,
    followUps
  });
});

ownerRouter.post("/follow-ups", requireSalonPermission("customers", "edit"), validate(schemas.customerFollowUp), async (req, res) => {
  const customer = await prisma.customer.findFirst({
    where: { id: req.body.customerId, salonId: req.salonId }
  });
  if (!customer) return res.status(404).json({ message: "Customer not found" });

  const staffUser = await prisma.userSalon.findFirst({
    where: { id: req.body.staffUserId, salonId: req.salonId, isArchived: false },
    include: { user: true }
  });
  if (!staffUser) return res.status(400).json({ message: "Assigned staff not found for this salon" });

  const title = `Follow-up scheduled (${String(req.body.type || "call").toUpperCase()})`;
  const details = {
    date: req.body.date,
    time: req.body.time || "",
    message: req.body.message,
    type: req.body.type,
    status: "SCHEDULED",
    staffUserId: staffUser.id,
    staffName: staffUser.user?.name || staffUser.user?.email || staffUser.id
  };

  const timeline = await prisma.customerTimeline.create({
    data: {
      customerId: customer.id,
      eventType: "FOLLOW_UP",
      title,
      details: JSON.stringify(details),
      referenceId: customer.id
    }
  });

  await createAuditLog({
    salonId: req.salonId,
    actorUserId: req.user.userId,
    actorMembershipId: req.user.membershipId,
    module: "CRM",
    action: "FOLLOW_UP_CREATED",
    entityType: "CustomerTimeline",
    entityId: timeline.id,
    summary: `Follow-up scheduled for ${customer.name || customer.phone || customer.id}`
  });

  res.status(201).json({
    ...timeline,
    ...details
  });
});

ownerRouter.get("/users", requireSalonPermission("staff", "view"), async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  res.json(await prisma.userSalon.findMany({
    where: { salonId: req.salonId, isArchived: false, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: true } } },
    orderBy: { id: "desc" }
  }));
});
ownerRouter.get("/staff-users", async (req, res) => {
  const branchId = normalizeBranchId(req.query.branchId);
  res.json(await prisma.userSalon.findMany({
    where: { salonId: req.salonId, isArchived: false, ...(branchId ? { OR: [{ branchId }, { branchId: null }] } : {}) },
    include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: true } } },
    orderBy: { id: "desc" }
  }));
});
ownerRouter.get("/custom-roles", requireSalonPermission("staff", "view"), async (req, res) => {
  res.json(await prisma.customRole.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } }));
});
ownerRouter.post("/custom-roles", requireSalonPermission("staff", "create"), validate(schemas.customRole), async (req, res) => {
  const existing = await prisma.customRole.findFirst({ where: { salonId: req.salonId, name: req.body.name } });
  if (existing) return res.status(400).json({ message: "A custom role with this name already exists" });
  res.status(201).json(await prisma.customRole.create({
    data: { salonId: req.salonId, name: req.body.name, description: req.body.description || null, permissions: req.body.permissions }
  }));
});
ownerRouter.patch("/custom-roles/:id", requireSalonPermission("staff", "edit"), validate(schemas.customRole), async (req, res) => {
  const role = await prisma.customRole.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!role) return res.status(404).json({ message: "Custom role not found" });
  res.json(await prisma.customRole.update({
    where: { id: role.id },
    data: { name: req.body.name, description: req.body.description || null, permissions: req.body.permissions }
  }));
});
ownerRouter.post("/users", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.post("/staff-users", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.patch("/users/:id", requireSalonPermission("staff", "edit"), validate(schemas.userMembershipUpdate), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  const branchId = req.body.branchId === null ? null : normalizeBranchId(req.body.branchId ?? row.branchId);
  const customRoleId = req.body.customRoleId === null ? null : (req.body.customRoleId ?? row.customRoleId ?? null);
  if (branchId) await ensureBranch(req.salonId, branchId);
  const resolvedPermissions = await resolveMembershipPermissions(req.salonId, customRoleId, req.body.permissions);
  if (Array.isArray(req.body.serviceIds) && req.body.serviceIds.length) {
    const services = await prisma.service.findMany({ where: { id: { in: req.body.serviceIds }, salonId: req.salonId, isActive: true } });
    if (services.length !== req.body.serviceIds.length) return res.status(400).json({ message: "One or more assigned services are invalid for this salon" });
    if (branchId) {
      const invalidService = services.find((s) => s.branchId && s.branchId !== branchId);
      if (invalidService) return res.status(400).json({ message: "Assigned services must belong to the selected branch or be branch-shared" });
    }
  }
  const updated = await prisma.$transaction(async (tx) => {
    const membership = await tx.userSalon.update({
      where: { id: req.params.id },
      data: {
        salonRole: req.body.salonRole ?? row.salonRole,
        branchId,
        customRoleId,
        phone: req.body.phone ?? row.phone,
        profileNote: req.body.profileNote ?? row.profileNote,
        avatarUrl: req.body.avatarUrl ?? row.avatarUrl,
        roleTitle: req.body.roleTitle ?? row.roleTitle,
        showInCatalog: req.body.showInCatalog ?? row.showInCatalog,
        isArchived: req.body.isArchived ?? row.isArchived,
        permissions: resolvedPermissions,
        joiningDate: req.body.joiningDate !== undefined ? (req.body.joiningDate ? new Date(req.body.joiningDate) : null) : row.joiningDate,
        designation: req.body.designation !== undefined ? (req.body.designation || null) : row.designation,
        uanNumber: req.body.uanNumber !== undefined ? (req.body.uanNumber || null) : row.uanNumber,
        reportingToId: req.body.reportingToId !== undefined ? (req.body.reportingToId || null) : row.reportingToId,
        workingHours: req.body.workingHours !== undefined ? (req.body.workingHours || null) : row.workingHours,
        bankName: req.body.bankName !== undefined ? (req.body.bankName || null) : row.bankName,
        bankBranch: req.body.bankBranch !== undefined ? (req.body.bankBranch || null) : row.bankBranch,
        accountNumber: req.body.accountNumber !== undefined ? (req.body.accountNumber || null) : row.accountNumber,
        ifscCode: req.body.ifscCode !== undefined ? (req.body.ifscCode || null) : row.ifscCode
      },
      include: { user: true, branch: true, customRole: true }
    });
    if (Array.isArray(req.body.serviceIds)) {
      await tx.staffServiceAssignment.deleteMany({ where: { userSalonId: req.params.id } });
      if (req.body.serviceIds.length) {
        await tx.staffServiceAssignment.createMany({
          data: req.body.serviceIds.map((serviceId) => ({ userSalonId: req.params.id, serviceId })),
          skipDuplicates: true
        });
      }
    }
    return tx.userSalon.findUnique({
      where: { id: req.params.id },
      include: { user: true, branch: true, customRole: true, serviceAssignments: { include: { service: true } } }
    });
  });
  res.json(updated);
});
ownerRouter.patch("/staff-users/:id", requireSalonPermission("staff", "edit"), validate(schemas.userMembershipUpdate), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "Staff mapping not found" });
  const branchId = req.body.branchId === null ? null : normalizeBranchId(req.body.branchId ?? row.branchId);
  if (branchId) await ensureBranch(req.salonId, branchId);
  res.json(await prisma.userSalon.update({ where: { id: req.params.id }, data: { ...req.body, branchId } }));
});
ownerRouter.get("/roles-permissions", requireSalonPermission("staff", "view"), async (req, res) => {
  res.json(
    await prisma.userSalon.findMany({
      where: { salonId: req.salonId, isArchived: false },
      include: { user: { select: { id: true, name: true, email: true, isActive: true } }, branch: true, customRole: true, serviceAssignments: { include: { service: true } } },
      orderBy: { id: "desc" }
    })
  );
});
ownerRouter.post("/users/create-login", requireSalonPermission("staff", "create"), validate(schemas.ownerUser), async (req, res) => {
  const result = await createLoginUserForSalon(req.salonId, req.body);
  res.status(result.status).json(result.body);
});
ownerRouter.patch("/users/:id/status", requireSalonPermission("staff", "edit"), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { user: true } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  res.json(await prisma.user.update({ where: { id: row.userId }, data: { isActive: Boolean(req.body.isActive) } }));
});
ownerRouter.patch("/users/:id/archive", requireSalonPermission("staff", "delete"), async (req, res) => {
  const row = await prisma.userSalon.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!row) return res.status(404).json({ message: "User mapping not found" });
  res.json(await prisma.userSalon.update({ where: { id: req.params.id }, data: { isArchived: true } }));
});

ownerRouter.get("/support-tickets", requireSalonPermission("support", "view"), async (req, res) => {
  const q = String(req.query.q || "").trim();
  const status = String(req.query.status || "").trim();
  const priority = String(req.query.priority || "").trim();
  res.json(await prisma.supportTicket.findMany({
    where: {
      salonId: req.salonId,
      ...(status ? { status } : {}),
      ...(priority ? { priority } : {}),
      ...(q ? {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { description: { contains: q, mode: "insensitive" } },
          { category: { contains: q, mode: "insensitive" } },
          { internalNote: { contains: q, mode: "insensitive" } },
          { assignedAgentName: { contains: q, mode: "insensitive" } }
        ]
      } : {})
    },
    include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "desc" }
  }));
});
ownerRouter.post("/support-tickets", requireSalonPermission("support", "create"), validate(schemas.supportTicket), async (req, res) => {
  const created = await prisma.$transaction(async (tx) => {
    const { attachmentUrl, ...ticketPayload } = req.body;
    const ticket = await tx.supportTicket.create({ data: { salonId: req.salonId, ...ticketPayload } });
    await tx.supportTicketEvent.create({
      data: {
        ticketId: ticket.id,
        eventType: "CREATED",
        actorName: req.user.name,
        details: "Ticket created by salon"
      }
    });
    if (req.body.description) {
      await tx.supportTicketMessage.create({
        data: {
          ticketId: ticket.id,
          authorType: "SALON",
          authorName: req.user.name,
          message: req.body.description,
          attachmentUrl: attachmentUrl || null
        }
      });
    }
    return tx.supportTicket.findUnique({
      where: { id: ticket.id },
      include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } }
    });
  });
  res.status(201).json(created);
});
ownerRouter.post("/support-tickets/:id/messages", requireSalonPermission("support", "create"), validate(schemas.supportTicketMessage), async (req, res) => {
  const ticket = await prisma.supportTicket.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
  if (!ticket) return res.status(404).json({ message: "Support ticket not found" });
  if (ticket.status === "CLOSED") return res.status(400).json({ message: "Closed tickets cannot receive replies until reopened by support" });

  await prisma.supportTicketMessage.create({
    data: {
      ticketId: ticket.id,
      authorType: "SALON",
      authorName: req.user.name,
      message: req.body.message,
      attachmentUrl: req.body.attachmentUrl || null
    }
  });
  await prisma.supportTicket.update({ where: { id: ticket.id }, data: { status: "OPEN" } });
  await prisma.supportTicketEvent.create({
    data: {
      ticketId: ticket.id,
      eventType: "REPLY_SENT",
      actorName: req.user.name,
      details: req.body.attachmentUrl ? "Salon reply sent with attachment placeholder" : "Salon reply sent",
      fromStatus: ticket.status,
      toStatus: "OPEN"
    }
  });
  res.json(await prisma.supportTicket.findUnique({ where: { id: ticket.id }, include: { messages: { orderBy: { createdAt: "asc" } }, events: { orderBy: { createdAt: "asc" } } } }));
});

ownerRouter.get("/settings", requireSalonPermission("settings", "view"), async (req, res) => {
  const row = await prisma.salonSetting.findFirst({ where: { salonId: req.salonId, branchId: null } });
  res.json(row);
});

ownerRouter.post("/settings/crm-segment-preview", requireSalonPermission("settings", "view"), async (req, res) => {
  const segments = req.body.segments || [];
  const preview = {};
  for (const segment of segments) {
    if (!segment.id) continue;
    try {
      const audience = await getCampaignAudience(req.salonId, segment.filterType || "ALL_CUSTOMERS", { serviceId: segment.serviceId });
      preview[segment.id] = audience.length;
    } catch (err) {
      preview[segment.id] = 0;
    }
  }
  res.json({ preview });
});
ownerRouter.post("/settings", requireSalonPermission("settings", "edit"), validate(schemas.salonSettings), async (req, res) => {
  const branchId = req.body.branchId || null;
  const payload = {
    invoicePrefix: req.body.invoicePrefix,
    invoiceFooter: req.body.invoiceFooter,
    taxLabel: req.body.taxLabel,
    paymentModes: req.body.paymentModes,
    whatsappNumber: req.body.whatsappNumber || null,
    bookingNotes: req.body.bookingNotes || null,
    cancellationPolicy: req.body.cancellationPolicy || null,
    allowNegativeStock: Boolean(req.body.allowNegativeStock),
    paymentGatewaySettings: req.body.paymentGatewaySettings || null,
    advancedSettings: req.body.advancedSettings || null,
    smsSettings: req.body.smsSettings || null
  };
  const existing = await prisma.salonSetting.findFirst({
    where: { salonId: req.salonId, branchId }
  });
  const row = existing
    ? await prisma.salonSetting.update({
        where: { id: existing.id },
        data: payload
      })
    : await prisma.salonSetting.create({
        data: { salonId: req.salonId, ...payload, branchId }
      });
  await createAuditLog({
    salonId: req.salonId,
    actorUserId: req.user.userId,
    actorMembershipId: req.user.membershipId,
    module: "SETTINGS",
    action: existing ? "SETTINGS_UPDATED" : "SETTINGS_CREATED",
    entityType: "SalonSetting",
    entityId: row.id,
    summary: branchId ? "Branch-level settings saved" : "Salon settings saved",
    metadata: {
      branchId,
      paymentModes: payload.paymentModes,
      allowNegativeStock: payload.allowNegativeStock,
      paymentLinkEnabled: payload.paymentGatewaySettings?.paymentLinkEnabled ?? null,
      advancedSettingsSections: Object.keys(payload.advancedSettings || {}),
      smsSettingsConfigured: Boolean(payload.smsSettings)
    }
  });
  res.status(201).json(row);
});

ownerRouter.get("/website/config", requireSalonPermission("settings", "view"), async (req, res) => {
  const salon = await prisma.salon.findUnique({
    where: { id: req.salonId },
    select: { featureFlags: true }
  });
  const featureFlags = typeof salon?.featureFlags === "object" && salon.featureFlags ? salon.featureFlags : {};
  const websiteConfig = typeof featureFlags.websiteConfig === "object" && featureFlags.websiteConfig ? featureFlags.websiteConfig : {};
  res.json({
    heroTitle: String(websiteConfig.heroTitle || ""),
    heroSubtitle: String(websiteConfig.heroSubtitle || ""),
    heroImage: String(websiteConfig.heroImage || "")
  });
});

ownerRouter.post("/website/config", requireSalonPermission("settings", "edit"), async (req, res) => {
  const salon = await prisma.salon.findUnique({
    where: { id: req.salonId },
    select: { featureFlags: true }
  });
  const featureFlags = typeof salon?.featureFlags === "object" && salon.featureFlags ? salon.featureFlags : {};
  const websiteConfig = {
    heroTitle: String(req.body.heroTitle || "").trim(),
    heroSubtitle: String(req.body.heroSubtitle || "").trim(),
    heroImage: String(req.body.heroImage || "").trim()
  };
  await prisma.salon.update({
    where: { id: req.salonId },
    data: {
      featureFlags: {
        ...featureFlags,
        websiteConfig
      }
    }
  });
  await createAuditLog({
    salonId: req.salonId,
    actorUserId: req.user.userId,
    actorMembershipId: req.user.membershipId,
    module: "SETTINGS",
    action: "WEBSITE_CONFIG_UPDATED",
    entityType: "Salon",
    entityId: req.salonId,
    summary: "Website editor configuration updated",
    metadata: websiteConfig
  });
  res.json(websiteConfig);
});

ownerRouter.get("/reports/trends", requireSalonPermission("reports", "view"), async (req, res) => {
  const range = req.query.range || "7D";

  let days = 7;
  if (range === "1D")  days = 1;
  if (range === "14D") days = 14;
  if (range === "1M")  days = 30;
  if (range === "2M")  days = 60;
  if (range === "YTD") days = Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / 86400000) || 1;
  if (range === "1Y")  days = 365;

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  startDate.setHours(0,0,0,0);

  const invoices = await prisma.invoice.findMany({
    where: {
      salonId: req.salonId,
      status: "PAID",
      createdAt: { gte: startDate }
    },
    include: {
      items: true
    }
  });

  let serviceRev = 0, productRev = 0, packageRev = 0, membershipRev = 0;

  invoices.forEach(inv => {
    inv.items.forEach(item => {
      const type  = item.itemType || "SERVICE";  // fixed: itemType not type
      const total = Number(item.lineTotal || 0); // fixed: lineTotal not total
      if (type === "SERVICE")    serviceRev    += total;
      if (type === "PRODUCT")    productRev    += total;
      if (type === "PACKAGE")    packageRev    += total;
      if (type === "MEMBERSHIP") membershipRev += total;
    });
  });

  const totalRev = serviceRev + productRev + packageRev + membershipRev;

  const revenueSplit = [
    { name: "Total", value: totalRev, fill: "#6366f1" },
    { name: "Service", value: serviceRev, fill: "#3b82f6" },
    { name: "Product", value: productRev, fill: "#10b981" },
    { name: "Package", value: packageRev, fill: "#f59e0b" },
    { name: "Membership", value: membershipRev, fill: "#ec4899" },
    { name: "Gift Card", value: 0, fill: "#8b5cf6" }
  ];

  // daily trend line
  const dateMap = {};
  const totalDays = Math.max(days, 1);
  for (let i = 0; i < totalDays; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (totalDays - 1 - i));
    const dateStr = d.toISOString().slice(0, 10);
    dateMap[dateStr] = { date: dateStr, total: 0, service: 0, product: 0, package: 0, membership: 0 };
  }

  invoices.forEach(inv => {
    const dStr = inv.createdAt.toISOString().slice(0, 10);
    if (dateMap[dStr]) {
      inv.items.forEach(item => {
        const type = item.itemType || "SERVICE";
        const t    = Number(item.lineTotal || 0);
        dateMap[dStr].total += t;
        if (type === "SERVICE")    dateMap[dStr].service    += t;
        if (type === "PRODUCT")    dateMap[dStr].product    += t;
        if (type === "PACKAGE")    dateMap[dStr].package    += t;
        if (type === "MEMBERSHIP") dateMap[dStr].membership += t;
      });
    }
  });

  // top services
  const serviceMap = {};
  invoices.forEach(inv => {
    inv.items.filter(i => (i.itemType || "SERVICE") === "SERVICE").forEach(item => {
      const name = item.serviceName || "Unknown";
      serviceMap[name] = (serviceMap[name] || 0) + Number(item.lineTotal || 0);
    });
  });
  const topServices = Object.entries(serviceMap)
    .map(([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  // top staff
  const staffMap = {};
  invoices.forEach(inv => {
    inv.items.forEach(item => {
      if (!item.staffName) return;
      staffMap[item.staffName] = (staffMap[item.staffName] || 0) + Number(item.lineTotal || 0);
    });
  });
  const topStaff = Object.entries(staffMap)
    .map(([name, revenue]) => ({ name, revenue }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  res.json({
    revenueSplit,
    trendLine:   Object.values(dateMap),
    topServices,
    topStaff,
    summary: {
      totalInvoices: invoices.length,
      totalRevenue:  totalRev,
      avgBillValue:  invoices.length ? Math.round(totalRev / invoices.length) : 0,
    }
  });
});






registerPhase2OwnerRoutes(ownerRouter);
registerPhase3OwnerRoutes(ownerRouter);
registerPhase4OwnerRoutes(ownerRouter);

ownerRouter.post("/settings/crm-segment-preview", requireSalonPermission("settings", "view"), async (req, res) => {
  res.json({ count: 0, sample: [] });
});

ownerRouter.get("/expenses/accounts", requireSalonPermission("expenses", "view"), async (req, res) => {
  res.json({ injections: [] });
});

ownerRouter.post("/expenses/accounts/injections", requireSalonPermission("expenses", "create"), async (req, res) => {
  res.status(201).json({ id: "inj_123", amount: req.body.amount });
});

ownerRouter.get("/customers/:id/advance-payments", requireSalonPermission("customers", "view"), async (req, res) => {
  try {
    const appointments = await prisma.appointment.findMany({
      where: { salonId: req.salonId, customerId: req.params.id, advancePaidAmount: { gt: 0 } },
      select: { id: true, advancePaidAmount: true, createdAt: true, status: true, note: true },
      orderBy: { createdAt: "desc" }
    });
    res.json(appointments.map(a => ({
      id: a.id,
      amount: Number(a.advancePaidAmount),
      mode: "Online",
      remark: a.note || "",
      createdAt: a.createdAt,
      type: a.status === "CANCELLED" ? "refunded" : "advance"
    })));
  } catch (error) {
    res.status(500).json({ error: "Failed to load advance payments" });
  }
});

ownerRouter.post("/advance-payments", requireSalonPermission("customers", "create"), async (req, res) => {
  try {
    const { customerId, amount, mode, remark } = req.body;
    if (!customerId || !amount) return res.status(400).json({ error: "customerId and amount are required" });
    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return res.status(400).json({ error: "Invalid amount" });
    const customer = await prisma.customer.findFirst({ where: { id: customerId, salonId: req.salonId } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    const appointment = await prisma.appointment.create({
      data: {
        salonId: req.salonId,
        customerId,
        branchId: null,
        startAt: new Date(),
        endAt: new Date(),
        status: "CONFIRMED",
        advancePaidAmount: numericAmount,
        advancePaymentRequired: true,
        note: remark || `Advance payment: ${numericAmount} (${mode || "Online"})`
      }
    });
    res.json({ id: appointment.id, amount: numericAmount, mode: mode || "Online", remark: remark || "", createdAt: appointment.createdAt });
  } catch (error) {
    res.status(500).json({ error: "Failed to create advance payment" });
  }
});
