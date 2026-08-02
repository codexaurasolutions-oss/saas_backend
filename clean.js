import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres:JdhbWCdhtdyYUChGZclqHSeYZZhGKIKl@metro.proxy.rlwy.net:23204/railway'
    }
  }
});

async function clean() {
  try {
    const res = await prisma.websiteVisit.deleteMany({
      where: {
        path: {
          in: ['/appointments', '/booking', '/pricing', '/contact', '/about', '/services', '/catalog']
        }
      }
    });
    console.log('Deleted visits:', res.count);
  } catch (err) {
    console.log('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}
clean();
