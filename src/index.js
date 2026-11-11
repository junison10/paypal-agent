'use strict';

const path = require('path');
const { PayPalClient, MockPayPalClient } = require('./paypalClient');
const { createStore } = require('./store');
const { createApp } = require('./server');

const store = createStore(path.join(__dirname, '..', 'data'));

let paypalClient;
if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET) {
  paypalClient = new PayPalClient({
    clientId: process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_CLIENT_SECRET,
    mode: process.env.PAYPAL_MODE || 'sandbox',
  });
} else {
  console.warn('No PayPal credentials — running in MOCK mode (no real API calls)');
  paypalClient = new MockPayPalClient();
}

const app = createApp({ paypalClient, store });

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`PayPal agent listening on http://localhost:${port} (mode: ${paypalClient.mode})`);
});
