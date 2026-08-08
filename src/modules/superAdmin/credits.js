import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../lib/async-handler.js";

export const superAdminCreditsRouter = Router();

// 1. Get all Salons with their credit balances
superAdminCreditsRouter.get("/salons", asyncHandler(async (req, res) => {
  const salons = await prisma.salon.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      credits: true,
      createdAt: true
    },
    orderBy: { createdAt: "desc" }
  });
  res.json(salons);
}));

// 2. Get all Credit Packages
superAdminCreditsRouter.get("/packages", asyncHandler(async (req, res) => {
  const packages = await prisma.creditPackage.findMany({
    orderBy: { credits: "asc" }
  });
  res.json(packages.map(p => ({ ...p, price: p.priceInPaise / 100 })));
}));

// 3. Create or update a Credit Package
superAdminCreditsRouter.post("/packages", asyncHandler(async (req, res) => {
  const { name, credits, price, description, isActive } = req.body;
  
  if (!name || !credits || price === undefined) {
    return res.status(400).json({ message: "Name, credits, and price are required." });
  }

  const pkg = await prisma.creditPackage.create({
    data: { 
      name, 
      credits: Number(credits), 
      priceInPaise: Math.round(Number(price) * 100), 
      description: description || null, 
      isActive: isActive !== undefined ? isActive : true 
    }
  });
  res.status(201).json({ ...pkg, price: pkg.priceInPaise / 100 });
}));

// 3b. Update package
superAdminCreditsRouter.patch("/packages/:id", asyncHandler(async (req, res) => {
  const pkg = await prisma.creditPackage.findUnique({ where: { id: req.params.id } });
  if (!pkg) return res.status(404).json({ message: "Package not found" });
  
  const { price, ...rest } = req.body;
  const updateData = { ...rest };
  if (price !== undefined) {
    updateData.priceInPaise = Math.round(Number(price) * 100);
  }
  
  const updated = await prisma.creditPackage.update({ where: { id: pkg.id }, data: updateData });
  res.json({ ...updated, price: updated.priceInPaise / 100 });
}));

// 3c. Delete package
superAdminCreditsRouter.delete("/packages/:id", asyncHandler(async (req, res) => {
  const pkg = await prisma.creditPackage.findUnique({ where: { id: req.params.id } });
  if (!pkg) return res.status(404).json({ message: "Package not found" });
  await prisma.creditPackage.delete({ where: { id: pkg.id } });
  res.json({ message: "Package deleted" });
}));


// 4. Manually add credits to a salon (by Superadmin)
superAdminCreditsRouter.post("/add-credits", asyncHandler(async (req, res) => {
  const { salonId, creditsToAdd, reason } = req.body;
  if (!salonId || !creditsToAdd) {
    return res.status(400).json({ message: "Salon ID and credits are required." });
  }

  const updatedSalon = await prisma.salon.update({
    where: { id: salonId },
    data: {
      credits: { increment: parseInt(creditsToAdd) }
    }
  });

  await prisma.creditTransaction.create({
    data: {
      salonId,
      packageName: "MANUAL_ADD",
      credits: parseInt(creditsToAdd),
      amountPaidPaise: 0,
      status: "COMPLETED"
    }
  });

  res.json({ message: "Credits added successfully", credits: updatedSalon.credits });
}));

// 5. Get recent credit transactions across all salons
superAdminCreditsRouter.get("/transactions", asyncHandler(async (req, res) => {
  const transactions = await prisma.creditTransaction.findMany({
    include: {
      salon: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json(transactions);
}));

// 6. Get credit costs
superAdminCreditsRouter.get("/costs", asyncHandler(async (req, res) => {
  const globalSetting = await prisma.globalSetting.findFirst();
  const defaults = globalSetting?.notificationDefaults || {};
  res.json({
    whatsappCreditCost: defaults.whatsappCreditCost !== undefined ? Number(defaults.whatsappCreditCost) : 1,
    smsCreditCost: defaults.smsCreditCost !== undefined ? Number(defaults.smsCreditCost) : 1
  });
}));

// 7. Update credit costs
superAdminCreditsRouter.post("/costs", asyncHandler(async (req, res) => {
  const { whatsappCreditCost, smsCreditCost } = req.body;
  
  let globalSetting = await prisma.globalSetting.findFirst();
  if (!globalSetting) {
    globalSetting = await prisma.globalSetting.create({ data: {} });
  }
  
  const currentDefaults = globalSetting.notificationDefaults || {};
  const updatedDefaults = {
    ...currentDefaults,
    whatsappCreditCost: whatsappCreditCost !== undefined ? Number(whatsappCreditCost) : currentDefaults.whatsappCreditCost,
    smsCreditCost: smsCreditCost !== undefined ? Number(smsCreditCost) : currentDefaults.smsCreditCost
  };

  await prisma.globalSetting.update({
    where: { id: globalSetting.id },
    data: { notificationDefaults: updatedDefaults }
  });

  res.json({ message: "Costs updated successfully" });
}));
