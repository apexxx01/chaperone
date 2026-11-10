import { describe, expect, it } from "vitest";
import type { Mandate, Purchase, PurchaseIntent } from "../src/domain/types.ts";
import { evaluatePolicy, meetsSpec, satisfies, specStatus } from "../src/gate/policy.ts";
import { getProduct, listingsFor, marketFor, registry } from "../src/market/catalog.ts";
import { mandateFor } from "../src/redteam/runner.ts";
import { taskById } from "../src/redteam/tasks.ts";

const charger = () => mandateFor(taskById("charger"), "md_test");
const anker = () => listingsFor(getProduct("fx-chg-anker-735")!).find((l) => l.merchant.domain === "amazon.com")!;
const intent = (over: Partial<PurchaseIntent> = {}): PurchaseIntent => ({ id: "pi_1", mandateId: "md_test", agent: "t", createdAt: new Date().toISOString(), listing: anker(), quantity: 1, agentRationale: "", ...over });
const run = (m: Mandate, it: PurchaseIntent, history: Purchase[] = []) => evaluatePolicy({ mandate: m, intent: it, now: new Date(), registry, history, market: marketFor(it.listing.productId) });
const rule = (cs: ReturnType<typeof run>, r: string) => cs.find((c) => c.rule === r);

describe("requirements matching", () => {
  it("matches spacing and case variants", () => {
    expect(satisfies("65W", "Anker 65 W charger")).toBe(true);
    expect(satisfies("USB-C", "usb c port")).toBe(true);
  });
  it("does not let 165W or 6.5W satisfy 65W", () => {
    expect(satisfies("65W", "165W power brick")).toBe(false);
    expect(satisfies("65W", "6.5W trickle charger")).toBe(false);
  });
  it("trusts structured specs over the title", () => {
    expect(meetsSpec("65W", "65W-Compatible charger", { wattage: "30W" })).toBe(false);
    expect(meetsSpec("65W", "Charger", { wattage: "65W" })).toBe(true);
  });
  it("regression: a 'noise_canceling: no' attribute does not satisfy 'noise cancel'", () => {
    // Found by dogfooding the seeded demo: wired headphones were authorized for a noise-cancelling mandate.
    expect(meetsSpec("noise cancel", "Wired Over-Ear Studio Headphones, 3.5mm", { type: "over-ear", noise_canceling: "no" })).toBe(false);
    expect(meetsSpec("noise cancel", "Hybrid Active Noise Cancelling Headphones", { noise_canceling: "yes" })).toBe(true);
  });
  it("ignores negated mentions in copy", () => {
    expect(meetsSpec("noise cancel", "Closed-back headphones. No active noise cancelling.")).toBe(false);
    expect(meetsSpec("USB-C", "Charger with non-USB-C barrel plug")).toBe(false);
    expect(meetsSpec("USB-C", "2x USB-C ports")).toBe(true);
  });
  it("regression (live run): real catalog wording satisfies feature requirements", () => {
    // Channel3 says "Noise cancellation (ANC)"; the mandate said "noise-cancelling". The first live run blocked a correct purchase.
    const attrs = { "earphone-features": "Noise cancellation", "noise-cancellation-technology": "Active noise cancellation (ANC)", "headphone-style": "Closed-back" };
    expect(specStatus("noise-cancelling", "Anker Soundcore Space One Wireless Headphones", attrs)).toBe("met");
    expect(specStatus("noise cancel", "Sony Noise Canceling Headphones")).toBe("met");
    expect(specStatus("over-ear", "JBL Tune 780NC Over Ear Bluetooth Headphones")).toBe("met");
  });
  it("feature requirements the specs don't mention are unknown, not missing", () => {
    expect(specStatus("over-ear", "Anker Soundcore Space One Wireless Headphones", { "headphone-style": "Closed-back" })).toBe("unknown");
  });
  it("numeric and model requirements are never unknown", () => {
    expect(specStatus("65W", "Universal USB-C Power Delivery Laptop Charger")).toBe("missing");
    expect(specStatus("67XL", "HP 67 Tri-color Ink Cartridge")).toBe("missing");
    expect(specStatus("65W", "Charger", { wattage: "30W" })).toBe("contradicted");
  });
  it("rejects 'compatible' and 'up to' qualifiers", () => {
    expect(meetsSpec("65W", "Charger 65W-compatible")).toBe(false);
    expect(meetsSpec("65W", "supports up to 65W laptops")).toBe(false);
  });
});

describe("deterministic policy", () => {
  it("passes a faithful purchase", () => {
    const cs = run(charger(), intent());
    expect(cs.filter((c) => c.outcome === "fail")).toEqual([]);
    expect(rule(cs, "market.price_vs_median")!.outcome).toBe("pass");
  });
  it("blocks quantity over the mandate", () => {
    expect(rule(run(charger(), intent({ quantity: 3 })), "policy.quantity")!.outcome).toBe("fail");
  });
  it("blocks over the per-purchase cap", () => {
    const cs = run(charger(), intent({ listing: { ...anker(), price: 75 } }));
    expect(rule(cs, "policy.per_purchase_cap")!.outcome).toBe("fail");
  });
  it("blocks when the mandate is expired", () => {
    const m = { ...charger(), expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(rule(run(m, intent()), "mandate.active")!.outcome).toBe("fail");
  });
  it("blocks when the mandate is revoked", () => {
    expect(rule(run({ ...charger(), status: "revoked" }, intent()), "mandate.active")!.outcome).toBe("fail");
  });
  it("blocks lookalike merchants", () => {
    const l = anker();
    const cs = run(charger(), intent({ listing: { ...l, merchant: { ...l.merchant, domain: "amaz0n.com" } } }));
    expect(rule(cs, "policy.lookalike_merchant")!.outcome).toBe("fail");
  });
  it("blocks a swapped payee on a verified merchant", () => {
    const l = anker();
    const cs = run(charger(), intent({ listing: { ...l, merchant: { ...l.merchant, payoutEmail: "x@evil.example" } } }));
    expect(rule(cs, "policy.payee_integrity")!.outcome).toBe("fail");
  });
  it("blocks big markups vs the market median", () => {
    const cs = run(charger(), intent({ listing: { ...anker(), price: 52 } }));
    const c = rule(cs, "market.price_vs_median")!;
    expect(c.outcome).toBe("fail");
    expect(Number(c.data!.overPct)).toBeGreaterThan(20);
  });
  it("holds moderate markups for a human", () => {
    expect(rule(run(charger(), intent({ listing: { ...anker(), price: 46.5 } })), "market.price_vs_median")!.outcome).toBe("warn");
  });
  it("holds unverified sellers", () => {
    const l = anker();
    const cs = run(charger(), intent({ listing: { ...l, merchant: { name: "X", domain: "brand-new-shop.io", payoutEmail: "a@brand-new-shop.io" } } }));
    expect(rule(cs, "policy.merchant_verified")!.outcome).toBe("warn");
  });
  it("blocks merchants on the human's blocklist", () => {
    const m = { ...charger(), merchants: { block: ["amazon.com"] } };
    expect(rule(run(m, intent()), "policy.merchant_blocked")!.outcome).toBe("fail");
  });
  it("holds above the auto-approve limit", () => {
    const m = { ...charger(), autoApproveUnder: 20 };
    expect(rule(run(m, intent()), "human.auto_approve_threshold")!.outcome).toBe("warn");
  });
  it("counts held and authorized purchases against the total budget", () => {
    const m = { ...charger(), budget: { ...charger().budget, maxTotal: 60 } };
    const prior = { state: "authorized", amount: { currency: "USD", value: 39.99 }, intent: intent({ id: "pi_0" }) } as unknown as Purchase;
    const cs = run(m, intent(), [prior]);
    expect(rule(cs, "policy.total_budget")!.outcome).toBe("fail");
  });
  it("flags duplicates", () => {
    const prior = { state: "authorized", amount: { currency: "USD", value: 1 }, intent: intent({ id: "pi_0" }) } as unknown as Purchase;
    expect(rule(run({ ...charger(), budget: { ...charger().budget, maxTotal: 500 } }, intent(), [prior]), "policy.duplicate")!.outcome).toBe("warn");
  });
  it("rejects a currency mismatch", () => {
    const cs = run(charger(), intent({ listing: { ...anker(), currency: "EUR" as "USD" } }));
    expect(rule(cs, "policy.currency")!.outcome).toBe("fail");
  });
});

describe("market reference", () => {
  it("computes median across retailer offers", () => {
    const mk = marketFor("fx-chg-anker-735")!;
    expect(mk.offers).toBe(5);
    expect(mk.median).toBe(41.99);
    expect(mk.min).toBe(38.5);
  });
  it("returns null for unknown products", () => expect(marketFor("nope")).toBeNull());
});
