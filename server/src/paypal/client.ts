/**
 * Thin, typed PayPal REST client (sandbox). Every POST carries a PayPal-Request-Id
 * so retries are idempotent, and every debug id is kept for the receipts view.
 */
import { config, paypalBase } from "../config.ts";
import { PayPalError, type AuthorizeRequest, type AuthorizeResult, type PayPalApi } from "./types.ts";

type Json = Record<string, any>;

export class PayPalSandbox implements PayPalApi {
  readonly kind = "sandbox" as const;
  private token: { value: string; exp: number } | null = null;

  constructor(
    private clientId = config.paypal.clientId,
    private secret = config.paypal.clientSecret,
    private base = paypalBase(),
  ) {
    if (!clientId || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing. Get them at developer.paypal.com → Apps & Credentials → Sandbox.");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) throw new PayPalError(`PayPal auth failed (${res.status}): ${body.error_description ?? body.error ?? "check client id/secret"}`, res.status);
    this.token = { value: body.access_token, exp: Date.now() + Number(body.expires_in ?? 3000) * 1000 };
    return this.token.value;
  }

  async call<T = Json>(method: string, path: string, body?: unknown, opts: { requestId?: string; prefer?: string } = {}, attempt = 0): Promise<T & { __debugId?: string }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    headers["Prefer"] = opts.prefer ?? "return=representation";
    const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    const text = await res.text();
    const json = (text ? JSON.parse(text) : {}) as Json;
    if (res.status === 401 && attempt === 0) {
      this.token = null;
      return this.call(method, path, body, opts, 1);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return this.call(method, path, body, opts, attempt + 1);
    }
    if (!res.ok) {
      const issue = json.details?.[0]?.issue ?? json.name;
      const desc = json.details?.[0]?.description ?? json.message ?? text.slice(0, 200);
      throw new PayPalError(`PayPal ${method} ${path} → ${res.status} ${issue ?? ""}: ${desc}`, res.status, issue, debugId ?? json.debug_id);
    }
    return Object.assign(json, { __debugId: debugId ?? json.debug_id }) as T & { __debugId?: string };
  }

  // ── Mandate approval: save the human's PayPal wallet once, without a purchase (Vault v3) ──
  async createSetupToken(opts: { returnUrl: string; cancelUrl: string; description: string }) {
    const r = await this.call("POST", "/v3/vault/setup-tokens", {
      payment_source: {
        paypal: {
          description: opts.description,
          usage_pattern: "IMMEDIATE",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: true,
          experience_context: { brand_name: "Chaperone", return_url: opts.returnUrl, cancel_url: opts.cancelUrl, shipping_preference: "NO_SHIPPING", vault_instruction: "ON_PAYER_APPROVAL" },
        },
      },
    }, { requestId: `setup-${crypto.randomUUID()}` });
    const approve = (r.links as Json[] | undefined)?.find((l) => l.rel === "approve")?.href;
    if (!approve) throw new PayPalError("Setup token created without an approve link", 500);
    return { setupTokenId: r.id as string, approveUrl: approve as string };
  }

  async createPaymentToken(setupTokenId: string) {
    const r = await this.call("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id: setupTokenId, type: "SETUP_TOKEN" } } }, { requestId: `ptok-${setupTokenId}` });
    return { paymentTokenId: r.id as string, customerId: r.customer?.id as string | undefined, payerEmail: r.payment_source?.paypal?.email_address as string | undefined };
  }

  // ── Hold the money: Orders v2, intent=AUTHORIZE ──
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const value = req.amount.toFixed(2);
    const itemTotal = req.items.reduce((s, i) => s + i.unitAmount * i.quantity, 0).toFixed(2);
    const paymentSource =
      config.paypal.paymentMode === "card" || !req.vaultId
        ? { card: { number: "4111111111111111", expiry: "2030-12", name: "Chaperone Test Buyer", billing_address: { address_line_1: "2211 N First St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" } } }
        : { paypal: { vault_id: req.vaultId, stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", charge_pattern: "UNSCHEDULED_POSTPAID" } } };
    const order = await this.call("POST", "/v2/checkout/orders", {
      intent: "AUTHORIZE",
      payment_source: paymentSource,
      purchase_units: [
        {
          reference_id: req.customId,
          custom_id: req.customId,
          ...(req.payeeEmail ? { payee: { email_address: req.payeeEmail } } : {}),
          invoice_id: req.invoiceId,
          description: req.description.slice(0, 127),
          soft_descriptor: req.softDescriptor?.slice(0, 22),
          amount: { currency_code: req.currency, value, breakdown: { item_total: { currency_code: req.currency, value: itemTotal } } },
          items: req.items.map((i) => ({ name: i.name.slice(0, 127), quantity: String(i.quantity), unit_amount: { currency_code: req.currency, value: i.unitAmount.toFixed(2) }, sku: i.sku?.slice(0, 127), category: "PHYSICAL_GOODS" })),
        },
      ],
    }, { requestId: req.requestId });

    let auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    let status = order.status as string;
    if (!auth && (status === "APPROVED" || status === "CREATED")) {
      const authorized = await this.call("POST", `/v2/checkout/orders/${order.id}/authorize`, {}, { requestId: `${req.requestId}-auth` });
      auth = authorized.purchase_units?.[0]?.payments?.authorizations?.[0];
      status = authorized.status;
    }
    if (!auth) throw new PayPalError(`Order ${order.id} not authorized (status ${status}). If PAYER_ACTION_REQUIRED, the wallet needs approval.`, 422, status, order.__debugId);
    if (auth.status !== "CREATED" && auth.status !== "PENDING") throw new PayPalError(`Authorization ${auth.id} is ${auth.status}`, 402, auth.status, order.__debugId);
    return { orderId: order.id, authorizationId: auth.id, status: auth.status, expiresAt: auth.expiration_time, debugId: order.__debugId };
  }

  async capture(authorizationId: string, opts: { requestId: string; amount: number; final: boolean; invoiceId: string }) {
    const r = await this.call("POST", `/v2/payments/authorizations/${authorizationId}/capture`, {
      amount: { currency_code: "USD", value: opts.amount.toFixed(2) },
      final_capture: opts.final,
      invoice_id: `${opts.invoiceId}-cap`,
      note_to_payer: "Delivered as ordered. Verified by Chaperone.",
    }, { requestId: opts.requestId });
    return { captureId: r.id as string, status: r.status as string, debugId: r.__debugId };
  }

  async void(authorizationId: string, requestId: string) {
    // Void returns 204 with Prefer: return=minimal semantics; ask for representation to get status.
    const r = await this.call("POST", `/v2/payments/authorizations/${authorizationId}/void`, undefined, { requestId });
    return { status: (r.status as string) ?? "VOIDED", debugId: r.__debugId };
  }

  async refund(captureId: string, opts: { requestId: string; amount?: number; note: string }) {
    const r = await this.call("POST", `/v2/payments/captures/${captureId}/refund`, {
      ...(opts.amount ? { amount: { currency_code: "USD", value: opts.amount.toFixed(2) } } : {}),
      note_to_payer: opts.note.slice(0, 255),
    }, { requestId: opts.requestId });
    return { refundId: r.id as string, status: r.status as string, debugId: r.__debugId };
  }

  async addTracking(orderId: string, opts: { captureId: string; trackingNumber: string; carrier: string; items: { name: string; quantity: number; sku?: string }[] }) {
    const r = await this.call("POST", `/v2/checkout/orders/${orderId}/track`, {
      capture_id: opts.captureId,
      tracking_number: opts.trackingNumber,
      carrier: opts.carrier,
      notify_payer: false,
      items: opts.items.map((i) => ({ name: i.name.slice(0, 127), quantity: String(i.quantity), sku: i.sku })),
    }, { requestId: `track-${opts.captureId}-${opts.trackingNumber}` });
    const tracker = (r.purchase_units?.[0]?.shipping?.trackers?.[0]?.id as string) ?? `${opts.captureId}-${opts.trackingNumber}`;
    return { trackerId: tracker };
  }

  async payout(opts: { requestId: string; receiverEmail: string; amount: number; note: string; purchaseId: string }) {
    const r = await this.call("POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: opts.requestId, email_subject: "You've been paid for a verified delivery", email_message: opts.note },
      items: [{ recipient_type: "EMAIL", receiver: opts.receiverEmail, amount: { currency: "USD", value: opts.amount.toFixed(2) }, note: opts.note.slice(0, 4000), sender_item_id: opts.purchaseId }],
    }, { requestId: opts.requestId });
    return { batchId: r.batch_header?.payout_batch_id as string, status: r.batch_header?.batch_status as string };
  }

  async getOrder(orderId: string) {
    return this.call("GET", `/v2/checkout/orders/${orderId}`);
  }

  async searchTransactions(opts: { start: Date; end: Date }) {
    const qs = new URLSearchParams({ start_date: opts.start.toISOString().replace(/\.\d+Z$/, "Z"), end_date: opts.end.toISOString().replace(/\.\d+Z$/, "Z"), fields: "transaction_info", page_size: "100" });
    const r = await this.call("GET", `/v1/reporting/transactions?${qs}`);
    const items = ((r.transaction_details as Json[]) ?? []).map((t) => ({
      id: t.transaction_info?.transaction_id,
      amount: `${t.transaction_info?.transaction_amount?.value} ${t.transaction_info?.transaction_amount?.currency_code}`,
      status: t.transaction_info?.transaction_status,
      date: t.transaction_info?.transaction_initiation_date,
      customId: t.transaction_info?.custom_field,
    }));
    return { count: items.length, items };
  }

  async verifyWebhook(headers: Record<string, string>, body: unknown) {
    if (!config.paypal.webhookId) return false;
    const r = await this.call("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: config.paypal.webhookId,
      webhook_event: body,
    });
    return r.verification_status === "SUCCESS";
  }
}
