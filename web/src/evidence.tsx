import { useEffect, useMemo, useRef, useState } from "react";
import { usd, type AppState, type Purchase } from "./api.ts";

const STAGES = ["mandate", "policy", "market", "scanner", "auditor", "delivery"] as const;
const STAGE_NAME: Record<string, string> = { mandate: "Mandate", policy: "Policy", market: "Market price", scanner: "Scanner", auditor: "AI auditor", human: "You", delivery: "Delivery" };

// ── Small pieces ─────────────────────────────────────────────
export function useCountUp(target: number, ms = 700): number {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setV(target);
    const a = from.current, t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(a + (target - a) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function Num({ value, money, digits = 0 }: { value: number; money?: boolean; digits?: number }) {
  const v = useCountUp(value);
  return <>{money ? usd(v) : v.toFixed(digits)}</>;
}

/** Live tape of real purchase events. Pauses on hover; static with reduced motion. */
export function Ticker({ purchases }: { purchases: Purchase[] }) {
  const items = useMemo(() => {
    const ev = purchases.flatMap((p) =>
      p.timeline
        .filter((e) => ["gate", "authorized", "captured", "voided", "payout", "refunded", "waiting"].includes(e.kind))
        .map((e) => ({ at: e.at, kind: e.kind, text: e.kind === "gate" ? p.verdict.headline : e.label, bad: e.kind === "gate" && p.verdict.decision === "block" })),
    );
    return ev.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 24);
  }, [purchases]);
  if (!items.length) return null;
  const row = items.map((e, i) => (
    <span key={i} className={`tick-item${e.bad ? " bad" : ""}`}>
      <i>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</i>
      {e.text}
    </span>
  ));
  return (
    <div className="ticker" aria-label="Latest purchase events">
      <div className="ticker-run">{row}{row}</div>
    </div>
  );
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function Panel({ title, note, children, table }: { title: string; note?: string; children: React.ReactNode; table?: { head: string[]; rows: (string | number)[][] } }) {
  return (
    <section className="cell">
      <header>
        <h3>{title}</h3>
        {note && <p>{note}</p>}
      </header>
      {children}
      {table && (
        <details className="astable">
          <summary>Show as table</summary>
          <table className="table"><thead><tr>{table.head.map((h) => <th key={h}>{h}</th>)}</tr></thead><tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="num">{c}</td>)}</tr>)}</tbody></table>
        </details>
      )}
    </section>
  );
}

/** Horizontal bars with the value at the tip and a hover readout. One series, so no legend. */
function Bars({ rows, unit, format = (n: number) => String(n), accent }: { rows: { label: string; value: number; hint?: string }[]; unit: string; format?: (n: number) => string; accent?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bars" onMouseLeave={() => setHover(null)}>
      {rows.map((r, i) => (
        <div key={r.label} className={`bar-row${hover === i ? " on" : ""}`} onMouseEnter={() => setHover(i)} tabIndex={0} onFocus={() => setHover(i)}>
          <span className="bar-label">{r.label}</span>
          <span className="bar-track"><span className={`bar-fill${accent ? " accent" : ""}`} style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="bar-val num">{format(r.value)}</span>
        </div>
      ))}
      <p className="readout">{hover != null ? `${rows[hover]!.label}: ${format(rows[hover]!.value)} ${unit}${rows[hover]!.hint ? `. ${rows[hover]!.hint}` : ""}` : `Hover a bar for detail. Values in ${unit}.`}</p>
    </div>
  );
}

// ── Money over time ──────────────────────────────────────────
function moneySeries(purchases: Purchase[]) {
  type Ev = { t: number; held: number; paid: number; stopped: number };
  const evs: Ev[] = [];
  for (const p of purchases) {
    const a = p.amount.value;
    for (const e of p.timeline) {
      const t = new Date(e.at).getTime();
      if (e.kind === "gate" && p.verdict.decision === "block") evs.push({ t, held: 0, paid: 0, stopped: a });
      if (e.kind === "authorized") evs.push({ t, held: a, paid: 0, stopped: 0 });
      if (e.kind === "captured") evs.push({ t, held: -a, paid: p.paypal.capturedAmount ?? a, stopped: 0 });
      if (e.kind === "voided") evs.push({ t, held: -a, paid: 0, stopped: a });
    }
  }
  evs.sort((x, y) => x.t - y.t);
  let held = 0, paid = 0, stopped = 0;
  return evs.map((e) => ({ t: e.t, held: (held += e.held), paid: (paid += e.paid), stopped: (stopped += e.stopped) }));
}

function MoneyChart({ purchases }: { purchases: Purchase[] }) {
  const pts = useMemo(() => moneySeries(purchases), [purchases]);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = 220, L = 46, R = 132, T = 12, B = 26;
  if (pts.length < 2) return <p className="readout">Run a few purchases or duels and this fills in.</p>;
  const t0 = pts[0]!.t, t1 = pts.at(-1)!.t || t0 + 1;
  const max = Math.max(1, ...pts.map((p) => Math.max(p.held, p.paid, p.stopped)));
  const nice = niceMax(max);
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - v / nice) * (H - T - B);
  const path = (k: "held" | "paid" | "stopped") => pts.map((p, i) => `${i ? "H" : "M"}${x(p.t).toFixed(1)}${i ? "" : `,${y(p[k]).toFixed(1)}`}${i ? `V${y(p[k]).toFixed(1)}` : ""}`).join("");
  const last = pts.at(-1)!;
  const series = [
    { k: "stopped" as const, name: "Stopped", cls: "s-stopped" },
    { k: "paid" as const, name: "Paid to sellers", cls: "s-paid" },
    { k: "held" as const, name: "Held now", cls: "s-held" },
  ];
  // spread end labels so they never collide
  const ends = series.map((s) => ({ ...s, y: y(last[s.k]) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i]!.y - ends[i - 1]!.y < 15) ends[i]!.y = ends[i - 1]!.y + 15;
  const h = hover != null ? pts[hover]! : null;
  return (
    <>
      <div className="legend">{series.map((s) => <span key={s.k}><i className={s.cls} />{s.name}</span>)}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={`Cumulative sandbox dollars: ${usd(last.stopped)} stopped, ${usd(last.paid)} paid to sellers after verified delivery, ${usd(last.held)} held now.`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          let best = 0;
          pts.forEach((p, i) => { if (Math.abs(x(p.t) - px) < Math.abs(x(pts[best]!.t) - px)) best = i; });
          setHover(best);
        }}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(nice * f)} y2={y(nice * f)} className="grid" />
            <text x={L - 6} y={y(nice * f) + 4} textAnchor="end" className="axis">{usd(nice * f).replace(".00", "")}</text>
          </g>
        ))}
        {series.map((s) => <path key={s.k} d={path(s.k)} className={`line ${s.cls}`} />)}
        {ends.map((s) => <text key={s.k} x={W - R + 8} y={s.y + 4} className="endlabel">{s.name.split(" ")[0]} {`$${Math.round(last[s.k]).toLocaleString("en-US")}`}</text>)}
        {h && <line x1={x(h.t)} x2={x(h.t)} y1={T} y2={H - B} className="cross" />}
        <text x={L} y={H - 6} className="axis">{new Date(t0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="axis">{new Date(t1).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</text>
      </svg>
      <p className="readout">{h ? `${new Date(h.t).toLocaleTimeString()}: ${usd(h.stopped)} stopped, ${usd(h.paid)} paid, ${usd(h.held)} held` : "Hover the chart to read any moment."}</p>
    </>
  );
}

function niceMax(v: number) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

// ── Layer matrix (red team) ──────────────────────────────────
function LayerMatrix({ s }: { s: AppState }) {
  const cases = (s.redteam?.cases ?? []).filter((c) => c.kind === "attack");
  const [hover, setHover] = useState<string | null>(null);
  if (!cases.length) return <p className="readout">Run the red team below to fill this in.</p>;
  const avg = cases.reduce((a, c) => a + (c.protected.layers?.length ?? 0), 0) / cases.length;
  const multi = cases.filter((c) => (c.protected.layers?.length ?? 0) >= 2).length;
  return (
    <>
      <p className="bignote"><b className="num">{avg.toFixed(1)}</b> layers stopped each attack on average. {multi} of {cases.length} were caught by two or more independent layers.</p>
      <div className="matrix" role="table" aria-label="Which layers caught which attack" style={{ gridTemplateColumns: `minmax(120px, 1.6fr) repeat(${STAGES.length}, minmax(0, 1fr))` }}>
        <span />
        {STAGES.map((st) => <span key={st} className="mx-head">{STAGE_NAME[st]}</span>)}
        {cases.map((c) => (
          <Row key={c.id} label={`${c.id} ${c.name}`} cells={STAGES.map((st) => c.protected.layers?.includes(st) ?? false)} onHover={(st) => setHover(st ? `${c.id} ${c.name}: ${st.hit ? "caught" : "not flagged"} by ${STAGE_NAME[st.stage]}. ${c.technique}` : null)} />
        ))}
      </div>
      <p className="readout">{hover ?? "Filled square: that layer failed the purchase by itself. Hover any square."}</p>
    </>
  );
}

function Row({ label, cells, onHover }: { label: string; cells: boolean[]; onHover: (c: { stage: string; hit: boolean } | null) => void }) {
  return (
    <>
      <span className="mx-label">{label}</span>
      {cells.map((hit, i) => <span key={i} className={`mx-cell${hit ? " hit" : ""}`} onMouseEnter={() => onHover({ stage: STAGES[i]!, hit })} onMouseLeave={() => onHover(null)} aria-label={hit ? "caught" : "not flagged"} />)}
    </>
  );
}

// ── The page ─────────────────────────────────────────────────
export function EvidenceView({ s, children }: { s: AppState; children?: React.ReactNode }) {
  const ps = s.purchases;
  const catches = STAGES.map((st) => ({ label: STAGE_NAME[st]!, value: ps.filter((p) => [...p.verdict.checks, ...(p.deliveryVerdict?.checks ?? [])].some((c) => c.stage === st && c.outcome === "fail")).length }));
  const latency = ["policy", "market", "auditor"].map((st) => {
    const rules = st === "auditor" ? ["auditor.quarantined_reader", "auditor.mandate_alignment"] : null;
    if (rules) return rules.map((r) => ({ label: r === "auditor.quarantined_reader" ? "Quarantined reader" : "Privileged auditor", value: Math.round(median(ps.flatMap((p) => p.verdict.checks.filter((c) => c.rule === r && (c.ms ?? 0) > 0).map((c) => c.ms!)))) }));
    return [{ label: STAGE_NAME[st]!, value: Math.round(median(ps.flatMap((p) => p.verdict.checks.filter((c) => c.stage === st && c.ms != null).map((c) => c.ms!)))) }];
  }).flat();
  latency.push({ label: "Whole gate", value: Math.round(median(ps.map((p) => p.verdict.ms))) });
  const auth = ps.flatMap((p) => p.timeline.filter((e) => e.kind === "authorized" && e.ms).map((e) => e.ms!));
  if (auth.length) latency.push({ label: "PayPal authorize", value: Math.round(median(auth)) });

  const byAttack = new Map<string, { name: string; runs: number; fooled: number }>();
  for (const d of s.duels.filter((d) => d.status === "done")) {
    const k = d.attack.custom ? "Custom" : d.attack.id;
    const e = byAttack.get(k) ?? { name: d.attack.custom ? "Custom attacks" : `${d.attack.id} ${d.attack.name}`, runs: 0, fooled: 0 };
    e.runs += 2;
    e.fooled += (d.alone.fooled ? 1 : 0) + (d.guarded.fooled ? 1 : 0);
    byAttack.set(k, e);
  }
  const hijack = [...byAttack.values()].sort((a, b) => b.fooled / b.runs - a.fooled / a.runs).map((e) => ({ label: e.name, value: Math.round((e.fooled / e.runs) * 100), hint: `${e.fooled} of ${e.runs} agent runs fell for it. Small sample` }));

  const blocked = ps.filter((p) => p.state === "blocked").length;
  const st = s.arena.stats;
  return (
    <>
      <h1 className="headline">The receipts.</h1>
      <p className="lede">Everything here is computed from real runs in this deployment: every purchase the agent proposed, every check, every PayPal call. Nothing on this page is typed in by hand.</p>

      <div className="score num">
        <div><b><Num value={ps.length} /></b><span>purchases proposed by agents</span></div>
        <div><b><Num value={blocked} /></b><span>blocked before PayPal was called</span></div>
        <div><b><Num value={ps.reduce((a, p) => a + p.verdict.checks.length, 0)} /></b><span>individual checks run</span></div>
        <div className="bad"><b><Num value={st.aloneLost} money /></b><span>captured from unprotected agents</span></div>
        <div><b><Num value={st.capturedThroughChaperone} money /></b><span>paid to attackers through Chaperone</span></div>
      </div>

      <div className="grid-cells">
        <Panel title="Where the money went" note="Cumulative sandbox dollars, by what happened to them.">
          <MoneyChart purchases={ps} />
        </Panel>
        <Panel title="Which layer stops purchases" note="Purchases failed by each layer. One purchase can be failed by several." table={{ head: ["Layer", "Purchases failed"], rows: catches.map((c) => [c.label, c.value]) }}>
          <Bars rows={catches} unit="purchases" />
        </Panel>
        <Panel title="How long the gate takes" note="Median milliseconds per step, measured on these runs." table={{ head: ["Step", "Median ms"], rows: latency.map((c) => [c.label, c.value]) }}>
          <Bars rows={latency} unit="ms" format={(n) => `${n.toLocaleString()} ms`} />
        </Panel>
        <Panel title="How often the real agent is fooled" note="Share of live Gemini runs in the Arena that fell for each attack." table={hijack.length ? { head: ["Attack", "% fooled"], rows: hijack.map((c) => [c.label, c.value]) } : undefined}>
          {hijack.length ? <Bars rows={hijack} unit="% of runs" format={(n) => `${n}%`} accent /> : <p className="readout">Run duels in the Arena and this fills in.</p>}
        </Panel>
        <section className="cell wide">
          <header><h3>Defense in depth</h3><p>Red team, full-compromise mode: the agent is assumed fooled. Each row is an attack, each column a layer.</p></header>
          <LayerMatrix s={s} />
        </section>
      </div>
      {children}
    </>
  );
}
