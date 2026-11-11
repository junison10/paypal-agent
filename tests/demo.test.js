'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStore } = require('../src/store');
const { createApp } = require('../src/server');
const { MockPayPalClient } = require('../src/paypalClient');
const { parseInstruction } = require('../src/parser');
const { evaluateGuardrails } = require('../src/guardrails');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-agent-demo-'));
}

async function post(app, url, body) {
  const res = await fetch(`http://127.0.0.1:${app._port}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, json: await res.json() };
}

test('demo seed populates settings, allowlist and history (mock mode)', async (t) => {
  const dir = tmpDir();
  const app = createApp({
    paypalClient: new MockPayPalClient(),
    store: createStore(dir),
    parseInstruction,
    evaluateGuardrails,
  });
  const server = app.listen(0);
  app._port = server.address().port;
  t.after(() => server.close());

  const seed = await post(app, '/api/demo/seed');
  assert.equal(seed.status, 200);
  assert.equal(seed.json.seeded, true);
  assert.equal(seed.json.settings.perTxCap, 50);
  assert.equal(seed.json.settings.dailyCap, 200);
  assert.ok(seed.json.settings.allowlist.includes('supplier@example.com'));
  assert.equal(seed.json.transactions.length, 3);
  assert.equal(seed.json.transactions[0].status, 'COMPLETED');

  // The seeded state actually gates payments: $100 is now over the $50 cap.
  const parsed = await post(app, '/api/parse', { text: 'bayar $100 ke supplier@example.com buat invoice #124' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.json.guardrails.passed, false);

  const reset = await post(app, '/api/demo/reset');
  assert.equal(reset.status, 200);
  assert.equal(reset.json.reset, true);
  assert.equal(reset.json.settings.perTxCap, 500);
  assert.deepEqual(reset.json.transactions, []);
});

test('demo seed/reset are forbidden outside mock mode', async (t) => {
  const dir = tmpDir();
  const { PayPalClient } = require('../src/paypalClient');
  const app = createApp({
    paypalClient: new PayPalClient({ clientId: 'x', clientSecret: 'y' }),
    store: createStore(dir),
    parseInstruction,
    evaluateGuardrails,
  });
  const server = app.listen(0);
  app._port = server.address().port;
  t.after(() => server.close());

  const seed = await post(app, '/api/demo/seed');
  assert.equal(seed.status, 403);
  const reset = await post(app, '/api/demo/reset');
  assert.equal(reset.status, 403);
});
