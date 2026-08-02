// Test: list all super admin users on Railway DB to confirm which email works
process.env.DATABASE_URL = "postgresql://postgres:JdhbWCdhtdyYUChGZclqHSeYZZhGKIKl@metro.proxy.rlwy.net:23204/railway";
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  try {
    const users = await prisma.user.findMany({
      where: { systemRole: "SUPER_ADMIN" },
      select: { id: true, email: true, name: true, isActive: true, createdAt: true }
    });
    console.log("SUPER_ADMIN users on Railway DB:");
    console.table(users);
    
    // Also check plans currently in DB
    const plans = await prisma.plan.findMany({
      select: { id: true, name: true, monthlyPrice: true, createdAt: true }
    });
    console.log("\nExisting plans:");
    console.table(plans);
  } catch(err) {
    console.error("Error:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}
main();
