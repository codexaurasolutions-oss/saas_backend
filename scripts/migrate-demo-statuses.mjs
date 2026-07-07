import { PrismaClient } from "@prisma/client";

const OLD_TO_NEW = {
  PENDING: "NEW",
  CONTACTED: "CONNECTED",
  MEETING_SCHEDULED: "IN_PROGRESS",
  APPROVED: "CONVERTED",
  REJECTED: "CANCELED"
};

async function migrate() {
  const prisma = new PrismaClient();
  try {
    console.log("[migration] Converting old DemoLeadStatus values...");
    for (const [oldVal, newVal] of Object.entries(OLD_TO_NEW)) {
      const result = await prisma.$executeRawUnsafe(
        `UPDATE \"DemoLead\" SET status = $1 WHERE status = $2`,
        newVal,
        oldVal
      );
      if (result > 0) console.log(`[migration] ${oldVal} -> ${newVal}: ${result} rows`);
    }
    console.log("[migration] Done.");
  } catch (err) {
    console.error("[migration] Error:", err.message);
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
