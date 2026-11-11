import type { Check, Decision, Mandate, Merchant, Purchase, PurchaseIntent, Verdict } from "../domain/types.ts";
import { audit, flagsToChecks, readUntrusted } from "./auditor.ts";
import { evaluatePolicy, mentions, round2, type MarketStats } from "./policy.ts";
import { catalogChecks, type CatalogFacts } from "./catalog.ts";
import { scanText, type Finding } from "./scanner.ts";

export interface GateDeps {
  registry: Map<string, Merchant>;
  history: (mandateId: string) => Purchase[];
  market: (intent: PurchaseIntent) => Promise<MarketStats | null>;
  /** Channel3 catalog truth for this exact product (sellers, prices, 90-day history). Optional: offline runs skip it. */
  catalog?: (intent: PurchaseIntent) => Promise<CatalogFacts | null>;
  now?: () => Date;
}

/** Fail closed, in plain words. The raw provider error stays in the server log. */
function aiDownReason(e: unknown): string {
  const msg = String((e as Error)?.message ?? e);
  console.warn("AI layer unavailable:", msg.slice(0, 300));
  if (/quota|429|RESOURCE_EXHAUSTED/i.test(msg)) return "The AI auditor is over its usage limit right now. Chaperone fails closed: instead of guessing, it asks you.";
  if (/timed out|503|UNAVAILABLE|overloaded|high demand/i.test(msg)) return "The AI auditor didn't answer in time. Chaperone fails closed: instead of guessing, it asks you.";
  return "The AI auditor couldn't be reached. Chaperone fails closed: instead of guessing, it asks you.";
}


const SCAN_WEIGHT = { high: 35, medium: 15, low: 4 } as const;

export function scanIntent(intent: PurchaseIntent): Finding[] {
  return [
    ...scanText("listing.title", intent.listing.title),
    ...scanText("listing.pageText", intent.listing.pageText),
    ...scanText("agent.rationale", intent.agentRationale),
    ...scanText("order.note", intent.note ?? ""),
  ];
}

export function scannerChecks(findings: Finding[]): Check[] {
  if (!findings.length) return [{ stage: "scanner", rule: "scanner.clean", outcome: "pass", title: "No injection fingerprints", detail: "No hidden characters, role spoofing or AI-directed text." }];
  // high → block, medium → human, low (e.g. "only 3 left") → noted, not escalated: real pages say that all day.
  return findings.map((f) => ({
    stage: "scanner" as const,
    rule: `scanner.${f.kind}`,
    outcome: f.severity === "high" ? ("fail" as const) : f.severity === "medium" ? ("warn" as const) : ("pass" as const),
    title: f.explanation,
    detail: `In ${f.field}: “${f.excerpt}”`,
    data: { severity: f.severity, field: f.field },
  }));
}

/** fail anywhere → block; warn anywhere → hold for a human; else authorize. */
export function decide(checks: Check[]): Decision {
  if (checks.some((c) => c.outcome === "fail")) return "block";
  if (checks.some((c) => c.outcome === "warn")) return "hold";
  return "authorize";
}

export function riskScore(checks: Check[], findings: Finding[]): number {
  let s = 0;
  for (const c of checks) s += c.outcome === "fail" ? 30 : c.outcome === "warn" ? 8 : 0;
  for (const f of findings) s += SCAN_WEIGHT[f.severity];
  return Math.min(100, s);
}

export function headline(decision: Decision, checks: Check[], intent: PurchaseIntent): string {
  const amount = round2(intent.listing.price * intent.quantity).toFixed(2);
  const first = checks.find((c) => c.outcome === "fail") ?? checks.find((c) => c.outcome === "warn");
  if (decision === "authorize") return `Held $${amount} for ${shorten(intent.listing.title)}, not charged. The seller gets paid when it arrives as ordered.`;
  if (decision === "hold") return `Needs you: $${amount} for ${shorten(intent.listing.title)}. ${(first?.title ?? "").replace(/\.$/, "")}.`;
  return `Blocked $${amount} at ${intent.listing.merchant.domain}: ${(first?.title ?? "policy").replace(/\.$/, "")}.`;
}

function shorten(s: string, n = 48) {
  return s.length > n ? s.slice(0, n - 1).trimEnd().replace(/[,.;:]$/, "") + "…" : s;
}

export async function runGate(mandate: Mandate, intent: PurchaseIntent, deps: GateDeps): Promise<Verdict> {
  const t0 = performance.now();
  const now = deps.now?.() ?? new Date();

  const tm = performance.now();
  const [market, catalog] = await Promise.all([deps.market(intent).catch(() => null), deps.catalog ? deps.catalog(intent).catch((e) => ({ product: null, history: null, ms: 0, error: String((e as Error)?.message ?? e) })) : Promise.resolve(null)]);
  const marketMs = performance.now() - tm;

  const tp = performance.now();
  const deterministic = evaluatePolicy({ mandate, intent, now, registry: deps.registry, history: deps.history(mandate.id), market });
  for (const c of deterministic) c.ms = c.stage === "market" ? Math.round(marketMs) : Math.round(performance.now() - tp);
  deterministic.push(...catalogChecks(intent, catalog, deps.registry, mandate.budget.maxPerPurchase));

  const findings = scanIntent(intent);
  const scan = scannerChecks(findings);

  // AI layer: the quarantined reader and the privileged auditor run at the same time and never talk to each other.
  // The auditor sees only what the deterministic layer already established.
  let ai: Check[] = [];
  try {
    const reqCheck = deterministic.find((c) => c.rule === "policy.requirements");
    const unconfirmed = reqCheck?.outcome === "warn" ? String(reqCheck.data?.unconfirmed ?? "").split(", ").filter(Boolean) : [];
    // Requirements the reader is still confirming aren't reported to the auditor as problems.
    const settled = deterministic.filter((c) => !(c === reqCheck && c.outcome === "warn"));
    const [reader, a] = await Promise.all([readUntrusted(intent, unconfirmed), audit({ mandate, intent, market, deterministic: settled, findings, canonicalTitle: catalog?.product?.title })]);
    if (reqCheck && unconfirmed.length) {
      const still = unconfirmed.filter((_, i) => !reader.confirmed[i]);
      // A page that is trying to steer the agent doesn't get to vouch for itself.
      const steering = reader.flags.addressesAI || reader.flags.claimsApproval;
      // The reader alone never passes a purchase: its "yes" counts only where the page text itself
      // states the requirement, checked in plain code. Otherwise its "yes" can only hold it for you.
      const literal = unconfirmed.filter((r) => {
        const m = mentions(r, intent.listing.pageText);
        return m.positive && !m.negated;
      });
      const onlyReader = unconfirmed.filter((r) => !literal.includes(r));
      if (still.length || steering) {
        reqCheck.outcome = "fail";
        reqCheck.title = `Missing: ${(still.length ? still : unconfirmed).join(", ")}`;
        reqCheck.detail = `Not in the title or specs, and the listing's description ${steering && !still.length ? "can't be trusted to confirm it" : "doesn't clearly state it either"}.`;
      } else if (onlyReader.length) {
        reqCheck.outcome = "warn";
        reqCheck.title = `Check: ${onlyReader.join(", ")}`;
        reqCheck.detail = `The quarantined reader (${reader.source}) thinks the description covers ${onlyReader.join(", ")}, but the page never states it in words the code can verify. A model's "yes" alone doesn't authorize a purchase, so you decide.`;
      } else {
        reqCheck.outcome = "pass";
        reqCheck.title = "Meets every requirement";
        reqCheck.detail = `${unconfirmed.join(", ")} confirmed from the listing's description by the quarantined reader (${reader.source}); the rest matched the title and specs.`;
      }
      reqCheck.data = { ...reqCheck.data, confirmedByReader: unconfirmed.filter((_, i) => reader.confirmed[i]).join(", ") };
    }
    const readerCheck = flagsToChecks(reader.flags, reader.source, reader.ms);
    ai = [
      readerCheck,
      {
        stage: "auditor",
        rule: "auditor.mandate_alignment",
        outcome: !a.result.aligned ? "fail" : a.result.confidence < 0.6 ? "warn" : "pass",
        title: a.result.aligned ? (a.result.confidence < 0.6 ? "Auditor unsure" : "Auditor: serves your instruction") : "Auditor: doesn't serve your instruction",
        detail: a.result.summary,
        data: { aligned: a.result.aligned, confidence: Math.round(a.result.confidence * 100) / 100, concerns: a.result.concerns.join(", "), source: a.source },
        ms: Math.round(a.ms),
      },
    ];
  } catch (e) {
    // Fail closed: if the AI layer is down, a human decides.
    ai = [{ stage: "auditor", rule: "auditor.unavailable", outcome: "warn", title: "Auditor unavailable, routing to you", detail: aiDownReason(e) }];
  }

  const checks = [...deterministic, ...scan, ...ai];
  const decision = decide(checks);
  return { decision, checks, headline: headline(decision, checks, intent), riskScore: riskScore(checks, findings), ms: Math.round(performance.now() - t0) };
}
