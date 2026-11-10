import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { AgentStep, Mandate, Purchase } from "../domain/types.ts";

export interface StoreEvent {
  type: "purchase" | "mandate" | "agent" | "redteam" | "duel" | "reset";
  id?: string;
  at: string;
  payload?: unknown;
}

export interface AgentRun {
  id: string;
  mandateId: string;
  mode: "protected" | "unprotected";
  startedAt: string;
  finishedAt?: string;
  steps: AgentStep[];
  purchaseIds: string[];
  /** What the agent actually tried to buy (both modes). */
  buys?: { seller?: string; listingId: string; quantity: number; amount: number; outcome: string }[];
  status: "running" | "done" | "error";
  error?: string;
}

interface Snapshot {
  mandates: Mandate[];
  purchases: Purchase[];
  runs: AgentRun[];
  redteam: unknown[];
  duels?: unknown[];
}

/** Small, durable, boring: in-memory maps + an atomic JSON snapshot. */
export class Store {
  mandates = new Map<string, Mandate>();
  purchases = new Map<string, Purchase>();
  runs = new Map<string, AgentRun>();
  redteam: unknown[] = [];
  duels = new Map<string, { id: string; at: string }>();
  readonly events = new EventEmitter();
  private file?: string;
  private timer?: NodeJS.Timeout;

  constructor(dir?: string) {
    this.events.setMaxListeners(200);
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "chaperone.json");
    if (existsSync(this.file)) {
      try {
        const s = JSON.parse(readFileSync(this.file, "utf8")) as Snapshot;
        s.mandates?.forEach((m) => this.mandates.set(m.id, m));
        s.purchases?.forEach((p) => this.purchases.set(p.id, p));
        s.runs?.forEach((r) => this.runs.set(r.id, r));
        this.redteam = s.redteam ?? [];
        (s.duels as { id: string; at: string }[] | undefined)?.forEach((d) => this.duels.set(d.id, d));
      } catch {
        /* corrupt snapshot: start fresh rather than crash */
      }
    }
  }

  emit(e: Omit<StoreEvent, "at">) {
    this.events.emit("event", { ...e, at: new Date().toISOString() });
    this.persist();
  }

  persist() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const snap: Snapshot = { mandates: [...this.mandates.values()], purchases: [...this.purchases.values()], runs: [...this.runs.values()].slice(-50), redteam: this.redteam.slice(-10), duels: [...this.duels.values()].slice(-200) };
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(snap));
      renameSync(tmp, this.file!);
    }, 150);
  }

  saveMandate(m: Mandate) {
    this.mandates.set(m.id, m);
    this.emit({ type: "mandate", id: m.id, payload: m });
  }

  savePurchase(p: Purchase) {
    p.updatedAt = new Date().toISOString();
    this.purchases.set(p.id, p);
    this.emit({ type: "purchase", id: p.id, payload: p });
  }

  saveRun(r: AgentRun) {
    this.runs.set(r.id, r);
    this.emit({ type: "agent", id: r.id, payload: r });
  }

  purchasesFor(mandateId: string): Purchase[] {
    return [...this.purchases.values()].filter((p) => p.intent.mandateId === mandateId);
  }

  reset() {
    this.mandates.clear();
    this.purchases.clear();
    this.runs.clear();
    this.redteam = [];
    this.duels.clear();
    this.emit({ type: "reset" });
  }
}
