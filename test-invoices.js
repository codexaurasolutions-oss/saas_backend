import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const count = await prisma.invoice.count();
  console.log(`Total invoices in DB: ${count}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
