'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseInstruction, parseInstructionRule } = require('../src/parser');

// Ensure the LLM path is off by default in these tests (no key set).
delete process.env.OPENAI_API_KEY;

test('Indonesian full extraction: bayar $25 ke supplier@example.com buat invoice #123', async () => {
  const out = await parseInstruction('bayar $25 ke supplier@example.com buat invoice #123');
  assert.strictEqual(out.amount, 25);
  assert.strictEqual(out.currency, 'USD');
  assert.strictEqual(out.recipient, 'supplier@example.com');
  assert.strictEqual(out.invoiceId, '123');
  assert.strictEqual(out.memo, 'invoice #123');
  assert.strictEqual(out.confidence, 0.9);
  assert.strictEqual(out.method, 'rule');
});

test('rule parser: same Indonesian sentence (sync export)', () => {
  const out = parseInstructionRule('bayar $25 ke supplier@example.com buat invoice #123');
  assert.strictEqual(out.amount, 25);
  assert.strictEqual(out.currency, 'USD');
  assert.strictEqual(out.recipient, 'supplier@example.com');
  assert.strictEqual(out.invoiceId, '123');
  assert.strictEqual(out.memo, 'invoice #123');
  assert.strictEqual(out.method, 'rule');
});

test('pay 100 USD to alice@test.com', async () => {
  const out = await parseInstruction('pay 100 USD to alice@test.com');
  assert.strictEqual(out.amount, 100);
  assert.strictEqual(out.currency, 'USD');
  assert.strictEqual(out.recipient, 'alice@test.com');
  assert.strictEqual(out.confidence, 0.9);
});

test('kirim 50 ke bob@test.com (no currency -> USD)', async () => {
  const out = await parseInstruction('kirim 50 ke bob@test.com');
  assert.strictEqual(out.amount, 50);
  assert.strictEqual(out.currency, 'USD');
  assert.strictEqual(out.recipient, 'bob@test.com');
});

test('text with no amount: amount null, low confidence', async () => {
  const out = await parseInstruction('please pay supplier@example.com for the invoice');
  assert.strictEqual(out.amount, null);
  assert.strictEqual(out.recipient, 'supplier@example.com');
  assert.strictEqual(out.confidence, 0.3);
});

test('text with no recipient', async () => {
  const out = await parseInstruction('pay $40 for lunch');
  assert.strictEqual(out.amount, 40);
  assert.strictEqual(out.recipient, null);
  assert.strictEqual(out.confidence, 0.6);
  assert.strictEqual(out.memo, 'lunch');
});

test('invoice formats: #123 and invoice #INV-2026-01', () => {
  const a = parseInstructionRule('pay 75 USD to alice@test.com for invoice #123');
  assert.strictEqual(a.invoiceId, '123');
  assert.strictEqual(a.memo, 'invoice #123');

  const b = parseInstructionRule('bayar $80 ke bob@test.com buat invoice #INV-2026-01');
  assert.strictEqual(b.invoiceId, 'INV-2026-01');
  assert.strictEqual(b.memo, 'invoice #INV-2026-01');

  const c = parseInstructionRule('transfer 10 USD to carol@test.com #INV-2026-01');
  assert.strictEqual(c.invoiceId, 'INV-2026-01');
});

test('EUR currency', async () => {
  const out = await parseInstruction('pay 60 EUR to alice@test.com');
  assert.strictEqual(out.amount, 60);
  assert.strictEqual(out.currency, 'EUR');
  assert.strictEqual(out.recipient, 'alice@test.com');
});

test('dollars wording and transfer/send verbs', () => {
  const a = parseInstructionRule('send 20 dollars to dave@test.com');
  assert.strictEqual(a.amount, 20);
  assert.strictEqual(a.currency, 'USD');

  const b = parseInstructionRule('transfer $33 to eve@test.com untuk invoice #9');
  assert.strictEqual(b.amount, 33);
  assert.strictEqual(b.invoiceId, '9');
  assert.strictEqual(b.memo, 'invoice #9');
});

test('LLM path mocked via injected fetch (opts.fetchImpl)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const fakeFetch = async (url, options) => {
      assert.ok(String(url).includes('/chat/completions'));
      assert.strictEqual(options.method, 'POST');
      assert.ok(options.headers.Authorization.includes('test-key'));
      const body = JSON.parse(options.body);
      assert.strictEqual(body.model, 'gpt-4o-mini');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                amount: 42,
                currency: 'EUR',
                recipient: 'llm@test.com',
                invoiceId: 'INV-99',
                memo: 'LLM memo',
              }),
            },
          }],
        }),
      };
    };
    const out = await parseInstruction('whatever the user typed', { fetchImpl: fakeFetch });
    assert.strictEqual(out.method, 'llm');
    assert.strictEqual(out.amount, 42);
    assert.strictEqual(out.currency, 'EUR');
    assert.strictEqual(out.recipient, 'llm@test.com');
    assert.strictEqual(out.invoiceId, 'INV-99');
    assert.strictEqual(out.memo, 'LLM memo');
    assert.strictEqual(out.confidence, 0.9);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('LLM path mocked via opts.fetch alias', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const fakeFetch = async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"amount": 7, "currency": "USD", "recipient": "x@y.com", "invoiceId": null, "memo": null}' } }],
      }),
    });
    const out = await parseInstruction('pay seven?', { fetch: fakeFetch });
    assert.strictEqual(out.method, 'llm');
    assert.strictEqual(out.amount, 7);
    assert.strictEqual(out.recipient, 'x@y.com');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('LLM failure falls back to rule parser (network error)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const failingFetch = async () => { throw new Error('network down'); };
    const out = await parseInstruction('bayar $25 ke supplier@example.com buat invoice #123', { fetchImpl: failingFetch });
    assert.strictEqual(out.method, 'rule');
    assert.strictEqual(out.amount, 25);
    assert.strictEqual(out.recipient, 'supplier@example.com');
    assert.strictEqual(out.invoiceId, '123');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('LLM failure falls back to rule parser (non-JSON reply)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const badFetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json at all' } }] }),
    });
    const out = await parseInstruction('pay 100 USD to alice@test.com', { fetchImpl: badFetch });
    assert.strictEqual(out.method, 'rule');
    assert.strictEqual(out.amount, 100);
    assert.strictEqual(out.recipient, 'alice@test.com');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('LLM failure falls back to rule parser (missing fields)', async () => {
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const badFetch = async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"foo": 1}' } }] }),
    });
    const out = await parseInstruction('kirim 50 ke bob@test.com', { fetchImpl: badFetch });
    assert.strictEqual(out.method, 'rule');
    assert.strictEqual(out.amount, 50);
    assert.strictEqual(out.recipient, 'bob@test.com');
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('no API key -> rule parser even if fetch would succeed', async () => {
  delete process.env.OPENAI_API_KEY;
  let called = false;
  const fakeFetch = async () => { called = true; throw new Error('should not be called'); };
  const out = await parseInstruction('pay 100 USD to alice@test.com', { fetchImpl: fakeFetch });
  assert.strictEqual(called, false);
  assert.strictEqual(out.method, 'rule');
  assert.strictEqual(out.amount, 100);
});
