'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PayPalClient, MockPayPalClient, SANDBOX_BASE_URL } = require('../src/paypalClient');

function fakeFetchFactory() {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith('/v1/oauth2/token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'FAKE-TOKEN', token_type: 'Bearer', expires_in: 3600 }),
        text: async () => '',
      };
    }
    if (url.endsWith('/v2/checkout/orders') && opts.method === 'POST') {
      return {
        ok: true,
        status: 201,
        json: async () => ({ id: 'ORDER-123', status: 'CREATED', intent: 'CAPTURE' }),
        text: async () => '',
      };
    }
    if (url.endsWith('/capture') && opts.method === 'POST') {
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'ORDER-123',
          status: 'COMPLETED',
          purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '25.00' } }] } }],
        }),
        text: async () => '',
      };
    }
    if (opts.method === 'GET') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'ORDER-123', status: 'APPROVED' }),
        text: async () => '',
      };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  };
  return { fetchImpl, calls };
}

test('PayPalClient uses the sandbox base URL by default', () => {
  const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret' });
  assert.equal(client.baseUrl, SANDBOX_BASE_URL);
  assert.equal(client.mode, 'sandbox');
});

test('PayPalClient.getAccessToken uses Basic auth and caches the token', async () => {
  const { fetchImpl, calls } = fakeFetchFactory();
  const client = new PayPalClient({ clientId: 'my-id', clientSecret: 'my-secret', fetchImpl });
  const token1 = await client.getAccessToken();
  const token2 = await client.getAccessToken();
  assert.equal(token1, 'FAKE-TOKEN');
  assert.equal(token2, 'FAKE-TOKEN');
  const tokenCalls = calls.filter((c) => c.url.endsWith('/v1/oauth2/token'));
  assert.equal(tokenCalls.length, 1, 'second call should use the cached token');
  const expectedBasic = Buffer.from('my-id:my-secret').toString('base64');
  assert.equal(tokenCalls[0].opts.headers.Authorization, `Basic ${expectedBasic}`);
  assert.equal(tokenCalls[0].opts.body, 'grant_type=client_credentials');
});

test('PayPalClient.createOrder posts CAPTURE with payee and custom_id', async () => {
  const { fetchImpl, calls } = fakeFetchFactory();
  const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const order = await client.createOrder({
    amount: 25,
    currency: 'USD',
    recipientEmail: 'alice@example.com',
    invoiceId: 'INV-1',
    memo: 'thanks',
  });
  assert.equal(order.id, 'ORDER-123');
  const orderCall = calls.find((c) => c.url.endsWith('/v2/checkout/orders'));
  const body = JSON.parse(orderCall.opts.body);
  assert.equal(body.intent, 'CAPTURE');
  assert.equal(body.purchase_units[0].amount.currency_code, 'USD');
  assert.equal(body.purchase_units[0].amount.value, '25.00');
  assert.equal(body.purchase_units[0].payee.email_address, 'alice@example.com');
  assert.equal(body.purchase_units[0].custom_id, 'INV-1');
  assert.equal(orderCall.opts.headers.Authorization, 'Bearer FAKE-TOKEN');
});

test('PayPalClient.createOrder omits payee when no recipient is given', async () => {
  const { fetchImpl, calls } = fakeFetchFactory();
  const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  await client.createOrder({ amount: 10, currency: 'USD' });
  const orderCall = calls.find((c) => c.url.endsWith('/v2/checkout/orders'));
  const body = JSON.parse(orderCall.opts.body);
  assert.equal(body.purchase_units[0].payee, undefined);
});

test('PayPalClient.captureOrder and getOrder hit the right paths', async () => {
  const { fetchImpl, calls } = fakeFetchFactory();
  const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  const capture = await client.captureOrder('ORDER-123');
  assert.equal(capture.status, 'COMPLETED');
  assert.equal(capture.purchase_units[0].payments.captures[0].id, 'CAP-1');
  const order = await client.getOrder('ORDER-123');
  assert.equal(order.status, 'APPROVED');
  assert.ok(calls.some((c) => c.url.endsWith('/v2/checkout/orders/ORDER-123/capture')));
  assert.ok(calls.some((c) => c.url.endsWith('/v2/checkout/orders/ORDER-123') && c.opts.method === 'GET'));
});

test('PayPalClient.createOrder rejects a non-positive amount', async () => {
  const { fetchImpl } = fakeFetchFactory();
  const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl });
  await assert.rejects(() => client.createOrder({ amount: 0 }), /positive amount/);
});

test('MockPayPalClient mirrors the interface without network calls', async () => {
  const mock = new MockPayPalClient();
  assert.equal(mock.mode, 'mock');
  assert.equal(await mock.getAccessToken(), 'MOCK-ACCESS-TOKEN');
  const order = await mock.createOrder({ amount: 25, currency: 'USD', recipientEmail: 'alice@example.com', invoiceId: 'INV-1' });
  assert.match(order.id, /^MOCK-ORDER-/);
  const capture = await mock.captureOrder(order.id);
  assert.equal(capture.status, 'COMPLETED');
  assert.equal(capture.id, order.id);
  const cap = capture.purchase_units[0].payments.captures[0];
  assert.match(cap.id, /^MOCK-CAPTURE-/);
  assert.equal(cap.status, 'COMPLETED');
  assert.equal(cap.amount.currency_code, 'USD');
  assert.equal(cap.amount.value, '25.00');
  const fetched = await mock.getOrder(order.id);
  assert.equal(fetched.id, order.id);
  assert.ok(typeof fetched.status === 'string' && fetched.status.length > 0);
});
