import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Starting database clean up...");
  try {
    // Delete in order to satisfy FK constraints
    const history = await prisma.subscriptionHistory.deleteMany({});
    console.log(`Deleted ${history.count} subscription history records.`);

    const subs = await prisma.subscription.deleteMany({});
    console.log(`Deleted ${subs.count} subscriptions.`);

    const userSalons = await prisma.userSalon.deleteMany({});
    console.log(`Deleted ${userSalons.count} userSalon links.`);

    // Delete users that are NOT super admins so they don't lock out
    const users = await prisma.user.deleteMany({
      where: {
        systemRole: { not: "SUPER_ADMIN" }
      }
    });
    console.log(`Deleted ${users.count} salon users.`);

    const salons = await prisma.salon.deleteMany({});
    console.log(`Deleted ${salons.count} salons.`);

    const plans = await prisma.plan.deleteMany({});
    console.log(`Deleted ${plans.count} plans.`);

    console.log("✨ Database successfully cleaned up!");
  } catch (error) {
    console.error("❌ Error cleaning database:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
