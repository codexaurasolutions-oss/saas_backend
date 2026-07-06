import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { defaultOwnerPermissions } from "../src/lib/permissions.js";

const prisma = new PrismaClient();

async function main() {
  console.log("Creating new Salon Owner and Salon Workspace...");
  try {
    const email = "owner@respark.local";
    const password = "Owner@123";

    // 1. Ensure a plan exists
    let plan = await prisma.plan.findFirst();
    if (!plan) {
      plan = await prisma.plan.create({
        data: {
          name: "Standard",
          monthlyPrice: 4999,
          yearlyPrice: 49990,
          trialDays: 7,
          branchLimit: 5,
          userLimit: 10,
          customerLimit: 1000,
          invoiceLimit: 2000,
          storageLimit: 10,
          featureFlags: { pos: true, crm: true, reports: true, publicCatalog: true }
        }
      });
      console.log("Created default Plan.");
    }

    // 2. Create Salon
    const salon = await prisma.salon.create({
      data: {
        name: "Krishn Salon",
        slug: "krishn-salon",
        businessType: "Salon",
        email: "salon@krishn.com",
        phone: "+919999988888",
        city: "Delhi",
        country: "India",
        currency: "INR",
        taxRate: 18,
        status: "ACTIVE",
        featureFlags: { pos: true, appointments: true, inventory: true, reports: true, publicCatalog: true }
      }
    });
    console.log("Created Salon: Krishn Salon (slug: krishn-salon)");

    // 3. Create Subscription
    await prisma.subscription.create({
      data: {
        salonId: salon.id,
        planId: plan.id,
        status: "ACTIVE",
        paymentStatus: "PAID",
        startsAt: new Date(),
        endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      }
    });
    console.log("Created Active Subscription.");

    // 4. Create Owner User
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        name: "Krishn Pal",
        systemRole: "SALON_USER",
        passwordHash,
        isActive: true
      }
    });
    console.log(`Created Owner User: ${email}`);

    // 5. Connect User to Salon
    await prisma.userSalon.create({
      data: {
        userId: user.id,
        salonId: salon.id,
        salonRole: "SALON_OWNER",
        permissions: defaultOwnerPermissions
      }
    });
    console.log("Connected User to Salon as SALON_OWNER.");

    console.log("✨ Done!");
  } catch (error) {
    console.error("❌ Error creating owner:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
