async function main() {
  try {
    // 1. Login as super admin
    const loginRes = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "superadmin_test_12345@test.com",
        password: "password123"
      })
    });
    
    if (!loginRes.ok) {
      console.log("Login failed:", loginRes.status, await loginRes.text());
      return;
    }
    
    const { accessToken } = await loginRes.json();
    console.log("Logged in OK, token length:", accessToken.length);

    // 2. Test plan creation
    const payload = {
      name: "Basic Plan Test",
      monthlyPrice: 999,
      yearlyPrice: 9999,
      trialDays: 14,
      branchLimit: 1,
      userLimit: 5,
      customerLimit: 500,
      invoiceLimit: 1000,
      storageLimit: 5,
      isCustom: false,
      isPopular: false,
      featureFlags: {
        pos: true,
        appointments: true,
        inventory: true,
        crm: true,
        campaigns: true,
        campaignTemplates: true,
        campaignAnalytics: true,
        ecommerce: true,
        digitalCatalog: true,
        catalogAnalytics: true,
        feedback: true,
        reports: true,
        memberships: true,
        packages: true,
        loyalty: true,
        couponsGiftCards: true,
        whatsapp: true,
        enquiries: true,
        expenses: true,
        attendance: true,
        leaves: true,
        payroll: true,
        incentives: true,
        customerPortal: true,
        publicCatalog: true,
        onlineOrders: true,
        messageTemplates: true,
        notifications: true,
        auditLogs: true,
        advancedReports: true
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
      console.error("PLAN CREATE FAILED:", res.status, JSON.stringify(data, null, 2));
    } else {
      console.log("PLAN CREATED:", data.id, "-", data.name);
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}
main();
