import { useEffect, useRef } from "react";
import type { Purchase } from "./api.ts";

/**
 * The gate, drawn in 3D and driven by real purchases. Each purchase flies down a corridor of seven
 * frames (one per layer). It stops, in red, at the layer that caught it; waits at the PayPal frame
 * while funds are held; or passes the delivery frame once the seller is paid. Move the pointer to
 * look around. With reduced motion it draws one still frame.
 */
const FRAMES = ["Mandate", "Policy", "Market", "Scanner", "AI auditor", "PayPal hold", "Delivery"] as const;
const STAGE_INDEX: Record<string, number> = { mandate: 0, policy: 1, market: 2, scanner: 3, auditor: 4, human: 4, delivery: 6 };

export interface Flight {
  id: string;
  /** Frame index where the purchase ends, or 7 when it passes everything. */
  end: number;
  fate: "blocked" | "held" | "paid" | "waiting";
  amount: number;
}

export function flightOf(p: Purchase): Flight {
  const amount = p.amount.value;
  if (p.state === "blocked" || p.state === "denied" || p.state === "failed") {
    const c = p.verdict.checks.find((x) => x.outcome === "fail") ?? p.verdict.checks.find((x) => x.outcome === "warn");
    return { id: p.id, end: STAGE_INDEX[c?.stage ?? "policy"] ?? 1, fate: "blocked", amount };
  }
  if (p.state === "held") return { id: p.id, end: 4, fate: "waiting", amount };
  if (p.state === "voided" || p.state === "refunded") return { id: p.id, end: 6, fate: "blocked", amount };
  if (p.state === "seller_paid" || p.state === "captured") return { id: p.id, end: 7, fate: "paid", amount };
  return { id: p.id, end: 5, fate: "held", amount };
}

interface Mote extends Flight {
  x: number;
  y: number;
  z: number;
  t: number;
  done: number;
}

export function GateField({ purchases, height = 380 }: { purchases: Purchase[]; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const data = useRef<Flight[]>([]);
  const fresh = useRef<Flight[]>([]);
  const seen = useRef<Set<string> | null>(null);

  // Keep the replay list current, and queue brand-new purchases to fly immediately.
  useEffect(() => {
    const flights = purchases.slice(0, 60).map(flightOf);
    if (seen.current) for (const f of flights) if (!seen.current.has(`${f.id}:${f.fate}`)) fresh.current.push(f);
    seen.current = new Set(flights.map((f) => `${f.id}:${f.fate}`));
    data.current = flights;
  }, [purchases]);

  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext("2d")!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let w = 0, h = 0;
    // Mostly side-on, so the seven frames read left to right like a sentence.
    const YAW = 1.02, PITCH = 0.2;
    let yaw = YAW, pitch = PITCH, tyaw = yaw, tpitch = pitch;
    let motes: Mote[] = [];
    let cursor = 0;
    let lastSpawn = 0;
    const GAP = 2.05;
    const zOf = (i: number) => 1.2 + i * GAP;

    const size = () => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      w = r.width;
      h = r.height;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(size);
    ro.observe(cv);
    size();

    const onMove = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      tyaw = YAW + ((e.clientX - r.left) / r.width - 0.5) * 0.45;
      tpitch = PITCH + ((e.clientY - r.top) / r.height - 0.5) * 0.3;
    };
    cv.addEventListener("pointermove", onMove);
    const onLeave = () => { tyaw = YAW; tpitch = PITCH; };
    cv.addEventListener("pointerleave", onLeave);

    const project = (x: number, y: number, z: number) => {
      // Rotate around the middle of the corridor, then perspective-project.
      const zc = z - zOf(3);
      const x1 = x * Math.cos(yaw) + zc * Math.sin(yaw);
      const z1 = -x * Math.sin(yaw) + zc * Math.cos(yaw);
      const y1 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
      const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch) + 15;
      const f = Math.min(w * 1.02, h * 3.3);
      return { sx: w * 0.5 + (x1 * f) / z2, sy: h * 0.52 + (y1 * f) / z2, k: f / z2 };
    };

    const spawn = (f: Flight) => motes.push({ ...f, x: (Math.random() - 0.5) * 1.3, y: (Math.random() - 0.5) * 1.1, z: -1.2, t: 0, done: 0 });

    const draw = (now: number) => {
      const css = getComputedStyle(cv);
      const ink = css.getPropertyValue("--ink").trim() || "#fff";
      const red = css.getPropertyValue("--signal").trim() || "#f00";
      yaw += (tyaw - yaw) * 0.06;
      pitch += (tpitch - pitch) * 0.06;
      ctx.clearRect(0, 0, w, h);

      // Tallies per frame from the real purchase list.
      const caught = Array(8).fill(0) as number[];
      for (const f of data.current) if (f.fate === "blocked") caught[f.end]!++;
      const holding = data.current.filter((f) => f.fate === "held").length;
      const paid = data.current.filter((f) => f.fate === "paid").length;

      if (!reduce) {
        if (fresh.current.length) spawn(fresh.current.shift()!);
        else if (data.current.length && now - lastSpawn > 520 && motes.length < 40) {
          spawn(data.current[cursor++ % data.current.length]!);
          lastSpawn = now;
        }
      }

      // Frames, far to near so near lines sit on top.
      ctx.font = `600 11px Archivo, sans-serif`;
      for (let i = FRAMES.length - 1; i >= 0; i--) {
        const z = zOf(i);
        const c = [project(-1, -1, z), project(1, -1, z), project(1, 1, z), project(-1, 1, z)];
        const alpha = 0.28 + 0.5 * (1 - i / FRAMES.length);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = ink;
        ctx.lineWidth = i === 5 ? 2 : 1;
        ctx.beginPath();
        c.forEach((p, j) => (j ? ctx.lineTo(p.sx, p.sy) : ctx.moveTo(p.sx, p.sy)));
        ctx.closePath();
        ctx.stroke();
        // corner ticks
        ctx.globalAlpha = alpha * 0.5;
        const m = [project(-1, 0, z), project(1, 0, z), project(0, -1, z), project(0, 1, z)];
        ctx.beginPath();
        ctx.moveTo(m[0]!.sx, m[0]!.sy); ctx.lineTo(project(-0.86, 0, z).sx, project(-0.86, 0, z).sy);
        ctx.moveTo(m[1]!.sx, m[1]!.sy); ctx.lineTo(project(0.86, 0, z).sx, project(0.86, 0, z).sy);
        ctx.stroke();
        // label + tally
        ctx.globalAlpha = Math.min(1, alpha + 0.25);
        ctx.fillStyle = ink;
        const lab = project(-1, -1, z);
        ctx.fillText(FRAMES[i]!.toUpperCase(), lab.sx + 4, lab.sy - 7);
        const n = i === 5 ? holding : caught[i]!;
        if (n) {
          ctx.fillStyle = i === 5 ? ink : red;
          ctx.font = `800 ${Math.max(13, 20 * (lab.k / 90))}px Archivo, sans-serif`;
          const b = project(-1, 1, z);
          ctx.fillText(i === 5 ? `${n} held` : `${n} stopped`, b.sx + 4, b.sy + 18);
          ctx.font = `600 11px Archivo, sans-serif`;
        }
      }
      // Corridor rails
      ctx.globalAlpha = 0.14;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        const a = project(x, y, zOf(0)), b = project(x, y, zOf(6));
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
      }

      // Purchases in flight
      const still: Mote[] = [];
      for (const m of motes) {
        const stopZ = m.end >= 7 ? zOf(6) + 2.6 : zOf(m.end) - 0.04;
        if (!m.done) {
          m.z += 0.085;
          if (m.z >= stopZ) { m.z = stopZ; m.done = now; }
        }
        const age = m.done ? (now - m.done) / 1000 : 0;
        const life = m.fate === "held" || m.fate === "waiting" ? 3.2 : 1.1;
        if (m.done && age > life) continue;
        still.push(m);
        const p = project(m.x, m.y, m.z);
        const tail = project(m.x, m.y, m.z - 0.75);
        const fade = m.done ? Math.max(0, 1 - age / life) : 1;
        const stopped = m.done && m.fate === "blocked";
        ctx.globalAlpha = 0.9 * fade;
        ctx.strokeStyle = ctx.fillStyle = stopped ? red : ink;
        if (!m.done) {
          ctx.lineWidth = Math.max(1, p.k / 60);
          ctx.beginPath(); ctx.moveTo(tail.sx, tail.sy); ctx.lineTo(p.sx, p.sy); ctx.stroke();
        }
        const s = Math.max(3, (p.k / 16) * (0.6 + Math.min(1, m.amount / 120)));
        if (stopped) {
          // an X where it was stopped, plus an expanding square
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(p.sx - s, p.sy - s); ctx.lineTo(p.sx + s, p.sy + s); ctx.moveTo(p.sx + s, p.sy - s); ctx.lineTo(p.sx - s, p.sy + s); ctx.stroke();
          ctx.globalAlpha = 0.5 * fade;
          const g = s + age * 46;
          ctx.strokeRect(p.sx - g, p.sy - g, g * 2, g * 2);
        } else if (m.done && (m.fate === "held" || m.fate === "waiting")) {
          ctx.lineWidth = 2;
          ctx.strokeRect(p.sx - s, p.sy - s, s * 2, s * 2);
          if (m.fate === "held" && Math.sin(now / 160) > 0) ctx.fillRect(p.sx - 2, p.sy - 2, 4, 4);
        } else ctx.fillRect(p.sx - s / 2, p.sy - s / 2, s, s);
      }
      motes = still;

      // Exit tally
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = ink;
      const out = project(0, 0, zOf(6) + 2.2);
      if (paid) {
        ctx.font = `800 15px Archivo, sans-serif`;
        ctx.fillText(`${paid} paid`, out.sx - 20, out.sy + 5);
      }
      ctx.globalAlpha = 1;
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    if (reduce) setTimeout(() => draw(performance.now()), 300);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  const flights = purchases.slice(0, 60).map(flightOf);
  const label = flights.length
    ? `Live view of the last ${flights.length} purchases passing through the gate: ${flights.filter((f) => f.fate === "blocked").length} stopped, ${flights.filter((f) => f.fate === "held").length} held in PayPal, ${flights.filter((f) => f.fate === "paid").length} paid.`
    : "The gate, waiting for its first purchase.";
  return <canvas ref={ref} className="gatefield" style={{ height }} role="img" aria-label={label} />;
}
