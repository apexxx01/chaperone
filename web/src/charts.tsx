import { useMemo, useState } from "react";
import { usd, type LogLine, type Purchase } from "./api.ts";
import { fmtMs, median, rel } from "./ui.tsx";

// ── Trace waterfall: how one purchase spent its time, from the real per-check timings ──
export function Waterfall({ p }: { p: Purchase }) {
  const [hover, setHover] = useState<number | null>(null);
  const ms = (rule: string) => p.verdict.checks.find((c) => c.rule === rule)?.ms ?? 0;
  const market = Math.max(0, ...p.verdict.checks.filter((c) => c.stage === "market").map((c) => c.ms ?? 0));
  const reader = ms("auditor.quarantined_reader");
  const auditor = ms("auditor.mandate_alignment");
  const gate = Math.max(p.verdict.ms, market + Math.max(reader, auditor));
  const auth = p.timeline.find((e) => e.kind === "authorized");
  const spans = [
    { label: "Channel3 market lookup", start: 0, dur: market, kind: "io" },
    { label: "Policy, plain code", start: market, dur: 0.6, kind: "code" },
    { label: "Injection scanner", start: market, dur: 0.4, kind: "code" },
    { label: "Quarantined reader (Gemini)", start: market, dur: reader, kind: "ai", off: !p.verdict.checks.some((c) => c.rule === "auditor.quarantined_reader") },
    { label: "Privileged auditor (Gemini)", start: market, dur: auditor, kind: "ai", off: !p.verdict.checks.some((c) => c.rule === "auditor.mandate_alignment") },
    { label: `Decision: ${p.verdict.decision}`, start: gate, dur: 0, kind: p.verdict.decision === "block" ? "stop" : "mark" },
    ...(auth ? [{ label: "PayPal authorize (hold)", start: gate, dur: auth.ms ?? 0, kind: "paypal" }] : []),
  ].filter((s) => !("off" in s && s.off));
  const total = Math.max(1, ...spans.map((s) => s.start + s.dur));
  const W = 100;
  return (
    <div className="wf" onMouseLeave={() => setHover(null)}>
      <div className="wf-axis num">
        <span>0</span>
        <span>{fmtMs(total / 2)}</span>
        <span>{fmtMs(total)}</span>
      </div>
      {spans.map((s, i) => (
        <div key={i} className={`wf-row${hover === i ? " on" : ""}`} onMouseEnter={() => setHover(i)}>
          <span className="wf-label">{s.label}</span>
          <span className="wf-track">
            {s.kind === "mark" || s.kind === "stop" ? (
              <i className={`wf-mark ${s.kind}`} style={{ left: `${(s.start / total) * W}%` }} />
            ) : (
              <i className={`wf-bar k-${s.kind}`} style={{ left: `${(s.start / total) * W}%`, width: `max(2px, ${(s.dur / total) * W}%)` }} />
            )}
          </span>
          <span className="wf-ms num">{s.kind === "mark" || s.kind === "stop" ? fmtMs(s.start) : fmtMs(s.dur)}</span>
        </div>
      ))}
      <p className="readout">
        {hover != null ? `${spans[hover]!.label}: starts at ${fmtMs(spans[hover]!.start)}, takes ${fmtMs(spans[hover]!.dur)}.` : `Gate ${fmtMs(p.verdict.ms)}. The two Gemini calls run side by side; everything else is sub-millisecond code.`}
      </p>
    </div>
  );
}

// ── Money flow: where every proposed dollar ended up ─────────
interface Flow {
  from: string;
  to: string;
  value: number;
  bad?: boolean;
}

export function moneyFlows(ps: Purchase[]) {
  const sum = (f: (p: Purchase) => boolean, v: (p: Purchase) => number = (p) => p.amount.value) => ps.filter(f).reduce((a, p) => a + v(p), 0);
  const isAuth = (p: Purchase) => !["blocked", "held", "denied", "failed", "proposed"].includes(p.state);
  const captured = (p: Purchase) => p.paypal.capturedAmount ?? p.amount.value;
  const flows: Flow[] = [
    { from: "Proposed", to: "Blocked before PayPal", value: sum((p) => p.state === "blocked"), bad: true },
    { from: "Proposed", to: "Waiting for you", value: sum((p) => p.state === "held") },
    { from: "Proposed", to: "Declined by you", value: sum((p) => p.state === "denied"), bad: true },
    { from: "Proposed", to: "PayPal declined", value: sum((p) => p.state === "failed"), bad: true },
    { from: "Proposed", to: "Authorized (held)", value: sum(isAuth) },
    { from: "Authorized (held)", to: "Still held", value: sum((p) => ["authorized", "awaiting_delivery", "verifying"].includes(p.state)) },
    { from: "Authorized (held)", to: "Paid to sellers", value: sum((p) => p.state === "seller_paid" || p.state === "captured", captured) },
    { from: "Authorized (held)", to: "Released (short ship)", value: sum((p) => p.state === "seller_paid" && captured(p) < p.amount.value, (p) => p.amount.value - captured(p)) },
    { from: "Authorized (held)", to: "Voided at delivery", value: sum((p) => p.state === "voided"), bad: true },
    { from: "Authorized (held)", to: "Refunded", value: sum((p) => p.state === "refunded"), bad: true },
  ].filter((f) => f.value > 0.004);
  return { flows, total: sum(() => true) };
}

export function MoneyFlow({ purchases }: { purchases: Purchase[] }) {
  const { flows, total } = useMemo(() => moneyFlows(purchases), [purchases]);
  const [hover, setHover] = useState<string | null>(null);
  if (total <= 0) return <p className="readout">No money has been proposed in this scope yet.</p>;
  const W = 600, Hh = 200, BAR = 8, GAP = 10;
  const cols: Record<string, number> = { Proposed: 0 };
  for (const f of flows) cols[f.to] = f.from === "Proposed" ? 1 : 2;
  const cx = [0, 296, 592];
  const usable = Hh - 20;
  const k = (usable - GAP * 5) / total;
  // stack nodes per column
  const nodes = new Map<string, { col: number; y: number; h: number; value: number; bad?: boolean }>();
  const place = (col: number, names: string[]) => {
    let y = 4;
    for (const n of names) {
      const value = n === "Proposed" ? total : flows.filter((f) => f.to === n).reduce((a, f) => a + f.value, 0);
      const h = Math.max(2, value * k);
      nodes.set(n, { col, y, h, value, bad: flows.find((f) => f.to === n)?.bad });
      y += h + GAP;
    }
  };
  place(0, ["Proposed"]);
  place(1, flows.filter((f) => f.from === "Proposed").map((f) => f.to));
  place(2, flows.filter((f) => f.from !== "Proposed").map((f) => f.to));
  const outY = new Map<string, number>();
  const ribbons = flows.map((f) => {
    const a = nodes.get(f.from)!, b = nodes.get(f.to)!;
    const h = Math.max(1, f.value * k);
    const y0 = outY.get(f.from) ?? a.y;
    outY.set(f.from, y0 + h);
    const y1 = b.y;
    const x0 = cx[a.col]! + BAR, x1 = cx[b.col]!;
    const m = (x0 + x1) / 2;
    return { f, d: `M${x0},${y0} C${m},${y0} ${m},${y1} ${x1},${y1} L${x1},${y1 + h} C${m},${y1 + h} ${m},${y0 + h} ${x0},${y0 + h} Z` };
  });
  const hv = hover ? flows.find((f) => f.to === hover) : null;
  return (
    <div className="mflow" onMouseLeave={() => setHover(null)}>
      <div className="mf-head"><b className="num">{usd(total)}</b><span className="faint">proposed by agents</span></div>
      <svg viewBox={`0 0 ${W} ${Hh}`} className="flow-svg" role="img" aria-label={`Money flow: ${flows.map((f) => `${f.to} ${usd(f.value)}`).join(", ")}.`}>
        {ribbons.map((r) => (
          <path key={r.f.to} d={r.d} className={`ribbon${r.f.bad ? " bad" : ""}${hover && hover !== r.f.to ? " dim" : ""}`} onMouseEnter={() => setHover(r.f.to)} />
        ))}
        {[...nodes.entries()].map(([name, n]) => (
          <g key={name} onMouseEnter={() => name !== "Proposed" && setHover(name)}>
            <title>{`${name}: ${usd(n.value)}`}</title>
            <rect x={cx[n.col]} y={n.y} width={BAR} height={n.h} className={`flow-bar${n.bad ? " bad" : ""}`} />
          </g>
        ))}
      </svg>
      <ul className="flow-list">
        {flows.map((f) => (
          <li key={f.to} className={`${f.bad ? "bad" : ""}${hover === f.to ? " on" : ""}`} onMouseEnter={() => setHover(f.to)}>
            <i />
            <span>{f.to}</span>
            <span className="fl-bar"><b style={{ width: `${Math.max(1, (f.value / total) * 100)}%` }} /></span>
            <span className="num">{((f.value / total) * 100).toFixed(1)}%</span>
            <span className="num">{usd(f.value)}</span>
          </li>
        ))}
      </ul>
      <p className="readout">{hv ? `${hv.to}: ${usd(hv.value)}, ${((hv.value / total) * 100).toFixed(1)}% of everything agents proposed.` : "Hover a band or a row. Red is money that was stopped before it reached a seller."}</p>
    </div>
  );
}

// ── Provider health, from the backend's own call log ─────────
const PROVIDERS = [
  { id: "paypal", name: "PayPal" },
  { id: "gemini", name: "Gemini" },
  { id: "bedrock", name: "Bedrock (backup AI)" },
  { id: "channel3", name: "Channel3" },
] as const;

export function providerStats(lines: LogLine[]) {
  return PROVIDERS.map((p) => {
    const xs = lines.filter((l) => l.provider === p.id && l.ms != null);
    const ms = xs.map((l) => l.ms!);
    const s = [...ms].sort((a, b) => a - b);
    return {
      ...p,
      calls: xs.length,
      errors: xs.filter((l) => !l.ok).length,
      p50: median(ms),
      p95: s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! : 0,
      recent: xs.slice(-36),
      last: xs.at(-1),
    };
  });
}

export function Health({ lines, now }: { lines: LogLine[]; now: number }) {
  const st = providerStats(lines).filter((p) => p.id !== "bedrock" || p.calls > 0);
  return (
    <div className="health">
      {st.map((p) => {
        const max = Math.max(1, ...p.recent.map((l) => l.ms!));
        const errPct = p.calls ? (p.errors / p.calls) * 100 : 0;
        return (
          <div key={p.id} className="h-row">
            <div className="h-head">
              <b>{p.name}</b>
              <span className="num faint">{p.calls ? `${p.calls} calls · last ${rel(p.last!.at, now)}` : "no calls yet"}</span>
            </div>
            <div className="h-bars" role="img" aria-label={`${p.name}: median ${fmtMs(p.p50)}, slowest 5% ${fmtMs(p.p95)}, ${errPct.toFixed(0)}% errors over ${p.calls} calls`}>
              {p.recent.map((l) => (
                <i key={l.seq} className={l.ok ? "" : "err"} style={{ height: `${Math.max(6, (l.ms! / max) * 100)}%` }} title={`${l.op}: ${fmtMs(l.ms!)}${l.ok ? "" : " · failed"}`} />
              ))}
            </div>
            <div className="h-nums num">
              <span><em>p50</em> {fmtMs(p.p50)}</span>
              <span><em>p95</em> {fmtMs(p.p95)}</span>
              <span className={errPct > 0 ? "red" : ""}><em>err</em> {errPct.toFixed(0)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Tiny trend line under a KPI ───────────────────────────────
export function Spark({ values, bad }: { values: number[]; bad?: boolean }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 100 24" aria-hidden />;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${22 - (v / max) * 20}`);
  return (
    <svg className={`spark${bad ? " bad" : ""}`} viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden>
      <polyline points={`0,24 ${pts.join(" ")} 100,24`} className="spark-fill" />
      <polyline points={pts.join(" ")} className="spark-line" />
    </svg>
  );
}

/** Cumulative series over time for a KPI. */
export function cumulative(ps: Purchase[], value: (p: Purchase) => number, buckets = 24): number[] {
  if (!ps.length) return [];
  const ts = ps.map((p) => new Date(p.intent.createdAt).getTime());
  const t0 = Math.min(...ts), t1 = Math.max(...ts, t0 + 1);
  const out = Array(buckets).fill(0) as number[];
  for (const p of ps) {
    const i = Math.min(buckets - 1, Math.floor(((new Date(p.intent.createdAt).getTime() - t0) / (t1 - t0)) * buckets));
    out[i]! += value(p);
  }
  for (let i = 1; i < buckets; i++) out[i]! += out[i - 1]!;
  return out;
}
