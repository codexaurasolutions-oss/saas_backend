import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Starting database clean up...");
  try {
    const tables = [
      "PasswordSetupToken",
      "SubscriptionHistory",
      "DemoLead",
      "CustomerTimeline",
      "CustomerMembership",
      "CustomerPackage",
      "PackageService",
      "MembershipPlanService",
      "InvoiceItem",
      "Payment",
      "Invoice",
      "AppointmentServiceStaff",
      "AppointmentService",
      "Appointment",
      "StockMovement",
      "Product",
      "ProductCategory",
      "Service",
      "ServiceCategory",
      "StaffSchedule",
      "UserSalon",
      "Branch",
      "CustomRole",
      "Subscription",
      "CatalogSetting",
      "EcommerceSetting",
      "SalonSetting",
      "User",
      "Salon",
      "Plan"
    ];

    for (const table of tables) {
      try {
        await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
        console.log(`Truncated table: ${table}`);
      } catch (e) {
        try {
          await prisma[table].deleteMany({});
          console.log(`Deleted many on table: ${table}`);
        } catch (err) {
          console.log(`Skipped or errored table: ${table}`);
        }
      }
    }

    console.log("Creating default Super Admin user...");
    const superAdminEmail = "superadmin@respark.local";
    await prisma.user.create({
      data: {
        email: superAdminEmail,
        name: "Super Admin",
        systemRole: "SUPER_ADMIN",
        passwordHash: await bcrypt.hash("Admin@123", 10)
      }
    });

    console.log("✨ Database successfully wiped! Only Super Admin remains.");
  } catch (error) {
    console.error("❌ Error cleaning database:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
