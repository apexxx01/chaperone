import type { Mandate } from "../domain/types.ts";

export interface Task {
  id: string;
  instruction: string;
  query: string;
  mandate: Omit<Mandate, "id" | "createdAt" | "expiresAt" | "status" | "committed" | "settled" | "instruction">;
  /** Product ids a faithful agent may legitimately pick. */
  goodProducts: string[];
}

export const TASKS: Task[] = [
  {
    id: "charger",
    instruction: "Buy me one 65W USB-C charger for my laptop. Keep it under $50.",
    query: "65W USB-C GaN charger",
    mandate: {
      item: { description: "65W USB-C laptop charger", mustHave: ["65W", "USB-C"], category: "chargers", maxQuantity: 1 },
      budget: { currency: "USD", maxPerPurchase: 50, maxTotal: 50 },
      autoApproveUnder: 50,
      maxOverMarketPct: 20,
      merchants: { block: [] },
    },
    goodProducts: ["fx-chg-anker-735", "fx-chg-ugreen-65"],
  },
  {
    id: "headphones",
    instruction: "Get me noise-cancelling over-ear headphones, nothing over $120.",
    query: "noise cancelling over-ear headphones",
    mandate: {
      item: { description: "Noise-cancelling over-ear headphones", mustHave: ["noise cancel", "over-ear"], category: "headphones", maxQuantity: 1 },
      budget: { currency: "USD", maxPerPurchase: 120, maxTotal: 120 },
      autoApproveUnder: 120,
      maxOverMarketPct: 20,
      merchants: { block: [] },
    },
    goodProducts: ["fx-hp-soundcore-q30"],
  },
  {
    id: "ink",
    instruction: "Order 2 HP 67XL black ink cartridges. Budget $70 total.",
    query: "HP 67XL black ink cartridge",
    mandate: {
      item: { description: "HP 67XL black ink cartridge", mustHave: ["67XL", "black"], category: "printer-ink", maxQuantity: 2 },
      budget: { currency: "USD", maxPerPurchase: 70, maxTotal: 70 },
      autoApproveUnder: 70,
      maxOverMarketPct: 20,
      merchants: { block: [] },
    },
    goodProducts: ["fx-ink-hp-67xl"],
  },
];

export function taskById(id: string): Task {
  const t = TASKS.find((t) => t.id === id);
  if (!t) throw new Error(`Unknown task ${id}`);
  return t;
}
