import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const appointment = await prisma.appointment.findFirst({
    where: { id: "cmqmhvayi0001q1ksl30iezhv" },
    include: {
      items: true
    }
  });
  console.log("=== APPOINTMENT RAW ===");
  if (appointment) {
    console.log(`Appointment:`);
    console.log(`  startAt: ${appointment.startAt.toISOString()} (raw: ${appointment.startAt})`);
    console.log(`  endAt: ${appointment.endAt.toISOString()} (raw: ${appointment.endAt})`);
    appointment.items.forEach(item => {
      console.log(`Item:`);
      console.log(`  startAt: ${item.startAt ? item.startAt.toISOString() : 'null'} (raw: ${item.startAt})`);
      console.log(`  endAt: ${item.endAt ? item.endAt.toISOString() : 'null'} (raw: ${item.endAt})`);
    });
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
