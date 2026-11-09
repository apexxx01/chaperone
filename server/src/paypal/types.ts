export interface OrderItem {
  name: string;
  quantity: number;
  unitAmount: number;
  sku?: string;
}

export interface AuthorizeRequest {
  requestId: string;
  amount: number;
  currency: "USD";
  items: OrderItem[];
  description: string;
  /** Chaperone purchase id, echoed back on webhooks. */
  customId: string;
  invoiceId: string;
  softDescriptor?: string;
  vaultId?: string;
}

export interface AuthorizeResult {
  orderId: string;
  authorizationId: string;
  status: string;
  expiresAt?: string;
  debugId?: string;
}

export interface SetupTokenResult {
  setupTokenId: string;
  approveUrl: string;
}

export interface PaymentTokenResult {
  paymentTokenId: string;
  customerId?: string;
  payerEmail?: string;
}

export interface PayoutResult {
  batchId: string;
  status: string;
}

export interface PayPalApi {
  readonly kind: "sandbox" | "simulated";
  createSetupToken(opts: { returnUrl: string; cancelUrl: string; description: string }): Promise<SetupTokenResult>;
  createPaymentToken(setupTokenId: string): Promise<PaymentTokenResult>;
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
  capture(authorizationId: string, opts: { requestId: string; amount: number; final: boolean; invoiceId: string }): Promise<{ captureId: string; status: string; debugId?: string }>;
  void(authorizationId: string, requestId: string): Promise<{ status: string; debugId?: string }>;
  refund(captureId: string, opts: { requestId: string; amount?: number; note: string }): Promise<{ refundId: string; status: string; debugId?: string }>;
  addTracking(orderId: string, opts: { captureId: string; trackingNumber: string; carrier: string; items: { name: string; quantity: number; sku?: string }[] }): Promise<{ trackerId: string }>;
  payout(opts: { requestId: string; receiverEmail: string; amount: number; note: string; purchaseId: string }): Promise<PayoutResult>;
  getOrder(orderId: string): Promise<unknown>;
  searchTransactions(opts: { start: Date; end: Date }): Promise<{ count: number; items: { id: string; amount: string; status: string; date: string; customId?: string }[] }>;
  verifyWebhook(headers: Record<string, string>, body: unknown): Promise<boolean>;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issue?: string,
    readonly debugId?: string,
  ) {
    super(message);
  }
}
