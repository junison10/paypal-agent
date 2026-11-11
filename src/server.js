'use strict';

const path = require('path');
const express = require('express');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Try to load a sibling module export; return null when absent. */
function tryRequireExport(modulePath, exportName) {
  try {
    const mod = require(modulePath);
    if (typeof mod === 'function' && exportName === 'default') return mod;
    if (mod && typeof mod[exportName] === 'function') return mod[exportName];
    if (typeof mod === 'function') return mod;
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize the many plausible guardrail result shapes to {allowed, reasons, ...original}.
 * Supported: {allowed}, {blocked}, {pass}, {ok}, {violations[]}, {reasons[]}.
 */
function normalizeGuardrails(result) {
  if (result === true) return { allowed: true, reasons: [] };
  if (result === false) return { allowed: false, reasons: ['Blocked by guardrails'] };
  if (!result || typeof result !== 'object') {
    return { allowed: false, reasons: ['Guardrail evaluation returned no result'] };
  }
  if (typeof result.allowed === 'boolean') {
    return { ...result, reasons: result.reasons || result.violations || [] };
  }
  if (typeof result.passed === 'boolean') {
    const reasons =
      result.reasons ||
      result.violations ||
      (Array.isArray(result.checks)
        ? result.checks.filter((c) => c.passed === false).map((c) => c.detail || c.rule)
        : []);
    return { ...result, allowed: result.passed, reasons };
  }
  if (typeof result.blocked === 'boolean') {
    return { ...result, allowed: !result.blocked, reasons: result.reasons || result.violations || [] };
  }
  if (typeof result.pass === 'boolean') {
    return { ...result, allowed: result.pass, reasons: result.reasons || result.violations || [] };
  }
  if (typeof result.ok === 'boolean') {
    return { ...result, allowed: result.ok, reasons: result.reasons || result.violations || [] };
  }
  if (Array.isArray(result.violations)) {
    return { ...result, allowed: result.violations.length === 0, reasons: result.violations };
  }
  if (Array.isArray(result.reasons)) {
    return { ...result, allowed: result.reasons.length === 0 };
  }
  return { ...result, allowed: true, reasons: [] };
}

function guardrailsPass(guardrails) {
  return normalizeGuardrails(guardrails).allowed === true;
}

/** Call evaluateGuardrails tolerating (intent, settings, todayTotal) and (intent, context) signatures. */
function runGuardrails(evaluateGuardrails, intent, settings, todayTotal) {
  const context = { settings, todayTotal, allowlist: settings.allowlist || [] };
  if (evaluateGuardrails.length >= 3) {
    return evaluateGuardrails(intent, settings, todayTotal);
  }
  if (evaluateGuardrails.length === 2) {
    return evaluateGuardrails(intent, context);
  }
  // length 0/1: pass the full calling convention anyway; extra args are ignored.
  return evaluateGuardrails(intent, settings, todayTotal);
}

function extractCaptureId(capture) {
  try {
    const c = capture.purchase_units[0].payments.captures[0];
    return c.id || null;
  } catch {
    return null;
  }
}

/**
 * Build the Express app. parseInstruction / evaluateGuardrails may be injected;
 * otherwise they are lazily required from sibling modules (./parser, ./guardrails).
 */
function createApp({ paypalClient, store, parseInstruction, evaluateGuardrails } = {}) {
  if (!paypalClient) throw new Error('createApp requires a paypalClient');
  if (!store) throw new Error('createApp requires a store');

  const parseFn =
    parseInstruction ||
    tryRequireExport('./parser', 'parseInstruction') ||
    tryRequireExport('./parser', 'parse') ||
    null;
  const guardrailsFn =
    evaluateGuardrails ||
    tryRequireExport('./guardrails', 'evaluateGuardrails') ||
    tryRequireExport('./guardrails', 'evaluate') ||
    null;

  const app = express();
  app.use(express.json());
  app.use('/', express.static(path.join(__dirname, '..', 'public')));

  const mode = paypalClient.mode === 'mock' ? 'mock' : 'sandbox';

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', mode });
  });

  app.post('/api/parse', async (req, res) => {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (!parseFn) {
      return res.status(500).json({ error: 'Parser module is not available' });
    }
    if (!guardrailsFn) {
      return res.status(500).json({ error: 'Guardrails module is not available' });
    }
    let parsed;
    try {
      // parseInstruction may be sync (rule parser) or async (LLM path).
      parsed = await parseFn(text);
    } catch (err) {
      return res.status(400).json({ error: `Could not parse instruction: ${err.message}` });
    }
    // Parser may return the intent directly or wrapped as {intent}.
    const intent = parsed && parsed.intent ? parsed.intent : parsed;
    if (!intent || typeof intent !== 'object') {
      return res.status(400).json({ error: 'Could not parse instruction into an intent' });
    }
    const settings = store.getSettings();
    const todayTotal = store.getTodayTotal();
    let guardrails;
    try {
      guardrails = normalizeGuardrails(runGuardrails(guardrailsFn, intent, settings, todayTotal));
    } catch (err) {
      return res.status(500).json({ error: `Guardrail evaluation failed: ${err.message}` });
    }
    const pending = store.savePending({
      intent,
      guardrails,
      createdAt: new Date().toISOString(),
    });
    return res.json({ pendingId: pending.id, intent, guardrails, requiresConfirmation: true });
  });

  app.post('/api/confirm', async (req, res) => {
    const { pendingId, confirmed } = req.body || {};
    if (!pendingId) {
      return res.status(400).json({ error: 'pendingId is required' });
    }
    const pending = store.getPending(pendingId);
    if (!pending) {
      return res.status(404).json({ error: 'Pending payment not found' });
    }
    if (confirmed === false) {
      store.deletePending(pendingId);
      return res.json({ cancelled: true });
    }
    if (confirmed !== true) {
      return res.status(400).json({ error: 'confirmed must be true or false' });
    }

    // Re-check guardrails against current settings / today's total.
    if (guardrailsFn) {
      const settings = store.getSettings();
      const todayTotal = store.getTodayTotal();
      let guardrails;
      try {
        guardrails = normalizeGuardrails(runGuardrails(guardrailsFn, pending.intent, settings, todayTotal));
      } catch (err) {
        return res.status(500).json({ error: `Guardrail evaluation failed: ${err.message}` });
      }
      if (!guardrailsPass(guardrails)) {
        return res.status(400).json({
          error: 'Guardrails no longer pass',
          guardrails,
        });
      }
    }

    const intent = pending.intent || {};
    const amount = Number(intent.amount);
    const currency = intent.currency || store.getSettings().currency || 'USD';
    const recipient = intent.recipientEmail || intent.recipient || null;
    try {
      const order = await paypalClient.createOrder({
        amount,
        currency,
        recipientEmail: recipient || undefined,
        invoiceId: intent.invoiceId,
        memo: intent.memo,
      });
      const capture = await paypalClient.captureOrder(order.id);
      const captureId = extractCaptureId(capture);
      const receipt = {
        orderId: order.id,
        captureId,
        status: (capture && capture.status) || 'COMPLETED',
        amount,
        currency,
        recipient,
        invoiceId: intent.invoiceId || null,
        memo: intent.memo || null,
        timestamp: new Date().toISOString(),
      };
      store.addTransaction({ ...receipt });
      store.deletePending(pendingId);
      return res.json({ receipt });
    } catch (err) {
      // Keep the pending record so the user can retry after fixing the cause.
      return res.status(500).json({ error: `Payment failed: ${err.message}` });
    }
  });

  app.get('/api/history', (_req, res) => {
    const transactions = [...store.getHistory()].sort((a, b) =>
      String(b.timestamp || '').localeCompare(String(a.timestamp || '')),
    );
    res.json({ transactions });
  });

  app.get('/api/settings', (_req, res) => {
    res.json(store.getSettings());
  });

  app.put('/api/settings', (req, res) => {
    const { perTxCap, dailyCap, currency } = req.body || {};
    const patch = {};
    if (perTxCap !== undefined) {
      if (typeof perTxCap !== 'number' || !(perTxCap > 0)) {
        return res.status(400).json({ error: 'perTxCap must be a number greater than 0' });
      }
      patch.perTxCap = perTxCap;
    }
    if (dailyCap !== undefined) {
      if (typeof dailyCap !== 'number' || !(dailyCap > 0)) {
        return res.status(400).json({ error: 'dailyCap must be a number greater than 0' });
      }
      patch.dailyCap = dailyCap;
    }
    if (currency !== undefined) {
      if (typeof currency !== 'string' || !currency.trim()) {
        return res.status(400).json({ error: 'currency must be a non-empty string' });
      }
      patch.currency = currency.trim().toUpperCase();
    }
    res.json(store.updateSettings(patch));
  });

  app.post('/api/allowlist', (req, res) => {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    res.json({ allowlist: store.addAllowlist(email) });
  });

  app.delete('/api/allowlist', (req, res) => {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    res.json({ allowlist: store.removeAllowlist(email) });
  });

  // ---- Demo / seed mode (mock mode ONLY — never in sandbox/live) ----
  // Lets the demo video be shot from static screenshots: one call puts the
  // app into the exact state the demo script needs (caps, allowlist, history).
  function requireMock(_req, res) {
    if (mode !== 'mock') {
      res.status(403).json({ error: 'Demo seed/reset is only available in mock mode' });
      return false;
    }
    return true;
  }

  const DEMO_TRANSACTIONS = [
    {
      orderId: 'MOCK-ORDER-DEMO001',
      captureId: 'MOCK-CAPTURE-DEMO001',
      status: 'COMPLETED',
      amount: 25,
      currency: 'USD',
      recipient: 'supplier@example.com',
      invoiceId: '123',
      memo: 'invoice #123',
      timestamp: new Date(Date.now() - 1000 * 60 * 42).toISOString(),
    },
    {
      orderId: 'MOCK-ORDER-DEMO002',
      captureId: 'MOCK-CAPTURE-DEMO002',
      status: 'COMPLETED',
      amount: 100,
      currency: 'USD',
      recipient: 'alice@test.com',
      invoiceId: 'INV-2026-01',
      memo: 'hosting',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
    },
    {
      orderId: 'MOCK-ORDER-DEMO003',
      captureId: 'MOCK-CAPTURE-DEMO003',
      status: 'COMPLETED',
      amount: 10,
      currency: 'USD',
      recipient: 'bob@test.com',
      invoiceId: null,
      memo: 'refund test',
      timestamp: new Date(Date.now() - 1000 * 60 * 60 * 26).toISOString(),
    },
  ];

  app.post('/api/demo/seed', (req, res) => {
    if (!requireMock(req, res)) return;
    store.resetSettings();
    store.updateSettings({ perTxCap: 50, dailyCap: 200, currency: 'USD' });
    store.addAllowlist('supplier@example.com');
    store.addAllowlist('alice@test.com');
    store.clearHistory();
    store.clearPending();
    for (const tx of DEMO_TRANSACTIONS) store.addTransaction({ ...tx });
    res.json({ seeded: true, settings: store.getSettings(), transactions: store.getHistory() });
  });

  app.post('/api/demo/reset', (req, res) => {
    if (!requireMock(req, res)) return;
    store.clearHistory();
    store.clearPending();
    store.resetSettings();
    res.json({ reset: true, settings: store.getSettings(), transactions: [] });
  });

  return app;
}

module.exports = { createApp, normalizeGuardrails };
