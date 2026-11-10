import { describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.ts";
import { PayPalSimulated } from "../src/paypal/simulated.ts";
import { Store } from "../src/store/store.ts";

const store = new Store();
const { app } = createApp(store, new PayPalSimulated());
const call = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null, headers: res.headers };
};

describe("end-to-end loop through the HTTP API (offline)", () => {
  let mandateId = "";

  it("drafts a mandate from the human's words", async () => {
    const r = await call("POST", "/api/mandates", { instruction: "Buy me one 65W USB-C charger for my laptop. Keep it under $50." });
    expect(r.status).toBe(200);
    mandateId = r.json.mandate.id;
    expect(r.json.mandate.item.mustHave).toEqual(expect.arrayContaining(["65W", "USB-C"]));
    expect(r.json.mandate.budget.maxPerPurchase).toBe(50);
    expect(r.json.mandate.status).toBe("draft");
  });

  it("refuses to run the protected agent before PayPal approval", async () => {
    const r = await call("POST", "/api/agent/run", { mandateId, mode: "protected", wait: true });
    expect(r.status).toBe(409);
  });

  it("signs the mandate through the PayPal vault flow", async () => {
    const r = await call("POST", `/api/mandates/${mandateId}/approve`);
    expect(r.json.mandate.status).toBe("awaiting_paypal");
    const back = await call("GET", r.json.approveUrl);
    expect(back.status).toBe(302);
    expect(store.mandates.get(mandateId)!.status).toBe("active");
    expect(store.mandates.get(mandateId)!.paymentTokenId).toBeTruthy();
  });

  it("locks the mandate after signing", async () => {
    const r = await call("PATCH", `/api/mandates/${mandateId}`, { maxTotal: 5000 });
    expect(r.status).toBe(409);
  });

  it("agent buys → funds held → delivery verified → seller paid", async () => {
    const r = await call("POST", "/api/agent/run", { mandateId, mode: "protected", wait: true });
    expect(r.json.run.status).toBe("done");
    const pid = r.json.run.purchaseIds[0];
    expect(store.purchases.get(pid)!.state).toBe("awaiting_delivery");
    const d = await call("POST", `/api/purchases/${pid}/delivery`, { scenario: "as_ordered" });
    expect(d.json.purchase.state).toBe("seller_paid");
  });

  it("a hijacked agent is blocked and no money moves", async () => {
    const m = await call("POST", "/api/mandates", { instruction: "Buy me one 65W USB-C charger for my laptop. Keep it under $50." });
    const id = m.json.mandate.id;
    const a = await call("POST", `/api/mandates/${id}/approve`);
    await call("GET", a.json.approveUrl);
    const r = await call("POST", "/api/agent/run", { mandateId: id, mode: "protected", attackId: "A01", wait: true });
    const p = store.purchases.get(r.json.run.purchaseIds[0])!;
    expect(p.state).toBe("blocked");
    expect(p.paypal.authorizationId).toBeUndefined();
  });

  it("the same attack on an unprotected agent pays the attacker immediately", async () => {
    const r = await call("POST", "/api/agent/run", { mandateId, mode: "unprotected", attackId: "A01", wait: true });
    expect(r.json.run.steps.some((s: any) => /PAID \$/.test(s.text))).toBe(true);
  });

  it("wrong item at delivery voids the authorization", async () => {
    const m = await call("POST", "/api/mandates", { instruction: "Buy me one 65W USB-C charger, under $50" });
    const id = m.json.mandate.id;
    const a = await call("POST", `/api/mandates/${id}/approve`);
    await call("GET", a.json.approveUrl);
    const r = await call("POST", "/api/agent/run", { mandateId: id, mode: "protected", wait: true });
    const d = await call("POST", `/api/purchases/${r.json.run.purchaseIds[0]}/delivery`, { scenario: "wrong_item" });
    expect(d.json.purchase.state).toBe("voided");
  });

  it("stores only a fingerprint of the buyer's proof photo", async () => {
    const m = await call("POST", "/api/mandates", { instruction: "Buy me one 65W USB-C charger, under $50" });
    const id = m.json.mandate.id;
    const a = await call("POST", `/api/mandates/${id}/approve`);
    await call("GET", a.json.approveUrl);
    const r = await call("POST", "/api/agent/run", { mandateId: id, mode: "protected", wait: true });
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const d = await call("POST", `/api/purchases/${r.json.run.purchaseIds[0]}/delivery`, { scenario: "as_ordered", photo: png });
    expect(d.json.purchase.delivery.photo.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(d.json.purchase)).not.toContain("iVBORw0KGgo");
    expect(d.json.purchase.state).toBe("seller_paid");
  });
  it("rejects a photo that isn't an image data URL", async () => {
    const r = await call("POST", "/api/purchases/x/delivery", { photo: "javascript:alert(1)" });
    expect([400, 404]).toContain(r.status);
  });

  it("serves state for the console", async () => {
    const r = await call("GET", "/api/state");
    expect(r.json.mandates.length).toBeGreaterThanOrEqual(3);
    expect(r.json.attacks).toHaveLength(21);
    expect(r.json.capabilities.paypalClient).toBe("simulated");
  });

  it("validates input", async () => {
    expect((await call("POST", "/api/mandates", { instruction: "" })).status).toBe(400);
    expect((await call("POST", "/api/purchases/nope/decision", { decision: "approve" })).status).toBe(404);
  });
});
