import { describe, expect, it } from "vitest";
import { instrument } from "../src/paypal/instrument.ts";
import { PayPalSimulated } from "../src/paypal/simulated.ts";
import { log, recentLines, resetTelemetry, snapshot, timed } from "../src/telemetry.ts";

describe("telemetry", () => {
  it("logs successes and failures with timings and keeps sequence order", async () => {
    resetTelemetry();
    await timed("channel3", "POST /v1/search", async () => 42, (r) => `${r} offers`);
    await expect(timed("gemini", "privileged auditor", async () => { throw new Error("429 quota"); })).rejects.toThrow("429");
    const lines = recentLines();
    expect(lines.map((l) => [l.provider, l.ok])).toEqual([["channel3", true], ["gemini", false]]);
    expect(lines[0]!.note).toBe("42 offers");
    expect(lines[1]!.note).toContain("429");
    expect(lines[1]!.seq).toBeGreaterThan(lines[0]!.seq);
    expect(lines.every((l) => typeof l.ms === "number")).toBe(true);
  });

  it("computes per-provider stats from the real log", () => {
    resetTelemetry();
    for (const ms of [100, 200, 300, 400]) log({ provider: "paypal", op: "x", ms, ok: true });
    log({ provider: "paypal", op: "x", ms: 50, ok: false });
    const s = snapshot();
    expect(s.providers.paypal.calls).toBe(5);
    expect(s.providers.paypal.errors).toBe(1);
    expect(s.providers.paypal.p50).toBe(200);
    expect(s.providers.gemini.calls).toBe(0);
  });

  it("keeps a bounded ring", () => {
    resetTelemetry();
    for (let i = 0; i < 700; i++) log({ provider: "gate", op: `n${i}`, ok: true });
    const lines = recentLines();
    expect(lines.length).toBeLessThanOrEqual(600);
    expect(lines.at(-1)!.op).toBe("n699");
  });

  it("instruments every PayPal call with its REST route", async () => {
    resetTelemetry();
    const pp = instrument(new PayPalSimulated());
    expect(instrument(pp)).toBe(pp);
    const st = await pp.createSetupToken({ returnUrl: "https://x.example/r", cancelUrl: "https://x.example/c" } as never).catch(() => null);
    const ops = recentLines().filter((l) => l.provider === "paypal").map((l) => l.op);
    expect(ops).toContain("POST /v3/vault/setup-tokens");
    expect(st === null || typeof st === "object").toBe(true);
  });
});
