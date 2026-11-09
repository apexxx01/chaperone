/**
 * Timed end-to-end loop on whatever is configured (sandbox or simulator):
 * mandate → agent proposes → gate → PayPal authorize → delivery → capture → tracking → payout.
 * Uses an already-approved mandate when one exists in the data dir (sandbox vault approval
 * needs a human once), otherwise a simulated approval.
 *
 *   npm run loop
 */
import { config, capabilities } from "../config.ts";
import { runShopper } from "../agent/shopper.ts";
import { Chaperone } from "../lifecycle/service.ts";
import { makePayPal } from "../paypal/index.ts";
import { Store } from "../store/store.ts";
import { mandateFor } from "./runner.ts";
import { taskById } from "./tasks.ts";

const store = new Store(config.dataDir);
const paypal = makePayPal();
const ch = new Chaperone(store, paypal);
const caps = capabilities();

let mandate = [...store.mandates.values()].find((m) => m.status === "active" && m.paymentTokenId && (paypal.kind === "simulated" || m.paymentTokenId !== "sim-vault-token"));
if (!mandate) {
  if (paypal.kind === "sandbox" && config.paypal.paymentMode === "vault") {
    console.error("No PayPal-approved mandate yet. Open the console, create a mandate and click Approve with PayPal once, then rerun.");
    process.exit(1);
  }
  mandate = mandateFor(taskById("charger"), `md_loop_${Date.now().toString(36)}`, paypal.kind === "sandbox" ? "sandbox-test-card" : "sim-vault-token");
  store.saveMandate(mandate);
}
// Fresh budget for each loop so it can be rerun.
mandate.budget.maxTotal = Math.max(mandate.budget.maxTotal, mandate.settled + mandate.committed + mandate.budget.maxPerPurchase);
if (mandate.status === "exhausted") mandate.status = "active";

console.log(`Loop · PayPal ${paypal.kind} · AI ${caps.gemini ? config.geminiModel : "heuristic"} · products ${caps.channel3 ? "Channel3" : "fixtures"}`);
const t0 = performance.now();
const run = await runShopper({ store, chaperone: ch, paypal }, { mandate, mode: "protected" });
const tAgent = performance.now();
const pid = run.purchaseIds[0];
if (!pid) {
  console.error("Agent didn't propose a purchase:", run.steps.at(-1)?.text);
  process.exit(1);
}
let p = ch.purchase(pid);
console.log(`agent → proposal + gate + authorize: ${((tAgent - t0) / 1000).toFixed(1)} s  (${p.state}, gate ${p.verdict.ms} ms)`);
if (p.state !== "awaiting_delivery") {
  console.log(p.verdict.headline);
  process.exit(0);
}
const td = performance.now();
p = await ch.deliver(p.id, { receivedAt: new Date().toISOString(), carrier: "UPS", trackingNumber: `1Z${Date.now()}`.slice(0, 18), manifest: [{ title: p.intent.listing.title, quantity: p.intent.quantity, attributes: p.intent.listing.attributes }] });
const tEnd = performance.now();
console.log(`delivery → verify + capture + tracking + payout: ${((tEnd - td) / 1000).toFixed(1)} s  (${p.state})`);
for (const e of p.timeline) console.log(`  ${e.kind.padEnd(10)} ${e.ms != null ? String(e.ms).padStart(6) + " ms" : "         "}  ${e.label}`);
console.log(`\nTotal: ${((tEnd - t0) / 1000).toFixed(1)} s · order ${p.paypal.orderId} · auth ${p.paypal.authorizationId} · capture ${p.paypal.captureId} · payout ${p.paypal.payoutBatchId}`);
await new Promise((r) => setTimeout(r, 300));
