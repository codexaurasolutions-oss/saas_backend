import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const invoices = await prisma.invoice.findMany({
    select: { salonId: true, invoiceNumber: true }
  });
  console.log(invoices);
}

main().catch(console.error).finally(() => prisma.$disconnect());
