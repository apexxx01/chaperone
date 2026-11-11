import { useEffect, useRef, useState } from "react";
import type { Mandate, Purchase } from "../../server/src/domain/types.ts";
import type { AgentRun } from "../../server/src/store/store.ts";
import type { CaseResult, RedteamReport } from "../../server/src/redteam/runner.ts";
import type { Duel } from "../../server/src/arena/duel.ts";
import type { LogLine } from "../../server/src/telemetry.ts";
export type { LogLine };
export type { Duel };

export type { Mandate, Purchase, AgentRun, CaseResult, RedteamReport };
export type { Check, PurchaseState } from "../../server/src/domain/types.ts";

export interface Capabilities {
  mode: "live" | "offline";
  paypal: boolean;
  gemini: boolean;
  bedrock?: boolean;
  channel3: boolean;
  paypalEnv: string;
  paymentMode: string;
  paypalClient: "sandbox" | "simulated";
}

export interface AppState {
  capabilities: Capabilities;
  mandates: Mandate[];
  purchases: Purchase[];
  runs: AgentRun[];
  redteam: RedteamReport | null;
  duels: Duel[];
  arena: { stats: { duels: number; aloneRobbed: number; aloneLost: number; gateBypassed: number; capturedThroughChaperone: number; custom: number }; attacks: { id: string; name: string; technique: string }[] };
  attacks: { id: string; name: string; technique: string; task: string; goal: string }[];
  tasks: { id: string; instruction: string }[];
  sellers: number;
}

export class ApiError extends Error {}

export async function api<T = any>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  // The server restarted and forgot this tab's session: get a fresh one and try once more.
  if (res.status === 401 && json.code === "human_session_required" && !retried) {
    await fetch("/api/session").catch(() => {});
    return api<T>(method, path, body, true);
  }
  if (!res.ok) throw new ApiError(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

/** Full state on load, then live patches over SSE. Reconnects with backoff and resyncs on reconnect. */
export function useLive() {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveCases, setLiveCases] = useState<CaseResult[]>([]);
  const [redteamRunning, setRedteamRunning] = useState(false);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const retry = useRef(0);

  const refresh = async () => {
    try {
      const [st, tel] = await Promise.all([api<AppState>("GET", "/api/state"), api<{ log: LogLine[]; startedAt: string }>("GET", "/api/telemetry").catch(() => null)]);
      setState(st);
      if (tel) {
        setStartedAt(tel.startedAt);
        setLines((cur) => mergeLines(tel.log, cur));
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: number | undefined;
    let closed = false;
    const connect = () => {
      es = new EventSource("/api/events");
      es.addEventListener("hello", () => {
        retry.current = 0;
        setConnected(true);
        void refresh();
      });
      const patch = (fn: (s: AppState, d: any) => AppState) => (ev: MessageEvent) => {
        const d = JSON.parse(ev.data);
        setState((s) => (s ? fn(s, d) : s));
      };
      es.addEventListener("purchase", patch((s, d) => ({ ...s, purchases: upsert(s.purchases, d.payload, (p) => p.intent.createdAt) })));
      es.addEventListener("mandate", patch((s, d) => ({ ...s, mandates: upsert(s.mandates, d.payload, (m) => m.createdAt) })));
      es.addEventListener("agent", patch((s, d) => ({ ...s, runs: upsert(s.runs, d.payload, (r) => r.startedAt) })));
      es.addEventListener("duel", (ev: MessageEvent) => {
        const d = JSON.parse(ev.data).payload as Duel;
        setState((s) => (s ? { ...s, duels: upsert(s.duels, d, (x) => x.at) } : s));
        if (d.status !== "running") void refresh();
      });
      es.addEventListener("log", (ev: MessageEvent) => {
        const l = JSON.parse(ev.data) as LogLine;
        setLines((cur) => mergeLines(cur, [l]));
      });
      es.addEventListener("reset", () => void refresh());
      es.addEventListener("redteam", (ev: MessageEvent) => {
        const d = JSON.parse(ev.data).payload;
        if (d.case) {
          setRedteamRunning(true);
          setLiveCases((cs) => [...cs.filter((c) => c.id !== d.case.id), d.case]);
        }
        if (d.report) {
          setRedteamRunning(false);
          setLiveCases([]);
          setState((s) => (s ? { ...s, redteam: d.report } : s));
        }
        if (d.error) {
          setRedteamRunning(false);
          setError(d.error);
        }
      });
      es.onerror = () => {
        setConnected(false);
        es?.close();
        if (closed) return;
        const wait = Math.min(15000, 500 * 2 ** retry.current++);
        timer = window.setTimeout(connect, wait);
      };
    };
    void refresh();
    connect();
    return () => {
      closed = true;
      es?.close();
      clearTimeout(timer);
    };
  }, []);

  return { state, connected, error, refresh, liveCases, redteamRunning, setRedteamRunning, setLiveCases, lines, startedAt };
}

function mergeLines(a: LogLine[], b: LogLine[]): LogLine[] {
  const m = new Map<number, LogLine>();
  for (const l of a) m.set(l.seq, l);
  for (const l of b) m.set(l.seq, l);
  return [...m.values()].sort((x, y) => x.seq - y.seq).slice(-600);
}

function upsert<T extends { id: string }>(list: T[], item: T, sortKey: (x: T) => string): T[] {
  const next = list.filter((x) => x.id !== item.id);
  next.push(item);
  return next.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
}

export const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
};
export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
