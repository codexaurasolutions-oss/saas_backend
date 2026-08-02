const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const prisma = new PrismaClient();

async function main() {
  try {
    const email = "superadmin_test_12345@test.com";
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          name: "Super Admin Test",
          email,
          passwordHash: await bcrypt.hash("password123", 10),
          systemRole: "SUPER_ADMIN"
        }
      });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, systemRole: user.systemRole },
      process.env.JWT_SECRET || "fallback_secret",
      { expiresIn: "1h" }
    );

    console.log("Got token");

    const payload = {
      name: "Test API Salon 123",
      slug: "test-api-salon-123",
      businessType: "Salon",
      email: "",
      phone: "",
      address: "",
      taxRate: 0,
      trialStartsAt: "",
      trialEndsAt: "",
      internalNote: "",
      ownerName: "",
      ownerEmail: "",
      ownerPassword: "",
      featureFlags: { pos: true, crm: true }
    };

    // Use local server if running, or direct logic.
    // Let's just try to hit the Railway backend with the token! 
    // Wait, the Railway backend might have a different JWT_SECRET!
    // If it has a different JWT_SECRET, our token will fail with 401.
    const res = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/super-admin/salons", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error("API Error:", res.status, data);
    } else {
      const data = await res.json();
      console.log("Success:", data);
    }
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}
main();
