import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { api, usd, type AppState, type LogLine, type Purchase } from "./api.ts";
import { cumulative, Health, MoneyFlow, Spark, Waterfall } from "./charts.tsx";
import { Num } from "./evidence.tsx";
import { Pipeline } from "./pipeline.tsx";
import { fmtMs, Icon, inScope, median, Pane, rel, Seg, SCOPES, scopeOf, StateTag, useNow, type Scope } from "./ui.tsx";

type Notify = (m: string, err?: boolean) => void;

export function ConsoleView({ s, lines, scope, setScope, sel, setSel, open, notify }: { s: AppState; lines: LogLine[]; scope: Scope; setScope: (x: Scope) => void; sel?: string; setSel: (id: string) => void; open: (id: string) => void; notify: Notify }) {
  const now = useNow(1000);
  const ps = useMemo(() => s.purchases.filter(inScope(scope)), [s.purchases, scope]);
  const [replay, setReplay] = useState<{ id: string; n: number } | undefined>();
  const selected = ps.find((p) => p.id === sel) ?? ps[0];

  const blocked = ps.filter((p) => p.state === "blocked");
  const heldNow = ps.filter((p) => ["authorized", "awaiting_delivery", "verifying"].includes(p.state));
  const paid = ps.filter((p) => p.state === "seller_paid" || p.state === "captured");
  const stopped = ps.filter((p) => ["blocked", "voided", "denied"].includes(p.state));
  const gateMs = median(ps.map((p) => p.verdict.ms));
  const lastAt = lines.at(-1)?.at;

  return (
    <div className="console">
      <div className="view-head">
        <div>
          <h1 className="title">Control room</h1>
          <p className="status-line num">
            <i className="livedot" /> {ps.length} purchases · {blocked.length} blocked before PayPal · {usd(heldNow.reduce((a, p) => a + p.amount.value, 0))} held · last backend event {lastAt ? rel(lastAt, now) : "none yet"}
            {lastAt && rel(lastAt, now) !== "now" ? " ago" : ""}
          </p>
        </div>
        <Seg value={scope} options={SCOPES} onChange={setScope} label="Which purchases" />
      </div>

      <div className="kpis">
        <Kpi label="Purchases proposed" value={ps.length} spark={cumulative(ps, () => 1)} />
        <Kpi label="Blocked before PayPal" value={blocked.length} spark={cumulative(blocked, () => 1)} bad />
        <Kpi label="Held in PayPal now" value={heldNow.reduce((a, p) => a + p.amount.value, 0)} money spark={cumulative(heldNow, (p) => p.amount.value)} />
        <Kpi label="Paid to sellers" value={paid.reduce((a, p) => a + (p.paypal.capturedAmount ?? p.amount.value), 0)} money spark={cumulative(paid, (p) => p.paypal.capturedAmount ?? p.amount.value)} />
        <Kpi label="Stopped before it moved" value={stopped.reduce((a, p) => a + p.amount.value, 0)} money spark={cumulative(stopped, (p) => p.amount.value)} bad />
        <Kpi label="Median gate time" value={gateMs / 1000} suffix=" s" digits={2} spark={ps.slice().reverse().map((p) => p.verdict.ms)} raw />
      </div>

      <Pane
        title="System map"
        hint="the real backend, layer by layer"
        live
        className="span-12"
        right={
          selected && (
            <button className="btn sm" onClick={() => setReplay({ id: selected.id, n: (replay?.n ?? 0) + 1 })}>
              <Icon name="replay" size={14} /> Replay selected
            </button>
          )
        }
      >
        <Pipeline purchases={ps} replay={replay} />
      </Pane>

      <div className="row">
        <Pane title="Trace" hint={selected ? selected.id : "no purchase selected"} className="span-7" right={selected && <button className="btn sm" onClick={() => open(selected.id)}>Every check and receipt <Icon name="arrow" size={14} /></button>}>
          {selected ? <Trace p={selected} now={now} /> : <p className="readout">No purchases in this scope yet.</p>}
        </Pane>
        <Pane title="Where the money went" hint="every proposed dollar" className="span-5">
          <MoneyFlow purchases={ps} />
        </Pane>
      </div>

      <div className="row">
        <Pane title="Purchases" hint={`${ps.length} in scope · click to trace`} className="span-7">
          <Table ps={ps} sel={selected?.id} setSel={setSel} open={open} now={now} />
        </Pane>
        <Pane title="Backend log" hint="every call, as it happens" live className="span-5 tall">
          <Log lines={lines} setSel={setSel} now={now} />
        </Pane>
      </div>

      <div className="row">
        <Pane title="Needs you" hint="purchases waiting for a person" className="span-4">
          <Queue ps={ps.filter((p) => p.state === "held")} notify={notify} open={open} />
        </Pane>
        <Pane title="Provider health" hint="latency of the last calls" live className="span-4">
          <Health lines={lines} now={now} />
        </Pane>
        <Pane title="Budgets" hint="signed mandates" className="span-4">
          <Budgets s={s} />
        </Pane>
      </div>
    </div>
  );
}

function Kpi({ label, value, money, spark, bad, suffix, digits, raw }: { label: string; value: number; money?: boolean; spark: number[]; bad?: boolean; suffix?: string; digits?: number; raw?: boolean }) {
  return (
    <div className={`kpi${bad ? " bad" : ""}`}>
      <span className="kpi-label">{label}</span>
      <b className="kpi-val num">
        <Num value={value} money={money} digits={digits} />
        {suffix}
      </b>
      <Spark values={raw ? spark : spark} bad={bad} />
    </div>
  );
}

function Trace({ p, now }: { p: Purchase; now: number }) {
  const t0 = new Date(p.intent.createdAt).getTime();
  const fails = p.verdict.checks.filter((c) => c.outcome === "fail");
  return (
    <div className="trace">
      <div className="trace-head">
        <div>
          <b>{p.intent.quantity}× {p.intent.listing.title}</b>
          <span className="faint num">
            {p.intent.listing.merchant.domain} · {usd(p.amount.value)} · {p.intent.agent} · {rel(p.intent.createdAt, now)} ago
          </span>
        </div>
        <StateTag state={p.state} />
      </div>
      {fails.length > 0 && (
        <div className="caught">
          {fails.slice(0, 4).map((c, i) => (
            <span key={i}>
              <i /> {c.title}
            </span>
          ))}
        </div>
      )}
      <Waterfall p={p} />
      <ol className="chainlist">
        {p.timeline.map((e, i) => (
          <li key={i} className={e.kind === "error" || e.kind === "voided" ? "bad" : ""}>
            <span className="num faint">+{fmtMs(new Date(e.at).getTime() - t0)}</span>
            <span className="cl-label">{e.label}</span>
            <span className="num faint cl-hash" title={e.hash}>{e.hash ? e.hash.slice(0, 8) : ""}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Table({ ps, sel, setSel, open, now }: { ps: Purchase[]; sel?: string; setSel: (id: string) => void; open: (id: string) => void; now: number }) {
  const [n, setN] = useState(12);
  if (!ps.length) return <p className="readout">Nothing here yet. Run a duel in the Arena or send your agent shopping.</p>;
  return (
    <div className="ptable-wrap">
      <table className="ptable">
        <thead>
          <tr>
            <th>When</th>
            <th>Item</th>
            <th className="r">Amount</th>
            <th>Money</th>
            <th>Caught by</th>
            <th className="r">Gate</th>
          </tr>
        </thead>
        <tbody>
          <AnimatePresence initial={false}>
            {ps.slice(0, n).map((p) => {
              const c = p.deliveryVerdict?.checks.find((x) => x.outcome === "fail") ?? p.verdict.checks.find((x) => x.outcome === "fail") ?? p.verdict.checks.find((x) => x.outcome === "warn");
              return (
                <motion.tr
                  key={p.id}
                  layout="position"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className={p.id === sel ? "on" : ""}
                  onClick={() => setSel(p.id)}
                  onDoubleClick={() => open(p.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && open(p.id)}
                >
                  <td className="num faint">{rel(p.intent.createdAt, now)}</td>
                  <td>
                    <span className="t-item">{p.intent.listing.title}</span>
                    <span className="t-sub">
                      {p.intent.listing.merchant.domain} · <span className={`scope-${scopeOf(p)}`}>{scopeOf(p) === "mine" ? "your agent" : scopeOf(p) === "arena" ? "arena" : "red team"}</span>
                    </span>
                  </td>
                  <td className="num r">{usd(p.amount.value)}</td>
                  <td>
                    <StateTag state={p.state} />
                  </td>
                  <td className="t-why">{c?.title ?? <span className="faint">every check passed</span>}</td>
                  <td className="num r faint">{fmtMs(p.verdict.ms)}</td>
                </motion.tr>
              );
            })}
          </AnimatePresence>
        </tbody>
      </table>
      {ps.length > n && (
        <button className="btn sm ghost more" onClick={() => setN(n + 20)}>
          Show {Math.min(20, ps.length - n)} more of {ps.length - n}
        </button>
      )}
    </div>
  );
}

const SOURCES = [
  { id: "all", label: "All" },
  { id: "paypal", label: "PayPal" },
  { id: "gemini", label: "Gemini" },
  { id: "channel3", label: "Channel3" },
  { id: "gate", label: "Gate" },
  { id: "lifecycle", label: "Money" },
  { id: "agent", label: "Agent" },
] as const;

export function Log({ lines, setSel, now, max = 80 }: { lines: LogLine[]; setSel?: (id: string) => void; now: number; max?: number }) {
  const [src, setSrc] = useState<string>("all");
  const [paused, setPaused] = useState<LogLine[] | null>(null);
  const shown = (paused ?? lines).filter((l) => src === "all" || l.provider === src).slice(-max).reverse();
  const counts = useMemo(() => Object.fromEntries(SOURCES.map((s) => [s.id, s.id === "all" ? lines.length : lines.filter((l) => l.provider === s.id).length])), [lines]);
  return (
    <div className="log">
      <div className="log-bar">
        <div className="chips">
          {SOURCES.map((s) => (
            <button key={s.id} className="chip" aria-pressed={src === s.id} onClick={() => setSrc(s.id)}>
              {s.label} <span className="num">{counts[s.id]}</span>
            </button>
          ))}
        </div>
        <button className="btn sm ghost" onClick={() => setPaused(paused ? null : lines.slice())} aria-pressed={!!paused}>
          <Icon name={paused ? "play" : "pause"} size={12} /> {paused ? "Resume" : "Pause"}
        </button>
      </div>
      <ul className="log-lines">
        <AnimatePresence initial={false}>
          {shown.map((l) => (
            <motion.li
              key={l.seq}
              initial={{ opacity: 0, x: -8, backgroundColor: "var(--flash)" }}
              animate={{ opacity: 1, x: 0, backgroundColor: "rgba(0,0,0,0)" }}
              transition={{ duration: 0.5 }}
              className={`${l.ok ? "" : "err"}${l.ref ? " link" : ""}`}
              onClick={() => l.ref && setSel?.(l.ref)}
              title={l.note}
            >
              <span className="l-t num">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>
              <span className={`l-src p-${l.provider}`}>{l.provider === "lifecycle" ? "money" : l.provider}</span>
              <span className="l-op">
                {l.op}
                {l.note && <em> {l.note}</em>}
              </span>
              <span className="l-ms num">{l.ms != null ? fmtMs(l.ms) : ""}</span>
            </motion.li>
          ))}
        </AnimatePresence>
        {!shown.length && <li className="empty-line">Waiting for the backend. Run a duel or send your agent shopping and every PayPal, Gemini and Channel3 call shows up here.</li>}
      </ul>
    </div>
  );
}

function Queue({ ps, notify, open }: { ps: Purchase[]; notify: Notify; open: (id: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const go = async (id: string, decision: "approve" | "deny") => {
    setBusy(id);
    try {
      await api("POST", `/api/purchases/${id}/decision`, { decision });
      notify(decision === "approve" ? "Approved. PayPal is holding the funds until delivery." : "Declined. Nothing was charged.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  if (!ps.length) return <p className="readout">Nothing is waiting for you. Purchases over your auto-approve limit, from unverified sellers, or made while the AI is down land here.</p>;
  return (
    <ul className="queue">
      {ps.slice(0, 5).map((p) => (
        <li key={p.id}>
          <button className="q-main" onClick={() => open(p.id)}>
            <b>{p.intent.listing.title}</b>
            <span className="faint">{usd(p.amount.value)} · {p.verdict.checks.filter((c) => c.outcome === "warn").map((c) => c.title).join(" · ")}</span>
          </button>
          <div className="btn-row">
            <button className="btn sm primary" disabled={busy === p.id} onClick={() => go(p.id, "approve")}>Approve</button>
            <button className="btn sm" disabled={busy === p.id} onClick={() => go(p.id, "deny")}>Decline</button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Budgets({ s }: { s: AppState }) {
  const ms = s.mandates.filter((m) => m.status !== "draft" && m.status !== "awaiting_paypal").slice(0, 5);
  if (!ms.length) return <p className="readout">No signed mandates yet. Sign one on the Mandates page.</p>;
  return (
    <ul className="budgets">
      {ms.map((m) => {
        const t = m.budget.maxTotal || 1;
        return (
          <li key={m.id}>
            <div className="b-head">
              <span className="b-name">{m.item.description}</span>
              <span className="num faint">{usd(Math.max(0, m.budget.maxTotal - m.settled - m.committed))} left</span>
            </div>
            <div className="meter" role="img" aria-label={`${usd(m.settled)} paid, ${usd(m.committed)} held, of ${usd(m.budget.maxTotal)}`}>
              <motion.span className="m-paid" initial={{ width: 0 }} animate={{ width: `${(m.settled / t) * 100}%` }} />
              <motion.span className="m-held" initial={{ width: 0 }} animate={{ width: `${(m.committed / t) * 100}%` }} />
            </div>
            <span className="b-sub num faint">
              {usd(m.settled)} paid · {usd(m.committed)} held · cap {usd(m.budget.maxTotal)} · {m.status}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
