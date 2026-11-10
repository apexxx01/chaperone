import { timed } from "../telemetry.ts";
import type { PayPalApi } from "./types.ts";

const NAMES: Record<string, string> = {
  createSetupToken: "POST /v3/vault/setup-tokens",
  createPaymentToken: "POST /v3/vault/payment-tokens",
  authorize: "POST /v2/checkout/orders (AUTHORIZE)",
  capture: "POST /v2/payments/authorizations/:id/capture",
  void: "POST /v2/payments/authorizations/:id/void",
  refund: "POST /v2/payments/captures/:id/refund",
  addTracking: "POST /v2/checkout/orders/:id/track",
  payout: "POST /v1/payments/payouts",
  getOrder: "GET /v2/checkout/orders/:id",
  searchTransactions: "GET /v1/reporting/transactions",
  verifyWebhook: "POST /v1/notifications/verify-webhook-signature",
};

/** Every PayPal call is timed and logged, against the sandbox or the simulator alike. */
export function instrument(api: PayPalApi): PayPalApi {
  if ((api as { __instrumented?: boolean }).__instrumented) return api;
  return new Proxy(api, {
    get(target, prop, recv) {
      if (prop === "__instrumented") return true;
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function" || !(String(prop) in NAMES)) return v;
      return (...args: unknown[]) =>
        timed("paypal", NAMES[String(prop)]!, () => (v as (...a: unknown[]) => Promise<unknown>).apply(target, args), (r) => {
          const o = r as Record<string, unknown>;
          const id = (o?.authorizationId ?? o?.captureId ?? o?.batchId ?? o?.refundId ?? o?.setupTokenId ?? o?.orderId) as string | undefined;
          const st = o?.status as string | undefined;
          return [st, id].filter(Boolean).join(" · ") || undefined;
        });
    },
  });
}
