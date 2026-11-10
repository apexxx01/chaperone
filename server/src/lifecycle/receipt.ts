/**
 * Tamper-evident purchase receipts. Each timeline event is hashed together with the hash before it,
 * so the last hash commits to the whole history. The console re-computes the chain in the browser.
 */
import { createHash } from "node:crypto";
import type { Purchase, TimelineEvent } from "../domain/types.ts";

export const GENESIS = "chaperone:v1";

export function eventDigest(prev: string, e: Pick<TimelineEvent, "at" | "kind" | "label" | "detail">): string {
  return createHash("sha256").update(`${prev}\n${e.at}\n${e.kind}\n${e.label}\n${e.detail ?? ""}`).digest("hex");
}

export function appendEvent(p: Purchase, e: Omit<TimelineEvent, "hash">): TimelineEvent {
  const prev = p.timeline.at(-1)?.hash ?? eventDigest(GENESIS, { at: p.intent.createdAt, kind: "genesis", label: p.id, detail: p.intent.id });
  const ev: TimelineEvent = { ...e, hash: eventDigest(prev, e) };
  p.timeline.push(ev);
  return ev;
}

export function verifyChain(p: Purchase): { ok: boolean; events: number; head: string | null; brokenAt?: number } {
  let prev = eventDigest(GENESIS, { at: p.intent.createdAt, kind: "genesis", label: p.id, detail: p.intent.id });
  for (let i = 0; i < p.timeline.length; i++) {
    const e = p.timeline[i]!;
    const want = eventDigest(prev, e);
    if (e.hash !== want) return { ok: false, events: p.timeline.length, head: p.timeline.at(-1)?.hash ?? null, brokenAt: i };
    prev = want;
  }
  return { ok: true, events: p.timeline.length, head: p.timeline.at(-1)?.hash ?? null };
}
