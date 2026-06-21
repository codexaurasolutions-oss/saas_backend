import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv";

dotenv.config();

const prisma = new PrismaClient();

async function run() {
  const users = await prisma.user.findMany({
    select: { id: true, email: true, systemRole: true }
  });
  console.log("Users List:", users);
}

run().finally(() => prisma.$disconnect());
