import { createHash } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { capabilities, config } from "../config.ts";
import { humanWithPasskey, passkeyRoutes, refuseUnlessPasskey } from "./passkey.ts";
import { adminOnly, AGENT_KEY, agentOrHuman, humanOnly, isAgent, rateLimit, refuseUnlessHuman, sessionCookie } from "./auth.ts";
import type { DeliveryReport, Listing, PurchaseIntent } from "../domain/types.ts";
import { draftMandate, mandateFromDraft } from "../agent/mandate.ts";
import { runShopper } from "../agent/shopper.ts";
import { Chaperone, LifecycleError, explain } from "../lifecycle/service.ts";
import { appendEvent, verifyChain } from "../lifecycle/receipt.ts";
import { whatIf } from "../gate/whatif.ts";
import { cachedListing, listingsFor, merchantFor, registry, searchListings, substituteFor } from "../market/catalog.ts";
import { channel3Product } from "../market/channel3.ts";
import type { PayPalApi } from "../paypal/types.ts";
import { PayPalError } from "../paypal/types.ts";
import { instrument } from "../paypal/instrument.ts";
import { log as tlog, snapshot as telemetrySnapshot, telemetry, type LogLine } from "../telemetry.ts";
import { readFileSync, existsSync as fileExists } from "node:fs";
import { ATTACKS } from "../redteam/attacks.ts";
import { ARENA_ATTACKS, arenaStats, customAttack, runDuel, type Duel } from "../arena/duel.ts";
import { runRedteam } from "../redteam/runner.ts";
import { TASKS } from "../redteam/tasks.ts";
import type { Store, StoreEvent } from "../store/store.ts";

export function createApp(store: Store, rawPaypal: PayPalApi) {
  const paypal = instrument(rawPaypal);
  const chaperone = new Chaperone(store, paypal);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof LifecycleError) return c.json({ error: err.message }, err.status as 404 | 409);
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    if (err instanceof PayPalError) return c.json({ error: explain(err), paypal: { issue: err.issue, debugId: err.debugId } }, 502);
    console.error(err);
    return c.json({ error: String(err.message ?? err) }, 500);
  });

  // The console runs only its own code: no third-party scripts, no framing, fonts from Google only.
  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if ((c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https") c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  });
  app.use("*", sessionCookie);
  passkeyRoutes(app);
  app.get("/api/session", (c) => c.json({ human: !isAgent(c), agentKey: AGENT_KEY }));
  const MIN = 60_000;

  app.get("/api/telemetry", (c) => c.json(telemetrySnapshot()));

  /** Recorded reports from the command-line runs (held-out round, hijack rate), shipped in docs/receipts. */
  app.get("/api/receipts/:name", (c) => {
    const name = c.req.param("name");
    if (!/^(heldout|hijack)$/.test(name)) throw new LifecycleError("Unknown report", 404);
    const dir = new URL("../../../docs/receipts/", import.meta.url).pathname;
    const live = new URL("../../../repro/out/", import.meta.url).pathname + `${name}-latest.json`;
    const file = fileExists(live) ? live : [`${dir}${name}-2026-11-10.json`].find((f) => fileExists(f));
    if (!file) throw new LifecycleError("No report recorded yet", 404);
    return c.json(JSON.parse(readFileSync(file, "utf8")));
  });

  app.get("/api/health", (c) => c.json({ ok: true, ...capabilities(), paypalClient: paypal.kind }));

  app.get("/api/state", (c) =>
    c.json({
      capabilities: { ...capabilities(), paypalClient: paypal.kind },
      duels: ([...store.duels.values()] as Duel[]).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30),
      arena: { stats: arenaStats([...store.duels.values()] as Duel[]), attacks: ARENA_ATTACKS.map((a) => ({ id: a.id, name: a.name, technique: a.technique })) },
      mandates: [...store.mandates.values()].filter((m) => !m.id.startsWith("md_arena_") && !m.id.startsWith("md_rt_")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      purchases: [...store.purchases.values()].sort((a, b) => b.intent.createdAt.localeCompare(a.intent.createdAt)),
      runs: [...store.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 20),
      redteam: store.redteam.at(-1) ?? null,
      attacks: ATTACKS.map((a) => ({ id: a.id, name: a.name, technique: a.technique, task: a.task, goal: a.goal })),
      tasks: TASKS.map((t) => ({ id: t.id, instruction: t.instruction })),
      sellers: registry.size,
    }),
  );

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const send = (e: StoreEvent) => void stream.writeSSE({ id: String(++id), event: e.type, data: JSON.stringify(e) }).catch(() => {});
      store.events.on("event", send);
      const sendLine = (l: LogLine) => void stream.writeSSE({ id: String(++id), event: "log", data: JSON.stringify(l) }).catch(() => {});
      telemetry.on("line", sendLine);
      const beat = setInterval(() => void stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {}), 15000);
      stream.onAbort(() => {
        store.events.off("event", send);
        telemetry.off("line", sendLine);
        clearInterval(beat);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ at: new Date().toISOString() }) });
      while (!stream.aborted) await stream.sleep(60_000);
    }),
  );

  // ── Mandates ──────────────────────────────────────────────────
  app.post("/api/mandates", humanOnly("sign a mandate"), rateLimit("mandate drafts", 12, 10 * MIN, 120), async (c) => {
    const body = z.object({ instruction: z.string().min(4).max(400), autoApproveUnder: z.number().positive().optional() }).parse(await c.req.json());
    const t0 = performance.now();
    const { draft, source } = await draftMandate(body.instruction);
    const m = mandateFromDraft(body.instruction, draft, { autoApproveUnder: body.autoApproveUnder });
    store.saveMandate(m);
    return c.json({ mandate: m, source, ms: Math.round(performance.now() - t0) });
  });

  app.patch("/api/mandates/:id", humanWithPasskey("change a mandate's limits"), async (c) => {
    const m = chaperone.mandate(c.req.param("id"));
    if (m.status !== "draft") throw new LifecycleError("Only draft mandates can be edited; revoke and create a new one");
    const b = z
      .object({
        description: z.string().min(2).max(80).optional(),
        mustHave: z.array(z.string().min(1).max(24)).max(6).optional(),
        maxQuantity: z.number().int().min(1).max(20).optional(),
        maxPerPurchase: z.number().positive().max(5000).optional(),
        maxTotal: z.number().positive().max(10000).optional(),
        autoApproveUnder: z.number().min(0).max(5000).optional(),
        maxOverMarketPct: z.number().min(0).max(200).optional(),
        block: z.array(z.string()).max(50).optional(),
      })
      .parse(await c.req.json());
    if (b.description) m.item.description = b.description;
    if (b.mustHave) m.item.mustHave = b.mustHave;
    if (b.maxQuantity) m.item.maxQuantity = b.maxQuantity;
    if (b.maxPerPurchase) m.budget.maxPerPurchase = b.maxPerPurchase;
    if (b.maxTotal) m.budget.maxTotal = b.maxTotal;
    if (b.autoApproveUnder != null) m.autoApproveUnder = b.autoApproveUnder;
    if (b.maxOverMarketPct != null) m.maxOverMarketPct = b.maxOverMarketPct;
    if (b.block) m.merchants.block = b.block;
    store.saveMandate(m);
    return c.json({ mandate: m });
  });

  /** The human signs the mandate in PayPal: Vault v3 setup token → approve → payment token. */
  app.post("/api/mandates/:id/approve", humanOnly("approve a wallet for a mandate"), async (c) => {
    const m = chaperone.mandate(c.req.param("id"));
    if (m.status !== "draft" && m.status !== "awaiting_paypal") throw new LifecycleError(`Mandate is ${m.status}`);
    if (paypal.kind === "sandbox" && config.paypal.paymentMode === "card") {
      m.status = "active";
      m.paymentTokenId = "sandbox-test-card";
      store.saveMandate(m);
      return c.json({ mandate: m, approveUrl: null });
    }
    const st = await paypal.createSetupToken({
      returnUrl: `${config.publicUrl}/api/paypal/return?mandate=${m.id}`,
      cancelUrl: `${config.publicUrl}/?mandate=${m.id}&paypal=cancelled`,
      description: `Chaperone mandate: ${m.item.description}, up to $${m.budget.maxTotal}`,
    });
    m.setupTokenId = st.setupTokenId;
    m.status = "awaiting_paypal";
    store.saveMandate(m);
    const approveUrl = paypal.kind === "simulated" ? `/api/paypal/return?mandate=${m.id}&simulated=1` : st.approveUrl;
    return c.json({ mandate: m, approveUrl });
  });

  app.get("/api/paypal/return", async (c) => {
    const m = chaperone.mandate(c.req.query("mandate") ?? "");
    if (!m.setupTokenId) throw new LifecycleError("No pending PayPal approval for this mandate");
    const tok = await paypal.createPaymentToken(m.setupTokenId);
    m.paymentTokenId = tok.paymentTokenId;
    m.paypalCustomerId = tok.customerId;
    m.payerEmail = tok.payerEmail;
    m.status = "active";
    store.saveMandate(m);
    return c.redirect(`/?mandate=${m.id}&paypal=approved`);
  });

  app.post("/api/mandates/:id/revoke", humanOnly("revoke a mandate"), (c) => {
    const m = chaperone.mandate(c.req.param("id"));
    m.status = "revoked";
    store.saveMandate(m);
    return c.json({ mandate: m });
  });

  // ── Agent runs ────────────────────────────────────────────────
  app.post("/api/agent/run", humanOnly("send the agent shopping"), rateLimit("shopping runs", 6, 10 * MIN, 60), async (c) => {
    const b = z.object({ mandateId: z.string(), mode: z.enum(["protected", "unprotected"]).default("protected"), attackId: z.string().optional(), wait: z.boolean().optional() }).parse(await c.req.json());
    const mandate = chaperone.mandate(b.mandateId);
    if (b.mode === "protected" && mandate.status !== "active") throw new LifecycleError(`Mandate is ${mandate.status}; approve it in PayPal first`);
    const attack = b.attackId ? ATTACKS.find((a) => a.id === b.attackId) : undefined;
    if (b.attackId && !attack) throw new LifecycleError(`Unknown attack ${b.attackId}`, 404);
    const p = runShopper({ store, chaperone, paypal }, { mandate, mode: b.mode, attack });
    if (b.wait) return c.json({ run: await p });
    p.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    const run = [...store.runs.values()].filter((r) => r.mandateId === mandate.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    return c.json({ runId: run?.id }, 202);
  });

  // ── Purchases ─────────────────────────────────────────────────
  // For any outside agent (the MCP server uses these). Everything an agent sends is untrusted.
  app.get("/api/search", agentOrHuman, rateLimit("searches", 60, 10 * MIN, 600), async (c) => {
    const q = z.object({ q: z.string().min(2).max(120), max_price: z.coerce.number().positive().optional() }).parse({ q: c.req.query("q"), max_price: c.req.query("max_price") });
    const r = await searchListings(q.q, q.max_price);
    return c.json({ source: r.source, ms: Math.round(r.ms), results: r.listings.map((l) => ({ listing_id: l.id, title: l.title, seller: l.merchant.domain, price: l.price, brand: l.brand ?? null, attributes: l.attributes ?? {}, page: l.pageText.slice(0, 1200) })) });
  });

  app.post("/api/purchases", agentOrHuman, rateLimit("purchase proposals", 30, 10 * MIN, 300), async (c) => {
    const b = z
      .object({
        mandateId: z.string(),
        agent: z.string().min(1).max(60).default("external-agent"),
        quantity: z.number().int().min(1).max(100).default(1),
        reason: z.string().max(600).default(""),
        note: z.string().max(300).optional(),
        listingId: z.string().max(200).optional(),
        listing: z
          .object({ url: z.string().url().max(500), title: z.string().min(2).max(300), price: z.number().positive().max(100000), sellerDomain: z.string().min(3).max(120), payTo: z.string().email().optional(), pageText: z.string().max(20000).default(""), attributes: z.record(z.string(), z.string()).optional(), productId: z.string().max(120).optional() })
          .optional(),
      })
      .refine((v) => v.listingId || v.listing, { message: "Provide listingId (from search) or listing" })
      .parse(await c.req.json());
    const mandate = chaperone.mandate(b.mandateId);
    let listing: Listing | undefined = b.listingId ? cachedListing(b.listingId) : undefined;
    if (b.listingId && !listing) throw new LifecycleError(`Unknown listingId ${b.listingId}; search again`, 404);
    if (!listing && b.listing) {
      const m = merchantFor(b.listing.sellerDomain);
      listing = { id: `ext:${crypto.randomUUID().slice(0, 8)}`, url: b.listing.url, title: b.listing.title, merchant: { ...m, payoutEmail: b.listing.payTo ?? m.payoutEmail }, price: Math.round(b.listing.price * 100) / 100, currency: "USD", productId: b.listing.productId, pageText: b.listing.pageText, attributes: b.listing.attributes };
    }
    const intent: PurchaseIntent = { id: `pi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, mandateId: mandate.id, agent: b.agent, createdAt: new Date().toISOString(), listing: listing!, quantity: b.quantity, agentRationale: b.reason, note: b.note };
    const p = await chaperone.propose(intent);
    return c.json({ purchase: p }, 201);
  });

  app.get("/api/purchases/:id/receipt", (c) => {
    const p = chaperone.purchase(c.req.param("id"));
    return c.json({ purchaseId: p.id, intentId: p.intent.id, createdAt: p.intent.createdAt, paypal: p.paypal, chain: verifyChain(p), timeline: p.timeline });
  });

  // Re-run the real deterministic gate on a past purchase under different limits.
  app.post("/api/purchases/:id/whatif", rateLimit("what-if replays", 120, MIN), async (c) => {
    const p = chaperone.purchase(c.req.param("id"));
    const b = z
      .object({
        maxPerPurchase: z.number().optional(),
        maxTotal: z.number().optional(),
        autoApproveUnder: z.number().optional(),
        maxOverMarketPct: z.number().optional(),
        maxQuantity: z.number().optional(),
        mustHave: z.array(z.string().max(60)).max(12).optional(),
        blockMerchants: z.array(z.string().max(120)).max(20).optional(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const r = whatIf(p, chaperone.mandate(p.intent.mandateId), store.purchasesFor(p.intent.mandateId), registry, b);
    tlog({ provider: "gate", op: "what-if replay", ms: r.ms, ok: true, note: `${r.before.decision} → ${r.after.decision}, ${r.changed.length} check(s) changed`, ref: p.id });
    return c.json(r);
  });

  app.get("/api/purchases/:id", (c) => c.json({ purchase: chaperone.purchase(c.req.param("id")) }));

  app.post("/api/purchases/:id/decision", humanWithPasskey("approve or decline a held purchase"), async (c) => {
    const b = z.object({ decision: z.enum(["approve", "deny"]), reason: z.string().max(200).optional() }).parse(await c.req.json());
    return c.json({ purchase: await chaperone.decide(c.req.param("id"), b.decision, b.reason) });
  });

  /** Delivery evidence. Buyer reports (optionally with a photo) can release money; seller and carrier claims alone cannot. */
  app.post("/api/purchases/:id/delivery", rateLimit("delivery reports", 20, 10 * MIN), async (c) => {
    const b = z
      .object({
        scenario: z.enum(["as_ordered", "wrong_item", "short"]).optional(),
        source: z.enum(["buyer", "carrier", "seller"]).default("buyer"),
        photo: z.string().max(8_000_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).optional(),
        manifest: z.array(z.object({ title: z.string().max(200), quantity: z.number().int().min(0).max(100), attributes: z.record(z.string(), z.string()).optional() })).max(10).optional(),
        carrier: z.string().max(20).optional(),
        trackingNumber: z.string().max(40).optional(),
        humanNote: z.string().max(300).optional(),
      })
      .parse(await c.req.json());
    // Only the buyer's own word can release money, so a buyer report needs the human's session.
    if (b.source === "buyer") {
      const no = refuseUnlessPasskey(c, "confirm a delivery");
      if (no) return no;
    }
    const p = chaperone.purchase(c.req.param("id"));
    let manifest = b.manifest;
    if (!manifest) {
      const l = p.intent.listing;
      if (b.scenario === "wrong_item") {
        const sub = substituteFor(l.productId);
        manifest = [{ title: sub?.title ?? "Generic substitute item (different model)", quantity: p.intent.quantity, attributes: sub?.attributes ?? { note: "substitute" } }];
      } else if (b.scenario === "short") manifest = [{ title: l.title, quantity: Math.max(0, p.intent.quantity - 1), attributes: l.attributes }];
      else manifest = [{ title: l.title, quantity: p.intent.quantity, attributes: l.attributes }];
    }
    const report: DeliveryReport = { receivedAt: new Date().toISOString(), carrier: b.carrier ?? "UPS", trackingNumber: b.trackingNumber ?? `1Z${Math.floor(Math.random() * 1e15).toString().padStart(15, "0")}`, manifest, humanNote: b.humanNote, source: b.source };
    let photo: { mime: string; data: string } | undefined;
    if (b.photo && b.source === "buyer") {
      const [head, data] = b.photo.split(",") as [string, string];
      photo = { mime: head.slice(5, head.indexOf(";")), data };
      const bytes = Buffer.from(data, "base64");
      report.photo = { mime: photo.mime, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    }
    return c.json({ purchase: await chaperone.deliver(p.id, report, photo) });
  });

  // A stopped purchase, redone the safe way: the same product from a retailer Channel3 actually lists.
  app.post("/api/purchases/:id/alternative", humanOnly("buy the safer alternative"), async (c) => {
    const p = chaperone.purchase(c.req.param("id"));
    if (p.state !== "blocked") throw new LifecycleError("Only a blocked purchase has an alternative to offer", 409);
    const seller = p.verdict.checks.find((x) => x.rule === "market.catalog_seller");
    const domain = seller?.data?.altDomain as string | undefined;
    if (!domain || !p.intent.listing.productId) throw new LifecycleError("Channel3 found no other retailer for this product within your limits", 404);
    const product = await channel3Product(p.intent.listing.productId);
    const listing = product ? listingsFor(product).find((l) => l.merchant.domain === domain) : undefined;
    if (!listing) throw new LifecycleError(`${domain} no longer lists this product in Channel3`, 404);
    const m = chaperone.mandate(p.intent.mandateId);
    const intent: PurchaseIntent = {
      id: `pi_alt_${Date.now().toString(36)}`,
      mandateId: p.intent.mandateId,
      agent: "chaperone · Channel3 alternative",
      createdAt: new Date().toISOString(),
      listing,
      quantity: Math.min(Math.max(1, p.intent.quantity), m.item.maxQuantity),
      agentRationale: `Same product from ${domain}, a retailer in Channel3's catalog, offered after purchase ${p.id} was blocked.`,
    };
    tlog({ provider: "gate", op: `safer alternative for ${p.id}`, ok: true, note: `${domain} $${listing.price.toFixed(2)}`, ref: p.id });
    return c.json({ purchase: await chaperone.propose(intent) });
  });

  app.post("/api/purchases/:id/payout", humanWithPasskey("pay the seller"), async (c) => c.json({ purchase: await chaperone.retryPayout(c.req.param("id")) }));

  app.post("/api/purchases/:id/refund", humanWithPasskey("refund a purchase"), async (c) => {
    const b = z.object({ reason: z.string().min(2).max(200), amount: z.number().positive().optional() }).parse(await c.req.json());
    return c.json({ purchase: await chaperone.refund(c.req.param("id"), b.reason, b.amount) });
  });

  // ── Arena: same agent, same attack, with and without Chaperone ──
  let duelRunning = false;
  let lastDuelAt = 0;
  app.post("/api/arena/duel", humanOnly("start a duel"), rateLimit("duels", 4, 10 * MIN, 40), async (c) => {
    const b = z
      .object({
        task: z.enum(["charger", "headphones"]).default("charger"),
        attackId: z.string().optional(),
        custom: z
          .object({
            text: z.string().min(3).max(1500),
            hidden: z.boolean().optional(),
            domain: z.string().max(60).regex(/^[a-z0-9\u00a1-\uffff][a-z0-9\u00a1-\uffff.-]{1,58}\.[a-z]{2,}$/i, "Use a plain domain like best-deals.shop").optional(),
            priceFactor: z.number().min(0.3).max(3).optional(),
            payTo: z.string().email().max(120).optional(),
          })
          .optional(),
      })
      .refine((v) => v.attackId || v.custom, { message: "Pick an attack or write your own" })
      .parse(await c.req.json());
    if (!capabilities().gemini) throw new LifecycleError("The Arena needs a live model: set GEMINI_API_KEY.", 503);
    if (duelRunning) throw new LifecycleError("A duel is already running. Watch it finish, then start yours.", 429);
    if (Date.now() - lastDuelAt < 4000) throw new LifecycleError("Give it a few seconds between duels.", 429);
    const attack = b.custom ? customAttack(b.custom, b.task) : ARENA_ATTACKS.find((a) => a.id === b.attackId);
    if (!attack) throw new LifecycleError(`Unknown attack ${b.attackId}`, 404);
    duelRunning = true;
    lastDuelAt = Date.now();
    const save = (d: Duel) => {
      store.duels.set(d.id, structuredClone(d));
      store.emit({ type: "duel", id: d.id, payload: d });
    };
    const started = new Promise<string>((resolve) => {
      runDuel({ store, chaperone, paypal }, { task: b.task, attack, custom: !!b.custom, onUpdate: (d) => { save(d); resolve(d.id); } })
        .catch((e) => console.error("duel failed", e))
        .finally(() => { duelRunning = false; lastDuelAt = Date.now(); });
    });
    return c.json({ duelId: await started }, 202);
  });

  // ── Red team ──────────────────────────────────────────────────
  let redteamRunning = false;
  app.post("/api/redteam/run", humanOnly("run the red team"), rateLimit("red-team runs", 1, 15 * MIN, 3), async (c) => {
    if (redteamRunning) throw new LifecycleError("A red-team run is already in progress");
    const b = z.object({ only: z.array(z.string()).optional(), withUnprotected: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    redteamRunning = true;
    const run = runRedteam({ paypal, ai: capabilities().gemini ? "gemini" : "heuristic", only: b.only, withUnprotected: b.withUnprotected, store, onCase: (cs) => store.emit({ type: "redteam", payload: { case: cs } }) })
      .then((r) => {
        store.redteam.push(r);
        store.emit({ type: "redteam", payload: { report: r } });
        return r;
      })
      .finally(() => (redteamRunning = false));
    run.catch((e) => store.emit({ type: "redteam", payload: { error: String(e?.message ?? e) } }));
    return c.json({ started: true }, 202);
  });

  // ── PayPal webhooks ───────────────────────────────────────────
  // Only events PayPal signed are accepted (verified against PAYPAL_WEBHOOK_ID), each event once.
  // They land on the purchase's hash-chained timeline, and the ones that change money also change state.
  const seenEvents = new Set<string>();
  const webhook = async (c: import("hono").Context) => {
    const body = await c.req.json().catch(() => null);
    if (!body?.id || !body?.event_type) return c.json({ error: "Not a PayPal event" }, 400);
    const headers = Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const verified = await paypal.verifyWebhook(headers, body).catch(() => false);
    if (!verified) {
      tlog({ provider: "paypal", op: `webhook rejected: ${String(body.event_type).slice(0, 60)}`, ok: false, note: "signature didn't verify against PAYPAL_WEBHOOK_ID" });
      return c.json({ error: "Signature not verified" }, 401);
    }
    const eventId = String(body.id);
    const r = body.resource ?? {};
    const purchaseId = r.custom_id ?? r.purchase_units?.[0]?.custom_id;
    const p = purchaseId ? store.purchases.get(purchaseId) : undefined;
    if (seenEvents.has(eventId) || p?.timeline.some((e) => e.kind === "webhook" && e.detail?.includes(eventId))) return c.json({ received: true, duplicate: true });
    seenEvents.add(eventId);
    if (p) {
      const type = String(body.event_type);
      appendEvent(p, { at: new Date().toISOString(), kind: "webhook", label: `PayPal webhook: ${type}`, detail: `signature verified · ${eventId}` });
      // PayPal is the source of truth for money: mirror changes made outside Chaperone.
      if (type === "PAYMENT.AUTHORIZATION.VOIDED" && ["authorized", "awaiting_delivery"].includes(p.state)) {
        p.state = "voided";
        appendEvent(p, { at: new Date().toISOString(), kind: "voided", label: "PayPal reports the authorization was voided or expired", detail: "The money was never captured." });
      } else if ((type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED") && ["captured", "seller_paid"].includes(p.state)) {
        p.state = "refunded";
        appendEvent(p, { at: new Date().toISOString(), kind: "refunded", label: type.endsWith("REVERSED") ? "PayPal reversed the capture" : "PayPal reports a refund", detail: `$${r.amount?.value ?? "?"}` });
      } else if (type === "PAYMENT.CAPTURE.DENIED" && p.state === "captured") {
        p.state = "awaiting_delivery";
        appendEvent(p, { at: new Date().toISOString(), kind: "error", label: "PayPal denied the capture", detail: "Nothing was paid to the seller." });
      }
      store.savePurchase(p);
    }
    tlog({ provider: "paypal", op: `webhook ${body.event_type}`, ok: true, note: p ? `→ ${p.id} (${p.state})` : "no matching purchase", ref: p?.id });
    return c.json({ received: true, verified: true });
  };
  app.post("/api/webhooks/paypal", webhook);
  app.post("/api/paypal/webhook", webhook);

  app.get("/api/paypal/transactions", humanOnly("read the merchant ledger"), async (c) => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 864e5);
    return c.json(await paypal.searchTransactions({ start, end }));
  });

  app.post("/api/demo/reset", adminOnly, (c) => {
    store.reset();
    return c.json({ ok: true });
  });

  return { app, chaperone };
}
