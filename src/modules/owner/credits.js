import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireSystemRole } from "../../middlewares/rbac.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { addCredits } from "../../lib/credits.js";
import Razorpay from "razorpay";

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET_KEY
});

export const creditsRouter = Router();

// ─── Super Admin: Manage Credit Packages ───────────────────────────
creditsRouter.get("/packages", requireAuth, requireSystemRole("SUPER_ADMIN"), asyncHandler(async (req, res) => {
  const packages = await prisma.creditPackage.findMany({ orderBy: { createdAt: "desc" } });
  res.json(packages);
}));

creditsRouter.post("/packages", requireAuth, requireSystemRole("SUPER_ADMIN"), asyncHandler(async (req, res) => {
  const { name, credits, priceInPaise, description } = req.body;
  if (!name || !credits || !priceInPaise) {
    return res.status(400).json({ message: "Name, credits, and price are required" });
  }
  const pkg = await prisma.creditPackage.create({
    data: { name, credits: Number(credits), priceInPaise: Number(priceInPaise), description: description || null }
  });
  res.status(201).json(pkg);
}));

creditsRouter.patch("/packages/:id", requireAuth, requireSystemRole("SUPER_ADMIN"), asyncHandler(async (req, res) => {
  const pkg = await prisma.creditPackage.findUnique({ where: { id: req.params.id } });
  if (!pkg) return res.status(404).json({ message: "Package not found" });
  const updated = await prisma.creditPackage.update({ where: { id: pkg.id }, data: req.body });
  res.json(updated);
}));

creditsRouter.delete("/packages/:id", requireAuth, requireSystemRole("SUPER_ADMIN"), asyncHandler(async (req, res) => {
  const pkg = await prisma.creditPackage.findUnique({ where: { id: req.params.id } });
  if (!pkg) return res.status(404).json({ message: "Package not found" });
  await prisma.creditPackage.delete({ where: { id: pkg.id } });
  res.json({ message: "Package deleted" });
}));

// ─── Super Admin: View All Salon Credits ───────────────────────────
creditsRouter.get("/salons", requireAuth, requireSystemRole("SUPER_ADMIN"), asyncHandler(async (req, res) => {
  const salons = await prisma.salon.findMany({
    select: { id: true, name: true, slug: true, credits: true, status: true, createdAt: true },
    orderBy: { credits: "desc" }
  });
  res.json(salons);
}));

creditsRouter.get("/salons/:salonId/transactions", requireAuth, requireSystemRole("SUPER_ADMIN"), asyncHandler(async (req, res) => {
  const transactions = await prisma.creditTransaction.findMany({
    where: { salonId: req.params.salonId },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  res.json(transactions);
}));

// ─── Salon Owner: Get My Credits ───────────────────────────────────
creditsRouter.get("/my-credits", requireAuth, asyncHandler(async (req, res) => {
  const salonId = req.salonId || req.user?.salonId;
  if (!salonId) return res.status(400).json({ message: "No salon context" });
  const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { credits: true } });
  res.json({ credits: salon?.credits || 0 });
}));

creditsRouter.get("/my-transactions", requireAuth, asyncHandler(async (req, res) => {
  const salonId = req.salonId || req.user?.salonId;
  if (!salonId) return res.status(400).json({ message: "No salon context" });
  const transactions = await prisma.creditTransaction.findMany({
    where: { salonId },
    orderBy: { createdAt: "desc" },
    take: 50
  });
  res.json(transactions);
}));

// ─── Salon Owner: Create Razorpay Order ────────────────────────────
creditsRouter.post("/create-order", requireAuth, asyncHandler(async (req, res) => {
  const salonId = req.salonId || req.user?.salonId;
  if (!salonId) return res.status(400).json({ message: "No salon context" });

  const { packageId } = req.body;
  const pkg = await prisma.creditPackage.findUnique({ where: { id: packageId } });
  if (!pkg || !pkg.isActive) return res.status(404).json({ message: "Package not found or inactive" });

  const order = await razorpay.orders.create({
    amount: pkg.priceInPaise,
    currency: "INR",
    receipt: `credits_${salonId}_${pkg.id}_${Date.now()}`
  });

  await prisma.creditTransaction.create({
    data: {
      salonId,
      packageName: pkg.name,
      credits: pkg.credits,
      amountPaidPaise: pkg.priceInPaise,
      razorpayOrderId: order.id,
      status: "PENDING"
    }
  });

  res.json({ orderId: order.id, amount: pkg.priceInPaise, currency: "INR", key: process.env.RAZORPAY_KEY_ID });
}));

// ─── Salon Owner: Verify Payment ───────────────────────────────────
creditsRouter.post("/verify-payment", requireAuth, asyncHandler(async (req, res) => {
  const salonId = req.salonId || req.user?.salonId;
  if (!salonId) return res.status(400).json({ message: "No salon context" });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ message: "Missing payment details" });
  }

  const crypto = await import("crypto");
  const expectedSig = crypto.default.createHmac("sha256", process.env.RAZORPAY_SECRET_KEY)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  if (expectedSig !== razorpay_signature) {
    return res.status(400).json({ message: "Invalid payment signature" });
  }

  const tx = await prisma.creditTransaction.findFirst({ where: { salonId, razorpayOrderId: razorpay_order_id, status: "PENDING" } });
  if (!tx) return res.status(404).json({ message: "Transaction not found" });

  await prisma.$transaction([
    prisma.creditTransaction.update({ where: { id: tx.id }, data: { razorpayPaymentId: razorpay_payment_id, razorpaySignature: razorpay_signature, status: "COMPLETED" } }),
    prisma.salon.update({ where: { id: salonId }, data: { credits: { increment: tx.credits } } })
  ]);

  res.json({ success: true, creditsAdded: tx.credits });
}));
