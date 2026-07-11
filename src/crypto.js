// Web Crypto helpers — all native to the Workers runtime, no npm deps.

const enc = new TextEncoder();

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// base64url without padding — cookie/JWT-safe
export function b64url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  return atob(str);
}

// Constant-time string compare (equal length hex/ascii)
export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export async function sha256Hex(message) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(message)));
}

// ── Password hashing (PBKDF2-SHA256) ─────────────────────────────────────────
// 100k iterations runs well under the Workers free-tier 10ms CPU budget for the
// infrequent admin-login path. Format stored: "iterations$saltHex$hashHex".
const PBKDF2_ITER = 100_000;

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `${PBKDF2_ITER}$${toHex(salt)}$${toHex(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [iterStr, saltHex, hashHex] = (stored || "").split("$");
  if (!iterStr || !saltHex || !hashHex) return false;
  const hash = await pbkdf2(password, fromHex(saltHex), parseInt(iterStr, 10));
  return timingSafeEqual(toHex(hash), hashHex);
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256
  );
}

export function randomId() {
  return crypto.randomUUID();
}

// 6-digit numeric OTP
export function randomOtp() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(n).padStart(6, "0");
}
