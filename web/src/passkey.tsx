import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { PasskeyAsk } from "./api.ts";

/**
 * "Confirm it's you." Shown when a money action needs a person. The browser's own passkey prompt
 * (Touch ID, Face ID, Windows Hello, a phone or a security key) does the proving; an agent can't.
 */
export function PasskeyGate() {
  const [ask, setAsk] = useState<PasskeyAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      setErr(null);
      setAsk((e as CustomEvent<PasskeyAsk>).detail);
    };
    window.addEventListener("chaperone:passkey", on);
    return () => window.removeEventListener("chaperone:passkey", on);
  }, []);
  const done = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
    setBusy(false);
  };
  const post = async (path: string, body: unknown) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error ?? `Request failed (${r.status})`), { code: j.code });
    return j;
  };
  const register = async () => {
    const opts = await post("/api/passkey/register/options", {});
    const res = await startRegistration({ optionsJSON: opts });
    await post("/api/passkey/register/verify", res);
  };
  const authenticate = async () => {
    try {
      const opts = await post("/api/passkey/auth/options", {});
      const res = await startAuthentication({ optionsJSON: opts });
      await post("/api/passkey/auth/verify", res);
    } catch (e) {
      // The server forgot this browser's passkey (e.g. a fresh deploy): make a new one instead.
      if ((e as { code?: string }).code === "no_passkey") return register();
      throw e;
    }
  };
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!window.PublicKeyCredential) throw new Error("This browser can't use passkeys. Try Chrome, Safari, Edge or Firefox on a device with a screen lock.");
      await (ask!.registered ? authenticate() : register());
      done(true);
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      setErr(/NotAllowed|cancel|abort|timed out/i.test(m) ? "The passkey prompt was closed. Nothing moved." : m);
      setBusy(false);
    }
  };
  return (
    <AnimatePresence>
      {ask && (
        <motion.div className="pk-back" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !busy && done(false)}>
          <motion.div className="pk" role="dialog" aria-labelledby="pk-t" onClick={(e) => e.stopPropagation()} initial={{ y: 14, scale: 0.97, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 420, damping: 32 }}>
            <div className="pk-icon" aria-hidden>
              <svg viewBox="0 0 48 48" width="44" height="44"><circle cx="24" cy="24" r="22" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 4" /><path d="M24 12a8 8 0 0 0-8 8v4h16v-4a8 8 0 0 0-8-8Z" fill="none" stroke="currentColor" strokeWidth="2" /><rect x="13" y="23" width="22" height="14" rx="3" fill="currentColor" /><circle cx="24" cy="30" r="2" fill="var(--bg)" /></svg>
            </div>
            <h2 id="pk-t">Confirm it's you</h2>
            <p>{ask.why}</p>
            <p className="faint">Moving money needs a person, not an agent. Your device's passkey (Touch ID, Face ID, Windows Hello, your phone or a security key) proves you're here. It unlocks money actions in this browser for 10 minutes.</p>
            {err && <p className="pk-err">{err}</p>}
            <div className="pk-row">
              <button className="btn ghost" disabled={busy} onClick={() => done(false)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={go} autoFocus>
                <span>{busy ? "Waiting for your device…" : ask.registered ? "Use my passkey" : "Create a passkey"}</span>
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
