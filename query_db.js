import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function run() {
  console.log("Fetching users...");
  const users = await prisma.user.findMany({
    select: { id: true, email: true, systemRole: true }
  });
  console.log("Users:", JSON.stringify(users, null, 2));

  console.log("Fetching salon settings...");
  const settings = await prisma.salonSetting.findMany({
    select: { id: true, salonId: true, branchId: true, advancedSettings: true }
  });
  console.log("Salon Settings:", JSON.stringify(settings, null, 2));

  console.log("Fetching gift cards...");
  const giftCards = await prisma.giftCard.findMany({
    take: 10,
    orderBy: { createdAt: "desc" }
  });
  console.log("Gift Cards:", JSON.stringify(giftCards, null, 2));
}

run().finally(() => prisma.$disconnect());
