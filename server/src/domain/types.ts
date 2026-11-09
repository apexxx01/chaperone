/**
 * Chaperone domain model.
 *
 * Money model (why this is real escrow, not a UI trick):
 *   Chaperone runs as the agent platform's PayPal merchant account.
 *   1. The human approves a Mandate once in PayPal (wallet is vaulted against it).
 *   2. Every purchase the agent proposes is checked, then the buyer's funds are
 *      AUTHORIZED (held, not moved) with Orders v2 intent=AUTHORIZE.
 *   3. The seller is only paid (Payouts) after delivery is verified against the
 *      mandate. Otherwise the authorization is VOIDED: the money never moved.
 */

export type Money = { currency: "USD"; value: number };

export type MandateStatus = "draft" | "awaiting_paypal" | "active" | "revoked" | "expired" | "exhausted";

export interface Mandate {
  id: string;
  createdAt: string;
  expiresAt: string;
  /** The human's own words. Never re-interpreted by the agent. */
  instruction: string;
  /** Structured, human-confirmed reading of the instruction. */
  item: {
    description: string;
    /** Hard requirements every candidate must satisfy, e.g. ["65W", "USB-C"]. */
    mustHave: string[];
    category: string;
    maxQuantity: number;
  };
  budget: {
    currency: "USD";
    maxPerPurchase: number;
    maxTotal: number;
  };
  /** Purchases at or under this go through without a human tap. */
  autoApproveUnder: number;
  /** Max acceptable markup over the market median for the same product. */
  maxOverMarketPct: number;
  merchants: { block: string[] };
  status: MandateStatus;
  /** PayPal vault token for the wallet the human approved for this mandate. */
  paymentTokenId?: string;
  /** Vault v3 setup token awaiting the human's approval in PayPal. */
  setupTokenId?: string;
  payerEmail?: string;
  paypalCustomerId?: string;
  /** Running totals, derived from the ledger. */
  committed: number;
  settled: number;
}

export interface Merchant {
  name: string;
  domain: string;
  /** Where Chaperone pays the seller on verified delivery (PayPal Payouts receiver). */
  payoutEmail: string;
}

/** What the agent saw. Everything in here is UNTRUSTED. */
export interface Listing {
  id: string;
  url: string;
  title: string;
  merchant: Merchant;
  price: number;
  currency: "USD";
  /** Channel3 product id, when the listing maps to a known product. */
  productId?: string;
  brand?: string;
  imageUrl?: string;
  /** Raw page text the agent read. Untrusted. */
  pageText: string;
  attributes?: Record<string, string>;
}

export interface PurchaseIntent {
  id: string;
  mandateId: string;
  agent: string;
  createdAt: string;
  listing: Listing;
  quantity: number;
  /** The agent's own free-text reason. Untrusted: the agent may be hijacked. */
  agentRationale: string;
  /** Free-text the agent wants to attach to the order (gift note etc). Untrusted. */
  note?: string;
}

export type CheckStage = "mandate" | "policy" | "market" | "scanner" | "auditor" | "human" | "delivery";
export type CheckOutcome = "pass" | "warn" | "fail";

export interface Check {
  stage: CheckStage;
  rule: string;
  outcome: CheckOutcome;
  title: string;
  detail: string;
  /** The receipt: the actual numbers behind the call. */
  data?: Record<string, string | number | boolean | null>;
  ms?: number;
}

export type Decision = "authorize" | "hold" | "block";

export interface Verdict {
  decision: Decision;
  checks: Check[];
  /** One plain sentence a human can read in a notification. */
  headline: string;
  riskScore: number;
  ms: number;
}

export type PurchaseState =
  | "proposed"
  | "blocked"
  | "held"
  | "denied"
  | "authorized"
  | "awaiting_delivery"
  | "verifying"
  | "captured"
  | "seller_paid"
  | "voided"
  | "refunded"
  | "failed";

export interface DeliveryReport {
  receivedAt: string;
  carrier?: string;
  trackingNumber?: string;
  /** What actually showed up, as reported by the seller/carrier manifest. Untrusted. */
  manifest: { title: string; quantity: number; attributes?: Record<string, string> }[];
  /** Optional photo / notes from the human at the door. */
  humanNote?: string;
}

export interface Purchase {
  id: string;
  intent: PurchaseIntent;
  verdict: Verdict;
  state: PurchaseState;
  amount: Money;
  paypal: {
    orderId?: string;
    authorizationId?: string;
    captureId?: string;
    capturedAmount?: number;
    payoutBatchId?: string;
    refundId?: string;
    debugIds: string[];
  };
  delivery?: DeliveryReport;
  deliveryVerdict?: Verdict;
  human?: { decision: "approve" | "deny"; at: string; reason?: string };
  timeline: TimelineEvent[];
  updatedAt: string;
}

export interface TimelineEvent {
  at: string;
  kind: string;
  label: string;
  detail?: string;
  ms?: number;
}

export interface AgentStep {
  at: string;
  role: "user" | "agent" | "tool" | "chaperone";
  text: string;
  tool?: string;
}
