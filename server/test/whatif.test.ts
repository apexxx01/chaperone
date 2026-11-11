import { beforeEach, describe, expect, it } from "vitest";
import type { PurchaseIntent } from "../src/domain/types.ts";
import { whatIf } from "../src/gate/whatif.ts";
import { Chaperone } from "../src/lifecycle/service.ts";
import { getProduct, listingsFor, registry } from "../src/market/catalog.ts";
import { PayPalSimulated } from "../src/paypal/simulated.ts";
import { mandateFor } from "../src/redteam/runner.ts";
import { taskById } from "../src/redteam/tasks.ts";
import { Store } from "../src/store/store.ts";

let store: Store, ch: Chaperone;
let n = 0;
const listing = () => listingsFor(getProduct("fx-chg-anker-735")!).find((l) => l.merchant.domain === "amazon.com")!;
const intent = (over: Partial<PurchaseIntent> = {}): PurchaseIntent => ({ id: `pi_w${++n}`, mandateId: "md", agent: "t", createdAt: new Date().toISOString(), listing: listing(), quantity: 1, agentRationale: "best verified price", ...over });

beforeEach(() => {
  store = new Store();
  ch = new Chaperone(store, new PayPalSimulated());
  const m = mandateFor(taskById("charger"), "md");
  m.budget.maxTotal = 200;
  store.saveMandate(m);
});

describe("what-if gate replay", () => {
  it("re-runs the real policy: a tighter cap blocks what was authorized", async () => {
    const p = await ch.propose(intent());
    expect(p.verdict.decision).toBe("authorize");
    const r = whatIf(p, ch.mandate("md"), store.purchasesFor("md"), registry, { maxPerPurchase: 20 });
    expect(r.after.decision).toBe("block");
    expect(r.changed.some((c) => c.to === "fail")).toBe(true);
    expect(r.mandate.budget.maxPerPurchase).toBe(20);
  });

  it("a lower auto-approve limit holds it for a human instead", async () => {
    const p = await ch.propose(intent());
    const r = whatIf(p, ch.mandate("md"), store.purchasesFor("md"), registry, { autoApproveUnder: 5 });
    expect(r.after.decision).toBe("hold");
  });

  it("blocking the seller blocks the purchase; unchanged limits reproduce the original decision", async () => {
    const p = await ch.propose(intent());
    expect(whatIf(p, ch.mandate("md"), store.purchasesFor("md"), registry, { blockMerchants: ["amazon.com"] }).after.decision).toBe("block");
    expect(whatIf(p, ch.mandate("md"), store.purchasesFor("md"), registry, {}).after.decision).toBe(p.verdict.decision);
  });

  it("never touches the stored purchase or mandate", async () => {
    const p = await ch.propose(intent());
    const before = JSON.stringify([p, ch.mandate("md")]);
    whatIf(p, ch.mandate("md"), store.purchasesFor("md"), registry, { maxTotal: 1, mustHave: ["100W"] });
    expect(JSON.stringify([ch.purchase(p.id), ch.mandate("md")])).toBe(before);
  });
});
