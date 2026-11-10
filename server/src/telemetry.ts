/**
 * Telemetry: every call Chaperone makes to PayPal, Gemini and Channel3, and every lifecycle step,
 * recorded as it happens. The console's live log, provider health and latency charts read from here,
 * so what you see is what the backend actually did.
 */
import { EventEmitter } from "node:events";

export type Provider = "paypal" | "gemini" | "channel3" | "gate" | "lifecycle" | "agent";

export interface LogLine {
  seq: number;
  at: string;
  provider: Provider;
  op: string;
  ms?: number;
  ok: boolean;
  note?: string;
  /** Purchase this line belongs to, when known. */
  ref?: string;
}

const RING = 600;
let seq = 0;
const lines: LogLine[] = [];
export const telemetry = new EventEmitter();
telemetry.setMaxListeners(200);
const startedAt = Date.now();

export function log(l: Omit<LogLine, "seq" | "at">): LogLine {
  const line: LogLine = { ...l, seq: ++seq, at: new Date().toISOString(), ms: l.ms == null ? undefined : Math.round(l.ms) };
  lines.push(line);
  if (lines.length > RING) lines.shift();
  telemetry.emit("line", line);
  return line;
}

/** Time an async call and log it, success or failure. */
export async function timed<T>(provider: Provider, op: string, fn: () => Promise<T>, note?: (r: T) => string | undefined, ref?: string): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    log({ provider, op, ms: performance.now() - t0, ok: true, note: note?.(r), ref });
    return r;
  } catch (e) {
    log({ provider, op, ms: performance.now() - t0, ok: false, note: String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160), ref });
    throw e;
  }
}

function pct(xs: number[], p: number) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

export function snapshot() {
  const by = (p: Provider) => lines.filter((l) => l.provider === p && l.ms != null);
  const stats = (p: Provider) => {
    const xs = by(p);
    const ms = xs.map((l) => l.ms!);
    return { calls: xs.length, errors: xs.filter((l) => !l.ok).length, p50: pct(ms, 50), p95: pct(ms, 95), recent: xs.slice(-40).map((l) => ({ ms: l.ms!, ok: l.ok })) };
  };
  return { startedAt: new Date(startedAt).toISOString(), seq, providers: { paypal: stats("paypal"), gemini: stats("gemini"), channel3: stats("channel3") }, log: lines.slice(-200) };
}

/** Load lines saved with the store (so a restarted instance keeps its recent history). */
export function restoreLines(saved: LogLine[]) {
  if (!Array.isArray(saved) || lines.length) return;
  for (const l of saved.slice(-RING)) lines.push(l);
  seq = Math.max(seq, ...lines.map((l) => l.seq), 0);
}

export function recentLines(): LogLine[] {
  return lines.slice();
}

export function resetTelemetry() {
  lines.length = 0;
}
