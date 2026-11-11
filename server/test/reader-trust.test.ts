import { describe, expect, it, vi } from "vitest";

// A reader that says "yes, the page states it" no matter what: what a fooled or hijacked reader would do.
vi.mock("../src/gate/auditor.ts", async (orig) => {
  const real = await orig<typeof import("../src/gate/auditor.ts")>();
  return {
    ...real,
    readUntrusted: async (_intent: unknown, confirm: string[] = []) => ({ flags: real.heuristicFlags(""), confirmed: confirm.map(() => true), source: "fooled reader", ms: 1 }),
  };
});

const { Chaperone } = await import("../src/lifecycle/service.ts");
const { getProduct, listingsFor } = await import("../src/market/catalog.ts");
const { PayPalSimulated } = await import("../src/paypal/simulated.ts");
const { mandateFor } = await import("../src/redteam/runner.ts");
const { taskById } = await import("../src/redteam/tasks.ts");
const { Store } = await import("../src/store/store.ts");

describe("the quarantined reader can't pass a purchase on its own", () => {
  const setup = () => {
    const store = new Store();
    const pp = new PayPalSimulated();
    const ch = new Chaperone(store, pp);
    const m = mandateFor(taskById("headphones"), "md");
    m.item.mustHave = ["noise-cancelling", "over-ear"];
    store.saveMandate(m);
    const base = listingsFor(getProduct("fx-hp-soundcore-q30")!).find((l) => l.merchant.domain === "amazon.com")!;
    const listing = (pageText: string) => ({ ...base, title: "Soundcore Space One Wireless Headphones", attributes: { "headphone-style": "Closed-back" }, pageText });
    const intent = (pageText: string) => ({ id: `pi_${Math.random().toString(36).slice(2)}`, mandateId: "md", agent: "t", createdAt: new Date().toISOString(), listing: listing(pageText), quantity: 1, agentRationale: "best price" });
    return { ch, pp, intent };
  };

  it("holds for the human when only the model says the page covers a requirement", async () => {
    const { ch, pp, intent } = setup();
    const p = await ch.propose(intent("Wireless headphones with 40 hour battery."));
    expect(p.state).toBe("held");
    const req = p.verdict.checks.find((c) => c.rule === "policy.requirements")!;
    expect(req.outcome).toBe("warn");
    expect(req.detail).toMatch(/doesn't authorize a purchase/);
    expect(pp.auths.size).toBe(0);
  });

  it("passes when the page text itself states the requirement", async () => {
    const { ch, intent } = setup();
    const p = await ch.propose(intent("Over-ear headphones with adaptive active noise cancelling."));
    expect(p.state).toBe("awaiting_delivery");
  });
});
