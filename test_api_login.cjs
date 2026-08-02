

async function main() {
  try {
    // 1. Login
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
    
    const loginData = await loginRes.json();
    const token = loginData.accessToken;
    console.log("Logged in successfully, token length:", token.length);

    // 2. Create Salon
    const payload = {
      name: "Test API Salon Owner",
      slug: "test-api-salon-owner",
      businessType: "Salon",
      email: "",
      phone: "",
      address: "",
      taxRate: 0,
      trialStartsAt: "",
      trialEndsAt: "",
      internalNote: "",
      ownerName: "John Doe",
      ownerEmail: "john_doe_test@test.com",
      ownerPassword: "password123",
      featureFlags: { pos: true, crm: true }
    };

    const res = await fetch("https://saasbackend-production-9177.up.railway.app/api/v1/super-admin/salons", {
      method: "POST",
      headers: { 
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error("Salon Create Failed:", res.status, data);
    } else {
      const data = await res.json();
      console.log("Salon Created:", data.id);
    }
  } catch (err) {
    console.error("Error:", err.message);
  }
}
main();
