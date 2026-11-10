import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { config } from "../config.ts";

let client: GoogleGenAI | null = null;
export function gemini(): GoogleGenAI {
  if (!config.geminiKey) throw new Error("GEMINI_API_KEY is not set. Add it to .env, or run in offline mode (CHAPERONE_MODE=offline).");
  client ??= new GoogleGenAI({ apiKey: config.geminiKey });
  return client;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      if (!/429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ECONNRESET/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 600 * 2 ** i));
    }
  }
  throw last;
}

/** Structured output call: the model can only answer in this JSON shape. */
export async function generateJson<T>(opts: { model: string; system: string; prompt: string; schema: object; temperature?: number; image?: { mime: string; data: string } }): Promise<T> {
  const res = await withRetry(() =>
    gemini().models.generateContent({
      model: opts.model,
      contents: [{ role: "user", parts: [...(opts.image ? [{ inlineData: { mimeType: opts.image.mime, data: opts.image.data } }] : []), { text: opts.prompt }] }],
      config: {
        systemInstruction: opts.system,
        responseMimeType: "application/json",
        responseJsonSchema: opts.schema,
        temperature: opts.temperature ?? 0,
      },
    }),
  );
  const text = res.text ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 200)}`);
  }
}

export async function generateWithTools(opts: { model: string; system: string; contents: Content[]; tools: FunctionDeclaration[]; temperature?: number }) {
  return withRetry(() =>
    gemini().models.generateContent({
      model: opts.model,
      contents: opts.contents,
      config: {
        systemInstruction: opts.system,
        tools: [{ functionDeclarations: opts.tools }],
        temperature: opts.temperature ?? 0.2,
      },
    }),
  );
}
