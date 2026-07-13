// Super-admin control plane — a standalone Worker above the town fleet. It holds
// a registry of towns (each a separately-deployed marketplace Worker, possibly on
// another Cloudflare account) and gives the super-admin full control of every town
// by proxying into that town's token-authed control API (/api/control/*).
//
// This is NOT a marketplace app (no createApp / flows); it's its own small Hono app.
import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { randomId, hashPassword, verifyPassword } from "../../../core/crypto.js";
import { issueSession, readSession, requireRole, COOKIE_NAME, sessionCookieOpts } from "../../../core/session.js";
import { deployTown, testTarget } from "./deploy.js";

const app = new Hono();
const now = () => Date.now();

// ── Auth ─────────────────────────────────────────────────────────────────────
// One-time bootstrap of the first super-admin (guarded by SETUP_TOKEN).
app.post("/api/setup", async (c) => {
  if (!c.env.SETUP_TOKEN || c.req.header("X-Setup-Token") !== c.env.SETUP_TOKEN) return c.json({ error: "forbidden" }, 403);
  const existing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM admin_users").first();
  if (existing?.n > 0) return c.json({ error: "already_initialized" }, 409);
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ error: "missing" }, 400);
  const id = randomId();
  await c.env.DB.prepare("INSERT INTO admin_users (id, email, pass_hash, created_at) VALUES (?,?,?,?)")
    .bind(id, String(email).toLowerCase(), await hashPassword(password), now()).run();
  return c.json({ ok: true, id });
});

app.post("/auth/login", async (c) => {
  const { email, password } = await c.req.json().catch(() => ({}));
  const user = await c.env.DB.prepare("SELECT * FROM admin_users WHERE email = ?").bind(String(email || "").toLowerCase()).first();
  if (!user || !(await verifyPassword(password, user.pass_hash))) return c.json({ error: "invalid_credentials" }, 401);
  const token = await issueSession(c.env, { role: "super_admin", user_id: user.id, email: user.email });
  setCookie(c, COOKIE_NAME, token, sessionCookieOpts);
  return c.json({ ok: true });
});
app.post("/auth/logout", (c) => { deleteCookie(c, COOKIE_NAME, { path: "/" }); return c.json({ ok: true }); });
app.get("/api/me", async (c) => {
  const sess = await readSession(c.env, getCookie(c, COOKIE_NAME));
  return c.json(sess ? { authenticated: true, ...sess } : { authenticated: false });
});

// ── Towns registry ───────────────────────────────────────────────────────────
async function getTown(db, id) {
  return db.prepare("SELECT * FROM towns WHERE id = ?").bind(id).first();
}
// Call a town's control API with its stored service token.
async function callTown(town, path, method = "GET", body) {
  const res = await fetch(town.url.replace(/\/$/, "") + path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${town.control_token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

app.get("/api/towns", requireRole("super_admin"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, slug, name, url, wa_number, domain, cf_account, status, created_at FROM towns ORDER BY created_at DESC").all();
  return c.json({ towns: results || [] });
});
app.post("/api/towns", requireRole("super_admin"), async (c) => {
  const { slug, name, url, control_token, wa_number, domain, cf_account } = await c.req.json().catch(() => ({}));
  if (!slug || !name || !url || !control_token) return c.json({ error: "missing", need: "slug, name, url, control_token" }, 400);
  const id = randomId();
  try {
    await c.env.DB.prepare("INSERT INTO towns (id, slug, name, url, control_token, wa_number, domain, cf_account, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'active', ?)")
      .bind(id, slug, name, url.replace(/\/$/, ""), control_token, wa_number || null, domain || null, cf_account || null, now()).run();
  } catch (e) {
    return c.json({ error: "slug_taken_or_invalid", detail: String(e) }, 400);
  }
  return c.json({ ok: true, id });
});
app.patch("/api/towns/:id", requireRole("super_admin"), async (c) => {
  const cur = await getTown(c.env.DB, c.req.param("id"));
  if (!cur) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare("UPDATE towns SET name=?, url=?, control_token=?, wa_number=?, domain=?, cf_account=?, status=? WHERE id=?")
    .bind(
      b.name?.trim() || cur.name,
      (b.url || cur.url).replace(/\/$/, ""),
      b.control_token?.trim() || cur.control_token,
      b.wa_number !== undefined ? b.wa_number || null : cur.wa_number,
      b.domain !== undefined ? b.domain || null : cur.domain,
      b.cf_account !== undefined ? b.cf_account || null : cur.cf_account,
      b.status || cur.status,
      cur.id
    ).run();
  return c.json({ ok: true });
});
app.delete("/api/towns/:id", requireRole("super_admin"), async (c) => {
  await c.env.DB.prepare("DELETE FROM towns WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

// Test connectivity to a town's control API (does the token work?).
app.get("/api/towns/:id/ping", requireRole("super_admin"), async (c) => {
  const town = await getTown(c.env.DB, c.req.param("id"));
  if (!town) return c.json({ error: "not_found" }, 404);
  try {
    const r = await callTown(town, "/api/control/summary");
    return c.json({ ok: r.status === 200, status: r.status, summary: r.status === 200 ? r.data : null });
  } catch (e) {
    return c.json({ ok: false, error: String(e) });
  }
});

// ── Full control of a town — proxy into its /api/control/* ────────────────────
const towned = (subpath) => async (c) => {
  const town = await getTown(c.env.DB, c.req.param("id"));
  if (!town) return c.json({ error: "town_not_found" }, 404);
  const body = ["POST", "PATCH", "PUT"].includes(c.req.method) ? await c.req.json().catch(() => ({})) : undefined;
  const extra = c.req.param("rest") ? "/" + c.req.param("rest") : "";
  const r = await callTown(town, `/api/control/${subpath}${extra}`, c.req.method, body);
  return c.json(r.data, r.status);
};
app.get("/api/towns/:id/summary", requireRole("super_admin"), towned("summary"));
app.get("/api/towns/:id/flows", requireRole("super_admin"), towned("flows"));
app.get("/api/towns/:id/verticals", requireRole("super_admin"), towned("verticals"));
app.post("/api/towns/:id/verticals", requireRole("super_admin"), towned("verticals"));
app.get("/api/towns/:id/providers", requireRole("super_admin"), towned("providers"));
app.post("/api/towns/:id/providers", requireRole("super_admin"), towned("providers"));
app.get("/api/towns/:id/settings", requireRole("super_admin"), towned("settings"));
app.post("/api/towns/:id/settings", requireRole("super_admin"), towned("settings"));
// Generic proxy into a town's control API for any control path, forwarding method + body.
async function proxyTown(c, controlPath) {
  const town = await getTown(c.env.DB, c.req.param("id"));
  if (!town) return c.json({ error: "town_not_found" }, 404);
  const body = ["POST", "PATCH", "PUT"].includes(c.req.method) ? await c.req.json().catch(() => ({})) : undefined;
  const r = await callTown(town, controlPath, c.req.method, body);
  return c.json(r.data, r.status);
}
const P = (c) => c.req.param("pid");
// Edit / delete a provider.
app.patch("/api/towns/:id/providers/:pid", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}`));
app.delete("/api/towns/:id/providers/:pid", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}`));
// Catalog.
app.get("/api/towns/:id/providers/:pid/catalog", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/catalog`));
app.post("/api/towns/:id/providers/:pid/catalog", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/catalog`));
app.delete("/api/towns/:id/providers/:pid/catalog/:itemId", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/catalog/${c.req.param("itemId")}`));
// Managers (admin numbers) + captains (field agents).
app.get("/api/towns/:id/providers/:pid/managers", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/managers`));
app.post("/api/towns/:id/providers/:pid/managers", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/managers`));
app.delete("/api/towns/:id/providers/:pid/managers/:mid", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/managers/${c.req.param("mid")}`));
app.get("/api/towns/:id/providers/:pid/captains", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/captains`));
app.post("/api/towns/:id/providers/:pid/captains", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/captains`));
app.delete("/api/towns/:id/providers/:pid/captains/:cid", requireRole("super_admin"), (c) => proxyTown(c, `/api/control/providers/${P(c)}/captains/${c.req.param("cid")}`));

// ── Deploy targets (Cloudflare accounts + tokens) ─────────────────────────────
app.get("/api/targets", requireRole("super_admin"), async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, label, cf_account_id, zone_id, created_at FROM deploy_targets ORDER BY created_at DESC").all();
  return c.json({ targets: results || [] }); // never returns the token
});
app.post("/api/targets", requireRole("super_admin"), async (c) => {
  const { label, cf_account_id, cf_api_token, zone_id } = await c.req.json().catch(() => ({}));
  if (!label || !cf_account_id || !cf_api_token) return c.json({ error: "missing", need: "label, cf_account_id, cf_api_token" }, 400);
  const id = randomId();
  await c.env.DB.prepare("INSERT INTO deploy_targets (id, label, cf_account_id, cf_api_token, zone_id, created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, label, cf_account_id, cf_api_token, zone_id || null, now()).run();
  return c.json({ ok: true, id });
});
app.delete("/api/targets/:id", requireRole("super_admin"), async (c) => {
  await c.env.DB.prepare("DELETE FROM deploy_targets WHERE id = ?").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});
// Check a target's token can do what a deploy needs (before deploying).
app.get("/api/targets/:id/test", requireRole("super_admin"), async (c) => {
  const t = await c.env.DB.prepare("SELECT * FROM deploy_targets WHERE id = ?").bind(c.req.param("id")).first();
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json(await testTarget(t));
});

// Deploy a new town Worker to a target CF account. dryRun (default) returns the
// plan of Cloudflare API calls without executing; dryRun:false performs the deploy.
app.post("/api/deploy", requireRole("super_admin"), async (c) => {
  const { targetId, spec, dryRun } = await c.req.json().catch(() => ({}));
  const target = await c.env.DB.prepare("SELECT * FROM deploy_targets WHERE id = ?").bind(targetId).first();
  if (!target) return c.json({ error: "target_not_found" }, 404);
  if (!spec?.slug || !spec?.name || !spec?.domain) return c.json({ error: "missing", need: "spec.slug, spec.name, spec.domain" }, 400);
  // Worker/D1 names must be lowercase [a-z0-9-]; slugify defensively.
  spec.slug = String(spec.slug).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.slug)) return c.json({ error: "invalid_slug", detail: "use lowercase letters, digits, hyphens" }, 400);
  try {
    const result = await deployTown(c.env, c.env.DB, target, spec, { dryRun: dryRun !== false });
    return c.json(result);
  } catch (e) {
    return c.json({ error: "deploy_failed", detail: String(e.message || e) }, 500);
  }
});

app.get("/api/health", (c) => c.json({ ok: true, service: "sd-admin-svc" }));

export default { fetch: (req, env, ctx) => app.fetch(req, env, ctx) };
