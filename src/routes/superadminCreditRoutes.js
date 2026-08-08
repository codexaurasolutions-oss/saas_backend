import express from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireSuperAdmin } from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

// 1. Get all Salons with their credit balances
router.get("/salons", async (req, res) => {
  try {
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
  } catch (error) {
    console.error("Error fetching salon credits:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2. Get all Credit Packages
router.get("/packages", async (req, res) => {
  try {
    const packages = await prisma.creditPackage.findMany({
      orderBy: { credits: "asc" }
    });
    res.json(packages);
  } catch (error) {
    console.error("Error fetching credit packages:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3. Create or update a Credit Package
router.post("/packages", async (req, res) => {
  const { name, credits, priceInPaise, description, isActive } = req.body;
  try {
    if (!name || !credits || !priceInPaise) {
      return res.status(400).json({ error: "Name, credits, and price are required." });
    }

    const pkg = await prisma.creditPackage.upsert({
      where: { name },
      update: { credits, priceInPaise, description, isActive },
      create: { name, credits, priceInPaise, description, isActive }
    });

    res.json({ message: "Package saved successfully", package: pkg });
  } catch (error) {
    console.error("Error saving credit package:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 4. Manually add credits to a salon (by Superadmin)
router.post("/add-credits", async (req, res) => {
  const { salonId, creditsToAdd, reason } = req.body;
  try {
    if (!salonId || !creditsToAdd) {
      return res.status(400).json({ error: "Salon ID and credits are required." });
    }

    const updatedSalon = await prisma.salon.update({
      where: { id: salonId },
      data: {
        credits: { increment: parseInt(creditsToAdd) }
      }
    });

    // Log this as a free manual transaction
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
  } catch (error) {
    console.error("Error adding credits:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 5. Get recent credit transactions across all salons
router.get("/transactions", async (req, res) => {
  try {
    const transactions = await prisma.creditTransaction.findMany({
      include: {
        salon: { select: { id: true, name: true } }
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });
    res.json(transactions);
  } catch (error) {
    console.error("Error fetching credit transactions:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 6. Get credit costs
router.get("/costs", async (req, res) => {
  try {
    const globalSetting = await prisma.globalSetting.findFirst();
    const defaults = globalSetting?.notificationDefaults || {};
    res.json({
      whatsappCreditCost: defaults.whatsappCreditCost !== undefined ? Number(defaults.whatsappCreditCost) : 1,
      smsCreditCost: defaults.smsCreditCost !== undefined ? Number(defaults.smsCreditCost) : 1
    });
  } catch (error) {
    console.error("Error fetching credit costs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 7. Update credit costs
router.post("/costs", async (req, res) => {
  const { whatsappCreditCost, smsCreditCost } = req.body;
  try {
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
  } catch (error) {
    console.error("Error updating credit costs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
