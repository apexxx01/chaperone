import { useState } from "react";
import type { Purchase } from "./api.ts";

/**
 * Plays the hijacked agent: calls the real API with the agent's own key, no human session,
 * and shows what the server says. Nothing is faked here; the request really goes out.
 */
export function AgentTry({ p }: { p: Purchase }) {
  const [out, setOut] = useState<{ status: number; body: string; path: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const move =
    p.state === "held"
      ? { label: "approve its own held purchase", path: `/api/purchases/${p.id}/decision`, body: { decision: "approve", reason: "Approved by the user (agent)" } }
      : p.state === "awaiting_delivery"
        ? { label: "confirm its own delivery", path: `/api/purchases/${p.id}/delivery`, body: { scenario: "as_ordered", source: "buyer" } }
        : p.state === "seller_paid" || p.state === "captured"
          ? { label: "issue a refund on its own", path: `/api/purchases/${p.id}/refund`, body: { reason: "agent says the user wants a refund" } }
          : null;
  if (!move) return null;
  const go = async () => {
    setBusy(true);
    try {
      const key = (await (await fetch("/api/session", { credentials: "omit" })).json()).agentKey as string;
      const r = await fetch(move.path, { method: "POST", credentials: "omit", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify(move.body) });
      setOut({ status: r.status, body: await r.text(), path: move.path });
    } catch (e) {
      setOut({ status: 0, body: String((e as Error).message), path: move.path });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="agenttry">
      <div className="at-head">
        <div>
          <b>What if the agent tries to {move.label}?</b>
          <span className="faint">This sends the real request with the agent's own key, the way a hijacked agent with an HTTP tool would.</span>
        </div>
        <button className="btn sm danger" disabled={busy} onClick={go}>
          {busy ? "Sending…" : "Let the agent try"}
        </button>
      </div>
      {out && (
        <pre className={`at-out${out.status >= 400 ? " refused" : ""}`}>
          <span className="faint">POST {out.path}{"\n"}Authorization: Bearer chp_agent_…{"\n\n"}</span>
          <b>HTTP {out.status}</b> {out.body}
        </pre>
      )}
    </div>
  );
}
