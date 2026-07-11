// Thin D1 query helpers + the order state machine.
import { randomId } from "./crypto.js";
import { notifyCustomer } from "./wa.js";

// Linear (rankable) statuses, in order. REJECTED is a separate terminal branch.
export const STATUS_FLOW = [
  "REQUESTED",
  "ACCEPTED",
  "ASSIGNED",
  "PICKED_UP",
  "IN_SERVICE",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

const RANK = Object.fromEntries(STATUS_FLOW.map((s, i) => [s, i]));
const TERMINAL = new Set(["REJECTED", "DELIVERED"]);

// Is a status change allowed? Enforces: accept/reject only from REQUESTED,
// terminal statuses are final, and otherwise advance exactly one step forward
// (no skipping, no going back).
export function canTransition(from, to) {
  if (from === to) return false;
  if (TERMINAL.has(from)) return false; // rejected or delivered → no further action
  if (to === "ACCEPTED" || to === "REJECTED") return from === "REQUESTED";
  if (!(from in RANK) || !(to in RANK)) return false;
  // Must be past REQUESTED (i.e. accepted) and move to the immediate next step.
  return RANK[from] >= RANK.ACCEPTED && RANK[to] === RANK[from] + 1;
}

// Valid next statuses from a given status (drives the admin UI controls).
export function allowedTransitions(from) {
  if (TERMINAL.has(from)) return [];
  if (from === "REQUESTED") return ["ACCEPTED", "REJECTED"];
  return STATUS_FLOW.filter((s) => canTransition(from, s));
}

// Statuses that trigger a customer WhatsApp notification.
const NOTIFY_STATUSES = new Set([
  "ACCEPTED",
  "REJECTED",
  "PICKED_UP",
  "IN_SERVICE",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
]);

export function now() {
  return Date.now();
}

// Human order id: 001-DDMMYY, 002-DDMMYY … sequential per calendar day (IST).
const IST_OFFSET_MIN = 330;
export function dayKey(ts) {
  const d = new Date(ts + IST_OFFSET_MIN * 60000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  return `${dd}${mm}${yy}`;
}

async function nextOrderId(db, ts) {
  const day = dayKey(ts);
  // Atomic per-day counter via upsert + RETURNING.
  const row = await db
    .prepare(
      "INSERT INTO order_counters (day, seq) VALUES (?, 1) " +
        "ON CONFLICT(day) DO UPDATE SET seq = seq + 1 RETURNING seq"
    )
    .bind(day)
    .first();
  const seq = row?.seq || 1;
  return `${String(seq).padStart(3, "0")}-${day}`;
}

// ── Platform settings & WhatsApp config resolution ───────────────────────────
export async function getSettings(db) {
  return db.prepare("SELECT * FROM platform_settings WHERE id = 'global'").first();
}

// Merge DB settings + provider row + env into one resolved WhatsApp config.
// Precedence: provider override → platform settings → env secret (legacy).
export async function getWaConfig(env, db, provider) {
  const s = await getSettings(db);
  return {
    token: provider?.wa_token || s?.wa_token || env.WA_TOKEN || null,
    phoneNumberId: provider?.wa_phone_number_id || env.WA_PHONE_NUMBER_ID || null,
    appSecret: s?.wa_app_secret || env.WA_APP_SECRET || null,
    verifyToken: s?.wa_verify_token || env.WA_VERIFY_TOKEN || null,
    apiVersion: s?.wa_api_version || "v21.0",
  };
}

// ── Providers ────────────────────────────────────────────────────────────────
export async function getProvider(db, id) {
  return db.prepare("SELECT * FROM service_providers WHERE id = ?").bind(id).first();
}
export async function getProviderBySlug(db, slug) {
  return db.prepare("SELECT * FROM service_providers WHERE slug = ?").bind(slug).first();
}
export async function getProviderByPhoneNumberId(db, pnid) {
  return db
    .prepare("SELECT * FROM service_providers WHERE wa_phone_number_id = ?")
    .bind(pnid)
    .first();
}

// ── Customers ────────────────────────────────────────────────────────────────
export async function getCustomer(db, id) {
  return db.prepare("SELECT * FROM customers WHERE id = ?").bind(id).first();
}
export async function getCustomerByPhone(db, waPhone) {
  return db.prepare("SELECT * FROM customers WHERE wa_phone = ?").bind(waPhone).first();
}
export async function upsertCustomerByPhone(db, waPhone, patch = {}) {
  let cust = await getCustomerByPhone(db, waPhone);
  if (!cust) {
    const id = randomId();
    await db
      .prepare("INSERT INTO customers (id, wa_phone, name, address, created_at) VALUES (?,?,?,?,?)")
      .bind(id, waPhone, patch.name || null, patch.address || null, now())
      .run();
    cust = await getCustomer(db, id);
  }
  return cust;
}

// Stamp the 24h window when a customer messages us.
export async function touchInboundWindow(db, waPhone) {
  const cust = await upsertCustomerByPhone(db, waPhone);
  await db
    .prepare("UPDATE customers SET last_inbound_at = ? WHERE id = ?")
    .bind(now(), cust.id)
    .run();
  return cust;
}

// ── Customer address book ────────────────────────────────────────────────────
export async function listAddresses(db, customerId) {
  const { results } = await db
    .prepare("SELECT * FROM customer_addresses WHERE customer_id = ? ORDER BY is_default DESC, created_at DESC")
    .bind(customerId)
    .all();
  return results;
}
export async function getAddress(db, id, customerId) {
  return db
    .prepare("SELECT * FROM customer_addresses WHERE id = ? AND customer_id = ?")
    .bind(id, customerId)
    .first();
}
export async function createAddress(db, { customerId, label, contactName, contactPhone, line1, area, lat, lng, makeDefault }) {
  const id = randomId();
  const latN = Number.isFinite(+lat) ? +lat : null;
  const lngN = Number.isFinite(+lng) ? +lng : null;
  const def = makeDefault ? 1 : 0;
  if (def) await db.prepare("UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?").bind(customerId).run();
  await db
    .prepare("INSERT INTO customer_addresses (id, customer_id, label, contact_name, contact_phone, line1, area, lat, lng, is_default, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, customerId, label || null, contactName || null, contactPhone || null, line1 || null, area || null, latN, lngN, def, now())
    .run();
  return getAddress(db, id, customerId);
}
// Make one address the default (clears the flag on the customer's others).
export async function setDefaultAddress(db, id, customerId) {
  await db.batch([
    db.prepare("UPDATE customer_addresses SET is_default = 0 WHERE customer_id = ?").bind(customerId),
    db.prepare("UPDATE customer_addresses SET is_default = 1 WHERE id = ? AND customer_id = ?").bind(id, customerId),
  ]);
}
export function fullAddress(a) {
  return [a?.line1, a?.area].filter(Boolean).join(", ");
}

// ── Captains (per provider) ──────────────────────────────────────────────────
export async function listCaptains(db, providerId) {
  const { results } = await db
    .prepare("SELECT id, name, phone FROM captains WHERE provider_id = ? AND active = 1 ORDER BY name")
    .bind(providerId)
    .all();
  return results;
}
export async function createCaptain(db, { providerId, name, phone }) {
  const id = randomId();
  await db
    .prepare("INSERT INTO captains (id, provider_id, name, phone, active, created_at) VALUES (?,?,?,?,1,?)")
    .bind(id, providerId, name || null, phone || null, now())
    .run();
  return id;
}
export async function deleteCaptain(db, id, providerId) {
  await db.prepare("DELETE FROM captains WHERE id = ? AND provider_id = ?").bind(id, providerId).run();
}

// ── Captain accounts (phone-keyed login identity, spans providers) ────────────
// The providers a captain (identified by phone) works for — distinct, ordered.
export async function getCaptainProviders(db, phone) {
  const { results } = await db
    .prepare(
      "SELECT sp.id, sp.slug, sp.name FROM captains c " +
        "JOIN service_providers sp ON sp.id = c.provider_id " +
        "WHERE c.phone = ? AND c.active = 1 GROUP BY sp.id ORDER BY sp.name"
    )
    .bind(phone)
    .all();
  return results;
}
// A display name for this captain, taken from any of their captain rows.
export async function captainName(db, phone) {
  const row = await db
    .prepare("SELECT name FROM captains WHERE phone = ? AND name IS NOT NULL AND name != '' LIMIT 1")
    .bind(phone)
    .first();
  return row?.name || null;
}

// ── Managers (per provider, tier admin|manager) ──────────────────────────────
export async function listManagers(db, providerId) {
  const { results } = await db
    .prepare("SELECT id, name, phone, tier FROM managers WHERE provider_id = ? AND active = 1 ORDER BY tier, name")
    .bind(providerId)
    .all();
  return results;
}
export async function createManager(db, { providerId, name, phone, tier }) {
  const id = randomId();
  await db
    .prepare("INSERT INTO managers (id, provider_id, name, phone, tier, active, created_at) VALUES (?,?,?,?,?,1,?)")
    .bind(id, providerId, name || null, phone || null, tier === "admin" ? "admin" : "manager", now())
    .run();
  return id;
}
export async function deleteManager(db, id, providerId) {
  await db.prepare("DELETE FROM managers WHERE id = ? AND provider_id = ?").bind(id, providerId).run();
}
// The providers a manager (by phone) runs, each with their tier there.
export async function getManagerProviders(db, phone) {
  const { results } = await db
    .prepare(
      "SELECT sp.id, sp.slug, sp.name, m.tier FROM managers m " +
        "JOIN service_providers sp ON sp.id = m.provider_id " +
        "WHERE m.phone = ? AND m.active = 1 GROUP BY sp.id ORDER BY sp.name"
    )
    .bind(phone)
    .all();
  return results;
}
export async function getManagerFor(db, phone, providerId) {
  const row = await db
    .prepare("SELECT tier FROM managers WHERE phone = ? AND provider_id = ? AND active = 1 LIMIT 1")
    .bind(phone, providerId)
    .first();
  return row?.tier || null;
}
export async function managerName(db, phone) {
  const row = await db
    .prepare("SELECT name FROM managers WHERE phone = ? AND name IS NOT NULL AND name != '' LIMIT 1")
    .bind(phone)
    .first();
  return row?.name || null;
}

// Orders assigned to a captain (as pickup or delivery) within one provider.
// Returns each with its items, total, the captain's role(s), and the action the
// captain can take now (pickup | deliver | null).
export async function listCaptainJobs(db, phone, providerId) {
  // COALESCE lets pre-snapshot orders fall back to the linked customer record.
  const { results: orders } = await db
    .prepare(
      "SELECT o.*, COALESCE(o.customer_name, cu.name) AS cust_name, COALESCE(o.customer_phone, cu.wa_phone) AS cust_phone " +
        "FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id " +
        "WHERE o.provider_id = ? AND (o.captain_phone = ? OR o.delivery_captain_phone = ?) " +
        "ORDER BY o.updated_at DESC LIMIT 100"
    )
    .bind(providerId, phone, phone)
    .all();
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const ph = ids.map(() => "?").join(",");
  const { results: items } = await db
    .prepare(`SELECT order_id, name, qty, unit_price FROM order_items WHERE order_id IN (${ph})`)
    .bind(...ids)
    .all();
  const byOrder = new Map();
  for (const it of items || []) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
    byOrder.get(it.order_id).push(it);
  }
  return orders.map((o) => {
    const its = byOrder.get(o.id) || [];
    const total = its.reduce((s, it) => s + it.qty * (it.unit_price || 0), 0);
    const roles = [];
    if (o.captain_phone === phone) roles.push("pickup");
    if (o.delivery_captain_phone === phone) roles.push("delivery");
    const action =
      o.status === "ASSIGNED" && roles.includes("pickup")
        ? "pickup"
        : o.status === "OUT_FOR_DELIVERY" && roles.includes("delivery")
        ? "deliver"
        : null;
    return {
      id: o.id,
      status: o.status,
      address: o.address,
      lat: o.lat,
      lng: o.lng,
      customer_name: o.cust_name,
      customer_phone: o.cust_phone,
      contact_name: o.contact_name,
      contact_phone: o.contact_phone,
      note: o.note,
      created_at: o.created_at,
      updated_at: o.updated_at,
      payment_status: o.payment_status,
      payment_amount: o.payment_amount,
      payment_payer: o.payment_payer,
      items: its,
      total,
      roles,
      action,
    };
  });
}

// ── Orders ───────────────────────────────────────────────────────────────────
export async function createOrder(db, { providerId, customerId, address, lat, lng, addressId, customerName, customerPhone, contactName, contactPhone, items, note }) {
  const ts = now();
  const id = await nextOrderId(db, ts);
  const latN = Number.isFinite(+lat) ? +lat : null;
  const lngN = Number.isFinite(+lng) ? +lng : null;
  await db
    .prepare(
      "INSERT INTO orders (id, provider_id, customer_id, status, address, lat, lng, address_id, customer_name, customer_phone, contact_name, contact_phone, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(id, providerId, customerId, "REQUESTED", address || null, latN, lngN, addressId || null, customerName || null, customerPhone || null, contactName || null, contactPhone || null, note || null, ts, ts)
    .run();

  // Resolve unit prices from the provider's catalog (authoritative — never trust
  // a client-sent price). Matched case-insensitively by item name.
  const { results: catalog } = await db
    .prepare("SELECT name, price FROM catalog_items WHERE provider_id = ?")
    .bind(providerId)
    .all();
  const priceOf = new Map((catalog || []).map((c) => [String(c.name).toLowerCase(), c.price || 0]));

  const stmts = [];
  for (const it of items || []) {
    if (!it?.name) continue;
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const unit = priceOf.get(String(it.name).toLowerCase()) ?? 0;
    stmts.push(
      db
        .prepare("INSERT INTO order_items (id, order_id, name, qty, unit_price) VALUES (?,?,?,?,?)")
        .bind(randomId(), id, it.name, qty, unit)
    );
  }
  stmts.push(
    db
      .prepare("INSERT INTO order_events (id, order_id, status, actor, at) VALUES (?,?,?,?,?)")
      .bind(randomId(), id, "REQUESTED", "customer", ts)
  );
  if (stmts.length) await db.batch(stmts);
  return getOrder(db, id);
}

// Replace an order's items wholesale (used by the pickup captain to reconcile
// to what was actually collected). Prices are re-resolved from the provider's
// catalog — never trust client-sent prices.
export async function replaceOrderItems(db, orderId, providerId, items) {
  const { results: catalog } = await db
    .prepare("SELECT name, price FROM catalog_items WHERE provider_id = ?")
    .bind(providerId)
    .all();
  const priceOf = new Map((catalog || []).map((c) => [String(c.name).toLowerCase(), c.price || 0]));
  const stmts = [db.prepare("DELETE FROM order_items WHERE order_id = ?").bind(orderId)];
  for (const it of items || []) {
    if (!it?.name) continue;
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const unit = priceOf.get(String(it.name).toLowerCase()) ?? 0;
    stmts.push(
      db
        .prepare("INSERT INTO order_items (id, order_id, name, qty, unit_price) VALUES (?,?,?,?,?)")
        .bind(randomId(), orderId, it.name, qty, unit)
    );
  }
  stmts.push(db.prepare("UPDATE orders SET updated_at = ? WHERE id = ?").bind(now(), orderId));
  await db.batch(stmts);
}

export async function getOrder(db, id) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!order) return null;
  const { results: items } = await db
    .prepare("SELECT id, name, qty, unit_price FROM order_items WHERE order_id = ?")
    .bind(id)
    .all();
  const { results: events } = await db
    .prepare("SELECT status, actor, at FROM order_events WHERE order_id = ? ORDER BY at ASC")
    .bind(id)
    .all();
  const total = (items || []).reduce((s, it) => s + it.qty * (it.unit_price || 0), 0);
  return { ...order, items, events, total };
}

// Advance/transition status, write an event, and notify the customer.
// Returns { order } or throws Error('invalid_transition').
export async function transitionOrder(env, db, { orderId, toStatus, actor, agentName, captainPhone }) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) throw new Error("not_found");

  if (!canTransition(order.status, toStatus)) throw new Error("invalid_transition");

  const ts = now();
  // Route the captain selection to the right slot: ASSIGNED sets the pickup
  // captain, OUT_FOR_DELIVERY sets the delivery captain. Other steps carry no
  // captain and leave both slots untouched.
  const pickName = toStatus === "ASSIGNED" ? agentName || null : null;
  const pickPhone = toStatus === "ASSIGNED" ? captainPhone || null : null;
  const delivName = toStatus === "OUT_FOR_DELIVERY" ? agentName || null : null;
  const delivPhone = toStatus === "OUT_FOR_DELIVERY" ? captainPhone || null : null;
  await db
    .prepare(
      "UPDATE orders SET status = ?, " +
        "agent_name = COALESCE(?, agent_name), captain_phone = COALESCE(?, captain_phone), " +
        "delivery_captain_name = COALESCE(?, delivery_captain_name), delivery_captain_phone = COALESCE(?, delivery_captain_phone), " +
        "updated_at = ? WHERE id = ?"
    )
    .bind(toStatus, pickName, pickPhone, delivName, delivPhone, ts, orderId)
    .run();
  await db
    .prepare("INSERT INTO order_events (id, order_id, status, actor, at) VALUES (?,?,?,?,?)")
    .bind(randomId(), orderId, toStatus, actor || "admin", ts)
    .run();

  const full = await getOrder(db, orderId); // includes items + total
  if (NOTIFY_STATUSES.has(toStatus)) {
    const provider = await getProvider(db, order.provider_id);
    const customer = await getCustomer(db, order.customer_id);
    if (provider && customer) {
      const waCfg = await getWaConfig(env, db, provider);
      // Fire-and-log; a WhatsApp failure must not roll back the status change.
      await notifyCustomer(waCfg, { provider, customer, status: toStatus, order: full }).catch((e) =>
        console.error("[notify] failed", e)
      );
    }
  }
  return full;
}
