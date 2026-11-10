import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, clock, usd, type Check, type Purchase } from "./api.ts";

// ── Money lane ───────────────────────────────────────────────
const STOPS = ["Proposed", "Checked", "Held", "Delivered", "Paid"] as const;

export function coinFor(p: Purchase): { at: number; kind: "waiting" | "stopped" | "paid" | "moving"; label: string } {
  switch (p.state) {
    case "proposed": return { at: 0, kind: "moving", label: "Checking" };
    case "blocked": return { at: 1, kind: "stopped", label: "Blocked" };
    case "held": return { at: 1, kind: "waiting", label: "Needs you" };
    case "denied": return { at: 1, kind: "stopped", label: "You declined" };
    case "failed": return { at: 2, kind: "stopped", label: "PayPal error" };
    case "authorized":
    case "awaiting_delivery": return { at: 2, kind: "waiting", label: "Held in PayPal" };
    case "verifying": return { at: 3, kind: "moving", label: "Verifying" };
    case "voided": return { at: 3, kind: "stopped", label: "Voided" };
    case "captured": return { at: 3.5, kind: "moving", label: "Captured" };
    case "seller_paid": return { at: 4, kind: "paid", label: p.paypal.capturedAmount != null && p.paypal.capturedAmount < p.amount.value ? "Paid in part" : "Seller paid" };
    case "refunded": return { at: 4, kind: "stopped", label: "Refunded" };
  }
}

export function Lane({ p, current, onOpen }: { p: Purchase; current?: boolean; onOpen: () => void }) {
  const coin = coinFor(p);
  const left = `calc(6px + (100% - 12px) * ${coin.at / 4})`;
  const l = p.intent.listing;
  return (
    <button className="lane" aria-current={current} onClick={onOpen} aria-label={`${l.title}, ${usd(p.amount.value)}, ${coin.label}`}>
      <span className="lane-what">
        {l.imageUrl ? <img src={l.imageUrl} alt="" loading="lazy" /> : <span className="ph">{(l.brand ?? l.merchant.domain).slice(0, 1).toUpperCase()}</span>}
        <span className="t">
          <b>{l.title}</b>
          <span>
            {p.intent.quantity}× from {l.merchant.domain}
          </span>
        </span>
      </span>
      <span className="track" aria-hidden>
        {STOPS.map((s, i) => (
          <span key={s} className={`stop${i <= coin.at ? " done" : ""}${Math.floor(coin.at) === i ? " here" : ""}`}>
            <span className="dot" />
            <span className="lbl">{s}</span>
          </span>
        ))}
        <span className={`coin ${coin.kind}`} style={{ left }}>$</span>
      </span>
      <span className="lane-amt num">
        {usd(p.paypal.capturedAmount ?? p.amount.value)}
        <small>{coin.label}</small>
      </span>
    </button>
  );
}

// ── Purchase drawer (receipts) ───────────────────────────────
const STAGE_NAME: Record<string, string> = { mandate: "Mandate", policy: "Policy", market: "Market price", scanner: "Scanner", auditor: "AI auditor", human: "You", delivery: "Delivery" };

export function CheckRow({ c }: { c: Check }) {
  const data = c.data ? Object.entries(c.data).filter(([, v]) => v !== null && v !== "" && typeof v !== "boolean") : [];
  return (
    <div className={`check ${c.outcome}`}>
      <span className="mark" aria-label={c.outcome}>{c.outcome === "pass" ? "✓" : c.outcome === "warn" ? "!" : "×"}</span>
      <span>
        <b>{c.title}</b>
        <p>{c.detail}</p>
        {data.length > 0 && (
          <span className="data num">
            {data.slice(0, 6).map(([k, v]) => (
              <span key={k}>
                {k}: {String(v)}
              </span>
            ))}
          </span>
        )}
      </span>
      <span className="stage">
        {STAGE_NAME[c.stage] ?? c.stage}
        {c.ms != null && c.ms > 0 ? <><br />{c.ms} ms</> : null}
      </span>
    </div>
  );
}

export function Drawer({ p, onClose, notify }: { p: Purchase; onClose: () => void; notify: (m: string, err?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<string | undefined>();
  const pickPhoto = (f?: File) => {
    if (!f) return setPhoto(undefined);
    if (f.size > 5_000_000) return notify("That photo is over 5 MB. Pick a smaller one.", true);
    const r = new FileReader();
    r.onload = () => setPhoto(String(r.result));
    r.readAsDataURL(f);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      notify(ok);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const sorted = [...p.verdict.checks].sort((a, b) => rank(a.outcome) - rank(b.outcome));
  const l = p.intent.listing;
  return (
    <>
      <motion.div className="drawer-back" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      <motion.aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 36 }}>
        <div className="drawer-head">
          <div>
            <span className={`state ${p.state}`}>{coinFor(p).label}</span>
            <h2 id="drawer-title" style={{ marginTop: 8 }}>{l.title}</h2>
            <p className="muted" style={{ margin: "4px 0 0" }}>
              {p.intent.quantity}× at {usd(l.price)} from <b>{l.merchant.domain}</b> · proposed by {p.intent.agent}
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">Esc</button>
        </div>

        <div className={`verdict ${p.verdict.decision}`}>{p.deliveryVerdict?.headline ?? p.verdict.headline}</div>

        {p.state === "held" && (
          <div className="btn-row" style={{ marginBottom: 16 }}>
            <button className="btn approve" disabled={busy} onClick={() => act(() => api("POST", `/api/purchases/${p.id}/decision`, { decision: "approve" }), "Approved. Funds are held in PayPal until delivery.")}>Approve and hold funds</button>
            <button className="btn danger" disabled={busy} onClick={() => act(() => api("POST", `/api/purchases/${p.id}/decision`, { decision: "deny" }), "Declined. Nothing was charged.")}>Decline</button>
          </div>
        )}
        {p.state === "awaiting_delivery" && (
          <div className="panel" style={{ marginBottom: 16 }}>
            <h3>What showed up?</h3>
            <p className="muted" style={{ margin: "4px 0 12px", fontSize: 14 }}>Only your word releases the money. Add a photo of the item or its label and Gemini checks it against the order.</p>
            <div className="field" style={{ marginBottom: 12 }}>
              <label htmlFor="proof">Proof photo (optional)</label>
              <input id="proof" className="input" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pickPhoto(e.target.files?.[0])} />
              {photo && <span className="faint" style={{ fontSize: 13 }}>Photo ready. It is checked once and only its fingerprint is kept.</span>}
            </div>
            <div className="btn-row">
              <button className="btn approve" disabled={busy} onClick={() => act(() => api("POST", `/api/purchases/${p.id}/delivery`, { scenario: "as_ordered", photo }), "Checked what arrived.")}>It arrived as ordered</button>
              <button className="btn" disabled={busy} onClick={() => act(() => api("POST", `/api/purchases/${p.id}/delivery`, { scenario: "wrong_item", photo }), "Wrong item reported.")}>Wrong item arrived</button>
              {p.intent.quantity > 1 && <button className="btn" disabled={busy} onClick={() => act(() => api("POST", `/api/purchases/${p.id}/delivery`, { scenario: "short", photo }), "Short shipment reported.")}>One unit missing</button>}
            </div>
            <p className="faint" style={{ margin: "14px 0 6px", fontSize: 13 }}>Or play the other side:</p>
            <button className="btn" disabled={busy} onClick={() => act(() => api("POST", `/api/purchases/${p.id}/delivery`, { scenario: "as_ordered", source: "seller" }), "Seller's claim recorded. Funds stay held.")}>Seller claims it was delivered</button>
          </div>
        )}
        {(p.state === "seller_paid" || p.state === "captured") && (
          <div className="btn-row" style={{ marginBottom: 16 }}>
            <button className="btn" disabled={busy} onClick={() => act(() => api("POST", `/api/purchases/${p.id}/refund`, { reason: "Returned by buyer" }), "Refunded through PayPal.")}>Refund through PayPal</button>
          </div>
        )}

        {p.deliveryVerdict && (
          <section className="section" style={{ marginTop: 24 }}>
            <h3 style={{ marginBottom: 10 }}>What arrived</h3>
            <div className="checks">{p.deliveryVerdict.checks.map((c, i) => <CheckRow key={i} c={c} />)}</div>
          </section>
        )}

        <section className="section" style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 10 }}>Why ({p.verdict.checks.length} checks, {p.verdict.ms} ms)</h3>
          <div className="checks">{sorted.map((c, i) => <CheckRow key={i} c={c} />)}</div>
        </section>

        <section className="section" style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 10 }}>Timeline</h3>
          <ol className="timeline">
            {p.timeline.map((e, i) => (
              <li key={i}>
                <time>{clock(e.at)}</time>
                <span>
                  {e.label}
                  {e.detail && <span className="faint" style={{ display: "block", fontSize: 13, overflowWrap: "anywhere" }}>{e.detail}</span>}
                </span>
                <span className="ms num">{e.ms != null ? `${e.ms} ms` : ""}</span>
              </li>
            ))}
          </ol>
        </section>

        <ChainBadge p={p} />

        <section className="section" style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 10 }}>PayPal receipts</h3>
          <dl className="ids">
            <Id k="Order" v={p.paypal.orderId} />
            <Id k="Authorization" v={p.paypal.authorizationId} />
            <Id k="Capture" v={p.paypal.captureId} />
            <Id k="Payout batch" v={p.paypal.payoutBatchId} />
            <Id k="Refund" v={p.paypal.refundId} />
            <Id k="Debug ids" v={p.paypal.debugIds.join(", ") || undefined} />
          </dl>
          {!p.paypal.orderId && <p className="faint" style={{ fontSize: 14 }}>No PayPal call was made. Nothing was authorized or charged.</p>}
        </section>

        <section className="section" style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 6 }}>What the agent read</h3>
          <p className="faint" style={{ fontSize: 13, margin: "0 0 8px" }}>Untrusted. The AI auditor never sees this; only the quarantined reader does.</p>
          <pre style={{ whiteSpace: "pre-wrap", font: "13px/1.5 var(--text)", background: "var(--surface)", padding: 12, borderRadius: 10, margin: 0, maxHeight: 220, overflow: "auto", overflowWrap: "anywhere" }}>{reveal(l.pageText)}</pre>
          <p className="faint" style={{ fontSize: 13 }}>Agent's reason: {p.intent.agentRationale}</p>
        </section>
      </motion.aside>
    </>
  );
}

const GENESIS = "chaperone:v1";
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
/** Re-computes the purchase's hash chain here in the browser, so the server's word isn't taken for it. */
export async function verifyChain(p: Purchase): Promise<{ ok: boolean; head: string; brokenAt?: number }> {
  let prev = await sha(`${GENESIS}\n${p.intent.createdAt}\ngenesis\n${p.id}\n${p.intent.id}`);
  for (let i = 0; i < p.timeline.length; i++) {
    const e = p.timeline[i]!;
    const want = await sha(`${prev}\n${e.at}\n${e.kind}\n${e.label}\n${e.detail ?? ""}`);
    if (e.hash !== want) return { ok: false, head: e.hash ?? "", brokenAt: i };
    prev = want;
  }
  return { ok: true, head: prev };
}

function ChainBadge({ p }: { p: Purchase }) {
  const [v, setV] = useState<{ ok: boolean; head: string; brokenAt?: number } | null>(null);
  useEffect(() => {
    let live = true;
    setV(null);
    if (!crypto?.subtle) return;
    void verifyChain(p).then((r) => live && setV(r));
    return () => { live = false; };
  }, [p.id, p.timeline.length]);
  if (!v) return null;
  return (
    <div className={`chain ${v.ok ? "ok" : "bad"}`}>
      <b>{v.ok ? "Receipt verified in your browser" : `Receipt chain broken at event ${(v.brokenAt ?? 0) + 1}`}</b>
      <span className="num">{v.ok ? `${p.timeline.length} events, each SHA-256 chained to the one before. Head ${v.head.slice(0, 16)}…` : "An event in this purchase's history was changed after it was written."}</span>
      <a href={`/api/purchases/${p.id}/receipt`} target="_blank" rel="noreferrer">Download the signed-chain receipt (JSON)</a>
    </div>
  );
}

function Id({ k, v }: { k: string; v?: string }) {
  if (!v) return null;
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
      <button className="copy" onClick={() => void navigator.clipboard?.writeText(v)}>Copy</button>
    </>
  );
}

const rank = (o: string) => (o === "fail" ? 0 : o === "warn" ? 1 : 2);

/** Show hidden text in brackets so a human can see what the model saw. */
export function reveal(s: string): string {
  let out = "";
  let hidden = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) hidden += String.fromCodePoint(cp - 0xe0000);
    else {
      if (hidden) {
        out += `⟦hidden: ${hidden}⟧`;
        hidden = "";
      }
      out += /[​-‏⁠-⁤﻿]/.test(ch) ? "·" : ch;
    }
  }
  if (hidden) out += `⟦hidden: ${hidden}⟧`;
  return out;
}

export function Logo() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden>
      <rect width="64" height="64" fill="var(--ink)" />
      <path d="M14 14h36v8H22v20h28v8H14z" fill="var(--paper)" />
      <rect x="38" y="27" width="12" height="10" fill="var(--signal)" />
    </svg>
  );
}
