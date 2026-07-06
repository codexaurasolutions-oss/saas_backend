import bcrypt from "bcryptjs";

async function main() {
  const hash = "$2a$10$RmRi3mpHjkY5ElniH2zh6ulIgK1vx9j0SmUxjny1diLldh7Tr7mtS";
  const match = await bcrypt.compare("Admin@123", hash);
  console.log("Password Admin@123 matches hash?", match);
}

main();
