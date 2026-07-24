// Captain PWA. WhatsApp-only sign-in — a captain texts "login" to the channel
// and taps the reply link (no passwords). Then pick a provider → see the orders
// assigned to you and confirm pickup / delivery.
const el = document.getElementById("app");

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
};

const h = (html) => { el.innerHTML = html; window.scrollTo(0, 0); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s.replace(/_/g, " "))}</span>`;
const CUR = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };
const money = (paise, cur = "INR") =>
  (CUR[cur] || cur + " ") + (Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const paidPill = (o) =>
  o.payment_status === "paid" ? `<span class="paid-pill">✅ Paid</span>`
  : o.payment_status === "failed" ? `<span class="paid-pill fail">❌ Failed</span>` : "";

let state = { phone: "", name: "", providers: [], providerId: null, providerName: "", flow: {}, brand: {}, paymentAfter: null };

// ── Live updates (WebSocket → orders hub) ───────────────────────────────────
let _ws = null, _wsProvider = null, _liveTimer = null;
function liveConnect(provider) {
  if (!provider) return;
  if (_ws && _wsProvider === provider && _ws.readyState <= 1) return; // already connected
  _wsProvider = provider;
  try { if (_ws) _ws.close(); } catch {}
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = (_ws = new WebSocket(`${proto}//${location.host}/api/ws?provider=${encodeURIComponent(provider)}`));
  ws.onmessage = (e) => { try { if (JSON.parse(e.data).type === "orders_changed") liveRefresh(); } catch {} };
  ws.onclose = () => { if (_ws === ws) { _ws = null; setTimeout(() => { if (_wsProvider) liveConnect(_wsProvider); }, 3000); } };
}
function liveDisconnect() { _wsProvider = null; try { if (_ws) _ws.close(); } catch {} _ws = null; }
let _liveHandler = null; // set by the current screen; each guards on its own marker
function liveRefresh() {
  clearTimeout(_liveTimer);
  _liveTimer = setTimeout(() => { if (_liveHandler) _liveHandler(); }, 400);
}

// ── Entry ─────────────────────────────────────────────────────────────────────
async function boot() {
  // The vertical's flow + branding drives terminology, job sections and actions.
  try { const cfg = await api("/api/config"); state.flow = cfg.flow || {}; state.brand = cfg.brand || {}; state.paymentAfter = cfg.flow?.paymentAfter || null; } catch {}
  try {
    const me = await api("/api/captain/me");
    state.phone = me.phone; state.name = me.name || ""; state.providers = me.providers || [];
    goHome();
  } catch {
    screenAuth();
  }
}

function goHome() {
  if (state.providers.length === 1) {
    state.providerId = state.providers[0].id;
    state.providerName = state.providers[0].name;
    screenOrders();
  } else {
    screenProviders();
  }
}

// ── Screen: not signed in → open WhatsApp and send "login" ──────────────────
async function screenAuth() {
  let info = {};
  try { info = await api("/auth/captain/wa-login/info"); } catch {}
  const openBtn = info.waLink
    ? `<a class="btn-link" href="${esc(info.waLink)}" target="_blank" rel="noopener">💬 Open WhatsApp &amp; send “capt”</a>`
    : "";
  const toWhom = info.number ? `+${esc(info.number)}` : "your provider's WhatsApp number";
  const term = state.brand?.agentTerm || "Captain";
  h(`
    <div class="cap-hero"><div class="cap-logo">🧢</div><h1>${esc(term)}</h1><p class="muted">Your assigned jobs</p></div>
    <div class="card">
      <h2 style="margin-top:0">Sign in from WhatsApp</h2>
      <p class="muted small">This app opens from WhatsApp. Send <b>capt</b> and tap the sign-in link we reply with.</p>
      ${openBtn}
      <ol class="steps">
        <li>On WhatsApp, send <b>capt</b> to ${toWhom}.</li>
        <li>You'll get a reply with an <b>Open Captain app</b> button.</li>
        <li>Tap it — you'll be signed in here automatically.</li>
      </ol>
    </div>`);
}

// ── Screen: choose provider ─────────────────────────────────────────────────
function screenProviders() {
  const rows = state.providers.map((p) =>
    `<button class="ghost prov" data-id="${esc(p.id)}" data-name="${esc(p.name)}">
       <span>${esc(p.name)}</span><span class="chev">›</span>
     </button>`).join("");
  h(`
    <div class="topbar"><h1>Choose provider</h1><button class="ghost small" id="logout">Log out</button></div>
    <p class="muted">You're a captain for these providers. Pick one to see its orders.</p>
    <div class="stack">${rows}</div>`);
  document.getElementById("logout").onclick = logout;
  el.querySelectorAll(".prov").forEach((b) => (b.onclick = () => {
    state.providerId = b.dataset.id; state.providerName = b.dataset.name; screenOrders();
  }));
}

// ── Screen: orders for the selected provider ────────────────────────────────
async function screenOrders() {
  liveConnect(state.providerId);
  _liveHandler = () => { if (document.getElementById("capOrdersMarker")) screenOrders(); };
  h(`<div class="topbar"><h1>${esc(state.providerName || "Orders")}</h1></div><p class="muted">Loading jobs…</p>`);
  let data;
  try {
    // A captain can span verticals — resolve THIS provider's flow (sections/labels).
    const fl = await api(`/api/flow?provider=${encodeURIComponent(state.providerId)}`);
    state.flow = fl.flow || {};
    state.paymentAfter = state.flow.paymentAfter || null;
    data = await api(`/api/captain/orders?provider=${encodeURIComponent(state.providerId)}`);
  }
  catch (e) { h(`<div class="card"><p class="err">${esc(e.message || "Could not load orders.")}</p><button id="retry">Retry</button></div>`); document.getElementById("retry").onclick = screenOrders; return; }

  const jobs = data.jobs || [];
  // One section per flow advance step (jobs at that status awaiting this agent's
  // action), then a "Recent" section for everything else.
  const advance = state.flow?.advance || {};
  const done = jobs.filter((j) => !j.action);

  const canSwitch = state.providers.length > 1;
  const section = (title, list, emptyText) => `
    <h2 class="sec">${title} ${list.length ? `<span class="count">${list.length}</span>` : ""}</h2>
    ${list.length ? list.map(card).join("") : `<p class="muted small">${emptyText}</p>`}`;

  const secHtml = Object.keys(advance).map((src) => {
    const list = jobs.filter((j) => j.status === src && j.action);
    return section(esc(advance[src].section || advance[src].label), list, "Nothing waiting.");
  }).join("");

  h(`
    <div class="topbar">
      <h1>${esc(state.providerName || "Orders")}</h1>
      <div class="row grow0" style="gap:6px">
        ${canSwitch ? `<button class="ghost small" id="switch">Switch</button>` : ""}
        <button class="ghost small" id="logout">Log out</button>
      </div>
    </div>
    <div id="capOrdersMarker" hidden></div>
    <div class="row grow0" style="justify-content:flex-end;margin:-2px 0 8px"><button class="ghost small" id="refresh">↻ Refresh</button></div>
    ${secHtml}
    ${done.length ? section("Recent", done, "") : ""}`);

  if (canSwitch) document.getElementById("switch").onclick = screenProviders;
  document.getElementById("logout").onclick = logout;
  document.getElementById("refresh").onclick = screenOrders;
  el.querySelectorAll("[data-open]").forEach((c) => (c.onclick = () => screenOrderDetail(c.dataset.open)));
}

// Compact, tappable order row (details + actions live on the detail page).
function card(j) {
  const count = (j.items || []).reduce((n, i) => n + (i.qty || 0), 0);
  const summary = (j.items || []).map((i) => `${esc(i.name)}×${i.qty}`).join(", ");
  const who = [j.customer_name, j.customer_phone].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="card job tap" data-open="${esc(j.id)}">
      <div class="row" style="align-items:baseline">
        <strong style="flex:1">${esc(j.id)}</strong>
        ${badge(j.status)}
        <span class="chev" style="margin-left:6px">›</span>
      </div>
      ${who ? `<p class="small" style="margin:6px 0 0">👤 ${who}</p>` : ""}
      ${summary ? `<p class="muted small" style="margin:4px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${summary}</p>` : ""}
      <div class="row small" style="margin-top:4px;align-items:baseline">
        <span class="muted" style="flex:1">${count} item${count === 1 ? "" : "s"}</span>
        ${paidPill(j)}
        ${j.total ? `<strong>${money(j.total)}</strong>` : ""}
      </div>
    </div>`;
}

// ── Screen: order detail — contact, items, status action, edit ──────────────
async function screenOrderDetail(orderId) {
  h(`<div class="topbar"><h1>Order</h1><button class="ghost small" id="back">←</button></div><p class="muted">Loading…</p>`);
  document.getElementById("back").onclick = screenOrders;
  let d;
  try { d = await api(`/api/captain/orders/${encodeURIComponent(orderId)}`); }
  catch (e) { h(`<div class="card"><p class="err">${esc(e.message || "Could not load order.")}</p><button id="b">← Back</button></div>`); document.getElementById("b").onclick = screenOrders; return; }

  const o = d.order;
  const items = (o.items || []).map((i) => `<li>${esc(i.name)} × ${i.qty}${i.unit_price ? ` <span class="muted">— ${money(i.qty * i.unit_price)}</span>` : ""}</li>`).join("");
  const custCall = o.customer_phone ? `<a href="tel:${esc(o.customer_phone)}">📞 ${esc(o.customer_name || o.customer_phone)}</a>` : (o.customer_name ? esc(o.customer_name) : "");
  // Show the on-site contact only when it differs from the customer.
  const contactDiffers = (o.contact_phone && o.contact_phone !== o.customer_phone) || (o.contact_name && o.contact_name !== o.customer_name);
  const pickupContact = contactDiffers && (o.contact_name || o.contact_phone)
    ? `<p class="muted small" style="margin:6px 0 0">On-site contact: ${esc(o.contact_name || "")}${o.contact_phone ? ` · ${esc(o.contact_phone)}` : ""}</p>` : "";
  const mapLink = o.lat != null ? `<a href="https://www.google.com/maps?q=${o.lat},${o.lng}" target="_blank" rel="noopener">📍 Navigate</a>` : "";

  const paymentAfter = d.paymentAfter || state.paymentAfter;
  let actionCard = "";
  if (d.action) {
    actionCard = `<div class="card"><button id="act">${esc(d.action.label)}</button><p id="msg"></p></div>`;
  } else if (o.status === paymentAfter) {
    actionCard = `<div class="card"><button id="paybtn">💳 Show payment QR</button></div>`;
  } else {
    actionCard = `<div class="card"><p class="muted">No action for you on this order right now.</p></div>`;
  }

  h(`
    <div class="topbar"><h1>${esc(o.id)}</h1><button class="ghost small" id="back">←</button></div>
    <div class="card">
      ${badge(o.status)}
      ${custCall ? `<p style="margin:10px 0 2px">👤 ${custCall}</p>` : ""}
      ${o.address ? `<p class="muted small" style="margin:6px 0 4px">${esc(o.address)}</p>` : ""}
      <div class="row small" style="gap:16px;flex-wrap:wrap">${[mapLink].filter(Boolean).join("")}</div>
      ${pickupContact}
    </div>
    <div class="card">
      <div class="row" style="align-items:baseline;margin-bottom:4px">
        <h2 style="margin:0;flex:1">Items</h2>
        ${d.editable ? `<button class="ghost small grow0" id="edit">✏️ Edit</button>` : ""}
      </div>
      <ul>${items || '<li class="muted">No items</li>'}</ul>
      <div class="row" style="align-items:baseline"><strong style="flex:1">Total</strong><strong style="font-size:17px">${money(o.total)}</strong></div>
    </div>
    ${actionCard}`);
  document.getElementById("back").onclick = screenOrders;
  const edit = document.getElementById("edit");
  if (edit) edit.onclick = () => screenEditItems(orderId);
  const act = document.getElementById("act");
  if (act) act.onclick = () => confirmAction(orderId, d.action, act, document.getElementById("msg"));
  const paybtn = document.getElementById("paybtn");
  if (paybtn) paybtn.onclick = () => paymentScreen(orderId);
}

async function confirmAction(orderId, action, btn, msg) {
  if (!confirm(`${action.label}? The customer will be notified.`)) return;
  if (msg) { msg.textContent = ""; msg.className = ""; }
  btn.disabled = true; btn.textContent = "Confirming…";
  try {
    const r = await api(`/api/captain/orders/${encodeURIComponent(orderId)}/advance`, { method: "POST", body: { to: action.to } });
    // When this step reaches the pay-after status, show the UPI QR so the customer can pay.
    if (action.paymentDue || r.paymentDue) paymentScreen(orderId);
    else screenOrders();
  } catch (e) {
    if (msg) { msg.className = "err"; msg.textContent = e.message === "forbidden" ? "This job is no longer available." : (e.message || "Could not update."); }
    btn.disabled = false; btn.textContent = action.label;
  }
}

// ── Screen: UPI payment QR (after delivery) — goes live when payment lands ───
async function paymentScreen(orderId) {
  h(`<div class="topbar"><h1>Payment</h1><button class="ghost small" id="back">←</button></div><p class="muted">Loading…</p>`);
  document.getElementById("back").onclick = screenOrders;
  let d;
  try { d = await api(`/api/captain/orders/${encodeURIComponent(orderId)}/payment`); }
  catch (e) { h(`<div class="card"><p class="err">${esc(e.message || "Could not load payment.")}</p><button id="b">← Back</button></div>`); document.getElementById("b").onclick = screenOrders; return; }
  renderPayment(orderId, d);
  // When the payment email reconciles the order, the hub broadcasts → re-check.
  _liveHandler = () => { if (document.getElementById("capPayMarker")) refreshPayment(orderId); };
}
async function refreshPayment(orderId) {
  try { renderPayment(orderId, await api(`/api/captain/orders/${encodeURIComponent(orderId)}/payment`)); } catch {}
}
function renderPayment(orderId, d) {
  if (d.payment_status === "paid") {
    h(`<div class="topbar"><h1>Paid ✅</h1><button class="ghost small" id="back">←</button></div>
       <div id="capPayMarker" hidden></div>
       <div class="card" style="text-align:center">
         <div style="font-size:52px;line-height:1">✅</div>
         <h2 style="margin:6px 0 2px">Payment received</h2>
         <div style="font-size:26px;font-weight:800">₹${esc(d.payment_amount ? (d.payment_amount / 100).toFixed(0) : d.amount || "")}</div>
         ${d.payment_payer ? `<p class="muted small" style="margin:4px 0 0">from ${esc(d.payment_payer)}</p>` : ""}
         <p class="muted small" style="margin:2px 0 0">Order ${esc(orderId)}</p>
       </div>
       <button id="done">Done</button>`);
  } else if (!d.hasUpi) {
    h(`<div class="topbar"><h1>Job done ✓</h1><button class="ghost small" id="back">←</button></div>
       <div id="capPayMarker" hidden></div>
       <div class="card"><p>Order <strong>${esc(orderId)}</strong> completed.</p><p class="muted">No UPI set up for this provider.</p></div>
       <button id="cash">💵 Received cash</button>
       <button id="done" class="ghost" style="margin-top:8px">Done</button>`);
  } else {
    h(`<div class="topbar"><h1>Collect payment</h1><button class="ghost small" id="back">←</button></div>
       <div id="capPayMarker" hidden></div>
       <div class="card" style="text-align:center">
         <p class="muted small" style="margin:0 0 4px">Order ${esc(orderId)} · ask the customer to scan &amp; pay</p>
         <div style="font-size:26px;font-weight:800;font-family:var(--serif,inherit)">₹${esc(d.amount)}</div>
         <div class="qrwrap">${d.svg}</div>
         <p class="muted small" style="margin:6px 0 0">${esc(d.upi_name)} · ${esc(d.upi_id)}</p>
         ${d.payment_status === "failed" ? `<p class="err small" style="margin:6px 0 0">Last attempt failed — ask them to retry.</p>` : `<p class="muted small" style="margin:6px 0 0">⏳ Waiting for payment… updates automatically.</p>`}
       </div>
       <button id="cash" class="ghost">💵 Received cash instead</button>
       <button id="done" class="ghost" style="margin-top:8px">Done</button>`);
  }
  document.getElementById("back").onclick = screenOrders;
  document.getElementById("done").onclick = screenOrders;
  const cashBtn = document.getElementById("cash");
  if (cashBtn) cashBtn.onclick = async () => {
    if (!confirm("Mark this order as paid in cash?")) return;
    cashBtn.disabled = true; cashBtn.textContent = "Saving…";
    try { await api(`/api/captain/orders/${encodeURIComponent(orderId)}/cash`, { method: "POST" }); refreshPayment(orderId); }
    catch (e) { cashBtn.disabled = false; cashBtn.textContent = "💵 Received cash"; alert(e.message || "Could not save."); }
  };
}

// ── Screen: edit items — category-grouped picker (pickup captain, pre-pickup) ─
async function screenEditItems(orderId) {
  h(`<div class="topbar"><h1>Edit items</h1><button class="ghost small" id="back">←</button></div><p class="muted">Loading…</p>`);
  let d;
  try { d = await api(`/api/captain/orders/${encodeURIComponent(orderId)}`); }
  catch (e) { h(`<div class="card"><p class="err">${esc(e.message || "Could not load order.")}</p><button id="b">← Back</button></div>`); document.getElementById("b").onclick = () => screenOrderDetail(orderId); return; }

  if (!d.editable) {
    h(`<div class="topbar"><h1>${esc(d.order.id)}</h1><button class="ghost small" id="back">←</button></div>
       <div class="card"><p class="muted">Items are locked once the order is picked up.</p>
       <ul>${(d.order.items || []).map((i) => `<li>${esc(i.name)} × ${i.qty}</li>`).join("")}</ul></div>`);
    document.getElementById("back").onclick = () => screenOrderDetail(orderId);
    return;
  }

  const catalog = d.catalog || [];
  const startQty = {};
  for (const it of d.order.items || []) startQty[it.name.toLowerCase()] = it.qty;

  // Catalog grouped by category (mirrors the customer order form).
  const groups = {};
  catalog.forEach((ci) => { const g = ci.category || "Other"; (groups[g] = groups[g] || []).push(ci); });
  const catKeys = Object.keys(groups).sort();
  const pickerHtml = catKeys.map((g) =>
    `<div class="pick-cat">${esc(g)}</div>` +
    groups[g].map((ci) => {
      const q = startQty[ci.name.toLowerCase()] || 0;
      return `<div class="pick-row${q > 0 ? " picked" : ""}" data-name="${esc(ci.name)}" data-cat="${esc(g)}" data-price="${ci.price || 0}">
        <div class="pick-info"><strong>${esc(ci.name)}</strong><br><span class="muted">${money(ci.price || 0)} · ${esc(ci.unit || "")}</span></div>
        <div class="qtyctrl"><button type="button" class="qbtn qminus">−</button><input class="qnum" type="number" min="0" value="${q}" inputmode="numeric" /><button type="button" class="qbtn qplus">+</button></div>
      </div>`;
    }).join("")
  ).join("");
  const chipsHtml = catKeys.length > 1
    ? `<div class="chips" id="itemchips"><button type="button" class="chip active" data-c="__all__">All</button>` +
      catKeys.map((g) => `<button type="button" class="chip" data-c="${esc(g)}">${esc(g)}</button>`).join("") + `</div>`
    : "";

  h(`
    <div class="topbar"><h1>Edit items</h1><button class="ghost small" id="back">←</button></div>
    <div class="card">
      <p class="muted small">Adjust to what you actually collected. Set a count to 0 to remove.</p>
      <input id="itemsearch" placeholder="Search items…" style="margin-bottom:8px" />
      ${chipsHtml}
      <div id="picker">${pickerHtml || '<p class="muted">No items available.</p>'}</div>
      <div id="summary" class="summary"></div>
      <div class="row" style="margin-top:12px;align-items:baseline"><strong style="flex:1">Total</strong><strong id="total" style="font-size:17px">${money(0)}</strong></div>
      <button id="save" style="margin-top:12px">Save items</button>
      <p id="msg"></p>
    </div>`);
  document.getElementById("back").onclick = () => screenOrderDetail(orderId);

  const picker = document.getElementById("picker");
  const recalc = () => {
    let sum = 0; const selected = [];
    picker.querySelectorAll(".pick-row").forEach((r) => {
      const price = parseInt(r.dataset.price || "0", 10);
      const qty = Math.max(0, parseInt(r.querySelector(".qnum").value, 10) || 0);
      if (qty > 0) selected.push({ name: r.dataset.name, cat: r.dataset.cat, qty, price });
      sum += price * qty;
    });
    document.getElementById("total").textContent = money(sum);
    const box = document.getElementById("summary");
    if (!selected.length) { box.innerHTML = ""; return; }
    const g = {};
    selected.forEach((s) => (g[s.cat] = g[s.cat] || []).push(s));
    box.innerHTML = `<div class="summary-head">Selected items</div>` +
      Object.keys(g).sort().map((cat) =>
        `<div class="summary-cat">${esc(cat)}</div>` +
        g[cat].map((s) => `<div class="summary-line"><span>${esc(s.name)} × ${s.qty}</span><span class="amt">${money(s.price * s.qty)}</span></div>`).join("")
      ).join("");
  };
  picker.querySelectorAll(".pick-row").forEach((r) => {
    const num = r.querySelector(".qnum");
    const mark = () => r.classList.toggle("picked", (parseInt(num.value, 10) || 0) > 0);
    r.querySelector(".qplus").onclick = () => { num.value = (parseInt(num.value, 10) || 0) + 1; mark(); recalc(); };
    r.querySelector(".qminus").onclick = () => { num.value = Math.max(0, (parseInt(num.value, 10) || 0) - 1); mark(); recalc(); };
    num.oninput = () => { mark(); recalc(); };
  });
  const itemsearch = document.getElementById("itemsearch");
  let activeCat = "__all__";
  const applyFilter = () => {
    const q = itemsearch.value.trim().toLowerCase();
    picker.querySelectorAll(".pick-row").forEach((r) => {
      const catOk = activeCat === "__all__" || r.dataset.cat === activeCat;
      const nameOk = !q || r.dataset.name.toLowerCase().includes(q);
      r.style.display = catOk && nameOk ? "" : "none";
    });
    picker.querySelectorAll(".pick-cat").forEach((hd) => {
      let sib = hd.nextElementSibling, any = false;
      while (sib && sib.classList.contains("pick-row")) { if (sib.style.display !== "none") any = true; sib = sib.nextElementSibling; }
      hd.style.display = any ? "" : "none";
    });
  };
  itemsearch.oninput = applyFilter;
  document.querySelectorAll("#itemchips .chip").forEach((ch) => {
    ch.onclick = () => { activeCat = ch.dataset.c; document.querySelectorAll("#itemchips .chip").forEach((x) => x.classList.toggle("active", x === ch)); applyFilter(); };
  });
  recalc();

  document.getElementById("save").onclick = async (ev) => {
    const btn = ev.currentTarget, msg = document.getElementById("msg");
    const items = [...picker.querySelectorAll(".pick-row")]
      .map((r) => ({ name: r.dataset.name, qty: Math.max(0, parseInt(r.querySelector(".qnum").value, 10) || 0) }))
      .filter((x) => x.qty > 0);
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await api(`/api/captain/orders/${encodeURIComponent(orderId)}/items`, { method: "PATCH", body: { items } });
      screenOrderDetail(orderId);
    } catch (e) {
      msg.className = "err"; msg.textContent = e.message === "locked" ? "Items are locked — order already picked up." : (e.message || "Could not save.");
      btn.disabled = false; btn.textContent = "Save items";
    }
  };
}

async function logout() {
  liveDisconnect();
  try { await api("/auth/logout", { method: "POST" }); } catch {}
  state = { phone: "", name: "", providers: [], providerId: null, providerName: "" };
  screenAuth();
}

// PWA service worker (scoped to /captain).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/captain" }).catch(() => {});
}

boot();
