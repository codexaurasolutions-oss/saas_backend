import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { validate, schemas } from "../../middlewares/validate.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { registerPublicPhase3Routes } from "./phase3.js";
import { resolvePublicSalonBySlug } from "../../lib/phase3.js";

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
  let salon = await prisma.salon.findUnique({ 
    where: { slug: req.params.slug },
    include: {
      catalogSettings: true,
      ecommerceSettings: true,
      settings: { where: { branchId: null }, take: 1 }
    }
  });
  if (!salon) {
    const customSlugSetting = await prisma.catalogSetting.findFirst({
      where: { customSlug: req.params.slug },
      select: { salonId: true }
    });
    if (customSlugSetting) {
      salon = await prisma.salon.findUnique({
        where: { id: customSlugSetting.salonId },
        include: {
          catalogSettings: true,
          ecommerceSettings: true,
          settings: { where: { branchId: null }, take: 1 }
        }
      });
    }
  }
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

  const [services, products, categories] = await Promise.all([
    showServices ? prisma.service.findMany({ where: { salonId: salon.id, isActive: true, isPublicVisible: true } }) : [],
    showProducts ? prisma.product.findMany({ where: { salonId: salon.id, isActive: true, isOnlineVisible: true }, include: { category: true, branch: true } }) : [],
    showProducts ? prisma.productCategory.findMany({ where: { salonId: salon.id, isActive: true, isPublicVisible: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }) : []
  ]);
  res.json({
    salon: { ...salon, settings: undefined, catalogSettings: undefined, ecommerceSettings: undefined },
    services,
    products,
    categories,
    websiteConfig: {
      heroTitle: String(websiteConfig.heroTitle || ""),
      heroSubtitle: String(websiteConfig.heroSubtitle || ""),
      heroImage: String(websiteConfig.heroImage || ""),
      heroBtn1Text: String(websiteConfig.heroBtn1Text || ""),
      heroBtn1Link: String(websiteConfig.heroBtn1Link || ""),
      heroBtn2Text: String(websiteConfig.heroBtn2Text || ""),
      heroBtn2Link: String(websiteConfig.heroBtn2Link || ""),
      aboutTitle: String(websiteConfig.aboutTitle || ""),
      aboutDescription: String(websiteConfig.aboutDescription || ""),
      aboutImage: String(websiteConfig.aboutImage || ""),
      aboutMission: String(websiteConfig.aboutMission || ""),
      aboutVision: String(websiteConfig.aboutVision || ""),
      galleryImages: Array.isArray(websiteConfig.galleryImages) ? websiteConfig.galleryImages : [],
      contactPhone: String(websiteConfig.contactPhone || ""),
      contactEmail: String(websiteConfig.contactEmail || ""),
      contactAddress: String(websiteConfig.contactAddress || ""),
      contactMapUrl: String(websiteConfig.contactMapUrl || ""),
      socialFacebook: String(websiteConfig.socialFacebook || ""),
      socialInstagram: String(websiteConfig.socialInstagram || ""),
      socialYoutube: String(websiteConfig.socialYoutube || ""),
      socialTiktok: String(websiteConfig.socialTiktok || ""),
      socialTwitter: String(websiteConfig.socialTwitter || ""),
      businessHours: Array.isArray(websiteConfig.businessHours) ? websiteConfig.businessHours : [],
      ctaTitle: String(websiteConfig.ctaTitle || ""),
      ctaSubtitle: String(websiteConfig.ctaSubtitle || ""),
      ctaBtnText: String(websiteConfig.ctaBtnText || ""),
      ctaBtnLink: String(websiteConfig.ctaBtnLink || ""),
      ctaImage: String(websiteConfig.ctaImage || ""),
      testimonials: Array.isArray(websiteConfig.testimonials) ? websiteConfig.testimonials : [],
      primaryColor: String(websiteConfig.primaryColor || ""),
      secondaryColor: String(websiteConfig.secondaryColor || ""),
      bannerImage: String(websiteConfig.bannerImage || ""),
      bannerTitle: String(websiteConfig.bannerTitle || ""),
      bannerSubtitle: String(websiteConfig.bannerSubtitle || ""),
      bannerBtnText: String(websiteConfig.bannerBtnText || ""),
      bannerBtnLink: String(websiteConfig.bannerBtnLink || ""),
      cardShape: String(websiteConfig.cardShape || "rounded"),
      sections: Array.isArray(websiteConfig.sections) ? websiteConfig.sections : [],
      footerText: String(websiteConfig.footerText || ""),
      salonName: String(websiteConfig.salonName || ""),
      logoUrl: String(websiteConfig.logoUrl || salon.logoUrl || "")
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

publicRouter.get("/salon/:slug/categories", asyncHandler(async (req, res) => {
  let salon = await prisma.salon.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
  if (!salon) {
    const custom = await prisma.catalogSetting.findFirst({ where: { customSlug: req.params.slug }, select: { salonId: true } });
    if (custom) salon = await prisma.salon.findUnique({ where: { id: custom.salonId }, select: { id: true } });
  }
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const categories = await prisma.productCategory.findMany({
    where: { salonId: salon.id, isActive: true, isPublicVisible: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }]
  });
  res.json(categories);
}));

publicRouter.get("/salon/:slug/products", asyncHandler(async (req, res) => {
  let salon = await prisma.salon.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
  if (!salon) {
    const custom = await prisma.catalogSetting.findFirst({ where: { customSlug: req.params.slug }, select: { salonId: true } });
    if (custom) salon = await prisma.salon.findUnique({ where: { id: custom.salonId }, select: { id: true } });
  }
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const where = { salonId: salon.id, isActive: true, isOnlineVisible: true };
  if (req.query.categoryId) where.categoryId = req.query.categoryId;
  if (req.query.search) where.name = { contains: req.query.search };
  const products = await prisma.product.findMany({
    where,
    include: { category: true, branch: true },
    orderBy: { createdAt: "desc" }
  });
  res.json(products);
}));

publicRouter.get("/salon/:slug/product/:productId", asyncHandler(async (req, res) => {
  let salon = await prisma.salon.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
  if (!salon) {
    const custom = await prisma.catalogSetting.findFirst({ where: { customSlug: req.params.slug }, select: { salonId: true } });
    if (custom) salon = await prisma.salon.findUnique({ where: { id: custom.salonId }, select: { id: true } });
  }
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const product = await prisma.product.findFirst({
    where: { id: req.params.productId, salonId: salon.id, isActive: true },
    include: { category: true, branch: true }
  });
  if (!product) return res.status(404).json({ message: "Product not found" });
  res.json(product);
}));

// Public order tracking — customer can track order by order number + phone/email
publicRouter.get("/salon/:slug/track-order", asyncHandler(async (req, res) => {
  let salon = await prisma.salon.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
  if (!salon) {
    const custom = await prisma.catalogSetting.findFirst({ where: { customSlug: req.params.slug }, select: { salonId: true } });
    if (custom) salon = await prisma.salon.findUnique({ where: { id: custom.salonId }, select: { id: true } });
  }
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const { orderNumber, phone, email } = req.query;
  if (!orderNumber) return res.status(400).json({ message: "Order number is required" });
  const where = { salonId: salon.id, orderNumber: String(orderNumber) };
  if (phone) where.customerPhone = String(phone);
  if (email) where.customerEmail = String(email);
  const order = await prisma.onlineOrder.findFirst({
    where,
    include: {
      items: { include: { product: true } },
      logs: { orderBy: { createdAt: "asc" } }
    }
  });
  if (!order) return res.status(404).json({ message: "Order not found. Please check your order number and contact details." });
  res.json({
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.total,
    createdAt: order.createdAt,
    completedAt: order.completedAt,
    items: order.items.map(i => ({
      name: i.product?.name || i.name,
      qty: i.qty,
      price: i.price
    })),
    timeline: order.logs.map(l => ({
      status: l.toStatus,
      note: l.note,
      createdAt: l.createdAt
    }))
  });
}));

// Public enquiry submission
publicRouter.post("/salon/:slug/enquiry", asyncHandler(async (req, res) => {
  let salon = await prisma.salon.findUnique({ where: { slug: req.params.slug }, select: { id: true } });
  if (!salon) {
    const custom = await prisma.catalogSetting.findFirst({ where: { customSlug: req.params.slug }, select: { salonId: true } });
    if (custom) salon = await prisma.salon.findUnique({ where: { id: custom.salonId }, select: { id: true } });
  }
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const { name, email, phone, message } = req.body;
  if (!name || !email || !phone || !message) return res.status(400).json({ message: "Name, email, phone, and message are required" });
  const enquiry = await prisma.enquiry.create({
    data: { salonId: salon.id, name, email, phone, message, source: "WEBSITE" }
  });
  res.status(201).json({ ok: true, id: enquiry.id });
}));

publicRouter.post("/salon/:slug/track", asyncHandler(async (req, res) => {
  const { slug } = req.params;
  const salon = await resolvePublicSalonBySlug(slug);
  if (!salon) return res.status(404).json({ message: "Salon not found" });
  const { path } = req.body;
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null;
  const userAgent = req.headers["user-agent"] || null;
  const referrer = req.headers["referer"] || null;
  await prisma.websiteVisit.create({
    data: { salonId: salon.id, path: path || "/", ip, userAgent, referrer }
  });
  res.json({ ok: true });
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

publicRouter.post("/demo-checkout/:leadId/razorpay-order", asyncHandler(async (req, res) => {
  const { planId } = req.body;
  const lead = await prisma.demoLead.findUnique({ where: { id: req.params.leadId } });
  if (!lead) return res.status(404).json({ message: "Demo lead not found" });
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) return res.status(404).json({ message: "Plan not found" });

  const keyId = process.env.RAZORPAY_KEY_ID || "rzp_test_TAAtuWKFZfp0f3";
  const keySecret = process.env.RAZORPAY_SECRET_KEY || "kVhUs2zxmiveVbdkRDfPtnOQ";

  const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  const response = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": authHeader
    },
    body: JSON.stringify({
      amount: plan.monthlyPrice * 100, // in Paise
      currency: "INR",
      receipt: `rcpt_${lead.id.substring(0, 8)}_${Date.now().toString().substring(8)}`
    })
  });

  if (!response.ok) {
    const errorData = await response.json();
    console.error("Razorpay Order Error:", errorData);
    return res.status(400).json({ message: errorData.error?.description || "Razorpay order creation failed" });
  }

  const order = await response.json();
  res.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: keyId,
    leadName: lead.name,
    leadEmail: lead.email,
    leadPhone: lead.phone
  });
}));

publicRouter.post("/demo-checkout/verify-razorpay", asyncHandler(async (req, res) => {
  const { leadId, planId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
  
  const keySecret = process.env.RAZORPAY_SECRET_KEY || "kVhUs2zxmiveVbdkRDfPtnOQ";
  
  const { default: crypto } = await import("node:crypto");
  const generated_signature = crypto
    .createHmac("sha256", keySecret)
    .update(razorpayOrderId + "|" + razorpayPaymentId)
    .digest("hex");

  if (generated_signature === razorpaySignature) {
    // 1. Mark payment completed on the lead
    const lead = await prisma.demoLead.update({
      where: { id: leadId },
      data: {
        paymentCompleted: true,
        paymentSessionId: razorpayPaymentId,
        selectedPlanId: planId
      }
    });

    // 2. Automate lead approval and workspace provisioning
    const { approveDemoLead } = await import("../../lib/demoInvites.js");
    const result = await approveDemoLead({
      leadId,
      actorName: "System Auto-Approval (Paid Checkout)",
      planId,
      trialDays: 30,
      salonName: lead.company || lead.name,
      businessType: "Salon",
      reviewNote: "Automated paid checkout setup via Razorpay"
    });

    res.json({
      ok: true,
      setupToken: result.rawToken,
      loginAccessToken: result.loginAccessToken,
      email: lead.email
    });
  } else {
    res.status(400).json({ message: "Payment verification failed. Invalid signature." });
  }
}));

// SECURITY: The following 3 debug endpoints have been REMOVED from production.
// They previously allowed anyone with the hardcoded key "respark123" to:
//   1. /public/debug-db       - read all users, settings, gift cards
//   2. /public/debug-code     - read source code (security disclosure)
//   3. /public/run-seed-services - WIPE all services & categories and re-seed
// These endpoints were removed for security reasons.
// If you need to seed services, use the seeder script in prisma/seed/seed.js instead.
