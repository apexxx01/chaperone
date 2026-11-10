import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { config } from "../config.ts";

let client: GoogleGenAI | null = null;
export function gemini(): GoogleGenAI {
  if (!config.geminiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env, or run in offline mode (CHAPERONE_MODE=offline).");
  client ??= new GoogleGenAI({ apiKey: config.geminiKey });
  return client;
}

const FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.6-flash,gemini-3.8-flash").split(",").map((m) => m.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 12000);
/** Which model actually answered last. Shown in receipts so nothing is misattributed. */
export let lastModelUsed = "";

const coolingUntil = new Map<string, number>();

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`504 ${what} timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Try the configured model, then fall back to other Gemini models when it is
 * overloaded or slow. Each attempt has a hard timeout so a busy model can't hang a request.
 */
async function withRetry<T>(fn: (model: string) => Promise<T>, model: string): Promise<T> {
  let last: unknown;
  const now = Date.now();
  const all = [model, ...FALLBACKS.filter((f) => f !== model)];
  // Circuit breaker: skip a model that just failed for two minutes (unless every model is cooling off).
  const open = all.filter((m) => (coolingUntil.get(m) ?? 0) < now);
  for (const m of open.length ? open : all) {
    try {
      const r = await withTimeout(fn(m), TIMEOUT_MS, m);
      lastModelUsed = m;
      return r;
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      coolingUntil.set(m, Date.now() + 120_000);
      if (!/429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|fetch failed|ECONNRESET|timed out|NOT_FOUND|404/i.test(msg)) throw e;
    }
  }
  throw last;
}

/** Structured output call: the model can only answer in this JSON shape. */
export async function generateJson<T>(opts: { model: string; system: string; prompt: string; schema: object; temperature?: number; image?: { mime: string; data: string } }): Promise<T> {
  const res = await withRetry((model) =>
    gemini().models.generateContent({
      model,
      contents: [{ role: "user", parts: [...(opts.image ? [{ inlineData: { mimeType: opts.image.mime, data: opts.image.data } }] : []), { text: opts.prompt }] }],
      config: {
        systemInstruction: opts.system,
        responseMimeType: "application/json",
        responseJsonSchema: opts.schema,
        temperature: opts.temperature ?? 0,
      },
    }),
    opts.model,
  );
  const text = res.text ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 200)}`);
  }
}

export async function generateWithTools(opts: { model: string; system: string; contents: Content[]; tools: FunctionDeclaration[]; temperature?: number }) {
  return withRetry((model) =>
    gemini().models.generateContent({
      model,
      contents: opts.contents,
      config: {
        systemInstruction: opts.system,
        tools: [{ functionDeclarations: opts.tools }],
        temperature: opts.temperature ?? 0.2,
      },
    }),
    opts.model,
  );
}
