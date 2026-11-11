/**
 * Backup AI provider: Amazon Nova on AWS Bedrock, through the Converse API.
 *
 * Gemini is the primary model for every AI step. When it is over quota, overloaded or slow,
 * the same call is answered by Nova instead, so the gate keeps working instead of routing
 * everything to a human. Receipts record which provider and model actually answered.
 *
 * Enabled when AWS credentials are present (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, or any
 * credential the AWS SDK finds) and BEDROCK_DISABLED is not set.
 */
import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message, type Tool } from "@aws-sdk/client-bedrock-runtime";
import type { Content, FunctionDeclaration, Part } from "@google/genai";
import { timed } from "../telemetry.ts";

export const BEDROCK_MODEL = process.env.BEDROCK_MODEL ?? "us.amazon.nova-pro-v1:0";
export const BEDROCK_FAST_MODEL = process.env.BEDROCK_FAST_MODEL ?? "us.amazon.nova-lite-v1:0";
const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
const TIMEOUT_MS = Number(process.env.BEDROCK_TIMEOUT_MS ?? 20000);

export function bedrockEnabled(): boolean {
  if (process.env.BEDROCK_DISABLED) return false;
  return Boolean((process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) || process.env.AWS_PROFILE || process.env.AWS_BEARER_TOKEN_BEDROCK);
}

let client: BedrockRuntimeClient | null = null;
const br = () => (client ??= new BedrockRuntimeClient({ region: REGION }));

/** Gemini schemas use upper-case type names ("OBJECT"); JSON Schema wants lower case. */
export function toJsonSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (k === "type" && typeof v === "string") out[k] = v.toLowerCase();
    else if (k === "propertyOrdering" || k === "nullable") continue;
    else out[k] = toJsonSchema(v);
  }
  return out;
}

async function converse(what: string, model: string, input: { system: string; messages: Message[]; tools?: Tool[]; force?: string; temperature: number }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await timed("bedrock", `${what} · ${model.replace(/^us\.amazon\./, "")}`, () =>
      br().send(
        new ConverseCommand({
          modelId: model,
          system: [{ text: input.system }],
          messages: input.messages,
          inferenceConfig: { temperature: input.temperature, maxTokens: 2048 },
          ...(input.tools ? { toolConfig: { tools: input.tools, ...(input.force ? { toolChoice: { tool: { name: input.force } } } : {}) } } : {}),
        }),
        { abortSignal: ctl.signal },
      ),
    );
  } finally {
    clearTimeout(t);
  }
}

const IMG: Record<string, "png" | "jpeg" | "webp" | "gif"> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" };

/** Structured output: Nova is forced to call one tool whose input schema is the answer's shape. */
export async function bedrockJson<T>(opts: { system: string; prompt: string; schema: object; temperature?: number; image?: { mime: string; data: string }; label?: string; fast?: boolean }): Promise<{ value: T; model: string }> {
  const model = opts.fast ? BEDROCK_FAST_MODEL : BEDROCK_MODEL;
  const content: ContentBlock[] = [];
  if (opts.image && IMG[opts.image.mime]) content.push({ image: { format: IMG[opts.image.mime], source: { bytes: Buffer.from(opts.image.data, "base64") } } });
  content.push({ text: opts.prompt });
  const res = await converse(opts.label ?? "json", model, {
    system: `${opts.system}\n\nAnswer only by calling the "answer" tool.`,
    messages: [{ role: "user", content }],
    tools: [{ toolSpec: { name: "answer", description: "Return the answer in exactly this shape.", inputSchema: { json: toJsonSchema(opts.schema) as never } } }],
    force: "answer",
    temperature: opts.temperature ?? 0,
  });
  const use = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  if (use?.input && typeof use.input === "object") return { value: use.input as T, model };
  const text = res.output?.message?.content?.map((c) => c.text ?? "").join("") ?? "";
  try {
    return { value: JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T, model };
  } catch {
    throw new Error(`Bedrock returned no structured answer: ${text.slice(0, 160)}`);
  }
}

/**
 * Agent turn with tools. Takes and returns Gemini's shapes so the shopping loop doesn't care
 * which provider answered; a conversation can switch providers mid-run.
 */
export async function bedrockTools(opts: { system: string; contents: Content[]; tools: FunctionDeclaration[]; temperature?: number }): Promise<{ candidates: { content: Content }[]; functionCalls: { id: string; name: string; args: Record<string, unknown> }[]; model: string }> {
  const messages = toMessages(opts.contents);
  const tools: Tool[] = opts.tools.map((f) => ({ toolSpec: { name: f.name!, description: f.description ?? f.name!, inputSchema: { json: toJsonSchema(f.parametersJsonSchema ?? f.parameters ?? { type: "object", properties: {} }) as never } } }));
  const res = await converse("agent turn", BEDROCK_MODEL, { system: opts.system, messages, tools, temperature: opts.temperature ?? 0.2 });
  const parts: Part[] = [];
  const functionCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  for (const c of res.output?.message?.content ?? []) {
    if (c.text) parts.push({ text: c.text });
    if (c.toolUse) {
      const call = { id: c.toolUse.toolUseId!, name: c.toolUse.name!, args: (c.toolUse.input ?? {}) as Record<string, unknown> };
      functionCalls.push(call);
      parts.push({ functionCall: call });
    }
  }
  return { candidates: [{ content: { role: "model", parts } }], functionCalls, model: BEDROCK_MODEL };
}

/** Gemini contents → Bedrock messages: roles mapped, tool calls paired with their results by id (or by order). */
export function toMessages(contents: Content[]): Message[] {
  const out: Message[] = [];
  const pending = new Map<string, string[]>(); // tool name → ids awaiting a result
  let n = 0;
  for (const c of contents) {
    const role = c.role === "model" ? "assistant" : "user";
    const blocks: ContentBlock[] = [];
    for (const p of c.parts ?? []) {
      if (p.text) blocks.push({ text: p.text });
      else if (p.functionCall) {
        const id = p.functionCall.id || `call_${++n}`;
        const name = p.functionCall.name ?? "tool";
        pending.set(name, [...(pending.get(name) ?? []), id]);
        blocks.push({ toolUse: { toolUseId: id, name, input: (p.functionCall.args ?? {}) as never } });
      } else if (p.functionResponse) {
        const name = p.functionResponse.name ?? "tool";
        const q = pending.get(name) ?? [];
        const id = p.functionResponse.id || q.shift() || `call_${++n}`;
        if (p.functionResponse.id) pending.set(name, q.filter((x) => x !== id));
        blocks.push({ toolResult: { toolUseId: id, content: [{ json: (p.functionResponse.response ?? {}) as never }] } });
      }
    }
    if (!blocks.length) continue;
    const last = out.at(-1);
    if (last && last.role === role) last.content!.push(...blocks);
    else out.push({ role, content: blocks });
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: [{ text: "(continue)" }] });
  return out;
}
