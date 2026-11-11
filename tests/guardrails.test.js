'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evaluateGuardrails } = require('../src/guardrails');

const SETTINGS = { perTxCap: 500, dailyCap: 2000, currency: 'USD', allowlist: [] };

function resultFor(intent, settings = SETTINGS, todaysTotal = 0) {
  return evaluateGuardrails(intent, settings, todaysTotal);
}

function check(result, rule) {
  const found = result.checks.find((c) => c.rule === rule);
  assert.ok(found, `missing check ${rule}`);
  return found;
}

test('happy path passes, checks in order', () => {
  const r = resultFor({ amount: 100, recipient: 'alice@test.com' });
  assert.strictEqual(r.passed, true);
  assert.deepStrictEqual(
    r.checks.map((c) => c.rule),
    ['amount_present', 'recipient_present', 'amount_positive', 'per_tx_cap', 'daily_cap', 'allowlist'],
  );
  for (const c of r.checks) {
    assert.strictEqual(c.passed, true, c.rule);
    assert.strictEqual(typeof c.detail, 'string');
    assert.ok(c.detail.length > 0, c.rule);
  }
});

test('over perTxCap fails', () => {
  const r = resultFor({ amount: 501, recipient: 'alice@test.com' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'per_tx_cap').passed, false);
  assert.strictEqual(check(r, 'amount_present').passed, true);
});

test('exactly at perTxCap passes', () => {
  const r = resultFor({ amount: 500, recipient: 'alice@test.com' });
  assert.strictEqual(r.passed, true);
});

test('daily cap exceeded fails (todaysTotal near cap)', () => {
  const r = resultFor({ amount: 100, recipient: 'alice@test.com' }, SETTINGS, 1950);
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'daily_cap').passed, false);
  assert.strictEqual(check(r, 'per_tx_cap').passed, true);
});

test('daily cap exactly reached passes', () => {
  const r = resultFor({ amount: 100, recipient: 'alice@test.com' }, SETTINGS, 1900);
  assert.strictEqual(r.passed, true);
});

test('recipient not in non-empty allowlist fails', () => {
  const settings = { ...SETTINGS, allowlist: ['alice@test.com', 'bob@test.com'] };
  const r = resultFor({ amount: 100, recipient: 'mallory@test.com' }, settings);
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'allowlist').passed, false);
});

test('empty allowlist passes (any recipient allowed)', () => {
  const r = resultFor({ amount: 100, recipient: 'anyone@test.com' }, SETTINGS);
  assert.strictEqual(r.passed, true);
  assert.strictEqual(check(r, 'allowlist').passed, true);
  assert.strictEqual(check(r, 'allowlist').detail, 'allowlist empty — any recipient allowed');
});

test('case-insensitive allowlist match passes', () => {
  const settings = { ...SETTINGS, allowlist: ['Alice@Test.com'] };
  const r = resultFor({ amount: 100, recipient: 'alice@test.com' }, settings);
  assert.strictEqual(r.passed, true);
  assert.strictEqual(check(r, 'allowlist').passed, true);

  const r2 = resultFor({ amount: 100, recipient: 'ALICE@TEST.COM' }, settings);
  assert.strictEqual(r2.passed, true);
});

test('missing amount fails', () => {
  const r = resultFor({ amount: null, recipient: 'alice@test.com' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'amount_present').passed, false);
  assert.strictEqual(check(r, 'amount_positive').passed, false);

  const r2 = resultFor({ recipient: 'alice@test.com' });
  assert.strictEqual(r2.passed, false);
});

test('missing recipient fails', () => {
  const r = resultFor({ amount: 100, recipient: null });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'recipient_present').passed, false);
});

test('amount 0 fails', () => {
  const r = resultFor({ amount: 0, recipient: 'alice@test.com' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'amount_positive').passed, false);
  assert.strictEqual(check(r, 'amount_present').passed, false);
});

test('negative amount fails', () => {
  const r = resultFor({ amount: -50, recipient: 'alice@test.com' });
  assert.strictEqual(r.passed, false);
  assert.strictEqual(check(r, 'amount_positive').passed, false);
});
