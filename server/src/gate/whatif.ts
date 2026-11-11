/**
 * What-if: re-run the real deterministic gate on a past purchase under different limits.
 * Policy, market and scanner checks are recomputed with the same code the live gate runs.
 * The AI layer is not called again (it costs a model call and its answer depends on the page,
 * not on your limits), so its recorded checks are carried over and labeled as such.
 */
import type { Check, Decision, Mandate, Merchant, Purchase } from "../domain/types.ts";
import { decide, headline, scanIntent, scannerChecks } from "./pipeline.ts";
import { evaluatePolicy, type MarketStats } from "./policy.ts";

export interface WhatIfLimits {
  maxPerPurchase?: number;
  maxTotal?: number;
  autoApproveUnder?: number;
  maxOverMarketPct?: number;
  maxQuantity?: number;
  mustHave?: string[];
  blockMerchants?: string[];
}

export interface WhatIfResult {
  before: { decision: Decision; headline: string };
  after: { decision: Decision; headline: string };
  mandate: Pick<Mandate, "budget" | "autoApproveUnder" | "maxOverMarketPct"> & { maxQuantity: number; mustHave: string[]; blockMerchants: string[] };
  changed: { rule: string; title: string; from: Check["outcome"] | "absent"; to: Check["outcome"] | "absent"; detail: string }[];
  checks: (Check & { carried?: boolean })[];
  ms: number;
}

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);

/** Rebuild the market reference the live gate saw, from the check it recorded. */
function recordedMarket(p: Purchase): MarketStats | null {
  const c = p.verdict.checks.find((x) => x.stage === "market" && x.data && "median" in x.data);
  if (!c?.data) return null;
  const median = Number(c.data.median);
  const range = /range \$([\d.,]+)–\$([\d.,]+)/.exec(c.detail ?? "");
  const n = (s?: string) => (s ? Number(s.replace(/,/g, "")) : median);
  return {
    productId: p.intent.listing.productId ?? "",
    offers: Number(c.data.offers ?? c.data.comparables ?? 0),
    median,
    min: n(range?.[1]),
    max: n(range?.[2]),
    source: (c.data.source as MarketStats["source"]) ?? "channel3",
    basis: c.rule === "market.price_vs_comparable" ? "comparable" : "same_product",
  };
}

export function whatIf(p: Purchase, mandate: Mandate, siblings: Purchase[], registry: Map<string, Merchant>, raw: WhatIfLimits): WhatIfResult {
  const t0 = performance.now();
  const m: Mandate = structuredClone(mandate);
  const L = raw ?? {};
  m.budget.maxPerPurchase = num(L.maxPerPurchase, 0, 1e6) ?? m.budget.maxPerPurchase;
  m.budget.maxTotal = num(L.maxTotal, 0, 1e7) ?? m.budget.maxTotal;
  m.autoApproveUnder = num(L.autoApproveUnder, 0, 1e6) ?? m.autoApproveUnder;
  m.maxOverMarketPct = num(L.maxOverMarketPct, 0, 1000) ?? m.maxOverMarketPct;
  m.item.maxQuantity = Math.round(num(L.maxQuantity, 1, 1000) ?? m.item.maxQuantity);
  if (Array.isArray(L.mustHave)) m.item.mustHave = L.mustHave.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  if (Array.isArray(L.blockMerchants)) m.merchants.block = L.blockMerchants.map(String).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 20);
  // Judge it as of the moment it was proposed, against the purchases that came before it.
  m.status = "active";
  const at = new Date(p.intent.createdAt);
  const history = siblings.filter((x) => x.id !== p.id && x.intent.createdAt < p.intent.createdAt);

  const policy = evaluatePolicy({ mandate: m, intent: p.intent, now: at, registry, history, market: recordedMarket(p) });
  const scan = scannerChecks(scanIntent(p.intent));
  // Reused as recorded: the AI's answers, and Channel3's catalog facts (they describe the product, not your limits).
  const fromCatalog = (c: Check) => c.rule.startsWith("market.catalog") || c.rule === "market.price_history";
  const ai = p.verdict.checks.filter((c) => c.stage === "auditor" || fromCatalog(c)).map((c) => ({ ...c, carried: true }));
  // The reader may have confirmed requirements the title didn't state; respect that if the requirement list is unchanged.
  const req = policy.find((c) => c.rule === "policy.requirements");
  const orig = p.verdict.checks.find((c) => c.rule === "policy.requirements");
  if (req && orig && req.outcome === "warn" && !Array.isArray(L.mustHave)) Object.assign(req, { outcome: orig.outcome, title: orig.title, detail: orig.detail });
  else if (req && req.outcome === "warn") req.detail = `${req.detail} The quarantined reader would check the description for these in a live run.`;

  const checks = [...policy, ...scan, ...ai];
  const decision = decide(checks);

  const key = (c: Check) => `${c.rule}`;
  const before = new Map(p.verdict.checks.map((c) => [key(c), c]));
  const after = new Map(checks.map((c) => [key(c), c]));
  const changed: WhatIfResult["changed"] = [];
  for (const [k, c] of after) {
    const b = before.get(k);
    if (!b || b.outcome !== c.outcome) changed.push({ rule: k, title: c.title, from: b?.outcome ?? "absent", to: c.outcome, detail: c.detail ?? "" });
  }
  for (const [k, b] of before) if (!after.has(k) && b.stage !== "auditor" && b.stage !== "delivery" && !fromCatalog(b)) changed.push({ rule: k, title: b.title, from: b.outcome, to: "absent", detail: "No longer applies." });

  return {
    before: { decision: p.verdict.decision, headline: p.verdict.headline },
    after: { decision, headline: headline(decision, checks, p.intent) },
    mandate: { budget: m.budget, autoApproveUnder: m.autoApproveUnder, maxOverMarketPct: m.maxOverMarketPct, maxQuantity: m.item.maxQuantity, mustHave: m.item.mustHave, blockMerchants: m.merchants.block },
    changed,
    checks,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  };
}
