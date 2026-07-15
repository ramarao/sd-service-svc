// Thin D1 query helpers + the order state machine. The lifecycle rules live in
// flow.js and are driven by the app's `flow` config (see config.js); this module
// stays vertical-agnostic by passing `flow` through to those helpers.
import { randomId } from "./crypto.js";
import { notifyCustomer } from "./wa.js";
import { canTransition, notifyStatuses, assignmentAt, advanceStep } from "./flow.js";
import { flowForProvider } from "./flows/index.js";

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
    phoneNumberId: provider?.wa_phone_number_id || s?.wa_phone_number_id || env.WA_PHONE_NUMBER_ID || null,
    appSecret: s?.wa_app_secret || env.WA_APP_SECRET || null,
    verifyToken: s?.wa_verify_token || env.WA_VERIFY_TOKEN || null,
    apiVersion: s?.wa_api_version || "v21.0",
  };
}

// ── Providers ────────────────────────────────────────────────────────────────
// Providers join to their vertical so callers get `vertical_flow` (the flow key
// that drives the order lifecycle). Falls back to a plain select on legacy D1s
// that predate the `verticals` table.
async function providerWithFlow(db, where, val) {
  try {
    return await db
      .prepare(`SELECT sp.*, v.flow AS vertical_flow FROM service_providers sp LEFT JOIN verticals v ON v.slug = sp.vertical WHERE ${where}`)
      .bind(val)
      .first();
  } catch {
    return db.prepare(`SELECT sp.* FROM service_providers sp WHERE ${where}`).bind(val).first();
  }
}
export async function getProvider(db, id) {
  return providerWithFlow(db, "sp.id = ?", id);
}
export async function getProviderBySlug(db, slug) {
  return providerWithFlow(db, "sp.slug = ?", slug);
}
export async function getProviderByPhoneNumberId(db, pnid) {
  return providerWithFlow(db, "sp.wa_phone_number_id = ?", pnid);
}

// ── Verticals (town-enabled service categories; slug == flow registry key) ────
export async function listVerticals(db) {
  try {
    const { results } = await db
      .prepare("SELECT slug, name, flow, emoji, sort FROM verticals WHERE active = 1 ORDER BY sort, name")
      .all();
    return results || [];
  } catch {
    return []; // table absent (single-vertical legacy D1)
  }
}
export async function listProvidersByVertical(db, slug) {
  try {
    const { results } = await db
      .prepare("SELECT id, slug, name FROM service_providers WHERE vertical = ? ORDER BY name")
      .bind(slug)
      .all();
    return results || [];
  } catch {
    return []; // vertical column absent (legacy D1)
  }
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

// Orders assigned to a field agent (either slot) within one provider. Returns
// each with its items, total, the slot(s) the agent owns, and the advance action
// the agent can take now ({ to, label, section } | null) — all flow-driven.
export async function listCaptainJobs(db, flow, phone, providerId) {
  // COALESCE lets pre-snapshot orders fall back to the linked customer record.
  // A captain sees an order if they hold either slot OR are one of its assignees
  // (on-site jobs can have several). `is_assignee` drives the advance permission.
  const sql = (withAssignees) =>
    "SELECT o.*, COALESCE(o.customer_name, cu.name) AS cust_name, COALESCE(o.customer_phone, cu.wa_phone) AS cust_phone, " +
    (withAssignees ? "EXISTS(SELECT 1 FROM order_assignees a WHERE a.order_id = o.id AND a.phone = ?) AS is_assignee " : "0 AS is_assignee ") +
    "FROM orders o LEFT JOIN customers cu ON cu.id = o.customer_id " +
    "WHERE o.provider_id = ? AND (o.captain_phone = ? OR o.delivery_captain_phone = ?" +
    (withAssignees ? " OR EXISTS(SELECT 1 FROM order_assignees a WHERE a.order_id = o.id AND a.phone = ?)" : "") +
    ") ORDER BY o.updated_at DESC LIMIT 100";
  let orders;
  try {
    ({ results: orders } = await db.prepare(sql(true)).bind(phone, providerId, phone, phone, phone).all());
  } catch {
    // legacy D1 without order_assignees → slot-only matching
    ({ results: orders } = await db.prepare(sql(false)).bind(providerId, phone, phone).all());
  }
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
    const isAssignee = o.is_assignee === 1;
    const roles = [];
    if (o.captain_phone === phone || isAssignee) roles.push("primary");
    if (o.delivery_captain_phone === phone) roles.push("delivery");
    // The advance action, if this agent owns the slot that advances this status.
    // For the primary (on-site) slot, any assignee can advance.
    const step = advanceStep(flow, o.status);
    let action = null;
    if (step) {
      const owns = step.slot === "delivery" ? o.delivery_captain_phone === phone : (o.captain_phone === phone || isAssignee);
      if (owns) action = { to: step.to, label: step.label, section: step.section };
    }
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
export async function createOrder(db, { providerId, customerId, address, lat, lng, addressId, customerName, customerPhone, contactName, contactPhone, items, note, images }) {
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
    .prepare("SELECT name, price, available FROM catalog_items WHERE provider_id = ? AND active = 1")
    .bind(providerId)
    .all();
  const priceOf = new Map((catalog || []).map((c) => [String(c.name).toLowerCase(), c.price || 0]));
  // Catalog items marked out-of-stock can't be ordered even if a client bypasses
  // the greyed-out UI. Non-catalog items (photo/list extras) aren't gated.
  const unavailable = new Set((catalog || []).filter((c) => c.available === 0).map((c) => String(c.name).toLowerCase()));

  const stmts = [];
  for (const it of items || []) {
    if (!it?.name) continue;
    if (unavailable.has(String(it.name).toLowerCase())) continue; // drop out-of-stock catalog items
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    const unit = priceOf.get(String(it.name).toLowerCase()) ?? 0;
    stmts.push(
      db
        .prepare("INSERT INTO order_items (id, order_id, name, qty, unit_price) VALUES (?,?,?,?,?)")
        .bind(randomId(), id, it.name, qty, unit)
    );
  }
  // Persist any uploaded photos/lists (already downscaled client-side).
  for (const data of images || []) {
    if (typeof data !== "string" || !data.startsWith("data:image/")) continue;
    stmts.push(
      db
        .prepare("INSERT INTO order_images (id, order_id, data, created_at) VALUES (?,?,?,?)")
        .bind(randomId(), id, data, ts)
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
  let images = [];
  try {
    const r = await db.prepare("SELECT id, data FROM order_images WHERE order_id = ? ORDER BY created_at ASC").bind(id).all();
    images = r.results || [];
  } catch { /* table absent on legacy D1 */ }
  const assignees = await orderAssignees(db, id);
  const total = (items || []).reduce((s, it) => s + it.qty * (it.unit_price || 0), 0);
  return { ...order, items, events, images, assignees, total };
}

// Captains assigned to an order (on-site jobs may have several). Tolerates the
// table being absent on a legacy D1.
export async function orderAssignees(db, orderId) {
  try {
    const { results } = await db.prepare("SELECT id, name, phone FROM order_assignees WHERE order_id = ? ORDER BY created_at ASC").bind(orderId).all();
    return results || [];
  } catch {
    return [];
  }
}

// Advance/transition status, write an event, and notify the customer. The flow
// is resolved from the order's provider → its vertical. Returns { order } or throws.
export async function transitionOrder(env, db, { orderId, toStatus, actor, agentName, captainPhone, shipMode, courierName, courierTracking, assignees }) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) throw new Error("not_found");
  const provider = await getProvider(db, order.provider_id);
  const flow = flowForProvider(provider);

  if (!canTransition(flow, order.status, toStatus)) throw new Error("invalid_transition");

  const ts = now();
  // Courier dispatch: instead of assigning a field agent, record the courier +
  // tracking. Only meaningful at an assignment step; otherwise ignored.
  const asg = assignmentAt(flow, toStatus);
  const courier = asg && shipMode === "courier";
  // On-site jobs can assign several captains at the primary step. The list goes to
  // order_assignees; the first also fills the legacy primary slot (display/notify).
  const multi = !courier && asg?.slot === "primary" && Array.isArray(assignees)
    ? assignees.map((a) => ({ name: (a?.name || "").trim() || null, phone: String(a?.phone || "").trim() })).filter((a) => a.phone)
    : null;
  const first = multi && multi.length ? multi[0] : null;
  // Route the field-agent selection into the slot this status assigns (if any).
  // primary → agent_name/captain_phone, delivery → delivery_captain_*. A status
  // that isn't an assignment point carries no agent and leaves both slots as-is.
  const primaryName = !courier && asg?.slot === "primary" ? (multi ? (first?.name || null) : (agentName || null)) : null;
  const primaryPhone = !courier && asg?.slot === "primary" ? (multi ? (first?.phone || null) : (captainPhone || null)) : null;
  const delivName = !courier && asg?.slot === "delivery" ? agentName || null : null;
  const delivPhone = !courier && asg?.slot === "delivery" ? captainPhone || null : null;
  const shipModeVal = asg ? (courier ? "courier" : "delivery") : null; // set at dispatch only
  await db
    .prepare(
      "UPDATE orders SET status = ?, " +
        "agent_name = COALESCE(?, agent_name), captain_phone = COALESCE(?, captain_phone), " +
        "delivery_captain_name = COALESCE(?, delivery_captain_name), delivery_captain_phone = COALESCE(?, delivery_captain_phone), " +
        "ship_mode = COALESCE(?, ship_mode), courier_name = COALESCE(?, courier_name), courier_tracking = COALESCE(?, courier_tracking), " +
        "updated_at = ? WHERE id = ?"
    )
    .bind(toStatus, primaryName, primaryPhone, delivName, delivPhone, shipModeVal, courier ? (courierName || null) : null, courier ? (courierTracking || null) : null, ts, orderId)
    .run();
  // Replace the assignee list when a multi-captain assignment was made.
  if (multi) {
    const stmts = [db.prepare("DELETE FROM order_assignees WHERE order_id = ?").bind(orderId)];
    for (const a of multi) stmts.push(db.prepare("INSERT INTO order_assignees (id, order_id, name, phone, created_at) VALUES (?,?,?,?,?)").bind(randomId(), orderId, a.name, a.phone, ts));
    await db.batch(stmts);
  }
  await db
    .prepare("INSERT INTO order_events (id, order_id, status, actor, at) VALUES (?,?,?,?,?)")
    .bind(randomId(), orderId, toStatus, actor || "admin", ts)
    .run();

  const full = await getOrder(db, orderId); // includes items + total
  if (notifyStatuses(flow).has(toStatus)) {
    const customer = await getCustomer(db, order.customer_id);
    if (provider && customer) {
      const waCfg = await getWaConfig(env, db, provider);
      // Fire-and-log; a WhatsApp failure must not roll back the status change.
      await notifyCustomer(waCfg, { flow, provider, customer, status: toStatus, order: full }).catch((e) =>
        console.error("[notify] failed", e)
      );
    }
  }
  return full;
}
