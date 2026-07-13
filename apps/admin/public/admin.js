// Super-admin control-plane console. Log in → manage the town fleet: register
// towns, then drill into any town and control its verticals/providers/settings
// (proxied through the admin worker into each town's control API).
const el = document.getElementById("app");
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
};
const h = (html) => { el.innerHTML = html; window.scrollTo(0, 0); };
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (p) => "₹" + (Number(p || 0) / 100).toLocaleString("en-IN");

async function boot() {
  let me;
  try { me = await api("/api/me"); } catch { me = { authenticated: false }; }
  if (!me.authenticated) return screenLogin();
  townsList();
}

function screenLogin() {
  h(`<div class="topbar"><h1>Control Plane</h1></div>
     <div class="card" style="max-width:380px">
       <h2 style="margin-top:0">Super-admin sign in</h2>
       <label>Email</label><input id="email" type="email" />
       <label style="margin-top:8px">Password</label><input id="pw" type="password" />
       <button id="go" style="margin-top:14px">Sign in</button><p id="msg" class="err"></p>
     </div>`);
  document.getElementById("go").onclick = async () => {
    const msg = document.getElementById("msg"); msg.textContent = "";
    try { await api("/auth/login", { method: "POST", body: { email: document.getElementById("email").value, password: document.getElementById("pw").value } }); townsList(); }
    catch (e) { msg.textContent = e.message === "invalid_credentials" ? "Wrong email or password." : (e.message || "Sign in failed."); }
  };
}

async function townsList() {
  h(`<div class="topbar"><h1>Towns</h1><div class="row grow0" style="gap:6px"><button class="small" id="add">+ Town</button><button class="ghost small" id="out">Log out</button></div></div>
     <div id="list"><p class="muted">Loading…</p></div>`);
  document.getElementById("out").onclick = async () => { await api("/auth/logout", { method: "POST" }); screenLogin(); };
  document.getElementById("add").onclick = addTownForm;
  let towns = [];
  try { towns = (await api("/api/towns")).towns || []; } catch (e) { document.getElementById("list").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  document.getElementById("list").innerHTML = towns.length
    ? towns.map((t) => `<div class="card job tap" data-id="${esc(t.id)}">
        <div class="row" style="align-items:baseline"><strong style="flex:1">${esc(t.name)}</strong><span class="badge ${t.status === "active" ? "ACCEPTED" : "REJECTED"}">${esc(t.status)}</span><span class="chev" style="margin-left:6px">›</span></div>
        <p class="muted small" style="margin:6px 0 0">${esc(t.url)}${t.wa_number ? " · 📱 " + esc(t.wa_number) : ""}${t.cf_account ? " · ☁️ " + esc(t.cf_account) : ""}</p></div>`).join("")
    : `<p class="muted">No towns yet. Add one to point the control plane at a deployed town Worker.</p>`;
  el.querySelectorAll("[data-id]").forEach((n) => (n.onclick = () => townDetail(n.dataset.id)));
}

function addTownForm() {
  h(`<div class="topbar"><h1>Add town</h1><button class="ghost small" id="back">←</button></div>
     <div class="card">
       <p class="muted small">Register a deployed town Worker so the control plane can manage it.</p>
       <label>Name</label><input id="name" placeholder="Hyderabad" />
       <label style="margin-top:8px">Slug</label><input id="slug" placeholder="hyderabad" />
       <label style="margin-top:8px">Base URL</label><input id="url" placeholder="https://demo.manasanta.in" />
       <label style="margin-top:8px">Control token</label><input id="tok" placeholder="the town's CONTROL_TOKEN" />
       <label style="margin-top:8px">WhatsApp number (optional)</label><input id="wa" placeholder="9198…" />
       <label style="margin-top:8px">CF account label (optional)</label><input id="cf" placeholder="ramarao.satti@gmail.com" />
       <button id="save" style="margin-top:14px">Add town</button><p id="msg" class="err"></p>
     </div>`);
  document.getElementById("back").onclick = townsList;
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg"); msg.textContent = "";
    const body = { name: v("name"), slug: v("slug"), url: v("url"), control_token: v("tok"), wa_number: v("wa"), cf_account: v("cf") };
    try { await api("/api/towns", { method: "POST", body }); townsList(); }
    catch (e) { msg.textContent = e.message + (e.data?.need ? " — need: " + e.data.need : ""); }
  };
}
const v = (id) => document.getElementById(id).value.trim();

async function townDetail(id) {
  h(`<div class="topbar"><h1>Town</h1><button class="ghost small" id="back">←</button></div><p class="muted">Connecting…</p>`);
  document.getElementById("back").onclick = townsList;
  let ping;
  try { ping = await api(`/api/towns/${encodeURIComponent(id)}/ping`); }
  catch (e) { h(`<div class="card"><p class="err">${esc(e.message)}</p></div>`); return; }
  if (!ping.ok) {
    h(`<div class="topbar"><h1>Town</h1><button class="ghost small" id="back">←</button></div>
       <div class="card"><p class="err">Can't reach this town's control API (status ${ping.status || "?"}). Check the URL + control token.</p>
       <button class="ghost small" id="del">Remove town</button></div>`);
    document.getElementById("back").onclick = townsList;
    document.getElementById("del").onclick = async () => { if (confirm("Remove this town from the registry?")) { await api(`/api/towns/${id}`, { method: "DELETE" }); townsList(); } };
    return;
  }
  const s = ping.summary || {};
  const [provs, verts] = await Promise.all([
    api(`/api/towns/${id}/providers`).catch(() => ({ providers: [] })),
    api(`/api/towns/${id}/verticals`).catch(() => ({ verticals: [] })),
  ]);
  const orderTiles = Object.entries(s.orders || {}).map(([k, n]) => `<span class="badge ${esc(k)}">${esc(k.replace(/_/g, " "))} ${n}</span>`).join(" ") || `<span class="muted small">no orders</span>`;
  h(`
    <div class="topbar"><h1>${esc(s.town || "Town")}</h1><button class="ghost small" id="back">←</button></div>
    <div class="card"><div class="row small"><span class="muted" style="flex:1">Providers: <b>${s.providers ?? 0}</b> · Verticals: <b>${(s.verticals || []).length}</b></span></div>
      <div style="margin-top:8px">${orderTiles}</div></div>

    <div class="card">
      <div class="row" style="align-items:baseline"><h2 style="margin:0;flex:1">Verticals</h2><button class="ghost small grow0" id="addv">+ Vertical</button></div>
      ${(verts.verticals || []).map((x) => `<div class="order-line"><div><strong>${esc(x.emoji || "")} ${esc(x.name)}</strong> <span class="muted">${esc(x.slug)}</span></div><span class="badge ${x.active ? "ACCEPTED" : "REJECTED"}">${x.active ? "on" : "off"}</span></div>`).join("") || '<p class="muted small">None.</p>'}
    </div>

    <div class="card">
      <div class="row" style="align-items:baseline"><h2 style="margin:0;flex:1">Providers</h2><button class="ghost small grow0" id="addp">+ Provider</button></div>
      ${(provs.providers || []).map((p) => `<div class="order-line"><div><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.vertical || "—")}</span><br><span class="muted small">${esc(p.slug)}${p.upi_id ? " · " + esc(p.upi_id) : ""}</span></div></div>`).join("") || '<p class="muted small">None.</p>'}
    </div>

    <div class="card"><button class="ghost small" id="settings">⚙️ Settings</button> <button class="ghost small" id="del">Remove town</button></div>`);
  document.getElementById("back").onclick = townsList;
  document.getElementById("addv").onclick = () => addVertical(id);
  document.getElementById("addp").onclick = () => addProvider(id);
  document.getElementById("settings").onclick = () => townSettings(id);
  document.getElementById("del").onclick = async () => { if (confirm("Remove this town from the registry? (The town Worker itself keeps running.)")) { await api(`/api/towns/${id}`, { method: "DELETE" }); townsList(); } };
}

async function addVertical(id) {
  let flows = [];
  try { flows = (await api(`/api/towns/${id}/flows`)).flows || []; } catch {}
  h(`<div class="topbar"><h1>Add vertical</h1><button class="ghost small" id="back">←</button></div>
     <div class="card"><p class="muted small">Enable a service category in this town. The slug must match a flow shape in the build.</p>
       <label>Flow / slug</label><select id="slug">${flows.map((f) => `<option value="${esc(f.key)}">${esc(f.key)} · ${esc(f.agentTerm)}</option>`).join("")}</select>
       <label style="margin-top:8px">Name</label><input id="name" placeholder="Laundry" />
       <label style="margin-top:8px">Emoji</label><input id="emoji" placeholder="🧺" />
       <label style="margin-top:8px">Sort</label><input id="sort" type="number" value="0" />
       <button id="save" style="margin-top:14px">Save vertical</button><p id="msg" class="err"></p></div>`);
  document.getElementById("back").onclick = () => townDetail(id);
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg"); msg.textContent = "";
    try { await api(`/api/towns/${id}/verticals`, { method: "POST", body: { slug: v("slug"), name: v("name"), emoji: v("emoji"), sort: parseInt(v("sort"), 10) || 0 } }); townDetail(id); }
    catch (e) { msg.textContent = e.data?.detail || e.message; }
  };
}

async function addProvider(id) {
  let verts = [];
  try { verts = (await api(`/api/towns/${id}/verticals`)).verticals || []; } catch {}
  h(`<div class="topbar"><h1>Add provider</h1><button class="ghost small" id="back">←</button></div>
     <div class="card"><p class="muted small">Add a shop under a vertical in this town.</p>
       <label>Vertical</label><select id="vertical">${verts.map((x) => `<option value="${esc(x.slug)}">${esc(x.name)}</option>`).join("")}</select>
       <label style="margin-top:8px">Name</label><input id="name" placeholder="Sparkle Dhobi" />
       <label style="margin-top:8px">Slug</label><input id="slug" placeholder="sparkle-dhobi" />
       <label style="margin-top:8px">UPI ID (optional)</label><input id="upi" placeholder="shop@upi" />
       <button id="save" style="margin-top:14px">Add provider</button><p id="msg" class="err"></p></div>`);
  document.getElementById("back").onclick = () => townDetail(id);
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg"); msg.textContent = "";
    try { await api(`/api/towns/${id}/providers`, { method: "POST", body: { slug: v("slug"), name: v("name"), vertical: v("vertical"), upi_id: v("upi") } }); townDetail(id); }
    catch (e) { msg.textContent = e.data?.detail || e.message; }
  };
}

async function townSettings(id) {
  h(`<div class="topbar"><h1>Settings</h1><button class="ghost small" id="back">←</button></div><p class="muted">Loading…</p>`);
  document.getElementById("back").onclick = () => townDetail(id);
  let s = {};
  try { s = await api(`/api/towns/${id}/settings`); } catch (e) { h(`<div class="card"><p class="err">${esc(e.message)}</p></div>`); return; }
  h(`<div class="topbar"><h1>Settings</h1><button class="ghost small" id="back">←</button></div>
     <div class="card"><p class="muted small">WhatsApp / maps / payment-email config for this town (secrets shown only as set/unset).</p>
       <div class="order-line"><span>WhatsApp token</span><span class="badge ${s.token_set ? "ACCEPTED" : "REJECTED"}">${s.token_set ? "set" : "unset"}</span></div>
       <div class="order-line"><span>App secret</span><span class="badge ${s.app_secret_set ? "ACCEPTED" : "REJECTED"}">${s.app_secret_set ? "set" : "unset"}</span></div>
       <div class="order-line"><span>Verify token</span><span class="muted">${esc(s.verify_token || "—")}</span></div>
       <div class="order-line"><span>Maps key</span><span class="badge ${s.maps_set ? "ACCEPTED" : "REJECTED"}">${s.maps_set ? "set" : "unset"}</span></div>
       <div class="order-line"><span>Groq key</span><span class="badge ${s.groq_set ? "ACCEPTED" : "REJECTED"}">${s.groq_set ? "set" : "unset"}</span></div>
       <div class="order-line"><span>WA display number</span><span class="muted">${esc(s.wa_display_number || "—")}</span></div>
       <label style="margin-top:12px">Set WhatsApp display number</label><input id="wadn" value="${esc(s.wa_display_number || "")}" />
       <button id="save" style="margin-top:10px">Save</button><p id="msg" class="err"></p></div>`);
  document.getElementById("back").onclick = () => townDetail(id);
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg"); msg.textContent = "";
    try { await api(`/api/towns/${id}/settings`, { method: "POST", body: { wa_display_number: v("wadn") } }); msg.className = ""; msg.textContent = "Saved ✓"; }
    catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
}

boot();
