import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api, usd, type Purchase } from "./api.ts";

type Decision = "authorize" | "hold" | "block";
type Outcome = "pass" | "warn" | "fail" | "absent";
interface Limits { maxPerPurchase: number; maxTotal: number; autoApproveUnder: number; maxOverMarketPct: number; maxQuantity: number; mustHave: string; blockMerchants: string }
interface Result {
  before: { decision: Decision; headline: string };
  after: { decision: Decision; headline: string };
  mandate: { budget: { maxPerPurchase: number; maxTotal: number }; autoApproveUnder: number; maxOverMarketPct: number; maxQuantity: number; mustHave: string[]; blockMerchants: string[] };
  changed: { rule: string; title: string; from: Outcome; to: Outcome; detail: string }[];
  ms: number;
}

const WORD: Record<Decision, string> = { authorize: "Hold in PayPal", hold: "Ask you first", block: "Block" };
const OUT: Record<Outcome, string> = { pass: "pass", warn: "ask", fail: "fail", absent: "n/a" };

const toLimits = (m: Result["mandate"]): Limits => ({
  maxPerPurchase: m.budget.maxPerPurchase,
  maxTotal: m.budget.maxTotal,
  autoApproveUnder: m.autoApproveUnder,
  maxOverMarketPct: m.maxOverMarketPct,
  maxQuantity: m.maxQuantity,
  mustHave: m.mustHave.join(", "),
  blockMerchants: m.blockMerchants.join(", "),
});
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Change the limits and the real gate re-runs on this purchase, server side, as you type. */
export function WhatIf({ p }: { p: Purchase }) {
  const [base, setBase] = useState<Limits | null>(null);
  const [lim, setLim] = useState<Limits | null>(null);
  const [r, setR] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    let live = true;
    api<Result>("POST", `/api/purchases/${p.id}/whatif`, {})
      .then((x) => {
        if (!live) return;
        const l = toLimits(x.mandate);
        setBase(l);
        setLim(l);
        setR(x);
      })
      .catch((e) => live && setErr((e as Error).message));
    return () => {
      live = false;
    };
  }, [p.id]);

  useEffect(() => {
    if (!lim || !base || lim === base) return;
    const n = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      api<Result>("POST", `/api/purchases/${p.id}/whatif`, {
        maxPerPurchase: lim.maxPerPurchase,
        maxTotal: lim.maxTotal,
        autoApproveUnder: lim.autoApproveUnder,
        maxOverMarketPct: lim.maxOverMarketPct,
        maxQuantity: lim.maxQuantity,
        mustHave: list(lim.mustHave),
        blockMerchants: list(lim.blockMerchants),
      })
        .then((x) => n === seq.current && setR(x))
        .catch((e) => n === seq.current && setErr((e as Error).message))
        .finally(() => n === seq.current && setBusy(false));
    }, 220);
    return () => clearTimeout(t);
  }, [lim, base, p.id]);

  // The guided tour demonstrates a flip: drop the cap below this purchase's price.
  useEffect(() => {
    const go = () => base && setLim({ ...base, maxPerPurchase: Math.max(1, Math.floor(p.amount.value * 0.6)) });
    window.addEventListener("chaperone:whatif-demo", go);
    return () => window.removeEventListener("chaperone:whatif-demo", go);
  }, [base, p.amount.value]);

  if (err) return null;
  if (!lim || !r || !base) return <div className="whatif loading faint">Loading the limits this purchase was judged against…</div>;

  const set = (k: keyof Limits) => (e: React.ChangeEvent<HTMLInputElement>) => setLim({ ...lim, [k]: e.target.type === "number" || e.target.type === "range" ? Number(e.target.value) : e.target.value });
  const dirty = JSON.stringify(lim) !== JSON.stringify(base);
  const flipped = r.after.decision !== r.before.decision;
  const amount = p.amount.value;
  const slider = (k: "maxPerPurchase" | "autoApproveUnder", label: string) => {
    const max = Math.max(10, Math.ceil((Math.max(base[k], amount) * 2) / 10) * 10);
    return (
      <label className="wi-field">
        <span>
          {label} <b className="num">{usd(lim[k])}</b>
        </span>
        <input type="range" min={0} max={max} step={1} value={lim[k]} onChange={set(k)} style={{ ["--at" as string]: `${(amount / max) * 100}%` }} />
        <em className="faint num">this purchase: {usd(amount)}</em>
      </label>
    );
  };

  return (
    <section className="whatif">
      <header>
        <h3>What if your limits were different?</h3>
        <p className="faint">Drag a limit and the real gate re-runs on this purchase, on the server, with the same code. The AI's answer is reused from the original run.</p>
      </header>

      <div className={`wi-result${flipped ? " flipped" : ""}`} aria-live="polite">
        <div>
          <span className="faint">Originally</span>
          <b className={`wi-d d-${r.before.decision}`}>{WORD[r.before.decision]}</b>
        </div>
        <span className="wi-arrow">→</span>
        <div>
          <span className="faint">With these limits {busy && <i className="wi-spin" />}</span>
          <AnimatePresence mode="popLayout">
            <motion.b key={r.after.decision} className={`wi-d d-${r.after.decision}`} initial={{ y: 10, opacity: 0, scale: 0.9 }} animate={{ y: 0, opacity: 1, scale: 1 }} exit={{ y: -10, opacity: 0 }} transition={{ type: "spring", stiffness: 500, damping: 30 }}>
              {WORD[r.after.decision]}
            </motion.b>
          </AnimatePresence>
        </div>
        <span className="wi-ms num faint">{r.ms} ms</span>
      </div>

      <div className="wi-grid">
        {slider("maxPerPurchase", "Cap per purchase")}
        {slider("autoApproveUnder", "Buy without asking under")}
        <label className="wi-field">
          <span>
            Max over market price <b className="num">{lim.maxOverMarketPct}%</b>
          </span>
          <input type="range" min={0} max={100} step={1} value={lim.maxOverMarketPct} onChange={set("maxOverMarketPct")} />
        </label>
        <label className="wi-field">
          <span>Total budget</span>
          <input className="input" type="number" min={0} value={lim.maxTotal} onChange={set("maxTotal")} />
        </label>
        <label className="wi-field">
          <span>Max quantity</span>
          <input className="input" type="number" min={1} value={lim.maxQuantity} onChange={set("maxQuantity")} />
        </label>
        <label className="wi-field">
          <span>Must have</span>
          <input className="input" value={lim.mustHave} onChange={set("mustHave")} placeholder="65W, USB-C" />
        </label>
        <label className="wi-field wide">
          <span>Never buy from</span>
          <input className="input" value={lim.blockMerchants} onChange={set("blockMerchants")} placeholder={p.intent.listing.merchant.domain} />
        </label>
      </div>

      <ul className="wi-changes">
        <AnimatePresence initial={false}>
          {r.changed.map((c) => (
            <motion.li key={c.rule} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }}>
              <span className={`wi-o o-${c.from}`}>{OUT[c.from]}</span>
              <span className="wi-to">→</span>
              <span className={`wi-o o-${c.to}`}>{OUT[c.to]}</span>
              <span className="wi-t">
                <b>{c.title}</b>
                <em className="faint">{c.detail}</em>
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
        {!r.changed.length && <li className="faint wi-none">{dirty ? "These limits change nothing about this purchase." : "These are the limits it was judged against. Change one."}</li>}
      </ul>

      <div className="btn-row">
        <button className="btn sm" disabled={!dirty} onClick={() => setLim(base)}>
          Reset to the signed limits
        </button>
        <span className="faint" style={{ fontSize: 12 }}>Nothing here is saved or charged.</span>
      </div>
    </section>
  );
}
