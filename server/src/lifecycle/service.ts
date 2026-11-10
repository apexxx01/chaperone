/**
 * The purchase lifecycle. One place where money moves, so every transition is
 * guarded, idempotent and written to the timeline.
 *
 *   propose → gate ─┬─ block ──────────────────────────────▶ blocked
 *                   ├─ hold ─▶ human ─┬─ deny ─────────────▶ denied
 *                   │                 └─ approve ─┐
 *                   └─ authorize ─────────────────┴▶ authorized (funds HELD)
 *   authorized ─▶ delivery report ─▶ verify ─┬─ match   ─▶ capture ─▶ track ─▶ payout seller ─▶ seller_paid
 *                                            ├─ partial ─▶ partial capture (rest released) ─▶ payout
 *                                            └─ mismatch ─▶ void (money never moved)
 */
import type { DeliveryReport, Mandate, Purchase, PurchaseIntent } from "../domain/types.ts";
import { runGate } from "../gate/pipeline.ts";
import { round2 } from "../gate/policy.ts";
import { marketForIntent, registry } from "../market/catalog.ts";
import type { PayPalApi } from "../paypal/types.ts";
import { PayPalError } from "../paypal/types.ts";
import type { Store } from "../store/store.ts";
import { verifyDelivery, type ProofPhoto } from "./delivery.ts";
import { appendEvent } from "./receipt.ts";

const now = () => new Date().toISOString();

export class LifecycleError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

export class Chaperone {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    readonly store: Store,
    readonly paypal: PayPalApi,
  ) {}

  /** Serialize all money movement per mandate, so two agents can't race the budget. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    this.locks.set(key, prev.then(() => next));
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }

  private event(p: Purchase, kind: string, label: string, detail?: string, ms?: number) {
    appendEvent(p, { at: now(), kind, label, detail, ms: ms == null ? undefined : Math.round(ms) });
  }

  mandate(id: string): Mandate {
    const m = this.store.mandates.get(id);
    if (!m) throw new LifecycleError(`Mandate ${id} not found`, 404);
    return m;
  }

  purchase(id: string): Purchase {
    const p = this.store.purchases.get(id);
    if (!p) throw new LifecycleError(`Purchase ${id} not found`, 404);
    return p;
  }

  refreshTotals(m: Mandate) {
    const ps = this.store.purchasesFor(m.id);
    m.committed = round2(ps.filter((p) => ["held", "authorized", "awaiting_delivery", "verifying"].includes(p.state)).reduce((s, p) => s + p.amount.value, 0));
    m.settled = round2(ps.filter((p) => ["captured", "seller_paid"].includes(p.state)).reduce((s, p) => s + (p.paypal.capturedAmount ?? p.amount.value), 0));
    if (m.status === "active" && m.settled + m.committed >= m.budget.maxTotal - 0.009) m.status = "exhausted";
    else if (m.status === "exhausted" && m.settled + m.committed < m.budget.maxTotal - 0.009) m.status = "active";
    this.store.saveMandate(m);
  }

  /** Entry point for every agent purchase. */
  async propose(intent: PurchaseIntent): Promise<Purchase> {
    return this.withLock(intent.mandateId, async () => {
      const m = this.mandate(intent.mandateId);
      const t0 = performance.now();
      const verdict = await runGate(m, intent, { registry, history: (id) => this.store.purchasesFor(id), market: marketForIntent });
      const p: Purchase = {
        id: `pur_${intent.id.replace(/^pi_/, "")}`,
        intent,
        verdict,
        state: "proposed",
        amount: { currency: "USD", value: round2(intent.listing.price * intent.quantity) },
        paypal: { debugIds: [] },
        timeline: [],
        updatedAt: now(),
      };
      this.event(p, "proposed", `Agent proposed ${intent.quantity}× ${intent.listing.title.slice(0, 60)}`, `$${p.amount.value.toFixed(2)} at ${intent.listing.merchant.domain}`);
      this.event(p, "gate", `Gate: ${verdict.decision.toUpperCase()}`, verdict.headline, verdict.ms);

      if (verdict.decision === "block") {
        p.state = "blocked";
        this.store.savePurchase(p);
        return p;
      }
      if (verdict.decision === "hold") {
        p.state = "held";
        this.store.savePurchase(p);
        this.refreshTotals(m);
        return p;
      }
      await this.authorize(m, p, t0);
      return p;
    });
  }

  private async authorize(m: Mandate, p: Purchase, t0 = performance.now()) {
    try {
      const ta = performance.now();
      const r = await this.paypal.authorize({
        requestId: `auth-${p.id}`,
        amount: p.amount.value,
        currency: "USD",
        items: [{ name: p.intent.listing.title, quantity: p.intent.quantity, unitAmount: p.intent.listing.price, sku: p.intent.listing.productId }],
        description: `${p.intent.listing.title} via ${p.intent.listing.merchant.domain}`,
        customId: p.id,
        invoiceId: `CHP-${p.id}`,
        softDescriptor: "CHAPERONE",
        // Arena and card-mode mandates carry a marker, not a vault token: those authorize on PayPal's sandbox test card.
        vaultId: m.paymentTokenId === "sandbox-test-card" || m.paymentTokenId === "sim-vault-token" ? undefined : m.paymentTokenId,
      });
      p.paypal.orderId = r.orderId;
      p.paypal.authorizationId = r.authorizationId;
      if (r.debugId) p.paypal.debugIds.push(r.debugId);
      p.state = "awaiting_delivery";
      this.event(p, "authorized", `PayPal authorized $${p.amount.value.toFixed(2)} (held, not captured)`, `Order ${r.orderId} · Authorization ${r.authorizationId}${r.expiresAt ? ` · honor period to ${r.expiresAt.slice(0, 10)}` : ""}`, performance.now() - ta);
      this.event(p, "loop", "Proposal → funds held", undefined, performance.now() - t0);
    } catch (e) {
      p.state = "failed";
      this.event(p, "error", "PayPal authorization failed", explain(e));
      if (e instanceof PayPalError && e.debugId) p.paypal.debugIds.push(e.debugId);
    }
    this.store.savePurchase(p);
    this.refreshTotals(m);
  }

  async decide(purchaseId: string, decision: "approve" | "deny", reason?: string): Promise<Purchase> {
    const p0 = this.purchase(purchaseId);
    return this.withLock(p0.intent.mandateId, async () => {
      const p = this.purchase(purchaseId);
      if (p.state !== "held") throw new LifecycleError(`Purchase is ${p.state}; only held purchases can be decided`);
      const m = this.mandate(p.intent.mandateId);
      p.human = { decision, at: now(), reason };
      this.event(p, "human", decision === "approve" ? "You approved" : "You declined", reason);
      if (decision === "deny") {
        p.state = "denied";
        this.store.savePurchase(p);
        this.refreshTotals(m);
        return p;
      }
      // Re-check the hard limits at approval time: budget may have moved since the hold.
      const hard = p.verdict.checks.filter((c) => c.outcome === "fail");
      if (hard.length) throw new LifecycleError("Blocked checks can't be overridden");
      await this.authorize(m, p);
      return p;
    });
  }

  async deliver(purchaseId: string, report: DeliveryReport, photo?: ProofPhoto): Promise<Purchase> {
    const p0 = this.purchase(purchaseId);
    return this.withLock(p0.intent.mandateId, async () => {
      const p = this.purchase(purchaseId);
      if (p.state !== "awaiting_delivery") throw new LifecycleError(`Purchase is ${p.state}; delivery can only be verified for authorized purchases`);
      const m = this.mandate(p.intent.mandateId);
      p.state = "verifying";
      p.delivery = report;
      this.event(p, "delivered", `${report.source === "buyer" ? "You reported what arrived" : report.source === "seller" ? "Seller says it was delivered" : "Carrier scan"}${report.carrier ? ` (${report.carrier} ${report.trackingNumber ?? ""})` : ""}`, report.manifest.map((i) => `${i.quantity}× ${i.title}`).join(", "));
      this.store.savePurchase(p);

      const { verdict, settlement } = await verifyDelivery(m, p, report, photo);
      p.deliveryVerdict = verdict;
      this.event(p, "verified", "Delivery check", verdict.headline, verdict.ms);

      if (settlement.action === "await_buyer") {
        p.state = "awaiting_delivery";
        this.event(p, "waiting", "Funds stay held: waiting for you to confirm", `${settlement.reason}. If nobody confirms, the authorization expires and the money is released back to you.`);
        this.store.savePurchase(p);
        return p;
      }
      try {
        if (settlement.action === "void") {
          const t = performance.now();
          const r = await this.paypal.void(p.paypal.authorizationId!, `void-${p.id}`);
          if (r.debugId) p.paypal.debugIds.push(r.debugId);
          p.state = "voided";
          this.event(p, "voided", `Authorization voided. $${p.amount.value.toFixed(2)} never left your account`, settlement.reason, performance.now() - t);
        } else {
          const amount = settlement.amount;
          const t = performance.now();
          const c = await this.paypal.capture(p.paypal.authorizationId!, { requestId: `cap-${p.id}`, amount, final: true, invoiceId: `CHP-${p.id}` });
          p.paypal.captureId = c.captureId;
          p.paypal.capturedAmount = amount;
          if (c.debugId) p.paypal.debugIds.push(c.debugId);
          p.state = "captured";
          this.event(p, "captured", `Captured $${amount.toFixed(2)}`, `Capture ${c.captureId}`, performance.now() - t);
          if (settlement.action === "capture_partial") this.event(p, "released", `Released $${round2(p.amount.value - amount).toFixed(2)} back to you (final capture)`);

          if (report.trackingNumber && p.paypal.orderId) {
            try {
              const tr = await this.paypal.addTracking(p.paypal.orderId, { captureId: c.captureId, trackingNumber: report.trackingNumber, carrier: normalizeCarrier(report.carrier), items: [{ name: p.intent.listing.title, quantity: settlement.action === "capture_partial" ? settlement.units : p.intent.quantity, sku: p.intent.listing.productId }] });
              this.event(p, "tracked", "Tracking attached to the PayPal order", tr.trackerId);
            } catch (e) {
              this.event(p, "warn", "Couldn't attach tracking", explain(e));
            }
          }
          const tp = performance.now();
          const po = await this.paypal.payout({ requestId: `pay-${p.id}`, receiverEmail: p.intent.listing.merchant.payoutEmail, amount, note: `Payment for verified delivery: ${p.intent.listing.title.slice(0, 80)} (${p.id})`, purchaseId: p.id });
          p.paypal.payoutBatchId = po.batchId;
          p.state = "seller_paid";
          this.event(p, "payout", `Seller paid via PayPal Payouts: $${amount.toFixed(2)} → ${p.intent.listing.merchant.payoutEmail}`, `Batch ${po.batchId} (${po.status})`, performance.now() - tp);
        }
      } catch (e) {
        this.event(p, "error", "Settlement failed. Funds stay held; retry is safe (idempotent)", explain(e));
        p.state = p.paypal.captureId ? "captured" : "awaiting_delivery";
      }
      this.store.savePurchase(p);
      this.refreshTotals(m);
      return p;
    });
  }

  /** After capture, if something goes wrong later (return, defect), refund through PayPal. */
  async refund(purchaseId: string, reason: string, amount?: number): Promise<Purchase> {
    const p0 = this.purchase(purchaseId);
    return this.withLock(p0.intent.mandateId, async () => {
      const p = this.purchase(purchaseId);
      if (!p.paypal.captureId) throw new LifecycleError("Nothing captured to refund");
      const r = await this.paypal.refund(p.paypal.captureId, { requestId: `ref-${p.id}-${amount ?? "full"}`, amount, note: reason });
      p.paypal.refundId = r.refundId;
      if (r.debugId) p.paypal.debugIds.push(r.debugId);
      p.state = "refunded";
      this.event(p, "refunded", `Refunded${amount ? ` $${amount.toFixed(2)}` : " in full"}`, reason);
      this.store.savePurchase(p);
      this.refreshTotals(this.mandate(p.intent.mandateId));
      return p;
    });
  }
}

export function explain(e: unknown): string {
  if (e instanceof PayPalError) return `${e.message}${e.debugId ? ` (debug id ${e.debugId})` : ""}`;
  return String((e as Error)?.message ?? e);
}

function normalizeCarrier(c?: string): string {
  const k = (c ?? "OTHER").toUpperCase();
  return ["UPS", "USPS", "FEDEX", "DHL"].includes(k) ? k : "OTHER";
}
