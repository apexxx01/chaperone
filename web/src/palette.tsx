import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./ui.tsx";

export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** Subsequence match with a bonus for word starts, so "rt" finds "Run the red team". */
function score(q: string, s: string): number {
  if (!q) return 1;
  const a = q.toLowerCase(), b = s.toLowerCase();
  if (b.includes(a)) return 100 - b.indexOf(a);
  let i = 0, sc = 0, last = -2;
  for (let j = 0; j < b.length && i < a.length; j++) {
    if (b[j] === a[i]) {
      sc += last === j - 1 ? 3 : /[\s\-(]/.test(b[j - 1] ?? " ") ? 4 : 1;
      last = j;
      i++;
    }
  }
  return i === a.length ? sc : 0;
}

export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(
    () =>
      commands
        // Duels spend shared AI quota and start real runs, so they rank below looking things up.
        .map((c) => ({ c, s: Math.max(score(q, c.label), score(q, c.hint ?? "") * 0.6, score(q, c.group) * 0.3) * (c.group === "Run a duel" ? 0.55 : 1) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => (q ? b.s - a.s : 0))
        .slice(0, 40)
        .map((x) => x.c),
    [q, commands],
  );
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setI(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  }, [i]);
  const go = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };
  let lastGroup = "";
  return (
    <motion.div className="palette-back" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
      <motion.div
        className="palette"
        role="dialog"
        aria-label="Commands"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: -12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -8, scale: 0.98 }}
        transition={{ type: "spring", stiffness: 520, damping: 36 }}
      >
        <div className="pal-input">
          <Icon name="search" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Jump to a view, run a duel, find a purchase…"
            aria-label="Search commands"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setI((x) => Math.min(shown.length - 1, x + 1)));
              if (e.key === "ArrowUp") (e.preventDefault(), setI((x) => Math.max(0, x - 1)));
              if (e.key === "Enter") go(shown[i]);
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <ul ref={list} className="pal-list" role="listbox">
          {shown.map((c, n) => {
            const head = c.group !== lastGroup ? (lastGroup = c.group) : null;
            return (
              <li key={c.id} role="presentation">
                {head && !q && <span className="pal-group">{head}</span>}
                <button role="option" aria-selected={n === i} data-i={n} className="pal-item" onMouseMove={() => setI(n)} onClick={() => go(c)}>
                  <span>{c.label}</span>
                  {c.hint && <em>{c.hint}</em>}
                </button>
              </li>
            );
          })}
          {!shown.length && <li className="pal-empty">Nothing matches “{q}”.</li>}
        </ul>
        <div className="pal-foot faint">
          <span>↑↓ to move</span>
          <span>Enter to run</span>
          <span>Esc to close</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
