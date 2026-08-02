async function testLogin(email, password) {
  const res = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const data = await res.json();
  if (!res.ok) {
    console.log(`❌ ${email}: ${res.status} - ${data.message}`);
    return null;
  }
  if (data.requireOtp) {
    console.log(`⚠️  ${email}: OTP required (check your email/phone for OTP)`);
    return null;
  }
  console.log(`✅ ${email}: Login OK, systemRole = ${data.systemRole || data.user?.systemRole || "unknown"}`);
  return data.accessToken;
}

async function main() {
  console.log("Testing login for real super admin accounts on Railway...\n");

  // Test main super admin
  const token1 = await testLogin("superadmin@salonnest.in", "Admin@123");
  if (!token1) await testLogin("superadmin@salonnest.in", "Admin@1234");
  if (!token1) await testLogin("superadmin@salonnest.in", "password123");

  console.log("");
  
  // Test codexaura account
  const token2 = await testLogin("codexaurasolutions@gmail.com", "Admin@123");
  if (!token2) await testLogin("codexaurasolutions@gmail.com", "password123");
}
main();
