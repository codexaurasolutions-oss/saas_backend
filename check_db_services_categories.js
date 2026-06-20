import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const categories = await prisma.serviceCategory.findMany({ select: { id: true, name: true } });
  const services = await prisma.service.findMany({ select: { id: true, name: true, categoryId: true } });
  const products = await prisma.product.findMany({ select: { id: true, name: true } });
  console.log("=== SERVICE CATEGORIES ===");
  console.log(categories);
  console.log("=== SERVICES ===");
  console.log(services);
  console.log("=== PRODUCTS ===");
  console.log(products);
}

main().catch(console.error).finally(() => prisma.$disconnect());
