const https = require('https');
const data = JSON.stringify({
  "name": "Test Salon UI",
  "slug": "test-salon-ui-xyz",
  "businessType": "Salon",
  "email": "",
  "phone": "",
  "address": "",
  "taxRate": 0,
  "trialStartsAt": "",
  "trialEndsAt": "",
  "internalNote": "",
  "ownerName": "",
  "ownerEmail": "",
  "ownerPassword": "",
  "featureFlags": {
    "pos": true
  }
});

const options = {
  hostname: 'saasbackend-production-9177.up.railway.app',
  port: 443,
  path: '/api/v1/super-admin/salons',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
    // NO AUTHORIZATION HEADER - it should return 401
  }
};

const req = https.request(options, (res) => {
  console.log('statusCode:', res.statusCode);
  let body = '';
  res.on('data', (d) => {
    body += d;
  });
  res.on('end', () => {
    console.log('Body:', body);
  });
});

req.on('error', (e) => {
  console.error(e);
});

req.write(data);
req.end();
