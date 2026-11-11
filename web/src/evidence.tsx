import { useEffect, useMemo, useRef, useState } from "react";
import { usd, type AppState, type Purchase } from "./api.ts";
import { MoneyFlow } from "./charts.tsx";

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
// The quarantined reader sees only the page; the auditor also sees what the other layers found, so it is
// not independent of them. It counts as an independent catch only when it was the sole layer to fail a purchase.
const MX = ["mandate", "policy", "market", "scanner", "reader", "auditor", "delivery"] as const;
const MX_NAME: Record<string, string> = { mandate: "Mandate", policy: "Policy", market: "Market", scanner: "Scanner", reader: "Reader", auditor: "Auditor*", delivery: "Delivery" };
function caughtBy(p: AppState["purchases"][number] | undefined, fallback: string[]): Set<string> {
  if (!p) return new Set(fallback);
  const fails = [...p.verdict.checks, ...(p.deliveryVerdict?.checks ?? [])].filter((x) => x.outcome === "fail" || (x.stage === "delivery" && x.outcome === "warn"));
  return new Set(fails.map((x) => (x.rule === "auditor.quarantined_reader" ? "reader" : x.stage)));
}
function LayerMatrix({ s }: { s: AppState }) {
  const cases = (s.redteam?.cases ?? []).filter((c) => c.kind === "attack");
  const [hover, setHover] = useState<string | null>(null);
  if (!cases.length) return <p className="readout">Run the red team below to fill this in.</p>;
  const byId = new Map(s.purchases.map((p) => [p.id, p]));
  const rows = cases.map((c) => {
    const hit = caughtBy(c.protected.purchaseId ? byId.get(c.protected.purchaseId) : undefined, c.protected.layers ?? []);
    const indep = [...hit].filter((x) => x !== "auditor" || hit.size === 1);
    return { c, hit, indep };
  });
  const avg = rows.reduce((a, r) => a + r.indep.length, 0) / rows.length;
  const multi = rows.filter((r) => r.indep.length >= 2).length;
  const cols = MX.filter((st) => rows.some((r) => r.hit.has(st)));
  return (
    <>
      <p className="bignote"><b className="num">{avg.toFixed(1)}</b> independent layers stopped each attack on average. {multi} of {rows.length} were caught by two or more layers that don't see each other's results.</p>
      <div className="matrix" role="table" aria-label="Which layers caught which attack" style={{ gridTemplateColumns: `minmax(120px, 1.6fr) repeat(${cols.length}, minmax(0, 1fr))` }}>
        <span />
        {cols.map((st) => <span key={st} className="mx-head">{MX_NAME[st]}</span>)}
        {rows.map(({ c, hit }) => (
          <Row key={c.id} label={`${c.id} ${c.name}`} stages={cols} cells={cols.map((st) => hit.has(st))} onHover={(st) => setHover(st ? `${c.id} ${c.name}: ${st.hit ? "caught" : "not flagged"} by ${MX_NAME[st.stage]}. ${c.technique}` : null)} />
        ))}
      </div>
      <p className="readout">{hover ?? "Filled: that layer failed the purchase. *The auditor also sees the other layers' findings, so it only counts toward the average when it was the only layer to catch an attack."}</p>
    </>
  );
}

function Row({ label, cells, stages, onHover }: { label: string; cells: boolean[]; stages: readonly string[]; onHover: (c: { stage: string; hit: boolean } | null) => void }) {
  return (
    <>
      <span className="mx-label">{label}</span>
      {cells.map((hit, i) => <span key={i} className={`mx-cell${hit ? " hit" : ""}`} onMouseEnter={() => onHover({ stage: stages[i]!, hit })} onMouseLeave={() => onHover(null)} aria-label={hit ? "caught" : "not flagged"} />)}
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
      <div className="view-head">
        <div>
          <h1 className="title">The receipts.</h1>
          <p className="lede">Everything here is computed from real runs: every purchase an agent proposed, every check, every PayPal call. Nothing on this page is typed in by hand.</p>
        </div>
      </div>

      <div className="score num">
        <div><b><Num value={ps.length} /></b><span>purchases proposed by agents</span></div>
        <div><b><Num value={blocked} /></b><span>blocked before PayPal was called</span></div>
        <div><b><Num value={ps.reduce((a, p) => a + p.verdict.checks.length, 0)} /></b><span>individual checks run</span></div>
        <div className="bad"><b><Num value={st.aloneLost} money /></b><span>taken from the agent alone in Arena duels</span></div>
        <div><b><Num value={st.capturedThroughChaperone} money /></b><span>paid to attackers through Chaperone, ever</span></div>
      </div>

      <div className="grid-cells">
        <Panel title="Where the money went" note="Every dollar agents proposed, and where it ended up. Red never reached a seller.">
          <MoneyFlow purchases={ps} />
        </Panel>
        <Panel title="Which layer flags purchases" note="Purchases failed by each layer; one purchase can be failed by several. The system map counts only the layer where each one stopped first." table={{ head: ["Layer", "Purchases failed"], rows: catches.map((c) => [c.label, c.value]) }}>
          <Bars rows={catches} unit="purchases" />
        </Panel>
        <Panel title="How long the gate takes" note="Median milliseconds per step, measured on these runs." table={{ head: ["Step", "Median ms"], rows: latency.map((c) => [c.label, c.value]) }}>
          <Bars rows={latency} unit="ms" format={(n) => (n < 1 ? "<1 ms" : `${n.toLocaleString()} ms`)} />
        </Panel>
        <Panel title="Arena: how often the live agent was fooled" note="From the duels run on this server, so the sample is small. The controlled study is further down." table={hijack.length ? { head: ["Attack", "% fooled"], rows: hijack.map((c) => [c.label, c.value]) } : undefined}>
          {hijack.length ? <Bars rows={hijack} unit="% of runs" format={(n) => `${n}%`} accent /> : <p className="readout">Run duels in the Arena and this fills in.</p>}
        </Panel>
        <section className="cell wide">
          <header><h3>Defense in depth</h3><p>Red team, full-compromise mode: the agent is assumed fooled. Each row is an attack, each column a layer.</p></header>
          <LayerMatrix s={s} />
        </section>
        <HeldOut />
        <Hijack />
      </div>
      {children}
    </>
  );
}

// ── Recorded studies (repro scripts, saved as JSON) ───────────
interface HeldOutReport { at: string; attackerModel: string; auditorModel: string; n: number; blocked: number; heldForHuman: number; pastGate: number; rows: { n: number; name: string; idea: string; levers: string; outcome: string; caughtBy?: string; amount: number; gateMs: number; text: string }[] }
interface HijackReport { at: string; model: string; hijacked: number; runs: number; rows: { id: string; name: string; hijacked: boolean; amount?: number; qty?: number }[] }

function useReport<T>(name: string): T | null | undefined {
  const [r, setR] = useState<T | null | undefined>();
  useEffect(() => {
    fetch(`/api/receipts/${name}`).then((x) => (x.ok ? x.json() : null)).then(setR, () => setR(null));
  }, [name]);
  return r;
}

const HO_WORD: Record<string, string> = { blocked: "Blocked at the gate", held_for_human: "Held for you", slipped: "Got past the gate" };

function HeldOut() {
  const r = useReport<HeldOutReport>("heldout");
  const [hover, setHover] = useState<number | null>(null);
  if (!r) return null;
  const pick = r.rows.findIndex((x) => x.outcome !== "blocked");
  const row = r.rows[hover ?? (pick >= 0 ? pick : 0)];
  return (
    <section className="cell wide" id="t-heldout">
      <header>
        <h3>Attacks nobody wrote rules for</h3>
        <p>
          A separate model ({r.attackerModel}) invented {r.n} new attacks against the gate, after it was finished. Result: <b>{r.blocked} blocked</b>, <b>{r.heldForHuman} held for you</b>, <b>{r.pastGate} past the gate</b>. Hover a square to read the attack.
        </p>
      </header>
      <div className="study">
        <div className="study-grid" onMouseLeave={() => setHover(null)}>
          {r.rows.map((x, i) => (
            <button key={i} className={`sq o-${x.outcome}${hover === i ? " on" : ""}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} aria-label={`${x.name}: ${HO_WORD[x.outcome] ?? x.outcome}`}>
              <span className="num">{String(x.n).padStart(2, "0")}</span>
            </button>
          ))}
        </div>
        <div className="study-read">
          {row ? (
            <>
              <b>{row.name}</b>
              <span className="faint">{row.idea}</span>
              <span className="num faint">{row.levers} · gate {Math.round(row.gateMs).toLocaleString()} ms</span>
              <span className={`stag s-${row.outcome === "blocked" ? "blocked" : "held"}`}>{HO_WORD[row.outcome] ?? row.outcome}{row.caughtBy ? `: ${row.caughtBy}` : ""}</span>
              <pre>{row.text}</pre>
            </>
          ) : (
            <span className="faint">Recorded {new Date(r.at).toLocaleString()} · auditor {r.auditorModel}. Reproduce with <code>npm run heldout</code>.</span>
          )}
        </div>
      </div>
    </section>
  );
}

function Hijack() {
  const r = useReport<HijackReport>("hijack");
  if (!r) return null;
  const pct = Math.round((r.hijacked / r.runs) * 100);
  return (
    <section className="cell wide">
      <header>
        <h3>Why the gate has to exist</h3>
        <p>
          The same attack library against the bare agent ({r.model}), no Chaperone. It fell for <b>{r.hijacked} of {r.runs}</b> ({pct}%). A capable model still gets talked into paying the wrong store about one time in {Math.max(2, Math.round(r.runs / Math.max(1, r.hijacked)))}.
        </p>
      </header>
      <div className="hj">
        {r.rows.map((x) => (
          <div key={x.id} className={`hj-cell${x.hijacked ? " bad" : ""}`} title={x.hijacked ? `Fooled: paid ${x.amount != null ? `$${x.amount.toFixed(2)}` : ""}${(x.qty ?? 1) > 1 ? ` for ${x.qty} units` : ""}` : "Resisted"}>
            <b className="num">{x.id}</b>
            <span>{x.name}</span>
            <em>{x.hijacked ? `fooled${x.amount != null ? ` · $${x.amount.toFixed(2)}` : ""}` : "resisted"}</em>
          </div>
        ))}
      </div>
    </section>
  );
}
