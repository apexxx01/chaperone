const env = process.env;

export type Mode = "live" | "offline";

export const config = {
  mode: ((env.CHAPERONE_MODE ?? "live") === "offline" ? "offline" : "live") as Mode,
  port: Number(env.PORT ?? 8787),
  publicUrl: env.PUBLIC_URL ?? `http://localhost:${env.PORT ?? 8787}`,
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
    env: (env.PAYPAL_ENV ?? "sandbox") as "sandbox" | "live",
    paymentMode: (env.PAYPAL_PAYMENT_MODE ?? "vault") as "vault" | "card",
    webhookId: env.PAYPAL_WEBHOOK_ID ?? "",
  },
  geminiKey: env.GEMINI_API_KEY ?? "",
  geminiModel: env.GEMINI_MODEL ?? "gemini-2.5-flash",
  auditorModel: env.GEMINI_AUDITOR_MODEL ?? env.GEMINI_MODEL ?? "gemini-2.5-flash",
  channel3Key: env.CHANNEL3_API_KEY ?? "",
  dataDir: env.CHAPERONE_DATA_DIR ?? new URL("../data/", import.meta.url).pathname,
};

export function paypalBase(): string {
  return config.paypal.env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

/** What's actually wired up. Shown in the console so nobody is fooled about what's live. */
export function capabilities() {
  const offline = config.mode === "offline";
  return {
    mode: config.mode,
    paypal: !offline && !!config.paypal.clientId && !!config.paypal.clientSecret,
    gemini: !offline && !!config.geminiKey,
    channel3: !offline && !!config.channel3Key,
    paypalEnv: config.paypal.env,
    paymentMode: config.paypal.paymentMode,
  };
}
