#!/usr/bin/env node
// Idempotently ensure a Cloudflare Email Routing rule sends an address to this
// Worker. Email Routing must already be enabled on the zone (manasanta.in's MX
// already points at Cloudflare, so it is).
//
// Usage:
//   CLOUDFLARE_API_TOKEN=xxx node scripts/setup-email-routing.mjs \
//     [--zone manasanta.in] [--address upi-payments@manasanta.in] [--worker sd-service-svc]
//
// The token needs "Email Routing Rules: Edit" + "Zone: Read" on the zone.

const args = Object.fromEntries(
  process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith("--") ? [...a, [v.slice(2), arr[i + 1]]] : a), [])
);
const ZONE = args.zone || "manasanta.in";
const ADDRESS = args.address || "upi-payments@manasanta.in";
const WORKER = args.worker || "sd-service-svc";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!TOKEN) {
  console.error("Set CLOUDFLARE_API_TOKEN (needs Email Routing Rules: Edit + Zone: Read).");
  process.exit(1);
}

const API = "https://api.cloudflare.com/client/v4";
const cf = async (path, init = {}) => {
  const res = await fetch(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const data = await res.json();
  if (!data.success) throw new Error(`${path} → ${JSON.stringify(data.errors)}`);
  return data.result;
};

const zones = await cf(`/zones?name=${encodeURIComponent(ZONE)}`);
if (!zones.length) throw new Error(`Zone not found: ${ZONE}`);
const zoneId = zones[0].id;
console.log(`Zone ${ZONE} → ${zoneId}`);

// Email Routing status (informational).
try {
  const st = await cf(`/zones/${zoneId}/email/routing`);
  if (!st.enabled) console.warn("⚠️  Email Routing is not enabled on this zone — enable it in the dashboard first.");
} catch {}

const rules = await cf(`/zones/${zoneId}/email/routing/rules`);
const existing = rules.find((r) => r.matchers?.some((m) => m.field === "to" && m.value === ADDRESS));
const body = {
  name: `${ADDRESS} → ${WORKER}`,
  enabled: true,
  matchers: [{ type: "literal", field: "to", value: ADDRESS }],
  actions: [{ type: "worker", value: [WORKER] }],
};

if (existing) {
  await cf(`/zones/${zoneId}/email/routing/rules/${existing.tag}`, { method: "PUT", body: JSON.stringify(body) });
  console.log(`✓ Updated rule: ${ADDRESS} → Worker ${WORKER}`);
} else {
  await cf(`/zones/${zoneId}/email/routing/rules`, { method: "POST", body: JSON.stringify(body) });
  console.log(`✓ Created rule: ${ADDRESS} → Worker ${WORKER}`);
}
