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
  h(`<div class="topbar"><h1>Towns</h1><div class="row grow0" style="gap:6px"><button class="small" id="dep">⚡ Deploy</button><button class="ghost small" id="add">+ Register</button><button class="ghost small" id="pw">🔑</button><button class="ghost small" id="out">Log out</button></div></div>
     <div id="list"><p class="muted">Loading…</p></div>`);
  document.getElementById("out").onclick = async () => { await api("/auth/logout", { method: "POST" }); screenLogin(); };
  document.getElementById("add").onclick = addTownForm;
  document.getElementById("dep").onclick = deployFlow;
  document.getElementById("pw").onclick = screenPassword;
  let towns = [];
  try { towns = (await api("/api/towns")).towns || []; } catch (e) { document.getElementById("list").innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  document.getElementById("list").innerHTML = towns.length
    ? towns.map((t) => `<div class="card job tap" data-id="${esc(t.id)}">
        <div class="row" style="align-items:baseline"><strong style="flex:1">${esc(t.name)}</strong><span class="badge ${t.status === "active" ? "ACCEPTED" : "REJECTED"}">${esc(t.status)}</span><span class="chev" style="margin-left:6px">›</span></div>
        <p class="muted small" style="margin:6px 0 0">${esc(t.url)}${t.wa_number ? " · 📱 " + esc(t.wa_number) : ""}${t.cf_account ? " · ☁️ " + esc(t.cf_account) : ""}</p></div>`).join("")
    : `<p class="muted">No towns yet. Add one to point the control plane at a deployed town Worker.</p>`;
  el.querySelectorAll("[data-id]").forEach((n) => (n.onclick = () => townDetail(n.dataset.id)));
}

function screenPassword() {
  h(`<div class="topbar"><h1>Change password</h1><button class="ghost small" id="back">←</button></div>
     <div class="card" style="max-width:420px">
       <p class="muted small">Update the super-admin password for this control plane.</p>
       <label>Current password</label><input id="cur" type="password" />
       <label style="margin-top:8px">New password (min 8 chars)</label><input id="np" type="password" />
       <label style="margin-top:8px">Confirm new password</label><input id="np2" type="password" />
       <button id="save" style="margin-top:14px">Change password</button><p id="msg"></p>
     </div>`);
  document.getElementById("back").onclick = townsList;
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg");
    const cur = v("cur"), np = v("np"), np2 = v("np2");
    if (np.length < 8) { msg.className = "err"; msg.textContent = "New password must be at least 8 characters."; return; }
    if (np !== np2) { msg.className = "err"; msg.textContent = "New passwords don't match."; return; }
    try {
      await api("/api/account/password", { method: "POST", body: { current: cur, next: np } });
      msg.className = "small"; msg.textContent = "Password changed ✓";
    } catch (e) {
      msg.className = "err";
      msg.textContent = e.message === "wrong_current_password" ? "Current password is incorrect." : (e.data?.detail || e.message);
    }
  };
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
const slugify = (s) => String(s || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
// Cloudflare "Create Token" deep-link pre-filled with exactly the perms a town deploy needs.
function cfTokenLink(accountId) {
  const perms = [
    { key: "d1", type: "edit" },              // Account · D1
    { key: "workers_scripts", type: "edit" }, // Account · Workers Scripts
    { key: "workers_routes", type: "edit" },  // Zone · Workers Routes
    { key: "dns_records", type: "edit" },      // Zone · DNS (custom domain)
  ];
  const p = new URLSearchParams();
  p.set("permissionGroupKeys", JSON.stringify(perms));
  p.set("name", "Manasanta Town Deploy");
  if (accountId) p.set("accountId", accountId);
  return "https://dash.cloudflare.com/profile/api-tokens/create?" + p.toString();
}

// ── Deploy a new town Worker onto a Cloudflare account ───────────────────────
async function deployFlow() {
  h(`<div class="topbar"><h1>Deploy town</h1><button class="ghost small" id="back">←</button></div><div id="body"><p class="muted">Loading…</p></div>`);
  document.getElementById("back").onclick = townsList;
  let targets = [];
  try { targets = (await api("/api/targets")).targets || []; } catch {}
  const opts = targets.map((t) => `<option value="${esc(t.id)}">${esc(t.label)} · ${esc(t.cf_account_id)}</option>`).join("");
  document.getElementById("body").innerHTML = `
    <div class="card">
      <div class="row" style="align-items:baseline"><h2 style="margin:0;flex:1">Cloudflare accounts</h2><button class="ghost small grow0" id="addt">+ Account</button></div>
      ${targets.length ? targets.map((t) => `<div class="order-line"><div><strong>${esc(t.label)}</strong> <span class="test-res small" data-for="${esc(t.id)}"></span><br><span class="muted small">${esc(t.cf_account_id)}${t.zone_id ? " · zone " + esc(t.zone_id) : ""}</span></div><div class="row grow0" style="gap:6px"><button class="ghost small testt" data-id="${esc(t.id)}">Test</button><button class="ghost small delt" data-id="${esc(t.id)}">✕</button></div></div>`).join("") : '<p class="muted small">No accounts yet. Add one (with a scoped CF API token) to deploy onto.</p>'}
    </div>
    <div class="card">
      <h2 style="margin-top:0">New town</h2>
      <label>Deploy to account</label><select id="target">${opts || '<option value="">— add an account first —</option>'}</select>
      <label style="margin-top:8px">Name</label><input id="name" placeholder="Bangalore" />
      <label style="margin-top:8px">Slug</label><input id="slug" placeholder="bangalore" />
      <label style="margin-top:8px">Domain</label><input id="domain" placeholder="bangalore.manasanta.in" />
      <label style="margin-top:8px">WhatsApp number (optional)</label><input id="wa" placeholder="9188…" />
      <div class="row" style="margin-top:12px;gap:8px"><button class="ghost grow0" id="plan">Preview plan</button><button class="grow0" id="go">Deploy for real</button></div>
      <pre id="out" class="muted small" style="white-space:pre-wrap;margin-top:10px"></pre>
    </div>`;
  document.getElementById("addt").onclick = addTargetForm;
  el.querySelectorAll(".delt").forEach((b) => (b.onclick = async () => { if (confirm("Remove this account + its token?")) { await api(`/api/targets/${b.dataset.id}`, { method: "DELETE" }); deployFlow(); } }));
  el.querySelectorAll(".testt").forEach((b) => (b.onclick = async () => {
    const out = el.querySelector(`.test-res[data-for="${b.dataset.id}"]`);
    out.className = "test-res small muted"; out.textContent = "testing…"; b.disabled = true;
    try {
      const r = await api(`/api/targets/${b.dataset.id}/test`);
      out.className = "test-res small";
      out.innerHTML = r.checks.map((ch) => `${ch.ok ? "✅" : "❌"} ${esc(ch.name)}`).join("  ") +
        (r.ok ? "" : ` <span class="err">— ${esc((r.checks.find((ch) => !ch.ok) || {}).detail || "check token perms")}</span>`);
    } catch (e) { out.className = "test-res small err"; out.textContent = e.message; }
    b.disabled = false;
  }));
  // Auto-slugify: derive the slug from the name until the user edits it directly.
  const nameI = document.getElementById("name"), slugI = document.getElementById("slug");
  let slugTouched = false;
  nameI.oninput = () => { if (!slugTouched) slugI.value = slugify(nameI.value); };
  slugI.oninput = () => { slugTouched = true; };
  slugI.onblur = () => { slugI.value = slugify(slugI.value); };
  const spec = () => ({ name: v("name"), slug: slugify(v("slug")), domain: v("domain"), wa_number: v("wa") });
  const run = async (dryRun) => {
    const out = document.getElementById("out"); out.className = "muted small"; out.textContent = dryRun ? "Planning…" : "Deploying… (creates real resources)";
    try {
      const r = await api("/api/deploy", { method: "POST", body: { targetId: v("target"), spec: spec(), dryRun } });
      if (r.dryRun) out.textContent = `Plan for ${r.worker} (${r.domain}):\n` + r.plan.map((p, i) => `${i + 1}. [${p.method}] ${p.title}${p.note ? " → " + p.note : ""}`).join("\n");
      else {
        out.className = "small";
        out.textContent = `✓ Deployed ${r.worker} → ${r.url || "https://" + r.domain}` + (r.warning ? `\n⚠️ ${r.warning}` : "");
        setTimeout(townsList, r.warning ? 5000 : 1500);
      }
    } catch (e) { out.className = "err small"; out.textContent = (e.data?.detail || e.message); }
  };
  document.getElementById("plan").onclick = () => run(true);
  document.getElementById("go").onclick = () => { if (confirm("Deploy for real? This creates a Worker + D1 + domain on the selected Cloudflare account.")) run(false); };
}

function addTargetForm() {
  h(`<div class="topbar"><h1>Add CF account</h1><button class="ghost small" id="back">←</button></div>
     <div class="card"><p class="muted small">A scoped Cloudflare API token for the account towns deploy onto. Stored server-side; never shown again.</p>
       <label>Label</label><input id="label" placeholder="ramarao.satti@gmail.com" />
       <label style="margin-top:8px">Account ID</label><input id="acct" />
       <label style="margin-top:8px">API token</label><input id="tok" type="password" />
       <p class="small" style="margin:8px 0 0">🔗 <a href="#" id="mktoken">Create a token with the right permissions →</a> <span class="muted">(D1 · Workers Scripts · Workers Routes · DNS — all Edit)</span></p>
       <p class="muted small" style="margin:2px 0 0">Opens Cloudflare pre-filled. Then set <b>Zone Resources → manasanta.in</b>, create it, and paste it above.</p>
       <label style="margin-top:8px">Zone ID (for custom domains) — from your zone's Overview page</label><input id="zone" placeholder="32-char hex zone id" />
       <button id="save" style="margin-top:14px">Add account</button><p id="msg" class="err"></p></div>`);
  document.getElementById("back").onclick = deployFlow;
  document.getElementById("mktoken").onclick = (e) => { e.preventDefault(); window.open(cfTokenLink(v("acct")), "_blank", "noopener"); };
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg"); msg.textContent = "";
    try { await api("/api/targets", { method: "POST", body: { label: v("label"), cf_account_id: v("acct"), cf_api_token: v("tok"), zone_id: v("zone") } }); deployFlow(); }
    catch (e) { msg.textContent = e.message + (e.data?.need ? " — need: " + e.data.need : ""); }
  };
}

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
      ${(verts.verticals || []).map((x) => `<div class="order-line tap" data-vslug="${esc(x.slug)}"><div><strong>${esc(x.emoji || "")} ${esc(x.name)}</strong> <span class="muted">${esc(x.slug)}</span>${x.flow ? ` <span class="badge ASSIGNED">${esc(x.flow)}</span>` : ""}</div><span class="badge ${x.active ? "ACCEPTED" : "REJECTED"}">${x.active ? "on" : "off"}</span> <span class="chev">›</span></div>`).join("") || '<p class="muted small">None.</p>'}
    </div>

    <div class="card">
      <div class="row" style="align-items:baseline"><h2 style="margin:0;flex:1">Providers</h2><button class="ghost small grow0" id="addp">+ Provider</button></div>
      ${(provs.providers || []).map((p) => `<div class="order-line tap" data-pid="${esc(p.id)}"><div><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.vertical || "—")}</span><br><span class="muted small">${esc(p.slug)}${p.upi_id ? " · " + esc(p.upi_id) : ""}</span></div><span class="chev">›</span></div>`).join("") || '<p class="muted small">None.</p>'}
    </div>

    <div class="card"><button class="ghost small" id="settings">⚙️ Settings</button> <button class="ghost small" id="del">Remove town</button></div>`);
  document.getElementById("back").onclick = townsList;
  document.getElementById("addv").onclick = () => addVertical(id);
  document.getElementById("addp").onclick = () => addProvider(id);
  document.getElementById("settings").onclick = () => townSettings(id);
  document.getElementById("del").onclick = async () => { if (confirm("Remove this town from the registry? (The town Worker itself keeps running.)")) { await api(`/api/towns/${id}`, { method: "DELETE" }); townsList(); } };
  el.querySelectorAll("[data-pid]").forEach((n) => (n.onclick = () => providerDetail(id, (provs.providers || []).find((p) => p.id === n.dataset.pid))));
  el.querySelectorAll("[data-vslug]").forEach((n) => (n.onclick = () => verticalDetail(id, (verts.verticals || []).find((v) => v.slug === n.dataset.vslug))));
}

// Vertical detail — rename, re-emoji, re-sort, switch flow, activate/deactivate, delete.
async function verticalDetail(townId, vtc) {
  let flows = [];
  try { flows = (await api(`/api/towns/${townId}/flows`)).flows || []; } catch {}
  h(`<div class="topbar"><h1>${esc(vtc.emoji || "")} ${esc(vtc.name)}</h1><button class="ghost small" id="back">←</button></div>
     <div class="card">
       <label>Name</label><input id="v_name" value="${esc(vtc.name)}" />
       <label style="margin-top:8px">Flow</label>
       <select id="v_flow">${flows.map((f) => `<option value="${esc(f.key)}" ${f.key === vtc.flow ? "selected" : ""}>${esc(f.key)} · ${esc(f.agentTerm)}</option>`).join("") || `<option value="${esc(vtc.flow || "")}">${esc(vtc.flow || "—")}</option>`}</select>
       <label style="margin-top:8px">Emoji</label><input id="v_emoji" value="${esc(vtc.emoji || "")}" />
       <label style="margin-top:8px">Sort</label><input id="v_sort" type="number" value="${vtc.sort || 0}" />
       <label class="row" style="margin-top:12px;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="v_active" ${vtc.active ? "checked" : ""} style="width:auto;margin:0" /><span>Active <span class="muted small">— shown to customers in the chooser</span></span></label>
       <p class="muted small" style="margin-top:8px">Slug <code>${esc(vtc.slug)}</code> can't be changed (providers link to it).</p>
       <div class="row" style="margin-top:12px;gap:8px"><button class="grow0" id="vsave">Save</button><button class="ghost grow0" id="vdel">Delete vertical</button></div>
       <p id="vmsg"></p>
     </div>`);
  document.getElementById("back").onclick = () => townDetail(townId);
  document.getElementById("vsave").onclick = async () => {
    const msg = document.getElementById("vmsg");
    try {
      // POST upserts by slug — same slug + new fields = edit.
      await api(`/api/towns/${townId}/verticals`, { method: "POST", body: { slug: vtc.slug, name: v("v_name"), flow: v("v_flow"), emoji: v("v_emoji"), sort: parseInt(v("v_sort"), 10) || 0, active: document.getElementById("v_active").checked } });
      msg.className = "small"; msg.textContent = "Saved ✓";
    } catch (e) { msg.className = "err"; msg.textContent = e.data?.detail || e.message; }
  };
  document.getElementById("vdel").onclick = async () => {
    if (!confirm(`Delete vertical "${vtc.name}"?`)) return;
    const msg = document.getElementById("vmsg");
    try { await api(`/api/towns/${townId}/verticals/${encodeURIComponent(vtc.slug)}`, { method: "DELETE" }); townDetail(townId); }
    catch (e) { msg.className = "err"; msg.textContent = e.data?.detail || e.message; }
  };
}

// Provider detail — edit/delete, managers (admin numbers), captains, catalog.
async function providerDetail(townId, p) {
  const pid = p.id;
  const A = (path) => `/api/towns/${townId}/providers/${pid}${path}`;
  h(`<div class="topbar"><h1>${esc(p.name)}</h1><button class="ghost small" id="back">←</button></div><div id="body"><p class="muted">Loading…</p></div>`);
  document.getElementById("back").onclick = () => townDetail(townId);
  const [mgrs, caps, cat, verts] = await Promise.all([
    api(A("/managers")).catch(() => ({ managers: [] })),
    api(A("/captains")).catch(() => ({ captains: [] })),
    api(A("/catalog")).catch(() => ({ catalog: [] })),
    api(`/api/towns/${townId}/verticals`).catch(() => ({ verticals: [] })),
  ]);
  const list = (rows, render, empty) => rows.length ? rows.map(render).join("") : `<p class="muted small">${empty}</p>`;
  document.getElementById("body").innerHTML = `
    <div class="card">
      <label>Name</label><input id="p_name" value="${esc(p.name)}" />
      <label style="margin-top:8px">Slug <span class="muted small">— URL id (${esc(p.slug)}/app), lowercase-with-hyphens</span></label><input id="p_slug" value="${esc(p.slug || "")}" />
      <label style="margin-top:8px">Vertical</label>
      <select id="p_vertical">${(verts.verticals || []).map((x) => `<option value="${esc(x.slug)}" ${x.slug === p.vertical ? "selected" : ""}>${esc(x.name)}</option>`).join("") || `<option value="${esc(p.vertical || "")}">${esc(p.vertical || "—")}</option>`}</select>
      <label style="margin-top:8px">UPI ID</label><input id="p_upi" value="${esc(p.upi_id || "")}" placeholder="shop@upi" />
      <label class="row" style="margin-top:12px;gap:8px;align-items:center;cursor:pointer">
        <input type="checkbox" id="p_photo" ${p.photo_order ? "checked" : ""} style="width:auto;margin:0" />
        <span>Photo / list upload <span class="muted small">— customer can send a picture or item list; Groq reads it and pre-fills the order</span></span>
      </label>
      <div class="row" style="margin-top:12px;gap:8px"><button class="grow0" id="psave">Save</button><button class="ghost grow0" id="pdel">Delete provider</button></div>
      <p id="pmsg"></p>
    </div>

    <div class="card">
      <div class="row" style="align-items:baseline"><h2 style="margin:0;flex:1">Managers (admin numbers)</h2></div>
      <p class="muted small" style="margin:0 0 8px">These phone numbers log into <code>${esc((p.slug))}</code>'s town at <b>/manager</b> over WhatsApp (text <b>admin</b> or <b>manager</b>).</p>
      ${list(mgrs.managers || [], (m) => `<div class="order-line"><div><strong>${esc(m.name || "—")}</strong> <span class="badge ${m.tier === "admin" ? "ACCEPTED" : "ASSIGNED"}">${esc(m.tier)}</span><br><span class="muted small">${esc(m.phone)}</span></div><button class="ghost small delm" data-mid="${esc(m.id)}" data-name="${esc(m.name || "")}">✕</button></div>`, "No managers yet.")}
      <div class="row" style="gap:6px;margin-top:10px;align-items:flex-end">
        <div style="flex:1"><label>Name</label><input id="m_name" placeholder="Owner" /></div>
        <div style="flex:1"><label>Phone (with country code)</label><input id="m_phone" inputmode="tel" placeholder="9198…" /></div>
        <div><label>Tier</label><select id="m_tier"><option value="admin">admin</option><option value="manager">manager</option></select></div>
        <button class="grow0" id="maddbtn">Add</button>
      </div><p id="mmsg" class="err small"></p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Captains (field agents)</h2>
      ${list(caps.captains || [], (x) => `<div class="order-line"><div><strong>${esc(x.name || "—")}</strong><br><span class="muted small">${esc(x.phone || "")}</span></div><button class="ghost small delc" data-cid="${esc(x.id)}" data-name="${esc(x.name || "")}">✕</button></div>`, "No captains yet.")}
      <div class="row" style="gap:6px;margin-top:10px;align-items:flex-end">
        <div style="flex:1"><label>Name</label><input id="c_name" placeholder="Ravi" /></div>
        <div style="flex:1"><label>Phone</label><input id="c_phone" inputmode="tel" placeholder="9198…" /></div>
        <button class="grow0" id="caddbtn">Add</button>
      </div><p id="cmsg" class="err small"></p>
    </div>

    <div class="card">
      <h2 style="margin-top:0">Catalog</h2>
      ${list(cat.catalog || [], (i) => { const off = i.available === 0; return `<div class="order-line"><div><strong>${esc(i.name)}</strong> <span class="muted small">${esc(i.category || "")}</span>${off ? ` <span class="badge REJECTED">out of stock</span>` : ""}<br><span class="muted small">${money(i.price)} · ${esc(i.unit || "piece")}</span></div><div class="row grow0" style="gap:6px"><button class="ghost small avail" data-iid="${esc(i.id)}" data-on="${off ? 0 : 1}">${off ? "In stock" : "Out"}</button><button class="ghost small deli" data-iid="${esc(i.id)}" data-name="${esc(i.name)}">✕</button></div></div>`; }, "No items yet — customers can't order without these.")}
      <div class="row" style="gap:6px;margin-top:10px;align-items:flex-end">
        <div style="flex:1"><label>Item</label><input id="i_name" placeholder="Shirt" /></div>
        <div style="flex:1"><label>Category</label><input id="i_cat" placeholder="Wash & Iron" /></div>
        <div><label>Price (₹)</label><input id="i_price" inputmode="numeric" placeholder="20" style="width:90px" /></div>
        <button class="grow0" id="iaddbtn">Add</button>
      </div><p id="imsg" class="err small"></p>
    </div>`;

  document.getElementById("psave").onclick = async () => {
    const msg = document.getElementById("pmsg");
    try { await api(A(""), { method: "PATCH", body: { name: v("p_name"), slug: slugify(v("p_slug")), vertical: v("p_vertical"), upi_id: v("p_upi"), photo_order: document.getElementById("p_photo").checked } }); msg.className = "small"; msg.textContent = "Saved ✓"; }
    catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
  document.getElementById("pdel").onclick = async () => {
    if (!confirm(`Delete "${p.name}" and all its catalog/managers/captains? This cannot be undone.`)) return;
    await api(A(""), { method: "DELETE" }); townDetail(townId);
  };
  document.getElementById("maddbtn").onclick = async () => {
    const msg = document.getElementById("mmsg"); msg.textContent = "";
    try { await api(A("/managers"), { method: "POST", body: { name: v("m_name"), phone: v("m_phone"), tier: document.getElementById("m_tier").value } }); providerDetail(townId, p); }
    catch (e) { msg.textContent = e.data?.need || e.message; }
  };
  document.getElementById("caddbtn").onclick = async () => {
    const msg = document.getElementById("cmsg"); msg.textContent = "";
    try { await api(A("/captains"), { method: "POST", body: { name: v("c_name"), phone: v("c_phone") } }); providerDetail(townId, p); }
    catch (e) { msg.textContent = e.data?.need || e.message; }
  };
  document.getElementById("iaddbtn").onclick = async () => {
    const msg = document.getElementById("imsg"); msg.textContent = "";
    try { await api(A("/catalog"), { method: "POST", body: { name: v("i_name"), category: v("i_cat"), price: (parseInt(v("i_price"), 10) || 0) * 100 } }); providerDetail(townId, p); }
    catch (e) { msg.textContent = e.message; }
  };
  el.querySelectorAll(".delm").forEach((b) => (b.onclick = async () => { if (confirm(`Remove manager "${b.dataset.name}"?`)) { await api(A(`/managers/${b.dataset.mid}`), { method: "DELETE" }); providerDetail(townId, p); } }));
  el.querySelectorAll(".delc").forEach((b) => (b.onclick = async () => { if (confirm(`Remove captain "${b.dataset.name}"?`)) { await api(A(`/captains/${b.dataset.cid}`), { method: "DELETE" }); providerDetail(townId, p); } }));
  el.querySelectorAll(".avail").forEach((b) => (b.onclick = async () => { await api(A(`/catalog/${b.dataset.iid}`), { method: "PATCH", body: { available: b.dataset.on === "0" } }); providerDetail(townId, p); }));
  el.querySelectorAll(".deli").forEach((b) => (b.onclick = async () => { if (confirm(`Delete item "${b.dataset.name}"?`)) { await api(A(`/catalog/${b.dataset.iid}`), { method: "DELETE" }); providerDetail(townId, p); } }));
}

async function addVertical(id) {
  let flows = [];
  try { flows = (await api(`/api/towns/${id}/flows`)).flows || []; } catch {}
  h(`<div class="topbar"><h1>Add vertical</h1><button class="ghost small" id="back">←</button></div>
     <div class="card"><p class="muted small">A vertical is a category customers pick (Medical, Fruits, Milk…). Many verticals can share one <b>flow</b> — e.g. Medical, Fruits and Milk all run the Delivery flow.</p>
       <label>Flow</label><select id="flow">${flows.map((f) => `<option value="${esc(f.key)}">${esc(f.key)} · ${esc(f.agentTerm)}</option>`).join("")}</select>
       <label style="margin-top:8px">Name</label><input id="name" placeholder="Medical" />
       <label style="margin-top:8px">Slug</label><input id="slug" placeholder="medical" />
       <label style="margin-top:8px">Emoji</label><input id="emoji" placeholder="💊" />
       <label style="margin-top:8px">Sort</label><input id="sort" type="number" value="0" />
       <button id="save" style="margin-top:14px">Save vertical</button><p id="msg" class="err"></p></div>`);
  document.getElementById("back").onclick = () => townDetail(id);
  // Auto-suggest the slug from the name until the user edits the slug directly.
  const nameEl = document.getElementById("name"), slugEl = document.getElementById("slug");
  let slugTouched = false;
  slugEl.oninput = () => { slugTouched = true; };
  nameEl.oninput = () => { if (!slugTouched) slugEl.value = nameEl.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); };
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg"); msg.textContent = "";
    try { await api(`/api/towns/${id}/verticals`, { method: "POST", body: { flow: v("flow"), slug: v("slug") || v("name"), name: v("name"), emoji: v("emoji"), sort: parseInt(v("sort"), 10) || 0 } }); townDetail(id); }
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
       <label style="margin-top:8px">Slug <span class="muted small">— URL id, lowercase-with-hyphens</span></label><input id="slug" placeholder="sparkle-dhobi" />
       <label style="margin-top:8px">UPI ID (optional)</label><input id="upi" placeholder="shop@upi" />
       <button id="save" style="margin-top:14px">Add provider</button><p id="msg" class="err"></p></div>`);
  document.getElementById("back").onclick = () => townDetail(id);
  // Auto-slugify the slug from the name until the user edits it directly.
  const nameI = document.getElementById("name"), slugI = document.getElementById("slug");
  let slugTouched = false;
  nameI.oninput = () => { if (!slugTouched) slugI.value = slugify(nameI.value); };
  slugI.oninput = () => { slugTouched = true; };
  slugI.onblur = () => { slugI.value = slugify(slugI.value); };
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg"); msg.textContent = "";
    try { await api(`/api/towns/${id}/providers`, { method: "POST", body: { slug: slugify(v("slug") || v("name")), name: v("name"), vertical: v("vertical"), upi_id: v("upi") } }); townDetail(id); }
    catch (e) { msg.textContent = e.data?.detail || e.message; }
  };
}

async function townSettings(id) {
  h(`<div class="topbar"><h1>Settings</h1><button class="ghost small" id="back">←</button></div><p class="muted">Loading…</p>`);
  document.getElementById("back").onclick = () => townDetail(id);
  let s = {};
  try { s = await api(`/api/towns/${id}/settings`); } catch (e) { h(`<div class="card"><p class="err">${esc(e.message)}</p></div>`); return; }
  const badge = (on) => `<span class="badge ${on ? "ACCEPTED" : "REJECTED"}">${on ? "set" : "unset"}</span>`;
  h(`<div class="topbar"><h1>Settings</h1><button class="ghost small" id="back">←</button></div>
     <div class="card"><p class="muted small">WhatsApp / maps / payment-email config for this town. Secret fields: leave blank to keep the current value; type to replace.</p>

       <label style="margin-top:6px">WhatsApp access token ${badge(s.token_set)}</label>
       <input id="wa_token" type="password" placeholder="${s.token_set ? "•••• set — blank keeps it" : "Meta permanent access token"}" />

       <label style="margin-top:8px">App secret ${badge(s.app_secret_set)}</label>
       <input id="wa_app_secret" type="password" placeholder="${s.app_secret_set ? "•••• set — blank keeps it" : "Meta app secret (verifies webhook)"}" />

       <label style="margin-top:8px">Verify token</label>
       <input id="wa_verify_token" value="${esc(s.verify_token || "")}" placeholder="you choose this; also paste into Meta" />

       <label style="margin-top:8px">Phone Number ID (Meta — needed to SEND)</label>
       <input id="wa_phone_number_id" value="${esc(s.wa_phone_number_id || "")}" placeholder="from Meta → WhatsApp → API Setup" />

       <label style="margin-top:8px">WhatsApp display number (E.164 digits)</label>
       <input id="wa_display_number" value="${esc(s.wa_display_number || "")}" placeholder="e.g. 919999900000" />

       <label style="margin-top:8px">Ola Maps key ${badge(s.maps_set)}</label>
       <input id="ola_maps_api_key" type="password" placeholder="${s.maps_set ? "•••• set — blank keeps it" : "address autocomplete (optional)"}" />

       <label style="margin-top:8px">Groq key ${badge(s.groq_set)}</label>
       <input id="groq_api_key" type="password" placeholder="${s.groq_set ? "•••• set — blank keeps it" : "payment-email parsing (optional)"}" />

       <button id="save" style="margin-top:14px">Save</button><p id="msg"></p>
       <p class="muted small" style="margin-top:10px">Webhook URL for Meta: <code>https://${esc((s.host || "").replace(/^https?:\/\//, "")) || "&lt;this town&gt;"}/webhook/whatsapp</code></p>
     </div>`);
  document.getElementById("back").onclick = () => townDetail(id);
  document.getElementById("save").onclick = async () => {
    const msg = document.getElementById("msg"); msg.className = ""; msg.textContent = "Saving…";
    // Only send non-empty fields so blank inputs never wipe existing secrets.
    const body = {};
    for (const k of ["wa_token", "wa_app_secret", "wa_verify_token", "wa_phone_number_id", "wa_display_number", "ola_maps_api_key", "groq_api_key"]) {
      const val = v(k);
      if (val) body[k] = val;
    }
    body.wa_display_number = v("wa_display_number"); // always send (may be cleared)
    body.wa_phone_number_id = v("wa_phone_number_id");
    try { await api(`/api/towns/${id}/settings`, { method: "POST", body }); msg.className = "small"; msg.textContent = "Saved ✓"; }
    catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
}

boot();
