import { useEffect, useState, type ReactNode } from "react";
import type { Purchase } from "./api.ts";

// ── Scope: which purchases a view is about ───────────────────
export type Scope = "all" | "mine" | "arena" | "redteam";
export const SCOPES: { id: Scope; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "mine", label: "Your agent" },
  { id: "arena", label: "Arena" },
  { id: "redteam", label: "Red team" },
];
export function scopeOf(p: { intent: { mandateId: string } }): Exclude<Scope, "all"> {
  const m = p.intent.mandateId;
  return m.startsWith("md_arena_") ? "arena" : m.startsWith("md_rt_") ? "redteam" : "mine";
}
export const inScope = (scope: Scope) => (p: Purchase) => scope === "all" || scopeOf(p) === scope;

// ── State words and glyphs ──────────────────────────────────
export const STATE_WORD: Record<string, string> = {
  proposed: "Checking",
  blocked: "Blocked",
  held: "Needs you",
  denied: "Declined",
  authorized: "Held",
  awaiting_delivery: "Held",
  verifying: "Verifying",
  captured: "Captured",
  seller_paid: "Paid",
  voided: "Voided",
  refunded: "Refunded",
  failed: "PayPal error",
};

/** One glyph per money state, readable without color: filled = paid, outline = held, cross = stopped. */
export function Glyph({ state, size = 12 }: { state: string; size?: number }) {
  const s = size;
  const stopped = state === "blocked" || state === "voided" || state === "denied" || state === "failed";
  return (
    <svg width={s} height={s} viewBox="0 0 12 12" className={`glyph g-${state}`} aria-hidden>
      {state === "seller_paid" || state === "captured" ? (
        <rect x="1" y="1" width="10" height="10" fill="currentColor" />
      ) : stopped ? (
        <path d="M2 2 10 10M10 2 2 10" stroke="var(--red)" strokeWidth="2" />
      ) : state === "held" ? (
        <>
          <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" />
          <rect x="1.5" y="6" width="9" height="4.5" fill="currentColor" />
        </>
      ) : state === "refunded" ? (
        <path d="M10 6H2m3-3L2 6l3 3" stroke="currentColor" strokeWidth="1.6" fill="none" />
      ) : (
        <rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1.4" className="g-pulse" />
      )}
    </svg>
  );
}

export function StateTag({ state }: { state: string }) {
  return (
    <span className={`stag s-${state}`}>
      <Glyph state={state} />
      {STATE_WORD[state] ?? state}
    </span>
  );
}

// ── Panels ───────────────────────────────────────────────────
export function Pane({ title, hint, right, children, className = "", live, id }: { title: string; hint?: string; right?: ReactNode; children: ReactNode; className?: string; live?: boolean; id?: string }) {
  return (
    <section className={`pane ${className}`} aria-labelledby={id ? `${id}-t` : undefined}>
      <header className="pane-head">
        <div className="pane-title">
          {live && <i className="livedot" aria-hidden />}
          <h2 id={id ? `${id}-t` : undefined}>{title}</h2>
          {hint && <span className="pane-hint">{hint}</span>}
        </div>
        {right && <div className="pane-right">{right}</div>}
      </header>
      <div className="pane-body">{children}</div>
    </section>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

// ── Time ─────────────────────────────────────────────────────
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function rel(iso: string, now = Date.now()) {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 5) return "now";
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function fmtMs(ms: number) {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ── Icons (1.5px stroke, 16px) ───────────────────────────────
const P: Record<string, ReactNode> = {
  console: <><rect x="2" y="2.5" width="12" height="11" /><path d="M2 6h12M5 9l1.5 1.5L5 12" /></>,
  arena: <><path d="M3 13 13 3M13 13 3 3" /><path d="M2 11l3 3M11 2l3 3" /></>,
  agent: <><circle cx="8" cy="6" r="3" /><path d="M2.5 14c.8-2.8 3-4 5.5-4s4.7 1.2 5.5 4" /></>,
  evidence: <><path d="M2 14V2M2 14h12" /><path d="M5 11V8M8 11V5M11 11V7" /></>,
  mandates: <><path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3M6 8h5M6 11h3" /></>,
  how: <><circle cx="8" cy="8" r="6" /><path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.5M8 11.6v.4" /></>,
  search: <><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></>,
  sun: <><circle cx="8" cy="8" r="3" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" /></>,
  moon: <path d="M13 9.5A5.5 5.5 0 1 1 6.5 3a4.5 4.5 0 0 0 6.5 6.5z" />,
  play: <path d="M5 3v10l8-5z" />,
  replay: <><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2 2v3h3" /></>,
  copy: <><rect x="5" y="5" width="9" height="9" /><path d="M11 5V2H2v9h3" /></>,
  close: <path d="M3 3l10 10M13 3 3 13" />,
  arrow: <path d="M3 8h10m-4-4 4 4-4 4" />,
  pause: <path d="M5 3v10M11 3v10" />,
};
export function Icon({ name, size = 16 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" aria-hidden className="icon">
      {P[name]}
    </svg>
  );
}
