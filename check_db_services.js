import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const services = await prisma.service.findMany({ select: { id: true, name: true, gender: true } });
  console.log("=== SERVICES GENDER ===");
  console.log(services);
}

main().catch(console.error).finally(() => prisma.$disconnect());
