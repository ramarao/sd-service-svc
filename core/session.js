// Stateless signed-cookie sessions. Payload.b64url + '.' + HMAC(payload).
// No DB read per request — verification is one HMAC.
import { getCookie } from "hono/cookie";
import { b64url, b64urlDecode, hmacHex, timingSafeEqual } from "./crypto.js";

const COOKIE = "sd_session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function issueSession(env, claims) {
  const payload = b64url(JSON.stringify({ ...claims, exp: Date.now() + TTL_MS }));
  const mac = await hmacHex(env.SESSION_SECRET, payload);
  return `${payload}.${mac}`;
}

export async function readSession(env, token) {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = await hmacHex(env.SESSION_SECRET, payload);
  if (!timingSafeEqual(expected, mac)) return null;
  try {
    const claims = JSON.parse(b64urlDecode(payload));
    if (!claims.exp || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export const sessionCookieOpts = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  path: "/",
  maxAge: TTL_MS / 1000,
};

export const COOKIE_NAME = COOKIE;

// ── WhatsApp magic-link tokens ───────────────────────────────────────────────
// Short-lived, signed token embedded in the link we send over WhatsApp. Since
// the webhook already knows the sender's verified number, tapping the link logs
// the customer straight in — no OTP/login. Exchanged for a session cookie by the
// /auth/wa/:token route. TTL kept short because it's a bearer credential.
const LINK_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function mintLinkToken(env, claims) {
  const payload = b64url(JSON.stringify({ ...claims, k: "wl", exp: Date.now() + LINK_TTL_MS }));
  const mac = await hmacHex(env.SESSION_SECRET, payload);
  return `${payload}.${mac}`;
}

export async function verifyLinkToken(env, token) {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = await hmacHex(env.SESSION_SECRET, payload);
  if (!timingSafeEqual(expected, mac)) return null;
  try {
    const c = JSON.parse(b64urlDecode(payload));
    if (c.k !== "wl" || !c.exp || c.exp < Date.now()) return null;
    return c;
  } catch {
    return null;
  }
}

// Hono middleware: attaches c.get('session') or 401s. Roles narrow access.
export function requireRole(...roles) {
  return async (c, next) => {
    const sess = await readSession(c.env, getCookie(c, COOKIE));
    if (!sess) return c.json({ error: "unauthorized" }, 401);
    if (roles.length && !roles.includes(sess.role)) {
      return c.json({ error: "forbidden" }, 403);
    }
    c.set("session", sess);
    await next();
  };
}
