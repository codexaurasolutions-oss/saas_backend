process.env.DATABASE_URL = "postgresql://postgres:JdhbWCdhtdyYUChGZclqHSeYZZhGKIKl@metro.proxy.rlwy.net:23204/railway";
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function main() {
  try {
    const email = "superadmin_test_12345@test.com";
    const passwordHash = await bcrypt.hash("password123", 10);
    
    let user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.user.update({
        where: { email },
        data: { passwordHash, systemRole: "SUPER_ADMIN" }
      });
      console.log("Updated existing user");
    } else {
      await prisma.user.create({
        data: {
          name: "Super Admin Test",
          email,
          passwordHash,
          systemRole: "SUPER_ADMIN"
        }
      });
      console.log("Created new user");
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}
main();
