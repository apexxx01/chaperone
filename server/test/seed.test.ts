import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyChain } from "../src/lifecycle/receipt.ts";

describe("the recorded sandbox history the live site ships with", () => {
  const seed = JSON.parse(readFileSync(new URL("../seed/snapshot.json", import.meta.url), "utf8"));
  it("has a receipt chain that verifies for every purchase", () => {
    const broken = seed.purchases.filter((p: never) => !verifyChain(p).ok).map((p: { id: string }) => p.id);
    expect(broken).toEqual([]);
  });
  it("never claims a partially refunded purchase is fully refunded", () => {
    for (const p of seed.purchases) {
      const left = (p.paypal.capturedAmount ?? p.amount.value) - (p.paypal.refundedAmount ?? 0);
      if (p.paypal.refundedAmount && left > 0.001) expect(p.state).not.toBe("refunded");
    }
  });
});
