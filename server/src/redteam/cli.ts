import { mkdirSync, writeFileSync } from "node:fs";
import { config, capabilities } from "../config.ts";
import { makePayPal } from "../paypal/index.ts";
import { runRedteam, type CaseResult } from "./runner.ts";

const args = new Set(process.argv.slice(2));
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const caps = capabilities();
const paypal = makePayPal();
const ai = caps.gemini ? "gemini" : "heuristic";

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const ICON: Record<string, string> = { blocked: "BLOCKED", held_for_human: "HELD", voided_after_delivery: "VOIDED", partial_capture: "PARTIAL", held_until_confirmed: "HELD", slipped: "SLIPPED", completed: "OK" };

console.log(`\nPickpocket red team · PayPal: ${paypal.kind} · AI: ${ai} · mode: ${config.mode}\n`);
console.log(`${pad("ID", 14)}${pad("Attack", 22)}${pad("Unprotected", 14)}${pad("Chaperone", 10)}${pad("Gate ms", 9)}Caught by`);
console.log("─".repeat(110));
const t0 = performance.now();
const report = await runRedteam({
  paypal,
  ai,
  withUnprotected: !args.has("--no-unprotected"),
  only,
  onCase: (c: CaseResult) =>
    console.log(`${pad(c.id, 14)}${pad(c.name, 22)}${pad(c.unprotected.captured ? `-$${c.unprotected.moved.toFixed(2)}` : c.kind === "benign" ? "" : "(not run)", 14)}${pad(ICON[c.protected.outcome]!, 10)}${pad(String(c.protected.gateMs), 9)}${c.protected.firstCatch ?? ""}`),
});
const s = report.summary;
console.log("─".repeat(110));
console.log(`Attacks: ${s.attacks} · stopped at gate ${s.stoppedAtGate} · held for human ${s.heldForHuman} · caught after purchase ${s.caughtAfterPurchase} · slipped ${s.slipped}`);
console.log(`Unprotected agent moved $${s.unprotectedDollarsMoved.toFixed(2)} · through Chaperone $${s.protectedDollarsMovedWrongly.toFixed(2)} moved wrongly`);
console.log(`Benign: ${s.benignCompleted}/${s.benign} completed · false positives ${s.benignFalsePositives} · median gate ${s.medianGateMs} ms · total ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);

const outDir = new URL("../../../repro/out/", import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });
const file = `${outDir}redteam-${report.id}.json`;
writeFileSync(file, JSON.stringify(report, null, 2));
writeFileSync(`${outDir}redteam-latest.json`, JSON.stringify(report, null, 2));
console.log(`Report: ${file}`);
