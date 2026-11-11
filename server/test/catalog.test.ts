import { describe, expect, it } from "vitest";
import type { PurchaseIntent } from "../src/domain/types.ts";
import { catalogChecks } from "../src/gate/catalog.ts";
import type { C3Product } from "../src/market/channel3.ts";

const product: C3Product = {
  id: "uEVl4QC",
  title: "Universal USB-C Power Delivery 3.0 (PD) Laptop Charger",
  offers: [
    { url: "https://monoprice.com/p", domain: "monoprice.com", price: { price: 24.99, currency: "USD" }, availability: "InStock" },
    { url: "https://www.amazon.com/p", domain: "www.amazon.com", price: { price: 26.5, currency: "USD" }, availability: "InStock" },
  ],
};
const history = {
  canonical_product_id: "uEVl4QC",
  history: Array.from({ length: 30 }, (_, i) => ({ timestamp: `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00Z`, price: 29.99 - (i % 3), currency: "USD" })),
  statistics: { mean: 28.9, std_dev: 0.8, min_price: 27.99, max_price: 29.99, current_price: 24.99, current_status: "low" as const, currency: "USD" },
};
const intent = (domain: string, price: number): PurchaseIntent => ({
  id: "pi_t",
  mandateId: "md",
  agent: "t",
  createdAt: new Date().toISOString(),
  quantity: 1,
  agentRationale: "",
  listing: { id: `uEVl4QC:${domain}`, url: `https://${domain}/item`, title: product.title, price, currency: "USD", productId: "uEVl4QC", merchant: { domain, name: domain, payoutEmail: `${domain}@sellers.chaperone.example`, verified: true } as never, pageText: "" },
});
const run = (domain: string, price: number, cap = 50) => catalogChecks(intent(domain, price), { product, history, ms: 120 }, new Map(), cap);

describe("Channel3 catalog truth", () => {
  it("fails a seller Channel3 doesn't list, and names a real one instead", () => {
    const c = run("amaz0n.com", 21.24).find((x) => x.rule === "market.catalog_seller")!;
    expect(c.outcome).toBe("fail");
    expect(c.title).toContain("amaz0n.com");
    expect(c.data?.altDomain).toBe("monoprice.com");
    expect(c.data?.altPrice).toBe(24.99);
  });
  it("passes a real retailer at its catalog price, www. or not", () => {
    const cs = run("amazon.com", 26.5);
    expect(cs.find((x) => x.rule === "market.catalog_seller")!.outcome).toBe("pass");
    expect(cs.some((x) => x.rule === "market.catalog_price")).toBe(false);
  });
  it("fails a real seller's page that quotes a price far above its catalog price", () => {
    expect(run("monoprice.com", 39.99).find((x) => x.rule === "market.catalog_price")!.outcome).toBe("fail");
  });
  it("flags a price far above the 90-day range", () => {
    expect(run("monoprice.com", 24.99).find((x) => x.rule === "market.price_history")!.outcome).toBe("pass");
    expect(run("monoprice.com", 28).find((x) => x.rule === "market.price_history")!.outcome).toBe("pass");
    expect(catalogChecks(intent("monoprice.com", 45), { product, history, ms: 1 }, new Map(), 100).find((x) => x.rule === "market.price_history")!.outcome).toBe("fail");
    const bait = run("monoprice.com", 9.99).find((x) => x.rule === "market.price_history")!;
    expect(bait.outcome).toBe("warn");
    expect(bait.title).toMatch(/below its 90-day low/);
  });
  it("offers no alternative above the cap", () => {
    expect(run("amaz0n.com", 21.24, 20).find((x) => x.rule === "market.catalog_seller")!.data?.altDomain).toBeUndefined();
  });
  it("skips quietly when Channel3 is unreachable, and adds nothing offline", () => {
    const c = catalogChecks(intent("monoprice.com", 24.99), { product: null, history: null, ms: 0, error: "timeout" }, new Map(), 50);
    expect(c[0]!.outcome).toBe("warn");
    expect(catalogChecks(intent("monoprice.com", 24.99), null, new Map(), 50)).toEqual([]);
  });
});
