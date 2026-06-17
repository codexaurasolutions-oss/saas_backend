const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const services = await prisma.service.findMany({ select: { name: true, durationMin: true } });
  console.log('Services:', services);

  const appts = await prisma.appointment.findMany({ 
    select: { 
      id: true,
      startAt: true, 
      endAt: true,
      items: {
        select: {
          startAt: true,
          endAt: true,
          service: { select: { name: true, durationMin: true } }
        }
      }
    }, 
    orderBy: { startAt: 'desc' }, 
    take: 5 
  });
  console.log('Appointments:', JSON.stringify(appts, null, 2));
}

run().catch(console.error).finally(() => prisma.$disconnect());
