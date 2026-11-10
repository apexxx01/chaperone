import type { Check, Decision, Mandate, Merchant, Purchase, PurchaseIntent, Verdict } from "../domain/types.ts";
import { audit, flagsToChecks, readUntrusted } from "./auditor.ts";
import { evaluatePolicy, round2, type MarketStats } from "./policy.ts";
import { scanText, type Finding } from "./scanner.ts";

export interface GateDeps {
  registry: Map<string, Merchant>;
  history: (mandateId: string) => Purchase[];
  market: (intent: PurchaseIntent) => Promise<MarketStats | null>;
  now?: () => Date;
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
  const market = await deps.market(intent).catch(() => null);
  const marketMs = performance.now() - tm;

  const tp = performance.now();
  const deterministic = evaluatePolicy({ mandate, intent, now, registry: deps.registry, history: deps.history(mandate.id), market });
  for (const c of deterministic) c.ms = c.stage === "market" ? Math.round(marketMs) : Math.round(performance.now() - tp);

  const findings = scanIntent(intent);
  const scan = scannerChecks(findings);

  // AI layer: quarantined reader, then privileged auditor.
  let ai: Check[] = [];
  try {
    const reqCheck = deterministic.find((c) => c.rule === "policy.requirements");
    const unconfirmed = reqCheck?.outcome === "warn" ? String(reqCheck.data?.unconfirmed ?? "").split(", ").filter(Boolean) : [];
    const reader = await readUntrusted(intent, unconfirmed);
    if (reqCheck && unconfirmed.length) {
      const still = unconfirmed.filter((_, i) => !reader.confirmed[i]);
      // A page that is trying to steer the agent doesn't get to vouch for itself.
      const steering = reader.flags.addressesAI || reader.flags.claimsApproval;
      if (still.length || steering) {
        reqCheck.outcome = "fail";
        reqCheck.title = `Missing: ${(still.length ? still : unconfirmed).join(", ")}`;
        reqCheck.detail = `Not in the title or specs, and the listing's description ${steering && !still.length ? "can't be trusted to confirm it" : "doesn't clearly state it either"}.`;
      } else {
        reqCheck.outcome = "pass";
        reqCheck.title = "Meets every requirement";
        reqCheck.detail = `${unconfirmed.join(", ")} confirmed from the listing's description by the quarantined reader (${reader.source}); the rest matched the title and specs.`;
      }
      reqCheck.data = { ...reqCheck.data, confirmedByReader: unconfirmed.filter((_, i) => reader.confirmed[i]).join(", ") };
    }
    const readerCheck = flagsToChecks(reader.flags, reader.source, reader.ms);
    const a = await audit({ mandate, intent, market, deterministic, flags: reader.flags, findings });
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
    ai = [{ stage: "auditor", rule: "auditor.unavailable", outcome: "warn", title: "Auditor unavailable, routing to you", detail: String((e as Error).message).slice(0, 160) }];
  }

  const checks = [...deterministic, ...scan, ...ai];
  const decision = decide(checks);
  return { decision, checks, headline: headline(decision, checks, intent), riskScore: riskScore(checks, findings), ms: Math.round(performance.now() - t0) };
}
