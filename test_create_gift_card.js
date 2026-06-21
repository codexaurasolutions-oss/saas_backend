import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function run() {
  try {
    const salon = await prisma.salon.findFirst();
    const customer = await prisma.customer.findFirst();
    console.log("Using Salon:", salon.id);
    console.log("Using Customer:", customer.id);

    const code = "GC-TEST-" + Math.floor(100000 + Math.random() * 900000);
    const row = await prisma.giftCard.create({
      data: {
        salonId: salon.id,
        issuedToCustomerId: customer.id,
        code,
        title: "Test Gift Card",
        originalAmount: 1000,
        balanceAmount: 1000,
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        isActive: true
      }
    });
    console.log("Success! Created gift card:", row);
  } catch (error) {
    console.error("Error creating gift card:", error);
  }
}

run().finally(() => prisma.$disconnect());
