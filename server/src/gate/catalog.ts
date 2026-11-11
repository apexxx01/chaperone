/**
 * Catalog truth (Channel3): does the real catalog agree with what the agent was shown?
 *
 * The agent reads pages a seller wrote. Channel3 knows which retailers actually sell a product,
 * at what price, and what that price has been for 90 days. Three deterministic checks:
 *   1. Is this seller one of the product's real retailers?
 *   2. Does the price on the page match what Channel3 says this seller charges?
 *   3. Is the price far above the product's 90-day range?
 * When a purchase is stopped, the same data names a real seller for the real product: the safer alternative.
 */
import type { Check, Merchant, PurchaseIntent } from "../domain/types.ts";
import type { C3PriceHistory, C3Product } from "../market/channel3.ts";

export interface CatalogFacts {
  product: C3Product | null;
  history: C3PriceHistory | null;
  ms: number;
  error?: string;
}

const norm = (d: string) => d.toLowerCase().replace(/^www\./, "");

export function catalogChecks(intent: PurchaseIntent, facts: CatalogFacts | null, registry: Map<string, Merchant>, maxPerPurchase: number): Check[] {
  if (!facts) return [];
  const ms = Math.round(facts.ms);
  if (facts.error) return [{ stage: "market", rule: "market.catalog_unavailable", outcome: "pass", title: "Channel3 catalog unreachable, skipped", detail: `The other layers still ran. (${facts.error.slice(0, 120)})`, ms }];
  const p = facts.product;
  const l = intent.listing;
  if (!p) return [{ stage: "market", rule: "market.catalog_unknown", outcome: "warn", title: "Product isn't in Channel3's catalog", detail: `Channel3 has no record of product ${l.productId}. A real product sold by real retailers usually is.`, ms }];

  const checks: Check[] = [];
  const offers = p.offers.filter((o) => o.price.currency === "USD");
  const table = offers.slice(0, 8).map((o) => `${norm(o.domain)} $${o.price.price.toFixed(2)}${o.availability === "OutOfStock" ? " (out of stock)" : ""}`).join(" · ");
  const mine = offers.find((o) => norm(o.domain) === norm(l.merchant.domain));

  // Safer alternative: the cheapest in-stock real retailer of this exact product, inside the cap.
  const qty = Math.max(1, intent.quantity);
  const alt = offers
    .filter((o) => o.availability !== "OutOfStock" && norm(o.domain) !== norm(l.merchant.domain) && o.price.price * qty <= maxPerPurchase + 0.005)
    .sort((a, b) => a.price.price - b.price.price)[0];
  const altData: Record<string, string | number> = alt ? { altDomain: norm(alt.domain), altPrice: alt.price.price, altUrl: alt.url } : {};

  if (!mine) {
    checks.push({
      stage: "market",
      rule: "market.catalog_seller",
      outcome: offers.length ? "fail" : "warn",
      title: offers.length ? `Channel3 doesn't list ${l.merchant.domain} as a seller` : "No retailer listed in Channel3",
      detail: offers.length ? `Channel3 knows ${offers.length} real retailer${offers.length > 1 ? "s" : ""} for this product: ${table}. This seller isn't one of them.` : "Channel3 has the product but no current offers.",
      data: { offers: table, sellers: offers.length, ...altData },
      ms,
    });
  } else {
    const diff = Math.round(((l.price - mine.price.price) / mine.price.price) * 1000) / 10;
    const out = mine.availability === "OutOfStock";
    checks.push({
      stage: "market",
      rule: "market.catalog_seller",
      outcome: out ? "warn" : "pass",
      title: out ? `${l.merchant.domain} is out of stock in Channel3` : `Real retailer in Channel3's catalog`,
      detail: `Channel3 lists ${offers.length} retailer${offers.length > 1 ? "s" : ""}: ${table}.`,
      data: { offers: table, sellers: offers.length, ...altData },
      ms,
    });
    if (Math.abs(diff) > 15) {
      checks.push({
        stage: "market",
        rule: "market.catalog_price",
        outcome: diff > 0 ? "fail" : "warn",
        title: diff > 0 ? `Page price is ${diff}% above this seller's catalog price` : `Page price is ${Math.abs(diff)}% below this seller's catalog price`,
        detail: `The page says $${l.price.toFixed(2)}; Channel3 says ${l.merchant.domain} charges $${mine.price.price.toFixed(2)}.`,
        data: { page: l.price, catalog: mine.price.price, diffPct: diff },
      });
    }
  }

  const st = facts.history?.statistics;
  const pts = facts.history?.history ?? [];
  if (st && pts.length >= 5) {
    const step = Math.max(1, Math.ceil(pts.length / 30));
    const series = pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((h) => Math.round(h.price * 100) / 100);
    const over = Math.round(((l.price - st.max_price) / st.max_price) * 1000) / 10;
    checks.push({
      stage: "market",
      rule: "market.price_history",
      outcome: over > 25 ? "fail" : over > 5 ? "warn" : "pass",
      title: over > 5 ? `${over}% above its 90-day high` : `Within its ${pts.length}-day price range`,
      detail: `Channel3's history: $${st.min_price.toFixed(2)}–$${st.max_price.toFixed(2)}, typical $${st.mean.toFixed(2)}, today rated "${st.current_status}". This purchase: $${l.price.toFixed(2)}.`,
      data: { min: st.min_price, max: st.max_price, mean: Math.round(st.mean * 100) / 100, status: st.current_status, days: pts.length, series: series.join(","), price: l.price },
    });
  }
  return checks;
}
