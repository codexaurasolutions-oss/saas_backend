async function main() {
  try {
    // Login as real super admin
    const loginRes = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "superadmin@salonnest.in", password: "Admin@123" })
    });
    const loginData = await loginRes.json();
    
    if (!loginRes.ok) {
      console.error("Login failed:", loginData);
      return;
    }
    if (loginData.requireOtp) {
      console.log("⚠️  OTP required! The server sent an OTP to email. Cannot proceed in CLI.");
      console.log("This means on the live Vercel site, OTP is required to login.");
      return;
    }
    
    const { accessToken } = loginData;
    console.log("✅ Logged in as superadmin@salonnest.in");
    
    // Try creating a plan
    const payload = {
      name: "Professional Plan",
      monthlyPrice: 4999,
      yearlyPrice: 49999,
      trialDays: 14,
      branchLimit: 3,
      userLimit: 15,
      customerLimit: 2000,
      invoiceLimit: 5000,
      storageLimit: 20,
      isCustom: false,
      isPopular: true,
      featureFlags: {
        pos: true, appointments: true, inventory: true, crm: true,
        campaigns: true, campaignTemplates: true, campaignAnalytics: true,
        ecommerce: true, digitalCatalog: true, catalogAnalytics: true,
        feedback: true, reports: true, memberships: true, packages: true,
        loyalty: true, couponsGiftCards: true, whatsapp: true, enquiries: true,
        expenses: true, attendance: true, leaves: true, payroll: true,
        incentives: true, customerPortal: true, publicCatalog: true,
        onlineOrders: true, messageTemplates: true, notifications: true,
        auditLogs: true, advancedReports: true
      }
    };

    const res = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/super-admin/plans", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    
    if (!res.ok) {
      console.error("❌ Plan create FAILED:", res.status, JSON.stringify(data, null, 2));
    } else {
      console.log("✅ Plan created:", data.id, "-", data.name);
    }
  } catch(err) {
    console.error("Error:", err.message);
  }
}
main();
