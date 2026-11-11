/**
 * Who is asking: the human, or an agent?
 *
 * Agents (the MCP server, any tool-using model) authenticate with an agent key. That key can search,
 * propose purchases and read their status. It can never approve a held purchase, confirm a delivery,
 * refund, sign a mandate or start runs: those are human actions, and the server refuses them with 403
 * whenever an agent key is present.
 *
 * Human actions need the console's session cookie, issued when the page loads (HttpOnly, SameSite=Lax),
 * plus a same-origin request. In this demo, "the human" is whoever has the console open. In production
 * this is where the buyer's real login (PayPal Log In, a passkey) goes; the split of powers stays the same.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { log } from "../telemetry.ts";

const SECRET = process.env.CHAPERONE_SECRET || randomBytes(32).toString("hex");
/** Public on purpose: it is agent-scoped, so knowing it only lets you do what an agent may do. */
export const AGENT_KEY = process.env.CHAPERONE_AGENT_KEY || "chp_agent_demo_7f3a";
export const COOKIE = "chaperone_human";

const sign = (id: string) => createHmac("sha256", SECRET).update(`human:${id}`).digest("base64url");

export function issueHuman(c: Context): string {
  const id = randomBytes(12).toString("base64url");
  const v = `${id}.${sign(id)}`;
  const secure = (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")) === "https";
  setCookie(c, COOKIE, v, { httpOnly: true, sameSite: "Lax", secure, path: "/", maxAge: 60 * 60 * 24 * 7 });
  return v;
}

export function isHuman(v: string | undefined): boolean {
  if (!v) return false;
  const [id, mac] = v.split(".");
  if (!id || !mac) return false;
  const want = Buffer.from(sign(id));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  return h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : undefined;
}
export const isAgent = (c: Context) => bearer(c) === AGENT_KEY;

/** Same-origin check for state-changing human requests (CSRF). Requests without an Origin (curl, tests) pass on the cookie alone. */
function sameOrigin(c: Context): boolean {
  const origin = c.req.header("origin");
  if (!origin) return c.req.header("sec-fetch-site") ? c.req.header("sec-fetch-site") === "same-origin" || c.req.header("sec-fetch-site") === "none" : true;
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Hand the console a human session when the page (or /api/session) is loaded by a browser. */
export const sessionCookie: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "GET" && !isAgent(c) && (!c.req.path.startsWith("/api/") || c.req.path === "/api/session") && !isHuman(getCookie(c, COOKIE))) issueHuman(c);
  await next();
};

/** Returns a refusal response, or null if this request is the human. */
export function refuseUnlessHuman(c: Context, action: string): Response | null {
    if (isAgent(c)) {
      log({ provider: "gate", op: `refused: agent tried to ${action}`, ok: false, note: "agent key has no authority over money; only the human's session does", ref: c.req.param("id") });
      return c.json({ error: `Agents can't ${action}. Only the human can, from their own session.`, code: "agent_scope" }, 403);
    }
    if (!isHuman(getCookie(c, COOKIE)) || !sameOrigin(c)) {
      log({ provider: "gate", op: `refused: ${action} without a human session`, ok: false, ref: c.req.param("id") });
      return c.json({ error: `Only the human can ${action}. Open the Chaperone console to do it.`, code: "human_session_required" }, 401);
    }
    return null;
}

/** Only the human. Agent keys are refused outright, whatever else they carry. */
export function humanOnly(action: string): MiddlewareHandler {
  return async (c, next) => {
    const no = refuseUnlessHuman(c, action);
    if (no) return no;
    await next();
  };
}

/**
 * The caller's address as the edge saw it. Client-supplied X-Forwarded-For entries come first, so
 * prefer the edge's own headers, then the rightmost forwarded entry (added by the proxy, not the client).
 */
export function clientIp(c: Context): string {
  const edge = c.req.header("cf-connecting-ip") ?? c.req.header("true-client-ip");
  if (edge) return edge.trim();
  const xff = (c.req.header("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return xff.at(-1) ?? c.req.header("x-real-ip") ?? "local";
}

/**
 * Fixed-window limits so one visitor can't burn the shared AI quota: per address, per browser session,
 * and (optionally) for everyone together.
 */
export function rateLimit(name: string, max: number, windowMs: number, globalMax?: number): MiddlewareHandler {
  const hits = new Map<string, { n: number; reset: number }>();
  const bump = (key: string, limit: number, now: number): number | null => {
    const h = hits.get(key);
    if (!h || h.reset < now) {
      hits.set(key, { n: 1, reset: now + windowMs });
      return null;
    }
    return ++h.n > limit ? h.reset - now : null;
  };
  return async (c, next) => {
    const now = Date.now();
    const cookie = getCookie(c, COOKIE)?.split(".")[0];
    const waits = [bump(`ip:${clientIp(c)}`, max, now), cookie ? bump(`s:${cookie}`, max, now) : null, globalMax ? bump("all", globalMax, now) : null].filter((x): x is number => x !== null);
    if (waits.length) {
      const s = Math.ceil(Math.max(...waits) / 1000);
      c.header("Retry-After", String(s));
      return c.json({ error: `Too many ${name} right now. Try again in ${s > 90 ? `${Math.ceil(s / 60)} min` : `${s} s`}; this keeps the shared AI quota alive for other judges.`, code: "rate_limited" }, 429);
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    await next();
  };
}

/** Agents (with their key) or the human console. Anonymous callers get nothing that costs money or quota. */
export const agentOrHuman: MiddlewareHandler = async (c, next) => {
  if (isAgent(c) || isHuman(getCookie(c, COOKIE))) return next();
  return c.json({ error: "Send the agent key (Authorization: Bearer …) or use the console.", code: "unauthenticated" }, 401);
};

/** Destructive admin actions need the configured token. With none set, they're off. */
export const adminOnly: MiddlewareHandler = async (c, next) => {
  const token = process.env.CHAPERONE_ADMIN_TOKEN;
  const got = c.req.header("x-admin-token") ?? "";
  if (!token || got.length !== token.length || !timingSafeEqual(Buffer.from(got), Buffer.from(token))) return c.json({ error: "Admin only.", code: "admin_only" }, 403);
  await next();
};
