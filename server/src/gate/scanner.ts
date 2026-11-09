/**
 * Untrusted-text scanner. Deterministic, no model involved.
 *
 * Looks for the fingerprints of indirect prompt injection in anything the
 * agent read or wrote: invisible characters, Unicode tag smuggling, bidi
 * tricks, instructions addressed to AI agents, payee redirection, and
 * lookalike merchant domains.
 */

export type Severity = "high" | "medium" | "low";

export interface Finding {
  kind:
    | "invisible_chars"
    | "tag_smuggling"
    | "bidi_override"
    | "ai_directive"
    | "role_spoof"
    | "payee_redirect"
    | "quantity_push"
    | "hidden_markup"
    | "encoded_blob"
    | "urgency"
    | "lookalike_domain";
  severity: Severity;
  field: string;
  excerpt: string;
  explanation: string;
}

const ZERO_WIDTH = /[​-‏⁠-⁤﻿­]/g;
const BIDI = /[‪-‮⁦-⁩]/g;
// Unicode "tag" block U+E0000–U+E007F: invisible ASCII mirror used for smuggling.
const TAGS = /[\u{E0000}-\u{E007F}]/gu;

const AI_DIRECTIVES: { re: RegExp; why: string }[] = [
  { re: /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|user'?s?)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|constraints?|budget|limits?)\b/i, why: "tells the agent to discard its instructions" },
  { re: /\b(ai|llm|gpt|gemini|claude|assistant|agent|bot|model)s?\b[^.\n]{0,60}\b(must|should|are (required|instructed)|need to|will now|reading this)\b/i, why: "speaks directly to AI agents" },
  { re: /\b(note|message|instructions?|attention)\s+(to|for)\s+(the\s+)?(ai|assistant|agent|shopping (agent|assistant)|llm|bot)s?\b/i, why: "is a message addressed to the agent, not the human" },
  { re: /\b(you are now|from now on|new (instructions?|task|objective)|your (real|true|new) (task|goal|instructions?))\b/i, why: "attempts to re-task the agent" },
  { re: /\b(do not|don'?t|never)\s+(tell|inform|notify|ask|mention|show)\b[^.\n]{0,30}\b(user|human|owner|customer|buyer)\b/i, why: "asks the agent to hide something from the human" },
  { re: /\b(pre-?approved|already (approved|authori[sz]ed)|user (has )?(approved|authori[sz]ed|consented)|authori[sz]ation (is )?not (needed|required))\b/i, why: "claims approval the human never gave" },
];

const ROLE_SPOOF = /(^|\n)\s*(system|assistant|developer|tool)\s*[:>]|<\|?(im_start|system|endoftext)\|?>|\[\/?(INST|SYS)\]|<\/?(system|instructions?)>/i;
const PAYEE = /\b(send|wire|route|direct|remit|pay(ment)?s?)\b[^.\n]{0,40}\b(to|via)\b[^.\n]{0,40}([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i;
const PAYEE_CHANGE = /\b(new|updated|changed|alternate|backup)\s+(payee|payout|payment|paypal|billing)\s+(email|address|account|recipient)\b/i;
const QTY_PUSH = /\b(buy|order|purchase|add|select)\s+(at least\s+)?(\d{1,3}|two|three|four|five|ten|multiple|several|all)\s+(units?|items?|of (these|them)|copies|packs?)\b|\b(set|change|increase|bump)\s+(the\s+)?quantity\b|\bminimum order\s+(of\s+)?\d+/i;
const HIDDEN_MARKUP = /<!--[\s\S]*?-->|<[^>]+(display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|opacity\s*:\s*0)[^>]*>|color\s*:\s*(#fff(fff)?|white)\b/i;
const B64 = /\b[A-Za-z0-9+/]{48,}={0,2}\b/;
const URGENCY = /\b(only \d+ left|last chance|expires in \d+|price (goes|will go) up|act now|limited time|selling fast|\d+ people (are )?(viewing|looking))\b/i;

export function decodeTags(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xe0020 && cp <= 0xe007e) out += String.fromCodePoint(cp - 0xe0000);
  }
  return out;
}

/** Remove everything a human can't see, so what the auditor reads is what a person would read. */
export function sanitize(s: string): string {
  return s.replace(TAGS, "").replace(ZERO_WIDTH, "").replace(BIDI, "").replace(/<!--[\s\S]*?-->/g, "").normalize("NFKC");
}

function excerptAround(s: string, idx: number, len = 90): string {
  const start = Math.max(0, idx - 20);
  return s.slice(start, start + len).replace(/\s+/g, " ").trim();
}

export function scanText(field: string, raw: string): Finding[] {
  const findings: Finding[] = [];
  if (!raw) return findings;

  const tags = raw.match(TAGS);
  if (tags?.length) {
    findings.push({
      kind: "tag_smuggling",
      severity: "high",
      field,
      excerpt: decodeTags(raw).slice(0, 140),
      explanation: `${tags.length} invisible Unicode tag characters spell out hidden text a human never sees.`,
    });
  }
  const zw = raw.match(ZERO_WIDTH);
  if (zw && zw.length >= 3) {
    findings.push({ kind: "invisible_chars", severity: zw.length >= 10 ? "high" : "medium", field, excerpt: `${zw.length} zero-width characters`, explanation: "Zero-width characters are used to split or hide words from filters and humans." });
  }
  if (BIDI.test(raw)) {
    findings.push({ kind: "bidi_override", severity: "high", field, excerpt: "bidirectional override", explanation: "Text-direction overrides make displayed text differ from what the model reads." });
  }

  // Run phrase checks on both the visible text and the decoded hidden layer.
  const layers = [sanitize(raw), decodeTags(raw)].filter(Boolean);
  for (const text of layers) {
    for (const d of AI_DIRECTIVES) {
      const m = d.re.exec(text);
      if (m) findings.push({ kind: "ai_directive", severity: "high", field, excerpt: excerptAround(text, m.index), explanation: `Text ${d.why}.` });
    }
    let m = ROLE_SPOOF.exec(text);
    if (m) findings.push({ kind: "role_spoof", severity: "high", field, excerpt: excerptAround(text, m.index), explanation: "Fake system/assistant role markers try to pass page text off as instructions." });
    m = PAYEE.exec(text) ?? PAYEE_CHANGE.exec(text);
    if (m) findings.push({ kind: "payee_redirect", severity: "high", field, excerpt: excerptAround(text, m.index), explanation: "Tries to send payment somewhere other than the verified seller." });
    m = QTY_PUSH.exec(text);
    if (m) findings.push({ kind: "quantity_push", severity: "medium", field, excerpt: excerptAround(text, m.index), explanation: "Pushes the agent to buy more units than asked." });
    m = URGENCY.exec(text);
    if (m) findings.push({ kind: "urgency", severity: "low", field, excerpt: excerptAround(text, m.index), explanation: "Urgency pressure. Harmless to humans, effective on agents." });
  }
  const hm = HIDDEN_MARKUP.exec(raw);
  if (hm) findings.push({ kind: "hidden_markup", severity: "medium", field, excerpt: excerptAround(raw, hm.index), explanation: "Markup that hides text from people but not from models." });
  const b = B64.exec(raw);
  if (b) findings.push({ kind: "encoded_blob", severity: "low", field, excerpt: b[0].slice(0, 40) + "…", explanation: "Long encoded blob in product text." });

  return dedupe(findings);
}

function dedupe(fs: Finding[]): Finding[] {
  const seen = new Set<string>();
  return fs.filter((f) => {
    const k = `${f.kind}|${f.field}|${f.excerpt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ── Lookalike domains ─────────────────────────────────────────────

const CONFUSABLES: Record<string, string> = { "0": "o", "1": "l", "3": "e", "5": "s", "rn": "m", "vv": "w", "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i" };

export function skeleton(domain: string): string {
  let d = domain.toLowerCase().normalize("NFKC").replace(/^www\./, "");
  for (const [k, v] of Object.entries(CONFUSABLES)) d = d.split(k).join(v);
  return d.replace(/-/g, "");
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/** Returns the trusted domain this one imitates, or null. */
export function lookalikeOf(domain: string, trusted: string[]): string | null {
  const d = domain.toLowerCase().replace(/^www\./, "");
  if (trusted.includes(d)) return null;
  const nonAscii = /[^\x00-\x7f]/.test(d) || d.includes("xn--");
  const sk = skeleton(d);
  for (const t of trusted) {
    const tb = t.split(".")[0]!;
    const db = d.split(".")[0]!;
    if (skeleton(t) === sk) return t;
    if (nonAscii && skeleton(tb) === skeleton(db)) return t;
    if (tb.length >= 5 && levenshtein(skeleton(tb), skeleton(db)) <= 1) return t;
    if (db !== tb && db.includes(tb) && /(official|store|shop|deals|outlet|secure|verify)/.test(db)) return t;
  }
  return null;
}
