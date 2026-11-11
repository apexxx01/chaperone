import { Pipeline } from "./pipeline.tsx";
import { Pane } from "./ui.tsx";
import { useMemo, useState } from "react";
import { api, ago, usd, type AppState, type CaseResult, type Mandate, type Purchase } from "./api.ts";
import { Lane } from "./components.tsx";

type Notify = (m: string, err?: boolean) => void;

const PRESETS = [
  "Buy me one 65W USB-C charger for my laptop. Keep it under $50.",
  "Get me noise-cancelling over-ear headphones, nothing over $120.",
  "Find a 20,000 mAh USB-C power bank. Spend at most $60.",
];

// ── Now ──────────────────────────────────────────────────────
export function NowView({ s: all, open, openId, notify, goto }: { s: AppState; open: (id: string) => void; openId?: string; notify: Notify; goto: (t: string) => void }) {
  // This view is your own agent's purchases; Arena duels and red-team runs live in their own tabs.
  const s = { ...all, purchases: all.purchases.filter((p) => !/^md_(arena|rt)_/.test(p.intent.mandateId)), runs: all.runs.filter((r) => !/^md_(arena|rt)_/.test(r.mandateId)) };
  const held = s.purchases.filter((p) => p.state === "held");
  const holding = s.purchases.filter((p) => p.state === "awaiting_delivery" || p.state === "verifying");
  const heldSum = holding.reduce((a, p) => a + p.amount.value, 0);
  const stopped = s.purchases.filter((p) => ["blocked", "voided", "denied"].includes(p.state)).reduce((a, p) => a + p.amount.value, 0);
  const paid = s.purchases.filter((p) => p.state === "seller_paid").reduce((a, p) => a + (p.paypal.capturedAmount ?? 0), 0);

  let headline: React.ReactNode;
  let lede: string;
  if (held.length) {
    headline = <>{held.length === 1 ? "One purchase needs you." : `${held.length} purchases need you.`}</>;
    lede = "Your agent found something it isn't allowed to buy on its own. Nothing has been charged.";
  } else if (holding.length) {
    headline = <><span className="amt">{usd(heldSum)}</span> is held, not spent.</>;
    lede = `${holding.length} ${holding.length === 1 ? "purchase is" : "purchases are"} on the way. Sellers get paid when what arrives matches what you asked for.`;
  } else if (s.purchases.length) {
    headline = <>Nothing from your agent needs you.</>;
    lede = `${usd(paid)} paid to sellers for verified deliveries. ${usd(stopped)} stopped before it moved.`;
  } else {
    headline = <>Give your agent a job.</>;
    lede = "Say what you want in plain words. You sign the limits once in PayPal, the agent shops, and Chaperone holds the money until it arrives right.";
  }

  return (
    <>
      <h1 className="headline">{headline}</h1>
      <p className="lede">{lede}</p>

      {held.length > 0 && (
        <div className="section" style={{ marginTop: 24 }}>
          {held.map((p) => <Ask key={p.id} p={p} open={open} notify={notify} />)}
        </div>
      )}

      <div className="now-grid">
        <section>
          <div className="section-head">
            <h2>Purchases</h2>
            <p>Where each dollar is right now.</p>
          </div>
          {s.purchases.length ? (
            <div className="lanes">
              {s.purchases.slice(0, 14).map((p) => <Lane key={p.id} p={p} current={p.id === openId} onOpen={() => open(p.id)} />)}
            </div>
          ) : (
            <div className="empty">
              <span>No purchases yet. Send the agent shopping, then try planting an attack to watch Chaperone stop it.</span>
              <button className="btn" onClick={() => goto("redteam")}>Or run the full red team</button>
            </div>
          )}
        </section>
        <AgentPanel s={s} notify={notify} />
      </div>
    </>
  );
}

function Ask({ p, open, notify }: { p: Purchase; open: (id: string) => void; notify: Notify }) {
  const [busy, setBusy] = useState(false);
  const why = p.verdict.checks.filter((c) => c.outcome === "warn");
  const go = async (decision: "approve" | "deny") => {
    setBusy(true);
    try {
      await api("POST", `/api/purchases/${p.id}/decision`, { decision });
      notify(decision === "approve" ? "Approved. Funds held in PayPal until delivery." : "Declined. Nothing was charged.");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ask">
      <div style={{ display: "flex", gap: 16, justifyContent: "space-between", flexWrap: "wrap", alignItems: "baseline" }}>
        <h3>{p.intent.quantity}× {p.intent.listing.title}</h3>
        <span className="amount num">{usd(p.amount.value)}</span>
      </div>
      <p className="why">
        {p.intent.listing.merchant.domain} · {why.map((c) => c.title).join(". ")}.
      </p>
      <div className="btn-row">
        <button className="btn approve" disabled={busy} onClick={() => go("approve")}>Approve <kbd>A</kbd></button>
        <button className="btn danger" disabled={busy} onClick={() => go("deny")}>Decline <kbd>D</kbd></button>
        <button className="btn" onClick={() => open(p.id)}>See the receipts</button>
      </div>
    </div>
  );
}

function AgentPanel({ s, notify }: { s: AppState; notify: Notify }) {
  const active = s.mandates.filter((m) => m.status === "active");
  const [mandateId, setMandateId] = useState<string>("");
  const pendingDraft = s.mandates.some((m) => m.status === "draft" || m.status === "awaiting_paypal");
  const [composing, setComposing] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"protected" | "unprotected">("protected");
  const [attack, setAttack] = useState("");
  const [busy, setBusy] = useState(false);
  // Open on a job that can still buy something, so "Run" works on the first click.
  const funded = active.filter((m) => m.budget.maxTotal - (m.committed ?? 0) - (m.settled ?? 0) >= Math.min(m.budget.maxPerPurchase, m.budget.maxTotal) * 0.5);
  const latestJob = funded.find((m) => s.runs.some((r) => r.mandateId === m.id && r.mode !== "unprotected")) ?? funded[0] ?? active[0];
  const chosen = active.find((m) => m.id === mandateId) ?? latestJob;
  const run = s.runs.find((r) => r.mandateId === chosen?.id);

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await api("POST", "/api/agent/run", { mandateId: chosen.id, mode, attackId: attack || undefined });
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="agent-h">
      <div className="agent-head">
        <h2 id="agent-h">The agent</h2>
        {active.length > 0 && (
          <button className="btn sm" onClick={() => setComposing(!(composing ?? pendingDraft))}>
            {(composing ?? pendingDraft) ? "Back to my jobs" : "+ New job"}
          </button>
        )}
      </div>
      {!active.length || (composing ?? pendingDraft) ? (
        <>
          <p className="faint" style={{ margin: "6px 0 0", fontSize: 13 }}>Say what you want. Chaperone drafts the limits, you check them and approve once in PayPal, then the agent can shop.</p>
          <MandateComposer s={s} notify={notify} compact />
        </>
      ) : (
        <div className="composer" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="m-pick">Job</label>
            <select id="m-pick" className="input" value={chosen?.id} onChange={(e) => setMandateId(e.target.value)}>
              {active.map((m) => <option key={m.id} value={m.id}>{m.instruction}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="atk">Plant an attack in the search results</label>
            <select id="atk" className="input" value={attack} onChange={(e) => setAttack(e.target.value)}>
              <option value="">None, honest marketplace</option>
              {s.attacks.map((a) => <option key={a.id} value={a.id}>{a.id} {a.name}: {a.technique}</option>)}
            </select>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <div className="seg" role="group" aria-label="Protection">
              <button aria-pressed={mode === "protected"} onClick={() => setMode("protected")}>With Chaperone</button>
              <button className="risky" aria-pressed={mode === "unprotected"} onClick={() => setMode("unprotected")}>Agent alone</button>
            </div>
            <button className="btn primary" disabled={busy || run?.status === "running"} onClick={start}>
              {run?.status === "running" ? "Agent is shopping…" : "Send agent shopping"}
            </button>
          </div>
          {mode === "unprotected" && <p className="faint" style={{ margin: 0, fontSize: 13 }}>Agent alone pays immediately with no checks, like most agents today. Sandbox money only.</p>}
        </div>
      )}
      {run && (
        <div className="feed" aria-live="polite">
          {run.steps.map((st, i) => (
            <div key={i} className={`msg ${st.role}${/^(PAID|CHARGED) \$/.test(st.text) ? " paid" : ""}`}>
              <span className="who">{st.role === "chaperone" ? "Chaperone" : st.role === "tool" ? st.tool?.replace("_", " ") : st.role === "user" ? "You" : "Agent"}</span>
              <span className="txt">{st.text}</span>
            </div>
          ))}
          {run.status === "running" && <div className="msg"><span className="who">Agent</span><span className="txt faint">thinking…</span></div>}
        </div>
      )}
    </section>
  );
}

// ── Mandates ─────────────────────────────────────────────────
export function MandateComposer({ s, notify, compact }: { s: AppState; notify: Notify; compact?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const draft = s.mandates.find((m) => m.status === "draft" || m.status === "awaiting_paypal");
  const create = async (instruction: string) => {
    setBusy(true);
    try {
      await api("POST", "/api/mandates", { instruction });
      setText("");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (draft && compact) return <div style={{ marginTop: 12 }}><MandateDoc m={draft} notify={notify} /></div>;
  return (
    <div className="composer" style={{ marginTop: compact ? 12 : 0 }}>
      <div className="field">
        <label htmlFor="instr">What should the agent buy?</label>
        <textarea id="instr" className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Buy me one 65W USB-C charger for my laptop. Keep it under $50." />
      </div>
      <div className="presets">
        {PRESETS.map((p) => <button key={p} className="chip" onClick={() => setText(p)}>{p.split(".")[0]}</button>)}
      </div>
      <div>
        <button className="btn primary" disabled={busy || text.trim().length < 4} onClick={() => create(text.trim())}>{busy ? "Reading your request…" : "Draft the limits"}</button>
      </div>
    </div>
  );
}

export function MandatesView({ s, notify }: { s: AppState; notify: Notify }) {
  return (
    <>
      <h1 className="headline">Limits you sign once.</h1>
      <p className="lede">A mandate is your words plus the hard limits the agent can't talk its way past. You approve it in PayPal once; every purchase is checked against it.</p>
      <div className="section panel" style={{ marginTop: 32 }}>
        <MandateComposer s={s} notify={notify} />
      </div>
      <div className="section mandate-list">
        {s.mandates.map((m) => <MandateDoc key={m.id} m={m} notify={notify} purchases={s.purchases.filter((p) => p.intent.mandateId === m.id)} />)}
      </div>
    </>
  );
}

export function MandateDoc({ m, notify, purchases = [] }: { m: Mandate; notify: Notify; purchases?: Purchase[] }) {
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState({ maxPerPurchase: m.budget.maxPerPurchase, maxTotal: m.budget.maxTotal, maxQuantity: m.item.maxQuantity, autoApproveUnder: m.autoApproveUnder });
  const editable = m.status === "draft";
  const sign = async () => {
    setBusy(true);
    try {
      if (editable) await api("PATCH", `/api/mandates/${m.id}`, edit);
      const r = await api<{ approveUrl: string | null }>("POST", `/api/mandates/${m.id}/approve`);
      if (r.approveUrl) window.location.href = r.approveUrl;
      else notify("Mandate active.");
    } catch (e) {
      notify((e as Error).message, true);
      setBusy(false);
    }
  };
  const revoke = async () => {
    try {
      await api("POST", `/api/mandates/${m.id}/revoke`);
      notify("Mandate revoked. The agent can't spend against it any more.");
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  const total = m.budget.maxTotal || 1;
  const num = (k: keyof typeof edit) => (
    <input type="number" min={1} step={k === "maxQuantity" ? 1 : 0.01} value={edit[k]} aria-label={k} onChange={(e) => setEdit({ ...edit, [k]: Number(e.target.value) })} />
  );
  return (
    <article className="doc">
      <p className="words">{m.instruction}</p>
      <div>
        <div className="faint" style={{ fontSize: 13, marginBottom: 6 }}>Must have</div>
        <div className="reqs">{m.item.mustHave.length ? m.item.mustHave.map((r) => <span key={r} className="req">{r}</span>) : <span className="faint">No hard specs</span>}</div>
      </div>
      <dl className="terms num">
        <div><dt>Most per purchase</dt><dd>{editable ? num("maxPerPurchase") : usd(m.budget.maxPerPurchase)}</dd></div>
        <div><dt>Most in total</dt><dd>{editable ? num("maxTotal") : usd(m.budget.maxTotal)}</dd></div>
        <div><dt>Units</dt><dd>{editable ? num("maxQuantity") : `up to ${m.item.maxQuantity}`}</dd></div>
        <div><dt>Buy without asking under</dt><dd>{editable ? num("autoApproveUnder") : usd(m.autoApproveUnder)}</dd></div>
        <div><dt>Over market price</dt><dd>at most {m.maxOverMarketPct}%</dd></div>
        <div><dt>Expires</dt><dd>{new Date(m.expiresAt).toLocaleDateString()}</dd></div>
      </dl>
      {!editable && (
        <div>
          <div className="meter" aria-label="Budget used">
            <span style={{ width: `${(m.settled / total) * 100}%`, background: "var(--moss)" }} />
            <span style={{ width: `${(m.committed / total) * 100}%`, background: "var(--brass)" }} />
          </div>
          <p className="faint num" style={{ fontSize: 13, margin: "6px 0 0" }}>
            {usd(m.settled)} paid · {usd(m.committed)} held · {usd(Math.max(0, m.budget.maxTotal - m.settled - m.committed))} left · {purchases.length} purchase{purchases.length === 1 ? "" : "s"}
          </p>
        </div>
      )}
      <div className="seal">
        {m.status === "active" || m.status === "exhausted" ? (
          <>
            <span className="sig">Signed in PayPal{m.payerEmail ? ` by ${m.payerEmail}` : ""}</span>
            <span className={`state ${m.status === "active" ? "seller_paid" : "held"}`}>{m.status === "active" ? "Active" : "Budget used up"}</span>
            <button className="btn danger" style={{ marginLeft: "auto" }} onClick={revoke}>Revoke</button>
          </>
        ) : m.status === "revoked" ? (
          <span className="state blocked">Revoked</span>
        ) : (
          <>
            <button className="btn paypal" disabled={busy} onClick={sign}>{busy ? "Opening PayPal…" : "Approve with PayPal"}</button>
            <span className="faint" style={{ fontSize: 13 }}>One approval. Your wallet is saved for these limits only; every purchase is held until it arrives right.</span>
            <JudgeLogin />
          </>
        )}
      </div>
    </article>
  );
}

// ── Red team ─────────────────────────────────────────────────
const OUTCOME: Record<string, string> = { blocked: "Blocked at the gate", held_for_human: "Held for you", voided_after_delivery: "Voided after delivery", partial_capture: "Paid only for what arrived", held_until_confirmed: "Held until you confirm", slipped: "Slipped through", completed: "Completed" };

export function RedTeamView({ s, live, running, start }: { s: AppState; live: CaseResult[]; running: boolean; start: () => void }) {
  const rep = s.redteam;
  const cases = running ? live : rep?.cases ?? [];
  const attacks = cases.filter((c) => c.kind === "attack");
  const benign = cases.filter((c) => c.kind === "benign");
  const lost = attacks.reduce((a, c) => a + c.unprotected.moved, 0);
  const wrong = attacks.reduce((a, c) => a + (c.protected.outcome === "slipped" ? c.protected.moved : 0), 0);
  const by = (o: string) => attacks.filter((c) => c.protected.outcome === o).length;
  return (
    <>
      <h2 className="subhead">Same hijacked agent, different outcome.</h2>
      <p className="lede">
        The red team runs {s.attacks.length} attacks in the style of published research: hidden instructions, invisible Unicode, fake system messages, lookalike stores, swapped payees, bait-and-switch, fake delivery claims. We assume the agent falls for every one, then check where the money goes.
      </p>
      <div className="btn-row" style={{ marginTop: 20 }}>
        <button className="btn primary" onClick={start} disabled={running}>{running ? `Running… ${cases.length}/${s.attacks.length + 4}` : rep ? "Run it again" : "Run the red team"}</button>
        {rep && !running && <span className="faint" style={{ alignSelf: "center", fontSize: 13 }}>Last run {ago(rep.at)} · PayPal {rep.paypal} · AI {rep.ai}</span>}
      </div>
      {cases.length > 0 && (
        <>
          <div className="versus">
            <div className="side-l">
              <span className="muted">Agent alone, holding PayPal directly</span>
              <span className="big num">−{usd(lost)}</span>
              <span className="muted">captured on {attacks.filter((c) => c.unprotected.captured).length} of {attacks.length} attacks</span>
            </div>
            <div className="side-r">
              <span className="muted">Same agent through Chaperone</span>
              <span className="big num">{usd(wrong)}</span>
              <span className="muted">moved to the wrong place</span>
              <div className="breakdown num">
                <span><b>{by("blocked")}</b>blocked</span>
                <span><b>{by("held_for_human")}</b>held for you</span>
                <span><b>{by("voided_after_delivery") + by("partial_capture") + by("held_until_confirmed")}</b>caught after purchase</span>
                <span><b>{benign.filter((c) => c.protected.outcome === "completed").length}/{benign.length}</b>honest buys completed</span>
              </div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Attack</th><th>Agent alone</th><th>With Chaperone</th><th>Caught by</th><th>Gate</th></tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.kind === "benign" ? `Honest purchase: ${c.task}` : `${c.id} ${c.name}`}</b><div className="tech">{c.technique}</div></td>
                    <td className="num">{c.kind === "benign" ? <span className="faint">n/a</span> : c.unprotected.captured ? <span className="lost">−{usd(c.unprotected.moved)}</span> : <span className="faint">not run</span>}</td>
                    <td><span className={`outcome ${c.protected.outcome}`}>{OUTCOME[c.protected.outcome]}</span>{c.protected.outcome === "partial_capture" && <div className="tech num">paid {usd(c.protected.moved)} of {usd(c.amount)}</div>}</td>
                    <td className="tech">{c.protected.firstCatch ?? "Every check passed"}</td>
                    <td className="num tech">{c.protected.gateMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ── How it works ─────────────────────────────────────────────
export function HowView({ s }: { s: AppState }) {
  const caps = s.capabilities;
  const prims = useMemo(
    () => ["Vault v3 setup tokens", "Vault v3 payment tokens", "Orders v2 intent=AUTHORIZE", "Authorizations: capture", "Authorizations: partial final capture", "Authorizations: void", "Captures: refund", "Orders: add tracking", "Payouts", "Transaction Search", "Webhook signature verification", "PayPal-Request-Id idempotency"],
    [],
  );
  return (
    <>
      <h1 className="headline">The money waits until it's right.</h1>
      <p className="lede">Agents get fooled. StakeBench (2026) hijacked GPT-5 and Gemini web agents with hidden page text 42–68% of the time. Chaperone doesn't try to make the agent smarter. It makes sure a fooled agent can't move money.</p>
      <Pane title="The system, as built" hint="hover any box to see what it checks · pulses are real purchases" live className="how-map">
        <Pipeline purchases={s.purchases} />
      </Pane>
      <div className="cols">
        <div><h3>Code decides facts</h3><p>Caps, budget, quantity, specs, lookalike stores, payee identity and price vs. the same product's offers on Channel3 are plain code. Page text is never an input to an amount.</p></div>
        <div><h3>AI judges, quarantined</h3><p>A Gemini reader looks at the untrusted page and can only answer yes/no flags. A second Gemini auditor sees your words and the facts, never the page, so injected text has no path to it.</p></div>
        <div><h3>You make the close calls</h3><p>Anything over your auto-approve limit, from an unverified seller, or a bit pricey waits for one tap. Fail closed: if the AI is down, it waits for you.</p></div>
        <div><h3>PayPal holds the money</h3><p>Purchases are authorized, not captured. Sellers are paid with Payouts only after delivery checks out. Wrong item: void. Short shipment: capture only what arrived.</p></div>
      </div>
      <div className="section">
        <h2>PayPal primitives in use</h2>
        <div className="prims">{prims.map((p) => <code key={p}>{p}</code>)}</div>
        <p className="faint" style={{ fontSize: 14, marginTop: 16 }}>
          Running against: PayPal {caps.paypalClient === "sandbox" ? `sandbox (${caps.paymentMode})` : "simulator (offline demo)"} · AI {caps.gemini ? "Gemini" : "offline heuristics"} · Products {caps.channel3 ? "Channel3 live" : "offline catalog"} · {s.sellers} verified sellers
        </p>
      </div>
    </>
  );
}

/** PayPal sandbox buyer for judges. Sandbox money only; this account exists for trying the demo. */
const JUDGE = { email: "sb-1ezxw53857958@personal.example.com", password: "(#A4tDCd" };
function JudgeLogin() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (k: string, v: string) => {
    navigator.clipboard?.writeText(v).then(() => {
      setCopied(k);
      setTimeout(() => setCopied(null), 1400);
    }, () => {});
  };
  return (
    <div className="judge">
      <b>Trying it out? Log in to PayPal with this sandbox buyer</b>
      <span>Fake sandbox money. Pay with the saved Visa, not a bank.</span>
      <div className="judge-row">
        <code>{JUDGE.email}</code>
        <button className="copy" onClick={() => copy("e", JUDGE.email)}>{copied === "e" ? "Copied" : "Copy"}</button>
      </div>
      <div className="judge-row">
        <code>{JUDGE.password}</code>
        <button className="copy" onClick={() => copy("p", JUDGE.password)}>{copied === "p" ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}
