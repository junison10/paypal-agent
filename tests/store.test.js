'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paypal-agent-store-'));
  return { dir, store: createStore(dir) };
}

test('store creates data dir and files with defaults', () => {
  const { dir, store } = tempStore();
  assert.deepEqual(store.getSettings(), { perTxCap: 500, dailyCap: 2000, currency: 'USD', allowlist: [] });
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  assert.ok(fs.existsSync(path.join(dir, 'history.json')));
  assert.ok(fs.existsSync(path.join(dir, 'pending.json')));
  assert.deepEqual(store.getHistory(), []);
  assert.equal(store.getTodayTotal(), 0);
});

test('store updateSettings merges and persists across instances', () => {
  const { dir, store } = tempStore();
  const updated = store.updateSettings({ perTxCap: 100, currency: 'EUR' });
  assert.equal(updated.perTxCap, 100);
  assert.equal(updated.currency, 'EUR');
  assert.equal(updated.dailyCap, 2000);
  const reopened = createStore(dir);
  assert.equal(reopened.getSettings().perTxCap, 100);
  assert.equal(reopened.getSettings().currency, 'EUR');
});

test('store allowlist add/remove is case-insensitive and deduped', () => {
  const { store } = tempStore();
  assert.deepEqual(store.addAllowlist('Alice@Example.com'), ['alice@example.com']);
  assert.deepEqual(store.addAllowlist('alice@example.com'), ['alice@example.com']);
  assert.deepEqual(store.getAllowlist(), ['alice@example.com']);
  assert.deepEqual(store.removeAllowlist('ALICE@example.com'), []);
  assert.deepEqual(store.getAllowlist(), []);
});

test('store history and getTodayTotal count only today COMPLETED transactions', () => {
  const { store } = tempStore();
  const today = new Date().toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  store.addTransaction({ amount: 25, currency: 'USD', status: 'COMPLETED', timestamp: today });
  store.addTransaction({ amount: 100, currency: 'USD', status: 'COMPLETED', timestamp: yesterday });
  store.addTransaction({ amount: 50, currency: 'USD', status: 'PENDING', timestamp: today });
  assert.equal(store.getTodayTotal(), 25);
  const history = store.getHistory();
  assert.equal(history.length, 3);
  assert.ok(history.every((tx) => typeof tx.id === 'string' && tx.id.length > 0));
});

test('store pending save/get/delete round-trips', () => {
  const { store } = tempStore();
  const saved = store.savePending({ intent: { amount: 10 }, guardrails: { allowed: true } });
  assert.ok(saved.id);
  assert.deepEqual(store.getPending(saved.id).intent, { amount: 10 });
  assert.equal(store.getPending('no-such-id'), null);
  assert.equal(store.deletePending(saved.id), true);
  assert.equal(store.getPending(saved.id), null);
});
