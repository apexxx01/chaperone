import { capabilities } from "../config.ts";
import { PayPalSandbox } from "./client.ts";
import { PayPalSimulated } from "./simulated.ts";
import type { PayPalApi } from "./types.ts";

export function makePayPal(): PayPalApi {
  return capabilities().paypal ? new PayPalSandbox() : new PayPalSimulated({ latencyMs: 120 });
}
