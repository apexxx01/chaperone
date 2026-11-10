import { config } from "../config.ts";
import type { Listing, Merchant, PurchaseIntent } from "../domain/types.ts";
import type { MarketStats } from "../gate/policy.ts";
import { channel3Search, type C3Product } from "./channel3.ts";
import { FIXTURE_PRODUCTS } from "./fixtures.ts";

/** Products seen this session, keyed by Channel3 id. The market reference reads from here. */
const products = new Map<string, C3Product>();
/** Verified sellers: every retailer domain Channel3 returned an offer from. */
export const registry = new Map<string, Merchant>();
/** Product id → ids of the products returned alongside it in the same search. */
const peers = new Map<string, string[]>();

export function merchantFor(domain: string): Merchant {
  const d = domain.toLowerCase().replace(/^www\./, "");
  const name = d.split(".")[0]!.replace(/(^|-)\w/g, (s) => s.replace("-", " ").toUpperCase());
  // Demo payout identity. Real sellers would be onboarded PayPal accounts; these reserved-domain
  // addresses can never reach a real retailer.
  return { name, domain: d, payoutEmail: `${d.replace(/[^a-z0-9]+/g, "-")}@sellers.chaperone.example` };
}

function remember(list: C3Product[], source: "channel3" | "fixture") {
  for (const p of list) {
    products.set(p.id, { ...p, structured_attributes: { ...(p.structured_attributes ?? {}), __source: source } });
    for (const o of p.offers) {
      const m = merchantFor(o.domain);
      if (!registry.has(m.domain)) registry.set(m.domain, m);
    }
  }
}

// Seed the offline catalog so demo mode and tests always have a market.
remember(FIXTURE_PRODUCTS, "fixture");

export function productText(p: C3Product): string {
  const attrs = Object.entries(p.structured_attributes ?? {})
    .filter(([k]) => !k.startsWith("__"))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`);
  return [p.title, p.description ?? "", ...(p.key_features ?? []).map((f) => `• ${f}`), ...attrs].filter(Boolean).join("\n");
}

export function listingsFor(p: C3Product): Listing[] {
  return p.offers
    .filter((o) => o.availability !== "OutOfStock" && o.price.currency === "USD")
    .map((o, i) => {
      const m = merchantFor(o.domain);
      return {
        id: `${p.id}:${m.domain}`,
        url: o.url,
        title: p.title,
        merchant: m,
        price: Math.round(o.price.price * 100) / 100,
        currency: "USD" as const,
        productId: p.id,
        brand: p.brands?.[0]?.name,
        imageUrl: p.images?.find((im) => im.is_main_image)?.url ?? p.images?.[0]?.url,
        pageText: productText(p),
        attributes: Object.fromEntries(
          Object.entries(p.structured_attributes ?? {})
            .filter(([k]) => !k.startsWith("__"))
            .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]),
        ),
        _rank: i,
      } as Listing;
    });
}

export function getProduct(id: string): C3Product | undefined {
  return products.get(id);
}

export async function search(query: string, opts: { maxPrice?: number; limit?: number } = {}): Promise<{ products: C3Product[]; source: "channel3" | "fixture"; ms: number }> {
  const t0 = performance.now();
  if (config.mode !== "offline" && config.channel3Key) {
    const list = await channel3Search(query, { maxPrice: opts.maxPrice, limit: opts.limit ?? 6 });
    remember(list, "channel3");
    for (const p of list) peers.set(p.id, list.map((x) => x.id));
    return { products: list, source: "channel3", ms: performance.now() - t0 };
  }
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const scored = FIXTURE_PRODUCTS.map((p) => ({ p, s: words.filter((w) => productText(p).toLowerCase().includes(w)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.p)
    .filter((p) => opts.maxPrice == null || Math.min(...p.offers.map((o) => o.price.price)) <= opts.maxPrice);
  return { products: scored.slice(0, opts.limit ?? 6), source: "fixture", ms: performance.now() - t0 };
}

/** Median/min/max of the same product's in-stock offers across retailers. */
export function marketFor(productId: string | undefined): MarketStats | null {
  if (!productId) return null;
  const p = products.get(productId);
  if (!p) return null;
  let prices = p.offers.filter((o) => o.availability !== "OutOfStock").map((o) => o.price.price).sort((a, b) => a - b);
  if (!prices.length) return null;
  let basis: "same_product" | "comparable" = "same_product";
  if (prices.length < 2) {
    // Single-retailer product: fall back to the lowest price of each similar product from the same search.
    const group = (peers.get(productId) ?? []).map((id) => products.get(id)).filter((x): x is C3Product => !!x);
    const peerPrices = group.map((g) => Math.min(...g.offers.filter((o) => o.availability !== "OutOfStock").map((o) => o.price.price))).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (peerPrices.length >= 3) {
      prices = peerPrices;
      basis = "comparable";
    }
  }
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid]! : (prices[mid - 1]! + prices[mid]!) / 2;
  return { productId, offers: prices.length, median: Math.round(median * 100) / 100, min: prices[0]!, max: prices[prices.length - 1]!, basis, source: (p.structured_attributes?.__source as "channel3" | "fixture") ?? "channel3" };
}

export async function marketForIntent(intent: PurchaseIntent): Promise<MarketStats | null> {
  return marketFor(intent.listing.productId);
}

/** A cheaper, different product in the same category: what a bait-and-switch seller ships. */
export function substituteFor(productId: string | undefined): { title: string; attributes: Record<string, string> } | null {
  const p = productId ? products.get(productId) : undefined;
  const cat = p?.category?.slug;
  const alt = FIXTURE_PRODUCTS.filter((x) => x.id !== productId && (!cat || x.category?.slug === cat)).sort((a, b) => a.offers[0]!.price.price - b.offers[0]!.price.price)[0];
  if (!alt) return null;
  const l = listingsFor(alt)[0]!;
  return { title: l.title, attributes: l.attributes ?? {} };
}

/** Listings handed to external agents, so a later purchase can reference one by id. */
const listingCache = new Map<string, Listing>();
export async function searchListings(query: string, maxPrice?: number): Promise<{ listings: Listing[]; source: "channel3" | "fixture"; ms: number }> {
  const r = await search(query, { maxPrice, limit: 5 });
  const listings = r.products.flatMap((p) => listingsFor(p).slice(0, 3)).slice(0, 10);
  for (const l of listings) listingCache.set(l.id, l);
  if (listingCache.size > 2000) for (const k of [...listingCache.keys()].slice(0, 500)) listingCache.delete(k);
  return { listings, source: r.source, ms: r.ms };
}
export function cachedListing(id: string): Listing | undefined {
  return listingCache.get(id);
}
