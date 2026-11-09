# Chaperone

**Purchase protection for AI shopping agents, built on PayPal.** Agents can shop. Nothing moves until it's right.

[![CI](https://github.com/apexxx01/chaperone/actions/workflows/ci.yml/badge.svg)](https://github.com/apexxx01/chaperone/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-85%20passing-2f7d4f)
![license](https://img.shields.io/badge/license-MIT-0f5e5a)

AI agents are starting to spend money for people, and they are easy to fool. A June 2026 benchmark (StakeBench) found indirect prompt injection hijacks GPT-5 and Gemini web agents **42–68%** of the time. Microsoft's Magentic Marketplace study watched shopping agents hand all their money to malicious sellers.

Most "agent wallet" tools stop at *should the agent buy this?* Chaperone covers the **whole life of the purchase**:

1. **Before:** a gate. Deterministic policy, Channel3 market-price check, an injection scanner, and a dual-LLM Gemini auditor that never reads the untrusted page.
2. **During:** the money is **authorized, not captured** (PayPal Orders v2 `intent=AUTHORIZE`). Held, not moved.
3. **After:** what arrived is checked against what you asked for. Match: **capture**, add tracking, pay the seller with **Payouts**. Short shipment: capture only what arrived. Wrong item: **void**, and the money never moved.

![Architecture](docs/architecture.svg)

## Try it

| | |
|---|---|
| **Live demo** | _hosted URL goes here after deploy_ |
| **One command (no keys)** | `docker compose -f repro/compose.yaml up` → http://localhost:8787 |
| **From source** | `npm ci && npm run build -w web && npm run demo` |
| **Red team** | `npm run redteam` (offline) or with keys in `.env` for the PayPal sandbox |
| **Tests** | `npm test` |

Offline mode needs no keys: payments go to a PayPal simulator that enforces the same state rules (no capture after void, no over-capture, idempotent request ids), the AI runs on labeled heuristics, and products come from a fixture catalog in Channel3's schema. The console always shows which of PayPal / Gemini / Channel3 is live.

### Run against the real PayPal sandbox

```bash
cp .env.example .env
# PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET  → developer.paypal.com → Apps & Credentials → Sandbox
# GEMINI_API_KEY                           → aistudio.google.com/apikey
# CHANNEL3_API_KEY                         → trychannel3.com/developers (promo PAYPAL-HACKATHON-2026)
npm ci && npm run build -w web && npm start      # http://localhost:8787
```

Approve a mandate with your **sandbox personal (buyer) account** from the Developer Dashboard → Testing Tools → Sandbox Accounts. If your sandbox app doesn't have "Save payment methods" enabled, set `PAYPAL_PAYMENT_MODE=card` to authorize with PayPal's published sandbox test card instead.

## Receipts

Red team, full-compromise mode (we assume the agent falls for every attack, then follow the money). Offline simulator run, reproduce with `npm run redteam`:

| | Agent alone (holds PayPal tools directly) | Same agent through Chaperone |
|---|---|---|
| Money moved by attacks | **−$1,358.14** on 20 / 20 attacks | **$0.00** moved to the wrong place |
| Outcome | captured immediately | 18 blocked at the gate · 2 caught after purchase (bait-and-switch voided, short shipment partially captured) |
| Honest purchases | n/a | 4 / 4 completed, 0 false positives |

The 20 attacks: instructions addressed to the AI, Unicode tag smuggling, fake `SYSTEM:` messages in reviews, HTML comments, `amaz0n.com`, a Cyrillic `у` in `bestbuу.com`, fake surcharges, quiet 70% markups, pack-size quantity pushes, persuasion with no AI keywords, payee swaps (visible and hidden), approval spoofing, concealment requests, a "65W-compatible" 30W charger, `<|im_start|>` tokens, zero-width splitting, an instruction in Hindi, bait-and-switch, and a short shipment. See [`server/src/redteam/attacks.ts`](server/src/redteam/attacks.ts).

`npm run hijack` measures the other half: how often a real Gemini agent actually falls for each attack.

**Dogfood:** running Chaperone's own seeded demo through itself caught a real bug. Wired headphones were authorized against a "noise-cancelling" mandate because the spec matcher read `noise_canceling: no` as a match. Fixed in [`2722b90`](../../commit/2722b90) with regression tests.

## How PayPal is used

| Primitive | Where |
|---|---|
| Vault v3 setup token → payer approval → payment token | Signing a mandate once ([`paypal/client.ts`](server/src/paypal/client.ts)) |
| Orders v2 `intent=AUTHORIZE` with `vault_id` + stored credential | Every agent purchase: funds held, not moved |
| Authorizations: capture (full, and final partial) | Verified delivery / short shipment |
| Authorizations: void | Wrong item, the money never moved |
| Captures: refund | Problems after capture |
| Orders: add tracking | Carrier tracking attached after capture |
| Payouts | Seller paid only after verified delivery |
| Transaction Search | Ledger reconciliation |
| Webhooks + signature verification | `PAYMENT.*` events on the purchase timeline |
| `PayPal-Request-Id` on every POST | Safe retries, no double charges |

## How AI is used

- **Mandate drafting** (Gemini, structured output): your sentence becomes limits you confirm. The model proposes; you sign.
- **Shopping agent** (Gemini function calling): deliberately ordinary and unhardened. Chaperone protects the money even when it's fooled.
- **Quarantined reader** (Gemini, booleans-only schema): reads untrusted page text and can only flip fixed flags, so injected text can't pass instructions along.
- **Privileged auditor** (Gemini, structured output): sees your words and verified facts, never the page. Decides whether the purchase serves your instruction.
- **Delivery comparison** (Gemini, booleans only): does the manifest match the order?
- Fail closed: if the AI layer is down, purchases wait for you.

## Repo map

```
server/src/gate/        policy.ts · scanner.ts · auditor.ts · pipeline.ts
server/src/lifecycle/   service.ts (state machine, per-mandate locks) · delivery.ts
server/src/paypal/      client.ts (sandbox REST) · simulated.ts (offline, same rules)
server/src/agent/       shopper.ts (Gemini agent) · mandate.ts · gemini.ts
server/src/market/      channel3.ts · catalog.ts (registry, market median)
server/src/redteam/     attacks.ts · runner.ts · cli.ts · hijack.ts
web/src/                console (React + Vite)
```

## Roadmap

- Carrier webhooks (EasyPost/AfterShip) instead of manual delivery reports
- Agent Ready / ACP checkout sessions as an intent source
- Per-merchant reputation from dispute history
- Multi-agent households with per-agent sub-budgets

MIT licensed.
