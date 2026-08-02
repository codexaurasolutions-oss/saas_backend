const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://postgres:JdhbWCdhtdyYUChGZclqHSeYZZhGKIKl@metro.proxy.rlwy.net:23204/railway'
    }
  }
});

const defaultFeatureFlags = { pos: true, reports: true };

async function main() {
  const trialStartsAt = '';
  const trialEndsAt = '';
  
  const toDate = (val) => (val ? new Date(val) : null);
  
  const salonData = {
    name: 'Debug Super Salon 999',
    slug: 'debug-super-salon-999',
    businessType: 'Salon',
    taxRate: 0,
    trialStartsAt: toDate(trialStartsAt),
    trialEndsAt: toDate(trialEndsAt),
    featureFlags: { ...defaultFeatureFlags }
  };
  
  console.log('Inserting data:', salonData);
  try {
    const s = await prisma.salon.create({ data: salonData });
    console.log('Success:', s.id);
    await prisma.salon.delete({ where: { id: s.id } });
  } catch (err) {
    console.error('Prisma Error:', err);
  }
}

main().finally(() => prisma.$disconnect());
