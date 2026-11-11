import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { config } from "../config.ts";
import { timed } from "../telemetry.ts";
import { bedrockEnabled, bedrockJson, bedrockTools } from "./bedrock.ts";

let client: GoogleGenAI | null = null;
export function gemini(): GoogleGenAI {
  if (!config.geminiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env, or run in offline mode (CHAPERONE_MODE=offline).");
  client ??= new GoogleGenAI({ apiKey: config.geminiKey });
  return client;
}

const FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS ?? "gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.5-flash-lite").split(",").map((m) => m.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 12000);
/** Which model actually answered last. Shown in receipts so nothing is misattributed. */
export let lastModelUsed = "";

const RETRYABLE = /429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|fetch failed|ECONNRESET|timed out|NOT_FOUND|404/i;
const retryable = (e: unknown) => RETRYABLE.test(String((e as Error)?.message ?? e));

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
async function withRetry<T>(fn: (model: string) => Promise<T>, model: string, what = "generate"): Promise<T> {
  let last: unknown;
  const now = Date.now();
  const all = [model, ...FALLBACKS.filter((f) => f !== model)];
  // Circuit breaker: try models that just failed last, for 30 seconds.
  const open = all.filter((m) => (coolingUntil.get(m) ?? 0) < now);
  const backup = bedrockEnabled();
  // With a backup provider, don't make the user wait through every cooling Gemini model: one pass over the healthy ones.
  if (backup && !open.length) throw new Error("503 every Gemini model is cooling off");
  // Models that are cooling off still get tried last, so one bad minute can't fail a request outright.
  const order = backup ? open : [...open, ...all.filter((x) => !open.includes(x))];
  // Two passes: Gemini overload errors are usually over within seconds.
  for (const m of backup ? order : [...order, ...order]) {
    try {
      const r = await timed("gemini", `${what} · ${m}`, () => withTimeout(fn(m), TIMEOUT_MS, m));
      lastModelUsed = m;
      return r;
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      coolingUntil.set(m, Date.now() + 30_000);
      if (!RETRYABLE.test(msg)) throw e;
    }
  }
  throw last;
}

/** Which provider and model produced an answer. */
export interface Answered<T> {
  value: T;
  provider: "gemini" | "bedrock";
  model: string;
}

/** Structured output call: the model can only answer in this JSON shape. Falls back to Bedrock when Gemini can't answer. */
export async function generateJsonMeta<T>(opts: { model: string; system: string; prompt: string; schema: object; temperature?: number; image?: { mime: string; data: string }; label?: string; fast?: boolean }): Promise<Answered<T>> {
  let model = opts.model;
  try {
    const res = await withRetry((m) => {
      model = m;
      return gemini().models.generateContent({
        model: m,
        contents: [{ role: "user", parts: [...(opts.image ? [{ inlineData: { mimeType: opts.image.mime, data: opts.image.data } }] : []), { text: opts.prompt }] }],
        config: {
          systemInstruction: opts.system,
          responseMimeType: "application/json",
          responseJsonSchema: opts.schema,
          temperature: opts.temperature ?? 0,
        },
      });
    }, opts.model, opts.label ?? "json");
    const text = res.text ?? "";
    try {
      return { value: JSON.parse(text) as T, provider: "gemini", model };
    } catch {
      throw new Error(`502 Gemini returned non-JSON output: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    if (!bedrockEnabled() || !retryable(e)) throw e;
    const r = await bedrockJson<T>({ system: opts.system, prompt: opts.prompt, schema: opts.schema, temperature: opts.temperature, image: opts.image, label: opts.label, fast: opts.fast });
    lastModelUsed = r.model;
    return { value: r.value, provider: "bedrock", model: r.model };
  }
}

export async function generateJson<T>(opts: Parameters<typeof generateJsonMeta>[0]): Promise<T> {
  return (await generateJsonMeta<T>(opts)).value;
}

export async function generateWithTools(opts: { model: string; system: string; contents: Content[]; tools: FunctionDeclaration[]; temperature?: number }) {
  try {
    const res = await withRetry((model) =>
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
      "agent turn",
    );
    return { candidates: res.candidates, functionCalls: res.functionCalls, provider: "gemini" as const, model: lastModelUsed };
  } catch (e) {
    if (!bedrockEnabled() || !retryable(e)) throw e;
    const r = await bedrockTools(opts);
    lastModelUsed = r.model;
    return { ...r, provider: "bedrock" as const };
  }
}
