import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { validate, schemas } from "../../middlewares/validate.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { registerPublicPhase3Routes } from "./phase3.js";

export const publicRouter = Router();

publicRouter.get("/settings", asyncHandler(async (req, res) => {
  const settings = await prisma.globalSetting.findFirst();
  res.json(
    settings || {
      systemName: "Skillify ERP",
      maintenanceMode: false,
      whatsappNumber: "+919876543210",
      contactEmail: "hello@skillify.local",
      supportEmail: "support@skillify.local",
      defaultCurrency: "INR",
      currencyOptions: ["INR", "USD", "AED"],
      defaultCountry: "Pakistan",
      defaultCity: "Lahore",
      termsUrl: "/terms",
      privacyUrl: "/privacy",
      demoBookingUrl: "",
      blogTitle: "Skillify Operations Workspace",
      blogIntro: "Manage services, appointments, billing, customers, and team workflows from one focused salon portal."
    },
    
  );
}));

publicRouter.get("/salon/:slug", asyncHandler(async (req, res) => {
  const salon = await prisma.salon.findUnique({ 
    where: { slug: req.params.slug },
    include: {
      catalogSettings: true,
      ecommerceSettings: true,
      settings: { where: { branchId: null }, take: 1 }
    }
  });
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const catalogSettings = salon.catalogSettings.find((item) => item.branchId === null) || salon.catalogSettings[0] || null;
  if (catalogSettings?.catalogEnabled === false) return res.status(403).json({ message: "Public catalog is disabled for this salon" });

  const ecommerceSettings = salon.ecommerceSettings[0] || null;
  const salonSettings = salon.settings[0] || null;
  const genericSettings = typeof salonSettings?.advancedSettings === "object"
    ? salonSettings.advancedSettings?.genericSettings || {}
    : {};
  const legalContent = typeof salonSettings?.advancedSettings === "object"
    ? salonSettings.advancedSettings?.legalContent || {}
    : {};
  const uiSettings = typeof salonSettings?.advancedSettings === "object"
    ? salonSettings.advancedSettings?.uiSettings || {}
    : {};
  const footerContent = typeof salonSettings?.advancedSettings === "object"
    ? salonSettings.advancedSettings?.footerContent || {}
    : {};
  const websiteConfig = typeof salon.featureFlags === "object" && salon.featureFlags?.websiteConfig && typeof salon.featureFlags.websiteConfig === "object"
    ? salon.featureFlags.websiteConfig
    : {};
  const showServices = catalogSettings?.showServices !== false;
  const showProducts = catalogSettings?.showProducts !== false && ecommerceSettings?.storeEnabled === true;

  const [services, products] = await Promise.all([
    showServices ? prisma.service.findMany({ where: { salonId: salon.id, isActive: true, isPublicVisible: true } }) : [],
    showProducts ? prisma.product.findMany({ where: { salonId: salon.id, isActive: true, isOnlineVisible: true }, include: { category: true, branch: true } }) : []
  ]);
  res.json({
    salon: { ...salon, settings: undefined, catalogSettings: undefined, ecommerceSettings: undefined },
    services,
    products,
    websiteConfig: {
      heroTitle: String(websiteConfig.heroTitle || ""),
      heroSubtitle: String(websiteConfig.heroSubtitle || ""),
      heroImage: String(websiteConfig.heroImage || "")
    },
    genericSettings,
    legalContent,
    uiSettings,
    footerContent,
    catalogSettings,
    ecommerceSettings,
    visibility: {
      services: showServices,
      products: showProducts,
      packages: catalogSettings?.showPackages !== false,
      memberships: catalogSettings?.showMemberships !== false,
      staff: catalogSettings?.showStaffPortfolio !== false
    }
  });
}));

registerPublicPhase3Routes(publicRouter);

publicRouter.get("/plans", asyncHandler(async (req, res) => {
  const plans = await prisma.plan.findMany({ orderBy: { monthlyPrice: "asc" } });
  res.json(plans.length ? plans.slice(0, 1) : [
    { id: "starter", name: "Standard Plan", monthlyPrice: 4999, yearlyPrice: 49990, trialDays: 7, branchLimit: 99999, userLimit: 9999, customerLimit: 99999, invoiceLimit: 99999, storageLimit: 999 }
  ]);
}));

publicRouter.post("/demo-leads", validate(schemas.demoLead), asyncHandler(async (req, res) => {
  const { name, email, phone, company, message } = req.body;
  const lead = await prisma.demoLead.create({
    data: { name, email, phone, company, message, status: "PENDING" }
  });
  res.status(201).json(lead);
}));

publicRouter.get("/demo-checkout-info/:leadId/:planId", asyncHandler(async (req, res) => {
  const lead = await prisma.demoLead.findUnique({ where: { id: req.params.leadId } });
  if (!lead) return res.status(404).json({ message: "Demo lead not found" });
  const plan = await prisma.plan.findUnique({ where: { id: req.params.planId } });
  if (!plan) return res.status(404).json({ message: "Plan not found" });
  res.json({
    leadName: lead.name,
    leadEmail: lead.email,
    company: lead.company,
    planName: plan.name,
    price: plan.monthlyPrice,
    limits: {
      branches: plan.branchLimit,
      users: plan.userLimit,
      customers: plan.customerLimit,
      invoices: plan.invoiceLimit
    }
  });
}));

publicRouter.post("/demo-checkout/:leadId", asyncHandler(async (req, res) => {
  const lead = await prisma.demoLead.findUnique({ where: { id: req.params.leadId } });
  if (!lead) return res.status(404).json({ message: "Demo lead not found" });
  const { planId, paymentSessionId } = req.body;
  const updated = await prisma.demoLead.update({
    where: { id: req.params.leadId },
    data: {
      paymentCompleted: true,
      paymentSessionId: paymentSessionId || `demo_pay_${Date.now()}`,
      selectedPlanId: planId || lead.selectedPlanId
    }
  });
  res.json({ ok: true, lead: updated });
}));

// SECURITY: The following 3 debug endpoints have been REMOVED from production.
// They previously allowed anyone with the hardcoded key "respark123" to:
//   1. /public/debug-db       - read all users, settings, gift cards
//   2. /public/debug-code     - read source code (security disclosure)
//   3. /public/run-seed-services - WIPE all services & categories and re-seed
// These endpoints were removed for security reasons.
// If you need to seed services, use the seeder script in prisma/seed/seed.js instead.
