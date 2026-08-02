// This simulates exactly what the frontend PlansPage does when creating a plan
// to identify the EXACT error the user sees

async function main() {
  // Step 1: Login as superadmin@salonnest.in 
  const loginRes = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "superadmin@salonnest.in", password: "Admin@123" })
  });
  const loginData = await loginRes.json();
  
  if (!loginRes.ok || loginData.requireOtp) {
    console.error("Login issue:", loginData);
    return;
  }
  
  const accessToken = loginData.accessToken;
  const refreshToken = loginData.refreshToken;
  console.log("✅ Logged in, accessToken:", accessToken?.substring(0, 30) + "...");
  console.log("   Refresh Token:", refreshToken ? "present" : "MISSING ❌");
  console.log("   systemRole:", loginData.user?.systemRole || loginData.systemRole || "unknown");

  // Step 2: Get current plans (simulates page load)
  const getRes = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/super-admin/plans", {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  const plans = await getRes.json();
  console.log("\n📋 Current Plans:", Array.isArray(plans) ? plans.map(p => p.name) : plans);

  // Step 3: Simulate EXACT frontend form payload (exactly like PlansPage.jsx submit function)
  const form = {
    name: "Test Plan Via Sim",
    monthlyPrice: 0,
    yearlyPrice: 0,
    trialDays: 0,
    branchLimit: 1,
    userLimit: 5,
    customerLimit: 500,
    invoiceLimit: 1000,
    storageLimit: 5,
    isCustom: false,
    isPopular: false,
    featureFlags: {
      pos: true, appointments: true, inventory: true, crm: true, campaigns: true,
      campaignTemplates: true, campaignAnalytics: true, ecommerce: true,
      digitalCatalog: true, catalogAnalytics: true, feedback: true, reports: true,
      memberships: true, packages: true, loyalty: true, couponsGiftCards: true,
      whatsapp: true, enquiries: true, expenses: true, attendance: true,
      leaves: true, payroll: true, incentives: true, customerPortal: true,
      publicCatalog: true, onlineOrders: true, messageTemplates: true,
      notifications: true, auditLogs: true, advancedReports: true
    }
  };

  const payload = {
    name: form.name.trim(),
    monthlyPrice: Number(form.monthlyPrice || 0),
    yearlyPrice: Number(form.yearlyPrice || 0),
    trialDays: Number(form.trialDays || 0),
    branchLimit: Number(form.branchLimit || 1),
    userLimit: Number(form.userLimit || 0),
    customerLimit: Number(form.customerLimit || 0),
    invoiceLimit: Number(form.invoiceLimit || 0),
    storageLimit: Number(form.storageLimit || 0),
    isCustom: Boolean(form.isCustom),
    isPopular: Boolean(form.isPopular),
    featureFlags: form.featureFlags || {}
  };

  console.log("\n📤 Sending payload:", JSON.stringify(payload, null, 2));

  const createRes = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/super-admin/plans", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  
  const createData = await createRes.json();
  
  if (!createRes.ok) {
    console.error("\n❌ PLAN CREATE FAILED! Status:", createRes.status);
    console.error("Error response:", JSON.stringify(createData, null, 2));
  } else {
    console.log("\n✅ Plan created successfully:", createData.id, "-", createData.name);
    
    // Now delete it to keep DB clean
    await fetch(`https://saasbackend-production-9177.up.railway.app/api/v1/super-admin/plans/${createData.id}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${accessToken}` }
    });
    console.log("🗑️  Test plan deleted.");
  }
}
main().catch(console.error);
