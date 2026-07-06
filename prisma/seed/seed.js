import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { defaultOwnerPermissions } from "../../src/lib/permissions.js";

const prisma = new PrismaClient();

async function main() {
  const superAdminEmail = "superadmin@respark.local";
  const ownerEmail = "owner@respark.local";

  console.log("Cleaning up existing database records...");

  // Safely delete previous records to ensure a fresh, clean, robust seed state
  const deleteTable = async (table) => {
    try {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE;`);
    } catch (e) {
      try {
        await prisma[table].deleteMany({});
      } catch (err) {
        // Table might not exist or be empty
      }
    }
  };

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
    await deleteTable(table);
  }

  console.log("Seeding plans...");

  const starterPlan = await prisma.plan.create({
    data: {
      name: "Starter",
      monthlyPrice: 4999,
      yearlyPrice: 49990,
      trialDays: 7,
      branchLimit: 9999,
      userLimit: 5,
      customerLimit: 500,
      invoiceLimit: 1000,
      storageLimit: 5,
      featureFlags: { pos: true, crm: true, reports: true, publicCatalog: true, digitalCatalog: true, customerPortal: true, ecommerce: true, onlineOrders: true, campaigns: true, messageTemplates: true, catalogAnalytics: true }
    }
  });

  const growthPlan = await prisma.plan.create({
    data: {
      name: "Growth",
      monthlyPrice: 9999,
      yearlyPrice: 99990,
      trialDays: 7,
      branchLimit: 9999,
      userLimit: 20,
      customerLimit: 3000,
      invoiceLimit: 10000,
      storageLimit: 20,
      featureFlags: { pos: true, crm: true, reports: true, publicCatalog: true, whatsapp: true, digitalCatalog: true, customerPortal: true, ecommerce: true, onlineOrders: true, campaigns: true, messageTemplates: true, catalogAnalytics: true }
    }
  });

  console.log("Seeding users...");

  const superAdmin = await prisma.user.create({
    data: {
      email: superAdminEmail,
      name: "Super Admin",
      systemRole: "SUPER_ADMIN",
      passwordHash: await bcrypt.hash("Admin@123", 10)
    }
  });

  const owner = await prisma.user.create({
    data: {
      email: ownerEmail,
      name: "Salon Owner",
      systemRole: "SALON_USER",
      passwordHash: await bcrypt.hash("Owner@123", 10)
    }
  });

  console.log("Seeding salon...");

  const salon = await prisma.salon.create({
    data: {
      name: "Demo Salon",
      slug: "demo-salon",
      businessType: "Salon",
      email: "demo@salon.local",
      phone: "+913001112233",
      city: "Delhi",
      country: "India",
      currency: "INR",
      taxRate: 18,
      trialStartsAt: new Date(),
      trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      status: "ACTIVE",
      featureFlags: { pos: true, appointments: true, inventory: true, reports: true, publicCatalog: true, digitalCatalog: true, customerPortal: true, ecommerce: true, onlineOrders: true, campaigns: true, messageTemplates: true, catalogAnalytics: true }
    }
  });

  console.log("Seeding salon-user connection...");

  await prisma.userSalon.create({
    data: {
      userId: owner.id,
      salonId: salon.id,
      salonRole: "SALON_OWNER",
      permissions: defaultOwnerPermissions
    }
  });

  console.log("Seeding custom roles...");

  const seniorStylistRole = await prisma.customRole.create({
    data: {
      salonId: salon.id,
      name: "Senior Stylist",
      description: "Custom role for Senior Hair and Makeup Stylists",
      permissions: { appointments: ["view", "create", "edit"], services: ["view"] }
    }
  });

  const receptionistRole = await prisma.customRole.create({
    data: {
      salonId: salon.id,
      name: "Receptionist Manager",
      description: "Handles bookings, POS invoices, and customer registry",
      permissions: { appointments: ["view", "create", "edit", "delete"], invoices: ["view", "create", "edit"], customers: ["view", "create", "edit"] }
    }
  });

  console.log("Seeding branches (4 total)...");

  const branch1 = await prisma.branch.create({
    data: {
      id: "seed-main-branch",
      salonId: salon.id,
      name: "Main Branch",
      address: "Connaught Place, New Delhi",
      phone: "+919999000111",
      isActive: true
    }
  });

  const branch2 = await prisma.branch.create({
    data: {
      id: "seed-dha-branch",
      salonId: salon.id,
      name: "DHA Branch",
      address: "DHA Phase 5, Mumbai",
      phone: "+919999000222",
      isActive: true
    }
  });

  const branch3 = await prisma.branch.create({
    data: {
      id: "seed-gulberg-branch",
      salonId: salon.id,
      name: "Gulberg Branch",
      address: "Gulberg Galleria, Bengaluru",
      phone: "+919999000333",
      isActive: true
    }
  });

  const branch4 = await prisma.branch.create({
    data: {
      id: "seed-johar-branch",
      salonId: salon.id,
      name: "Johar Town Branch",
      address: "Johar Town, Chennai",
      phone: "+919999000444",
      isActive: true
    }
  });

  console.log("Seeding staff users (6 total)...");

  const staffData = [
    { name: "Rohan Sharma", email: "rohan@respark.local", role: "STAFF", branchId: branch1.id, customRoleId: seniorStylistRole.id, phone: "+919876543231" },
    { name: "Pooja Patel", email: "pooja@respark.local", role: "STAFF", branchId: branch2.id, customRoleId: seniorStylistRole.id, phone: "+919876543232" },
    { name: "Amit Kumar", email: "amit@respark.local", role: "STAFF", branchId: branch3.id, phone: "+919876543233" },
    { name: "Sneha Reddy", email: "sneha@respark.local", role: "MANAGER", branchId: branch1.id, phone: "+919876543234" },
    { name: "Vikram Singh", email: "vikram@respark.local", role: "RECEPTIONIST", branchId: branch4.id, customRoleId: receptionistRole.id, phone: "+919876543235" },
    { name: "Neha Gupta", email: "neha@respark.local", role: "STAFF", branchId: branch4.id, phone: "+919876543236" }
  ];

  for (const staff of staffData) {
    const userRecord = await prisma.user.create({
      data: {
        email: staff.email,
        name: staff.name,
        systemRole: "SALON_USER",
        passwordHash: await bcrypt.hash("Staff@123", 10)
      }
    });

    await prisma.userSalon.create({
      data: {
        userId: userRecord.id,
        salonId: salon.id,
        salonRole: staff.role,
        branchId: staff.branchId,
        customRoleId: staff.customRoleId || null,
        phone: staff.phone,
        profileNote: `${staff.name} is a dedicated professional at ${staff.branchId}.`
      }
    });
  }

  console.log("Seeding service categories & subcategories...");

  // Hair Services Tree
  const hairParent = await prisma.serviceCategory.create({
    data: { salonId: salon.id, name: "Hair Services", isActive: true }
  });
  const hairCuts = await prisma.serviceCategory.create({
    data: { salonId: salon.id, name: "Hair Cuts", parentId: hairParent.id, isActive: true }
  });
  const hairStyling = await prisma.serviceCategory.create({
    data: { salonId: salon.id, name: "Hair Styling", parentId: hairParent.id, isActive: true }
  });

  // Skin Care Tree
  const skinParent = await prisma.serviceCategory.create({
    data: { salonId: salon.id, name: "Skin Care", isActive: true }
  });
  const facials = await prisma.serviceCategory.create({
    data: { salonId: salon.id, name: "Facials", parentId: skinParent.id, isActive: true }
  });
  const peels = await prisma.serviceCategory.create({
    data: { salonId: salon.id, name: "Chemical Peels", parentId: skinParent.id, isActive: true }
  });

  console.log("Seeding services...");

  const servicesData = [
    { name: "Classic Men's Haircut", price: 450, durationMin: 30, categoryId: hairCuts.id, branchId: branch1.id },
    { name: "Women's Advanced Cut", price: 950, durationMin: 45, categoryId: hairCuts.id, branchId: branch1.id },
    { name: "Premium Blow Dry & Style", price: 1200, durationMin: 40, categoryId: hairStyling.id, branchId: branch2.id },
    { name: "Organic Hydra Facial", price: 1800, durationMin: 60, categoryId: facials.id, branchId: branch3.id },
    { name: "Anti-Aging Glow Treatment", price: 2800, durationMin: 75, categoryId: facials.id, branchId: branch1.id },
    { name: "Deep Cleansing Therapy", price: 1500, durationMin: 50, categoryId: facials.id, branchId: branch4.id },
    { name: "Glycolic Glow Peel", price: 3200, durationMin: 60, categoryId: peels.id, branchId: branch2.id }
  ];

  const seededServices = [];
  for (const s of servicesData) {
    const serviceRecord = await prisma.service.create({
      data: {
        salonId: salon.id,
        branchId: s.branchId,
        categoryId: s.categoryId,
        name: s.name,
        price: s.price,
        durationMin: s.durationMin,
        gender: "UNISEX",
        onlineBookingEnabled: true,
        isPopular: true
      }
    });
    seededServices.push(serviceRecord);
  }

  console.log("Seeding product categories & products...");

  const prodCat1 = await prisma.productCategory.create({
    data: { salonId: salon.id, name: "Hair Care Products" }
  });
  const prodCat2 = await prisma.productCategory.create({
    data: { salonId: salon.id, name: "Skin Care Essentials" }
  });

  const productsData = [
    { name: "Keratin Repair Serum", sku: "SERUM-001", catId: prodCat1.id, cost: 800, sell: 1499, type: "RETAIL", stock: 25 },
    { name: "Argon Oil Nourishing Shampoo", sku: "SHAMPOO-001", catId: prodCat1.id, cost: 450, sell: 899, type: "RETAIL", stock: 40 },
    { name: "Intense Face Hydrator", sku: "CREAM-001", catId: prodCat2.id, cost: 1100, sell: 1999, type: "RETAIL", stock: 15 },
    { name: "Matte Clay Styling Wax", sku: "WAX-001", catId: prodCat1.id, cost: 300, sell: 599, type: "CONSUMABLE", stock: 50 },
    { name: "Microfiber Professional Towels", sku: "TOWEL-001", catId: prodCat1.id, cost: 150, sell: 350, type: "CONSUMABLE", stock: 120 }
  ];

  for (const p of productsData) {
    await prisma.product.create({
      data: {
        salonId: salon.id,
        branchId: branch1.id,
        categoryId: p.catId,
        name: p.name,
        sku: p.sku,
        productType: p.type,
        costPrice: p.cost,
        sellingPrice: p.sell,
        currentStock: p.stock,
        minStock: 5,
        isOnlineVisible: true
      }
    });
  }

  console.log("Seeding memberships...");

  const goldMembership = await prisma.membershipPlan.create({
    data: {
      salonId: salon.id,
      name: "Gold Annual Membership",
      price: 5000,
      validityDays: 365,
      benefitType: "WALLET_VALUE",
      walletValue: 6000,
      renewalReminder: 15,
      isActive: true
    }
  });

  const skinClubMembership = await prisma.membershipPlan.create({
    data: {
      salonId: salon.id,
      name: "Premium Skin Care Club",
      price: 2500,
      validityDays: 90,
      benefitType: "DISCOUNT_PERCENT",
      discountValue: 15,
      renewalReminder: 7,
      isActive: true
    }
  });

  console.log("Seeding packages...");

  const hairPkg = await prisma.package.create({
    data: {
      salonId: salon.id,
      name: "Hair Transformation Package",
      price: 4999,
      totalSessions: 5,
      validityDays: 180,
      isActive: true
    }
  });

  await prisma.packageService.create({
    data: {
      packageId: hairPkg.id,
      serviceId: seededServices[0].id, // Classic Men's Haircut
      sessions: 5
    }
  });

  const glowCombo = await prisma.package.create({
    data: {
      salonId: salon.id,
      name: "Bridal Glow Combo",
      price: 11999,
      totalSessions: 4,
      validityDays: 90,
      isActive: true
    }
  });

  await prisma.packageService.create({
    data: {
      packageId: glowCombo.id,
      serviceId: seededServices[3].id, // Organic Hydra Facial
      sessions: 4
    }
  });

  console.log("Seeding CRM customers (15 total with Indian names and numbers)...");

  const customersData = [
    { name: "Rajesh Sharma", phone: "+919876543201", email: "rajesh@gmail.com", gender: "MALE" },
    { name: "Vikram Malhotra", phone: "+919876543202", email: "vikram@gmail.com", gender: "MALE" },
    { name: "Priyansh Kapoor", phone: "+919876543203", email: "priyansh@gmail.com", gender: "MALE" },
    { name: "Anil Deshmukh", phone: "+919876543204", email: "anil@gmail.com", gender: "MALE" },
    { name: "Ananya Iyer", phone: "+919876543205", email: "ananya@gmail.com", gender: "FEMALE" },
    { name: "Sunita Verma", phone: "+919876543206", email: "sunita@gmail.com", gender: "FEMALE" },
    { name: "Kavita Nair", phone: "+919876543207", email: "kavita@gmail.com", gender: "FEMALE" },
    { name: "Rahul Dravid", phone: "+919876543208", email: "rahul@gmail.com", gender: "MALE" },
    { name: "Arjun Rampal", phone: "+919876543209", email: "arjun@gmail.com", gender: "MALE" },
    { name: "Dev Patel", phone: "+919876543210", email: "dev@gmail.com", gender: "MALE" },
    { name: "Ritu Phogat", phone: "+919876543211", email: "ritu@gmail.com", gender: "FEMALE" },
    { name: "Meera Bai", phone: "+919876543212", email: "meera@gmail.com", gender: "FEMALE" },
    { name: "Karan Johar", phone: "+919876543213", email: "karan@gmail.com", gender: "MALE" },
    { name: "Sanjay Dutt", phone: "+919876543214", email: "sanjay@gmail.com", gender: "MALE" },
    { name: "Divya Khosla", phone: "+919876543215", email: "divya@gmail.com", gender: "FEMALE" }
  ];

  for (const c of customersData) {
    await prisma.customer.create({
      data: {
        salonId: salon.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        gender: c.gender,
        source: "WALK_IN",
        notes: `Regular customer ${c.name} preferring personalized premium services.`
      }
    });
  }

  console.log("Seeding Catalog & Ecommerce settings...");

  const catalogSettingPayload = {
    catalogEnabled: true,
    customSlug: "demo-salon",
    showServices: true,
    showPackages: true,
    showMemberships: true,
    showProducts: true,
    showStaffPortfolio: true,
    whatsappNumber: "+919999000111",
    themeColor: "#0f766e"
  };

  await prisma.catalogSetting.create({
    data: {
      salonId: salon.id,
      branchId: null,
      ...catalogSettingPayload
    }
  });

  await prisma.ecommerceSetting.create({
    data: {
      salonId: salon.id,
      storeEnabled: true,
      allowCod: true,
      allowPayAtSalon: true,
      pickupEnabled: true
    }
  });

  await prisma.subscription.create({
    data: {
      id: "seed-demo-subscription",
      salonId: salon.id,
      planId: growthPlan.id,
      status: "ACTIVE",
      paymentStatus: "PAID",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      notes: "Seeded active subscription"
    }
  });

  console.log("Database seeded successfully!");
  console.log({
    superAdmin: superAdmin.email,
    owner: owner.email,
    salonId: salon.id,
    branchesCount: 4,
    staffCount: 6,
    servicesCount: seededServices.length,
    productsCount: productsData.length,
    membershipsCount: 2,
    packagesCount: 2,
    customersCount: customersData.length
  });
}

main().finally(() => prisma.$disconnect());
