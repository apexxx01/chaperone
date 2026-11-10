import { useEffect, useMemo, useRef, useState } from "react";
import { usd, type Purchase } from "./api.ts";
import { fmtMs, median, STATE_WORD } from "./ui.tsx";

/**
 * The system map. One node per layer of the real backend, in the order the code runs them.
 * Every number is computed from the purchases passed in, and every moving pulse is a real purchase
 * (live as it happens, or a labeled replay of recent ones), following the exact path it took.
 */
type NodeId = "agent" | "mandate" | "policy" | "market" | "scanner" | "ai" | "decide" | "hold" | "delivery" | "paid";
type SinkId = "blocked" | "you" | "voided" | "refunded";

const CY = 112;
const H = 66;
const NODES: { id: NodeId; x: number; w: number; title: string; does: string }[] = [
  { id: "agent", x: 8, w: 104, title: "Agent", does: "Any agent proposes a purchase: the built-in Gemini shopper, or yours over MCP. It can propose; it can't pay." },
  { id: "mandate", x: 138, w: 104, title: "Mandate", does: "Is there a signed, unexpired mandate with a PayPal wallet behind it?" },
  { id: "policy", x: 258, w: 104, title: "Policy", does: "Plain code: caps, total budget, quantity, required specs, lookalike stores, payee identity, velocity, duplicates." },
  { id: "market", x: 378, w: 104, title: "Market price", does: "Price against the same product's offers on other retailers (Channel3), or comparable products." },
  { id: "scanner", x: 498, w: 104, title: "Scanner", does: "Invisible Unicode, zero-width text, bidi tricks, fake system roles, text addressed to AI, payee redirects." },
  { id: "ai", x: 624, w: 124, title: "AI layer", does: "Two Gemini calls in parallel. The quarantined reader sees the page but can only answer yes/no. The auditor sees your words and the facts, never the page." },
  { id: "decide", x: 772, w: 40, title: "Decision", does: "Any fail blocks. Any warning waits for you. Otherwise PayPal holds the money." },
  { id: "hold", x: 836, w: 112, title: "PayPal hold", does: "Orders v2 intent=AUTHORIZE on the vaulted wallet: the money is held, not moved." },
  { id: "delivery", x: 970, w: 112, title: "Delivery", does: "Only your confirmation counts. Same product? Requirements still met? All units? Gemini vision checks a photo." },
  { id: "paid", x: 1104, w: 128, title: "Capture + payout", does: "Capture what arrived, attach tracking, pay the seller with PayPal Payouts." },
];
const SINK_Y = 262;
const SINKS: { id: SinkId; cx: number; w: number; title: string; does: string }[] = [
  { id: "blocked", cx: 430, w: 236, title: "Blocked: PayPal never called", does: "A layer failed the purchase. No authorization was created." },
  { id: "you", cx: 792, w: 136, title: "Waiting for you", does: "Something needs a human tap: over your auto-approve limit, an unverified seller, or the AI was unavailable." },
  { id: "voided", cx: 1026, w: 112, title: "Voided", does: "What arrived didn't match. The authorization was voided: the money never moved." },
  { id: "refunded", cx: 1168, w: 112, title: "Refunded", does: "Captured, then refunded through PayPal." },
];
const node = (id: NodeId) => NODES.find((n) => n.id === id)!;
const cx = (id: NodeId) => node(id).x + node(id).w / 2;
const STAGE_NODE: Record<string, NodeId> = { mandate: "mandate", policy: "policy", market: "market", scanner: "scanner", auditor: "ai", human: "decide", delivery: "delivery" };
const ORDER: NodeId[] = NODES.map((n) => n.id);

export interface Route {
  nodes: NodeId[];
  sink?: SinkId;
  /** Where the purchase's money ended up, for the end-of-path flash. */
  fate: "pass" | "stop" | "wait";
}

export function routeOf(p: Purchase): Route {
  const upTo = (id: NodeId) => ORDER.slice(0, ORDER.indexOf(id) + 1);
  switch (p.state) {
    case "blocked": {
      const fails = p.verdict.checks.filter((c) => c.outcome === "fail").map((c) => STAGE_NODE[c.stage] ?? "policy");
      const first = ORDER.find((n) => fails.includes(n)) ?? "policy";
      return { nodes: upTo(first), sink: "blocked", fate: "stop" };
    }
    case "held":
    case "denied":
      return { nodes: upTo("decide"), sink: "you", fate: p.state === "denied" ? "stop" : "wait" };
    case "proposed":
      return { nodes: upTo("ai"), fate: "wait" };
    case "failed":
      return { nodes: upTo("hold"), fate: "stop" };
    case "authorized":
    case "awaiting_delivery":
    case "verifying":
      return { nodes: upTo("hold"), fate: "wait" };
    case "voided":
      return { nodes: upTo("delivery"), sink: "voided", fate: "stop" };
    case "refunded":
      return { nodes: upTo("paid"), sink: "refunded", fate: "stop" };
    default:
      return { nodes: upTo("paid"), fate: "pass" };
  }
}

function pathOf(r: Route): { d: string; stops: { at: number; id: string }[] } {
  const pts: [number, number, string][] = r.nodes.map((n) => [cx(n), CY, n]);
  if (r.sink) {
    const last = pts.at(-1)!;
    const s = SINKS.find((x) => x.id === r.sink)!;
    const busY = r.sink === "blocked" ? 214 : SINK_Y - 26;
    pts.push([last[0], busY, ""], [s.cx, busY, ""], [s.cx, SINK_Y - 16, r.sink]);
  }
  let len = 0;
  const segs: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    len += Math.abs(pts[i]![0] - pts[i - 1]![0]) + Math.abs(pts[i]![1] - pts[i - 1]![1]);
    segs.push(len);
  }
  return { d: pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(""), stops: pts.map((p, i) => ({ at: len ? segs[i]! / len : 0, id: p[2] })).filter((s) => s.id) };
}

interface PulseSpec {
  key: string;
  route: Route;
  label: string;
  delay: number;
}

function Pulse({ spec, onStop, onDone }: { spec: PulseSpec; onStop: (id: string, last: boolean) => void; onDone: () => void }) {
  const pathRef = useRef<SVGPathElement>(null);
  const headRef = useRef<SVGGElement>(null);
  const { d, stops } = useMemo(() => pathOf(spec.route), [spec.route]);
  useEffect(() => {
    const path = pathRef.current!;
    const head = headRef.current!;
    const len = path.getTotalLength();
    const dur = 900 + len * 1.35;
    let raf = 0;
    let t0 = 0;
    let next = 0;
    const tick = (now: number) => {
      if (!t0) t0 = now + spec.delay;
      const k = Math.max(0, Math.min(1, (now - t0) / dur));
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const pt = path.getPointAtLength(e * len);
      head.setAttribute("transform", `translate(${pt.x},${pt.y})`);
      head.style.opacity = now < t0 ? "0" : "1";
      path.style.strokeDashoffset = String(len - e * len);
      while (next < stops.length && e >= stops[next]!.at - 0.001) {
        onStop(stops[next]!.id, next === stops.length - 1);
        next++;
      }
      if (k < 1) raf = requestAnimationFrame(tick);
      else setTimeout(onDone, 700);
    };
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
  const bad = spec.route.fate === "stop";
  return (
    <g className={`pulse ${bad ? "bad" : ""}`}>
      <path ref={pathRef} d={d} className="pulse-trail" />
      <g ref={headRef} style={{ opacity: 0 }}>
        <circle r="9" className="pulse-halo" />
        <circle r="4" className="pulse-head" />
      </g>
    </g>
  );
}

export function Pipeline({ purchases, replay, caption = true, compact = false }: { purchases: Purchase[]; replay?: { id: string; n: number }; caption?: boolean; compact?: boolean }) {
  const [pulses, setPulses] = useState<PulseSpec[]>([]);
  const [flash, setFlash] = useState<Record<string, { t: number; bad: boolean }>>({});
  const [hover, setHover] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const prev = useRef<Map<string, string> | null>(null);
  const reduce = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const spawn = (p: Purchase, delay = 0, why = "Live") => {
    if (reduce) return;
    setPulses((cur) => [...cur.slice(-14), { key: `${p.id}:${p.state}:${Math.random()}`, route: routeOf(p), label: `${why}: ${p.intent.listing.title.slice(0, 48)} · ${usd(p.amount.value)} · ${STATE_WORD[p.state] ?? p.state}`, delay }]);
    setTimeout(() => setNote(`${why}: ${p.intent.listing.title.slice(0, 56)} · ${usd(p.amount.value)} · ${STATE_WORD[p.state] ?? p.state}`), delay);
  };

  // New purchases and state changes fly the instant the backend reports them.
  useEffect(() => {
    const now = new Map(purchases.map((p) => [p.id, p.state]));
    if (prev.current) {
      for (const p of purchases) if (prev.current.get(p.id) !== p.state) spawn(p);
    } else {
      // First paint: replay the latest few real purchases, clearly labeled as a replay.
      purchases.slice(0, 5).reverse().forEach((p, i) => spawn(p, 500 + i * 900, "Replay"));
    }
    prev.current = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchases]);

  useEffect(() => {
    if (!replay) return;
    const p = purchases.find((x) => x.id === replay.id);
    if (p) spawn(p, 0, "Replay");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay?.n]);

  const stats = useMemo(() => {
    const reached: Record<string, number> = {};
    const stopped: Record<string, number> = {};
    for (const p of purchases) {
      const r = routeOf(p);
      for (const n of r.nodes) reached[n] = (reached[n] ?? 0) + 1;
      if (r.sink) reached[r.sink] = (reached[r.sink] ?? 0) + 1;
      if (r.fate === "stop" && r.sink === "blocked") stopped[r.nodes.at(-1)!] = (stopped[r.nodes.at(-1)!] ?? 0) + 1;
    }
    const checkMs = (pred: (rule: string, stage: string) => boolean) => median(purchases.flatMap((p) => p.verdict.checks.filter((c) => pred(c.rule, c.stage) && c.ms != null).map((c) => c.ms!)));
    const evMs = (kind: string) => median(purchases.flatMap((p) => p.timeline.filter((e) => e.kind === kind && e.ms != null).map((e) => e.ms!)));
    const ms: Record<string, string> = {
      mandate: "<1 ms",
      policy: fmtMs(checkMs((r, s) => s === "policy")),
      market: fmtMs(checkMs((r, s) => s === "market")),
      scanner: "<1 ms",
      reader: fmtMs(checkMs((r) => r === "auditor.quarantined_reader")),
      auditor: fmtMs(checkMs((r) => r === "auditor.mandate_alignment")),
      decide: fmtMs(median(purchases.map((p) => p.verdict.ms))),
      hold: fmtMs(evMs("authorized")),
      delivery: fmtMs(evMs("verified")),
      paid: fmtMs(evMs("captured") + evMs("payout")),
    };
    const held = purchases.filter((p) => ["awaiting_delivery", "authorized", "verifying"].includes(p.state)).reduce((a, p) => a + p.amount.value, 0);
    const paid = purchases.filter((p) => p.state === "seller_paid").reduce((a, p) => a + (p.paypal.capturedAmount ?? 0), 0);
    return { reached, stopped, ms, held, paid };
  }, [purchases]);

  const onStop = (id: string, last: boolean, bad: boolean) => setFlash((f) => ({ ...f, [id]: { t: Date.now(), bad: last && bad } }));
  const lit = (id: string) => {
    const f = flash[id];
    return f && Date.now() - f.t < 900 ? (f.bad ? " flash-bad" : " flash") : "";
  };
  // re-render to let flashes fade
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 300);
    return () => clearInterval(t);
  }, []);

  const hovered = NODES.find((n) => n.id === hover) ?? SINKS.find((s) => s.id === hover);
  return (
    <div className={`pipe${compact ? " compact" : ""}`}>
      <div className="pipe-scroll">
        <svg viewBox="0 58 1240 230" className="pipe-svg" role="img" aria-label={`System map: ${purchases.length} purchases. ${stats.reached.blocked ?? 0} blocked before PayPal, ${stats.reached.you ?? 0} waiting for a person, ${usd(stats.held)} held in PayPal, ${usd(stats.paid)} paid to sellers.`}>
          {/* main line */}
          {NODES.slice(0, -1).map((n, i) => {
            const b = NODES[i + 1]!;
            return <line key={n.id} x1={n.x + n.w} x2={b.x} y1={CY} y2={CY} className="edge" />;
          })}
          {/* exits */}
          <path d={`M${cx("mandate")},${CY + H / 2} V214 H${cx("ai")} V${CY + 42} M${cx("policy")},${CY + H / 2}V214 M${cx("market")},${CY + H / 2}V214 M${cx("scanner")},${CY + H / 2}V214 M430,214 V${SINK_Y - 16}`} className="edge exit" />
          <path d={`M${cx("decide")},${CY + 20} V${SINK_Y - 16} M${cx("delivery")},${CY + H / 2} V${SINK_Y - 26} H1026 V${SINK_Y - 16} M${cx("paid")},${CY + H / 2} V${SINK_Y - 26} H1168 V${SINK_Y - 16}`} className="edge exit" />

          {pulses.map((p) => (
            <Pulse key={p.key} spec={p} onStop={(id, last) => onStop(id, last, p.route.fate === "stop")} onDone={() => setPulses((cur) => cur.filter((x) => x.key !== p.key))} />
          ))}

          {NODES.map((n) => {
            if (n.id === "decide") {
              const x = cx("decide");
              return (
                <g key={n.id} className={`node diamond${lit(n.id)}${hover === n.id ? " hov" : ""}`} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(n.id)}>
                  <path d={`M${x},${CY - 20} L${x + 20},${CY} L${x},${CY + 20} L${x - 20},${CY} Z`} className="node-box" />
                  <text x={x} y={CY - 30} className="n-title" textAnchor="middle">Decide</text>
                  <text x={x + 14} y={CY + 22} className="n-ms">{stats.ms.decide}</text>
                </g>
              );
            }
            const h = n.id === "ai" ? 84 : H;
            const y = CY - h / 2;
            const reached = stats.reached[n.id] ?? 0;
            const stop = stats.stopped[n.id] ?? 0;
            return (
              <g key={n.id} className={`node${lit(n.id)}${hover === n.id ? " hov" : ""}`} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(n.id)}>
                <rect x={n.x} y={y} width={n.w} height={h} className="node-box" />
                <text x={n.x + 10} y={y + 17} className="n-title">{n.title}</text>
                {n.id === "ai" ? (
                  <>
                    <text x={n.x + 10} y={y + 40} className="n-sub">Reader</text>
                    <text x={n.x + n.w - 10} y={y + 40} className="n-ms" textAnchor="end">{stats.ms.reader}</text>
                    <line x1={n.x + 10} x2={n.x + n.w - 10} y1={y + 48} y2={y + 48} className="n-rule" />
                    <text x={n.x + 10} y={y + 64} className="n-sub">Auditor</text>
                    <text x={n.x + n.w - 10} y={y + 64} className="n-ms" textAnchor="end">{stats.ms.auditor}</text>
                    {stop > 0 && <text x={n.x + n.w - 2} y={y + h + 13} className="n-stop" textAnchor="end">{stop} stopped</text>}
                  </>
                ) : (
                  <>
                    <text x={n.x + 10} y={y + 46} className="n-num">{n.id === "hold" ? usd(stats.held).replace(".00", "") : n.id === "paid" ? usd(stats.paid).replace(".00", "") : reached}</text>
                    {n.id !== "agent" && <text x={n.x + 2} y={y + h + 13} className="n-ms">{stats.ms[n.id]}</text>}
                    {stop > 0 && <text x={n.x + n.w - 10} y={y + 46} className="n-stop" textAnchor="end">−{stop}</text>}
                    <text x={n.x + 10} y={y + h - 8} className="n-sub">{n.id === "agent" ? "proposals" : n.id === "hold" ? `${reached} reached` : n.id === "paid" ? `${reached} paid out` : stop ? `${reached} in · ${stop} stopped` : `${reached} in`}</text>
                  </>
                )}
              </g>
            );
          })}
          {SINKS.map((s) => (
            <g key={s.id} className={`node sink s-${s.id}${lit(s.id)}${hover === s.id ? " hov" : ""}`} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)} tabIndex={0} onFocus={() => setHover(s.id)}>
              <rect x={s.cx - s.w / 2} y={SINK_Y - 16} width={s.w} height={30} className="node-box" />
              <text x={s.cx - s.w / 2 + 10} y={SINK_Y + 4} className="n-sub">{s.title}</text>
              <text x={s.cx + s.w / 2 - 10} y={SINK_Y + 4} className="n-num sm" textAnchor="end">{stats.reached[s.id] ?? 0}</text>
            </g>
          ))}
        </svg>
      </div>
      {caption && (
        <p className="pipe-cap" aria-live="polite">
          {hovered ? (
            <>
              <b>{hovered.title}.</b> {hovered.does}
            </>
          ) : note ? (
            note
          ) : (
            "Hover any layer to see what it checks. Each pulse is a real purchase taking the path it took."
          )}
        </p>
      )}
    </div>
  );
}
