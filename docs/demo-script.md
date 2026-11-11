# Demo script — PayPal Agent (< 3:00, YouTube)

Total runtime target: **2:55**. Format: **slideshow + voiceover** — static
screenshots of the running app, one per shot, with the narration below read
over them, assembled with ffmpeg. No screen recording needed. Take the
screenshots at 1080p (browser window maximised, 1920×1080) so each slide
fills the frame; make sure the sandbox/mock badge and the warning banner are
visible in shot 1.

**Before screenshots:** start the server (`npm start`), then seed the demo
state with one call (mock mode only):

```sh
curl -X POST http://localhost:3000/api/demo/seed
```

That sets per-transaction cap **$50**, daily cap **$200**, allowlist
`supplier@example.com` + `alice@test.com`, and 3 sample completed payments
in history. Keep the server in mock mode for the screenshots (no
credentials needed) — say "mock mode" in shot 1 if the badge shows it, or
re-shoot shot 4 in sandbox mode later once credentials exist. To wipe the
demo data afterwards: `curl -X POST http://localhost:3000/api/demo/reset`.

## Screenshot list (one file per shot — take these in order)

| # | File | State on screen | How to reach it |
|---|---|---|---|
| 1 | `shot-01-empty.png` | Empty chat, header + badges + warning banner | Fresh load of http://localhost:3000 after `POST /api/demo/reset` |
| 2 | `shot-02-parsed.png` | Confirmation card for the $25 payment, intent fields visible | Click example chip `bayar $25 ke supplier@example.com buat invoice #123` |
| 3a | `shot-03a-guardrails-pass.png` | Same card, guardrail list all green, Confirm enabled | Same as shot 2 (zoom/crop on the guardrail list if needed) |
| 3b | `shot-03b-blocked.png` | Blocked card: $100 payment, per-tx-cap check failed, Confirm greyed out | Type `bayar $100 ke supplier@example.com buat invoice #124`, Send |
| 4 | `shot-04-receipt.png` | Receipt card: COMPLETED, $25, order + capture IDs | On the shot-2 card, click **Confirm & pay** |
| 5 | `shot-05-history.png` | Right panel: history list + settings + allowlist | Scroll the side panel into view (seeded history already there) |
| 6 | `shot-06-wrap.png` | Full app / chat view | Scroll back to the top of the chat |

Narration is read over the matching slide; hold each slide for the full
duration of its shot (see timings below).

---

## 0:00–0:15 — Intro + problem

**Slide:** `shot-01-empty.png` — the app homepage, full window. Cursor resting on the header.

**Say (exact lines):**

> "Paying someone should be as easy as telling someone to pay them. But
> today it's still copy the email, open PayPal, type the amount, type the
> invoice number — and hope you didn't mistype anything. This is PayPal
> Agent: you just type what you want, in plain language, and it handles the
> rest — safely."

**Screenshot:** fresh load of the app after `POST /api/demo/reset` (empty
chat). Let the viewer read the header
("PayPal Agent — bayar pakai bahasa natural") and the "SANDBOX — no real
money" badge.

## 0:15–0:45 — Type a payment, watch it parse

**Slide:** `shot-02-parsed.png` — chat area with the confirmation card.

**Say:**

> "Let's pay a supplier. I type: bayar twenty-five dollars to
> supplier@example.com for invoice one-two-three — and hit Send."

**Screenshot:** click the first example chip:
`bayar $25 ke supplier@example.com buat invoice #123` (or type it by hand).
Wait for the confirmation card to appear, then capture the screen.

**Say (as the card appears):**

> "The agent parsed it: twenty-five dollars, USD, to supplier@example.com,
> invoice one-two-three. That's the intent card — everything it understood,
> before any money moves."

## 0:45–1:20 — Guardrails panel + a blocked over-cap attempt

**Slides:** `shot-03a-guardrails-pass.png` (first ~35s), then
`shot-03b-blocked.png` (remaining ~40s).

**Say:**

> "Before I can pay, it checks the guardrails: amount present, under my
> fifty-dollar per-transaction cap, under my daily cap, and the recipient is
> on my allowlist. All green — so Confirm is enabled. But watch what
> happens when a payment breaks the rules."

**Screenshot (03a):** the shot-2 confirmation card with the guardrail list
visible (crop/zoom on the list if needed for readability).

**Say (cut to 03b):**

> "One hundred dollars is over my fifty-dollar cap, so this check fails —
> and look, the Confirm button is greyed out. The agent refuses to pay. No
> override, no silent retry. Cancel it, and nothing happened."

**Screenshot (03b):** type `bayar $100 ke supplier@example.com buat invoice #124`
and hit Send; capture the new card showing the failed per-tx-cap check and
the disabled Confirm button. Then click **Cancel** on it (the receipt area
says "Payment cancelled — no money moved").

## 1:20–2:10 — Confirm → capture → receipt

**Slide:** `shot-04-receipt.png` — the receipt card. (The first ($25)
confirmation card from shot 2 — scroll back up to it.)

**Say:**

> "Back to the good payment. Everything passes, so I press Confirm — and
> this is the only moment money moves."

**Screenshot:** click **Confirm & pay** on the $25 card; wait for the
receipt card, then capture the screen.

**Say:**

> "Done. The server created a PayPal Sandbox order and captured it. Here's
> the receipt: status completed, twenty-five dollars to supplier@example.com,
> and the real sandbox order ID and capture ID. That's a live PayPal
> transaction — sandbox money only, of course."

**Note:** in mock mode the IDs read `MOCK-ORDER-…` / `MOCK-CAPTURE-…`.
If sandbox credentials are available, re-shoot this one slide in sandbox
mode so the receipt shows a real sandbox order ID, and say "sandbox" in
the narration instead of "mock".

## 2:10–2:45 — History + settings / allowlist tour

**Slide:** `shot-05-history.png` — the side panel: history list, settings,
allowlist.

**Say:**

> "Every payment lands in the history — newest first, with status, amount,
> and IDs. That's the audit log. And here are the controls: the
> per-transaction and daily caps I set earlier, the currency, and the
> allowlist. Only people on this list can be paid — add or remove an email
> and the next payment respects it immediately."

**Screenshot:** scroll the right-hand panel into view; the seeded history
($25 payment at the top, plus the two older demo payments) and the
settings/allowlist are already there from `POST /api/demo/seed`.

## 2:45–3:00 — Wrap-up + prize-category callout

**Slide:** `shot-06-wrap.png` — full app / chat view.

**Say:**

> "PayPal Agent: natural language in, guardrailed PayPal payment out —
> parse, check, confirm, capture, receipt. It's built for the PayPal AI
> Hackathon — Best Use of Agentic Commerce, and Best Use of PayPal plus AI.
> Link and code in the description. Thanks for watching."

**Screenshot:** scroll back to the top of the chat. Stop the voiceover at
or before 3:00.

---

## Checklist before screenshots

- [ ] Server running (`npm start`), app open at http://localhost:3000
- [ ] Demo state seeded: `curl -X POST http://localhost:3000/api/demo/seed`
      (caps $50/$200, allowlist supplier@example.com + alice@test.com,
      3 sample payments in history)
- [ ] `supplier@example.com` on the allowlist (done by the seed call)
- [ ] Know which mode you're in — mock mode simulates the capture with no
      credentials; sandbox mode needs PayPal sandbox credentials in `.env`
- [ ] No real credentials, passwords, or API keys visible on screen at any point
- [ ] After screenshots: `curl -X POST http://localhost:3000/api/demo/reset`
      to wipe demo data before the real submission
