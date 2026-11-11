import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui.tsx";

export interface TourStep {
  target: string;
  title: string;
  body: string;
  /** Runs when the step opens: switch view, select a purchase, open the drawer. */
  enter?: () => void;
  /** Runs once the target is in view (e.g. start a replay). */
  shown?: () => void;
}

const DWELL = 9000;

/** A guided walk through the live system. Spotlights real panels; nothing here is a recording. */
export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [paused, setPaused] = useState(false);
  const [t, setT] = useState(0);
  const step = steps[i]!;
  const last = i === steps.length - 1;
  const raf = useRef(0);

  // Enter the step, then find and frame its target.
  useEffect(() => {
    step.enter?.();
    setRect(null);
    setT(0);
    let found: Element | null = null;
    let shownFired = false;
    const t0 = performance.now();
    const loop = () => {
      const el = document.querySelector(step.target);
      if (el && el !== found) {
        found = el;
        el.scrollIntoView({ behavior: "smooth", block: el.getBoundingClientRect().height > innerHeight * 0.7 ? "start" : "center" });
      }
      if (found) {
        const r = found.getBoundingClientRect();
        setRect((old) => (old && Math.abs(old.top - r.top) < 0.5 && Math.abs(old.left - r.left) < 0.5 && Math.abs(old.height - r.height) < 0.5 && Math.abs(old.width - r.width) < 0.5 ? old : r));
        if (!shownFired && performance.now() - t0 > 1100) {
          shownFired = true;
          step.shown?.();
        }
      }
      raf.current = requestAnimationFrame(loop);
    };
    const start = setTimeout(loop, 380);
    return () => {
      clearTimeout(start);
      cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // Auto-advance, pausable.
  useEffect(() => {
    if (paused || !rect) return;
    const id = setInterval(() => setT((x) => x + 100), 100);
    return () => clearInterval(id);
  }, [paused, rect]);
  useEffect(() => {
    if (t >= DWELL && !last) setI((x) => x + 1);
  }, [t, last]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "Enter") (e.preventDefault(), e.stopImmediatePropagation(), last ? onClose() : setI((x) => x + 1));
      else if (e.key === "ArrowLeft") (e.preventDefault(), e.stopImmediatePropagation(), setI((x) => Math.max(0, x - 1)));
      else if (e.key === "Escape") (e.stopImmediatePropagation(), onClose());
      else if (e.key === " ") (e.preventDefault(), e.stopImmediatePropagation(), setPaused((p) => !p));
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [last, onClose]);

  const pad = 8;
  const box = rect && {
    top: Math.max(4, rect.top - pad),
    left: Math.max(4, rect.left - pad),
    width: Math.min(innerWidth - 8, rect.width + pad * 2),
    height: Math.min(innerHeight - 8, rect.height + pad * 2),
  };
  // Put the card where it covers the least of the spotlight.
  const below = box ? box.top + box.height < innerHeight - 230 : true;
  const above = box ? box.top > 230 : false;
  const W = 516;
  const place = below && box ? "below" : above ? "above" : box && box.left > W + 24 ? "left" : box && innerWidth - box.left - box.width > W + 24 ? "right" : "corner";
  const posStyle: React.CSSProperties | undefined =
    place === "below" && box ? { top: Math.min(innerHeight - 230, box.top + box.height + 14) }
    : place === "above" && box ? { top: box.top - 14 }
    : place === "left" && box ? { left: box.left - W - 14, bottom: 24 }
    : place === "right" && box ? { left: box.left + box.width + 14, bottom: 24 }
    : undefined;

  return (
    <div className="tour" aria-live="polite">
      <AnimatePresence>
        {box && (
          <motion.div
            className="tour-spot"
            initial={{ opacity: 0, ...box }}
            animate={{ opacity: 1, ...box }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 32 }}
          />
        )}
      </AnimatePresence>
      {!box && <div className="tour-dim" />}
      <div className={`tour-pos at-${place}`} style={posStyle}>
      <motion.div
        key={i}
        className="tour-card"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        role="dialog"
        aria-label={`Tour step ${i + 1} of ${steps.length}`}
      >
        <div className="tour-top">
          <span className="num faint">
            {String(i + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
          </span>
          <div className="tour-dots">
            {steps.map((_, n) => (
              <button key={n} className={n === i ? "on" : n < i ? "done" : ""} onClick={() => setI(n)} aria-label={`Go to step ${n + 1}`} />
            ))}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="End tour">
            <Icon name="close" size={14} />
          </button>
        </div>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
        <div className="tour-foot">
          <button className="btn sm ghost" disabled={i === 0} onClick={() => setI((x) => x - 1)}>
            Back
          </button>
          <span className="faint tour-hint">{paused ? "Paused" : last ? "" : "← → to move · space to pause"}</span>
          <button className="btn sm primary" onClick={() => (last ? onClose() : setI((x) => x + 1))}>
            <span>{last ? "Try it yourself" : "Next"}</span> <Icon name="arrow" size={14} />
          </button>
        </div>
        {!last && <i className="tour-prog" style={{ transform: `scaleX(${Math.min(1, t / DWELL)})` }} />}
      </motion.div>
      </div>
    </div>
  );
}
