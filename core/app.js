// Core app factory — the vertical-agnostic engine shared by every service Worker
// (dhobi, HomeEase, …). One Worker serves: the WhatsApp webhook, the REST API,
// and the static SPA dashboards (customer / field-agent / manager / console).
//
// createApp(config) returns the Hono app wired to that vertical's config (see
// config.js). Because each service is its own Worker (one config per bundle), the
// config is injected once via a module-level ref + a request middleware — routes
// read it from context (c.get("config") / c.get("flow")).
import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import QRCode from "qrcode";
import { processPaymentEmail } from "./email.js";
import { extractItemsFromImage } from "./vision.js";
import { notifyOrders } from "./orders-hub.js";
import { allowedTransitions, advanceStep, itemsEditableAt } from "./flow.js";
import { FLOWS, flowForProvider, flowForVertical, setDefaultVertical } from "./flows/index.js";

import { randomId, randomOtp, sha256Hex, hashPassword, verifyPassword, timingSafeEqual } from "./crypto.js";
import {
  issueSession,
  readSession,
  requireRole,
  COOKIE_NAME,
  sessionCookieOpts,
  mintLinkToken,
  verifyLinkToken,
} from "./session.js";
import {
  verifySignature,
  sendWhatsApp,
  textPayload,
  ctaUrlPayload,
  templatePayload,
  withinWindow,
  safeConfig,
} from "./wa.js";
import {
  now,
  getProvider,
  getProviderBySlug,
  getProviderByPhoneNumberId,
  getCustomer,
  getCustomerByPhone,
  upsertCustomerByPhone,
  touchInboundWindow,
  createOrder,
  getOrder,
  transitionOrder,
  getSettings,
  getWaConfig,
  listAddresses,
  getAddress,
  createAddress,
  setDefaultAddress,
  fullAddress,
  listCaptains,
  createCaptain,
  deleteCaptain,
  getCaptainProviders,
  captainName,
  listCaptainJobs,
  replaceOrderItems,
  listManagers,
  createManager,
  deleteManager,
  getManagerProviders,
  getManagerFor,
  managerName,
  listVerticals,
  listProvidersByVertical,
} from "./db.js";
import { olaSuggest, olaReverse, olaConfigured } from "./ola.js";

const app = new Hono();
const OTP_TTL_MS = 5 * 60 * 1000;

// The active vertical's config, injected once by createApp() at Worker init.
let CONFIG = null;

// Build (well, configure) the app for one town and return it. Each Worker calls
// this once with its own config.js (town brand + defaultVertical). The order flow
// is NOT fixed per Worker — it's resolved per request from the provider's vertical.
export function createApp(config) {
  CONFIG = config;
  setDefaultVertical(config.defaultVertical); // fallback for providers with no vertical
  return app;
}

// Make the town config available to every request handler. (Flow is per-provider,
// resolved in each handler via flowForProvider(provider) — not global.)
app.use("*", (c, next) => {
  c.set("config", CONFIG);
  return next();
});

// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp webhook
// ─────────────────────────────────────────────────────────────────────────────

// Meta verification handshake (configured once). Verify token comes from the
// DB (super-admin console), falling back to the env secret.
app.get("/webhook/whatsapp", async (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const s = await getSettings(c.env.DB);
  const verifyToken = s?.wa_verify_token || c.env.WA_VERIFY_TOKEN;
  if (mode === "subscribe" && verifyToken && token === verifyToken) {
    return c.text(challenge || "", 200);
  }
  return c.text("forbidden", 403);
});

// Inbound messages + status callbacks.
app.post("/webhook/whatsapp", async (c) => {
  const raw = await c.req.text();
  const sig = c.req.header("X-Hub-Signature-256");
  const s = await getSettings(c.env.DB);
  const appSecret = s?.wa_app_secret || c.env.WA_APP_SECRET;
  if (!(await verifySignature(raw, sig, appSecret))) {
    return c.text("bad signature", 401);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.text("bad json", 400);
  }

  // Process asynchronously; always ACK fast so Meta doesn't retry.
  c.executionCtx.waitUntil(handleWebhook(c.env, body).catch((e) => console.error("[webhook]", e)));
  return c.text("EVENT_RECEIVED", 200);
});

async function handleWebhook(env, body) {
  const value = body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg) return; // status callback or non-message event — ignore for now

  const from = msg.from; // customer E.164 digits
  const phoneNumberId = value?.metadata?.phone_number_id;

  // Stamp the 24h free-message window and ensure the customer exists.
  const customer = await touchInboundWindow(env.DB, from);
  // A provider may still own its own number (legacy white-label). In a town the
  // number is the platform's — no provider matches, and we show the marketplace
  // chooser instead of going straight to one provider's order form.
  const provider = phoneNumberId
    ? await getProviderByPhoneNumberId(env.DB, phoneNumberId)
    : null;

  const host = env.PUBLIC_HOST || CONFIG?.brand?.host || "dhobi-demo.manasanta.in";
  const townName = CONFIG?.brand?.name || provider?.name || "us";
  const waCfg = await getWaConfig(env, env.DB, provider); // null provider → platform creds
  const text = (msg.text?.body || "").trim();

  // Captain login: a captain texts "capt" or "captain" → reply with a one-tap
  // sign-in link carrying a signed token for their verified number. Tapping it
  // opens the Captain app already authenticated.
  if (/^\s*capt(?:ain)?\b/i.test(text)) {
    const term = CONFIG?.brand?.agentTerm || "Captain";
    const lower = term.toLowerCase();
    const capProviders = await getCaptainProviders(env.DB, from);
    if (capProviders.length) {
      const t = await mintLinkToken(env, { cap: 1, ph: from });
      const link = `https://${host}/auth/captain/wa/${t}`;
      const name = await captainName(env.DB, from);
      await sendWhatsApp(waCfg, from, ctaUrlPayload(`Hi${name ? " " + name : ""}! Tap below to open your ${term} app — you'll be signed in automatically.`, `Open ${term} app`, link));
    } else {
      await sendWhatsApp(
        waCfg,
        from,
        textPayload(
          `🚫 *You're not a ${lower} yet*\n\n` +
            `This number isn't registered as a ${lower} for *${townName}* or any provider.\n\n` +
            `👉 Ask your provider to add you as a ${lower} using *this WhatsApp number*, then send *capt* again.`
        )
      );
    }
    return;
  }

  // Manager login: a manager texts "admin" or "manager" → one-tap sign-in link
  // for the admin app. Their tier (admin vs manager) is read from their record.
  if (/^\s*(admin|manager)\b/i.test(text)) {
    const mgrProviders = await getManagerProviders(env.DB, from);
    if (mgrProviders.length) {
      const t = await mintLinkToken(env, { mgr: 1, ph: from });
      const link = `https://${host}/auth/manager/wa/${t}`;
      const name = await managerName(env.DB, from);
      await sendWhatsApp(waCfg, from, ctaUrlPayload(`Hi${name ? " " + name : ""}! Tap below to open your admin app — you'll be signed in automatically.`, "Open admin app", link));
    } else {
      await sendWhatsApp(
        waCfg,
        from,
        textPayload(
          `🚫 *You're not a manager yet*\n\nThis number isn't registered as a manager for *${townName}* or any provider.\n\n👉 Ask an admin to add you, then send *admin* again.`
        )
      );
    }
    return;
  }

  // Default (any other message, e.g. "hi") → open a signed-in webview. Legacy
  // white-label (this number belongs to one provider) goes straight to that
  // provider's order form; a town number opens the marketplace chooser (/start).
  const hi = customer.name ? " " + customer.name : "";
  if (provider) {
    const t = await mintLinkToken(env, { cid: customer.id, ph: from, slug: provider.slug });
    const link = `https://${host}/auth/wa/${t}`;
    const bodyText = `Hi${hi}! Tap below to place your ${provider.name} order — you'll be signed in automatically, no login needed.`;
    await sendWhatsApp(waCfg, from, ctaUrlPayload(bodyText, "Place order", link));
  } else {
    const t = await mintLinkToken(env, { cid: customer.id, ph: from }); // no slug → chooser
    const link = `https://${host}/auth/wa/${t}`;
    const bodyText = `Hi${hi}! Welcome to *${townName}*. Tap below to browse services and place an order — you'll be signed in automatically.`;
    await sendWhatsApp(waCfg, from, ctaUrlPayload(bodyText, "Browse services", link));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

// Customer OTP request → send a 6-digit code over WhatsApp.
app.post("/auth/otp/request", async (c) => {
  const { wa_phone, slug } = await c.req.json().catch(() => ({}));
  const phone = normalizePhone(wa_phone);
  if (!phone) return c.json({ error: "invalid_phone" }, 400);

  const code = randomOtp();
  const codeHash = await sha256Hex(`${phone}:${code}:${c.env.SESSION_SECRET}`);
  await c.env.DB.prepare(
    "INSERT INTO otp_codes (wa_phone, code_hash, expires_at, attempts) VALUES (?,?,?,0) " +
      "ON CONFLICT(wa_phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0"
  )
    .bind(phone, codeHash, now() + OTP_TTL_MS)
    .run();

  await upsertCustomerByPhone(c.env.DB, phone);

  // Deliver the code. Within 24h → text; otherwise a login_code utility template.
  const provider = slug ? await getProviderBySlug(c.env.DB, slug) : null;
  const cust = await getCustomerByPhone(c.env.DB, phone);
  const cfg = safeConfig(provider?.config);
  const payload = withinWindow(cust?.last_inbound_at)
    ? textPayload(`Your login code is ${code}. It expires in 5 minutes.`)
    : templatePayload(cfg.templates?.login_code || "login_code", cfg.lang, [code]);
  const waCfg = await getWaConfig(c.env, c.env.DB, provider);
  await sendWhatsApp(waCfg, phone, payload);

  return c.json({ ok: true });
});

// Customer OTP verify → issue session.
app.post("/auth/otp/verify", async (c) => {
  const { wa_phone, code } = await c.req.json().catch(() => ({}));
  const phone = normalizePhone(wa_phone);
  const row = await c.env.DB.prepare("SELECT * FROM otp_codes WHERE wa_phone = ?").bind(phone).first();
  if (!row) return c.json({ error: "no_code" }, 400);
  if (row.expires_at < now()) return c.json({ error: "expired" }, 400);
  if (row.attempts >= 5) return c.json({ error: "too_many_attempts" }, 429);

  const codeHash = await sha256Hex(`${phone}:${String(code || "").trim()}:${c.env.SESSION_SECRET}`);
  if (codeHash !== row.code_hash) {
    await c.env.DB.prepare("UPDATE otp_codes SET attempts = attempts + 1 WHERE wa_phone = ?").bind(phone).run();
    return c.json({ error: "wrong_code" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM otp_codes WHERE wa_phone = ?").bind(phone).run();

  const customer = await upsertCustomerByPhone(c.env.DB, phone);
  const token = await issueSession(c.env, {
    role: "customer",
    customer_id: customer.id,
    wa_phone: phone,
  });
  setCookie(c, COOKIE_NAME, token, sessionCookieOpts);
  return c.json({ ok: true, role: "customer" });
});

// Admin / super-admin password login.
app.post("/auth/admin/login", async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ error: "missing" }, 400);
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ? AND role IN ('admin','super_admin')")
    .bind(String(email).toLowerCase())
    .first();
  if (!user || !(await verifyPassword(password, user.pass_hash))) {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const token = await issueSession(c.env, {
    role: user.role,
    user_id: user.id,
    provider_id: user.provider_id || null,
    email: user.email,
  });
  setCookie(c, COOKIE_NAME, token, sessionCookieOpts);
  return c.json({ ok: true, role: user.role });
});

app.post("/auth/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

// ── Captain auth — WhatsApp-only (no passwords) ──────────────────────────────
// The only way in is the magic link the webhook sends when a captain texts
// "login". Tapping it logs them straight in for their verified number.
app.get("/auth/captain/wa/:token", async (c) => {
  const claims = await verifyLinkToken(c.env, c.req.param("token"));
  if (!claims?.cap || !claims.ph) {
    const sess = await readSession(c.env, getCookie(c, COOKIE_NAME));
    if (sess?.role === "captain") return c.redirect("/captain");
    return c.redirect("/auth/expired?role=captain");
  }
  const providers = await getCaptainProviders(c.env.DB, claims.ph);
  if (!providers.length) return c.redirect("/captain"); // no longer a captain
  const name = await captainName(c.env.DB, claims.ph);
  const token = await issueSession(c.env, { role: "captain", phone: claims.ph, name });
  setCookie(c, COOKIE_NAME, token, sessionCookieOpts);
  return c.redirect("/captain");
});

// The WhatsApp number + prefilled "login" text so the app's "not signed in"
// screen can offer a one-tap "open WhatsApp" button.
app.get("/auth/captain/wa-login/info", async (c) => {
  const s = await getSettings(c.env.DB);
  const number = (s?.wa_display_number || "").replace(/[^\d]/g, "") || null;
  const message = "capt";
  return c.json({ number, message, waLink: number ? `https://wa.me/${number}?text=${encodeURIComponent(message)}` : null });
});

// ── Manager auth — WhatsApp-only, mirrors captains (no passwords) ─────────────
app.get("/auth/manager/wa/:token", async (c) => {
  const claims = await verifyLinkToken(c.env, c.req.param("token"));
  if (!claims?.mgr || !claims.ph) {
    const sess = await readSession(c.env, getCookie(c, COOKIE_NAME));
    if (sess?.role === "manager") return c.redirect("/manager");
    return c.redirect("/auth/expired?role=manager");
  }
  const providers = await getManagerProviders(c.env.DB, claims.ph);
  if (!providers.length) return c.redirect("/manager"); // no longer a manager
  const name = await managerName(c.env.DB, claims.ph);
  const token = await issueSession(c.env, { role: "manager", phone: claims.ph, name });
  setCookie(c, COOKIE_NAME, token, sessionCookieOpts);
  return c.redirect("/manager");
});

app.get("/auth/manager/wa-login/info", async (c) => {
  const s = await getSettings(c.env.DB);
  const number = (s?.wa_display_number || "").replace(/[^\d]/g, "") || null;
  const message = "admin";
  return c.json({ number, message, waLink: number ? `https://wa.me/${number}?text=${encodeURIComponent(message)}` : null });
});

// Shared "link expired" landing. A WhatsApp magic link is only valid for ~1 hour
// (it's a bearer credential); once it lapses and there's no live session, every
// WhatsApp-opened page lands here so the user can get a fresh link in one tap
// instead of hitting a blank/login page. role → the keyword that mints a new link.
// Under /auth/* so it runs the Worker first (not the static-asset SPA fallback).
app.get("/auth/expired", async (c) => {
  const role = c.req.query("role") || "customer";
  const keyword = role === "captain" ? "capt" : role === "manager" ? "admin" : "hi";
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const brand = c.get("config")?.brand?.name || "Store";
  const s = await getSettings(c.env.DB);
  const number = (s?.wa_display_number || "").replace(/[^\d]/g, "");
  const waLink = number ? `https://wa.me/${number}?text=${encodeURIComponent(keyword)}` : null;
  const cta = waLink
    ? `<a href="${waLink}" style="display:inline-block;margin-top:16px;padding:13px 22px;border-radius:10px;background:var(--accent);color:#fff;text-decoration:none;font-weight:600">📲 Open WhatsApp</a>`
    : `<p style="margin-top:14px">Send "<b>${esc(keyword)}</b>" to our WhatsApp number to get a new link.</p>`;
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>` +
    `<title>Link expired — ${esc(brand)}</title><link rel="stylesheet" href="/style.css"/></head>` +
    `<body><div id="app" style="max-width:460px;margin:0 auto;padding:24px">` +
    `<div class="card" style="text-align:center">` +
    `<div style="font-size:46px;line-height:1">⏰</div>` +
    `<h1 style="margin:10px 0 4px">Link expired</h1>` +
    `<p class="muted">For your security this link only works for a short while. Tap below to get a fresh one on WhatsApp — you'll be signed in automatically.</p>` +
    cta +
    `</div></div></body></html>`;
  return c.html(html);
});

// Who am I + which providers I manage (with my tier at each).
app.get("/api/manager/me", requireRole("manager"), async (c) => {
  const sess = c.get("session");
  const providers = await getManagerProviders(c.env.DB, sess.phone);
  const current = providers.find((p) => p.id === sess.provider_id) || null;
  return c.json({ phone: sess.phone, name: sess.name || null, providers, provider_id: sess.provider_id || null, tier: current?.tier || null });
});

// Choose which provider to manage → re-issue a provider-scoped session so all the
// existing provider-scoped endpoints (orders, catalog, …) just work.
app.post("/api/manager/select", requireRole("manager"), async (c) => {
  const sess = c.get("session");
  const { providerId } = await c.req.json().catch(() => ({}));
  const tier = await getManagerFor(c.env.DB, sess.phone, providerId);
  if (!tier) return c.json({ error: "forbidden" }, 403);
  const provider = await getProvider(c.env.DB, providerId);
  const token = await issueSession(c.env, { role: "manager", phone: sess.phone, name: sess.name || null, provider_id: providerId, tier });
  setCookie(c, COOKIE_NAME, token, sessionCookieOpts);
  return c.json({ ok: true, tier, provider: { id: provider.id, slug: provider.slug, name: provider.name } });
});

// ── Captain API (requires a captain session) ─────────────────────────────────
app.get("/api/captain/me", requireRole("captain"), async (c) => {
  const sess = c.get("session");
  const providers = await getCaptainProviders(c.env.DB, sess.phone);
  return c.json({ phone: sess.phone, name: sess.name || null, providers });
});

// Orders assigned to this captain within one of their providers.
app.get("/api/captain/orders", requireRole("captain"), async (c) => {
  const sess = c.get("session");
  const providerId = c.req.query("provider");
  const providers = await getCaptainProviders(c.env.DB, sess.phone);
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) return c.json({ error: "forbidden" }, 403);
  const flow = flowForProvider(await getProvider(c.env.DB, provider.id));
  const jobs = await listCaptainJobs(c.env.DB, flow, sess.phone, provider.id);
  return c.json({ provider, jobs });
});

// Order detail for a captain — includes the provider catalog so the pickup
// captain can reconcile items, and an `editable` flag (only before pickup).
app.get("/api/captain/orders/:id", requireRole("captain"), async (c) => {
  const sess = c.get("session");
  const order = await getOrder(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.captain_phone !== sess.phone && order.delivery_captain_phone !== sess.phone) {
    return c.json({ error: "forbidden" }, 403);
  }
  // Fall back to the linked customer for pre-snapshot orders.
  if (!order.customer_phone || !order.customer_name) {
    const cust = await getCustomer(c.env.DB, order.customer_id);
    order.customer_name = order.customer_name || cust?.name || null;
    order.customer_phone = order.customer_phone || cust?.wa_phone || null;
  }
  const { results: catalog } = await c.env.DB.prepare(
    "SELECT name, category, unit, price FROM catalog_items WHERE provider_id = ? AND active = 1 ORDER BY category, name"
  )
    .bind(order.provider_id)
    .all();
  // The primary (pickup) agent may edit items only while the flow allows it.
  const flow = flowForProvider(await getProvider(c.env.DB, order.provider_id));
  const editable = itemsEditableAt(flow, order.status) && order.captain_phone === sess.phone;
  // The advance action, if this agent owns the slot that advances this status.
  const step = advanceStep(flow, order.status);
  let action = null;
  if (step) {
    const ownerPhone = step.slot === "delivery" ? order.delivery_captain_phone : order.captain_phone;
    if (ownerPhone === sess.phone) action = { to: step.to, label: step.label, paymentDue: step.to === flow.paymentAfter };
  }
  return c.json({ order, catalog, editable, action, paymentAfter: flow.paymentAfter });
});

// Pickup captain reconciles items (add / remove / change qty) — allowed only
// while ASSIGNED. Once picked up, items are locked for everyone.
app.patch("/api/captain/orders/:id/items", requireRole("captain"), async (c) => {
  const sess = c.get("session");
  const { items } = await c.req.json().catch(() => ({}));
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(c.req.param("id")).first();
  if (!order) return c.json({ error: "not_found" }, 404);
  const flow = flowForProvider(await getProvider(c.env.DB, order.provider_id));
  if (order.captain_phone !== sess.phone || !itemsEditableAt(flow, order.status)) {
    return c.json({ error: "locked" }, 403); // not the primary agent, or items no longer editable
  }
  if (!Array.isArray(items)) return c.json({ error: "no_items" }, 400);
  await replaceOrderItems(c.env.DB, order.id, order.provider_id, items);
  await notifyOrders(c.env, order.provider_id);
  return c.json({ ok: true, order: await getOrder(c.env.DB, order.id) });
});

// Field agent advances an order one step (flow-driven). Body: { to }. Guarded:
// the agent must own the slot that advances the order's current status, and `to`
// must be exactly the flow's next step from here.
app.post("/api/captain/orders/:id/advance", requireRole("captain"), async (c) => {
  const sess = c.get("session");
  const { to } = await c.req.json().catch(() => ({}));
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(c.req.param("id")).first();
  if (!order) return c.json({ error: "not_found" }, 404);
  const flow = flowForProvider(await getProvider(c.env.DB, order.provider_id));
  const step = advanceStep(flow, order.status);
  if (!step || step.to !== to) return c.json({ error: "invalid_transition" }, 400);
  const ownerPhone = step.slot === "delivery" ? order.delivery_captain_phone : order.captain_phone;
  if (ownerPhone !== sess.phone) return c.json({ error: "forbidden" }, 403);
  try {
    const updated = await transitionOrder(c.env, c.env.DB, { orderId: order.id, toStatus: step.to, actor: "captain" });
    await notifyOrders(c.env, order.provider_id);
    return c.json({ ok: true, order: updated, paymentDue: step.to === flow.paymentAfter });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

// UPI payment QR for an order — shown to the customer after delivery. Builds a
// upi://pay deep-link for the provider's VPA + the order amount and renders it
// as an SVG QR server-side.
app.get("/api/captain/orders/:id/payment", requireRole("captain"), async (c) => {
  const sess = c.get("session");
  const order = await getOrder(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.captain_phone !== sess.phone && order.delivery_captain_phone !== sess.phone) return c.json({ error: "forbidden" }, 403);
  const provider = await getProvider(c.env.DB, order.provider_id);
  const pay = {
    payment_status: order.payment_status || null,
    payment_amount: order.payment_amount || null,
    payment_payer: order.payment_payer || null,
  };
  if (!provider?.upi_id) return c.json({ hasUpi: false, ...pay });
  const amount = (Number(order.total || 0) / 100).toFixed(2);
  const payee = provider.upi_name || provider.name;
  // tr = transaction reference (the merchant's order ref — PSPs track/report this,
  // unlike the free-text tn note). Carries our order id so payment emails/reports
  // can be matched back exactly.
  const upi =
    `upi://pay?pa=${encodeURIComponent(provider.upi_id)}&pn=${encodeURIComponent(payee)}` +
    `&am=${amount}&cu=INR&tr=${encodeURIComponent(order.id)}&tn=${encodeURIComponent("Order " + order.id)}`;
  const svg = await QRCode.toString(upi, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return c.json({ hasUpi: true, upi_id: provider.upi_id, upi_name: payee, amount, upi, svg, ...pay });
});

// Captain records a cash payment for an order they're assigned to.
app.post("/api/captain/orders/:id/cash", requireRole("captain"), async (c) => {
  const sess = c.get("session");
  const order = await getOrder(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.captain_phone !== sess.phone && order.delivery_captain_phone !== sess.phone) return c.json({ error: "forbidden" }, 403);
  await c.env.DB
    .prepare("UPDATE orders SET payment_status = 'paid', payment_amount = ?, payment_payer = ?, payment_ref = 'CASH', payment_at = ?, updated_at = ? WHERE id = ?")
    .bind(order.total || null, `Cash · ${sess.name || "captain"}`, now(), now(), order.id)
    .run();
  await notifyOrders(c.env, order.provider_id);
  return c.json({ ok: true });
});

// Change own password (admin / super_admin). Verifies the current password.
app.post("/api/account/password", requireRole("admin", "super_admin"), async (c) => {
  const sess = c.get("session");
  const { current, next } = await c.req.json().catch(() => ({}));
  if (!current || !next) return c.json({ error: "missing" }, 400);
  if (String(next).length < 8) return c.json({ error: "too_short" }, 400);

  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(sess.user_id).first();
  if (!user || !(await verifyPassword(current, user.pass_hash))) {
    return c.json({ error: "wrong_current_password" }, 401);
  }
  await c.env.DB.prepare("UPDATE users SET pass_hash = ? WHERE id = ?")
    .bind(await hashPassword(next), user.id)
    .run();
  return c.json({ ok: true });
});

// WhatsApp magic link → establish a customer session and redirect to their app.
// No login prompt: the token was minted for this customer's verified number.
app.get("/auth/wa/:token", async (c) => {
  const claims = await verifyLinkToken(c.env, c.req.param("token"));
  if (!claims) {
    // Expired/invalid link. If they still have a live session cookie, let them
    // through; otherwise send them back to WhatsApp for a fresh link.
    const sess = await readSession(c.env, getCookie(c, COOKIE_NAME));
    if (sess?.role === "customer") return c.redirect("/start");
    return c.redirect("/auth/expired?role=customer");
  }
  const session = await issueSession(c.env, {
    role: "customer",
    customer_id: claims.cid,
    wa_phone: claims.ph,
  });
  setCookie(c, COOKIE_NAME, session, sessionCookieOpts);
  // A slug → straight to that provider's order form (white-label); no slug → the
  // marketplace chooser (town), where the customer picks a vertical then a provider.
  return c.redirect(claims.slug ? `/${claims.slug}/app` : "/start");
});

// Who am I (drives client-side dashboard rendering).
app.get("/api/me", async (c) => {
  const sess = await readSession(c.env, c.req.header("cookie")?.match(/sd_session=([^;]+)/)?.[1]);
  if (!sess) return c.json({ authenticated: false });
  return c.json({ authenticated: true, ...sess });
});

// ─────────────────────────────────────────────────────────────────────────────
// Public (customer-facing) API
// ─────────────────────────────────────────────────────────────────────────────

// Provider info + catalog for the customer order form.
app.get("/api/providers/:slug", async (c) => {
  const provider = await getProviderBySlug(c.env.DB, c.req.param("slug"));
  if (!provider) return c.json({ error: "not_found" }, 404);
  const { results: catalog } = await c.env.DB.prepare(
    "SELECT id, name, category, unit, price FROM catalog_items WHERE provider_id = ? AND active = 1 ORDER BY category, name"
  )
    .bind(provider.id)
    .all();
  const cfg = safeConfig(provider.config);
  return c.json({
    id: provider.id,
    slug: provider.slug,
    name: provider.name,
    vertical: provider.vertical || null,
    currency: cfg.currency || "INR",
    photo_order: provider.photo_order ? 1 : 0, // 1 = customer may upload a photo/list to auto-fill items
    catalog,
    flow: flowForProvider(provider), // the vertical's flow — drives status labels/tracking
  });
});

// Customer creates an order (must be logged in as customer).
// Customer uploads a photo/list; Groq reads it into a draft item list they can
// edit before placing the order. Only offered when the provider has photo_order on.
app.post("/api/my/orders/extract", requireRole("customer"), async (c) => {
  const { slug, image } = await c.req.json().catch(() => ({}));
  const provider = await getProviderBySlug(c.env.DB, slug);
  if (!provider) return c.json({ error: "unknown_provider" }, 400);
  if (!provider.photo_order) return c.json({ error: "photo_order_disabled" }, 403);
  if (!image) return c.json({ error: "no_image" }, 400);
  const r = await extractItemsFromImage(c.env, c.env.DB, provider, image);
  if (!r.ok) return c.json({ error: r.error || "extract_failed" }, 400);
  return c.json({ ok: true, items: r.items });
});

app.post("/api/my/orders", requireRole("customer"), async (c) => {
  const sess = c.get("session");
  const { slug, address, lat, lng, address_id, items, note, images } = await c.req.json().catch(() => ({}));
  const provider = await getProviderBySlug(c.env.DB, slug);
  if (!provider) return c.json({ error: "unknown_provider" }, 400);
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: "no_items" }, 400);
  // Only accept stored photos for photo_order providers; cap count + size defensively.
  const imgs = provider.photo_order && Array.isArray(images)
    ? images.filter((d) => typeof d === "string" && d.startsWith("data:image/") && d.length < 900_000).slice(0, 8)
    : [];

  // Prefer a saved address (ownership-checked); fall back to inline address/lat/lng.
  let addr = address,
    alat = lat,
    alng = lng,
    addrId = null,
    cName = null,
    cPhone = null;
  if (address_id) {
    const a = await getAddress(c.env.DB, address_id, sess.customer_id);
    if (!a) return c.json({ error: "unknown_address" }, 400);
    addr = fullAddress(a);
    alat = a.lat;
    alng = a.lng;
    addrId = a.id;
    cName = a.contact_name;
    cPhone = a.contact_phone;
  }

  // Snapshot the ordering customer's identity onto the order.
  const customer = await getCustomer(c.env.DB, sess.customer_id);
  const order = await createOrder(c.env.DB, {
    providerId: provider.id,
    customerId: sess.customer_id,
    address: addr,
    lat: alat,
    lng: alng,
    addressId: addrId,
    customerName: customer?.name || cName || null,
    customerPhone: customer?.wa_phone || sess.wa_phone || null,
    contactName: cName,
    contactPhone: cPhone,
    items,
    note,
    images: imgs,
  });
  await notifyOrders(c.env, provider.id);
  return c.json({ ok: true, order });
});

// ── Customer address book ────────────────────────────────────────────────────
app.get("/api/my/addresses", requireRole("customer"), async (c) => {
  const sess = c.get("session");
  return c.json({ addresses: await listAddresses(c.env.DB, sess.customer_id) });
});

app.post("/api/my/addresses", requireRole("customer"), async (c) => {
  const sess = c.get("session");
  const { label, name, phone, line1, area, lat, lng, makeDefault } = await c.req.json().catch(() => ({}));
  if (!line1 && !area) return c.json({ error: "empty" }, 400);
  // First address (or explicit request) becomes the default.
  const existing = await listAddresses(c.env.DB, sess.customer_id);
  const address = await createAddress(c.env.DB, {
    customerId: sess.customer_id,
    label,
    contactName: name,
    contactPhone: phone,
    line1,
    area,
    lat,
    lng,
    makeDefault: makeDefault || existing.length === 0,
  });
  return c.json({ ok: true, address });
});

// Mark one address as default (pre-selected on future orders).
app.post("/api/my/addresses/:id/default", requireRole("customer"), async (c) => {
  const sess = c.get("session");
  const a = await getAddress(c.env.DB, c.req.param("id"), sess.customer_id);
  if (!a) return c.json({ error: "not_found" }, 404);
  await setDefaultAddress(c.env.DB, a.id, sess.customer_id);
  return c.json({ ok: true });
});

app.delete("/api/my/addresses/:id", requireRole("customer"), async (c) => {
  const sess = c.get("session");
  await c.env.DB.prepare("DELETE FROM customer_addresses WHERE id = ? AND customer_id = ?")
    .bind(c.req.param("id"), sess.customer_id)
    .run();
  return c.json({ ok: true });
});

// Ola Maps address autocomplete (proxied so the API key stays server-side).
// Any signed-in user can call it (the order form requires a customer session).
app.get("/api/geo/suggest", requireRole("customer", "admin", "super_admin"), async (c) => {
  const q = c.req.query("q") || "";
  if (q.trim().length < 3) return c.json({ suggestions: [] });
  const loc = c.req.query("loc"); // optional "lat,lng" bias
  const settings = await getSettings(c.env.DB);
  const r = await olaSuggest(settings, q.trim(), loc);
  if (r.notConfigured) return c.json({ suggestions: [], notConfigured: true });
  return c.json({ suggestions: r.suggestions || [] });
});

// The Ola Maps key for rendering map tiles client-side. Session-gated; the key
// is still visible in tile requests, so domain-restrict it in the Ola console.
app.get("/api/geo/mapkey", requireRole("customer", "admin", "super_admin"), async (c) => {
  const s = await getSettings(c.env.DB);
  return c.json({ key: s?.ola_maps_api_key || null });
});

// Reverse geocode the map-pin location → address.
app.get("/api/geo/reverse", requireRole("customer", "admin", "super_admin"), async (c) => {
  const lat = c.req.query("lat");
  const lng = c.req.query("lng");
  if (!lat || !lng) return c.json({ error: "missing" }, 400);
  const settings = await getSettings(c.env.DB);
  const r = await olaReverse(settings, lat, lng);
  return c.json(r);
});

// Customer lists their own orders (scoped by session, never by client input).
app.get("/api/my/orders", requireRole("customer"), async (c) => {
  const sess = c.get("session");
  const { results } = await c.env.DB.prepare(
    "SELECT id, provider_id, status, address, created_at, updated_at, " +
      "(SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id = orders.id) AS total " +
      "FROM orders WHERE customer_id = ? ORDER BY created_at DESC"
  )
    .bind(sess.customer_id)
    .all();
  return c.json({ orders: results });
});

// Customer views one of their orders (ownership enforced).
app.get("/api/my/orders/:id", requireRole("customer"), async (c) => {
  const sess = c.get("session");
  const order = await getOrder(c.env.DB, c.req.param("id"));
  if (!order || order.customer_id !== sess.customer_id) return c.json({ error: "not_found" }, 404);
  return c.json({ order });
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin (provider) API — scoped to the admin's own provider_id
// ─────────────────────────────────────────────────────────────────────────────

// Resolve which provider(s) the caller may act on.
function providerScope(sess) {
  return sess.role === "super_admin" ? null : sess.provider_id; // null = all
}

// ── Live order updates (WebSocket → Durable Object) ──────────────────────────
// Every dashboard opens this; the Worker forwards the socket to the hub DO,
// tagged by scope ("all" for super-admin, else the provider id).
app.get("/api/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") return c.text("expected websocket", 426);
  const sess = await readSession(c.env, getCookie(c, COOKIE_NAME));
  if (!sess) return c.text("unauthorized", 401);

  let scope = null;
  if (sess.role === "super_admin") scope = "all";
  else if (sess.role === "manager" || sess.role === "admin") scope = sess.provider_id || null;
  else if (sess.role === "captain") {
    const p = c.req.query("provider");
    const providers = await getCaptainProviders(c.env.DB, sess.phone);
    if (p && providers.find((x) => x.id === p)) scope = p;
  } else if (sess.role === "customer") {
    scope = c.req.query("provider") || null; // refresh ping only; data stays customer-scoped
  }
  if (!scope) return c.text("no scope", 400);

  const stub = c.env.ORDERS_HUB.get(c.env.ORDERS_HUB.idFromName("global"));
  return stub.fetch(new Request(`https://orders-hub/connect?scope=${encodeURIComponent(scope)}`, c.req.raw));
});

// Middleware: allow super_admin (any provider) or a manager scoped to URL :id.
const providerManage = async (c, next) => {
  const sess = c.get("session");
  if (sess.role === "super_admin") return next();
  if (sess.role === "manager" && sess.provider_id && sess.provider_id === c.req.param("id")) return next();
  return c.json({ error: "forbidden" }, 403);
};
// Additionally require the admin tier (managing other managers).
const providerAdmin = async (c, next) => {
  const sess = c.get("session");
  if (sess.role === "super_admin") return next();
  if (sess.role === "manager" && sess.tier === "admin" && sess.provider_id === c.req.param("id")) return next();
  return c.json({ error: "forbidden" }, 403);
};

app.get("/api/admin/orders", requireRole("admin", "super_admin", "manager"), async (c) => {
  const sess = c.get("session");
  const scope = providerScope(sess);
  if (sess.role !== "super_admin" && !scope) return c.json({ orders: [] }); // no provider selected
  const status = c.req.query("status");
  const from = c.req.query("from"); // YYYY-MM-DD (IST calendar day)
  const to = c.req.query("to");
  const clauses = [];
  const binds = [];
  if (scope) {
    clauses.push("provider_id = ?");
    binds.push(scope);
  }
  if (status) {
    clauses.push("status = ?");
    binds.push(status);
  }
  // Filter on created_at across the IST day boundaries.
  const fromMs = istDayStart(from);
  const toMs = istDayEnd(to);
  if (fromMs != null) {
    clauses.push("created_at >= ?");
    binds.push(fromMs);
  }
  if (toMs != null) {
    clauses.push("created_at <= ?");
    binds.push(toMs);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const { results } = await c.env.DB.prepare(
    `SELECT *, (SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id = orders.id) AS total ` +
      `FROM orders ${where} ORDER BY created_at DESC LIMIT 500`
  )
    .bind(...binds)
    .all();
  return c.json({ orders: results });
});

app.get("/api/admin/orders/:id", requireRole("admin", "super_admin", "manager"), async (c) => {
  const sess = c.get("session");
  const order = await getOrder(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "not_found" }, 404);
  const scope = providerScope(sess);
  if (sess.role !== "super_admin" && !scope) return c.json({ error: "forbidden" }, 403);
  if (scope && order.provider_id !== scope) return c.json({ error: "forbidden" }, 403);
  // enrich with customer contact, valid next statuses, and the provider's captains
  const customer = await getCustomer(c.env.DB, order.customer_id);
  const captains = await listCaptains(c.env.DB, order.provider_id);
  const flow = flowForProvider(await getProvider(c.env.DB, order.provider_id));
  return c.json({ order, customer, allowedNext: allowedTransitions(flow, order.status), captains, flow });
});

// Advance status / assign captain → fires the WhatsApp notification.
app.patch("/api/admin/orders/:id/status", requireRole("admin", "super_admin", "manager"), async (c) => {
  const sess = c.get("session");
  const { status, agentName, captainPhone } = await c.req.json().catch(() => ({}));
  const order = await c.env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(c.req.param("id")).first();
  if (!order) return c.json({ error: "not_found" }, 404);
  const scope = providerScope(sess);
  if (sess.role !== "super_admin" && !scope) return c.json({ error: "forbidden" }, 403);
  if (scope && order.provider_id !== scope) return c.json({ error: "forbidden" }, 403);

  try {
    const updated = await transitionOrder(c.env, c.env.DB, {
      orderId: order.id,
      toStatus: status,
      actor: sess.role,
      agentName,
      captainPhone,
    });
    await notifyOrders(c.env, order.provider_id);
    return c.json({ ok: true, order: updated });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});

// Manager/admin reconciles the item list before accepting a photo/list order —
// keep/delete/adjust what Groq extracted. Only while still REQUESTED (pre-accept).
app.patch("/api/admin/orders/:id/items", requireRole("admin", "super_admin", "manager"), async (c) => {
  const sess = c.get("session");
  const { items } = await c.req.json().catch(() => ({}));
  const order = await getOrder(c.env.DB, c.req.param("id"));
  if (!order) return c.json({ error: "not_found" }, 404);
  const scope = providerScope(sess);
  if (sess.role !== "super_admin" && !scope) return c.json({ error: "forbidden" }, 403);
  if (scope && order.provider_id !== scope) return c.json({ error: "forbidden" }, 403);
  if (order.status !== "REQUESTED") return c.json({ error: "not_editable" }, 409);
  if (!Array.isArray(items) || items.length === 0) return c.json({ error: "no_items" }, 400);
  await replaceOrderItems(c.env.DB, order.id, order.provider_id, items);
  return c.json({ ok: true, order: await getOrder(c.env.DB, order.id) });
});

// ── Captains roster (super-admin or provider manager) ────────────────────────
app.get("/api/console/providers/:id/captains", requireRole("super_admin", "manager"), providerManage, async (c) => {
  return c.json({ captains: await listCaptains(c.env.DB, c.req.param("id")) });
});
app.post("/api/console/providers/:id/captains", requireRole("super_admin", "manager"), providerManage, async (c) => {
  const { name, phone } = await c.req.json().catch(() => ({}));
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!name?.trim() || digits.length < 10) return c.json({ error: "invalid" }, 400);
  const id = await createCaptain(c.env.DB, { providerId: c.req.param("id"), name: name.trim(), phone: digits });
  return c.json({ ok: true, id });
});
app.delete("/api/console/providers/:id/captains/:capId", requireRole("super_admin", "manager"), providerManage, async (c) => {
  await deleteCaptain(c.env.DB, c.req.param("capId"), c.req.param("id"));
  return c.json({ ok: true });
});

// ── Managers roster (super-admin or an *admin-tier* provider manager) ─────────
app.get("/api/console/providers/:id/managers", requireRole("super_admin", "manager"), providerAdmin, async (c) => {
  return c.json({ managers: await listManagers(c.env.DB, c.req.param("id")) });
});
app.post("/api/console/providers/:id/managers", requireRole("super_admin", "manager"), providerAdmin, async (c) => {
  const { name, phone, tier } = await c.req.json().catch(() => ({}));
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!name?.trim() || digits.length < 10) return c.json({ error: "invalid" }, 400);
  const id = await createManager(c.env.DB, { providerId: c.req.param("id"), name: name.trim(), phone: digits, tier });
  return c.json({ ok: true, id });
});
app.delete("/api/console/providers/:id/managers/:mgrId", requireRole("super_admin", "manager"), providerAdmin, async (c) => {
  await deleteManager(c.env.DB, c.req.param("mgrId"), c.req.param("id"));
  return c.json({ ok: true });
});

// ── Payment / UPI (super-admin or an *admin-tier* provider manager) ──────────
app.get("/api/console/providers/:id/payment", requireRole("super_admin", "manager"), providerAdmin, async (c) => {
  const p = await getProvider(c.env.DB, c.req.param("id"));
  return c.json({ upi_id: p?.upi_id || "", upi_name: p?.upi_name || "" });
});
app.patch("/api/console/providers/:id/payment", requireRole("super_admin", "manager"), providerAdmin, async (c) => {
  const { upi_id, upi_name } = await c.req.json().catch(() => ({}));
  const vpa = String(upi_id || "").trim();
  // Basic VPA shape: local@handle (allow empty to clear).
  if (vpa && !/^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/.test(vpa)) return c.json({ error: "invalid_upi" }, 400);
  await c.env.DB.prepare("UPDATE service_providers SET upi_id = ?, upi_name = ? WHERE id = ?")
    .bind(vpa || null, String(upi_name || "").trim() || null, c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

// Status flow for the admin UI — per provider (?provider=<id>), falling back to
// the town's default vertical when none is given.
app.get("/api/admin/meta", requireRole("admin", "super_admin", "manager"), async (c) => {
  const pid = c.req.query("provider");
  const provider = pid ? await getProvider(c.env.DB, pid) : null;
  const flow = flowForProvider(provider);
  return c.json({ statusFlow: flow.statuses, terminal: flow.terminal });
});

// Town config for the SPAs: brand + the default vertical's flow (single-vertical
// apps use this; the marketplace SPA fetches flow per provider via /api/flow).
app.get("/api/config", (c) => {
  const cfg = c.get("config");
  return c.json({ brand: cfg.brand, defaultVertical: cfg.defaultVertical || null, flow: flowForVertical(cfg.defaultVertical) });
});

// The town's active verticals — for the customer "pick a service" chooser. Public.
app.get("/api/verticals", async (c) => {
  return c.json({ verticals: await listVerticals(c.env.DB) });
});

// Providers within a vertical — for the chooser's second step. Public.
app.get("/api/verticals/:slug/providers", async (c) => {
  return c.json({ providers: await listProvidersByVertical(c.env.DB, c.req.param("slug")) });
});

// The resolved flow for a given provider (id or slug) — used by the captain/manager
// SPAs, which can span verticals, after they pick/select a provider.
app.get("/api/flow", async (c) => {
  const key = c.req.query("provider");
  if (!key) return c.json({ error: "missing_provider" }, 400);
  const provider = (await getProvider(c.env.DB, key)) || (await getProviderBySlug(c.env.DB, key));
  return c.json({ flow: flowForProvider(provider), vertical: provider?.vertical || null });
});

// Test the payment-email → Groq → order matching without email routing. Paste a
// real email's subject + body; dry-run by default (apply:true to write it).
app.post("/api/console/payment-email/test", requireRole("super_admin"), async (c) => {
  const { subject, text, apply } = await c.req.json().catch(() => ({}));
  const r = await processPaymentEmail(c.env, subject || "", text || "", { apply: !!apply });
  return c.json(r);
});

// Recent payment emails the Worker actually received (audit + debugging).
app.get("/api/console/payment-email/log", requireRole("super_admin"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM payment_email_log ORDER BY created_at DESC LIMIT 50").all();
  return c.json({ log: results });
});

// ─────────────────────────────────────────────────────────────────────────────
// Super-admin console API — manage providers, catalogs, and provider admins
// ─────────────────────────────────────────────────────────────────────────────

// ── WhatsApp / Meta platform settings ────────────────────────────────────────
// GET returns the webhook URL to paste into the Meta dashboard, the current
// verify token, and whether the sensitive fields are set (never echoes them).
app.get("/api/console/settings", requireRole("super_admin"), async (c) => {
  const s = await getSettings(c.env.DB);
  const origin = new URL(c.req.url).origin;
  return c.json({
    webhook_url: `${origin}/webhook/whatsapp`,
    verify_token: s?.wa_verify_token || "",
    api_version: s?.wa_api_version || "v21.0",
    app_secret_set: !!s?.wa_app_secret,
    token_set: !!s?.wa_token,
    maps_set: olaConfigured(s),
    groq_set: !!s?.groq_api_key,
    wa_display_number: s?.wa_display_number || "",
    updated_at: s?.updated_at || null,
  });
});

// Save WhatsApp config. Secret fields (app_secret, token) are only overwritten
// when a non-empty value is supplied, so re-saving the form doesn't wipe them.
app.post("/api/console/settings", requireRole("super_admin"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cur = (await getSettings(c.env.DB)) || {};
  const verify = body.wa_verify_token?.trim() || cur.wa_verify_token || null;
  const appSecret = body.wa_app_secret?.trim() ? body.wa_app_secret.trim() : cur.wa_app_secret || null;
  const token = body.wa_token?.trim() ? body.wa_token.trim() : cur.wa_token || null;
  const apiVersion = body.wa_api_version?.trim() || cur.wa_api_version || "v21.0";
  const olaKey = body.ola_maps_api_key?.trim() ? body.ola_maps_api_key.trim() : cur.ola_maps_api_key || null;
  const groqKey = body.groq_api_key?.trim() ? body.groq_api_key.trim() : cur.groq_api_key || null;
  const displayNumber = body.wa_display_number !== undefined
    ? String(body.wa_display_number).replace(/[^\d]/g, "") || null
    : cur.wa_display_number || null;
  await c.env.DB.prepare(
    "INSERT INTO platform_settings (id, wa_verify_token, wa_app_secret, wa_token, wa_api_version, ola_maps_api_key, groq_api_key, wa_display_number, updated_at) " +
      "VALUES ('global',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET " +
      "wa_verify_token=excluded.wa_verify_token, wa_app_secret=excluded.wa_app_secret, " +
      "wa_token=excluded.wa_token, wa_api_version=excluded.wa_api_version, " +
      "ola_maps_api_key=excluded.ola_maps_api_key, groq_api_key=excluded.groq_api_key, wa_display_number=excluded.wa_display_number, updated_at=excluded.updated_at"
  )
    .bind(verify, appSecret, token, apiVersion, olaKey, groqKey, displayNumber, now())
    .run();
  return c.json({ ok: true });
});

app.get("/api/console/providers", requireRole("super_admin"), async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, slug, name, wa_phone_number_id, (wa_token IS NOT NULL) AS has_token, created_at FROM service_providers ORDER BY created_at DESC"
  ).all();
  return c.json({ providers: results });
});

app.get("/api/console/providers/:id", requireRole("super_admin"), async (c) => {
  const p = await getProvider(c.env.DB, c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  return c.json({ id: p.id, slug: p.slug, name: p.name, wa_phone_number_id: p.wa_phone_number_id, has_token: !!p.wa_token });
});

app.post("/api/console/providers", requireRole("super_admin"), async (c) => {
  const { slug, name, wa_phone_number_id, wa_token, config } = await c.req.json().catch(() => ({}));
  if (!slug || !name) return c.json({ error: "missing" }, 400);
  const id = randomId();
  try {
    await c.env.DB.prepare(
      "INSERT INTO service_providers (id, slug, name, wa_phone_number_id, wa_token, config, created_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind(id, slug, name, wa_phone_number_id || null, wa_token || null, JSON.stringify(config || {}), now())
      .run();
  } catch (e) {
    return c.json({ error: "slug_taken_or_invalid", detail: String(e) }, 400);
  }
  return c.json({ ok: true, id });
});

// Update a provider's details (name / phone-number-id / per-provider token).
app.patch("/api/console/providers/:id", requireRole("super_admin"), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cur = await getProvider(c.env.DB, c.req.param("id"));
  if (!cur) return c.json({ error: "not_found" }, 404);
  const name = body.name?.trim() || cur.name;
  const pnid = body.wa_phone_number_id !== undefined ? body.wa_phone_number_id || null : cur.wa_phone_number_id;
  const token = body.wa_token?.trim() ? body.wa_token.trim() : cur.wa_token; // blank keeps existing
  await c.env.DB.prepare(
    "UPDATE service_providers SET name = ?, wa_phone_number_id = ?, wa_token = ? WHERE id = ?"
  )
    .bind(name, pnid, token, c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

// Register a category name for a provider (idempotent).
async function ensureCategory(db, providerId, name) {
  if (!name?.trim()) return;
  await db
    .prepare("INSERT OR IGNORE INTO provider_categories (id, provider_id, name, created_at) VALUES (?,?,?,?)")
    .bind(randomId(), providerId, name.trim(), now())
    .run();
}

app.get("/api/console/providers/:id/categories", requireRole("super_admin", "manager"), providerManage, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name FROM provider_categories WHERE provider_id = ? ORDER BY name"
  )
    .bind(c.req.param("id"))
    .all();
  return c.json({ categories: results });
});

app.post("/api/console/providers/:id/categories", requireRole("super_admin", "manager"), providerManage, async (c) => {
  const { name } = await c.req.json().catch(() => ({}));
  if (!name?.trim()) return c.json({ error: "missing" }, 400);
  await ensureCategory(c.env.DB, c.req.param("id"), name);
  return c.json({ ok: true });
});

app.delete("/api/console/providers/:id/categories/:catId", requireRole("super_admin", "manager"), providerManage, async (c) => {
  await c.env.DB.prepare("DELETE FROM provider_categories WHERE id = ? AND provider_id = ?")
    .bind(c.req.param("catId"), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

app.post("/api/console/providers/:id/catalog", requireRole("super_admin", "manager"), providerManage, async (c) => {
  const { name, unit, price, category } = await c.req.json().catch(() => ({}));
  if (!name) return c.json({ error: "missing" }, 400);
  const id = randomId();
  await c.env.DB.prepare(
    "INSERT INTO catalog_items (id, provider_id, name, category, unit, price, active) VALUES (?,?,?,?,?,?,1)"
  )
    .bind(id, c.req.param("id"), name, category?.trim() || null, unit || "piece", parseInt(price, 10) || 0)
    .run();
  await ensureCategory(c.env.DB, c.req.param("id"), category); // auto-add a new category
  return c.json({ ok: true, id });
});

// Edit a catalog item (price is in paise). Scoped to the provider.
app.patch("/api/console/providers/:id/catalog/:itemId", requireRole("super_admin", "manager"), providerManage, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const cur = await c.env.DB.prepare("SELECT * FROM catalog_items WHERE id = ? AND provider_id = ?")
    .bind(c.req.param("itemId"), c.req.param("id"))
    .first();
  if (!cur) return c.json({ error: "not_found" }, 404);
  const name = body.name?.trim() || cur.name;
  const category = body.category !== undefined ? body.category?.trim() || null : cur.category;
  const unit = body.unit?.trim() || cur.unit;
  const price = body.price !== undefined ? Math.max(0, parseInt(body.price, 10) || 0) : cur.price;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : cur.active;
  await c.env.DB.prepare("UPDATE catalog_items SET name = ?, category = ?, unit = ?, price = ?, active = ? WHERE id = ?")
    .bind(name, category, unit, price, active, cur.id)
    .run();
  await ensureCategory(c.env.DB, c.req.param("id"), category);
  return c.json({ ok: true });
});

// Delete a catalog item. Past orders keep their own price snapshot, so this is safe.
app.delete("/api/console/providers/:id/catalog/:itemId", requireRole("super_admin", "manager"), providerManage, async (c) => {
  await c.env.DB.prepare("DELETE FROM catalog_items WHERE id = ? AND provider_id = ?")
    .bind(c.req.param("itemId"), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

// Create a provider admin (super-admin only).
app.post("/api/console/admins", requireRole("super_admin"), async (c) => {
  const { email, password, provider_id } = await c.req.json().catch(() => ({}));
  if (!email || !password || !provider_id) return c.json({ error: "missing" }, 400);
  const id = randomId();
  const passHash = await hashPassword(password);
  try {
    await c.env.DB.prepare(
      "INSERT INTO users (id, role, email, pass_hash, provider_id, created_at) VALUES (?,?,?,?,?,?)"
    )
      .bind(id, "admin", String(email).toLowerCase(), passHash, provider_id, now())
      .run();
  } catch (e) {
    return c.json({ error: "email_taken", detail: String(e) }, 400);
  }
  return c.json({ ok: true, id });
});

// ─────────────────────────────────────────────────────────────────────────────
// Control-plane API — the separate super-admin (control-plane) Worker calls these
// with the town's service token (env.CONTROL_TOKEN) to manage the town remotely:
// verticals, providers, catalog, settings, and summary stats.
// ─────────────────────────────────────────────────────────────────────────────
const requireControlToken = async (c, next) => {
  const expected = c.env.CONTROL_TOKEN;
  const got = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "") || c.req.header("x-control-token") || "";
  if (!expected || !got || !timingSafeEqual(String(got), String(expected))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
};

// Town identity + at-a-glance stats.
app.get("/api/control/summary", requireControlToken, async (c) => {
  const cfg = c.get("config");
  const provs = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM service_providers").first();
  const verticals = await listVerticals(c.env.DB);
  const { results: byStatus } = await c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").all();
  return c.json({
    town: cfg.brand?.name || null,
    defaultVertical: cfg.defaultVertical || null,
    providers: provs?.n || 0,
    verticals,
    orders: Object.fromEntries((byStatus || []).map((r) => [r.status, r.n])),
  });
});

// The flow shapes available in this build (so the admin can pick a vertical's flow).
app.get("/api/control/flows", requireControlToken, (c) =>
  c.json({ flows: Object.keys(FLOWS).map((k) => ({ key: k, agentTerm: FLOWS[k].agentTerm, statuses: FLOWS[k].statuses })) })
);

// Verticals (including inactive).
app.get("/api/control/verticals", requireControlToken, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT slug, name, flow, emoji, sort, active FROM verticals ORDER BY sort, name").all().catch(() => ({ results: [] }));
  return c.json({ verticals: results || [] });
});
app.post("/api/control/verticals", requireControlToken, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = body.name;
  // The flow (state machine) the vertical runs. Many verticals may share one flow
  // (medical/fruits/milk → 'delivery'). Slug is the vertical's own identity; it
  // defaults to the flow key so older single-vertical-per-flow callers still work.
  const flow = body.flow || body.slug;
  const slug = String(body.slug || flow || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const { emoji, sort, active } = body;
  if (!slug || !name) return c.json({ error: "missing" }, 400);
  if (!FLOWS[flow]) return c.json({ error: "unknown_flow", detail: `flow must be one of: ${Object.keys(FLOWS).join(", ")}` }, 400);
  await c.env.DB.prepare(
    "INSERT INTO verticals (slug, name, flow, emoji, sort, active, created_at) VALUES (?,?,?,?,?,?,?) " +
      "ON CONFLICT(slug) DO UPDATE SET name=excluded.name, flow=excluded.flow, emoji=excluded.emoji, sort=excluded.sort, active=excluded.active"
  ).bind(slug, name, flow, emoji || null, parseInt(sort, 10) || 0, active === false ? 0 : 1, now()).run();
  return c.json({ ok: true });
});

// Providers.
app.get("/api/control/providers", requireControlToken, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, slug, name, vertical, photo_order, upi_id, upi_name FROM service_providers ORDER BY vertical, name").all();
  return c.json({ providers: results || [] });
});
app.post("/api/control/providers", requireControlToken, async (c) => {
  const { slug, name, vertical, photo_order, upi_id, upi_name } = await c.req.json().catch(() => ({}));
  if (!slug || !name || !vertical) return c.json({ error: "missing" }, 400);
  const id = randomId();
  try {
    await c.env.DB.prepare("INSERT INTO service_providers (id, slug, name, vertical, photo_order, config, upi_id, upi_name, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id, slug, name, vertical, photo_order ? 1 : 0, "{}", upi_id || null, upi_name || null, now()).run();
  } catch (e) {
    return c.json({ error: "slug_taken_or_invalid", detail: String(e) }, 400);
  }
  return c.json({ ok: true, id });
});
app.patch("/api/control/providers/:id", requireControlToken, async (c) => {
  const cur = await getProvider(c.env.DB, c.req.param("id"));
  if (!cur) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare("UPDATE service_providers SET name=?, vertical=?, photo_order=?, upi_id=?, upi_name=? WHERE id=?")
    .bind(
      b.name?.trim() || cur.name,
      b.vertical || cur.vertical,
      b.photo_order !== undefined ? (b.photo_order ? 1 : 0) : (cur.photo_order || 0),
      b.upi_id !== undefined ? b.upi_id || null : cur.upi_id,
      b.upi_name !== undefined ? b.upi_name || null : cur.upi_name,
      cur.id
    ).run();
  return c.json({ ok: true });
});

// Catalog per provider.
app.get("/api/control/providers/:id/catalog", requireControlToken, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, name, category, unit, price, active FROM catalog_items WHERE provider_id = ? ORDER BY category, name").bind(c.req.param("id")).all();
  return c.json({ catalog: results || [] });
});
app.post("/api/control/providers/:id/catalog", requireControlToken, async (c) => {
  const { name, category, unit, price } = await c.req.json().catch(() => ({}));
  if (!name) return c.json({ error: "missing" }, 400);
  const id = randomId();
  await c.env.DB.prepare("INSERT INTO catalog_items (id, provider_id, name, category, unit, price, active) VALUES (?,?,?,?,?,?,1)")
    .bind(id, c.req.param("id"), name, category?.trim() || null, unit || "piece", parseInt(price, 10) || 0).run();
  await ensureCategory(c.env.DB, c.req.param("id"), category);
  return c.json({ ok: true, id });
});
app.delete("/api/control/providers/:id/catalog/:itemId", requireControlToken, async (c) => {
  await c.env.DB.prepare("DELETE FROM catalog_items WHERE id = ? AND provider_id = ?").bind(c.req.param("itemId"), c.req.param("id")).run();
  return c.json({ ok: true });
});

// Delete a provider (and its catalog/categories/captains/managers).
app.delete("/api/control/providers/:id", requireControlToken, async (c) => {
  const pid = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM catalog_items WHERE provider_id = ?").bind(pid),
    c.env.DB.prepare("DELETE FROM provider_categories WHERE provider_id = ?").bind(pid),
    c.env.DB.prepare("DELETE FROM captains WHERE provider_id = ?").bind(pid),
    c.env.DB.prepare("DELETE FROM managers WHERE provider_id = ?").bind(pid),
    c.env.DB.prepare("DELETE FROM service_providers WHERE id = ?").bind(pid),
  ]);
  return c.json({ ok: true });
});

// Managers per provider (admin / manager tier) — the phone numbers that log into
// the town's /manager PWA over WhatsApp.
app.get("/api/control/providers/:id/managers", requireControlToken, async (c) => {
  return c.json({ managers: await listManagers(c.env.DB, c.req.param("id")) });
});
app.post("/api/control/providers/:id/managers", requireControlToken, async (c) => {
  const { name, phone, tier } = await c.req.json().catch(() => ({}));
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!name?.trim() || digits.length < 10) return c.json({ error: "invalid", need: "name + phone (>=10 digits)" }, 400);
  const id = await createManager(c.env.DB, { providerId: c.req.param("id"), name: name.trim(), phone: digits, tier });
  return c.json({ ok: true, id });
});
app.delete("/api/control/providers/:id/managers/:mgrId", requireControlToken, async (c) => {
  await deleteManager(c.env.DB, c.req.param("mgrId"), c.req.param("id"));
  return c.json({ ok: true });
});

// Captains (field agents) per provider.
app.get("/api/control/providers/:id/captains", requireControlToken, async (c) => {
  return c.json({ captains: await listCaptains(c.env.DB, c.req.param("id")) });
});
app.post("/api/control/providers/:id/captains", requireControlToken, async (c) => {
  const { name, phone } = await c.req.json().catch(() => ({}));
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!name?.trim() || digits.length < 10) return c.json({ error: "invalid", need: "name + phone (>=10 digits)" }, 400);
  const id = await createCaptain(c.env.DB, { providerId: c.req.param("id"), name: name.trim(), phone: digits });
  return c.json({ ok: true, id });
});
app.delete("/api/control/providers/:id/captains/:capId", requireControlToken, async (c) => {
  await deleteCaptain(c.env.DB, c.req.param("capId"), c.req.param("id"));
  return c.json({ ok: true });
});

// Settings (WhatsApp / Ola / Groq / display number). Secret fields only overwrite
// when a non-empty value is supplied.
app.get("/api/control/settings", requireControlToken, async (c) => {
  const s = await getSettings(c.env.DB);
  return c.json({
    api_version: s?.wa_api_version || "v21.0",
    verify_token: s?.wa_verify_token || "",
    app_secret_set: !!s?.wa_app_secret,
    token_set: !!s?.wa_token,
    maps_set: olaConfigured(s),
    groq_set: !!s?.groq_api_key,
    wa_display_number: s?.wa_display_number || "",
    wa_phone_number_id: s?.wa_phone_number_id || "",
  });
});
app.post("/api/control/settings", requireControlToken, async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const cur = (await getSettings(c.env.DB)) || {};
  await c.env.DB.prepare(
    "INSERT INTO platform_settings (id, wa_verify_token, wa_app_secret, wa_token, wa_phone_number_id, wa_api_version, ola_maps_api_key, groq_api_key, wa_display_number, updated_at) " +
      "VALUES ('global',?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET wa_verify_token=excluded.wa_verify_token, wa_app_secret=excluded.wa_app_secret, wa_token=excluded.wa_token, wa_phone_number_id=excluded.wa_phone_number_id, wa_api_version=excluded.wa_api_version, ola_maps_api_key=excluded.ola_maps_api_key, groq_api_key=excluded.groq_api_key, wa_display_number=excluded.wa_display_number, updated_at=excluded.updated_at"
  ).bind(
    b.wa_verify_token?.trim() || cur.wa_verify_token || null,
    b.wa_app_secret?.trim() ? b.wa_app_secret.trim() : cur.wa_app_secret || null,
    b.wa_token?.trim() ? b.wa_token.trim() : cur.wa_token || null,
    b.wa_phone_number_id !== undefined ? String(b.wa_phone_number_id).trim() || null : cur.wa_phone_number_id || null,
    b.wa_api_version?.trim() || cur.wa_api_version || "v21.0",
    b.ola_maps_api_key?.trim() ? b.ola_maps_api_key.trim() : cur.ola_maps_api_key || null,
    b.groq_api_key?.trim() ? b.groq_api_key.trim() : cur.groq_api_key || null,
    b.wa_display_number !== undefined ? String(b.wa_display_number).replace(/[^\d]/g, "") || null : cur.wa_display_number || null,
    now()
  ).run();
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// One-time bootstrap: create the first super-admin. Guarded by SETUP_TOKEN
// secret; refuses once any super_admin exists.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/setup/super-admin", async (c) => {
  if (!c.env.SETUP_TOKEN || c.req.header("X-Setup-Token") !== c.env.SETUP_TOKEN) {
    return c.json({ error: "forbidden" }, 403);
  }
  const existing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'super_admin'").first();
  if (existing?.n > 0) return c.json({ error: "already_initialized" }, 409);

  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ error: "missing" }, 400);
  const id = randomId();
  await c.env.DB.prepare(
    "INSERT INTO users (id, role, email, pass_hash, created_at) VALUES (?,?,?,?,?)"
  )
    .bind(id, "super_admin", String(email).toLowerCase(), await hashPassword(password), now())
    .run();
  return c.json({ ok: true, id });
});

app.get("/api/health", (c) => c.json({ ok: true, service: "sd-service-svc" }));

// ── helpers ──
function normalizePhone(v) {
  const digits = String(v || "").replace(/[^\d]/g, "");
  return digits.length >= 8 ? digits : null;
}

// Convert a YYYY-MM-DD calendar day (IST) to epoch-ms start/end. null if absent/invalid.
function istDayStart(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return null;
  const t = Date.parse(`${ymd}T00:00:00.000+05:30`);
  return Number.isNaN(t) ? null : t;
}
function istDayEnd(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || "")) return null;
  const t = Date.parse(`${ymd}T23:59:59.999+05:30`);
  return Number.isNaN(t) ? null : t;
}

