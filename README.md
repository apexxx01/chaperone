# Chaperone

**Purchase protection for AI shopping agents, built on PayPal.** Agents can shop. Nothing moves until it's right.

[![CI](https://github.com/apexxx01/chaperone/actions/workflows/ci.yml/badge.svg)](https://github.com/apexxx01/chaperone/actions/workflows/ci.yml)
![tests](https://img.shields.io/badge/tests-124%20passing-2f7d4f)
![license](https://img.shields.io/badge/license-MIT-0f5e5a)

AI agents are starting to spend money for people, and they are easy to fool. [StakeBench](https://arxiv.org/abs/2606.13385) (2026) measured indirect prompt injection succeeding against GPT-5 and Gemini 2.5 Flash web agents **41.67% to 68.59%** of the time.

Most "agent wallet" tools stop at *should the agent buy this?* Chaperone covers the **whole life of the purchase**:

1. **Before:** a gate. Deterministic policy, Channel3 market-price check, an injection scanner, and a dual-LLM Gemini auditor that never reads the untrusted page.
2. **During:** the money is **authorized, not captured** (PayPal Orders v2 `intent=AUTHORIZE`). Held, not moved.
3. **After:** what arrived is checked against what you asked for, and only **your** confirmation counts. A seller saying "delivered" releases nothing. Add a photo and Gemini vision checks the item and its label against the order. Match: **capture**, add tracking, pay the seller with **Payouts**. Short shipment: capture only what arrived. Wrong item: **void**, and the money never moved.

![Architecture](docs/architecture.svg)

## Try it

| | |
|---|---|
| **Live demo** | https://chaperone-ku2k.onrender.com · guided tour: https://chaperone-ku2k.onrender.com/?tour=1 |
| **PayPal sandbox buyer** (for "Approve with PayPal") | `sb-1ezxw53857958@personal.example.com` · password `(#A4tDCd` (sandbox money only) |
| **One command (no keys)** | `docker compose -f repro/compose.yaml up` → http://localhost:8787 |
| **From source** | `npm ci && npm run build -w web && npm run demo` |
| **Red team** | `npm run redteam` (offline) or with keys in `.env` for the PayPal sandbox |
| **Held-out attacks** | `npm run heldout`: a separate model invents fresh attacks it has never tested against the gate |
| **Real hijack rate** | `npm run hijack`: how often a live Gemini agent falls for each attack |
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

## Plug it into any agent (MCP)

Chaperone ships as an MCP server. Give an agent these tools **instead of** raw PayPal tools: it can shop, but it can't move money.

```json
{
  "mcpServers": {
    "chaperone": {
      "command": "npx",
      "args": ["tsx", "/path/to/chaperone/server/src/mcp/server.ts"],
      "env": { "CHAPERONE_URL": "http://localhost:8787" }
    }
  }
}
```

| Tool | What the agent can do |
|---|---|
| `list_mandates` | See the jobs you signed and what budget is left |
| `search_products` | Search real offers across retailers (Channel3) |
| `propose_purchase` | Ask to buy. Gate runs; on pass, PayPal **holds** the funds |
| `purchase_status` | See whether it was blocked, is waiting for you, held, paid or voided |

There is deliberately no tool to approve a held purchase, confirm delivery, or edit a mandate. Those stay with the human in the console. `npm run mcp:smoke` drives the server with a real MCP client: an honest purchase is held, a hijacked one is blocked.

## Receipts

All numbers below are from real runs on 10–11 Nov 2026 against the **PayPal sandbox**, with the AI layer on live Gemini (Amazon Nova on Bedrock answered the one call Gemini couldn't). Raw reports are in [`docs/receipts/`](docs/receipts) and every figure is reproducible with the command shown.

**1. Red team, full-compromise mode** (`npm run redteam`). We assume the agent falls for every attack, then follow the money.

| | Agent alone (holds PayPal tools directly) | Same agent through Chaperone |
|---|---|---|
| Money moved by 21 attacks | **−$1,398.13** captured, 21 / 21 | **$0.00** paid to the wrong place |
| Outcome | captured immediately | 18 blocked at the gate · 3 caught after purchase (bait-and-switch voided, short shipment partly captured, fake delivery claim left unpaid) |
| Independent layers per attack | n/a | 1.8 on average; 13 of 21 failed two or more layers that never see each other's results (the auditor counts only when it was the sole catch, since it is shown the other layers' findings) |
| Honest purchases | n/a | 4 of 4 completed, no false blocks |

**2. Held-out round** (`npm run heldout`). The corpus above and the gate share an author, so a separate Gemini call plays the attacker. It is told the scenario and nothing about the defenses, and invents 20 attacks of its own.

| Blocked at the gate | Held for a human | Past the gate |
|---|---|---|
| **19** | **1** | **0** |

Most were stopped by the plain-code limits the human signed (quantity, per-purchase cap, payee identity), not by pattern-matching the attack text. The attacker here was a small model; a stronger one will do better, which is why the money is held until delivery instead of trusting the gate.

**3. How often a real agent is fooled** (`npm run hijack`). A live `gemini-3.6-flash` shopping agent, one trial per attack: **4 of 18** pre-purchase attacks (22%) hijacked it, including the invisible-Unicode instruction and both lookalike stores. It resisted the other 14 by itself. In the Arena, the same lookalike store took **$21.24** from the unprotected agent, twice, as real sandbox captures.

**4. Speed.** Median gate time on the 11 Nov red-team run was about 1 s (7 s on 10 Nov, when Gemini was congested), almost all of it the two AI calls running in parallel; the deterministic checks take under a millisecond and a PayPal authorization about 2 s.

The 21 attacks: instructions addressed to the AI, Unicode tag smuggling, fake `SYSTEM:` messages in reviews, HTML comments, `amaz0n.com`, a Cyrillic `у` in `bestbuу.com`, fake surcharges, quiet 70% markups, pack-size quantity pushes, persuasion with no AI keywords, payee swaps (visible and hidden), approval spoofing, concealment requests, a "65W-compatible" 30W charger, `<|im_start|>` tokens, zero-width splitting, an instruction in Hindi, bait-and-switch, a short shipment, and a seller falsely marking an order delivered. See [`server/src/redteam/attacks.ts`](server/src/redteam/attacks.ts).

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
- **Tamper-evident receipts**: every purchase event is SHA-256 chained to the one before it, and the console re-computes the chain in your browser.
- **Delivery comparison** (Gemini, booleans only): does the report match the order?
- **Proof photo** (Gemini vision, booleans only): does the buyer's photo show the ordered product, and does any visible label contradict a requirement?
- Fail closed: if the AI layer is down, purchases wait for you.

## The control room

The web app is a live mirror of the backend, not a mockup of it. Every PayPal request, Gemini call, Channel3 search, gate decision and money movement is timed on the server (`server/src/telemetry.ts`, `server/src/paypal/instrument.ts`) and streamed to the browser over SSE.

- **System map**: one box per layer, in the order the code runs them. Each real purchase flies through as a pulse along the exact path it took; counts and median timings come from the recorded checks.
- **Trace**: pick any purchase and see its gate waterfall (the two Gemini calls run side by side) and its hash-chained timeline.
- **Where the money went**: every proposed dollar, from proposal through the gate into PayPal, captured, voided or still held.
- **Backend log** and **provider health**: the raw call log with p50/p95 and error rate per provider. Gemini quota errors show up here as they happen, and you can watch Bedrock pick up the call.
- **What-if replay**: in any purchase's receipts, drag its limits and the server re-runs the same deterministic gate on that exact purchase (`server/src/gate/whatif.ts`), showing which checks flip. Nothing is saved or charged.
- **Guided tour**: the Tour button (or `?tour=1` on the URL) walks through the live system in about a minute, spotlighting real panels.
- **Command palette** (⌘K or `/`): jump to a view, run any duel, open any purchase.

## Repo map

```
server/src/gate/        policy.ts · scanner.ts · auditor.ts · pipeline.ts
server/src/lifecycle/   service.ts (state machine, per-mandate locks) · delivery.ts
server/src/paypal/      client.ts (sandbox REST) · simulated.ts (offline, same rules)
server/src/agent/       shopper.ts (Gemini agent) · mandate.ts · gemini.ts
server/src/market/      channel3.ts · catalog.ts (registry, market median)
server/src/redteam/     attacks.ts · runner.ts · cli.ts · hijack.ts
server/src/mcp/         server.ts (MCP server for any agent) · smoke.ts
web/src/                control room (React + Vite + Motion): console.tsx · pipeline.tsx · charts.tsx · arena.tsx · evidence.tsx
server/src/telemetry.ts every outbound call and lifecycle step, timed and streamed
```

## Two AI providers

Gemini is the primary model for every AI step. When it is over quota, overloaded or slow, the same call goes to **Amazon Nova on AWS Bedrock** through the Converse API (`server/src/agent/bedrock.ts`): the quarantined reader, the auditor, mandate drafting, the delivery photo check and the shopping agent itself, which can switch providers mid-run. Structured output is a forced tool call with the same JSON schema. Receipts record which provider answered each check. If both are down, the gate still fails closed and asks you.

## Who can move money

Agents and humans hold different keys, and the server enforces the split (`server/src/api/auth.ts`):

| | Agent key (MCP, any tool-using model) | Human session (the console) |
|---|---|---|
| Search, propose a purchase, read its status | ✓ | ✓ |
| Approve a held purchase, confirm delivery, refund | **403** | ✓ |
| Sign or revoke a mandate, approve the PayPal wallet | **403** | ✓ |
| Report a seller or carrier "delivered" claim | ✓ (can't release money) | ✓ |

Try it: open any held purchase and press **Let the agent try**. The browser sends the real request with the agent's key and shows the server's 403. Or from a terminal:

```bash
curl -X POST https://chaperone-ku2k.onrender.com/api/purchases/<id>/decision \
  -H 'Authorization: Bearer chp_agent_demo_7f3a' -H 'Content-Type: application/json' -d '{"decision":"approve"}'
# {"error":"Agents can't approve or decline a held purchase. Only the human can, from their own session.","code":"agent_scope"}
```

Human actions need the console's session cookie (HttpOnly, SameSite=Lax, HMAC-signed) and a same-origin request. Demo reset is admin-only, and duels, red-team runs and shopping runs are rate-limited per visitor so one person can't burn the shared AI quota.

## Honest limits

- **"The human" is whoever has the console open.** The demo issues the human session on page load. In production that slot is the buyer's real login (PayPal Log In or a passkey); the split of powers above stays the same.
- **Money routes through Chaperone's account.** Today the hold is an Orders v2 authorization on Chaperone's own sandbox merchant, and the seller is paid with Payouts after delivery. In production this is PayPal's marketplace pattern instead: Multiparty with `payee.merchant_id` and delayed disbursement, so the capture belongs to the onboarded seller, the buyer keeps PayPal Purchase Protection with them, and Chaperone never holds the funds.
- **The AI auditor isn't independent of the other layers.** It is shown what policy and the scanner found, so its catches overlap theirs. The quarantined reader is independent (it only sees the page). The layer counts above treat them that way.

- **Live testing found bugs in our own checks.** On the first day against real catalog data, the gate wrongly blocked or voided correct purchases four times (wording differences, specs listed only in bullets or descriptions). Each is fixed with a regression test named for the live run that found it.
- **The AI layer depends on rate-limited APIs.** Bedrock covers Gemini outages; if both fail, purchases wait for a human instead of passing. Safe, but slower.

- **This is a self-built red team.** The attacks and the defenses come from the same author, and in "full-compromise mode" we assume the agent is fooled rather than measuring it. `npm run hijack` measures a real Gemini agent separately. The gate will miss attacks it hasn't seen; that is why the money is held until delivery instead of trusting the gate.
- **Sellers are demo identities.** Product offers are real (Channel3), but seller payout addresses are stand-ins on a reserved domain, and "verified seller" means the seller appeared in Channel3 results. Paying real sellers needs them onboarded through PayPal's platform products (see above).
- **Sandbox only.** No real money moves anywhere in this project.
- **Offline mode is a simulator.** Numbers from it are labeled as such; sandbox numbers come from `npm run redteam` with keys.

## Roadmap

- Carrier webhooks (EasyPost/AfterShip) instead of manual delivery reports
- Agent Ready / ACP checkout sessions as an intent source
- Per-merchant reputation from dispute history
- Multi-agent households with per-agent sub-budgets

MIT licensed.
