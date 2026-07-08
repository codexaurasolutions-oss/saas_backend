import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const updatedSalons = await prisma.salon.updateMany({
    where: { status: "TRIAL" },
    data: { status: "ACTIVE", trialStartsAt: null, trialEndsAt: null }
  });
  console.log("Updated Salons count:", updatedSalons.count);
  const updatedSubs = await prisma.subscription.updateMany({
    where: { status: "TRIAL" },
    data: { status: "ACTIVE", paymentStatus: "PAID" }
  });
  console.log("Updated Subscriptions count:", updatedSubs.count);
}
main().catch(console.error).finally(() => prisma.$disconnect());
