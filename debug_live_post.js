import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";
import { ensureProgramEnabled, getProgramSettings, toRuleNumber } from "./src/lib/settingsRules.js";

dotenv.config();

const prisma = new PrismaClient();

const toDate = (value) => (value ? new Date(value) : null);
const addDays = (days) => {
  const date = new Date();
  date.setDate(date.getDate() + Number(days || 0));
  return date;
};

const buildGiftCardData = (body, giftCardSettings) => {
  const originalAmount = toRuleNumber(body.originalAmount);
  const minimumAmount = toRuleNumber(giftCardSettings.minimumAmount, 0);
  const maximumAmount = toRuleNumber(giftCardSettings.maximumAmount, 0);
  if (minimumAmount > 0 && originalAmount < minimumAmount) {
    const error = new Error(`Gift card amount must be at least ${minimumAmount}`);
    error.status = 400;
    throw error;
  }
  if (maximumAmount > 0 && originalAmount > maximumAmount) {
    const error = new Error(`Gift card amount cannot exceed ${maximumAmount}`);
    error.status = 400;
    throw error;
  }
  const validityDays = toRuleNumber(giftCardSettings.validityDays, 0);
  return {
    originalAmount,
    balanceAmount: body.balanceAmount ?? originalAmount,
    expiresAt: toDate(body.expiresAt) || (validityDays > 0 ? addDays(validityDays) : null)
  };
};

async function run() {
  try {
    const salon = await prisma.salon.findFirst();
    const customer = await prisma.customer.findFirst();
    const user = await prisma.user.findFirst({
      where: { email: "owner@respark.local" }
    });

    const userSalon = await prisma.userSalon.findFirst({
      where: { userId: user.id, salonId: salon.id }
    });

    const salonId = salon.id;
    const reqBody = {
      customerId: customer.id,
      code: "GC-API-" + Math.floor(100000 + Math.random() * 900000),
      title: "Gift Card",
      originalAmount: 1000,
      expiresAt: "2027-06-21"
    };

    console.log("Mock request loaded. Fetching settings...");
    const giftCardSettings = await getProgramSettings(salonId, "giftCardSettings", { enabled: true, validityDays: 365, minimumAmount: 0, maximumAmount: 0 });
    console.log("giftCardSettings:", giftCardSettings);
    ensureProgramEnabled(giftCardSettings, "Gift cards");

    console.log("Building gift card data...");
    const giftCardData = buildGiftCardData(reqBody, giftCardSettings);
    console.log("giftCardData:", giftCardData);

    console.log("Creating gift card database row...");
    const row = await prisma.giftCard.create({
      data: {
        salonId: salonId,
        issuedToCustomerId: reqBody.customerId || null,
        soldInvoiceId: reqBody.soldInvoiceId || null,
        linkedCampaignId: reqBody.linkedCampaignId || null,
        createdByMembershipId: userSalon?.id || null,
        code: reqBody.code,
        title: reqBody.title,
        originalAmount: giftCardData.originalAmount,
        balanceAmount: giftCardData.balanceAmount,
        expiresAt: giftCardData.expiresAt,
        isActive: reqBody.isActive ?? true,
        note: reqBody.note || null
      }
    });
    console.log("Database Row created:", row);

    console.log("Creating Audit Log...");
    // Let's import createAuditLog from phase4.js
    const { createAuditLog } = await import("./src/lib/phase4.js");
    await createAuditLog({
      salonId: salonId,
      actorUserId: user.id,
      actorMembershipId: userSalon?.id,
      module: "GIFT_CARDS",
      action: "GIFT_CARD_CREATED",
      entityType: "GiftCard",
      entityId: row.id,
      reference: row.code,
      summary: `Gift card ${row.code} created`
    });
    console.log("Audit log created successfully!");

  } catch (error) {
    console.error("Step execution failed with error:", error);
  }
}

run().finally(() => prisma.$disconnect());
