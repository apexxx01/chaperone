import { beforeEach, describe, expect, it } from "vitest";
import type { PurchaseIntent } from "../src/domain/types.ts";
import { Chaperone, LifecycleError } from "../src/lifecycle/service.ts";
import { getProduct, listingsFor } from "../src/market/catalog.ts";
import { PayPalSimulated } from "../src/paypal/simulated.ts";
import { mandateFor } from "../src/redteam/runner.ts";
import { taskById } from "../src/redteam/tasks.ts";
import { Store } from "../src/store/store.ts";
import { decide } from "../src/gate/pipeline.ts";

let store: Store, pp: PayPalSimulated, ch: Chaperone;
let n = 0;
const listing = () => listingsFor(getProduct("fx-chg-anker-735")!).find((l) => l.merchant.domain === "amazon.com")!;
const intent = (over: Partial<PurchaseIntent> = {}): PurchaseIntent => ({ id: `pi_${++n}`, mandateId: "md", agent: "t", createdAt: new Date().toISOString(), listing: listing(), quantity: 1, agentRationale: "best verified price", ...over });
const delivered = (qty = 1, title = listing().title) => ({ receivedAt: new Date().toISOString(), carrier: "UPS", trackingNumber: "1Z999AA10123456784", manifest: [{ title, quantity: qty, attributes: { wattage: "65W", connector: "USB-C" } }] });

beforeEach(() => {
  store = new Store();
  pp = new PayPalSimulated();
  ch = new Chaperone(store, pp);
  const m = mandateFor(taskById("charger"), "md");
  m.budget.maxTotal = 200;
  store.saveMandate(m);
});

describe("decision aggregation", () => {
  it("any fail blocks, any warn holds, else authorize", () => {
    const c = (outcome: "pass" | "warn" | "fail") => ({ stage: "policy" as const, rule: "r", outcome, title: "", detail: "" });
    expect(decide([c("pass"), c("fail"), c("warn")])).toBe("block");
    expect(decide([c("pass"), c("warn")])).toBe("hold");
    expect(decide([c("pass")])).toBe("authorize");
  });
});

describe("purchase lifecycle", () => {
  it("authorizes (holds) a faithful purchase without capturing", async () => {
    const p = await ch.propose(intent());
    expect(p.state).toBe("awaiting_delivery");
    expect(p.paypal.authorizationId).toBeTruthy();
    expect(pp.auths.get(p.paypal.authorizationId!)!.status).toBe("CREATED");
    expect(pp.captures.size).toBe(0);
  });
  it("captures, tracks and pays the seller on a matching delivery", async () => {
    const p = await ch.propose(intent());
    const done = await ch.deliver(p.id, delivered());
    expect(done.state).toBe("seller_paid");
    expect(done.paypal.capturedAmount).toBe(39.99);
    expect(pp.payouts[0]).toMatchObject({ receiver: "payouts@amazon.com", amount: 39.99 });
    expect(done.timeline.map((e) => e.kind)).toEqual(expect.arrayContaining(["authorized", "captured", "tracked", "payout"]));
  });
  it("voids when a different item arrives: the money never moves", async () => {
    const p = await ch.propose(intent());
    const done = await ch.deliver(p.id, { ...delivered(1, "30W USB-C Fast Charger Block"), manifest: [{ title: "30W USB-C Fast Charger Block", quantity: 1, attributes: { wattage: "30W" } }] });
    expect(done.state).toBe("voided");
    expect(pp.auths.get(p.paypal.authorizationId!)!.status).toBe("VOIDED");
    expect(pp.payouts).toHaveLength(0);
  });
  it("captures only what arrived on a short shipment", async () => {
    store.mandates.get("md")!.item.maxQuantity = 2;
    store.mandates.get("md")!.budget.maxPerPurchase = 100;
    store.mandates.get("md")!.autoApproveUnder = 100;
    const p = await ch.propose(intent({ quantity: 2 }));
    const done = await ch.deliver(p.id, delivered(1));
    expect(done.paypal.capturedAmount).toBe(39.99);
    expect(done.timeline.some((e) => e.kind === "released")).toBe(true);
  });
  it("blocks without touching PayPal", async () => {
    const p = await ch.propose(intent({ quantity: 9 }));
    expect(p.state).toBe("blocked");
    expect(pp.auths.size).toBe(0);
  });
  it("holds, then authorizes when the human approves", async () => {
    store.mandates.get("md")!.autoApproveUnder = 10;
    const p = await ch.propose(intent());
    expect(p.state).toBe("held");
    expect(pp.auths.size).toBe(0);
    const ok = await ch.decide(p.id, "approve");
    expect(ok.state).toBe("awaiting_delivery");
    expect(pp.auths.size).toBe(1);
  });
  it("holds, then drops when the human declines", async () => {
    store.mandates.get("md")!.autoApproveUnder = 10;
    const p = await ch.propose(intent());
    const no = await ch.decide(p.id, "deny", "not this one");
    expect(no.state).toBe("denied");
    expect(pp.auths.size).toBe(0);
  });
  it("refuses to decide a purchase that isn't held", async () => {
    const p = await ch.propose(intent());
    await expect(ch.decide(p.id, "approve")).rejects.toBeInstanceOf(LifecycleError);
  });
  it("refuses to verify delivery twice", async () => {
    const p = await ch.propose(intent());
    await ch.deliver(p.id, delivered());
    await expect(ch.deliver(p.id, delivered())).rejects.toBeInstanceOf(LifecycleError);
  });
  it("refunds a captured purchase", async () => {
    const p = await ch.propose(intent());
    await ch.deliver(p.id, delivered());
    const r = await ch.refund(p.id, "Defective on arrival");
    expect(r.state).toBe("refunded");
  });
  it("serializes parallel agents so the budget can't be raced", async () => {
    const m = store.mandates.get("md")!;
    m.budget.maxTotal = 80;
    m.item.maxQuantity = 1;
    const cheap = listingsFor(getProduct("fx-chg-ugreen-65")!).find((l) => l.merchant.domain === "amazon.com")!;
    const results = await Promise.all([ch.propose(intent()), ch.propose(intent({ listing: cheap })), ch.propose(intent({ listing: listingsFor(getProduct("fx-chg-anker-735")!).find((l) => l.merchant.domain === "walmart.com")! }))]);
    const live = results.filter((p) => p.state === "awaiting_delivery");
    const total = live.reduce((s, p) => s + p.amount.value, 0);
    expect(total).toBeLessThanOrEqual(80);
    expect(results.some((p) => p.verdict.checks.some((c) => c.rule === "policy.total_budget" && c.outcome === "fail"))).toBe(true);
  });
  it("updates mandate totals as money moves", async () => {
    const p = await ch.propose(intent());
    expect(store.mandates.get("md")!.committed).toBe(39.99);
    await ch.deliver(p.id, delivered());
    expect(store.mandates.get("md")!.settled).toBe(39.99);
    expect(store.mandates.get("md")!.committed).toBe(0);
  });
  it("keeps a measured timeline", async () => {
    const p = await ch.propose(intent());
    expect(p.timeline.find((e) => e.kind === "loop")!.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("simulated PayPal enforces real state rules", () => {
  it("cannot capture a voided authorization", async () => {
    const a = await pp.authorize({ requestId: "r1", amount: 10, currency: "USD", items: [{ name: "x", quantity: 1, unitAmount: 10 }], description: "x", customId: "c", invoiceId: "i" });
    await pp.void(a.authorizationId, "v1");
    await expect(pp.capture(a.authorizationId, { requestId: "c1", amount: 10, final: true, invoiceId: "i" })).rejects.toThrow(/voided/);
  });
  it("cannot void a captured authorization", async () => {
    const a = await pp.authorize({ requestId: "r2", amount: 10, currency: "USD", items: [{ name: "x", quantity: 1, unitAmount: 10 }], description: "x", customId: "c", invoiceId: "i" });
    await pp.capture(a.authorizationId, { requestId: "c2", amount: 10, final: true, invoiceId: "i" });
    await expect(pp.void(a.authorizationId, "v2")).rejects.toThrow(/captured/);
  });
  it("is idempotent on request id", async () => {
    const req = { requestId: "same", amount: 10, currency: "USD" as const, items: [{ name: "x", quantity: 1, unitAmount: 10 }], description: "x", customId: "c", invoiceId: "i" };
    const a = await pp.authorize(req);
    const b = await pp.authorize(req);
    expect(a.authorizationId).toBe(b.authorizationId);
    expect(pp.auths.size).toBe(1);
  });
  it("rejects an item total mismatch", async () => {
    await expect(pp.authorize({ requestId: "m", amount: 11, currency: "USD", items: [{ name: "x", quantity: 1, unitAmount: 10 }], description: "x", customId: "c", invoiceId: "i" })).rejects.toThrow(/mismatch/i);
  });
  it("rejects over-refunds", async () => {
    const a = await pp.authorize({ requestId: "r3", amount: 10, currency: "USD", items: [{ name: "x", quantity: 1, unitAmount: 10 }], description: "x", customId: "c", invoiceId: "i" });
    const c = await pp.capture(a.authorizationId, { requestId: "c3", amount: 10, final: true, invoiceId: "i" });
    await expect(pp.refund(c.captureId, { requestId: "rf", amount: 20, note: "x" })).rejects.toThrow(/exceeds/);
  });
});
