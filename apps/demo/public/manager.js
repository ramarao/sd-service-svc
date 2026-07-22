// Manager/admin PWA. WhatsApp-only sign-in (text "admin" or "manager"). Pick a
// provider, then manage Orders / Items / Categories / Captains, plus Managers if
// you're the admin tier. Reuses the same API the super-admin console uses.
const el = document.getElementById("app");

const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
};
const h = (html) => { el.innerHTML = html; window.scrollTo(0, 0); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s.replace(/_/g, " "))}</span>`;
const fmtDate = (ms) => new Date(ms).toLocaleString();
const CUR = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };
const money = (paise) => "₹" + (Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
// Payment at a glance in the orders list. 'submitted' is the one that needs the
// shop to DO something, so it gets a pill of its own rather than reading as failed.
const paidPill = (o) =>
  o.payment_status === "paid" ? `<span class="paid-pill">✅ Paid</span>`
  : o.payment_status === "submitted" ? `<span class="paid-pill review">🕗 Check payment</span>`
  : o.payment_status === "rejected" ? `<span class="paid-pill fail">❌ Receipt rejected</span>`
  : o.payment_status === "failed" ? `<span class="paid-pill fail">❌ Failed</span>` : "";

function openModal(title, innerHTML) {
  closeModal();
  const ov = document.createElement("div");
  ov.className = "modal-overlay"; ov.id = "modal-overlay";
  ov.innerHTML = `<div class="modal"><div class="modal-head"><h2>${esc(title)}</h2><button class="modal-x" id="modal-x">×</button></div><div class="modal-body">${innerHTML}</div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(); });
  document.getElementById("modal-x").onclick = closeModal;
  return ov;
}
function closeModal() { const m = document.getElementById("modal-overlay"); if (m) m.remove(); }

let state = { phone: "", name: "", providers: [], providerId: null, providerName: "", tier: null, tab: "orders", flow: {}, brand: {} };

// Status buckets derived from the flow config (works for any vertical).
function statusBuckets() {
  const f = state.flow || {}, term = f.terminal || [], from = f.decision?.from, reject = f.decision?.reject;
  const active = (f.statuses || []).filter((s) => s !== from && !term.includes(s));
  return { from, active, terminal: term, reject };
}

// ── Live updates (WebSocket → orders hub) ───────────────────────────────────
let _ws = null, _wsProvider = null, _liveTimer = null;
function liveConnect(provider) {
  if (!provider) return;
  if (_ws && _wsProvider === provider && _ws.readyState <= 1) return;
  _wsProvider = provider;
  try { if (_ws) _ws.close(); } catch {}
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = (_ws = new WebSocket(`${proto}//${location.host}/api/ws?provider=${encodeURIComponent(provider)}`));
  ws.onmessage = (e) => { try { if (JSON.parse(e.data).type === "orders_changed") liveRefresh(); } catch {} };
  ws.onclose = () => { if (_ws === ws) { _ws = null; setTimeout(() => { if (_wsProvider) liveConnect(_wsProvider); }, 3000); } };
}
function liveDisconnect() { _wsProvider = null; try { if (_ws) _ws.close(); } catch {} _ws = null; }
function liveRefresh() {
  clearTimeout(_liveTimer);
  _liveTimer = setTimeout(() => { if (document.getElementById("mgrOrdersMarker")) tabOrders(); }, 400);
}

// ── Entry ───────────────────────────────────────────────────────────────────
async function boot() {
  try { const cfg = await api("/api/config"); state.flow = cfg.flow || {}; state.brand = cfg.brand || {}; } catch {}
  // A new-order alert lands here as /manager?order=…&provider=… — open that order
  // directly. Strip the params first so a reload doesn't re-open it.
  const q = new URLSearchParams(location.search);
  const deepOrder = q.get("order"), deepProvider = q.get("provider");
  if (deepOrder) history.replaceState(null, "", "/manager");
  let me;
  try { me = await api("/api/manager/me"); } catch { return screenAuth(); }
  state.phone = me.phone; state.name = me.name || ""; state.providers = me.providers || [];
  if (deepOrder && deepProvider) {
    const p = state.providers.find((x) => x.id === deepProvider);
    if (p) return selectProvider(p, deepOrder);
  }
  if (me.provider_id) {
    const p = state.providers.find((x) => x.id === me.provider_id);
    state.providerId = me.provider_id; state.providerName = p?.name || ""; state.tier = me.tier;
    dashboard();
  } else if (state.providers.length === 1) {
    selectProvider(state.providers[0]);
  } else {
    screenProviders();
  }
}

// openOrderId → jump straight to that order once the dashboard is up (new-order alert).
async function selectProvider(p, openOrderId) {
  h(`<div class="cap-hero"><div class="cap-logo">🗂️</div><p class="muted">Opening ${esc(p.name)}…</p></div>`);
  try {
    const r = await api("/api/manager/select", { method: "POST", body: { providerId: p.id } });
    state.providerId = p.id; state.providerName = r.provider.name; state.tier = r.tier; state.tab = "orders";
    await dashboard();
    if (openOrderId) orderDetail(openOrderId);
  } catch (e) { screenProviders(e.message); }
}

// ── Screen: not signed in → open WhatsApp and send "admin" ──────────────────
async function screenAuth() {
  let info = {};
  try { info = await api("/auth/manager/wa-login/info"); } catch {}
  const openBtn = info.waLink ? `<a class="btn-link" href="${esc(info.waLink)}" target="_blank" rel="noopener">💬 Open WhatsApp &amp; send “admin”</a>` : "";
  const toWhom = info.number ? `+${esc(info.number)}` : "your provider's WhatsApp number";
  h(`
    <div class="cap-hero"><div class="cap-logo">🗂️</div><h1>Admin</h1><p class="muted">Run your service</p></div>
    <div class="card">
      <h2 style="margin-top:0">Sign in from WhatsApp</h2>
      <p class="muted small">This app opens from WhatsApp. Send <b>admin</b> (or <b>manager</b>) and tap the sign-in link we reply with.</p>
      ${openBtn}
      <ol class="steps">
        <li>On WhatsApp, send <b>admin</b> to ${toWhom}.</li>
        <li>You'll get a reply with an <b>Open admin app</b> button.</li>
        <li>Tap it — you'll be signed in here automatically.</li>
      </ol>
    </div>`);
}

// ── Screen: choose provider ─────────────────────────────────────────────────
function screenProviders(err) {
  const rows = state.providers.map((p) =>
    `<button class="ghost prov" data-id="${esc(p.id)}"><span>${esc(p.name)} <span class="tag">${esc(p.tier)}</span></span><span class="chev">›</span></button>`).join("");
  h(`
    <div class="topbar"><h1>Choose provider</h1><button class="ghost small" id="logout">Log out</button></div>
    ${err ? `<p class="err">${esc(err)}</p>` : ""}
    <p class="muted">Pick a service to manage.</p>
    <div class="stack">${rows}</div>`);
  document.getElementById("logout").onclick = logout;
  el.querySelectorAll(".prov").forEach((b) => (b.onclick = () => selectProvider(state.providers.find((p) => p.id === b.dataset.id))));
}

// ── Dashboard shell (tab bar) ───────────────────────────────────────────────
async function dashboard() {
  liveConnect(state.providerId);
  // Resolve THIS provider's flow (a manager may run providers across verticals).
  try { const fl = await api(`/api/flow?provider=${encodeURIComponent(state.providerId)}`); if (fl.flow) state.flow = fl.flow; } catch {}
  const tabs = [
    { key: "orders", label: "Orders" },
    { key: "items", label: "Items" },
    { key: "categories", label: "Categories" },
    { key: "captains", label: "Captains" },
  ];
  if (state.tier === "admin") tabs.push({ key: "managers", label: "Managers" }, { key: "payment", label: "Payment" });
  const canSwitch = state.providers.length > 1;
  h(`
    <div class="topbar">
      <div><h1 style="margin:0">${esc(state.providerName)}</h1><span class="muted small">${esc(state.name || state.phone)} · ${esc(state.tier)}</span></div>
      <div class="row grow0" style="gap:6px">
        ${canSwitch ? `<button class="ghost small" id="switch">Switch</button>` : ""}
        <button class="ghost small" id="logout">Log out</button>
      </div>
    </div>
    <div class="tabbar" id="tabbar">${tabs.map((t) => `<button class="tabbtn${t.key === state.tab ? " active" : ""}" data-tab="${t.key}">${t.label}</button>`).join("")}</div>
    <div id="content"></div>`);
  if (canSwitch) document.getElementById("switch").onclick = screenProviders;
  document.getElementById("logout").onclick = logout;
  document.querySelectorAll("#tabbar .tabbtn").forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; dashboard(); }));
  renderTab();
}
const content = () => document.getElementById("content");
function renderTab() {
  ({ orders: tabOrders, items: tabItems, categories: tabCategories, captains: tabCaptains, managers: tabManagers, payment: tabPayment }[state.tab] || tabOrders)();
}
const pid = () => encodeURIComponent(state.providerId);

// ── Tab: Orders ─────────────────────────────────────────────────────────────
// IST calendar day (YYYY-MM-DD), optionally offset by N days.
function mgrDay(offset = 0) { return new Date(Date.now() + 330 * 60000 - (offset * 86400000)).toISOString().slice(0, 10); }

async function tabOrders() {
  const today = mgrDay(0);
  if (!state.ordersFilter) state.ordersFilter = { from: today, to: today, status: "" }; // default: today · all statuses
  const F = state.ordersFilter;
  const statuses = [...(state.flow.statuses || []), ...((state.flow.terminal || []).filter((t) => !(state.flow.statuses || []).includes(t)))];
  content().innerHTML = `
    <div class="card">
      <h2>Filter</h2>
      <div class="row">
        <div><label>From</label><input type="date" id="of_from" value="${esc(F.from)}" /></div>
        <div><label>To</label><input type="date" id="of_to" value="${esc(F.to)}" /></div>
      </div>
      <div class="row" style="margin-top:8px;flex-wrap:wrap">
        <button class="small grow0" id="of_apply">Apply</button>
        <button class="ghost small grow0" id="of_today">Today</button>
        <button class="ghost small grow0" id="of_week">Last 7 days</button>
        <button class="ghost small grow0" id="of_all">All dates</button>
      </div>
      <label>Status</label>
      <select id="of_status"><option value="">All statuses</option>${statuses.map((s) => `<option value="${esc(s)}" ${F.status === s ? "selected" : ""}>${esc(s.replace(/_/g, " "))}</option>`).join("")}</select>
    </div>
    <div id="mgrOrdersMarker" hidden></div>
    <div id="mgrOrdersList"><p class="muted">Loading orders…</p></div>`;

  const syncInputs = () => { document.getElementById("of_from").value = F.from; document.getElementById("of_to").value = F.to; };
  const loadOrders = async () => {
    const listEl = document.getElementById("mgrOrdersList");
    const q = new URLSearchParams();
    if (F.from) q.set("from", F.from);
    if (F.to) q.set("to", F.to);
    if (F.status) q.set("status", F.status);
    let orders = [];
    try { orders = (await api(`/api/admin/orders?${q.toString()}`)).orders || []; } catch (e) { listEl.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    const B = statusBuckets();
    const groups = [
      { key: "REQUESTED", label: "🆕 New requests", match: (s) => s === B.from },
      { key: "ACTIVE", label: "In progress", match: (s) => B.active.includes(s) },
      { key: "DONE", label: "Completed", match: (s) => B.terminal.includes(s) },
    ];
    const row = (o) => `<div class="card job tap" data-id="${esc(o.id)}">
        <div class="row" style="align-items:baseline"><strong style="flex:1">${esc(o.id)}</strong>${badge(o.status)}<span class="chev" style="margin-left:6px">›</span></div>
        ${o.customer_name || o.customer_phone ? `<p class="small" style="margin:6px 0 0">👤 ${esc([o.customer_name, o.customer_phone].filter(Boolean).join(" · "))}</p>` : ""}
        <div class="row small" style="margin-top:4px;align-items:baseline"><span class="muted" style="flex:1">${fmtDate(o.created_at)}</span>${paidPill(o)}<strong>${money(o.total)}</strong></div>
      </div>`;
    listEl.innerHTML = orders.length
      ? groups.map((g) => { const l = orders.filter((o) => g.match(o.status)); return l.length ? `<h2 class="sec">${g.label} <span class="count">${l.length}</span></h2>${l.map(row).join("")}` : ""; }).join("") || '<p class="muted small">No orders in this range.</p>'
      : '<p class="muted small">No orders in this range.</p>';
    listEl.querySelectorAll("[data-id]").forEach((n) => (n.onclick = () => orderDetail(n.dataset.id)));
  };

  const apply = () => { F.from = document.getElementById("of_from").value; F.to = document.getElementById("of_to").value; F.status = document.getElementById("of_status").value; loadOrders(); };
  document.getElementById("of_apply").onclick = apply;
  document.getElementById("of_status").onchange = apply;
  document.getElementById("of_today").onclick = () => { F.from = F.to = today; syncInputs(); loadOrders(); };
  document.getElementById("of_week").onclick = () => { F.from = mgrDay(6); F.to = today; syncInputs(); loadOrders(); };
  document.getElementById("of_all").onclick = () => { F.from = ""; F.to = ""; syncInputs(); loadOrders(); };
  loadOrders();
}

// ── Payment review ──────────────────────────────────────────────────────────
// The shop verifies the customer's UPI receipt. Groq's read is shown as a hint
// only — the shop confirms, and confirming is what unlocks the rest of the flow.
function payReviewHtml(order, ex) {
  if (order.payment_method !== "upi") {
    return order.payment_status === "paid"
      ? `<div class="card"><h2 style="margin-top:0">Payment</h2><p class="small" style="margin:0">✅ Paid${order.payment_ref ? ` · ${esc(order.payment_ref)}` : ""}</p></div>`
      : `<div class="card"><h2 style="margin-top:0">Payment</h2><p class="muted small" style="margin:0">💵 Cash on delivery — collect ${money(order.total)} from the customer.</p></div>`;
  }
  if (order.payment_status === "paid") {
    return `<div class="card"><h2 style="margin-top:0">Payment</h2>
      <p class="small" style="margin:0"><b style="color:#0a7">✅ Confirmed</b> — ${money(order.payment_amount || order.total)}${order.payment_ref ? ` · ref ${esc(order.payment_ref)}` : ""}${order.payment_payer ? ` · ${esc(order.payment_payer)}` : ""}</p>
      ${order.payment_receipt ? `<a href="${order.payment_receipt}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px"><img class="rcpt" src="${order.payment_receipt}" alt="payment receipt" /></a>` : ""}</div>`;
  }
  if (!order.payment_receipt) {
    return `<div class="card"><h2 style="margin-top:0">Payment</h2>
      <p class="muted small" style="margin:0">🕗 Waiting for the customer to pay ${money(order.total)} and upload a receipt.${order.payment_status === "rejected" ? " (Their last receipt was rejected.)" : ""}</p></div>`;
  }
  // Receipt in hand → show it big enough to read, with Groq's read beside it.
  const mismatch = ex && ex.mismatch;
  const via = ex && ex.source === "whatsapp" ? ` <span class="badge ASSIGNED">via WhatsApp</span>` : "";
  const read = ex && ex.ok !== false
    ? `<ul class="small" style="margin:8px 0 0;padding-left:18px">
         <li>Amount read: <b>${ex.amount != null ? money(ex.amount) : "—"}</b> ${mismatch ? `<span class="err">⚠️ order total is ${money(ex.expected)}</span>` : ex.amount != null ? "✅ matches the total" : ""}</li>
         ${ex.orderRef ? `<li>Order note: <b>${esc(ex.orderRef)}</b></li>` : ""}
         <li>Reference: ${ex.ref ? `<b>${esc(ex.ref)}</b>` : "—"}</li>
         <li>Payer: ${ex.payer ? esc(ex.payer) : "—"}</li>
         <li>Paid at: ${ex.paidAt ? esc(ex.paidAt) : "—"}${ex.status ? ` · ${esc(ex.status)}` : ""}</li>
       </ul>
       <p class="muted small" style="margin:6px 0 0">Read automatically${via ? " from a WhatsApp receipt" : ""} — check it against the image before confirming.</p>`
    : `<p class="muted small" style="margin:8px 0 0">Couldn't read this receipt automatically — please check the image yourself.</p>`;
  return `<div class="card"><h2 style="margin-top:0">Payment — review${via}</h2>
    <p class="small" style="margin:0 0 8px">Customer sent a receipt for <b>${money(order.total)}</b>. Confirm only if the money has actually reached your account.</p>
    <a href="${order.payment_receipt}" target="_blank" rel="noopener"><img class="rcpt" src="${order.payment_receipt}" alt="payment receipt" /></a>
    ${read}
    <div class="row" style="gap:8px;margin-top:12px">
      <button id="payok">✅ Confirm payment</button>
      <button id="payno" class="ghost">Reject receipt</button>
    </div>
    <p id="paymsg" class="small" style="margin:6px 0 0"></p></div>`;
}

function wirePayReview(order, id, reload) {
  const ok = document.getElementById("payok");
  if (!ok) return;
  const msg = document.getElementById("paymsg");
  const send = async (action) => {
    msg.className = "small"; msg.textContent = action === "confirm" ? "Confirming…" : "Rejecting…";
    try {
      await api(`/api/admin/orders/${encodeURIComponent(id)}/payment`, { method: "POST", body: { action } });
      reload();
    } catch (e) { msg.className = "small err"; msg.textContent = e.message; }
  };
  ok.onclick = () => { if (confirm(`Confirm you received ${money(order.total)} for ${order.id}?`)) send("confirm"); };
  document.getElementById("payno").onclick = () => { if (confirm("Reject this receipt? The customer will be asked to upload another.")) send("reject"); };
}

async function orderDetail(id) {
  h(`<div class="topbar"><h1>Order</h1><button class="ghost small" id="back">←</button></div><p class="muted">Loading…</p>`);
  document.getElementById("back").onclick = dashboard;
  let d;
  try { d = await api(`/api/admin/orders/${encodeURIComponent(id)}`); } catch (e) { content && (el.innerHTML = `<div class="card"><p class="err">${esc(e.message)}</p></div>`); return; }
  const { order, customer, allowedNext = [], captains = [], fulfilment = "delivery", payExtracted = null, paymentBlocked = false, feeKind = null } = d;
  let draftFee = order.delivery_fee || 0; // shop-set courier/delivery fee (paise)
  const items = (order.items || []).map((i) => `<li>${esc(i.name)} × ${i.qty}${i.unit_price ? ` <span class="muted">— ${money(i.qty * i.unit_price)}</span>` : ""}</li>`).join("");

  // Before accepting, the manager can reconcile the item list — essential for
  // photo/list orders where Groq guessed the items. Editable only at REQUESTED.
  const editable = order.status === "REQUESTED";
  const isPhoto = (order.images || []).length > 0; // photo/list order → quote-and-confirm
  let draftItems = (order.items || []).map((i) => ({ name: i.name, qty: i.qty, price: i.unit_price || 0 }));
  const itemsCardHtml = editable
    ? `<div class="card"><h2 style="margin-top:0">Items <span class="muted small">— review${isPhoto ? " &amp; price" : ""} before ${isPhoto ? "quoting" : "accepting"}</span></h2>
        <div id="edititems"></div>
        ${feeKind ? `<div class="row" style="align-items:center;margin-top:8px"><label style="flex:1;margin:0">${feeKind === "courier" ? "Courier" : "Delivery"} fee</label><div class="row grow0" style="gap:4px;align-items:center">₹<input id="draftFee" type="number" min="0" step="0.01" value="${(draftFee / 100).toFixed(2)}" style="width:80px" /></div></div>` : ""}
        <div class="row" style="align-items:baseline;margin-top:8px"><strong style="flex:1">Total</strong><strong id="draftTotal" style="font-size:16px">${money(0)}</strong></div>
        <div class="row" style="gap:6px;margin-top:10px;align-items:flex-end">
          <div style="flex:1"><label>Add item</label><input id="ni_name" placeholder="e.g. Tomato" /></div>
          <div><label>Qty</label><input id="ni_qty" type="number" min="1" value="1" style="width:56px" /></div>
          <div><label>₹</label><input id="ni_price" type="number" min="0" step="0.01" placeholder="0" style="width:70px" /></div>
          <button class="grow0 ghost small" id="ni_add">Add</button>
        </div>
        <p id="imsg" class="small"></p></div>`
    : `<div class="card"><h2 style="margin-top:0">Items</h2><ul>${items || '<li class="muted">No items</li>'}</ul>
        ${order.delivery_fee ? `<div class="row" style="align-items:baseline"><span class="muted small" style="flex:1">Items</span><span class="muted small">${money(order.items_total)}</span></div><div class="row" style="align-items:baseline"><span class="muted small" style="flex:1">${feeKind === "courier" ? "Courier" : "Delivery"} fee</span><span class="muted small">${money(order.delivery_fee)}</span></div>` : ""}
        <div class="row" style="align-items:baseline"><strong style="flex:1">Total</strong><strong style="font-size:17px">${money(order.total)}</strong></div>
        </div>`;
  // Customer-uploaded photos/lists (tap to view full size).
  const imagesCardHtml = (order.images || []).length
    ? `<div class="card"><h2 style="margin-top:0">Customer photos</h2><div class="pthumbs">${order.images.map((im) => `<a href="${im.data}" target="_blank" rel="noopener" class="pthumb"><img src="${im.data}" alt="customer photo" /></a>`).join("")}</div></div>`
    : "";

  let controls;
  if (order.status === "REQUESTED") {
    controls = `<p class="muted">${isPhoto ? "Price the items, then send the quote to the customer to confirm." : "Awaiting your decision."}</p><div class="row"><button id="accept">${isPhoto ? "Price &amp; send quote" : "Accept"}</button><button id="reject" class="ghost">Reject</button></div><p id="msg"></p>`;
  } else if (order.status === "QUOTED") {
    controls = `<p class="muted">⏳ Quote sent — awaiting the customer's confirmation.</p><p id="msg"></p>`;
  } else if (allowedNext.length) {
    const next = allowedNext[0];
    let agentField = "";
    const asg = (state.flow.assignments || []).find((a) => a.at === next);
    // A courier-flow step always captures courier + tracking (no field agent).
    const forcedCourier = asg && asg.role === "courier";
    // Courier is an alternative to a delivery-type assignment when the provider allows it.
    const courierable = asg && asg.role === "delivery" && (fulfilment === "courier" || fulfilment === "both");
    // Courier dispatch inputs: a tracking link and/or a receipt photo — either or both.
    const courierInputs = `
      <label>Tracking link <span class="muted small">(optional)</span></label>
      <input id="courierTracking" type="url" value="${esc(order.courier_tracking || "")}" placeholder="https://… courier tracking URL" />
      <label style="margin-top:8px">Courier receipt photo <span class="muted small">(optional)</span></label>
      <div class="row" style="gap:8px;align-items:center;margin-top:2px">
        <img id="crcptprev" src="${order.courier_receipt || ""}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;border:1px solid var(--border);${order.courier_receipt ? "" : "display:none"}" />
        <label class="ghost small grow0" style="cursor:pointer;margin:0">📷 ${order.courier_receipt ? "Change" : "Add"} receipt<input type="file" id="crcpt" accept="image/*" hidden /></label>
        <span id="crcptname" class="muted small"></span>
      </div>
      <p class="muted small" style="margin:4px 0 0">Add a tracking link, a receipt photo, or both. We'll send the link to the customer.</p>`;
    // On-site flows (no delivery/courier step, e.g. plumber) can assign several captains.
    const onsite = asg && asg.role !== "courier" && !(state.flow.assignments || []).some((a) => a.role === "delivery");
    if (asg) {
      const term = state.brand?.agentTerm || "agent";
      const isDel = asg.slot === "delivery";
      const cur = isDel ? order.delivery_captain_name : order.agent_name;
      let picker;
      if (captains.length) {
        const opts = `<option value="">Select…</option>` + captains.map((c) => `<option value="${c.id}" data-name="${esc(c.name || "")}" data-phone="${esc(c.phone || "")}" ${cur === c.name ? "selected" : ""}>${esc(c.name || term)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("");
        picker = `<select id="agent">${opts}</select>`;
      } else {
        picker = `<p class="muted small">No ${esc(term.toLowerCase())}s yet — add them in the Captains tab.</p><input id="agent" value="${esc(cur || "")}" placeholder="${esc(term)} name" />`;
      }
      if (forcedCourier) {
        agentField = courierInputs;
      } else if (courierable) {
        // fulfilment 'courier' → courier only; 'both' → let the manager choose.
        const startCourier = fulfilment === "courier";
        agentField = `
          ${fulfilment === "both" ? `<label>Fulfilment</label>
          <div class="row" style="gap:6px;margin-bottom:6px"><button type="button" class="ghost small grow0 fmode${startCourier ? "" : " sel"}" data-mode="delivery">🛵 Own agent</button><button type="button" class="ghost small grow0 fmode${startCourier ? " sel" : ""}" data-mode="courier">📦 Courier</button></div>` : ""}
          <div id="deliverFields" style="display:${startCourier ? "none" : "block"}"><label>Assign ${esc(term.toLowerCase())}</label>${picker}</div>
          <div id="courierFields" style="display:${startCourier ? "block" : "none"}">${courierInputs}</div>`;
      } else if (onsite && captains.length) {
        const assigned = new Set((order.assignees || []).map((a) => a.phone));
        agentField = `<label>Assign ${esc(term.toLowerCase())}s <span class="muted small">— pick one or more</span></label>
          <div id="multiCaptains">${captains.map((c) => `<label class="row" style="gap:8px;align-items:center;cursor:pointer;margin:4px 0"><input type="checkbox" class="mcap" data-name="${esc(c.name || "")}" data-phone="${esc(c.phone || "")}" ${assigned.has(c.phone) ? "checked" : ""} style="width:auto;margin:0" /><span>${esc(c.name || term)}${c.phone ? ` <span class="muted small">· ${esc(c.phone)}</span>` : ""}</span></label>`).join("")}</div>`;
      } else {
        agentField = `<label>Assign ${esc(term.toLowerCase())}</label>${picker}`;
      }
    }
    // A UPI order can't move past accept until payment is confirmed — say so
    // instead of letting them hit a button that will 400.
    controls = paymentBlocked
      ? `<p class="muted" style="margin:0">💳 Waiting on payment — confirm the customer's payment below before starting this order.</p>`
      : `${agentField}<button id="save" data-next="${next}" data-courierable="${courierable ? 1 : 0}" data-forcedcourier="${forcedCourier ? 1 : 0}" data-onsite="${onsite && captains.length ? 1 : 0}" data-start="${courierable && fulfilment === "courier" ? "courier" : "delivery"}" style="margin-top:12px">Advance to ${next.replace(/_/g, " ")} &amp; notify</button><p id="msg"></p>`;
  } else {
    controls = `<p class="muted">${order.status === (state.flow.decision?.reject) ? "Rejected — no further action." : "Complete — no further action."}</p>`;
  }

  h(`
    <div class="topbar"><h1>${esc(order.id)}</h1><button class="ghost small" id="back">←</button></div>
    <div class="card">
      ${badge(order.status)}
      <p style="margin:10px 0 2px">👤 ${customer?.wa_phone ? `<a href="tel:${esc(customer.wa_phone)}">${esc(order.customer_name || customer.name || customer.wa_phone)}</a>` : esc(order.customer_name || "—")}</p>
      ${order.address ? `<p class="muted small" style="margin:4px 0">${esc(order.address)}</p>` : ""}
      ${order.lat != null ? `<p class="small" style="margin:4px 0"><a href="https://www.google.com/maps?q=${order.lat},${order.lng}" target="_blank" rel="noopener">📍 Navigate</a></p>` : ""}
      ${(order.assignees || []).length > 1
        ? `<p class="muted small" style="margin:6px 0 0">🔧 ${esc(state.brand?.agentTerm || "Technician")}s: ${order.assignees.map((a) => `${esc(a.name || a.phone)}${a.phone ? ` <a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>` : ""}`).join(", ")}</p>`
        : order.agent_name ? `<p class="muted small" style="margin:6px 0 0">🔧 ${esc(state.brand?.agentTerm || "Technician")}: ${esc(order.agent_name)}${order.captain_phone ? ` · <a href="tel:${esc(order.captain_phone)}">${esc(order.captain_phone)}</a>` : ""}</p>` : ""}
      ${order.delivery_captain_name ? `<p class="muted small" style="margin:2px 0 0">🛵 ${esc(order.delivery_captain_name)}${order.delivery_captain_phone ? ` · <a href="tel:${esc(order.delivery_captain_phone)}">${esc(order.delivery_captain_phone)}</a>` : ""}</p>` : ""}
      ${order.ship_mode === "courier" && order.courier_tracking ? `<p class="muted small" style="margin:6px 0 0">📦 Tracking: <a href="${esc(order.courier_tracking)}" target="_blank" rel="noopener">${esc(order.courier_tracking)}</a></p>` : ""}
      ${order.courier_receipt ? `<a href="${order.courier_receipt}" target="_blank" rel="noopener" style="display:inline-block;margin:6px 0 0"><img class="rcpt" src="${order.courier_receipt}" alt="courier receipt" style="max-width:140px;max-height:180px" /></a>` : ""}
    </div>
    ${itemsCardHtml}
    ${imagesCardHtml}
    ${payReviewHtml(order, payExtracted)}
    <div class="card"><h2 style="margin-top:0">Action</h2>${controls}</div>
    <div class="card"><h2 style="margin-top:0">History</h2><ul class="timeline">${(order.events || []).map((e) => `<li>${badge(e.status)} <span class="muted">${fmtDate(e.at)} · ${esc(e.actor)}</span></li>`).join("")}</ul></div>`);
  document.getElementById("back").onclick = dashboard;
  wirePayReview(order, id, () => orderDetail(id));

  const patch = async (status, agentName, captainPhone, courier) => {
    const msg = document.getElementById("msg");
    try { await api(`/api/admin/orders/${encodeURIComponent(id)}/status`, { method: "PATCH", body: { status, agentName, captainPhone, ...(courier || {}) } }); orderDetail(id); }
    catch (e) { msg.className = "err"; msg.textContent = e.message === "invalid_transition" ? "That change isn't allowed." : e.message; }
  };
  // Courier receipt photo upload (undefined = leave as-is; string = new photo).
  let courierReceipt;
  const crcpt = document.getElementById("crcpt");
  if (crcpt) crcpt.onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const nm = document.getElementById("crcptname");
    try { courierReceipt = await downscaleImg(f); const p = document.getElementById("crcptprev"); p.src = courierReceipt; p.style.display = ""; nm.className = "muted small"; nm.textContent = "✓ receipt ready"; }
    catch { nm.className = "small err"; nm.textContent = "couldn't read image"; }
  };
  // Delivery ↔ courier toggle (only rendered when the provider allows courier).
  let shipMode = document.getElementById("save")?.dataset.start === "courier" ? "courier" : "delivery";
  document.querySelectorAll(".fmode").forEach((b) => (b.onclick = () => {
    shipMode = b.dataset.mode;
    document.querySelectorAll(".fmode").forEach((x) => x.classList.toggle("sel", x === b));
    const df = document.getElementById("deliverFields"), cf = document.getElementById("courierFields");
    if (df) df.style.display = shipMode === "courier" ? "none" : "block";
    if (cf) cf.style.display = shipMode === "courier" ? "block" : "none";
  }));
  // Editable item list (photo/list-order reconciliation) — only at REQUESTED.
  if (editable) {
    const box = document.getElementById("edititems");
    const recalcDraft = () => { const el = document.getElementById("draftTotal"); if (el) el.textContent = money(draftItems.reduce((s, it) => s + (it.price || 0) * it.qty, 0) + draftFee); };
    const feeEl = document.getElementById("draftFee");
    if (feeEl) feeEl.onchange = () => { draftFee = Math.round((parseFloat(feeEl.value) || 0) * 100); recalcDraft(); };
    const paint = () => {
      box.innerHTML = draftItems.length
        ? draftItems
            .map((it, idx) => `<div class="summary-line" data-idx="${idx}"><span style="flex:1">${esc(it.name)}</span><input class="dprice" type="number" min="0" step="0.01" value="${it.price ? (it.price / 100) : ""}" placeholder="₹" style="width:64px;margin-right:6px" title="Price each" /><div class="qtyctrl"><button type="button" class="qbtn dminus">−</button><input class="qnum dqty" type="number" min="1" value="${it.qty}" style="width:46px" /><button type="button" class="qbtn dplus">+</button></div><button type="button" class="qbtn drm" title="Remove" style="margin-left:6px">✕</button></div>`)
            .join("")
        : '<p class="muted small">No items — add at least one.</p>';
      box.querySelectorAll(".summary-line").forEach((row) => {
        const idx = +row.dataset.idx;
        const num = row.querySelector(".dqty"), pr = row.querySelector(".dprice");
        row.querySelector(".dplus").onclick = () => { draftItems[idx].qty++; paint(); };
        row.querySelector(".dminus").onclick = () => { draftItems[idx].qty = Math.max(1, draftItems[idx].qty - 1); paint(); };
        num.onchange = () => { draftItems[idx].qty = Math.max(1, parseInt(num.value, 10) || 1); recalcDraft(); };
        pr.onchange = () => { draftItems[idx].price = Math.round((parseFloat(pr.value) || 0) * 100); recalcDraft(); };
        row.querySelector(".drm").onclick = () => { draftItems.splice(idx, 1); paint(); };
      });
      recalcDraft();
    };
    paint();
    document.getElementById("ni_add").onclick = () => {
      const n = document.getElementById("ni_name"), q = document.getElementById("ni_qty"), p = document.getElementById("ni_price");
      const name = n.value.trim();
      if (!name) return;
      draftItems.push({ name, qty: Math.max(1, parseInt(q.value, 10) || 1), price: Math.round((parseFloat(p.value) || 0) * 100) });
      n.value = ""; q.value = "1"; p.value = ""; paint();
    };
  }

  const acc = document.getElementById("accept");
  if (acc) {
    acc.onclick = async () => {
      const imsg = document.getElementById("imsg");
      if (!draftItems.length) { if (imsg) { imsg.className = "small err"; imsg.textContent = "Add at least one item."; } return; }
      try {
        // Persist the reconciled + priced item list (+ shipping fee), then quote/accept in one tap.
        await api(`/api/admin/orders/${encodeURIComponent(id)}/items`, { method: "PATCH", body: { items: draftItems.map((i) => ({ name: i.name, qty: i.qty, price: i.price || 0 })), deliveryFee: draftFee } });
      } catch (e) {
        if (imsg) { imsg.className = "small err"; imsg.textContent = e.message === "not_editable" ? "Order already moved on." : e.message; }
        return;
      }
      // Photo/list order → send a quote for the customer to confirm; else accept outright.
      patch(isPhoto ? "QUOTED" : "ACCEPTED");
    };
    document.getElementById("reject").onclick = () => { if (confirm("Reject this request? Final.")) patch("REJECTED"); };
  }
  const save = document.getElementById("save");
  if (save) save.onclick = () => {
    if (save.dataset.forcedcourier === "1" || (save.dataset.courierable === "1" && shipMode === "courier")) {
      const ct = document.getElementById("courierTracking")?.value.trim() || "";
      const msg = document.getElementById("msg");
      if (ct && !/^https?:\/\//i.test(ct)) { if (msg) { msg.className = "err"; msg.textContent = "Enter a valid link starting with http:// or https://"; } return; }
      // Need at least one: a tracking link or a receipt photo (new or already on file).
      if (!ct && courierReceipt === undefined && !order.courier_receipt) { if (msg) { msg.className = "err"; msg.textContent = "Add a tracking link or a receipt photo."; } return; }
      patch(save.dataset.next, "", "", { shipMode: "courier", courierTracking: ct, ...(courierReceipt !== undefined ? { courierReceipt } : {}) });
      return;
    }
    if (save.dataset.onsite === "1") {
      const assignees = [...document.querySelectorAll(".mcap:checked")].map((b) => ({ name: b.dataset.name, phone: b.dataset.phone }));
      const msg = document.getElementById("msg");
      if (!assignees.length) { if (msg) { msg.className = "err"; msg.textContent = "Pick at least one captain."; } return; }
      patch(save.dataset.next, "", "", { assignees });
      return;
    }
    const elc = document.getElementById("agent"); let agentName = "", captainPhone = "";
    if (elc) { if (elc.tagName === "SELECT") { const o = elc.selectedOptions[0]; agentName = o?.dataset.name || ""; captainPhone = o?.dataset.phone || ""; } else agentName = elc.value; }
    patch(save.dataset.next, agentName, captainPhone);
  };
}

// ── Tab: Items (catalog) ────────────────────────────────────────────────────
async function tabItems() {
  content().innerHTML = `<p class="muted">Loading…</p>`;
  let catalog = [], categories = [];
  try {
    catalog = (await api(`/api/providers/${esc(providerSlug())}`)).catalog || [];
    categories = (await api(`/api/console/providers/${pid()}/categories`)).categories || [];
  } catch (e) { content().innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const groups = {};
  catalog.forEach((c) => { const g = c.category || "Uncategorised"; (groups[g] = groups[g] || []).push(c); });
  const catKeys = Object.keys(groups).sort();
  const rows = catKeys.map((g) =>
    `<div class="pick-cat">${esc(g)}</div>` + groups[g].map((c) => {
      const off = c.available === 0;
      return `<div class="order-line item-row${off ? " item-off" : ""}" data-name="${esc(c.name)}" data-cat="${esc(g)}"><div class="row" style="gap:10px;align-items:center;flex:1">${c.image ? `<img src="${c.image}" alt="" style="width:42px;height:42px;object-fit:cover;border-radius:8px;border:1px solid var(--border);flex:0 0 auto" />` : ""}<div><strong>${esc(c.name)}</strong> <span class="amt">${money(c.price)}</span>${off ? ` <span class="badge REJECTED">out of stock</span>` : ""}<br><span class="muted">${esc(c.unit || "")}</span></div></div>
       <div class="row grow0" style="gap:6px"><button class="ghost small avail" data-id="${c.id}" data-on="${off ? 0 : 1}">${off ? "Mark in stock" : "Mark out"}</button><button class="ghost small edit" data-id="${c.id}">Edit</button><button class="ghost small del" data-id="${c.id}" data-name="${esc(c.name)}">✕</button></div></div>`;
    }).join("")).join("");
  // Category chips — same rule as the customer's order form: a lone category is
  // no choice at all, so don't take up a row for it.
  const chipsHtml = catKeys.length > 1
    ? `<div class="chips" id="itemchips"><button type="button" class="chip active" data-c="__all__">All</button>` +
      catKeys.map((g) => `<button type="button" class="chip" data-c="${esc(g)}">${esc(g)}</button>`).join("") + `</div>`
    : "";
  content().innerHTML = `<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Items</h2><button class="small grow0" id="add">+ Add item</button></div>` +
    (catalog.length ? `${chipsHtml}<input id="itemsearch" placeholder="Search items…" style="margin-bottom:10px" /><p id="itemcount" class="muted small" style="margin:0 0 8px"></p>` : "") +
    (rows || '<p class="muted">No items yet.</p>');
  document.getElementById("add").onclick = () => itemModal(null, categories, catalog);
  wireItemFilter();
  content().querySelectorAll(".edit").forEach((b) => (b.onclick = () => itemModal(catalog.find((c) => c.id === b.dataset.id), categories, catalog)));
  content().querySelectorAll(".avail").forEach((b) => (b.onclick = async () => { await api(`/api/console/providers/${pid()}/catalog/${b.dataset.id}`, { method: "PATCH", body: { available: b.dataset.on === "0" } }); tabItems(); }));
  content().querySelectorAll(".del").forEach((b) => (b.onclick = async () => { if (!confirm(`Delete "${b.dataset.name}"?`)) return; await api(`/api/console/providers/${pid()}/catalog/${b.dataset.id}`, { method: "DELETE" }); tabItems(); }));
}
// Category chips + search, combined, over the Items tab's rows. Mirrors the
// customer order form's filter so the two read the same way. Hides a category
// heading once everything under it is filtered out, and says so when nothing matches.
function wireItemFilter() {
  const box = content();
  const search = box.querySelector("#itemsearch");
  if (!search) return; // no catalog yet
  const count = box.querySelector("#itemcount");
  let activeCat = "__all__";
  const apply = () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    box.querySelectorAll(".item-row").forEach((r) => {
      const catOk = activeCat === "__all__" || r.dataset.cat === activeCat;
      const nameOk = !q || r.dataset.name.toLowerCase().includes(q);
      const on = catOk && nameOk;
      r.style.display = on ? "" : "none";
      if (on) shown++;
    });
    box.querySelectorAll(".pick-cat").forEach((hd) => {
      let sib = hd.nextElementSibling, any = false;
      while (sib && sib.classList.contains("item-row")) { if (sib.style.display !== "none") any = true; sib = sib.nextElementSibling; }
      hd.style.display = any ? "" : "none";
    });
    const total = box.querySelectorAll(".item-row").length;
    count.textContent = shown === total ? `${total} item${total === 1 ? "" : "s"}` : shown ? `${shown} of ${total} items` : "No items match.";
  };
  search.oninput = apply;
  box.querySelectorAll("#itemchips .chip").forEach((ch) => {
    ch.onclick = () => {
      activeCat = ch.dataset.c;
      box.querySelectorAll("#itemchips .chip").forEach((x) => x.classList.toggle("active", x === ch));
      apply();
    };
  });
  apply();
}

// Downscale an uploaded photo before saving — smaller for D1 storage + fast pages.
const downscaleImg = (file) => new Promise((resolve, reject) => {
  const rd = new FileReader();
  rd.onerror = reject;
  rd.onload = () => {
    const img = new Image();
    img.onerror = reject;
    img.onload = () => {
      const max = 800, scale = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv.toDataURL("image/jpeg", 0.7));
    };
    img.src = rd.result;
  };
  rd.readAsDataURL(file);
});

function itemModal(item, categories, catalog) {
  const catOpts = categories.map((c) => `<option ${item && item.category === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("") + `<option value="__new__">+ New category…</option>`;
  let newImg; // set when the admin picks a new photo; undefined = leave as-is
  openModal(item ? "Edit item" : "Add item", `
    <label>Name</label><input id="m_name" value="${item ? esc(item.name) : ""}" />
    <label style="margin-top:8px">Category</label><select id="m_cat">${catOpts}</select>
    <input id="m_newcat" style="display:none;margin-top:6px" placeholder="New category name" />
    <label style="margin-top:8px">Unit</label><select id="m_unit"><option ${item && item.unit === "piece" ? "selected" : ""}>piece</option><option ${item && item.unit === "kg" ? "selected" : ""}>kg</option></select>
    <label style="margin-top:8px">Price (₹)</label><input id="m_price" type="number" min="0" step="0.01" value="${item ? (item.price / 100) : ""}" />
    <label style="margin-top:8px">Description <span class="muted small">— shown to customers</span></label>
    <textarea id="m_desc" rows="2" placeholder="e.g. Deep cleanses pores & controls oil">${item && item.description ? esc(item.description) : ""}</textarea>
    <label style="margin-top:8px">Photo</label>
    <div class="row" style="gap:8px;align-items:center">
      <img id="m_imgprev" src="${item && item.image ? item.image : ""}" alt="" style="width:52px;height:52px;object-fit:cover;border-radius:8px;border:1px solid var(--border);${item && item.image ? "" : "display:none"}" />
      <label class="ghost small grow0" style="cursor:pointer;margin:0">📷 ${item && item.image ? "Change photo" : "Add photo"}<input type="file" id="m_img" accept="image/*" hidden /></label>
      ${item && item.image ? `<button type="button" class="ghost small grow0" id="m_imgclear">Remove</button>` : ""}
      <span id="m_imgname" class="muted small"></span>
    </div>
    <button id="m_save" style="margin-top:14px">${item ? "Save" : "Add"}</button><p id="m_msg"></p>`);
  const sel = document.getElementById("m_cat"), ni = document.getElementById("m_newcat");
  sel.onchange = () => { ni.style.display = sel.value === "__new__" ? "block" : "none"; };
  const prev = document.getElementById("m_imgprev"), imgName = document.getElementById("m_imgname");
  document.getElementById("m_img").onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    try { newImg = await downscaleImg(f); prev.src = newImg; prev.style.display = ""; imgName.textContent = "✓ photo ready"; }
    catch { imgName.className = "small err"; imgName.textContent = "couldn't read image"; }
  };
  document.getElementById("m_imgclear")?.addEventListener("click", () => { newImg = null; prev.style.display = "none"; imgName.textContent = "photo will be removed"; });
  document.getElementById("m_save").onclick = async () => {
    const msg = document.getElementById("m_msg");
    const category = sel.value === "__new__" ? ni.value.trim() : sel.value;
    const paise = Math.round((parseFloat(document.getElementById("m_price").value) || 0) * 100);
    const body = { name: document.getElementById("m_name").value, category, unit: document.getElementById("m_unit").value, price: paise, description: document.getElementById("m_desc").value };
    if (newImg !== undefined) body.image = newImg; // only send when picked/removed
    if (!body.name.trim()) { msg.className = "err"; msg.textContent = "Name required."; return; }
    try {
      if (item) await api(`/api/console/providers/${pid()}/catalog/${item.id}`, { method: "PATCH", body });
      else await api(`/api/console/providers/${pid()}/catalog`, { method: "POST", body });
      closeModal(); tabItems();
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
}

// ── Tab: Categories ─────────────────────────────────────────────────────────
async function tabCategories() {
  content().innerHTML = `<p class="muted">Loading…</p>`;
  let categories = [];
  try { categories = (await api(`/api/console/providers/${pid()}/categories`)).categories || []; } catch (e) { content().innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const rows = categories.map((c) => `<div class="order-line"><strong>${esc(c.name)}</strong><button class="ghost small del" data-id="${c.id}" data-name="${esc(c.name)}">✕</button></div>`).join("");
  content().innerHTML = `<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Categories</h2><button class="small grow0" id="add">+ Add category</button></div>${rows || '<p class="muted">No categories yet.</p>'}`;
  document.getElementById("add").onclick = () => {
    openModal("Add category", `<label>Category name</label><input id="m_cat" placeholder="e.g. Wash & Iron" /><button id="m_save" style="margin-top:14px">Add</button><p id="m_msg"></p>`);
    document.getElementById("m_save").onclick = async () => {
      const name = document.getElementById("m_cat").value.trim(); if (!name) return;
      try { await api(`/api/console/providers/${pid()}/categories`, { method: "POST", body: { name } }); closeModal(); tabCategories(); }
      catch (e) { document.getElementById("m_msg").className = "err"; document.getElementById("m_msg").textContent = e.message; }
    };
  };
  content().querySelectorAll(".del").forEach((b) => (b.onclick = async () => { if (!confirm(`Delete "${b.dataset.name}"? (Items keep their label.)`)) return; await api(`/api/console/providers/${pid()}/categories/${b.dataset.id}`, { method: "DELETE" }); tabCategories(); }));
}

// ── Tab: Captains ───────────────────────────────────────────────────────────
async function tabCaptains() {
  content().innerHTML = `<p class="muted">Loading…</p>`;
  let captains = [];
  try { captains = (await api(`/api/console/providers/${pid()}/captains`)).captains || []; } catch (e) { content().innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const rows = captains.map((c) => `<div class="order-line"><div><strong>${esc(c.name || "Captain")}</strong><br><span class="muted">${esc(c.phone || "")}</span></div><button class="ghost small del" data-id="${c.id}" data-name="${esc(c.name || "")}">✕</button></div>`).join("");
  content().innerHTML = `<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Captains</h2><button class="small grow0" id="add">+ Add captain</button></div>${rows || '<p class="muted">No captains yet.</p>'}`;
  document.getElementById("add").onclick = () => {
    openModal("Add captain", `<label>Name</label><input id="m_name" /><label style="margin-top:8px">Phone (with country code)</label><input id="m_phone" inputmode="tel" placeholder="e.g. 91 98765 43210" /><button id="m_save" style="margin-top:14px">Add captain</button><p id="m_msg"></p>`);
    document.getElementById("m_save").onclick = async () => {
      const name = document.getElementById("m_name").value.trim(), phone = document.getElementById("m_phone").value;
      const msg = document.getElementById("m_msg");
      try { await api(`/api/console/providers/${pid()}/captains`, { method: "POST", body: { name, phone } }); closeModal(); tabCaptains(); }
      catch (e) { msg.className = "err"; msg.textContent = e.message === "invalid" ? "Enter a name and a valid phone with country code." : e.message; }
    };
  };
  content().querySelectorAll(".del").forEach((b) => (b.onclick = async () => { if (!confirm(`Remove captain "${b.dataset.name}"?`)) return; await api(`/api/console/providers/${pid()}/captains/${b.dataset.id}`, { method: "DELETE" }); tabCaptains(); }));
}

// ── Tab: Managers (admin tier only) ─────────────────────────────────────────
async function tabManagers() {
  content().innerHTML = `<p class="muted">Loading…</p>`;
  let managers = [];
  try { managers = (await api(`/api/console/providers/${pid()}/managers`)).managers || []; } catch (e) { content().innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  const rows = managers.map((m) => `<div class="order-line"><div><strong>${esc(m.name || "Manager")}</strong> <span class="tag">${esc(m.tier)}</span><br><span class="muted">${esc(m.phone || "")}</span></div><button class="ghost small del" data-id="${m.id}" data-name="${esc(m.name || "")}">✕</button></div>`).join("");
  content().innerHTML = `<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Managers</h2><button class="small grow0" id="add">+ Add manager</button></div>
    <p class="muted small" style="margin-top:-4px">Admins can add/remove managers. Managers can do everything except this tab.</p>${rows || '<p class="muted">No managers yet.</p>'}`;
  document.getElementById("add").onclick = () => {
    openModal("Add manager", `
      <label>Name</label><input id="m_name" />
      <label style="margin-top:8px">Phone (with country code)</label><input id="m_phone" inputmode="tel" placeholder="e.g. 91 98765 43210" />
      <label style="margin-top:8px">Role</label><select id="m_tier"><option value="manager">Manager (no Managers tab)</option><option value="admin">Admin (full access)</option></select>
      <button id="m_save" style="margin-top:14px">Add</button><p id="m_msg"></p>`);
    document.getElementById("m_save").onclick = async () => {
      const name = document.getElementById("m_name").value.trim(), phone = document.getElementById("m_phone").value, tier = document.getElementById("m_tier").value;
      const msg = document.getElementById("m_msg");
      try { await api(`/api/console/providers/${pid()}/managers`, { method: "POST", body: { name, phone, tier } }); closeModal(); tabManagers(); }
      catch (e) { msg.className = "err"; msg.textContent = e.message === "invalid" ? "Enter a name and a valid phone with country code." : e.message; }
    };
  };
  content().querySelectorAll(".del").forEach((b) => (b.onclick = async () => { if (!confirm(`Remove manager "${b.dataset.name}"?`)) return; await api(`/api/console/providers/${pid()}/managers/${b.dataset.id}`, { method: "DELETE" }); tabManagers(); }));
}

// ── Tab: Payment (UPI) — admin tier only ────────────────────────────────────
async function tabPayment() {
  content().innerHTML = `<p class="muted">Loading…</p>`;
  let p = {};
  try { p = await api(`/api/console/providers/${pid()}/payment`); } catch (e) { content().innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  content().innerHTML = `
    <h2 style="margin:0 0 4px">Payment (UPI)</h2>
    <p class="muted small" style="margin:0 0 12px">Set your UPI ID so technicians can show the customer a payment QR after the job.</p>
    ${p.upi_id ? `<div class="card" style="margin-bottom:12px"><span class="muted small">Current UPI</span><div><strong>${esc(p.upi_id)}</strong>${p.upi_name ? ` · ${esc(p.upi_name)}` : ""}</div></div>` : ""}
    <button class="ghost" id="scan" style="margin-bottom:12px">📷 Scan my UPI QR</button>
    <div id="scanbox"></div>
    <label>UPI ID (VPA)</label>
    <input id="upi" value="${esc(p.upi_id || "")}" placeholder="e.g. name@okhdfcbank" autocapitalize="off" autocorrect="off" spellcheck="false" />
    <label style="margin-top:8px">Payee name (shown in the customer's UPI app)</label>
    <input id="upiname" value="${esc(p.upi_name || "")}" placeholder="${esc(state.providerName)}" />
    <button id="save" style="margin-top:14px">Save UPI</button>
    <p id="msg"></p>`;
  document.getElementById("scan").onclick = startUpiScan;
  document.getElementById("save").onclick = async (ev) => {
    const btn = ev.currentTarget, msg = document.getElementById("msg");
    msg.textContent = ""; msg.className = "";
    const upi_id = document.getElementById("upi").value.trim();
    const upi_name = document.getElementById("upiname").value.trim();
    btn.disabled = true; btn.textContent = "Saving…";
    try { await api(`/api/console/providers/${pid()}/payment`, { method: "PATCH", body: { upi_id, upi_name } }); tabPayment(); }
    catch (e) { msg.className = "err"; msg.textContent = e.message === "invalid_upi" ? "That doesn't look like a UPI ID (e.g. name@okhdfcbank)." : e.message; btn.disabled = false; btn.textContent = "Save UPI"; }
  };
}

// Camera scan → extract the VPA (pa=) from the admin's UPI QR.
async function startUpiScan() {
  const box = document.getElementById("scanbox");
  box.innerHTML = `<div class="card"><video id="cam" playsinline muted style="width:100%;border-radius:12px;background:#000"></video><p id="scanmsg" class="muted small">Point the camera at your UPI QR…</p><button class="ghost small" id="scancancel">Cancel</button></div>`;
  let stream, raf, stopped = false;
  const stop = () => { stopped = true; if (raf) cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()); box.innerHTML = ""; };
  document.getElementById("scancancel").onclick = stop;
  const scanmsg = () => document.getElementById("scanmsg");
  try { await loadJsQR(); } catch { if (scanmsg()) { scanmsg().className = "err small"; scanmsg().textContent = "Couldn't load the scanner. Enter the UPI ID manually."; } return; }
  const video = document.getElementById("cam");
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); }
  catch { if (scanmsg()) { scanmsg().className = "err small"; scanmsg().textContent = "Camera access denied. Enter the UPI ID manually."; } return; }
  video.srcObject = stream; try { await video.play(); } catch {}
  const canvas = document.createElement("canvas");
  const tick = () => {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
      if (code) {
        const vpa = parseUpiVpa(code.data);
        if (vpa) {
          document.getElementById("upi").value = vpa;
          const nm = parseUpiName(code.data);
          if (nm && !document.getElementById("upiname").value) document.getElementById("upiname").value = nm;
          stop();
          const m = document.getElementById("msg"); if (m) { m.className = "ok"; m.textContent = `Scanned ${vpa} — review and tap Save.`; }
          return;
        } else if (scanmsg()) { scanmsg().className = "err small"; scanmsg().textContent = "That QR isn't a UPI QR — try your payment QR."; }
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
function parseUpiVpa(data) { const m = String(data).match(/[?&]pa=([^&]+)/i); return m ? decodeURIComponent(m[1]) : null; }
function parseUpiName(data) { const m = String(data).match(/[?&]pn=([^&]+)/i); return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : null; }
let _jsqrLoading;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve();
  if (_jsqrLoading) return _jsqrLoading;
  _jsqrLoading = new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/vendor/jsQR.js"; s.onload = () => res(); s.onerror = rej; document.head.appendChild(s); });
  return _jsqrLoading;
}

// Provider slug (for the public catalog read used by the Items tab).
function providerSlug() { const p = state.providers.find((x) => x.id === state.providerId); return p?.slug || ""; }

async function logout() {
  liveDisconnect();
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  state = { phone: "", name: "", providers: [], providerId: null, providerName: "", tier: null, tab: "orders" };
  screenAuth();
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/manager" }).catch(() => {});
boot();
