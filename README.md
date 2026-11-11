# PayPal Agent

A natural-language payment agent for the **PayPal AI Hackathon**.

Type a payment instruction in plain Indonesian or English — e.g. *"bayar $25 ke supplier@example.com buat invoice #123"* — and the agent parses it, checks it against your guardrails, and only sends money after your explicit confirmation. Every payment goes through the PayPal **Sandbox** (Orders API v2) and is written to an audit log.

> ⚠️ **Sandbox only — no real money moves.** Every payment needs your explicit confirmation.

## The flow

1. **Type an instruction** — `bayar $25 ke supplier@example.com buat invoice #123`
2. **Parse** — an LLM (with a rule-based fallback) extracts amount, currency, recipient, invoice ID, memo and confidence.
3. **Guardrails** — the request is checked against your rules: per-transaction cap, daily cap, recipient allowlist, amount/currency sanity. Each check is shown as a pass/fail line.
4. **Confirm** — the Confirm button is **disabled** unless every guardrail passes. You approve or cancel.
5. **PayPal Sandbox capture** — on confirm, the server creates and captures a PayPal Sandbox order (Orders API v2).
6. **Receipt** — the receipt (order ID, capture ID, status, amount, timestamp) is shown in chat and appended to the transaction history / audit log.

## Setup

Requires **Node.js 20+** (developed on Node 24).

```bash
npm install
cp .env.example .env
# fill in .env (see below)
npm start
# open http://localhost:3000
```

### Environment variables

Get free PayPal Sandbox credentials at [developer.paypal.com](https://developer.paypal.com) — create a free sandbox app and copy its Client ID and Secret. **Never use live credentials.**

| Variable | Required | Default | Description |
|---|---|---|---|
| `PAYPAL_CLIENT_ID` | Yes (unless mock mode) | — | PayPal Sandbox app Client ID |
| `PAYPAL_CLIENT_SECRET` | Yes (unless mock mode) | — | PayPal Sandbox app Secret |
| `PAYPAL_MODE` | No | `sandbox` | `sandbox` (PayPal Sandbox) |
| `OPENAI_API_KEY` | No | — | OpenAI API key for LLM parsing; if unset, the rule-based parser is used |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Model used for intent parsing |
| `PORT` | No | `3000` | HTTP port |

`.env` is git-ignored and must never be committed.

## How to run

```bash
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

## How to run tests

```bash
npm test
```

Tests cover the intent parser (including the rule-based fallback), the guardrails, and the API routes.

## Architecture

Plain Node.js, no frameworks, no build step. Static files in `public/` are served by the server.

```
paypal-agent/
├── public/
│   ├── index.html   # single-page chat UI
│   ├── app.js       # vanilla JS front end, talks to /api/*
│   └── style.css    # styling, no external fonts/CDNs
├── src/
│   ├── server.js        # HTTP server + API routes
│   ├── paypalClient.js  # PayPal Orders API v2 (create + capture order)
│   ├── parser.js        # LLM intent parsing + rule-based fallback
│   ├── guardrails.js    # cap / allowlist / sanity checks
│   └── store.js         # JSON-file persistence (settings, allowlist, history)
├── data/                # JSON store files (git-ignored)
├── tests/               # npm test
└── docs/demo-script.md  # <3-minute demo storyboard
```

### API

| Method | Endpoint | Body / Response |
|---|---|---|
| GET | `/api/health` | `{status, mode}` — mode is `sandbox` or `mock` |
| POST | `/api/parse` | `{text}` → `{pendingId, intent, guardrails, requiresConfirmation}` |
| POST | `/api/confirm` | `{pendingId, confirmed}` → `{receipt}` or `{cancelled: true}` |
| GET | `/api/history` | `{transactions: [...]}` — newest first |
| GET | `/api/settings` | `{perTxCap, dailyCap, currency, allowlist}` |
| PUT | `/api/settings` | `{perTxCap, dailyCap, currency}` |
| POST | `/api/allowlist` | `{email}` |
| DELETE | `/api/allowlist` | `{email}` |

### Modules

- **`server.js`** — serves `public/`, exposes the `/api/*` routes above, holds pending (unconfirmed) intents in memory.
- **`paypalClient.js`** — PayPal Orders API v2: OAuth2 client-credentials token, create order, capture order. In mock mode it returns deterministic fake order/capture IDs so the demo works with no credentials.
- **`parser.js`** — tries the LLM first (if `OPENAI_API_KEY` is set), validates the result, and falls back to a regex/rule parser for amounts, currencies, emails, invoice numbers and memos. Works fully offline via the fallback.
- **`guardrails.js`** — pure checks, each returning `{rule, passed, detail}`: amount present and positive, amount ≤ per-transaction cap, daily total + amount ≤ daily cap, recipient on the allowlist, currency supported. All must pass before Confirm is enabled.
- **`store.js`** — tiny JSON-file store in `data/` for settings, allowlist and transaction history. No database needed.

## Prize-category mapping

| Category | How this project fits |
|---|---|
| **Best Use of Agentic Commerce** | An autonomous payment agent: it takes a natural-language instruction, plans the payment, enforces guardrails, and only executes after human confirmation — with a full audit log of every transaction. |
| **Best Use of PayPal + AI** | PayPal Orders API v2 for real order creation and capture, combined with LLM intent parsing (plus a rule-based fallback so the demo never depends on the LLM). |
| **Main prizes** | A working end-to-end demo: type → parse → guardrails → confirm → Sandbox capture → receipt, in under a minute. |

## Guardrails explained

- **Per-transaction cap** — any single payment above this amount is blocked.
- **Daily cap** — the day's confirmed payments plus the new one must stay under this total.
- **Allowlist** — the recipient email must be on the allowlist (add/remove in the UI). Unknown recipients are blocked.
- **Amount & currency sanity** — the amount must be present, positive and parseable; the currency must be one the agent supports.
- **Confirmation mandatory** — even a fully passing request does nothing until you press Confirm. The Confirm button is disabled while any check fails, and cancelling discards the pending intent.

Guardrail results are shown per rule in the confirmation card, so a blocked payment always says *which* rule blocked it.

## Mock mode

If `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` are not set, the server runs in **mock mode**: the PayPal client is replaced by a mock that returns fake order and capture IDs. The whole flow — parse, guardrails, confirm, receipt, history — works end to end with zero credentials, so judges can try it immediately. The UI shows a `mode: mock` badge in that case (and `mode: sandbox` when real sandbox credentials are configured).

## Security notes

- **Sandbox only.** The app is built for PayPal Sandbox; it never touches live PayPal or real money.
- **Confirmation is mandatory.** No payment is created or captured without an explicit Confirm click for that specific pending intent.
- **`.env` is never committed.** See `.gitignore`. Sandbox credentials stay on your machine.
- **No accounts, no sign-up.** The demo runs locally; there are no user accounts and no third-party logins.
- **Allowlist by default.** Payments to anyone not on the allowlist are refused.

## License

MIT — see [LICENSE](LICENSE).
