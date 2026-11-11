'use strict';

/**
 * Rule-based instruction parser (pure, sync).
 *
 * Handles English and Indonesian phrasing, e.g.
 *   "bayar $25 ke supplier@example.com buat invoice #123"
 *   "pay 100 USD to alice@test.com"
 *   "kirim 50 ke bob@test.com"
 */

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const CURRENCY_RE = /\b(USD|EUR|GBP|SGD|IDR)\b/i;
const INVOICE_RE = /invoice\s*#?\s*([A-Za-z0-9-]+)/i;
const HASH_INVOICE_RE = /#([A-Za-z0-9-]{2,})/;
const MEMO_RE = /(?:buat|for|untuk)\s+(.+)$/i;

function parseNumber(raw) {
  // Decimal separator may be '.' or ',' (e.g. "25,50" -> 25.5).
  const n = Number(String(raw).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function extractAmountCurrency(text) {
  let amount = null;
  let currency = null;

  // 1. $ amount, optional currency code right after it.
  let m = /\$\s*(\d+(?:[.,]\d{1,2})?)\s?(USD|EUR|GBP|SGD|IDR)?/i.exec(text);
  if (m) {
    amount = parseNumber(m[1]);
    if (m[2]) currency = m[2].toUpperCase();
  }

  // 2. Number + explicit currency code ("100 USD", "50 EUR").
  if (amount === null) {
    m = /(\d+(?:[.,]\d{1,2})?)\s?(USD|EUR|GBP|SGD|IDR)/i.exec(text);
    if (m) {
      amount = parseNumber(m[1]);
      currency = m[2].toUpperCase();
    }
  }

  // 3. Number + "dollars"/"usd" word ("100 dollars").
  if (amount === null) {
    m = /(\d+(?:[.,]\d{1,2})?)\s?(dollars?|usd)/i.exec(text);
    if (m) {
      amount = parseNumber(m[1]);
      currency = 'USD';
    }
  }

  // 4. Bare number right after a payment verb ("kirim 50 ke ...",
  //    "bayar 25 ...", "pay 50 ..."). This avoids mistaking an
  //    invoice number (after '#') for the amount.
  if (amount === null) {
    m = /(?:bayar|transfer|kirim|pay|send)\s+\$?\s*(\d+(?:[.,]\d{1,2})?)\b/i.exec(text);
    if (m) {
      amount = parseNumber(m[1]);
    }
  }

  // Explicit currency code anywhere in the text wins over the default.
  if (amount !== null && currency === null) {
    const cm = CURRENCY_RE.exec(text);
    if (cm) currency = cm[1].toUpperCase();
  }

  return { amount, currency: currency || 'USD' };
}

function parseInstructionRule(text) {
  const input = typeof text === 'string' ? text : String(text == null ? '' : text);

  const { amount, currency } = extractAmountCurrency(input);

  const recipientMatch = EMAIL_RE.exec(input);
  const recipient = recipientMatch ? recipientMatch[0] : null;

  let invoiceId = null;
  const invoiceMatch = INVOICE_RE.exec(input);
  if (invoiceMatch) {
    invoiceId = invoiceMatch[1];
  } else {
    const hashMatch = HASH_INVOICE_RE.exec(input);
    if (hashMatch) invoiceId = hashMatch[1];
  }

  // Memo: text after "buat" / "for" / "untuk", trimmed.
  let memo = null;
  const memoMatch = MEMO_RE.exec(input);
  if (memoMatch) {
    const cleaned = memoMatch[1].trim().replace(/[.\s]+$/, '').trim();
    if (cleaned) memo = cleaned;
  }

  let confidence;
  if (amount !== null && recipient !== null) confidence = 0.9;
  else if (amount !== null) confidence = 0.6;
  else confidence = 0.3;

  return {
    amount,
    currency,
    recipient,
    invoiceId,
    memo,
    confidence,
    method: 'rule',
  };
}

const SYSTEM_PROMPT = [
  'You parse a payment instruction into strict JSON.',
  'Respond with ONLY a JSON object with exactly these keys:',
  'amount (number or null), currency (3-letter code, e.g. USD, or null),',
  'recipient (email address string or null), invoiceId (string or null),',
  'memo (string or null).',
  'Do not add any other keys, explanation, or markdown.',
].join(' ');

function normalizeLlmResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM reply is not a JSON object');
  }
  // Missing fields -> fall through to the rule parser.
  if (!('amount' in parsed) || !('recipient' in parsed)) {
    throw new Error('LLM reply is missing required fields');
  }
  let amount = null;
  if (parsed.amount !== null && parsed.amount !== undefined && parsed.amount !== '') {
    amount = typeof parsed.amount === 'number' ? parsed.amount : Number(parsed.amount);
    if (!Number.isFinite(amount)) amount = null;
  }
  let currency = 'USD';
  if (typeof parsed.currency === 'string' && /^[A-Za-z]{3}$/.test(parsed.currency.trim())) {
    currency = parsed.currency.trim().toUpperCase();
  }
  const recipient = typeof parsed.recipient === 'string' && parsed.recipient.trim()
    ? parsed.recipient.trim()
    : null;
  const invoiceId = parsed.invoiceId === null || parsed.invoiceId === undefined
    ? null
    : String(parsed.invoiceId);
  const memo = typeof parsed.memo === 'string' && parsed.memo.trim()
    ? parsed.memo.trim()
    : null;

  let confidence;
  if (amount !== null && recipient !== null) confidence = 0.9;
  else if (amount !== null) confidence = 0.6;
  else confidence = 0.3;

  return { amount, currency, recipient, invoiceId, memo, confidence, method: 'llm' };
}

function extractJsonFromContent(content) {
  const raw = String(content).trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Tolerate ```json fences around the object.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1].trim());
    const braced = raw.match(/\{[\s\S]*\}/);
    if (braced) return JSON.parse(braced[0]);
    throw new Error('LLM reply is not valid JSON');
  }
}

/**
 * Parse a payment instruction.
 * LLM path only when OPENAI_API_KEY is set (and opts.llm !== false);
 * any LLM error falls through to the rule parser.
 * Tests may inject a fake fetch via opts.fetchImpl or opts.fetch.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.llm] - set false to force the rule parser
 * @param {Function} [opts.fetchImpl] - fetch implementation (tests)
 * @param {Function} [opts.fetch] - alias for fetchImpl (tests)
 * @returns {Promise<{amount:number|null,currency:string,recipient:string|null,invoiceId:string|null,memo:string|null,confidence:number,method:'llm'|'rule'}>}
 */
async function parseInstruction(text, opts = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const fetchImpl = opts.fetchImpl || opts.fetch || globalThis.fetch;

  if (opts.llm !== false && apiKey && typeof fetchImpl === 'function') {
    try {
      const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: String(text) },
            ],
          }),
          signal: controller.signal,
        });
        if (!res || !res.ok) throw new Error(`LLM request failed: ${res ? res.status : 'no response'}`);
        const data = typeof res.json === 'function' ? await res.json() : res;
        const content = data && data.choices && data.choices[0]
          && data.choices[0].message && data.choices[0].message.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('LLM reply has no content');
        }
        return normalizeLlmResult(extractJsonFromContent(content));
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Fall through to the rule parser on any LLM error.
    }
  }

  return parseInstructionRule(text);
}

module.exports = { parseInstruction, parseInstructionRule };
