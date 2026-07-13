// Cross-account town deploy — the control plane provisions a whole town Worker
// (D1 + schema + Durable Object + static assets + secrets + custom domain) onto a
// chosen Cloudflare account via that account's API token, then registers the town.
//
// The town's bundled worker + assets are pre-built by `npm run build:town-bundle`
// into apps/admin/public/town-dist/ and read here through the ASSETS binding, since
// a Worker can't bundle code at runtime.
//
// deployTown(..., { dryRun:true }) returns the exact ordered plan of Cloudflare API
// calls WITHOUT executing — the safe, inspectable path. dryRun:false performs the
// real deploy (creates billable resources; run with your own token).
import { randomId } from "../../../core/crypto.js";

const CF = "https://api.cloudflare.com/client/v4";

async function cf(target, path, { method = "GET", json, form, token } = {}) {
  const res = await fetch(CF + path, {
    method,
    headers: {
      Authorization: `Bearer ${token || target.cf_api_token}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    },
    body: json ? JSON.stringify(json) : form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(`CF ${method} ${path} → ${res.status}: ${JSON.stringify(data.errors || data.messages || data)}`);
  }
  return data.result;
}

// Verify a deploy target's CF token can do what a town deploy needs, before deploying.
export async function testTarget(target) {
  const checks = [];
  const probe = async (name, path) => {
    try { await cf(target, path); checks.push({ name, ok: true }); }
    catch (e) { checks.push({ name, ok: false, detail: String(e.message || e).replace(/^CF GET \S+ → /, "").slice(0, 100) }); }
  };
  await probe("token valid", "/user/tokens/verify");
  await probe("D1 access", `/accounts/${target.cf_account_id}/d1/database?per_page=1`);
  await probe("Workers access", `/accounts/${target.cf_account_id}/workers/scripts?per_page=1`);
  return { ok: checks.every((c) => c.ok), checks };
}

// Read a file the build step placed under public/town-dist/ (served by ASSETS).
async function readAsset(env, rel) {
  const res = await env.ASSETS.fetch(new Request(`https://town-dist/town-dist/${rel}`));
  if (!res.ok) throw new Error(`missing build artifact town-dist/${rel} — run 'npm run build:town-bundle'`);
  return res;
}

// SHA-256 hex (first 32 chars) — Cloudflare's asset content hash.
async function assetHash(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
function b64(bytes) {
  let s = "";
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s);
}

// Upload the town's static SPA via the Workers Assets upload session; returns the
// completion JWT to embed in the script metadata.
async function uploadAssets(env, target, workerName) {
  const manifest = await (await readAsset(env, "assets-manifest.json")).json(); // { "/index.html": {hash,size}, ... }
  const session = await cf(target, `/accounts/${target.cf_account_id}/workers/scripts/${workerName}/assets-upload-session`, {
    method: "POST",
    json: { manifest },
  });
  let jwt = session.jwt;
  const buckets = session.buckets || [];
  // hash → path lookup to fetch the bytes for each requested upload
  const byHash = Object.fromEntries(Object.entries(manifest).map(([p, m]) => [m.hash, p]));
  for (const bucket of buckets) {
    const form = new FormData();
    for (const hash of bucket) {
      const path = byHash[hash];
      const bytes = await (await readAsset(env, "assets" + path)).arrayBuffer();
      form.append(hash, new Blob([b64(bytes)], { type: manifest[path].contentType || "application/octet-stream" }), hash);
    }
    const r = await cf(target, `/accounts/${target.cf_account_id}/workers/assets/upload?base64=true`, { method: "POST", form, token: jwt });
    if (r?.jwt) jwt = r.jwt; // final bucket returns the completion token
  }
  return jwt;
}

// Orchestrate the full deploy. spec: { name, slug, domain, wa_number, secrets:{...} }.
export async function deployTown(env, db, target, spec, { dryRun = true } = {}) {
  const acct = target.cf_account_id;
  const workerName = `sd-${spec.slug}-svc`;
  const dbName = `sd-${spec.slug}-db`;
  const controlToken = spec.secrets?.CONTROL_TOKEN || randomId() + randomId();
  const sessionSecret = spec.secrets?.SESSION_SECRET || randomId() + randomId();
  const secrets = {
    SESSION_SECRET: sessionSecret,
    CONTROL_TOKEN: controlToken,
    PUBLIC_HOST: spec.domain,
    ...(spec.secrets || {}),
  };
  const plan = [];
  const step = (title, method, path, note) => plan.push({ title, method, path, ...(note ? { note } : {}) });

  step("Create D1 database", "POST", `/accounts/${acct}/d1/database`, dbName);
  step("Initialise schema", "POST", `/accounts/${acct}/d1/database/<db_id>/query`, "town-dist/schema.sql");
  step("Upload static assets", "POST", `/accounts/${acct}/workers/scripts/${workerName}/assets-upload-session`, "town SPA");
  step("Upload Worker script", "PUT", `/accounts/${acct}/workers/scripts/${workerName}`, "bundle + D1/DO/Assets bindings + OrdersHub migration");
  step("Set secrets", "PUT", `/accounts/${acct}/workers/scripts/${workerName}/secrets`, Object.keys(secrets).join(", "));
  step("Attach custom domain", "POST", `/accounts/${acct}/workers/domains`, spec.domain);
  step("Register town in control plane", "local", "towns", `${spec.name} → https://${spec.domain}`);

  if (dryRun) {
    return { dryRun: true, worker: workerName, db: dbName, domain: spec.domain, controlToken, plan };
  }

  // ── Live execution (creates real resources) ────────────────────────────────
  // D1: create, or reuse an existing DB of the same name (idempotent re-runs).
  let dbId;
  try {
    const d1 = await cf(target, `/accounts/${acct}/d1/database`, { method: "POST", json: { name: dbName } });
    dbId = d1.uuid;
  } catch (e) {
    const list = await cf(target, `/accounts/${acct}/d1/database?per_page=100`);
    const existing = (list || []).find((d) => d.name === dbName);
    if (!existing) throw e;
    dbId = existing.uuid;
  }

  const schema = await (await readAsset(env, "schema.sql")).text();
  await cf(target, `/accounts/${acct}/d1/database/${dbId}/query`, { method: "POST", json: { sql: schema } });

  const assetsJwt = await uploadAssets(env, target, workerName);

  const bundle = await (await readAsset(env, "worker.js")).text();
  const metadata = {
    main_module: "worker.js",
    compatibility_date: "2026-07-09",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "d1", name: "DB", id: dbId },
      { type: "durable_object_namespace", name: "ORDERS_HUB", class_name: "OrdersHub" },
      { type: "assets", name: "ASSETS" },
    ],
    migrations: { new_tag: "v1", new_sqlite_classes: ["OrdersHub"] },
    assets: { jwt: assetsJwt, config: { not_found_handling: "single-page-application", run_worker_first: ["/api/*", "/auth/*", "/webhook/*"] } },
    observability: { enabled: true },
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("worker.js", new Blob([bundle], { type: "application/javascript+module" }), "worker.js");
  await cf(target, `/accounts/${acct}/workers/scripts/${workerName}`, { method: "PUT", form });

  // Secrets (one PUT each).
  for (const [name, text] of Object.entries(secrets)) {
    if (text == null || text === "") continue;
    await cf(target, `/accounts/${acct}/workers/scripts/${workerName}/secrets`, { method: "PUT", json: { name, text, type: "secret_text" } });
  }

  // Enable the workers.dev URL so the town is reachable + controllable immediately,
  // regardless of the custom domain. This becomes the registered URL fallback.
  let workersDevUrl = null;
  try {
    await cf(target, `/accounts/${acct}/workers/scripts/${workerName}/subdomain`, { method: "POST", json: { enabled: true } });
    const sub = await cf(target, `/accounts/${acct}/workers/subdomain`);
    if (sub?.subdomain) workersDevUrl = `https://${workerName}.${sub.subdomain}.workers.dev`;
  } catch { /* non-fatal */ }

  // Custom domain — attach via PUT (needs the zone in this account). Non-fatal.
  let domainWarning = null, domainAttached = false;
  if (spec.domain && target.zone_id) {
    try {
      await cf(target, `/accounts/${acct}/workers/domains`, {
        method: "PUT",
        json: { hostname: spec.domain, service: workerName, environment: "production", zone_id: target.zone_id },
      });
      domainAttached = true;
    } catch (e) {
      domainWarning = `Worker is live${workersDevUrl ? " at " + workersDevUrl : ""}, but the custom domain wasn't attached: ${String(e.message || e)}`;
    }
  } else if (spec.domain) {
    domainWarning = `Worker is live${workersDevUrl ? " at " + workersDevUrl : ""}, but no valid Zone ID on the account — custom domain not attached (add the 32-hex zone id and redeploy).`;
  }

  // The control plane manages the town over a URL that actually resolves now.
  const townUrl = domainAttached ? `https://${spec.domain}` : workersDevUrl || `https://${spec.domain}`;

  // Register the new town so the control plane can manage it (upsert on slug).
  const townId = randomId();
  await db
    .prepare(
      "INSERT INTO towns (id, slug, name, url, control_token, wa_number, domain, cf_account, status, created_at) VALUES (?,?,?,?,?,?,?,?, 'active', ?) " +
        "ON CONFLICT(slug) DO UPDATE SET name=excluded.name, url=excluded.url, control_token=excluded.control_token, wa_number=excluded.wa_number, domain=excluded.domain, cf_account=excluded.cf_account, status='active'"
    )
    .bind(townId, spec.slug, spec.name, townUrl, controlToken, spec.wa_number || null, spec.domain, target.label, Date.now())
    .run();

  return { ok: true, townId, worker: workerName, db: dbName, url: townUrl, domain: spec.domain, workersDevUrl, controlToken, ...(domainWarning ? { warning: domainWarning } : {}) };
}
