/**
 * Deterministic policy. Plain code, no model: these are facts, not judgment.
 * Text from the page is never an input to an amount; amounts come from the
 * structured listing and are checked against the human's mandate.
 */
import type { Check, Mandate, Merchant, Purchase, PurchaseIntent } from "../domain/types.ts";
import { lookalikeOf } from "./scanner.ts";

export interface MarketStats {
  productId: string;
  offers: number;
  median: number;
  min: number;
  max: number;
  source: "channel3" | "fixture";
  /** same_product: other retailers selling this exact product. comparable: similar products from the same search. */
  basis?: "same_product" | "comparable";
}

export interface PolicyContext {
  mandate: Mandate;
  intent: PurchaseIntent;
  now: Date;
  /** Verified sellers: domain → merchant (payout identity). */
  registry: Map<string, Merchant>;
  /** Other purchases under the same mandate. */
  history: Purchase[];
  market?: MarketStats | null;
}

const LIVE: Purchase["state"][] = ["authorized", "awaiting_delivery", "verifying", "captured", "seller_paid", "held"];

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function normalizeReq(s: string): string {
  return s.toLowerCase().normalize("NFKC").replace(/[\s\-_]+/g, "").replace(/watts?$/, "w");
}

export type SpecStatus = "met" | "missing" | "contradicted" | "unknown";

const NEGATIVE = /^(no|none|false|n|0|not included|without|n\/a)$/i;

/**
 * Requirement check that trusts structured attributes over marketing copy.
 *  - Numeric specs ("65W"): must be stated. If an attribute gives a value in that unit ("wattage: 30W"),
 *    it decides, whatever the title claims ("65W-Compatible"). Never "unknown": absent means missing.
 *  - Feature specs ("noise-cancelling"): met when stated, contradicted when an attribute says no or the
 *    only mentions are negated, otherwise "unknown" and left for the quarantined reader to confirm.
 */
export function specStatus(requirement: string, title: string, attributes: Record<string, string> = {}): SpecStatus {
  const num = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(requirement.trim());
  if (num) {
    const unit = num[2]!.toLowerCase();
    const specVals = Object.values(attributes).filter((v) => new RegExp(`\\d\\s*${unit}\\b`, "i").test(v.replace(/watts?/gi, "w")));
    if (specVals.length) return specVals.some((v) => satisfies(requirement, v)) ? "met" : "contradicted";
    // Qualifiers that mean "not actually": "65W-compatible", "up to 65W", "for 65W laptops"
    const t = title.toLowerCase().replace(/watts?/g, "w");
    const qualified = new RegExp(`(up to|for|supports?)\\s*${num[1]}\\s*${unit}|${num[1]}\\s*${unit}[-\\s]*(compatible|ready|equivalent|replacement)`, "i").test(t);
    if (qualified) return "contradicted";
    return satisfies(requirement, [title, ...Object.entries(attributes).map(([k, v]) => `${k} ${v}`)].join(" | ")) ? "met" : "missing";
  }
  // Model-style tokens with digits ("67XL") are exact: stated or missing.
  if (/\d/.test(requirement)) return satisfies(requirement, [title, ...Object.values(attributes)].join(" | ")) ? "met" : "missing";

  const req = normalizeReq(requirement);
  for (const [k, v] of Object.entries(attributes)) {
    const key = normalizeReq(k);
    if ((key.includes(req) || req.includes(key)) && NEGATIVE.test(v.trim())) return "contradicted";
  }
  const text = [title, ...Object.entries(attributes).map(([k, v]) => (NEGATIVE.test(v.trim()) ? "" : `${k} ${v}`))].join(" | ");
  const m = mentions(requirement, text);
  return m.positive ? "met" : m.negated ? "contradicted" : "unknown";
}

export function meetsSpec(requirement: string, title: string, attributes: Record<string, string> = {}): boolean {
  return specStatus(requirement, title, attributes) === "met";
}

const stem = (w: string) => (w.length > 6 ? w.slice(0, 5) : w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Stemmed, negation-aware mention search: "noise-cancelling" matches "Noise cancellation (ANC)" but not "no noise cancelling". */
export function mentions(requirement: string, text: string): { positive: boolean; negated: boolean } {
  const words = requirement.toLowerCase().split(/[\s\-_]+/).filter(Boolean);
  const pattern = words.map((w) => `${stem(w)}\\w*`).join("[\\s\\-_]*");
  const re = new RegExp(`(\\b(no|not|non|without|lacks?|zero)\\b[\\s\\-]*(\\w+[\\s\\-]+){0,2})?\\b${pattern}`, "gi");
  let positive = false, negated = false;
  for (const m of text.toLowerCase().matchAll(re)) m[1] ? (negated = true) : (positive = true);
  return { positive, negated };
}

/** True when a requirement like "65W" or "USB-C" is satisfied by the product text. */
export function satisfies(requirement: string, haystack: string): boolean {
  const req = normalizeReq(requirement);
  const hay = normalizeReq(haystack);
  // Numeric specs: "65W" is satisfied by "65 Watt", but NOT by "165W" or "6.5W".
  const num = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(req);
  if (!num) return hay.includes(req);
  {
    const re = new RegExp(`(^|[^0-9.])${num[1]!.replace(".", "\\.")}\\s*${num[2]}`, "i");
    return re.test(haystack.toLowerCase().replace(/watts?/g, "w"));
  }
}

export function evaluatePolicy(ctx: PolicyContext): Check[] {
  const { mandate: m, intent: it, now } = ctx;
  const amount = round2(it.listing.price * it.quantity);
  const checks: Check[] = [];
  const push = (c: Check) => checks.push(c);

  // Mandate validity
  const expired = new Date(m.expiresAt) < now;
  push({
    stage: "mandate",
    rule: "mandate.active",
    outcome: m.status === "active" && !expired ? "pass" : "fail",
    title: m.status === "active" && !expired ? "Mandate is active" : "Mandate is not active",
    detail: expired ? `Expired ${m.expiresAt}.` : `Status: ${m.status}.`,
    data: { status: m.status, expiresAt: m.expiresAt },
  });
  push({
    stage: "mandate",
    rule: "mandate.payment_method",
    outcome: m.paymentTokenId ? "pass" : "warn",
    title: m.paymentTokenId ? "Wallet approved in PayPal" : "No PayPal wallet approved yet",
    detail: m.paymentTokenId ? "The human approved this mandate's wallet in PayPal." : "Purchases need a one-time PayPal approval first.",
  });

  // Currency
  push({
    stage: "policy",
    rule: "policy.currency",
    outcome: it.listing.currency === m.budget.currency ? "pass" : "fail",
    title: "Currency matches mandate",
    detail: `${it.listing.currency} vs mandate ${m.budget.currency}.`,
  });

  // Quantity
  push({
    stage: "policy",
    rule: "policy.quantity",
    outcome: it.quantity >= 1 && it.quantity <= m.item.maxQuantity ? "pass" : "fail",
    title: it.quantity <= m.item.maxQuantity ? "Quantity within mandate" : "Quantity exceeds mandate",
    detail: `Agent wants ${it.quantity}; human allowed ${m.item.maxQuantity}.`,
    data: { requested: it.quantity, allowed: m.item.maxQuantity },
  });

  // Per-purchase cap
  push({
    stage: "policy",
    rule: "policy.per_purchase_cap",
    outcome: amount <= m.budget.maxPerPurchase ? "pass" : "fail",
    title: amount <= m.budget.maxPerPurchase ? "Under per-purchase cap" : "Over per-purchase cap",
    detail: `$${amount.toFixed(2)} vs cap $${m.budget.maxPerPurchase.toFixed(2)}.`,
    data: { amount, cap: m.budget.maxPerPurchase },
  });

  // Total budget (counts held + authorized + settled, so parallel agents can't race past it)
  const committed = round2(ctx.history.filter((p) => LIVE.includes(p.state)).reduce((s, p) => s + p.amount.value, 0));
  const remaining = round2(m.budget.maxTotal - committed);
  push({
    stage: "policy",
    rule: "policy.total_budget",
    outcome: amount <= remaining ? "pass" : "fail",
    title: amount <= remaining ? "Fits remaining budget" : "Would exceed total budget",
    detail: `$${amount.toFixed(2)} vs $${remaining.toFixed(2)} remaining of $${m.budget.maxTotal.toFixed(2)}.`,
    data: { amount, committed, remaining, total: m.budget.maxTotal },
  });

  // Requirements
  const status = m.item.mustHave.map((r) => ({ r, s: specStatus(r, it.listing.title, it.listing.attributes ?? {}) }));
  const missing = status.filter((x) => x.s === "missing" || x.s === "contradicted").map((x) => x.r);
  const unknown = status.filter((x) => x.s === "unknown").map((x) => x.r);
  push({
    stage: "policy",
    rule: "policy.requirements",
    outcome: missing.length ? "fail" : unknown.length ? "warn" : "pass",
    title: missing.length ? `Missing: ${missing.join(", ")}` : unknown.length ? `Couldn't confirm from the specs: ${unknown.join(", ")}` : "Meets every requirement",
    detail: missing.length
      ? `The human required ${m.item.mustHave.join(", ")}; the listing's title and specs don't show ${missing.join(", ")}.`
      : unknown.length
        ? `The title and structured specs don't state ${unknown.join(", ")}.`
        : `Matched ${m.item.mustHave.join(", ") || "no explicit requirements"}.`,
    data: { required: m.item.mustHave.join(", "), missing: missing.join(", "), unconfirmed: unknown.join(", ") },
  });

  // Merchant identity
  const domain = it.listing.merchant.domain.toLowerCase().replace(/^www\./, "");
  const verified = ctx.registry.get(domain);
  const imitates = lookalikeOf(domain, [...ctx.registry.keys()]);
  if (m.merchants.block.map((d) => d.toLowerCase()).includes(domain)) {
    push({ stage: "policy", rule: "policy.merchant_blocked", outcome: "fail", title: "Merchant is on the human's blocklist", detail: domain });
  }
  if (imitates) {
    push({ stage: "policy", rule: "policy.lookalike_merchant", outcome: "fail", title: `Lookalike of ${imitates}`, detail: `${domain} imitates the verified seller ${imitates}.`, data: { domain, imitates } });
  } else {
    push({
      stage: "policy",
      rule: "policy.merchant_verified",
      outcome: verified ? "pass" : "warn",
      title: verified ? `Verified seller: ${verified.name}` : "Unverified seller",
      detail: verified ? `${domain} is in the seller registry.` : `${domain} is not in the seller registry; a human should confirm.`,
      data: { domain },
    });
  }

  // Payee integrity: the money must go to the registered payout identity, not whatever the page says.
  if (verified) {
    const same = verified.payoutEmail.toLowerCase() === it.listing.merchant.payoutEmail.toLowerCase();
    push({
      stage: "policy",
      rule: "policy.payee_integrity",
      outcome: same ? "pass" : "fail",
      title: same ? "Payee matches verified seller" : "Payee was swapped",
      detail: same ? `Seller paid at ${verified.payoutEmail}.` : `Listing asks to pay ${it.listing.merchant.payoutEmail}; ${verified.name}'s verified payee is ${verified.payoutEmail}.`,
      data: { expected: verified.payoutEmail, got: it.listing.merchant.payoutEmail },
    });
  }

  // Velocity + duplicates
  const hourAgo = now.getTime() - 60 * 60 * 1000;
  const recent = ctx.history.filter((p) => new Date(p.intent.createdAt).getTime() > hourAgo && p.state !== "blocked" && p.state !== "denied");
  push({
    stage: "policy",
    rule: "policy.velocity",
    outcome: recent.length < 5 ? "pass" : "fail",
    title: recent.length < 5 ? "Normal purchase rate" : "Too many purchases in an hour",
    detail: `${recent.length} purchase(s) in the last hour (limit 5).`,
    data: { lastHour: recent.length },
  });
  const dupe = ctx.history.find((p) => LIVE.includes(p.state) && (p.intent.listing.productId ?? p.intent.listing.url) === (it.listing.productId ?? it.listing.url));
  if (dupe) {
    push({ stage: "policy", rule: "policy.duplicate", outcome: "warn", title: "Already bought this", detail: `Same product as purchase ${dupe.id} (${dupe.state}).` });
  }

  // Market price (Channel3)
  const mk = ctx.market;
  if (mk && mk.basis === "comparable" && mk.offers >= 3) {
    // Only one retailer sells this exact product, so compare against similar products. Different
    // products legitimately differ in price, so the bar is much looser: catch outliers, not premiums.
    const ratio = round2(it.listing.price / mk.median);
    const outcome = ratio > 2.5 ? "fail" : ratio > 1.75 ? "warn" : "pass";
    push({
      stage: "market",
      rule: "market.price_vs_comparable",
      outcome,
      title: outcome === "pass" ? "In line with comparable products" : `${ratio}× the price of comparable products`,
      detail: `$${it.listing.price.toFixed(2)} vs median $${mk.median.toFixed(2)} across ${mk.offers} comparable products (range $${mk.min.toFixed(2)}–$${mk.max.toFixed(2)}). Only one retailer lists this exact product.`,
      data: { price: it.listing.price, median: mk.median, comparables: mk.offers, ratio, source: mk.source },
    });
  } else if (mk && mk.offers >= 2) {
    const over = round2(((it.listing.price - mk.median) / mk.median) * 100);
    const outcome = over > m.maxOverMarketPct ? "fail" : over > m.maxOverMarketPct / 2 ? "warn" : "pass";
    push({
      stage: "market",
      rule: "market.price_vs_median",
      outcome,
      title: outcome === "pass" ? "Fair price" : over > 0 ? `${over}% over market` : "Below market",
      detail: `$${it.listing.price.toFixed(2)} vs median $${mk.median.toFixed(2)} across ${mk.offers} offers (range $${mk.min.toFixed(2)}–$${mk.max.toFixed(2)}).`,
      data: { price: it.listing.price, median: mk.median, offers: mk.offers, overPct: over, limitPct: m.maxOverMarketPct, source: mk.source },
    });
  } else {
    push({ stage: "market", rule: "market.no_reference", outcome: "warn", title: "No market reference", detail: "Couldn't find enough offers to price-check this product." });
  }

  // Human threshold (a hold, not a block)
  push({
    stage: "human",
    rule: "human.auto_approve_threshold",
    outcome: amount <= m.autoApproveUnder ? "pass" : "warn",
    title: amount <= m.autoApproveUnder ? "Under auto-approve limit" : "Over auto-approve limit",
    detail: amount <= m.autoApproveUnder ? `$${amount.toFixed(2)} ≤ $${m.autoApproveUnder.toFixed(2)}.` : `$${amount.toFixed(2)} needs a human tap (limit $${m.autoApproveUnder.toFixed(2)}).`,
    data: { amount, limit: m.autoApproveUnder },
  });

  return checks;
}
