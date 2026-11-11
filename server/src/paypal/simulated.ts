/**
 * Offline stand-in with the same contract and the same state rules as PayPal
 * (you can't capture a voided authorization, can't over-capture, idempotent request ids).
 * Used by `npm run demo` and the test suite. The console labels it "SIMULATED".
 */
import { PayPalError, type AuthorizeRequest, type AuthorizeResult, type PayPalApi } from "./types.ts";

type AuthState = { id: string; orderId: string; amount: number; captured: number; status: "CREATED" | "CAPTURED" | "PARTIALLY_CAPTURED" | "VOIDED" };

const id = (prefix: string, n = 17) => prefix + Array.from({ length: n }, () => "0123456789ABCDEFGHJKLMNPRSTUVWXYZ"[Math.floor(Math.random() * 33)]).join("");

export class PayPalSimulated implements PayPalApi {
  readonly kind = "simulated" as const;
  auths = new Map<string, AuthState>();
  captures = new Map<string, { authId: string; amount: number; refunded: number }>();
  orders = new Map<string, AuthorizeRequest>();
  payouts: { batchId: string; receiver: string; amount: number }[] = [];
  private idem = new Map<string, unknown>();
  latencyMs: number;

  constructor(opts: { latencyMs?: number } = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
  }

  private async lag() {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs * (0.6 + Math.random() * 0.8)));
  }

  private once<T>(key: string, fn: () => T): T {
    if (this.idem.has(key)) return this.idem.get(key) as T;
    const v = fn();
    this.idem.set(key, v);
    return v;
  }

  async createSetupToken() {
    await this.lag();
    const t = id("5C", 15);
    return { setupTokenId: t, approveUrl: `/sim/paypal/approve?token=${t}` };
  }

  async createPaymentToken(setupTokenId: string) {
    await this.lag();
    return this.once(`ptok-${setupTokenId}`, () => ({ paymentTokenId: id("8", 7).toLowerCase(), customerId: id("", 9), payerEmail: "sb-buyer@personal.example.com" }));
  }

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    await this.lag();
    if (req.amount <= 0) throw new PayPalError("Amount must be positive", 422, "INVALID_PARAMETER_VALUE");
    const itemTotal = Math.round(req.items.reduce((s, i) => s + i.unitAmount * i.quantity, 0) * 100) / 100;
    if (Math.abs(itemTotal - req.amount) > 0.001) throw new PayPalError("Item total mismatch: items don't add up to the amount", 422, "ITEM_TOTAL_MISMATCH");
    return this.once(req.requestId, () => {
      const orderId = id("", 17);
      const authorizationId = id("", 17);
      this.orders.set(orderId, req);
      this.auths.set(authorizationId, { id: authorizationId, orderId, amount: req.amount, captured: 0, status: "CREATED" });
      return { orderId, authorizationId, status: "CREATED", expiresAt: new Date(Date.now() + 29 * 864e5).toISOString(), debugId: id("f", 12).toLowerCase() };
    });
  }

  async capture(authorizationId: string, opts: { requestId: string; amount: number; final: boolean; invoiceId: string }) {
    await this.lag();
    return this.once(opts.requestId, () => {
      const a = this.auths.get(authorizationId);
      if (!a) throw new PayPalError("Authorization not found", 404, "RESOURCE_NOT_FOUND");
      if (a.status === "VOIDED") throw new PayPalError("Authorization has been voided", 422, "AUTHORIZATION_VOIDED");
      if (a.status === "CAPTURED") throw new PayPalError("Authorization already captured", 422, "AUTHORIZATION_ALREADY_CAPTURED");
      if (a.captured + opts.amount > a.amount * 1.15 + 0.001) throw new PayPalError("Capture exceeds authorized amount", 422, "MAX_CAPTURE_AMOUNT_EXCEEDED");
      a.captured += opts.amount;
      a.status = opts.final ? "CAPTURED" : "PARTIALLY_CAPTURED";
      const captureId = id("", 17);
      this.captures.set(captureId, { authId: authorizationId, amount: opts.amount, refunded: 0 });
      return { captureId, status: "COMPLETED", debugId: id("f", 12).toLowerCase() };
    });
  }

  async void(authorizationId: string, requestId: string) {
    await this.lag();
    return this.once(requestId, () => {
      const a = this.auths.get(authorizationId);
      if (!a) throw new PayPalError("Authorization not found", 404, "RESOURCE_NOT_FOUND");
      if (a.status === "CAPTURED" || a.status === "PARTIALLY_CAPTURED") throw new PayPalError("Authorization already captured", 422, "PREVIOUSLY_CAPTURED");
      a.status = "VOIDED";
      return { status: "VOIDED", debugId: id("f", 12).toLowerCase() };
    });
  }

  async refund(captureId: string, opts: { requestId: string; amount?: number; note: string }) {
    await this.lag();
    return this.once(opts.requestId, () => {
      const c = this.captures.get(captureId);
      if (!c) throw new PayPalError("Capture not found", 404, "RESOURCE_NOT_FOUND");
      const amt = opts.amount ?? c.amount - c.refunded;
      if (c.refunded + amt > c.amount + 0.001) throw new PayPalError("Refund exceeds capture", 422, "REFUND_AMOUNT_EXCEEDED");
      c.refunded += amt;
      return { refundId: id("", 17), status: "COMPLETED", debugId: id("f", 12).toLowerCase() };
    });
  }

  async addTracking(_orderId: string, opts: { captureId: string; trackingNumber: string }) {
    await this.lag();
    return { trackerId: `${opts.captureId}-${opts.trackingNumber}` };
  }

  async payout(opts: { requestId: string; receiverEmail: string; amount: number }) {
    await this.lag();
    return this.once(opts.requestId, () => {
      const batchId = id("", 13);
      this.payouts.push({ batchId, receiver: opts.receiverEmail, amount: opts.amount });
      return { batchId, status: "PENDING" };
    });
  }

  async getOrder(orderId: string) {
    return { id: orderId, ...this.orders.get(orderId) };
  }

  async searchTransactions() {
    const items = [...this.auths.values()].map((a) => ({ id: a.id, amount: `${a.amount.toFixed(2)} USD`, status: a.status, date: new Date().toISOString() }));
    return { count: items.length, items };
  }

  /** The simulator signs its own events with a fixed header; anything else is a forgery. */
  async verifyWebhook(headers: Record<string, string>) {
    return headers["paypal-transmission-sig"] === "chaperone-simulator";
  }
}
