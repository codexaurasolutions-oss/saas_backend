import axios from "axios";

const API_BASE = "https://resparkbackend-production-ba7b.up.railway.app/api/v1";

async function run() {
  try {
    console.log("Logging in...");
    const loginRes = await axios.post(`${API_BASE}/auth/login`, {
      email: "owner@respark.local",
      password: "Owner@123"
    });
    const token = loginRes.data.accessToken;
    console.log("Token obtained successfully.");

    console.log("Issuing gift card via API...");
    const giftCardRes = await axios.post(`${API_BASE}/owner/gift-cards`, {
      customerId: "cmpuzsa7f0009q10sedr6be1g",
      code: "GC-API-" + Math.floor(100000 + Math.random() * 900000),
      title: "Gift Card",
      originalAmount: 1000,
      expiresAt: "2027-06-21"
    }, {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    console.log("Response:", giftCardRes.data);
  } catch (error) {
    if (error.response) {
      console.error("API Error Status:", error.response.status);
      console.error("API Error Data:", error.response.data);
    } else {
      console.error("Connection Error:", error.message);
    }
  }
}

run();
