import express from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireSalonRole } from "../middleware/authMiddleware.js";

const router = express.Router();
router.use(requireAuth);

let razorpayInstance = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpayInstance = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
}

// 1. Get active packages
router.get("/packages", requireSalonRole(["SALON_OWNER"]), async (req, res) => {
  try {
    const packages = await prisma.creditPackage.findMany({
      where: { isActive: true },
      orderBy: { credits: "asc" }
    });
    res.json(packages);
  } catch (error) {
    console.error("Error fetching credit packages:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 2. Get current credits & transactions
router.get("/status", requireSalonRole(["SALON_OWNER"]), async (req, res) => {
  try {
    const salon = await prisma.salon.findUnique({
      where: { id: req.salonId },
      select: { credits: true }
    });

    const transactions = await prisma.creditTransaction.findMany({
      where: { salonId: req.salonId },
      orderBy: { createdAt: "desc" },
      take: 20
    });

    res.json({ credits: salon?.credits || 0, transactions });
  } catch (error) {
    console.error("Error fetching credit status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 3. Create Razorpay order
router.post("/create-order", requireSalonRole(["SALON_OWNER"]), async (req, res) => {
  const { packageName } = req.body;
  try {
    if (!razorpayInstance) return res.status(500).json({ error: "Payment gateway not configured" });

    const pkg = await prisma.creditPackage.findUnique({ where: { name: packageName } });
    if (!pkg || !pkg.isActive) {
      return res.status(400).json({ error: "Invalid or inactive credit package" });
    }

    const order = await razorpayInstance.orders.create({
      amount: pkg.priceInPaise,
      currency: "INR",
      receipt: `receipt_credit_${Date.now()}`
    });

    // Create a pending transaction
    const transaction = await prisma.creditTransaction.create({
      data: {
        salonId: req.salonId,
        packageName: pkg.name,
        credits: pkg.credits,
        amountPaidPaise: pkg.priceInPaise,
        razorpayOrderId: order.id,
        status: "PENDING"
      }
    });

    res.json({ order, transactionId: transaction.id });
  } catch (error) {
    console.error("Error creating credit order:", error);
    res.status(500).json({ error: "Failed to create order" });
  }
});

// 4. Verify Razorpay payment
router.post("/verify-payment", requireSalonRole(["SALON_OWNER"]), async (req, res) => {
  const { transactionId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  try {
    const transaction = await prisma.creditTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction || transaction.status !== "PENDING") {
      return res.status(400).json({ error: "Invalid transaction" });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      await prisma.creditTransaction.update({
        where: { id: transactionId },
        data: { status: "FAILED" }
      });
      return res.status(400).json({ error: "Payment verification failed" });
    }

    // Payment is valid, update transaction & add credits
    await prisma.$transaction([
      prisma.creditTransaction.update({
        where: { id: transactionId },
        data: {
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          status: "COMPLETED"
        }
      }),
      prisma.salon.update({
        where: { id: transaction.salonId },
        data: { credits: { increment: transaction.credits } }
      })
    ]);

    // Fetch updated credits to return
    const updatedSalon = await prisma.salon.findUnique({
      where: { id: transaction.salonId },
      select: { credits: true }
    });

    res.json({ success: true, credits: updatedSalon.credits });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
