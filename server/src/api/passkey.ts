/**
 * Step-up with a passkey: the one thing a hijacked agent can't fake.
 *
 * The console session says "this is a browser". A passkey says "a person is here": releasing money,
 * approving a held purchase, refunding, and signing or loosening limits all need a fresh passkey
 * check (Touch ID, Face ID, Windows Hello, a phone or a security key) within the last few minutes.
 * An agent can call every HTTP endpoint the console calls, but it can't make the authenticator sign.
 *
 * Credentials are stored per console session; only public keys are kept.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { config } from "../config.ts";
import { log } from "../telemetry.ts";
import { COOKIE, isAgent, isHuman, refuseUnlessHuman } from "./auth.ts";

const FRESH_MS = 10 * 60_000;

/** Passkeys are required in live mode, unless explicitly turned off (CHAPERONE_PASSKEYS=off) for scripted runs. */
export const passkeysRequired = () => process.env.CHAPERONE_PASSKEYS === "on" || (config.mode !== "offline" && process.env.CHAPERONE_PASSKEYS !== "off");

interface Cred { id: string; publicKey: string; counter: number; transports?: string[]; at: string }
const file = () => join(config.dataDir, "passkeys.json");
let creds: Record<string, Cred[]> = {};
try {
  if (existsSync(file())) creds = JSON.parse(readFileSync(file(), "utf8"));
} catch {
  creds = {};
}
const save = () => {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(file(), JSON.stringify(creds));
  } catch {}
};
const challenges = new Map<string, { challenge: string; at: number }>();
const fresh = new Map<string, number>();

const sid = (c: Context) => getCookie(c, COOKIE)?.split(".")[0] ?? "";
function rp(c: Context) {
  const host = (c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host).split(",")[0]!.trim();
  const proto = (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")).split(",")[0]!.trim();
  return { rpID: host.split(":")[0]!, origin: `${proto}://${host}` };
}

export const isFresh = (c: Context) => (fresh.get(sid(c)) ?? 0) > Date.now();

/** Human session AND a passkey check in the last 10 minutes. */
export function humanWithPasskey(action: string): MiddlewareHandler {
  return async (c, next) => {
    const no = refuseUnlessHuman(c, action);
    if (no) return no;
    if (passkeysRequired() && !isFresh(c)) {
      log({ provider: "gate", op: `asked for a passkey: ${action}`, ok: true, ref: c.req.param("id") });
      return c.json({ error: `Confirm it's you with your passkey to ${action}.`, code: "passkey_required", registered: (creds[sid(c)] ?? []).length > 0 }, 401);
    }
    await next();
  };
}

/** For handlers that only sometimes move money (a buyer's delivery report). */
export function refuseUnlessPasskey(c: Context, action: string): Response | null {
  const no = refuseUnlessHuman(c, action);
  if (no) return no;
  if (passkeysRequired() && !isFresh(c)) return c.json({ error: `Confirm it's you with your passkey to ${action}.`, code: "passkey_required", registered: (creds[sid(c)] ?? []).length > 0 }, 401);
  return null;
}

export function passkeyRoutes(app: Hono) {
  const human = (c: Context) => !isAgent(c) && isHuman(getCookie(c, COOKIE));
  const deny = (c: Context) => c.json({ error: "Only the console can use passkeys.", code: isAgent(c) ? "agent_scope" : "human_session_required" }, isAgent(c) ? 403 : 401);

  app.get("/api/passkey", (c) => c.json({ required: passkeysRequired(), registered: (creds[sid(c)] ?? []).length > 0, fresh: isFresh(c), freshForMs: Math.max(0, (fresh.get(sid(c)) ?? 0) - Date.now()) }));

  app.post("/api/passkey/register/options", async (c) => {
    if (!human(c)) return deny(c);
    const id = sid(c);
    const { rpID } = rp(c);
    const opts = await generateRegistrationOptions({
      rpName: "Chaperone",
      rpID,
      userName: "Chaperone buyer",
      userDisplayName: "You (the human who approves purchases)",
      userID: new TextEncoder().encode(`chaperone:${id}`),
      attestationType: "none",
      excludeCredentials: (creds[id] ?? []).map((x) => ({ id: x.id, transports: x.transports as never })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    challenges.set(id, { challenge: opts.challenge, at: Date.now() });
    return c.json(opts);
  });

  app.post("/api/passkey/register/verify", async (c) => {
    if (!human(c)) return deny(c);
    const id = sid(c);
    const ch = challenges.get(id);
    if (!ch || Date.now() - ch.at > 5 * 60_000) return c.json({ error: "That request expired. Try again." }, 400);
    const { rpID, origin } = rp(c);
    try {
      const v = await verifyRegistrationResponse({ response: (await c.req.json()) as RegistrationResponseJSON, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      if (!v.verified) return c.json({ error: "The passkey couldn't be verified." }, 400);
      const k = v.registrationInfo.credential;
      creds[id] = [...(creds[id] ?? []).filter((x) => x.id !== k.id), { id: k.id, publicKey: Buffer.from(k.publicKey).toString("base64url"), counter: k.counter, transports: k.transports, at: new Date().toISOString() }];
      save();
      challenges.delete(id);
      fresh.set(id, Date.now() + FRESH_MS);
      log({ provider: "gate", op: "passkey created", ok: true, note: `${v.registrationInfo.credentialDeviceType}, user verified` });
      return c.json({ ok: true, freshForMs: FRESH_MS });
    } catch (e) {
      return c.json({ error: `Passkey check failed: ${(e as Error).message}` }, 400);
    }
  });

  app.post("/api/passkey/auth/options", async (c) => {
    if (!human(c)) return deny(c);
    const id = sid(c);
    const mine = creds[id] ?? [];
    if (!mine.length) return c.json({ error: "No passkey yet for this browser.", code: "no_passkey" }, 404);
    const opts = await generateAuthenticationOptions({ rpID: rp(c).rpID, allowCredentials: mine.map((x) => ({ id: x.id, transports: x.transports as never })), userVerification: "required" });
    challenges.set(id, { challenge: opts.challenge, at: Date.now() });
    return c.json(opts);
  });

  app.post("/api/passkey/auth/verify", async (c) => {
    if (!human(c)) return deny(c);
    const id = sid(c);
    const ch = challenges.get(id);
    if (!ch || Date.now() - ch.at > 5 * 60_000) return c.json({ error: "That request expired. Try again." }, 400);
    const body = (await c.req.json()) as AuthenticationResponseJSON;
    const cred = (creds[id] ?? []).find((x) => x.id === body.id);
    if (!cred) return c.json({ error: "That passkey isn't registered for this browser.", code: "no_passkey" }, 404);
    const { rpID, origin } = rp(c);
    try {
      const v = await verifyAuthenticationResponse({ response: body, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true, credential: { id: cred.id, publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")), counter: cred.counter, transports: cred.transports as never } });
      if (!v.verified) return c.json({ error: "The passkey couldn't be verified." }, 400);
      cred.counter = v.authenticationInfo.newCounter;
      save();
      challenges.delete(id);
      fresh.set(id, Date.now() + FRESH_MS);
      log({ provider: "gate", op: "passkey confirmed", ok: true, note: "user verified; money actions unlocked for 10 min" });
      return c.json({ ok: true, freshForMs: FRESH_MS });
    } catch (e) {
      return c.json({ error: `Passkey check failed: ${(e as Error).message}` }, 400);
    }
  });
}
