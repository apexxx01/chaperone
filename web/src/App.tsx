import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, useLive, usd } from "./api.ts";
import { ArenaView } from "./arena.tsx";
import { providerStats } from "./charts.tsx";
import { Drawer, Logo } from "./components.tsx";
import { ConsoleView } from "./console.tsx";
import { EvidenceView } from "./evidence.tsx";
import { Palette, type Command } from "./palette.tsx";
import { Tour, type TourStep } from "./tour.tsx";
import { fmtMs, Icon, Kbd, useNow, type Scope } from "./ui.tsx";
import { HowView, MandatesView, NowView, RedTeamView } from "./views.tsx";

const TABS = [
  { id: "console", label: "Control room", icon: "console", key: "1", what: "The whole system, live" },
  { id: "arena", label: "Arena", icon: "arena", key: "2", what: "Try to rob the agent" },
  { id: "now", label: "Your agent", icon: "agent", key: "3", what: "Send it shopping" },
  { id: "redteam", label: "Evidence", icon: "evidence", key: "4", what: "Every measured result" },
  { id: "mandates", label: "Mandates", icon: "mandates", key: "5", what: "Limits you sign once" },
  { id: "how", label: "How it works", icon: "how", key: "6", what: "Architecture and PayPal calls" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export function App() {
  const live = useLive();
  const { state, connected, error, liveCases, redteamRunning, setRedteamRunning, setLiveCases, lines } = live;
  const now = useNow(1000);
  const [tab, setTab] = useState<Tab>(() => (TABS.some((t) => t.id === location.hash.slice(1)) ? (location.hash.slice(1) as Tab) : "console"));
  const [openId, setOpenId] = useState<string | undefined>();
  const [sel, setSel] = useState<string | undefined>();
  const [scope, setScope] = useState<Scope>(() => {
    try {
      return (localStorage.getItem("chaperone.scope") as Scope) || "all";
    } catch {
      return "all";
    }
  });
  const [toasts, setToasts] = useState<{ id: number; m: string; err?: boolean }[]>([]);
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [touring, setTouring] = useState(() => new URLSearchParams(location.search).has("tour"));
  const [toured, setToured] = useState(() => {
    try {
      return localStorage.getItem("chaperone.toured") === "1";
    } catch {
      return true;
    }
  });
  const endTour = useCallback(() => {
    setTouring(false);
    setOpenId(undefined);
    setToured(true);
    try {
      localStorage.setItem("chaperone.toured", "1");
    } catch {}
  }, []);
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem("chaperone.theme") ?? "";
    } catch {
      return "";
    }
  });

  const notify = useCallback((m: string, err?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, m, err }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4600);
  }, []);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      localStorage.setItem("chaperone.theme", theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    try {
      localStorage.setItem("chaperone.scope", scope);
    } catch {}
  }, [scope]);
  useEffect(() => {
    history.replaceState(null, "", `${location.pathname}${location.search}#${tab}`);
    window.scrollTo({ top: 0 });
  }, [tab]);
  useEffect(() => {
    const onHash = () => {
      const t = location.hash.slice(1) as Tab;
      if (TABS.some((x) => x.id === t)) setTab(t);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("paypal") === "approved") {
      notify("Approved in PayPal. Your agent can shop within these limits.");
      setTab("now");
    }
    if (q.get("paypal") === "cancelled") notify("PayPal approval cancelled. Nothing was saved.", true);
    if (q.get("paypal")) history.replaceState(null, "", `/${location.hash}`);
  }, [notify]);

  const startRedteam = useCallback(async () => {
    setLiveCases([]);
    setRedteamRunning(true);
    try {
      await api("POST", "/api/redteam/run", {});
      notify("Red team started: 21 attacks plus honest controls, through the real gate.");
    } catch (e) {
      setRedteamRunning(false);
      notify((e as Error).message, true);
    }
  }, [notify, setLiveCases, setRedteamRunning]);

  const runDuel = useCallback(
    async (attackId: string) => {
      try {
        await api("POST", "/api/arena/duel", { task: "charger", attackId });
        notify(`Duel started with ${attackId}. Watch both agents in the Arena.`);
        setTab("arena");
      } catch (e) {
        notify((e as Error).message, true);
      }
    },
    [notify],
  );

  // Keyboard: ⌘K palette, 1-6 views, j/k through purchases, Enter opens, ? help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        return setPalette((p) => !p);
      }
      if (e.key === "Escape" && help) return setHelp(false);
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        return setPalette(true);
      }
      const t = TABS.find((x) => x.key === e.key);
      if (t) return setTab(t.id);
      if (e.key === "?") return setHelp((h) => !h);
      if (!state) return;
      const list = state.purchases;
      if (e.key === "j" || e.key === "k") {
        const i = list.findIndex((p) => p.id === sel);
        const next = e.key === "j" ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
        if (list[next]) setSel(list[next].id);
      }
      if (e.key === "Enter" && sel && el === document.body) setOpenId(sel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, sel, help]);

  const commands = useMemo<Command[]>(() => {
    if (!state) return [];
    return [
      ...TABS.map((t) => ({ id: `go-${t.id}`, group: "Go to", label: t.label, hint: t.what, run: () => setTab(t.id) })),
      ...state.arena.attacks.map((a) => ({ id: `duel-${a.id}`, group: "Run a duel", label: `${a.id} ${a.name}`, hint: a.technique, run: () => runDuel(a.id) })),
      { id: "tour", group: "Actions", label: "Take the 60-second tour", hint: "A guided walk through the live system", run: () => setTouring(true) },
      { id: "redteam", group: "Actions", label: "Run the full red team", hint: "21 attacks + honest controls through the real gate", run: () => { setTab("redteam"); void startRedteam(); } },
      { id: "theme", group: "Actions", label: theme === "light" ? "Switch to black" : "Switch to white", hint: "Theme", run: () => setTheme(theme === "light" ? "" : "light") },
      ...(["all", "mine", "arena", "redteam"] as Scope[]).map((sc) => ({ id: `scope-${sc}`, group: "Show", label: `Show ${sc === "all" ? "everything" : sc === "mine" ? "your agent" : sc === "arena" ? "Arena" : "red team"} in the control room`, run: () => { setScope(sc); setTab("console"); } })),
      ...state.purchases.slice(0, 60).map((p) => ({ id: `p-${p.id}`, group: "Purchases", label: `${p.intent.listing.title.slice(0, 60)}`, hint: `${usd(p.amount.value)} · ${p.state.replace("_", " ")} · ${p.intent.listing.merchant.domain}`, run: () => { setSel(p.id); setOpenId(p.id); } })),
    ];
  }, [state, theme, runDuel, startRedteam]);

  const tourSteps = useMemo<TourStep[]>(() => {
    if (!state) return [];
    // The most telling purchase: an attack stopped by the most independent layers.
    const layers = (p: (typeof state.purchases)[number]) => new Set(p.verdict.checks.filter((c) => c.outcome === "fail").map((c) => c.stage)).size;
    const star = [...state.purchases].filter((p) => p.state === "blocked").sort((a, b) => layers(b) - layers(a) || b.amount.value - a.amount.value)[0] ?? state.purchases[0];
    const honest = state.purchases.find((p) => p.state === "seller_paid") ?? state.purchases.find((p) => p.state === "awaiting_delivery") ?? star;
    const toConsole = () => {
      setOpenId(undefined);
      setScope("all");
      setTab("console");
      if (star) setSel(star.id);
    };
    return [
      { target: "#t-kpis", title: "This is Chaperone's control room", body: "Purchase protection for AI shopping agents, built on PayPal. Every number here is computed live from real purchases agents proposed through the PayPal sandbox. Nothing is typed in by hand.", enter: toConsole },
      { target: "#t-map", title: "Every purchase runs the real gate", body: "Signed limits, a market-price check from Channel3, an injection scanner, then two Gemini models that never talk to each other. Watch this attack fly through and get stopped.", enter: toConsole, shown: () => window.dispatchEvent(new Event("chaperone:replay")) },
      { target: "#t-trace", title: "Why it stopped, to the millisecond", body: "Each check as the server timed it. The two AI calls run side by side. Below, a hash-chained receipt that your browser re-verifies, so you don't have to trust the server.", enter: toConsole },
      { target: "#t-money", title: "Money waits in PayPal", body: "Approved purchases are only authorized, never captured, until you confirm the right item arrived. Red is money that never reached a seller.", enter: toConsole },
      { target: "#t-log", title: "The backend, call by call", body: "Every PayPal REST call, Gemini call and Channel3 search, streamed as it happens. When Gemini hits a quota limit, you see it here, and the gate fails closed: it asks you instead of guessing.", enter: toConsole },
      { target: ".drawer .whatif", title: "Change the rules, re-run the gate", body: "This purchase was paid. Drag its limits and the server re-runs the same deterministic gate on it, showing which checks flip. Here the cap drops below the price, and it would have been blocked. Nothing is saved or charged.", enter: () => { toConsole(); if (honest) setOpenId(honest.id); }, shown: () => setTimeout(() => window.dispatchEvent(new Event("chaperone:whatif-demo")), 900) },
      { target: "#t-duel", title: "Same agent, same scam, two endings", body: "One real Gemini agent shopped twice with the same poisoned search results. Alone, it paid the attacker. Through Chaperone, the money never left PayPal.", enter: () => { setOpenId(undefined); setTab("arena"); } },
      { target: "#t-heldout", title: "Attacks nobody wrote rules for", body: "After the gate was finished, a separate model invented 20 brand-new attacks. 19 were blocked, 1 was held for a human, none got money past the gate.", enter: () => { setOpenId(undefined); setTab("redteam"); } },
      { target: ".forge", title: "Now try to rob it yourself", body: "Pick an attack or write your own, then run a live duel. Press ⌘K any time to jump anywhere or open any purchase.", enter: () => { setOpenId(undefined); setTab("arena"); } },
    ];
  }, [state?.purchases.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!state) {
    return (
      <div className="boot">
        <Logo />
        <p>{error ? `Can't reach the Chaperone server: ${error}.` : "Connecting to the backend…"}</p>
      </div>
    );
  }

  const caps = state.capabilities;
  const health = providerStats(lines);
  const heldCount = state.purchases.filter((p) => p.state === "held" && !/^md_(arena|rt)_/.test(p.intent.mandateId)).length;
  const open = state.purchases.find((p) => p.id === openId);
  const here = TABS.find((t) => t.id === tab)!;
  const up = (id: "paypal" | "gemini" | "channel3", on: boolean) => {
    const h = health.find((x) => x.id === id)!;
    const err = h.recent.slice(-5).filter((l) => !l.ok).length;
    return { on, h, cls: !on ? "off" : err >= 3 ? "down" : err ? "warn" : "ok" };
  };
  const status = [
    { name: "PayPal", sub: caps.paypalClient === "sandbox" ? "sandbox" : "simulator", ...up("paypal", true) },
    { name: "Gemini", sub: caps.gemini ? "live" : "offline", ...up("gemini", caps.gemini) },
    { name: "Channel3", sub: caps.channel3 ? "live" : "fixtures", ...up("channel3", caps.channel3) },
  ];

  return (
    <MotionConfig reducedMotion="user">
      <div className="app">
        <aside className="rail" aria-label="Sections">
          <a className="brand" href="#console" onClick={(e) => { e.preventDefault(); setTab("console"); }}>
            <Logo />
            <span>Chaperone</span>
          </a>
          <nav>
            {TABS.map((t) => (
              <button key={t.id} className="nav" title={`${t.what} · press ${t.key}`} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
                {tab === t.id && <motion.i layoutId="navmark" className="navmark" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                <Icon name={t.icon} />
                <span className="nav-label">{t.label}</span>
                {t.id === "now" && heldCount > 0 && <b className="badge num" title={`${heldCount} waiting for you`}>{heldCount}</b>}
              </button>
            ))}
          </nav>
          <div className="rail-foot">
            <div className="systems" aria-label="Connected systems">
              {status.map((x) => (
                <div key={x.name} className={`sys ${x.cls}`} title={x.h.calls ? `${x.name}: median ${fmtMs(x.h.p50)} over ${x.h.calls} calls, ${x.h.errors} errors` : `${x.name}: no calls yet`}>
                  <i />
                  <span>{x.name}</span>
                  <em className="num">{x.h.calls ? fmtMs(x.h.p50) : x.sub}</em>
                </div>
              ))}
            </div>
            <button className="nav sm" onClick={() => setPalette(true)}>
              <Icon name="search" />
              <span className="nav-label">Commands</span>
              <Kbd>⌘K</Kbd>
            </button>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div className="crumb">
              <b>{here.label}</b>
              <span className="faint">{here.what}</span>
            </div>
            <div className="top-right">
              <button className={`btn sm tour-btn${toured ? "" : " fresh"}`} onClick={() => setTouring(true)}>
                <Icon name="play" size={13} /> <span>Tour</span>
              </button>
              <span className={`conn ${connected ? "on" : ""}`} title={connected ? "Streaming from the backend over SSE. The count is how many calls and steps it has logged." : "Reconnecting to the backend"}>
                <i /> {connected ? "Live" : "Reconnecting"} <span className="num faint">{lines.length ? `· ${lines.at(-1)!.seq} events` : ""}</span>
              </span>
              <span className="num clock">{new Date(now).toLocaleTimeString([], { hour12: false })}</span>
              <button className="icon-btn" onClick={() => setTheme(theme === "light" ? "" : "light")} aria-label={theme === "light" ? "Switch to black" : "Switch to white"}>
                <Icon name={theme === "light" ? "moon" : "sun"} />
              </button>
              <button className="icon-btn" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts">?</button>
            </div>
          </header>

          {caps.mode === "offline" && <div className="banner">Offline demo: payments go to a PayPal simulator with the same rules, and the AI runs on local heuristics. Add sandbox keys to run it for real.</div>}

          <AnimatePresence mode="wait">
            <motion.main key={tab} className="view" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}>
              {tab === "console" && <ConsoleView s={state} lines={lines} scope={scope} setScope={setScope} sel={sel} setSel={setSel} open={setOpenId} notify={notify} tour={() => setTouring(true)} goto={(t) => setTab(t as Tab)} />}
              {tab === "arena" && <ArenaView s={state} notify={notify} open={setOpenId} lines={lines} />}
              {tab === "now" && <NowView s={state} open={setOpenId} openId={openId} notify={notify} goto={(t) => setTab(t as Tab)} />}
              {tab === "mandates" && <MandatesView s={state} notify={notify} />}
              {tab === "redteam" && (
                <EvidenceView s={state}>
                  <RedTeamView s={state} live={liveCases} running={redteamRunning} start={startRedteam} />
                </EvidenceView>
              )}
              {tab === "how" && <HowView s={state} />}
            </motion.main>
          </AnimatePresence>

          <footer className="foot">
            <span>Chaperone: purchase protection for AI agents, built on PayPal.</span>
            <a href="https://github.com/apexxx01/chaperone">Source</a>
            <span className="faint num">{caps.paypalClient === "sandbox" ? `PayPal ${caps.paypalEnv}` : "PayPal simulator"} · sandbox money only</span>
          </footer>
        </div>

        <AnimatePresence>{open && <Drawer key={open.id} p={open} onClose={() => setOpenId(undefined)} notify={notify} />}</AnimatePresence>
        <AnimatePresence>{palette && <Palette commands={commands} onClose={() => setPalette(false)} />}</AnimatePresence>
        {touring && tourSteps.length > 0 && <Tour steps={tourSteps} onClose={endTour} />}

        <div className="toasts" aria-live="polite">
          <AnimatePresence>
            {toasts.map((t) => (
              <motion.div key={t.id} className={`toast${t.err ? " err" : ""}`} role="status" initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: 40 }} transition={{ type: "spring", stiffness: 420, damping: 32 }}>
                {t.m}
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        <AnimatePresence>
          {help && (
            <motion.div className="help" onClick={() => setHelp(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <motion.div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts" initial={{ y: 12, scale: 0.98 }} animate={{ y: 0, scale: 1 }}>
                <h2>Shortcuts</h2>
                <dl>
                  <dt><Kbd>⌘K</Kbd> or <Kbd>/</Kbd></dt><dd>Commands: jump anywhere, run a duel, open any purchase</dd>
                  <dt><Kbd>1</Kbd>–<Kbd>6</Kbd></dt><dd>Switch view</dd>
                  <dt><Kbd>j</Kbd> <Kbd>k</Kbd></dt><dd>Select next / previous purchase</dd>
                  <dt><Kbd>Enter</Kbd></dt><dd>Open the selected purchase's receipts</dd>
                  <dt><Kbd>Esc</Kbd></dt><dd>Close</dd>
                </dl>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
