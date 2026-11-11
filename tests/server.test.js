'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../src/server');
const { createStore } = require('../src/store');
const { MockPayPalClient } = require('../src/paypalClient');

/**
 * Use the real parser/guardrails modules when the sibling worker has built
 * them; otherwise fall back to a stub with the same contract:
 *   parseInstruction(text) -> intent {amount, currency, recipientEmail, ...}
 *   evaluateGuardrails(intent, settings, todayTotal) -> {allowed, reasons}
 */
let parseInstruction;
let evaluateGuardrails;
let usingRealModules = false;
try {
  const parser = require('../src/parser');
  const guardrails = require('../src/guardrails');
  const p = parser.parseInstruction || parser.parse || parser;
  const g = guardrails.evaluateGuardrails || guardrails.evaluate || guardrails;
  if (typeof p === 'function' && typeof g === 'function') {
    parseInstruction = p;
    evaluateGuardrails = g;
    usingRealModules = true;
  }
} catch {
  // fall through to stubs below
}
if (!usingRealModules) {
  parseInstruction = (text) => {
    const amountMatch = text.match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
    const emailMatch = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    if (!amountMatch || !emailMatch) throw new Error('Could not parse instruction');
    return {
      action: 'send',
      amount: Number(amountMatch[1]),
      currency: 'USD',
      recipientEmail: emailMatch[0],
    };
  };
  evaluateGuardrails = (intent, settings, todayTotal = 0) => {
    const reasons = [];
    if (!(Number(intent.amount) > 0)) reasons.push('Amount must be positive');
    if (Number(intent.amount) > settings.perTxCap) {
      reasons.push(`Amount ${intent.amount} exceeds per-transaction cap ${settings.perTxCap}`);
    }
    if (todayTotal + Number(intent.amount) > settings.dailyCap) {
      reasons.push(`Daily cap ${settings.dailyCap} would be exceeded`);
    }
    const allowlist = settings.allowlist || [];
    if (allowlist.length > 0 && intent.recipientEmail && !allowlist.includes(intent.recipientEmail.toLowerCase())) {
      reasons.push(`Recipient ${intent.recipientEmail} is not on the allowlist`);
    }
    return { allowed: reasons.length === 0, reasons };
  };
}

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-agent-server-'));
  return createStore(dir);
}

async function startApp(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function setup() {
  const store = tempStore();
  const app = createApp({
    paypalClient: new MockPayPalClient(),
    store,
    parseInstruction,
    evaluateGuardrails,
  });
  const srv = await startApp(app);
  return { store, ...srv };
}

async function req(base, method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body (e.g. static 404); leave json null
  }
  return { status: res.status, json, text };
}

test('health reports ok in mock mode', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const { status, json } = await req(base, 'GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.mode, 'mock');
});

test('full flow: parse -> confirm -> receipt in history', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const parsed = await req(base, 'POST', '/api/parse', { text: 'Send $25 to alice@example.com' });
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  assert.ok(parsed.json.pendingId);
  assert.equal(parsed.json.requiresConfirmation, true);
  assert.equal(Number(parsed.json.intent.amount), 25);

  const confirmed = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json));
  const receipt = confirmed.json.receipt;
  assert.match(receipt.orderId, /^MOCK-ORDER-/);
  assert.match(receipt.captureId, /^MOCK-CAPTURE-/);
  assert.equal(receipt.status, 'COMPLETED');
  assert.equal(receipt.amount, 25);
  assert.equal(receipt.currency, 'USD');
  assert.equal(receipt.recipient, 'alice@example.com');

  const history = await req(base, 'GET', '/api/history');
  assert.equal(history.json.transactions.length, 1);
  assert.equal(history.json.transactions[0].orderId, receipt.orderId);

  // Pending is consumed: confirming again is a 404.
  const again = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(again.status, 404);
});

test('confirm with unknown pendingId returns 404', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const res = await req(base, 'POST', '/api/confirm', { pendingId: 'no-such-id', confirmed: true });
  assert.equal(res.status, 404);
  assert.ok(res.json.error);
});

test('confirm cancelled deletes the pending record and pays nothing', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const parsed = await req(base, 'POST', '/api/parse', { text: 'Send $25 to alice@example.com' });
  assert.equal(parsed.status, 200);
  const cancelled = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: false });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.cancelled, true);
  const history = await req(base, 'GET', '/api/history');
  assert.deepEqual(history.json.transactions, []);
  const again = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(again.status, 404);
});

test('over-cap payment is rejected at confirm (400)', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  // Default perTxCap is 500, so $9999 must be blocked.
  const parsed = await req(base, 'POST', '/api/parse', { text: 'Send $9999 to alice@example.com' });
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  const confirmed = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 400, JSON.stringify(confirmed.json));
  assert.ok(confirmed.json.error);
  assert.ok(confirmed.json.guardrails);
  const history = await req(base, 'GET', '/api/history');
  assert.deepEqual(history.json.transactions, []);
});

test('non-allowlisted recipient is blocked', async (t) => {
  const { base, close, store } = await setup();
  t.after(close);
  store.addAllowlist('bob@example.com');
  const parsed = await req(base, 'POST', '/api/parse', { text: 'Send $25 to alice@example.com' });
  assert.equal(parsed.status, 200, JSON.stringify(parsed.json));
  const confirmed = await req(base, 'POST', '/api/confirm', { pendingId: parsed.json.pendingId, confirmed: true });
  assert.equal(confirmed.status, 400, JSON.stringify(confirmed.json));
  const history = await req(base, 'GET', '/api/history');
  assert.deepEqual(history.json.transactions, []);
});

test('settings get/put validates caps; allowlist add/remove validates email', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const initial = await req(base, 'GET', '/api/settings');
  assert.equal(initial.json.perTxCap, 500);

  const bad = await req(base, 'PUT', '/api/settings', { perTxCap: 0 });
  assert.equal(bad.status, 400);
  const bad2 = await req(base, 'PUT', '/api/settings', { dailyCap: -5 });
  assert.equal(bad2.status, 400);

  const updated = await req(base, 'PUT', '/api/settings', { perTxCap: 100, currency: 'EUR' });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.perTxCap, 100);
  assert.equal(updated.json.currency, 'EUR');

  const badEmail = await req(base, 'POST', '/api/allowlist', { email: 'not-an-email' });
  assert.equal(badEmail.status, 400);
  const added = await req(base, 'POST', '/api/allowlist', { email: 'Alice@Example.com' });
  assert.equal(added.status, 200);
  assert.deepEqual(added.json.allowlist, ['alice@example.com']);
  const removed = await req(base, 'DELETE', '/api/allowlist', { email: 'alice@example.com' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json.allowlist, []);
});

test('parse without text returns 400', async (t) => {
  const { base, close } = await setup();
  t.after(close);
  const res = await req(base, 'POST', '/api/parse', {});
  assert.equal(res.status, 400);
});
