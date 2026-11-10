/**
 * Turns the human's sentence into a structured mandate the human then confirms.
 * The model proposes; the human signs. After that, only the structured fields
 * (and the original words, for the auditor) are ever used.
 */
import { config } from "../config.ts";
import type { Mandate } from "../domain/types.ts";
import { generateJson } from "./gemini.ts";

export interface MandateDraft {
  description: string;
  mustHave: string[];
  category: string;
  maxQuantity: number;
  maxPerPurchase: number;
  maxTotal: number;
}

const SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string", maxLength: 80 },
    mustHave: { type: "array", items: { type: "string", maxLength: 24 }, maxItems: 5 },
    category: { type: "string", maxLength: 32 },
    maxQuantity: { type: "integer", minimum: 1, maximum: 20 },
    maxPerPurchase: { type: "number", minimum: 1 },
    maxTotal: { type: "number", minimum: 1 },
  },
  required: ["description", "mustHave", "category", "maxQuantity", "maxPerPurchase", "maxTotal"],
  additionalProperties: false,
};

const WORDS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, pair: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };

export function heuristicDraft(instruction: string): MandateDraft {
  const t = instruction.toLowerCase();
  const money = [...t.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
  const qtyM = /\b(\d{1,2}|one|two|three|four|five|six|ten|a pair of)\b\s+(?!w\b|watt)/.exec(t);
  const qty = qtyM ? (WORDS[qtyM[1]!.replace("a pair of", "pair")] ?? Number(qtyM[1]) ?? 1) : 1;
  const specs = [...instruction.matchAll(/\b(\d+(?:\.\d+)?\s?(?:W|mAh|GB|TB|XL|in|inch))\b/gi)].map((m) => m[1]!.replace(/\s/g, ""));
  const known = ["USB-C", "noise cancel", "over-ear", "wireless", "black", "waterproof"].filter((k) => t.includes(k.toLowerCase().replace("noise cancel", "noise-cancel")) || t.includes(k.toLowerCase()));
  const budget = money.length ? Math.max(...money) : 100;
  const cleaned = instruction.replace(/^(please\s+)?(buy|get|order|find)\s+(me\s+)?/i, "").replace(/[,.].*$/, "").replace(/^(one|a|an)\s+/i, "").trim();
  return { description: cleaned.slice(0, 80) || "Item", mustHave: [...new Set([...specs, ...known])].slice(0, 5), category: "general", maxQuantity: Math.max(1, Math.min(20, qty || 1)), maxPerPurchase: budget, maxTotal: budget };
}

export async function draftMandate(instruction: string): Promise<{ draft: MandateDraft; source: "gemini" | "heuristic" }> {
  if (config.mode === "offline" || !config.geminiKey) return { draft: heuristicDraft(instruction), source: "heuristic" };
  try {
    const d = await generateJson<MandateDraft>({
      model: config.geminiModel,
      system: `Extract a purchase mandate from a user's shopping instruction. Be conservative.
- mustHave: hard, checkable specs the user named (e.g. "65W", "USB-C", "67XL", "noise cancel"). Short tokens. No adjectives like "good".
- maxQuantity: the number of units the user asked for (default 1).
- maxTotal: the user's stated budget in USD for the whole job; if none, estimate a sensible cap.
- maxPerPurchase: the most a single order (all units together) may cost. Unless the user gave a separate per-order limit, set it equal to maxTotal. Never divide the budget by the quantity.
- description: 3-8 words naming the item.`,
      prompt: instruction,
      schema: SCHEMA,
    });
    return { draft: { ...d, mustHave: d.mustHave.slice(0, 5), maxQuantity: Math.max(1, Math.round(d.maxQuantity)) }, source: "gemini" };
  } catch {
    return { draft: heuristicDraft(instruction), source: "heuristic" };
  }
}

export function mandateFromDraft(instruction: string, d: MandateDraft, extra: Partial<Pick<Mandate, "autoApproveUnder" | "maxOverMarketPct" | "expiresAt">> = {}): Mandate {
  const now = new Date();
  // A model that split the budget per unit would make the user's own request unbuyable; one order may use the whole budget.
  const perOrder = d.maxQuantity > 1 && d.maxPerPurchase * d.maxQuantity <= d.maxTotal + 0.01 ? d.maxTotal : d.maxPerPurchase;
  return {
    id: `md_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    createdAt: now.toISOString(),
    expiresAt: extra.expiresAt ?? new Date(now.getTime() + 7 * 864e5).toISOString(),
    instruction,
    item: { description: d.description, mustHave: d.mustHave, category: d.category, maxQuantity: d.maxQuantity },
    budget: { currency: "USD", maxPerPurchase: perOrder, maxTotal: Math.max(d.maxTotal, d.maxPerPurchase) },
    autoApproveUnder: extra.autoApproveUnder ?? perOrder,
    maxOverMarketPct: extra.maxOverMarketPct ?? 20,
    merchants: { block: [] },
    status: "draft",
    committed: 0,
    settled: 0,
  };
}
