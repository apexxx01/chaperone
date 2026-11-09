import { useCallback, useEffect, useState } from "react";
import { api, useLive } from "./api.ts";
import { Drawer, Logo } from "./components.tsx";
import { HowView, MandatesView, NowView, RedTeamView } from "./views.tsx";

const TABS = [
  { id: "now", label: "Now", key: "1" },
  { id: "mandates", label: "Mandates", key: "2" },
  { id: "redteam", label: "Red team", key: "3" },
  { id: "how", label: "How it works", key: "4" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const TOUR = [
  { t: "Say what you want", d: "Type a request like “one 65W USB-C charger under $50”. Chaperone turns it into hard limits you approve once in PayPal." },
  { t: "Let the agent shop", d: "The Gemini agent searches real products on Channel3 and proposes a purchase. Plant an attack to see it get fooled." },
  { t: "Watch the money", d: "Each purchase is a lane. The coin shows where your money is: held in PayPal, paid to the seller, or stopped." },
  { t: "Check the receipts", d: "Open any purchase for every check, the numbers behind it, and the PayPal ids. Press ? for shortcuts." },
];

export function App() {
  const { state, connected, error, liveCases, redteamRunning, setRedteamRunning, setLiveCases } = useLive();
  const [tab, setTab] = useState<Tab>(() => (location.hash.slice(1) as Tab) || "now");
  const [openId, setOpenId] = useState<string | undefined>();
  const [toast, setToast] = useState<{ m: string; err?: boolean } | null>(null);
  const [help, setHelp] = useState(false);
  const [tour, setTour] = useState<number | null>(() => {
    try {
      return localStorage.getItem("chaperone.tour") ? null : 0;
    } catch {
      return null;
    }
  });
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem("chaperone.theme") ?? "";
    } catch {
      return "";
    }
  });

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("chaperone.theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    history.replaceState(null, "", `${location.pathname}${location.search}#${tab}`);
  }, [tab]);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("paypal") === "approved") notify("Approved in PayPal. Your agent can shop within these limits.");
    if (q.get("paypal") === "cancelled") notify("PayPal approval cancelled. Nothing was saved.", true);
    if (q.get("paypal")) history.replaceState(null, "", `/${location.hash}`);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const notify = useCallback((m: string, err?: boolean) => setToast({ m, err }), []);

  const startRedteam = useCallback(async () => {
    setLiveCases([]);
    setRedteamRunning(true);
    try {
      await api("POST", "/api/redteam/run", {});
    } catch (e) {
      setRedteamRunning(false);
      notify((e as Error).message, true);
    }
  }, [notify, setLiveCases, setRedteamRunning]);

  // Keyboard: 1-4 tabs, j/k move through purchases, a/d decide the first held purchase, ? help.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = TABS.find((x) => x.key === e.key);
      if (t) return setTab(t.id);
      if (e.key === "?") return setHelp((h) => !h);
      if (!state) return;
      const list = state.purchases;
      if (e.key === "j" || e.key === "k") {
        const i = list.findIndex((p) => p.id === openId);
        const next = e.key === "j" ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
        if (list[next]) setOpenId(list[next].id);
      }
      const held = list.find((p) => p.state === "held");
      if (held && (e.key === "a" || e.key === "d")) {
        try {
          await api("POST", `/api/purchases/${held.id}/decision`, { decision: e.key === "a" ? "approve" : "deny" });
          notify(e.key === "a" ? "Approved. Funds held in PayPal until delivery." : "Declined. Nothing was charged.");
        } catch (err) {
          notify((err as Error).message, true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, openId, notify]);

  const finishTour = () => {
    setTour(null);
    try {
      localStorage.setItem("chaperone.tour", "done");
    } catch {}
  };

  if (!state) {
    return (
      <div className="shell">
        <header className="top"><a className="brand" href="/"><Logo />Chaperone</a></header>
        <p className="muted">{error ? `Can't reach the Chaperone server: ${error}. Start it with npm run dev.` : "Loading…"}</p>
      </div>
    );
  }
  const caps = state.capabilities;
  const heldCount = state.purchases.filter((p) => p.state === "held").length;
  const open = state.purchases.find((p) => p.id === openId);

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="/" onClick={(e) => { e.preventDefault(); setTab("now"); }}><Logo />Chaperone</a>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "now" && heldCount > 0 && <span className="count">{heldCount}</span>}
            </button>
          ))}
        </nav>
        <div className="top-right">
          <span className={`wire ${caps.paypalClient === "sandbox" ? "live" : "sim"}`} title="Where payments go"><i />PayPal {caps.paypalClient === "sandbox" ? "sandbox" : "simulator"}</span>
          <span className={`wire ${caps.gemini ? "live" : "sim"}`}><i />{caps.gemini ? "Gemini" : "Offline AI"}</span>
          <span className={`wire ${caps.channel3 ? "live" : "sim"}`}><i />{caps.channel3 ? "Channel3" : "Offline catalog"}</span>
          {!connected && <span className="wire"><i />Reconnecting</span>}
          <button className="icon-btn" onClick={() => setTheme(theme === "dark" ? "light" : theme === "light" ? "" : "dark")} aria-label="Switch theme">{theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Auto"}</button>
          <button className="icon-btn" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">?</button>
        </div>
      </header>

      {caps.mode === "offline" && <div className="banner">Offline demo: payments go to a PayPal simulator with the same rules, and the AI runs on local heuristics. Add sandbox keys to run it for real.</div>}

      <main>
        {tab === "now" && <NowView s={state} open={setOpenId} openId={openId} notify={notify} goto={(t) => setTab(t as Tab)} />}
        {tab === "mandates" && <MandatesView s={state} notify={notify} />}
        {tab === "redteam" && <RedTeamView s={state} live={liveCases} running={redteamRunning} start={startRedteam} />}
        {tab === "how" && <HowView s={state} />}
      </main>

      <footer className="foot">
        <span>Chaperone, purchase protection for AI agents, built on PayPal.</span>
        <a href="https://github.com/apexxx01/chaperone">Source</a>
        <button className="copy" onClick={() => setTour(0)}>Take the tour</button>
      </footer>

      {open && <Drawer p={open} onClose={() => setOpenId(undefined)} notify={notify} />}
      {toast && <div className={`toast${toast.err ? " err" : ""}`} role="status">{toast.m}</div>}
      {help && (
        <div className="help" onClick={() => setHelp(false)}>
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
            <h2>Shortcuts</h2>
            <dl>
              <dt><kbd>1</kbd>–<kbd>4</kbd></dt><dd>Switch section</dd>
              <dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next / previous purchase</dd>
              <dt><kbd>a</kbd></dt><dd>Approve the purchase that needs you</dd>
              <dt><kbd>d</kbd></dt><dd>Decline it</dd>
              <dt><kbd>Esc</kbd></dt><dd>Close receipts</dd>
              <dt><kbd>?</kbd></dt><dd>Show this</dd>
            </dl>
          </div>
        </div>
      )}
      {tour != null && (
        <div className="tour" role="dialog" aria-label="Tour">
          <span className="steps">{tour + 1} of {TOUR.length}</span>
          <h3>{TOUR[tour]!.t}</h3>
          <p>{TOUR[tour]!.d}</p>
          <div className="btn-row">
            {tour < TOUR.length - 1 ? <button className="btn" onClick={() => setTour(tour + 1)}>Next</button> : <button className="btn" onClick={finishTour}>Start</button>}
            <button className="btn ghost" onClick={finishTour}>Skip</button>
          </div>
        </div>
      )}
    </div>
  );
}
