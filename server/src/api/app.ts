import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { capabilities, config } from "../config.ts";
import type { DeliveryReport } from "../domain/types.ts";
import { draftMandate, mandateFromDraft } from "../agent/mandate.ts";
import { runShopper } from "../agent/shopper.ts";
import { Chaperone, LifecycleError, explain } from "../lifecycle/service.ts";
import { registry, substituteFor } from "../market/catalog.ts";
import type { PayPalApi } from "../paypal/types.ts";
import { PayPalError } from "../paypal/types.ts";
import { ATTACKS } from "../redteam/attacks.ts";
import { runRedteam } from "../redteam/runner.ts";
import { TASKS } from "../redteam/tasks.ts";
import type { Store, StoreEvent } from "../store/store.ts";

export function createApp(store: Store, paypal: PayPalApi) {
  const chaperone = new Chaperone(store, paypal);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof LifecycleError) return c.json({ error: err.message }, err.status as 404 | 409);
    if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
    if (err instanceof PayPalError) return c.json({ error: explain(err), paypal: { issue: err.issue, debugId: err.debugId } }, 502);
    console.error(err);
    return c.json({ error: String(err.message ?? err) }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true, ...capabilities(), paypalClient: paypal.kind }));

  app.get("/api/state", (c) =>
    c.json({
      capabilities: { ...capabilities(), paypalClient: paypal.kind },
      mandates: [...store.mandates.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
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
      const beat = setInterval(() => void stream.writeSSE({ event: "ping", data: String(Date.now()) }).catch(() => {}), 15000);
      stream.onAbort(() => {
        store.events.off("event", send);
        clearInterval(beat);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ at: new Date().toISOString() }) });
      while (!stream.aborted) await stream.sleep(60_000);
    }),
  );

  // ── Mandates ──────────────────────────────────────────────────
  app.post("/api/mandates", async (c) => {
    const body = z.object({ instruction: z.string().min(4).max(400), autoApproveUnder: z.number().positive().optional() }).parse(await c.req.json());
    const t0 = performance.now();
    const { draft, source } = await draftMandate(body.instruction);
    const m = mandateFromDraft(body.instruction, draft, { autoApproveUnder: body.autoApproveUnder });
    store.saveMandate(m);
    return c.json({ mandate: m, source, ms: Math.round(performance.now() - t0) });
  });

  app.patch("/api/mandates/:id", async (c) => {
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
  app.post("/api/mandates/:id/approve", async (c) => {
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

  app.post("/api/mandates/:id/revoke", (c) => {
    const m = chaperone.mandate(c.req.param("id"));
    m.status = "revoked";
    store.saveMandate(m);
    return c.json({ mandate: m });
  });

  // ── Agent runs ────────────────────────────────────────────────
  app.post("/api/agent/run", async (c) => {
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
  app.post("/api/purchases/:id/decision", async (c) => {
    const b = z.object({ decision: z.enum(["approve", "deny"]), reason: z.string().max(200).optional() }).parse(await c.req.json());
    return c.json({ purchase: await chaperone.decide(c.req.param("id"), b.decision, b.reason) });
  });

  /** Delivery report. In production this is a carrier/merchant webhook; the console lets you play the seller. */
  app.post("/api/purchases/:id/delivery", async (c) => {
    const p = chaperone.purchase(c.req.param("id"));
    const b = z
      .object({
        scenario: z.enum(["as_ordered", "wrong_item", "short"]).optional(),
        manifest: z.array(z.object({ title: z.string().max(200), quantity: z.number().int().min(0).max(100), attributes: z.record(z.string(), z.string()).optional() })).max(10).optional(),
        carrier: z.string().max(20).optional(),
        trackingNumber: z.string().max(40).optional(),
        humanNote: z.string().max(300).optional(),
      })
      .parse(await c.req.json());
    let manifest = b.manifest;
    if (!manifest) {
      const l = p.intent.listing;
      if (b.scenario === "wrong_item") {
        const sub = substituteFor(l.productId);
        manifest = [{ title: sub?.title ?? "Generic substitute item (different model)", quantity: p.intent.quantity, attributes: sub?.attributes ?? { note: "substitute" } }];
      } else if (b.scenario === "short") manifest = [{ title: l.title, quantity: Math.max(0, p.intent.quantity - 1), attributes: l.attributes }];
      else manifest = [{ title: l.title, quantity: p.intent.quantity, attributes: l.attributes }];
    }
    const report: DeliveryReport = { receivedAt: new Date().toISOString(), carrier: b.carrier ?? "UPS", trackingNumber: b.trackingNumber ?? `1Z${Math.floor(Math.random() * 1e15).toString().padStart(15, "0")}`, manifest, humanNote: b.humanNote };
    return c.json({ purchase: await chaperone.deliver(p.id, report) });
  });

  app.post("/api/purchases/:id/refund", async (c) => {
    const b = z.object({ reason: z.string().min(2).max(200), amount: z.number().positive().optional() }).parse(await c.req.json());
    return c.json({ purchase: await chaperone.refund(c.req.param("id"), b.reason, b.amount) });
  });

  // ── Red team ──────────────────────────────────────────────────
  let redteamRunning = false;
  app.post("/api/redteam/run", async (c) => {
    if (redteamRunning) throw new LifecycleError("A red-team run is already in progress");
    const b = z.object({ only: z.array(z.string()).optional(), withUnprotected: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    redteamRunning = true;
    const run = runRedteam({ paypal, ai: capabilities().gemini ? "gemini" : "heuristic", only: b.only, withUnprotected: b.withUnprotected, onCase: (cs) => store.emit({ type: "redteam", payload: { case: cs } }) })
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
  app.post("/api/webhooks/paypal", async (c) => {
    const body = await c.req.json();
    const headers = Object.fromEntries([...c.req.raw.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const verified = await paypal.verifyWebhook(headers, body).catch(() => false);
    const customId = body?.resource?.custom_id ?? body?.resource?.supplementary_data?.related_ids?.order_id;
    const p = customId ? store.purchases.get(customId) : undefined;
    if (p) {
      p.timeline.push({ at: new Date().toISOString(), kind: "webhook", label: `PayPal webhook: ${body.event_type}`, detail: verified ? "signature verified" : "signature not verified (no PAYPAL_WEBHOOK_ID)" });
      store.savePurchase(p);
    }
    return c.json({ received: true, verified });
  });

  app.get("/api/paypal/transactions", async (c) => {
    const end = new Date();
    const start = new Date(end.getTime() - 3 * 864e5);
    return c.json(await paypal.searchTransactions({ start, end }));
  });

  app.post("/api/demo/reset", (c) => {
    store.reset();
    return c.json({ ok: true });
  });

  return { app, chaperone };
}
