// Vanilla SPA. Path-based routing:
//   /                → role-aware landing (redirects logged-in users)
//   /{slug}/app      → customer app (OTP login → order list / create / track)
//   /admin           → provider-admin login → order board
//   /console         → super-admin login → providers / catalog / admins
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

const h = (html) => {
  el.innerHTML = html;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (ms) => new Date(ms).toLocaleString();
const badge = (s) => `<span class="badge ${esc(s)}">${esc(s.replace(/_/g, " "))}</span>`;
// Payment at a glance in the orders list. 'submitted' is the one that needs the
// shop to DO something, so it gets a pill of its own rather than reading as failed.
const paidPill = (o) =>
  o.payment_status === "paid" ? `<span class="paid-pill">✅ Paid</span>`
  : o.payment_status === "submitted" ? `<span class="paid-pill review">🕗 Check payment</span>`
  : o.payment_status === "rejected" ? `<span class="paid-pill fail">❌ Receipt rejected</span>`
  : o.payment_status === "failed" ? `<span class="paid-pill fail">❌ Failed</span>` : "";

// Money: values are stored in paise (minor units).
const CUR = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };
const money = (paise, cur = "INR") =>
  (CUR[cur] || cur + " ") +
  (Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

async function me() {
  return api("/api/me");
}

// Vertical config (flow + brand) — fetched once; drives status buckets and the
// field-agent terminology so this SPA works for any flow (pickup/deliver, on-site…).
let CFG = { flow: {}, brand: {} };
async function loadConfig() {
  try { CFG = await api("/api/config"); } catch {}
  return CFG;
}
// Status buckets derived from the flow: the decision entry (new), the terminal
// statuses (done/rejected), and everything in between (in progress).
function statusBuckets() {
  const f = CFG.flow || {}, term = f.terminal || [], from = f.decision?.from, reject = f.decision?.reject;
  const active = (f.statuses || []).filter((s) => s !== from && !term.includes(s));
  return { from, active, terminal: term, reject };
}

// ── Modal popup (appended to body; survives #app re-renders until closed) ──
function openModal(title, innerHTML) {
  closeModal();
  const ov = document.createElement("div");
  ov.className = "modal-overlay";
  ov.id = "modal-overlay";
  ov.innerHTML = `<div class="modal"><div class="modal-head"><h2>${esc(title)}</h2><button class="modal-x" id="modal-x">×</button></div><div class="modal-body">${innerHTML}</div></div>`;
  document.body.appendChild(ov);
  ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(); });
  document.getElementById("modal-x").onclick = closeModal;
  return ov;
}
function closeModal() {
  document.getElementById("modal-overlay")?.remove();
}

// Lazily load MapLibre GL (used by the Ola Maps address picker) from CDN, once.
let _mapLibre;
function loadMapLibre() {
  if (window.maplibregl) return Promise.resolve();
  if (_mapLibre) return _mapLibre;
  _mapLibre = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _mapLibre;
}

// ── Router ───────────────────────────────────────────────────────────────────
async function route() {
  const path = location.pathname;
  try {
    await loadConfig();
    if (path === "/console" || path === "/admin") return renderDashboard();
    if (path === "/start") return renderStart();
    const m = path.match(/^\/([^/]+)\/app$/);
    if (m) { let s; try { s = decodeURIComponent(m[1]); } catch { s = m[1]; } return renderCustomer(s); }
    // A shop's public storefront: /{slug} (no /app). Needs no session.
    const sm = path.match(/^\/([^/]+)\/?$/);
    if (sm) {
      let s; try { s = decodeURIComponent(sm[1]); } catch { s = sm[1]; }
      return renderShopLanding(s);
    }
    // Root of a single-shop town → that shop's storefront, not a dev index.
    if (path === "/" && CFG.soleProvider) return renderShopLanding(CFG.soleProvider);
    return renderLanding();
  } catch (e) {
    h(`<div class="card"><p class="err">${esc(e.message)}</p></div>`);
  }
}

function renderLanding() {
  h(`
    <div class="topbar"><h1>${esc(CFG.brand?.name || "HomeEase Guru")}</h1></div>
    <div class="card">
      <p class="muted">On-site home-appliance service — request, visit, repair.</p>
      <h2>Are you a…</h2>
      <p><a href="/admin">Provider / shop admin →</a></p>
      <p><a href="/console">Platform super-admin →</a></p>
      <p class="muted">Customers: open the link your provider shared, e.g. <code>/your-shop/app</code></p>
    </div>`);
}

// Readable ink for text sitting ON a swatch. Real relative-luminance (sRGB,
// gamma-corrected) rather than a naive average, so cream/ivory swatches get dark
// digits instead of invisible white ones. CSS color-contrast() would do this
// natively but isn't reliably supported yet.
function inkOn(hex) {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return "#ffffff";
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L =
    0.2126 * lin(parseInt(full.slice(0, 2), 16)) +
    0.7152 * lin(parseInt(full.slice(2, 4), 16)) +
    0.0722 * lin(parseInt(full.slice(4, 6), 16));
  return L > 0.5 ? "#0a1c34" : "#ffffff";
}

// "VDR Cosmetics" → "VDR". The stamp on a soap disc when it has no photo.
function initialsOf(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  return (first.length <= 4 ? first : first.slice(0, 3)).toUpperCase();
}

// ── Public shop landing ─────────────────────────────────────────────────────
// The shop's storefront: what a visitor with no session sees. Entirely driven by
// the provider's `config.landing` + its live catalog, so every shop gets its own
// page without a line of its branding living in here. No landing configured →
// callers fall back to the plain sign-in card.
async function renderShopLanding(slug) {
  const provider = await api(`/api/providers/${encodeURIComponent(slug)}`).catch(() => null);
  if (!provider) return h(`<div class="card"><p class="err">Unknown shop "${esc(slug)}".</p></div>`);
  const L = provider.landing;
  if (!L) return customerLogin(slug, provider); // nothing to show off — plain login

  const cur = provider.currency || "INR";
  // The collection's order + swatch colours are curated in config; price,
  // description and stock stay live from the catalog. Anything in the catalog but
  // not curated still shows, so a new soap never silently goes missing.
  const bySlug = new Map((provider.catalog || []).map((c) => [c.name.toLowerCase(), c]));
  const curated = (L.collection || []).map((c) => ({ ...c, item: bySlug.get(String(c.name).toLowerCase()) })).filter((c) => c.item);
  const curatedNames = new Set(curated.map((c) => c.item.name.toLowerCase()));
  const extras = (provider.catalog || []).filter((c) => !curatedNames.has(c.name.toLowerCase())).map((item) => ({ name: item.name, color: "#9aa7b4", item }));
  const collection = [...curated, ...extras];

  const waCta = provider.wa
    ? `<a class="lp-btn lp-btn-primary" href="${esc(provider.wa)}" target="_blank" rel="noopener">Order on WhatsApp</a>`
    : `<a class="lp-btn lp-btn-primary" href="/${encodeURIComponent(slug)}/app">Order now</a>`;

  // A storefront is the thing people bookmark and paste into WhatsApp, so it needs
  // its own title/description — the town's static <title> would show "Manasanta".
  document.title = L.tagline ? `${provider.name} — ${L.tagline}` : provider.name;
  let meta = document.querySelector('meta[name="description"]');
  if (!meta) { meta = document.createElement("meta"); meta.name = "description"; document.head.appendChild(meta); }
  meta.content = L.blurb || "";

  const mark = L.discMark || initialsOf(provider.name);
  const soapCards = collection.map((c, i) => {
    const it = c.item;
    const off = it.available === 0;
    const swatch = c.color || "#9aa7b4";
    return `<article class="lp-soap${off ? " lp-soap-off" : ""}" style="--swatch:${esc(swatch)};--swatch-ink:${inkOn(swatch)};animation-delay:${60 + i * 45}ms">
      <span class="lp-soap-n">${i + 1}</span>
      <div class="lp-disc">${it.image ? `<img src="${it.image}" alt="${esc(it.name)}" />` : `<span class="lp-disc-mark">${esc(mark)}</span>`}</div>
      <h3>${esc(it.name)}</h3>
      ${it.description ? `<p>${esc(it.description)}</p>` : ""}
      <div class="lp-soap-foot"><span class="lp-price">${money(it.price || 0, cur)}</span>${off ? `<span class="lp-oos">Out of stock</span>` : ""}</div>
    </article>`;
  }).join("");

  const features = (L.features || []).map((f) => `<li><span>${esc(f.icon || "✦")}</span>${esc(f.label || f)}</li>`).join("");
  const badges = (L.badges || []).map((b) => `<li><span>${esc(b.icon || "✦")}</span>${esc(b.label || b)}</li>`).join("");
  const C = L.contact || {};

  h(`
  <div class="lp">
    <header class="lp-nav">
      <a class="lp-mark" href="#top"><b>${esc(L.wordmark || provider.name)}</b><span>${esc(L.wordmarkSub || "")}</span></a>
      <nav>
        <a href="#collection">Collection</a>
        <a href="#about">About</a>
        <a href="#contact">Contact</a>
        <a class="lp-nav-cta" href="/${encodeURIComponent(slug)}/app">Order</a>
      </nav>
    </header>

    <section class="lp-hero" id="top">
      <div class="lp-hero-glow"></div>
      <div class="lp-hero-in">
        <p class="lp-eyebrow">${esc(L.tagline || "")}</p>
        <h1>${esc(L.headline || provider.name)}<em>${esc(L.headlineScript || "")}</em></h1>
        <p class="lp-blurb">${esc(L.blurb || "")}</p>
        <div class="lp-cta">${waCta}<a class="lp-btn lp-btn-ghost" href="#collection">View the collection</a></div>
      </div>
      ${features ? `<ul class="lp-features">${features}</ul>` : ""}
    </section>

    <section class="lp-sec" id="collection">
      <div class="lp-sec-head"><span class="lp-rule"></span><h2>Our Soap Collection</h2><span class="lp-rule"></span></div>
      <div class="lp-grid">${soapCards}</div>
    </section>

    ${badges ? `<section class="lp-trust"><ul>${badges}</ul></section>` : ""}

    ${L.about ? `<section class="lp-sec lp-about" id="about">
      <div class="lp-sec-head"><span class="lp-rule"></span><h2>${esc(L.aboutTitle || "About us")}</h2><span class="lp-rule"></span></div>
      <div class="lp-prose">${L.about.split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("")}</div>
    </section>` : ""}

    <section class="lp-sec lp-contact" id="contact">
      <div class="lp-sec-head"><span class="lp-rule"></span><h2>Contact</h2><span class="lp-rule"></span></div>
      <div class="lp-contact-grid">
        ${C.phone ? `<a href="tel:${esc(C.phone)}"><span>Phone</span><b>${esc(C.phone)}</b></a>` : ""}
        ${C.email ? `<a href="mailto:${esc(C.email)}"><span>Email</span><b>${esc(C.email)}</b></a>` : ""}
        ${C.address ? `<div><span>Visit</span><b>${esc(C.address)}</b></div>` : ""}
        ${C.hours ? `<div><span>Hours</span><b>${esc(C.hours)}</b></div>` : ""}
      </div>
      <div class="lp-cta" style="justify-content:center;margin-top:26px">${waCta}</div>
    </section>

    <footer class="lp-foot">
      <div class="lp-mark"><b>${esc(L.wordmark || provider.name)}</b><span>${esc(L.wordmarkSub || "")}</span></div>
      <nav>
        <a href="#collection">Collection</a><a href="#about">About</a><a href="#contact">Contact</a>
        <a href="/${encodeURIComponent(slug)}/app">Order</a>
      </nav>
      <p>${esc(L.footNote || `© ${new Date().getFullYear()} ${provider.name}`)}</p>
    </footer>
  </div>`);
}

// ── Marketplace chooser: pick a vertical → pick a provider → order ───────────
async function renderStart() {
  const who = await me();
  if (!who.authenticated || who.role !== "customer") {
    return h(`
      <div class="topbar"><h1>${esc(CFG.brand?.name || "Services")}</h1></div>
      <div class="card"><h2 style="margin-top:0">Open from WhatsApp</h2>
      <p class="muted">Send us a message on WhatsApp and tap <b>Browse services</b> — you'll land here signed in.</p></div>`);
  }
  h(`<div class="topbar"><h1>${esc(CFG.brand?.name || "Services")}</h1><button class="ghost small" id="logout">Log out</button></div>
     <p class="muted">What do you need today?</p><div id="verts" class="stack"><p class="muted">Loading…</p></div>`);
  document.getElementById("logout").onclick = logout;
  let verticals = [];
  try { verticals = (await api("/api/verticals")).verticals || []; } catch {}
  const box = document.getElementById("verts");
  if (!verticals.length) { box.innerHTML = `<p class="muted">No services available yet.</p>`; return; }
  // A town with a single vertical shouldn't make anyone "choose" from a list of
  // one — go straight to its providers. `skipped` tells that step there's no
  // chooser worth offering a Back button to.
  if (verticals.length === 1) return chooseProviders(verticals[0].slug, verticals[0].name, true);
  box.innerHTML = verticals.map((v) =>
    `<button class="ghost prov" data-slug="${esc(v.slug)}" data-name="${esc(v.name)}">
       <span style="font-size:20px;margin-right:8px">${esc(v.emoji || "•")}</span><span style="flex:1;text-align:left">${esc(v.name)}</span><span class="chev">›</span>
     </button>`).join("");
  box.querySelectorAll(".prov").forEach((b) => (b.onclick = () => chooseProviders(b.dataset.slug, b.dataset.name)));
}

// skipped = we got here automatically (single vertical), so there's no vertical
// chooser behind us to go Back to.
async function chooseProviders(vslug, vname, skipped) {
  h(`<div class="topbar"><h1>${esc(vname)}</h1>${skipped ? "" : `<button class="ghost small" id="back">←</button>`}</div>
     <p class="muted">Loading…</p><div id="provs" class="stack"></div>`);
  document.getElementById("back")?.addEventListener("click", renderStart);
  let providers = [];
  try { providers = (await api(`/api/verticals/${encodeURIComponent(vslug)}/providers`)).providers || []; } catch {}
  // Single shop → skip this step too. location.replace, NOT href: an auto-skip
  // must not leave a history entry, or Back would land on /start and bounce the
  // customer straight forward again.
  if (providers.length === 1) return location.replace(`/${encodeURIComponent(providers[0].slug)}/app`);
  const box = document.getElementById("provs");
  if (!providers.length) { box.innerHTML = `<p class="muted">No providers here yet.</p>`; return; }
  h(`<div class="topbar"><h1>${esc(vname)}</h1>${skipped ? "" : `<button class="ghost small" id="back">←</button>`}</div>
     <p class="muted">Choose a provider</p><div id="provs" class="stack">${providers.map((p) =>
       `<button class="ghost prov" data-slug="${esc(p.slug)}"><span style="flex:1;text-align:left">${esc(p.name)}</span><span class="chev">›</span></button>`).join("")}</div>`);
  document.getElementById("back")?.addEventListener("click", renderStart);
  // A real choice → push, so Back returns to this list.
  el.querySelectorAll(".prov").forEach((b) => (b.onclick = () => { location.href = `/${encodeURIComponent(b.dataset.slug)}/app`; }));
}

// How this order gets paid. Only a shop set to 'both' asks the customer; 'upi'
// and 'cod' shops are told, not asked (and a courier shop is always UPI). A UPI
// shop with no VPA configured can't take payment — flag it rather than promise it.
function payPickerHtml(provider) {
  const pm = provider.payment_method || "cod";
  if (pm === "both") {
    return `<label style="margin-top:12px">Payment</label>
      <div class="row" style="gap:6px">
        <button type="button" class="ghost small grow0 pm sel" data-pm="cod">💵 Cash on delivery</button>
        <button type="button" class="ghost small grow0 pm" data-pm="upi"${provider.has_upi ? "" : " disabled"}>💳 Pay online (UPI)</button>
      </div>
      ${provider.has_upi ? `<p class="muted small" style="margin:4px 0 0">Pay online and we'll start your order as soon as the shop confirms.</p>` : ""}`;
  }
  if (pm === "upi") {
    return provider.has_upi
      ? `<p class="muted small" style="margin:12px 0 0">💳 <b>Pay online</b> — you'll get a UPI QR once the shop accepts and prices your order.</p>`
      : `<p class="small err" style="margin:12px 0 0">⚠️ This shop takes online payment but hasn't set up a UPI ID yet.</p>`;
  }
  return `<p class="muted small" style="margin:12px 0 0">💵 <b>Cash on delivery</b> — pay when your order arrives.</p>`;
}

// Downscale before upload — smaller for Groq + fits D1 storage. Longest side ≤ 1280.
// Shared by the photo-order form and the payment-receipt upload.
function downscaleImg(file) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onerror = reject;
    rd.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const max = 1280, scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
        cv.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL("image/jpeg", 0.6));
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
}

// ── Customer ─────────────────────────────────────────────────────────────────
async function renderCustomer(slug) {
  const provider = await api(`/api/providers/${encodeURIComponent(slug)}`).catch(() => null);
  if (!provider) return h(`<div class="card"><p class="err">Unknown provider "${esc(slug)}".</p></div>`);

  const who = await me();
  // No session → show the storefront rather than a bare OTP form; it carries the
  // WhatsApp CTA that actually gets them signed in. (Falls back to the login card
  // for shops with no landing configured.)
  if (!who.authenticated || who.role !== "customer") return renderShopLanding(slug);

  // An order status message deep-links here as /{slug}/app?order=… — open that
  // order. Strip the param first so a reload doesn't re-open it.
  const deepOrder = new URLSearchParams(location.search).get("order");
  if (deepOrder) {
    history.replaceState(null, "", `/${encodeURIComponent(slug)}/app`);
    return customerTrack(deepOrder, slug);
  }

  const { orders } = await api(`/api/my/orders?provider=${encodeURIComponent(slug)}`);
  const list = orders
    .map(
      (o) => `<div class="order-line" data-id="${o.id}">
        <div><strong>Order ${esc(o.id)}</strong> <span class="amt">${money(o.total)}</span><br><span class="muted">${fmtDate(o.created_at)}</span></div>
        ${badge(o.status)}
      </div>`
    )
    .join("");

  h(`
    <div class="topbar">
      <div><h1>${esc(provider.name)}</h1><span class="muted">Your orders</span></div>
      <button class="ghost small" id="logout">Log out</button>
    </div>
    <div class="card">
      <button id="new">+ New request</button>
    </div>
    <div class="card">${orders.length ? list : '<p class="muted">No orders yet.</p>'}</div>`);

  document.getElementById("logout").onclick = logout;
  document.getElementById("new").onclick = () => customerNewOrder(slug, provider);
  el.querySelectorAll(".order-line").forEach((n) => (n.onclick = () => customerTrack(n.dataset.id, slug)));
}

function customerLogin(slug, provider) {
  h(`
    <div class="topbar"><h1>${esc(provider.name)}</h1></div>
    <div class="card">
      <h2>Log in with WhatsApp</h2>
      <label>WhatsApp number (with country code)</label>
      <input id="phone" placeholder="9198XXXXXXXX" inputmode="numeric" />
      <div id="step1"><button id="send" style="margin-top:12px">Send code</button></div>
      <div id="step2" style="display:none">
        <label>Enter the 6-digit code</label>
        <input id="code" inputmode="numeric" maxlength="6" />
        <button id="verify" style="margin-top:12px">Verify</button>
      </div>
      <p id="msg"></p>
    </div>`);
  const msg = document.getElementById("msg");
  document.getElementById("send").onclick = async () => {
    const wa_phone = document.getElementById("phone").value;
    try {
      await api("/auth/otp/request", { method: "POST", body: { wa_phone, slug } });
      document.getElementById("step1").style.display = "none";
      document.getElementById("step2").style.display = "block";
      msg.className = "ok"; msg.textContent = "Code sent on WhatsApp.";
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
  document.getElementById("step2") &&
    (document.getElementById("verify").onclick = async () => {
      const wa_phone = document.getElementById("phone").value;
      const code = document.getElementById("code").value;
      try {
        await api("/auth/otp/verify", { method: "POST", body: { wa_phone, code } });
        renderCustomer(slug);
      } catch (e) { msg.className = "err"; msg.textContent = e.message; }
    });
}

async function customerNewOrder(slug, provider) {
  const cur = provider.currency || "INR";
  // Catalog grouped by category — each item gets a quantity stepper (multi-select).
  const catGroups = {};
  provider.catalog.forEach((ci) => {
    const g = ci.category || "Other";
    (catGroups[g] = catGroups[g] || []).push(ci);
  });
  const catKeys = Object.keys(catGroups).sort();
  const pickerHtml = catKeys
    .map(
      (g) => `<div class="pick-cat">${esc(g)}</div>` +
        catGroups[g]
          .map((ci) => {
            const off = ci.available === 0;
            return `<div class="pick-row${off ? " pick-off" : ""}" data-name="${esc(ci.name)}" data-cat="${esc(g)}" data-price="${ci.price || 0}">
              ${ci.image ? `<img class="pick-img" src="${ci.image}" alt="${esc(ci.name)}" />` : ""}
              <div class="pick-info"><strong>${esc(ci.name)}</strong>${off ? ` <span class="muted small">· out of stock</span>` : ""}<br><span class="muted">${money(ci.price || 0, cur)} · ${esc(ci.unit)}</span>${ci.description ? `<br><span class="muted small">${esc(ci.description)}</span>` : ""}</div>
              ${off ? "" : `<div class="qtyctrl">
                <button type="button" class="qbtn qminus">−</button>
                <input class="qnum" type="number" min="0" value="0" inputmode="numeric" />
                <button type="button" class="qbtn qplus">+</button>
              </div>`}
            </div>`;
          })
          .join("")
    )
    .join("");
  // Category filter chips (only when there's more than one category).
  const chipsHtml =
    catKeys.length > 1
      ? `<div class="chips" id="itemchips"><button type="button" class="chip active" data-c="__all__">All</button>` +
        catKeys.map((g) => `<button type="button" class="chip" data-c="${esc(g)}">${esc(g)}</button>`).join("") +
        `</div>`
      : "";

  let addresses = [];
  try { addresses = (await api("/api/my/addresses")).addresses || []; } catch {}
  let selectedAddrId = addresses[0]?.id || null;
  let myPhone = "";
  try { myPhone = (await me()).wa_phone || ""; } catch {}

  h(`
    <div class="topbar"><h1>New request</h1><button class="ghost small" id="back">← Back</button></div>
    <div class="card">
      <label>Service address</label>
      <div id="addrsection"></div>
      ${provider.photo_order ? `<div class="photo-order" id="photocard">
        <strong>📷 Order from a photo or list</strong>
        <p class="muted small" style="margin:4px 0 8px">Send a picture of your handwritten list${provider.vertical === "delivery" ? ", prescription" : ""} or the items themselves — we'll read them for you.</p>
        <div class="row" style="gap:8px">
          <label class="photo-btn">📷 Take photo<input type="file" id="photocam" accept="image/*" capture="environment" hidden /></label>
          <label class="photo-btn">🖼️ Choose file<input type="file" id="photofile" accept="image/*" hidden /></label>
        </div>
        <p id="photostatus" class="small" style="margin:6px 0"></p>
        <div id="photothumbs" class="pthumbs"></div>
        <div id="photoitems"></div>
      </div>` : ""}
      <h2>Items</h2>
      <input id="itemsearch" placeholder="Search items…" style="margin-bottom:8px" />
      ${chipsHtml}
      <div id="picker">${pickerHtml || '<p class="muted">No items available.</p>'}</div>
      <div id="summary" class="summary"></div>
      <div class="row" style="margin-top:14px;align-items:baseline">
        <strong style="flex:1;font-size:15px">Estimated total</strong>
        <strong id="total" style="flex:0 0 auto;font-size:18px">${money(0, cur)}</strong>
      </div>
      <label>Note (optional)</label>
      <input id="note" />
      ${payPickerHtml(provider)}
      <button id="submit" style="margin-top:14px">Place request</button>
      <p id="msg"></p>
    </div>`);
  document.getElementById("back").onclick = () => renderCustomer(slug);
  el.querySelectorAll(".pm").forEach((b) => (b.onclick = () => {
    el.querySelectorAll(".pm").forEach((x) => x.classList.toggle("sel", x === b));
  }));

  // ── Items picker (multi-select with quantity) ──
  const picker = document.getElementById("picker");
  // Photo/list uploads. Items are merged by name into a single list (no duplicate
  // rows across images); each item tracks the ids of the images it came from, so an
  // item survives while any of its source images remain and drops when the last one
  // is deleted. Priced items count toward the total; unpriced ones the shop settles.
  let photoImages = []; // [{ id, thumb }]
  let photoItems = [];  // [{ name, qty, price, note, imgIds:[] }]
  const photoSum = () => photoItems.reduce((s, it) => s + (it.price || 0) * it.qty, 0);
  const recalc = () => {
    let sum = 0;
    const selected = [];
    picker.querySelectorAll(".pick-row").forEach((r) => {
      const numEl = r.querySelector(".qnum");
      if (!numEl) return; // out-of-stock row — no stepper, not orderable
      const price = parseInt(r.dataset.price || "0", 10);
      const qty = Math.max(0, parseInt(numEl.value, 10) || 0);
      if (qty > 0) selected.push({ name: r.dataset.name, cat: r.dataset.cat, qty, price });
      sum += price * qty;
    });
    sum += photoSum();
    document.getElementById("total").textContent = money(sum, cur);
    // Selected-items summary, grouped by category (always visible, even when a
    // category chip is hiding some of the picked items).
    const box = document.getElementById("summary");
    if (!selected.length) { box.innerHTML = ""; return; }
    const g = {};
    selected.forEach((s) => (g[s.cat] = g[s.cat] || []).push(s));
    box.innerHTML =
      `<div class="summary-head">Selected items</div>` +
      Object.keys(g)
        .sort()
        .map(
          (cat) => `<div class="summary-cat">${esc(cat)}</div>` +
            g[cat].map((s) => `<div class="summary-line"><span>${esc(s.name)} × ${s.qty}</span><span class="amt">${money(s.price * s.qty, cur)}</span></div>`).join("")
        )
        .join("");
  };
  picker.querySelectorAll(".pick-row").forEach((r) => {
    const num = r.querySelector(".qnum");
    if (!num) return; // out-of-stock row — nothing to wire
    const mark = () => r.classList.toggle("picked", (parseInt(num.value, 10) || 0) > 0);
    r.querySelector(".qplus").onclick = () => { num.value = (parseInt(num.value, 10) || 0) + 1; mark(); recalc(); };
    r.querySelector(".qminus").onclick = () => { num.value = Math.max(0, (parseInt(num.value, 10) || 0) - 1); mark(); recalc(); };
    num.oninput = () => { mark(); recalc(); };
  });
  // Category chips + search combine to filter the pick rows.
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
    ch.onclick = () => {
      activeCat = ch.dataset.c;
      document.querySelectorAll("#itemchips .chip").forEach((x) => x.classList.toggle("active", x === ch));
      applyFilter();
    };
  });

  // ── Photo / list order (Groq vision), multiple images ──
  const photoFile = document.getElementById("photofile"); // "Choose file"
  const photoCam = document.getElementById("photocam");   // "Take photo" (capture=camera)
  if (photoFile || photoCam) {
    const pstatus = document.getElementById("photostatus");
    const pthumbs = document.getElementById("photothumbs");
    const pitems = document.getElementById("photoitems");
    const priceOf = new Map((provider.catalog || []).map((ci) => [String(ci.name).toLowerCase(), ci.price || 0]));

    const downscale = downscaleImg;

    let photoSeq = 0;
    // Merge an extracted item into the shared list, keyed by name + written amount
    // (so "Rice 3 kg" and "Rice 2 kg" stay separate but a plain repeat merges):
    // sum the count and remember which image contributed it.
    const mergeItem = (imgId, raw) => {
      const nm = raw.name.trim();
      const amount = (raw.amount || "").trim();
      if (!nm) return;
      const key = (nm + "|" + amount).toLowerCase();
      const existing = photoItems.find((it) => (it.name + "|" + it.amount).toLowerCase() === key);
      if (existing) {
        existing.qty += raw.qty;
        if (!existing.imgIds.includes(imgId)) existing.imgIds.push(imgId);
        if (!existing.note && raw.note) existing.note = raw.note;
      } else {
        photoItems.push({ name: nm, amount, qty: raw.qty, price: priceOf.get(nm.toLowerCase()) || 0, note: raw.note || "", imgIds: [imgId] });
      }
    };
    // Delete an image: forget it as a source for every item; an item stays while it
    // still has another source image and is dropped once its last source is gone.
    const removeImage = (id) => {
      photoImages = photoImages.filter((im) => im.id !== id);
      photoItems = photoItems.filter((it) => { it.imgIds = it.imgIds.filter((x) => x !== id); return it.imgIds.length > 0; });
      renderPhotos(); recalc();
    };

    const renderPhotos = () => {
      pthumbs.innerHTML = photoImages
        .map((im, i) => `<div class="pthumb"><img src="${im.thumb}" alt="photo ${i + 1}" /><button type="button" class="pthumb-x" data-id="${im.id}" title="Remove photo &amp; its items">✕</button></div>`)
        .join("");
      pthumbs.querySelectorAll(".pthumb-x").forEach((b) => (b.onclick = () => removeImage(b.dataset.id)));
      pitems.innerHTML = photoItems.length
        ? `<div class="summary-head">Items from your photos</div>` +
          photoItems.map((it, i) => `<div class="summary-line" data-i="${i}"><span style="flex:1">${esc(it.name)}${it.amount ? ` <span class="muted">· ${esc(it.amount)}</span>` : ""}${it.price ? "" : ` <span class="muted">· shop prices</span>`}${it.note ? ` <span class="muted">(${esc(it.note)})</span>` : ""}</span><div class="qtyctrl"><button type="button" class="qbtn iminus">−</button><input class="qnum iqty" type="number" min="1" value="${it.qty}" inputmode="numeric" /><button type="button" class="qbtn iplus">+</button></div><button type="button" class="qbtn xrm" title="Remove item">✕</button></div>`).join("")
        : "";
      pitems.querySelectorAll(".summary-line").forEach((row) => {
        const i = +row.dataset.i, num = row.querySelector(".iqty"), it = photoItems[i];
        row.querySelector(".iplus").onclick = () => { it.qty++; renderPhotos(); recalc(); };
        row.querySelector(".iminus").onclick = () => { it.qty = Math.max(1, it.qty - 1); renderPhotos(); recalc(); };
        num.onchange = () => { it.qty = Math.max(1, parseInt(num.value, 10) || 1); recalc(); };
        row.querySelector(".xrm").onclick = () => { photoItems.splice(i, 1); renderPhotos(); recalc(); };
      });
    };

    const handlePhoto = async (file) => {
      if (!file) return;
      pstatus.className = "small muted"; pstatus.textContent = "Reading your photo…";
      let thumb;
      try { thumb = await downscale(file); }
      catch { pstatus.className = "small err"; pstatus.textContent = "Couldn't read that image."; return; }
      try {
        const { items } = await api("/api/my/orders/extract", { method: "POST", body: { slug, image: thumb } });
        const kept = (items || []).filter((it) => it.relevant !== false);
        const dropped = (items || []).length - kept.length;
        // Keep the image regardless (shown on the order for the shop to read); merge
        // its items into the shared list, deduped by name.
        const imgId = "img" + ++photoSeq;
        photoImages.push({ id: imgId, thumb });
        kept.forEach((it) => mergeItem(imgId, { name: it.name, amount: it.amount || "", qty: it.qty, note: it.note || "" }));
        renderPhotos(); recalc();
        pstatus.className = "small ok";
        pstatus.textContent = kept.length
          ? `Added ${kept.length} item${kept.length === 1 ? "" : "s"} from this photo${dropped ? ` (${dropped} unrelated skipped)` : ""}. Add more photos or place your request.`
          : "Photo added — we couldn't read items from it; the shop will check it. Add items manually if you like.";
      } catch (e) {
        pstatus.className = "small err";
        pstatus.textContent = e.message === "groq_not_configured"
          ? "Photo reading isn't set up for this shop yet — please add items manually."
          : "Couldn't read that image. Try a clearer photo or add items manually.";
      }
    };
    // Both the camera and the file picker feed the same handler. Reset value after
    // so re-selecting the same file (or retaking a photo) fires change again.
    [photoCam, photoFile].forEach((inp) => inp && (inp.onchange = () => { const f = inp.files?.[0]; inp.value = ""; handlePhoto(f); }));
  }

  // ── Address book ──
  let bias = null;
  navigator.geolocation?.getCurrentPosition((p) => { bias = `${p.coords.latitude},${p.coords.longitude}`; }, () => {}, { timeout: 4000 });
  let map = null;
  let mapState = { area: "", lat: null, lng: null }; // pending new address from the map

  function renderAddrSection(mode) {
    const box = document.getElementById("addrsection");
    if (mode === "add" || !addresses.length) {
      box.innerHTML = `
        <label>Contact name</label>
        <input id="cname" placeholder="Who should the technician contact on site?" />
        <label>Contact phone</label>
        <input id="cphone" inputmode="numeric" value="${esc(myPhone)}" placeholder="10-digit mobile" />
        <div style="position:relative;margin-top:6px">
          <input id="addr" autocomplete="off" placeholder="Search a location…" />
          <div id="suggest" class="suggest"></div>
        </div>
        <div id="mapwrap" style="display:none;margin-top:10px">
          <div class="maparea"><div id="map" class="map"></div><div class="pin">📍</div></div>
          <button type="button" id="useloc" class="ghost small" style="margin-top:8px">📍 Use my current location</button>
        </div>
        <label>Building / Apartment / Landmark (you can edit this)</label>
        <input id="premise" placeholder="e.g. XYZ Apartment" />
        <label>Street, area, city, state (from map — can't change)</label>
        <input id="locked" readonly placeholder="Move the map or search to set this" />
        <label>Flat / Floor / door no. (optional)</label>
        <input id="line1" placeholder="e.g. Flat 4B, 2nd floor" />
        <div class="row" style="margin-top:10px">
          <button id="saveaddr" class="grow0">Save address</button>
          ${addresses.length ? '<button id="canceladd" class="ghost grow0">Cancel</button>' : ""}
        </div>
        <p id="addrmsg" class="muted"></p>`;
      initMapPicker();
      document.getElementById("saveaddr").onclick = saveAddress;
      document.getElementById("canceladd")?.addEventListener("click", () => renderAddrSection("list"));
    } else {
      // Compact: show only the selected (default) address; picker button if >1.
      const sel = addresses.find((a) => a.id === selectedAddrId) || addresses[0];
      box.innerHTML = `
        <div class="addr-card sel">
          <div style="flex:1">
            <strong>${esc(sel.contact_name || sel.line1 || "Address")}</strong>${sel.is_default ? ' <span class="tag">Default</span>' : ""}
            ${sel.contact_phone ? `<br><span class="muted">${esc(sel.contact_phone)}</span>` : ""}
            <br><span class="muted">${esc([sel.line1, sel.area].filter(Boolean).join(", "))}</span>
          </div>
        </div>
        <div class="row" style="margin-top:8px">
          ${addresses.length > 1 ? '<button class="ghost small" id="pickaddr">Select from address book</button>' : ""}
          <button class="ghost small" id="addnew">+ Add new address</button>
        </div>`;
      document.getElementById("addnew").onclick = () => renderAddrSection("add");
      document.getElementById("pickaddr")?.addEventListener("click", openAddressPicker);
    }
  }

  // Address-book picker modal (choose a different saved address).
  function openAddressPicker() {
    const listHtml = addresses
      .map(
        (a) => `<label class="addr-card${a.id === selectedAddrId ? " sel" : ""}">
          <input type="radio" name="pickaddr" value="${a.id}" ${a.id === selectedAddrId ? "checked" : ""} />
          <div style="flex:1">
            <strong>${esc(a.contact_name || a.line1 || "Address")}</strong>${a.is_default ? ' <span class="tag">Default</span>' : ""}
            ${a.contact_phone ? `<br><span class="muted">${esc(a.contact_phone)}</span>` : ""}
            <br><span class="muted">${esc([a.line1, a.area].filter(Boolean).join(", "))}</span>
            ${a.is_default ? "" : `<br><a href="#" class="setdef" data-id="${a.id}">Set as default</a>`}
          </div>
          <button type="button" class="ghost small grow0 delAddr" data-id="${a.id}">Delete</button>
        </label>`
      )
      .join("");
    openModal("Select address", listHtml + `<button id="pickaddnew" class="ghost small" style="margin-top:8px">+ Add new address</button>`);
    const root = document.getElementById("modal-overlay");
    root.querySelectorAll('input[name="pickaddr"]').forEach((r) => (r.onchange = () => { selectedAddrId = r.value; closeModal(); renderAddrSection("list"); }));
    root.querySelectorAll(".setdef").forEach(
      (a) =>
        (a.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await api(`/api/my/addresses/${a.dataset.id}/default`, { method: "POST" }).catch(() => {});
          await loadAddresses();
          openAddressPicker();
        })
    );
    root.querySelectorAll(".delAddr").forEach(
      (b) =>
        (b.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!confirm("Remove this saved address?")) return;
          const wasSel = selectedAddrId === b.dataset.id;
          await api(`/api/my/addresses/${b.dataset.id}`, { method: "DELETE" }).catch(() => {});
          await loadAddresses(wasSel);
          if (!addresses.length) { closeModal(); renderAddrSection("add"); }
          else openAddressPicker();
        })
    );
    document.getElementById("pickaddnew").onclick = () => { closeModal(); renderAddrSection("add"); };
  }

  async function loadAddresses(reselect) {
    try { addresses = (await api("/api/my/addresses")).addresses || []; } catch { addresses = []; }
    if (reselect || !addresses.some((a) => a.id === selectedAddrId)) selectedAddrId = addresses[0]?.id || null;
  }

  function initMapPicker() {
    const addr = document.getElementById("addr");
    const suggestBox = document.getElementById("suggest");
    const premiseEl = document.getElementById("premise");
    const lockedEl = document.getElementById("locked");
    const mapwrap = document.getElementById("mapwrap");
    mapState = { locked: "", lat: null, lng: null };

    // premise (editable landmark) fills the editable box; locked (street/city/
    // state) fills the read-only box the customer can't change.
    const setResolved = (premise, locked, lat, lng) => {
      mapState = { locked: locked || lockedEl.value, lat, lng };
      if (premise !== undefined && premise !== null) premiseEl.value = premise;
      if (locked) lockedEl.value = locked;
    };
    const closeSuggest = () => { suggestBox.innerHTML = ""; suggestBox.style.display = "none"; };
    let timer;
    addr.oninput = () => {
      clearTimeout(timer);
      const q = addr.value.trim();
      if (q.length < 3) return closeSuggest();
      timer = setTimeout(async () => {
        const u = new URLSearchParams({ q });
        if (bias) u.set("loc", bias);
        let data;
        try { data = await api(`/api/geo/suggest?${u}`); } catch { return; }
        if (data.notConfigured || !data.suggestions.length) return closeSuggest();
        suggestBox.innerHTML = data.suggestions
          .map((s, i) => `<div class="sg" data-i="${i}"><strong>${esc(s.placeName)}</strong><br><span class="muted">${esc(s.placeAddress || "")}</span></div>`)
          .join("");
        suggestBox.style.display = "block";
        suggestBox.querySelectorAll(".sg").forEach((n) => {
          n.onclick = () => {
            const s = data.suggestions[+n.dataset.i];
            setResolved(s.placeName, s.placeAddress, s.lat, s.lng);
            if (map && s.lat != null) map.jumpTo({ center: [s.lng, s.lat], zoom: 16 });
            closeSuggest();
          };
        });
      }, 300);
    };
    document.addEventListener("click", (e) => { if (suggestBox && !suggestBox.contains(e.target) && e.target !== addr) closeSuggest(); });

    (async () => {
      let key;
      try { key = (await api("/api/geo/mapkey")).key; } catch { key = null; }
      if (!key) return; // no key → search-only
      try {
        await loadMapLibre();
        if (map) { try { map.remove(); } catch {} map = null; }
        mapwrap.style.display = "block";
        const transformRequest = (url) => {
          if (url.includes("api.olamaps.io") && !url.includes("api_key=")) {
            const u = new URL(url); u.searchParams.set("api_key", key); return { url: u.toString() };
          }
          return { url };
        };
        map = new maplibregl.Map({
          container: "map",
          style: `https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json?api_key=${key}`,
          center: [78.9629, 20.5937],
          zoom: 4,
          transformRequest,
          attributionControl: false,
        });
        const reverseAtCentre = async () => {
          const cc = map.getCenter();
          try {
            const r = await api(`/api/geo/reverse?lat=${cc.lat}&lng=${cc.lng}`);
            setResolved(r?.premise ?? premiseEl.value, r?.locked || lockedEl.value, cc.lat, cc.lng);
          } catch { setResolved(premiseEl.value, lockedEl.value, cc.lat, cc.lng); }
        };
        map.on("dragend", reverseAtCentre);
        map.on("load", () => { if (bias) { const [la, ln] = bias.split(","); map.jumpTo({ center: [+ln, +la], zoom: 16 }); reverseAtCentre(); } });
      } catch { mapwrap.style.display = "none"; }
    })();

    document.getElementById("useloc").onclick = () => {
      navigator.geolocation?.getCurrentPosition(
        (p) => { const { latitude: la, longitude: ln } = p.coords; if (map) { map.jumpTo({ center: [ln, la], zoom: 17 }); map.fire("dragend"); } else setResolved(premiseEl.value, lockedEl.value, la, ln); },
        () => { const m = document.getElementById("addrmsg"); m.className = "err"; m.textContent = "Couldn't get your location — search above instead."; }
      );
    };
  }

  async function saveAddress() {
    const msg = document.getElementById("addrmsg");
    const name = document.getElementById("cname").value.trim();
    const phone = document.getElementById("cphone").value.replace(/[^\d]/g, "");
    const premise = document.getElementById("premise").value.trim(); // editable landmark
    const extra = document.getElementById("line1").value.trim();     // optional flat/floor
    const locked = document.getElementById("locked").value.trim();   // map street/city/state
    if (!name) { msg.className = "err"; msg.textContent = "Add a contact name."; return; }
    if (phone.length < 10) { msg.className = "err"; msg.textContent = "Add a valid contact phone."; return; }
    if (!locked) { msg.className = "err"; msg.textContent = "Set the location — search or move the map."; return; }
    // line1 = the customer-editable bits (landmark + flat/floor); area = locked map part.
    const line1 = [premise, extra].filter(Boolean).join(", ");
    try {
      const r = await api("/api/my/addresses", { method: "POST", body: { name, phone, line1, area: locked, lat: mapState.lat, lng: mapState.lng } });
      selectedAddrId = r.address.id; // select the just-added address
      await loadAddresses();          // refresh ordering + default flags from server
      renderAddrSection("list");
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  }

  renderAddrSection(addresses.length ? "list" : "add");

  document.getElementById("submit").onclick = async () => {
    const items = [...picker.querySelectorAll(".pick-row")]
      .map((r) => ({ name: r.dataset.name, qty: Math.max(0, parseInt(r.querySelector(".qnum")?.value, 10) || 0) }))
      .filter((i) => i.qty > 0)
      // items read from the photos (merged by name); carry the written weight into the
      // name for shop-priced items so the shop sees "Toor dal (3 kg)" on the order.
      .concat(photoItems.map((it) => ({ name: it.amount && !it.price ? `${it.name} (${it.amount})` : it.name, qty: it.qty })));
    const images = photoImages.map((im) => im.thumb);
    const msg = document.getElementById("msg");
    if (!selectedAddrId) { msg.className = "err"; msg.textContent = "Select or add a service address."; return; }
    if (!items.length) { msg.className = "err"; msg.textContent = "Add at least one item (use + to set quantity) or upload a photo."; return; }
    try {
      await api("/api/my/orders", {
        method: "POST",
        body: {
          slug,
          address_id: selectedAddrId,
          items,
          note: document.getElementById("note").value,
          images,
          payment_method: el.querySelector(".pm.sel")?.dataset.pm, // only when the shop offers both
        },
      });
      renderCustomer(slug);
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
}

// The payment card on a customer's order. Only rendered for a UPI order the shop
// has accepted and not yet confirmed as paid (`pay` is null otherwise), plus a
// confirmation once it IS paid.
function payCardHtml(order, pay) {
  if (order.payment_status === "paid") {
    return `<div class="card"><h2>Payment</h2>
      <p class="small" style="margin:0"><b style="color:#0a7">✅ Payment confirmed</b> — thank you.</p>
      ${order.payment_receipt ? `<a href="${order.payment_receipt}" target="_blank" rel="noopener" style="display:inline-block;margin-top:10px"><img class="rcpt" src="${order.payment_receipt}" alt="your payment receipt" /></a>` : ""}</div>`;
  }
  if (!pay) return "";
  if (pay.misconfigured) {
    return `<div class="card"><h2>Payment</h2>
      <p class="small" style="margin:0">This shop hasn't set up online payment yet. Please contact them to pay.</p></div>`;
  }
  // Receipt sent, shop hasn't decided → nothing more for the customer to do.
  if (pay.status === "submitted") {
    return `<div class="card"><h2>Payment</h2>
      <p class="small" style="margin:0">🕗 <b>Payment under review</b> — we've sent your receipt to the shop. You'll get a WhatsApp message once it's confirmed.</p>
      <details style="margin-top:8px"><summary class="muted small">Sent the wrong receipt? Upload another</summary>
        ${payUploadHtml()}</details></div>`;
  }
  const rejected = pay.status === "rejected";
  // No "Pay now" intent link: upi:// deep links only work for gateway-issued
  // dynamic QRs. These are static merchant QRs, where the intent silently fails
  // or drops the amount — so the QR is the only honest path. Revisit if/when a
  // payment gateway is wired in.
  // Display the QR as a raster <img> (the token PNG endpoint), NOT the inline SVG:
  // an <img> can be long-pressed → "Save/Download image", which is the ONE way to
  // save that works inside WhatsApp's in-app browser (its WebView has no download
  // manager, so the button's programmatic download silently fails there).
  return `<div class="card"><h2>Pay ₹${esc(pay.amount)}</h2>
    ${rejected ? `<p class="small err" style="margin:0 0 8px">The shop couldn't verify your last receipt. Please pay and upload a clear screenshot.</p>` : ""}
    <p class="muted small" style="margin:0 0 8px">Scan this QR with any UPI app (GPay, PhonePe, Paytm…) and pay <b>₹${esc(pay.amount)}</b>.</p>
    <div class="qrbox"><img src="${esc(pay.qrUrl)}" alt="UPI QR to pay ₹${esc(pay.amount)}" /></div>
    <p class="muted small" style="text-align:center;margin:6px 0 0">${esc(pay.upi_name || "")} · ${esc(pay.upi_id || "")}</p>
    <p class="muted small" style="text-align:center;margin:8px 0 0">Paying on this phone? <b>Press &amp; hold the QR → Save image</b>, then use <b>Scan from gallery</b> in your UPI app.</p>
    <div class="row" style="justify-content:center;margin-top:10px">
      <a class="ghost small grow0" id="qrsave" style="text-decoration:none;text-align:center"
         href="${esc(pay.qrUrl)}"
         download="${esc(order.id)}-upi-qr.png">⬇️ Or tap to save</a>
    </div>
    <p id="qrsaveMsg" class="muted small" style="margin:8px 0 0"></p>
    <p class="small" style="margin:12px 0 6px"><b>After paying, upload the receipt</b> so the shop can confirm and start your order.</p>
    ${payUploadHtml()}</div>`;
}

// Get the QR PNG into the phone's gallery. A plain <a download> pointing at a
// server URL is unreliable on mobile — the browser tends to just navigate to and
// display the image. So we fetch the bytes in-page (the token URL needs no
// cookie), then hand them off through the most capable path available:
//   1. Web Share with a File → native share sheet's "Save image / Download" —
//      the real "save to gallery" action on Android + iOS, and it also sidesteps
//      the WhatsApp-webview cookie/download issues since the fetch is in-page.
//   2. A blob object-URL download — forces a save where the plain anchor wouldn't.
//   3. Open the image so the user can long-press → Save image (last resort).
async function saveQrToGallery(url, filename, msgEl) {
  const hint = "📱 Paying on this phone? Save the QR, then use <b>Scan from gallery</b> in your UPI app.";
  const say = (t, ok) => { if (msgEl) { msgEl.innerHTML = t; msgEl.className = ok === false ? "small err" : "muted small"; } };
  say("Saving…");
  let blob;
  try {
    const res = await fetch(url); // token URL → works without a session cookie
    if (!res.ok) throw new Error("fetch " + res.status);
    blob = await res.blob();
  } catch (e) {
    window.open(url, "_blank"); // can't fetch → at least show it so they can long-press → Save image
    say("Opened the QR — long-press it and choose <b>Save image</b>.");
    return;
  }
  const file = new File([blob], filename, { type: "image/png" });

  // iOS has no reliable blob-download-to-gallery; its native path is the share
  // sheet's "Save Image" (→ Photos). Android + desktop download blob URLs directly,
  // which is the one-tap "save" people expect — a share sheet there just adds steps.
  const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS masquerades as Mac
  if (iOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Payment QR" }); say(hint); return; }
    catch (e) { if (e && e.name === "AbortError") { say(hint); return; } /* else fall through */ }
  }

  // In-app WebviewS (WhatsApp, FB, Instagram) have NO download manager, so a
  // programmatic blob download silently no-ops — claiming "Saved" there is a lie.
  // Detect that context (Android WebView tags its UA "; wv"; WhatsApp's browser is
  // one) and, since Web Share is also usually unavailable, tell them the truth:
  // press-and-hold the QR image above, which the WebView CAN save.
  const inAppWebView = /; wv\)/.test(navigator.userAgent) || /\b(FBAN|FBAV|Instagram|Line)\b/.test(navigator.userAgent);
  if (inAppWebView) {
    say("Couldn't auto-save here. <b>Press &amp; hold the QR above → Save image</b>, then use <b>Scan from gallery</b> in your UPI app.", false);
    return;
  }

  // Real browser: force a download from a blob object URL. Unlike a plain <a>
  // pointing at the server URL — which browsers tend to just DISPLAY inline — a
  // blob download is forced. Android Chrome lands it in Downloads (in the gallery).
  try {
    const obj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = obj; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(obj), 5000);
    // We can't get a completion event, so keep the long-press path in view as a
    // backstop rather than over-promising.
    say(`Saving <b>${esc(filename)}</b>… If it's not in Downloads/gallery, press &amp; hold the QR above → <b>Save image</b>.`);
  } catch (e) {
    window.open(url, "_blank");
    say("Opened the QR — press &amp; hold it and choose <b>Save image</b>.");
  }
}

function payUploadHtml() {
  return `<div class="row" style="gap:8px;margin-top:6px">
      <label class="ghost small grow0" style="cursor:pointer;margin:0">📁 Choose screenshot
        <input type="file" id="rcptFile" accept="image/*" hidden /></label>
      <label class="ghost small grow0" style="cursor:pointer;margin:0">📷 Camera
        <input type="file" id="rcptCam" accept="image/*" capture="environment" hidden /></label>
    </div>
    <p id="rcptMsg" class="small" style="margin:6px 0 0"></p>`;
}

// slug → Back returns to that shop's page. Without it we'd history.back() out of
// the app entirely (a WhatsApp deep-link has no in-app history behind it).
async function customerTrack(id, slug) {
  const { order, pay, feeLabel } = await api(`/api/my/orders/${id}`);
  const feeRow = order.delivery_fee
    ? `<div class="row" style="align-items:baseline"><span class="muted" style="flex:1">Items</span><span class="muted">${money(order.items_total)}</span></div>
       <div class="row" style="align-items:baseline"><span class="muted" style="flex:1">${esc(feeLabel || "Delivery fee")}</span><span class="muted">${money(order.delivery_fee)}</span></div>`
    : "";
  const items = order.items
    .map((i) => `<li>${esc(i.name)} × ${i.qty}${i.unit_price ? ` <span class="muted">— ${money(i.qty * i.unit_price)}</span>` : ""}</li>`)
    .join("");
  const tl = order.events.map((e) => `<li>${badge(e.status)} <span class="muted">${fmtDate(e.at)}</span></li>`).join("");
  const imgs = (order.images || []).map((im) => `<a href="${im.data}" target="_blank" rel="noopener" class="pthumb"><img src="${im.data}" alt="uploaded photo" /></a>`).join("");
  const courier = order.ship_mode === "courier";
  const dispatchLine = courier
    ? `<span class="muted">· 📦 ${order.courier_tracking ? "Shipped" : "Courier"}</span>`
    : order.agent_name ? `<span class="muted">· 🔧 ${esc(CFG.brand?.agentTerm || "Technician")}: ${esc(order.agent_name)}</span>`
    : order.delivery_captain_name ? `<span class="muted">· 🛵 ${esc(order.delivery_captain_name)}</span>` : "";
  const quoted = order.status === "QUOTED";
  h(`
    <div class="topbar"><h1>Order ${esc(order.id)}</h1><button class="ghost small" id="back">← Back</button></div>
    <div class="card">${badge(order.status)} ${dispatchLine}
      ${quoted ? `<p class="small" style="margin:8px 0 0">The shop has priced your order. Please review and confirm.</p>` : ""}
      <h2>Items</h2><ul>${items}</ul>
      ${feeRow}
      <div class="row" style="align-items:baseline"><strong style="flex:1">Total</strong><strong style="flex:0 0 auto;font-size:17px">${money(order.total)}</strong></div>
      ${quoted ? `<div class="row" style="gap:8px;margin-top:12px"><button id="qaccept">✅ Accept order</button><button id="qreject" class="ghost">Reject</button></div><p id="qmsg" class="small"></p>` : ""}
      ${courier && order.courier_tracking ? `<a href="${esc(order.courier_tracking)}" target="_blank" rel="noopener" class="paybtn" style="background:#0b7">📦 Track your shipment</a>` : ""}
      ${order.courier_receipt ? `<p class="muted small" style="margin:10px 0 4px">Courier receipt</p><a href="${order.courier_receipt}" target="_blank" rel="noopener"><img class="rcpt" src="${order.courier_receipt}" alt="courier receipt" /></a>` : ""}
      ${imgs ? `<h2>Your photos</h2><div class="pthumbs">${imgs}</div>` : ""}
      ${order.address ? `<p class="muted" style="margin-top:8px">${esc(order.address)}</p>` : ""}
    </div>
    ${payCardHtml(order, pay)}
    <div class="card"><h2>Progress</h2><ul class="timeline">${tl}</ul></div>`);
  document.getElementById("back").onclick = () => (slug ? renderCustomer(slug) : history.back());
  // Receipt upload (both the file and camera inputs feed the same handler).
  const rmsg = document.getElementById("rcptMsg");
  const sendReceipt = async (file) => {
    if (!file) return;
    rmsg.className = "small"; rmsg.textContent = "Uploading…";
    try {
      const image = await downscaleImg(file);
      await api(`/api/my/orders/${id}/receipt`, { method: "POST", body: { image } });
      customerTrack(id, slug); // re-render → "under review"
    } catch (e) {
      rmsg.className = "small err";
      rmsg.textContent = e.message === "bad_image" ? "That file isn't a readable image." : e.message;
    }
  };
  document.getElementById("rcptFile")?.addEventListener("change", (e) => sendReceipt(e.target.files?.[0]));
  document.getElementById("rcptCam")?.addEventListener("change", (e) => sendReceipt(e.target.files?.[0]));
  const qrsave = document.getElementById("qrsave");
  if (qrsave) qrsave.addEventListener("click", (e) => {
    e.preventDefault();
    saveQrToGallery(qrsave.getAttribute("href"), qrsave.getAttribute("download"), document.getElementById("qrsaveMsg"));
  });
  if (quoted) {
    const confirm2 = async (accept) => {
      const m = document.getElementById("qmsg");
      try { await api(`/api/my/orders/${id}/confirm`, { method: "POST", body: { accept } }); customerTrack(id, slug); }
      catch (e) { m.className = "small err"; m.textContent = e.message; }
    };
    document.getElementById("qaccept").onclick = () => confirm2(true);
    document.getElementById("qreject").onclick = () => { if (confirm("Reject this order? This cannot be undone.")) confirm2(false); };
  }
}

// ── Payment review (admin side) ─────────────────────────────────────────────
// The shop verifies the customer's UPI receipt. Groq's read is a hint only — the
// shop confirms, and confirming is what unlocks the rest of the flow.
function payReviewHtml(order, ex) {
  if (order.payment_method !== "upi") {
    return order.payment_status === "paid"
      ? `<div class="card"><h2>Payment</h2><p class="small" style="margin:0">✅ Paid${order.payment_ref ? ` · ${esc(order.payment_ref)}` : ""}</p></div>`
      : `<div class="card"><h2>Payment</h2><p class="muted small" style="margin:0">💵 Cash on delivery — collect ${money(order.total)} from the customer.</p></div>`;
  }
  if (order.payment_status === "paid") {
    return `<div class="card"><h2>Payment</h2>
      <p class="small" style="margin:0"><b style="color:#0a7">✅ Confirmed</b> — ${money(order.payment_amount || order.total)}${order.payment_ref ? ` · ref ${esc(order.payment_ref)}` : ""}${order.payment_payer ? ` · ${esc(order.payment_payer)}` : ""}</p>
      ${order.payment_receipt ? `<a href="${order.payment_receipt}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px"><img class="rcpt" src="${order.payment_receipt}" alt="payment receipt" /></a>` : ""}</div>`;
  }
  if (!order.payment_receipt) {
    return `<div class="card"><h2>Payment</h2>
      <p class="muted small" style="margin:0">🕗 Waiting for the customer to pay ${money(order.total)} and upload a receipt.${order.payment_status === "rejected" ? " (Their last receipt was rejected.)" : ""}</p></div>`;
  }
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
  return `<div class="card"><h2>Payment — review${via}</h2>
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

// ── Admin (provider) ─────────────────────────────────────────────────────────
function todayIST() {
  // YYYY-MM-DD for the current IST calendar day.
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}

// Unified role-gated dashboard: combines the order board and the super-admin
// console into one tabbed page. /admin and /console both land here.
async function renderDashboard(tab) {
  closeModal();
  const who = await me();
  if (!who.authenticated || (who.role !== "admin" && who.role !== "super_admin")) return adminLogin();

  const TABS = [
    { key: "orders", label: "Orders", roles: ["admin", "super_admin"], render: ordersTab },
    { key: "whatsapp", label: "WhatsApp", roles: ["super_admin"], render: whatsappTab },
    { key: "providers", label: "Providers", roles: ["super_admin"], render: providersTab },
    { key: "admins", label: "Admins", roles: ["super_admin"], render: adminsTab },
    { key: "account", label: "Account", roles: ["admin", "super_admin"], render: accountTab },
  ].filter((t) => t.roles.includes(who.role));
  const active = TABS.find((t) => t.key === tab) ? tab : "orders";

  h(`
    <div class="topbar"><div><h1>Dashboard</h1><span class="muted">Signed in as ${who.role.replace(/_/g, " ")}</span></div>
      <button class="ghost small" id="logout">Log out</button></div>
    <div class="tabs">${TABS.map((t) => `<button class="tab${t.key === active ? " active" : ""}" data-tab="${t.key}">${t.label}</button>`).join("")}</div>
    <div id="tabbody"><p class="muted">Loading…</p></div>`);
  document.getElementById("logout").onclick = logout;
  el.querySelectorAll(".tab").forEach((b) => (b.onclick = () => renderDashboard(b.dataset.tab)));
  TABS.find((t) => t.key === active).render(document.getElementById("tabbody"), who);
}

// ── Live updates (WebSocket → orders hub) ───────────────────────────────────
// Scope is derived server-side from the session (super-admin = all providers,
// provider-admin = their provider), so no query param is needed here.
let _ws = null, _liveTimer = null, _liveOn = false, _adminReload = null;
function liveConnect() {
  if (_liveOn && _ws && _ws.readyState <= 1) return;
  _liveOn = true;
  try { if (_ws) _ws.close(); } catch {}
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = (_ws = new WebSocket(`${proto}//${location.host}/api/ws`));
  ws.onmessage = (e) => { try { if (JSON.parse(e.data).type === "orders_changed") liveRefresh(); } catch {} };
  ws.onclose = () => { if (_ws === ws) { _ws = null; if (_liveOn) setTimeout(liveConnect, 3000); } };
}
function liveDisconnect() { _liveOn = false; try { if (_ws) _ws.close(); } catch {} _ws = null; }
function liveRefresh() {
  clearTimeout(_liveTimer);
  _liveTimer = setTimeout(() => { if (document.getElementById("adminOrdersMarker") && _adminReload) _adminReload(); }, 400);
}

// ── Orders tab (the board) ───────────────────────────────────────────────────
async function ordersTab(container) {
  liveConnect();
  const today = todayIST();
  container.innerHTML = `<div id="adminOrdersMarker" hidden></div>`;
  container.innerHTML += `
    <div class="card">
      <h2>Filter by date</h2>
      <div class="row">
        <div><label>From</label><input type="date" id="from" value="${today}" /></div>
        <div><label>To</label><input type="date" id="to" value="${today}" /></div>
        <div class="grow0" style="align-self:end"><button class="small" id="apply">Apply</button></div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="ghost small" id="today">Today</button>
        <button class="ghost small" id="week">Last 7 days</button>
      </div>
      <label>Status</label>
      <select id="statusFilter">
        <option value="">All statuses</option>
        ${[...(CFG.flow.statuses || []), ...((CFG.flow.terminal || []).filter((t) => !(CFG.flow.statuses || []).includes(t)))]
          .map((s) => `<option value="${esc(s)}">${esc(s.replace(/_/g, " "))}</option>`).join("")}
      </select>
    </div>
    <div class="stats" id="stats"></div>
    <div class="card" id="list"><p class="muted">Loading…</p></div>`;

  let loaded = [];   // orders for the current range
  let filter = null; // active filter: a TILE group key OR an exact status

  // KPI tiles: total + one bucket per stage group (derived from the flow). Clicking filters the list.
  const B = statusBuckets();
  const TILES = [
    { key: null, label: "Total", accent: true, match: () => true },
    { key: "REQUESTED", label: "New", match: (s) => s === B.from },
    { key: "ACTIVE", label: "In progress", match: (s) => B.active.includes(s) },
    { key: "DONE", label: "Completed", match: (s) => B.terminal.includes(s) && s !== B.reject },
    { key: "REJECTED", label: "Rejected", match: (s) => s === B.reject },
  ];

  // Single source of truth for the active filter; keeps tiles + dropdown in sync.
  const setFilter = (f) => {
    filter = f || null;
    const sel = document.getElementById("statusFilter");
    // sync dropdown: exact statuses map to an option; group keys (ACTIVE) clear it
    sel.value = filter && [...sel.options].some((o) => o.value === filter) ? filter : "";
    renderStats();
    renderList();
  };

  const renderStats = () => {
    document.getElementById("stats").innerHTML = TILES.map((t) => {
      const n = loaded.filter((o) => t.match(o.status)).length;
      const active = filter === t.key ? " active" : "";
      return `<div class="tile${t.accent ? " accent" : ""}${active}" data-key="${t.key}">
        <div class="n">${n}</div><div class="l">${t.label}</div></div>`;
    }).join("");
    document.querySelectorAll("#stats .tile").forEach((el2) => {
      el2.onclick = () => {
        const k = el2.dataset.key === "null" ? null : el2.dataset.key;
        setFilter(filter === k ? null : k);
      };
    });
  };

  const renderList = () => {
    const list = document.getElementById("list");
    const tile = TILES.find((t) => t.key === filter);
    // filter: none → all; a tile group → tile.match; otherwise an exact status
    const rows = loaded.filter((o) => (!filter ? true : tile ? tile.match(o.status) : o.status === filter));
    if (!rows.length) { list.innerHTML = '<p class="muted">No orders to show.</p>'; return; }
    list.innerHTML = rows
      .map(
        (o) => `<div class="order-line" data-id="${o.id}">
          <div><strong>${esc(o.id)}</strong> <span class="amt">${money(o.total)}</span> ${paidPill(o)}<br><span class="muted">${fmtDate(o.created_at)}${o.agent_name ? " · " + esc(o.agent_name) : ""}</span></div>
          ${badge(o.status)}
        </div>`
      )
      .join("");
    list.querySelectorAll(".order-line").forEach((n) => (n.onclick = () => adminOrder(n.dataset.id)));
  };

  const load = async () => {
    const from = document.getElementById("from").value;
    const to = document.getElementById("to").value;
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    const { orders } = await api(`/api/admin/orders?${q.toString()}`);
    loaded = orders;
    setFilter(null); // resets tiles + dropdown, re-renders
  };

  document.getElementById("statusFilter").onchange = (e) => setFilter(e.target.value);
  document.getElementById("apply").onclick = load;
  document.getElementById("today").onclick = () => {
    document.getElementById("from").value = document.getElementById("to").value = todayIST();
    load();
  };
  document.getElementById("week").onclick = () => {
    document.getElementById("from").value = new Date(Date.now() + 330 * 60000 - 6 * 864e5).toISOString().slice(0, 10);
    document.getElementById("to").value = todayIST();
    load();
  };
  _adminReload = load; // let live updates re-fetch with the current filters
  load(); // initial: today
}

async function adminOrder(id) {
  const { order, customer, allowedNext, captains = [], fulfilment = "delivery", payExtracted = null, paymentBlocked = false, feeKind = null } = await api(`/api/admin/orders/${id}`);
  const isPhoto = (order.images || []).length > 0; // photo/list order → quote-and-confirm
  let draftItems = (order.items || []).map((i) => ({ name: i.name, qty: i.qty, price: i.unit_price || 0 }));
  let draftFee = order.delivery_fee || 0; // shop-set courier/delivery fee (paise)
  const items = order.items
    .map((i) => `<li>${esc(i.name)} × ${i.qty}${i.unit_price ? ` <span class="muted">— ${money(i.qty * i.unit_price)}</span>` : ""}</li>`)
    .join("");
  const tl = order.events.map((e) => `<li>${badge(e.status)} <span class="muted">${fmtDate(e.at)} · ${esc(e.actor)}</span></li>`).join("");

  // Build the action control based on where the order is in its lifecycle.
  // After acceptance the order advances exactly one step at a time.
  let controls;
  if (order.status === "REQUESTED") {
    controls = `
      <p class="muted">${isPhoto ? "Review the items, set a price on each, then send the quote to the customer to confirm." : "This request is awaiting your decision."}</p>
      <div id="edititems"></div>
      ${feeKind ? `<div class="row" style="align-items:center;margin-top:8px"><label style="flex:1;margin:0">${feeKind === "courier" ? "Courier" : "Delivery"} fee</label><div class="row grow0" style="gap:4px;align-items:center">₹<input id="draftFee" type="number" min="0" step="0.01" value="${(draftFee / 100).toFixed(2)}" style="width:80px" /></div></div>` : ""}
      <div class="row" style="align-items:baseline;margin-top:8px"><strong style="flex:1">Total</strong><strong id="draftTotal" style="font-size:16px">${money(0)}</strong></div>
      <div class="row" style="gap:6px;margin-top:10px;align-items:flex-end">
        <div style="flex:1"><label>Add item</label><input id="ni_name" placeholder="e.g. Tomato" /></div>
        <div><label>Qty</label><input id="ni_qty" type="number" min="1" value="1" style="width:56px" /></div>
        <div><label>₹</label><input id="ni_price" type="number" min="0" step="0.01" placeholder="0" style="width:70px" /></div>
        <button class="grow0 ghost small" id="ni_add">Add</button>
      </div>
      <div class="row" style="margin-top:12px">
        <button id="accept">${isPhoto ? "Price & send quote" : "Accept"}</button>
        <button id="reject" class="ghost">Reject</button>
      </div>
      <p id="msg"></p>`;
  } else if (order.status === "QUOTED") {
    controls = `<p class="muted">⏳ Quote sent — awaiting the customer's confirmation.</p><p id="msg"></p>`;
  } else if (allowedNext.length) {
    const next = allowedNext[0]; // single forward step
    const nextLabel = next.replace(/_/g, " ");
    let agentField = "";
    // Show the agent picker when this step is a flow assignment point.
    const asg = (CFG.flow.assignments || []).find((a) => a.at === next);
    const forcedCourier = asg && asg.role === "courier";
    const courierable = asg && asg.role === "delivery" && (fulfilment === "courier" || fulfilment === "both");
    const onsite = asg && asg.role !== "courier" && !(CFG.flow.assignments || []).some((a) => a.role === "delivery");
    if (asg) {
      const term = CFG.brand?.agentTerm || "agent";
      const isDelivery = asg.slot === "delivery";
      const label = `Assign ${term.toLowerCase()}`;
      const current = isDelivery ? order.delivery_captain_name : order.agent_name;
      let picker;
      if (captains.length) {
        const opts = `<option value="">Select…</option>` +
          captains.map((c) => `<option value="${c.id}" data-name="${esc(c.name || "")}" data-phone="${esc(c.phone || "")}" ${current === c.name ? "selected" : ""}>${esc(c.name || term)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("");
        picker = `<select id="agent">${opts}</select>`;
      } else {
        picker = `<p class="muted">No ${term.toLowerCase()}s for this provider yet — add them in Providers → Edit → Captains.</p><input id="agent" value="${esc(current || "")}" placeholder="${term} name" />`;
      }
      const courierInputs = `<label>Tracking link <span class="muted small">(optional)</span></label>
        <input id="courierTracking" type="url" value="${esc(order.courier_tracking || "")}" placeholder="https://… courier tracking URL" />
        <label style="margin-top:8px">Courier receipt photo <span class="muted small">(optional)</span></label>
        <div class="row" style="gap:8px;align-items:center;margin-top:2px">
          <img id="crcptprev" src="${order.courier_receipt || ""}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;border:1px solid var(--border);${order.courier_receipt ? "" : "display:none"}" />
          <label class="ghost small grow0" style="cursor:pointer;margin:0">📷 ${order.courier_receipt ? "Change" : "Add"} receipt<input type="file" id="crcpt" accept="image/*" hidden /></label>
          <span id="crcptname" class="muted small"></span>
        </div>
        <p class="muted small" style="margin:4px 0 0">Add a tracking link, a receipt photo, or both. We'll send the link to the customer.</p>`;
      if (forcedCourier) {
        agentField = courierInputs;
      } else if (courierable) {
        const startCourier = fulfilment === "courier";
        agentField = `
          ${fulfilment === "both" ? `<label>Fulfilment</label><div class="row" style="gap:6px;margin-bottom:6px"><button type="button" class="ghost small grow0 fmode${startCourier ? "" : " sel"}" data-mode="delivery">🛵 Own agent</button><button type="button" class="ghost small grow0 fmode${startCourier ? " sel" : ""}" data-mode="courier">📦 Courier</button></div>` : ""}
          <div id="deliverFields" style="display:${startCourier ? "none" : "block"}"><label>${label}</label>${picker}</div>
          <div id="courierFields" style="display:${startCourier ? "block" : "none"}">${courierInputs}</div>`;
      } else if (onsite && captains.length) {
        const assigned = new Set((order.assignees || []).map((a) => a.phone));
        agentField = `<label>Assign ${term.toLowerCase()}s <span class="muted small">— pick one or more</span></label>
          <div id="multiCaptains">${captains.map((c) => `<label class="row" style="gap:8px;align-items:center;cursor:pointer;margin:4px 0"><input type="checkbox" class="mcap" data-name="${esc(c.name || "")}" data-phone="${esc(c.phone || "")}" ${assigned.has(c.phone) ? "checked" : ""} style="width:auto;margin:0" /><span>${esc(c.name || term)}${c.phone ? ` <span class="muted">· ${esc(c.phone)}</span>` : ""}</span></label>`).join("")}</div>`;
      } else {
        agentField = `<label>${label}</label>${picker}`;
      }
    }
    // A UPI order can't move past accept until payment is confirmed — say so
    // instead of offering a button that will 400.
    controls = paymentBlocked
      ? `<p class="muted" style="margin:0">💳 Waiting on payment — confirm the customer's payment below before starting this order.</p>`
      : `
      ${agentField}
      <button id="save" data-next="${next}" data-courierable="${courierable ? 1 : 0}" data-forcedcourier="${forcedCourier ? 1 : 0}" data-onsite="${onsite && captains.length ? 1 : 0}" data-start="${courierable && fulfilment === "courier" ? "courier" : "delivery"}" style="margin-top:12px">Advance to ${nextLabel} & notify</button>
      <p id="msg"></p>`;
  } else {
    controls = `<p class="muted">${order.status === "REJECTED" ? "This request was rejected — no further action." : "Order delivered — complete."}</p>`;
  }

  h(`
    <div class="topbar"><h1>Order ${esc(order.id)}</h1><button class="ghost small" id="back">← Back</button></div>
    <div class="card">
      ${badge(order.status)}
      ${(order.assignees || []).length > 1
        ? `<p class="muted" style="margin-top:8px">🔧 ${esc(CFG.brand?.agentTerm || "Technician")}s: ${order.assignees.map((a) => `${esc(a.name || a.phone)}${a.phone ? ` <a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>` : ""}`).join(", ")}</p>`
        : order.agent_name ? `<p class="muted" style="margin-top:8px">🔧 ${esc(CFG.brand?.agentTerm || "Technician")}: ${esc(order.agent_name)}${order.captain_phone ? ` · <a href="tel:${esc(order.captain_phone)}">${esc(order.captain_phone)}</a>` : ""}</p>` : ""}
      ${order.delivery_captain_name ? `<p class="muted" style="margin-top:4px">🛵 ${esc(order.delivery_captain_name)}${order.delivery_captain_phone ? ` · <a href="tel:${esc(order.delivery_captain_phone)}">${esc(order.delivery_captain_phone)}</a>` : ""}</p>` : ""}
      ${order.ship_mode === "courier" && order.courier_tracking ? `<p class="muted" style="margin-top:4px">📦 Tracking: <a href="${esc(order.courier_tracking)}" target="_blank" rel="noopener">${esc(order.courier_tracking)}</a></p>` : ""}
      ${order.courier_receipt ? `<a href="${order.courier_receipt}" target="_blank" rel="noopener" style="display:inline-block;margin-top:6px"><img class="rcpt" src="${order.courier_receipt}" alt="courier receipt" style="max-width:150px;max-height:190px" /></a>` : ""}
      <h2>Customer</h2>
      <p>${esc(customer?.name || "—")} · ${esc(customer?.wa_phone || "")}</p>
      ${order.contact_name || order.contact_phone ? `<p class="muted">Pickup contact: ${esc(order.contact_name || "")}${order.contact_phone ? " · " + esc(order.contact_phone) : ""}</p>` : ""}
      ${order.address ? `<p class="muted">${esc(order.address)}</p>` : ""}
      ${order.lat != null ? `<p class="muted">📍 <a href="https://www.google.com/maps?q=${order.lat},${order.lng}" target="_blank" rel="noopener">${(+order.lat).toFixed(5)}, ${(+order.lng).toFixed(5)} — view on map</a></p>` : ""}
      <h2>Items</h2><ul>${items}</ul>
      ${order.delivery_fee ? `<div class="row" style="align-items:baseline"><span class="muted small" style="flex:1">Items</span><span class="muted small">${money(order.items_total)}</span></div><div class="row" style="align-items:baseline"><span class="muted small" style="flex:1">${feeKind === "courier" ? "Courier" : "Delivery"} fee</span><span class="muted small">${money(order.delivery_fee)}</span></div>` : ""}
      <div class="row" style="align-items:baseline"><strong style="flex:1">Total</strong><strong style="flex:0 0 auto;font-size:17px">${money(order.total)}</strong></div>
    </div>
    ${payReviewHtml(order, payExtracted)}
    <div class="card"><h2>Action</h2>${controls}</div>
    <div class="card"><h2>History</h2><ul class="timeline">${tl}</ul></div>`);
  wirePayReview(order, id, () => adminOrder(id));
  document.getElementById("back").onclick = () => renderDashboard("orders");

  const patch = async (status, agentName, captainPhone, courier) => {
    const msg = document.getElementById("msg");
    try {
      await api(`/api/admin/orders/${id}/status`, { method: "PATCH", body: { status, agentName, captainPhone, ...(courier || {}) } });
      adminOrder(id); // reload with the new status + controls
    } catch (e) {
      msg.className = "err";
      msg.textContent = e.message === "invalid_transition" ? "That status change isn't allowed." : e.message;
    }
  };
  // Courier receipt photo upload (undefined = leave as-is; string = new photo).
  let courierReceipt;
  const crcptEl = document.getElementById("crcpt");
  if (crcptEl) crcptEl.onchange = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const nm = document.getElementById("crcptname");
    try { courierReceipt = await downscaleImg(f); const p = document.getElementById("crcptprev"); p.src = courierReceipt; p.style.display = ""; nm.className = "muted small"; nm.textContent = "✓ receipt ready"; }
    catch { nm.className = "small err"; nm.textContent = "couldn't read image"; }
  };
  // Delivery ↔ courier toggle (rendered only when the provider allows courier).
  let shipMode = document.getElementById("save")?.dataset.start === "courier" ? "courier" : "delivery";
  document.querySelectorAll(".fmode").forEach((b) => (b.onclick = () => {
    shipMode = b.dataset.mode;
    document.querySelectorAll(".fmode").forEach((x) => x.classList.toggle("sel", x === b));
    const df = document.getElementById("deliverFields"), cf = document.getElementById("courierFields");
    if (df) df.style.display = shipMode === "courier" ? "none" : "block";
    if (cf) cf.style.display = shipMode === "courier" ? "block" : "none";
  }));

  // REQUESTED item editor (reconcile + price) — mirrors the manager app.
  const ebox = document.getElementById("edititems");
  if (ebox) {
    const recalcDraft = () => { const el = document.getElementById("draftTotal"); if (el) el.textContent = money(draftItems.reduce((s, it) => s + (it.price || 0) * it.qty, 0) + draftFee); };
    const feeEl = document.getElementById("draftFee");
    if (feeEl) feeEl.onchange = () => { draftFee = Math.round((parseFloat(feeEl.value) || 0) * 100); recalcDraft(); };
    const paint = () => {
      ebox.innerHTML = draftItems.length
        ? draftItems.map((it, idx) => `<div class="summary-line" data-idx="${idx}"><span style="flex:1">${esc(it.name)}</span><input class="dprice" type="number" min="0" step="0.01" value="${it.price ? (it.price / 100) : ""}" placeholder="₹" style="width:64px;margin-right:6px" /><div class="qtyctrl"><button type="button" class="qbtn dminus">−</button><input class="qnum dqty" type="number" min="1" value="${it.qty}" style="width:46px" /><button type="button" class="qbtn dplus">+</button></div><button type="button" class="qbtn drm" style="margin-left:6px">✕</button></div>`).join("")
        : '<p class="muted small">No items — add at least one.</p>';
      ebox.querySelectorAll(".summary-line").forEach((row) => {
        const idx = +row.dataset.idx, num = row.querySelector(".dqty"), pr = row.querySelector(".dprice");
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

  const acceptBtn = document.getElementById("accept");
  if (acceptBtn) {
    acceptBtn.onclick = async () => {
      const msg = document.getElementById("msg");
      if (!draftItems.length) { msg.className = "err"; msg.textContent = "Add at least one item."; return; }
      try {
        await api(`/api/admin/orders/${id}/items`, { method: "PATCH", body: { items: draftItems.map((i) => ({ name: i.name, qty: i.qty, price: i.price || 0 })), deliveryFee: draftFee } });
      } catch (e) { msg.className = "err"; msg.textContent = e.message === "not_editable" ? "Order already moved on." : e.message; return; }
      patch(isPhoto ? "QUOTED" : "ACCEPTED");
    };
    document.getElementById("reject").onclick = () => {
      if (confirm("Reject this request? This is final — no further action can be taken.")) patch("REJECTED");
    };
  }
  const saveBtn = document.getElementById("save");
  if (saveBtn) {
    saveBtn.onclick = () => {
      if (saveBtn.dataset.forcedcourier === "1" || (saveBtn.dataset.courierable === "1" && shipMode === "courier")) {
        const ct = document.getElementById("courierTracking")?.value.trim() || "";
        const m = document.getElementById("msg");
        if (ct && !/^https?:\/\//i.test(ct)) { m.className = "err"; m.textContent = "Enter a valid link starting with http:// or https://"; return; }
        if (!ct && courierReceipt === undefined && !order.courier_receipt) { m.className = "err"; m.textContent = "Add a tracking link or a receipt photo."; return; }
        patch(saveBtn.dataset.next, "", "", { shipMode: "courier", courierTracking: ct, ...(courierReceipt !== undefined ? { courierReceipt } : {}) });
        return;
      }
      if (saveBtn.dataset.onsite === "1") {
        const assignees = [...document.querySelectorAll(".mcap:checked")].map((b) => ({ name: b.dataset.name, phone: b.dataset.phone }));
        if (!assignees.length) { const m = document.getElementById("msg"); m.className = "err"; m.textContent = "Pick at least one captain."; return; }
        patch(saveBtn.dataset.next, "", "", { assignees });
        return;
      }
      const elc = document.getElementById("agent");
      let agentName = "", captainPhone = "";
      if (elc) {
        if (elc.tagName === "SELECT") { const o = elc.selectedOptions[0]; agentName = o?.dataset.name || ""; captainPhone = o?.dataset.phone || ""; }
        else agentName = elc.value;
      }
      patch(saveBtn.dataset.next, agentName, captainPhone);
    };
  }
}

function adminLogin() {
  h(`
    <div class="topbar"><h1>Provider login</h1></div>
    <div class="card">
      <label>Email</label><input id="email" type="email" />
      <label>Password</label><input id="password" type="password" />
      <button id="login" style="margin-top:12px">Log in</button>
      <p id="msg"></p>
    </div>`);
  document.getElementById("login").onclick = async () => {
    const msg = document.getElementById("msg");
    try {
      await api("/auth/admin/login", {
        method: "POST",
        body: { email: document.getElementById("email").value, password: document.getElementById("password").value },
      });
      renderDashboard();
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
}

// ── WhatsApp tab (super-admin) ───────────────────────────────────────────────
async function whatsappTab(container) {
  const settings = await api("/api/console/settings");
  container.innerHTML = `
    <div class="card">
      <h2>WhatsApp / Meta integration</h2>
      <label>Webhook URL — paste this into the Meta app dashboard</label>
      <div class="row">
        <input id="hook" readonly value="${esc(settings.webhook_url)}" />
        <button class="ghost small grow0" id="copyhook">Copy</button>
      </div>
      <label>Verify token — set the same value in Meta's webhook config</label>
      <div class="row">
        <input id="s_verify" value="${esc(settings.verify_token)}" placeholder="choose any string" />
        <button class="ghost small grow0" id="gen">Generate</button>
      </div>
      <label>App Secret ${settings.app_secret_set ? "· <span class='ok'>set</span> (leave blank to keep)" : "· not set"}</label>
      <input id="s_secret" type="password" placeholder="${settings.app_secret_set ? "•••••• unchanged" : "from Meta → App settings"}" />
      <label>Access token ${settings.token_set ? "· <span class='ok'>set</span> (leave blank to keep)" : "· not set"}</label>
      <input id="s_token" type="password" placeholder="${settings.token_set ? "•••••• unchanged" : "Meta permanent token"}" />
      <label>Graph API version</label><input id="s_ver" value="${esc(settings.api_version)}" />
      <label>Captain login WhatsApp number — the number captains message to log in (with country code, digits only)</label>
      <input id="s_num" value="${esc(settings.wa_display_number)}" placeholder="e.g. 919876543210" inputmode="numeric" />
      <button id="s_save" style="margin-top:12px">Save WhatsApp settings</button>
      <p id="s_msg" class="muted">In Meta → WhatsApp → Configuration, set the callback URL + verify token above, then subscribe to the <code>messages</code> field.</p>
    </div>

    <div class="card">
      <h2>Maps (Ola Maps) — address autocomplete</h2>
      <p class="muted">Used on the customer order form to search &amp; geocode the pickup address. Get an API key from your Ola Maps (Krutrim) developer console.</p>
      <label>API key ${settings.maps_set ? "· <span class='ok'>set</span> (leave blank to keep)" : "· not set"}</label>
      <input id="m_key" type="password" placeholder="${settings.maps_set ? "•••••• unchanged" : "Ola Maps API key"}" />
      <button id="m_save" style="margin-top:12px">Save Ola Maps settings</button>
      <p id="m_msg"></p>
    </div>

    <div class="card">
      <h2>Payment emails (Groq)</h2>
      <p class="muted">UPI/Paytm payment emails sent to <code>upi-payments@manasanta.in</code> are read with Groq to mark orders paid/failed. Get a key from console.groq.com.</p>
      <label>Groq API key ${settings.groq_set ? "· <span class='ok'>set</span> (leave blank to keep)" : "· not set"}</label>
      <input id="g_key" type="password" placeholder="${settings.groq_set ? "•••••• unchanged" : "gsk_…"}" />
      <button id="g_save" style="margin-top:12px">Save Groq key</button>
      <p id="g_msg"></p>
    </div>`;
  document.getElementById("copyhook").onclick = () => {
    navigator.clipboard?.writeText(settings.webhook_url);
    document.getElementById("copyhook").textContent = "Copied";
  };
  document.getElementById("gen").onclick = () => {
    document.getElementById("s_verify").value = "vt_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  };
  document.getElementById("s_save").onclick = async () => {
    const msg = document.getElementById("s_msg");
    try {
      await api("/api/console/settings", {
        method: "POST",
        body: {
          wa_verify_token: document.getElementById("s_verify").value,
          wa_app_secret: document.getElementById("s_secret").value,
          wa_token: document.getElementById("s_token").value,
          wa_api_version: document.getElementById("s_ver").value,
          wa_display_number: document.getElementById("s_num").value,
        },
      });
      msg.className = "ok"; msg.textContent = "Saved. Webhook is ready to configure in Meta.";
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
  document.getElementById("g_save").onclick = async () => {
    const msg = document.getElementById("g_msg");
    try {
      await api("/api/console/settings", { method: "POST", body: { groq_api_key: document.getElementById("g_key").value } });
      msg.className = "ok"; msg.textContent = "Saved. Payment emails will now be parsed.";
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
  document.getElementById("m_save").onclick = async () => {
    const msg = document.getElementById("m_msg");
    try {
      await api("/api/console/settings", {
        method: "POST",
        body: { ola_maps_api_key: document.getElementById("m_key").value },
      });
      msg.className = "ok"; msg.textContent = "Saved. Address autocomplete is now active on the order form.";
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
}

// ── Providers tab (super-admin) ──────────────────────────────────────────────
async function providersTab(container) {
  const { providers } = await api("/api/console/providers");
  const rows = providers
    .map((p) => `<div class="order-line"><div><strong>${esc(p.name)}</strong><br><span class="muted">/${esc(p.slug)}/app · ${esc(p.wa_phone_number_id || "no phone-number-id")}${p.has_token ? " · token ✓" : ""}</span></div>
      <button class="ghost small editprov grow0" data-id="${p.id}" data-slug="${esc(p.slug)}">Edit</button></div>`)
    .join("");
  container.innerHTML = `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h2 style="margin:0">Providers</h2>
        <button class="small" id="addprov">+ Add provider</button>
      </div>
      ${providers.length ? rows : '<p class="muted">None yet.</p>'}
    </div>`;
  document.getElementById("addprov").onclick = openAddProviderModal;
  container.querySelectorAll(".editprov").forEach((b) => (b.onclick = () => consoleProvider(b.dataset.id, b.dataset.slug, "details")));
}

function openAddProviderModal() {
  openModal("Add provider", `
    <label>Slug (URL)</label><input id="p_slug" placeholder="sparkle-laundry" />
    <label>Name</label><input id="p_name" placeholder="Sparkle Laundry" />
    <label>WABA phone-number-id</label><input id="p_pnid" placeholder="from Meta" />
    <label>Access token (optional — overrides platform token)</label><input id="p_token" type="password" placeholder="leave blank to use platform token" />
    <button id="p_create" style="margin-top:16px">Create provider</button>
    <p id="p_msg"></p>`);
  document.getElementById("p_create").onclick = async () => {
    const msg = document.getElementById("p_msg");
    try {
      await api("/api/console/providers", {
        method: "POST",
        body: {
          slug: document.getElementById("p_slug").value,
          name: document.getElementById("p_name").value,
          wa_phone_number_id: document.getElementById("p_pnid").value,
          wa_token: document.getElementById("p_token").value,
        },
      });
      closeModal();
      renderDashboard("providers");
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
}

// ── Admins tab (super-admin) ─────────────────────────────────────────────────
async function adminsTab(container) {
  const { providers } = await api("/api/console/providers");
  const ref = providers
    .map((p) => `<li><strong>${esc(p.name)}</strong> <span class="muted">${esc(p.id)}</span></li>`)
    .join("");
  container.innerHTML = `
    <div class="card">
      <h2>New provider admin</h2>
      <label>Provider id</label><input id="a_pid" placeholder="paste provider id from below" />
      <label>Email</label><input id="a_email" type="email" />
      <label>Password</label><input id="a_pass" type="password" />
      <button id="a_create" style="margin-top:12px">Create admin</button>
      <p id="a_msg"></p>
    </div>
    <div class="card"><h2>Provider ids (for reference)</h2><ul>${ref || '<li class="muted">No providers yet.</li>'}</ul></div>`;
  document.getElementById("a_create").onclick = async () => {
    const msg = document.getElementById("a_msg");
    try {
      await api("/api/console/admins", {
        method: "POST",
        body: { provider_id: document.getElementById("a_pid").value, email: document.getElementById("a_email").value, password: document.getElementById("a_pass").value },
      });
      msg.className = "ok"; msg.textContent = "Admin created.";
      document.getElementById("a_email").value = document.getElementById("a_pass").value = "";
    } catch (e) { msg.className = "err"; msg.textContent = e.message; }
  };
}

// ── Account tab (all roles) ──────────────────────────────────────────────────
function accountTab(container) {
  container.innerHTML = `
    <div class="card">
      <h2>Change my password</h2>
      <label>Current password</label><input id="pw_cur" type="password" />
      <label>New password (min 8 chars)</label><input id="pw_new" type="password" />
      <label>Confirm new password</label><input id="pw_conf" type="password" />
      <button id="pw_save" style="margin-top:12px">Update password</button>
      <p id="pw_msg"></p>
    </div>`;
  document.getElementById("pw_save").onclick = async () => {
    const msg = document.getElementById("pw_msg");
    const cur = document.getElementById("pw_cur").value;
    const next = document.getElementById("pw_new").value;
    const conf = document.getElementById("pw_conf").value;
    if (next.length < 8) { msg.className = "err"; msg.textContent = "New password must be at least 8 characters."; return; }
    if (next !== conf) { msg.className = "err"; msg.textContent = "New passwords don't match."; return; }
    try {
      await api("/api/account/password", { method: "POST", body: { current: cur, next } });
      msg.className = "ok"; msg.textContent = "Password updated.";
      document.getElementById("pw_cur").value = document.getElementById("pw_new").value = document.getElementById("pw_conf").value = "";
    } catch (e) {
      msg.className = "err";
      msg.textContent = e.message === "wrong_current_password" ? "Current password is incorrect." : e.message;
    }
  };
}

async function consoleProvider(providerId, slug, tab) {
  const TABS = { details: "Details", items: "Items", categories: "Categories", captains: "Captains", managers: "Managers", payment: "Payment" };
  tab = TABS[tab] ? tab : "details";
  closeModal();
  const provider = await api(`/api/providers/${encodeURIComponent(slug)}`); // name, currency, catalog
  let details = {}, categories = [], captains = [], managers = [], payment = {};
  try { details = await api(`/api/console/providers/${providerId}`); } catch {}
  try { categories = (await api(`/api/console/providers/${providerId}/categories`)).categories || []; } catch {}
  try { captains = (await api(`/api/console/providers/${providerId}/captains`)).captains || []; } catch {}
  try { managers = (await api(`/api/console/providers/${providerId}/managers`)).managers || []; } catch {}
  try { payment = await api(`/api/console/providers/${providerId}/payment`); } catch {}
  const cur = provider.currency || "INR";
  const sym = CUR[cur] || cur;

  h(`
    <div class="topbar"><h1>${esc(provider.name)}</h1><button class="ghost small" id="back">← Back</button></div>
    <div class="tabs">${Object.entries(TABS).map(([k, label]) => `<button class="tab ${k === tab ? "active" : ""}" data-t="${k}">${label}</button>`).join("")}</div>
    <div class="card" id="provbody"></div>`);
  document.getElementById("back").onclick = () => renderDashboard("providers");
  el.querySelectorAll(".tab").forEach((b) => (b.onclick = () => consoleProvider(providerId, slug, b.dataset.t)));
  const body = document.getElementById("provbody");

  // ── option builders (for the item modal) ──
  const catOptionsFor = (editing) =>
    `<option value="">— none —</option>` +
    categories.map((c) => `<option ${editing && editing.category === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("") +
    `<option value="__new__">+ New category…</option>`;
  const UNITS = ["piece", "kg"];
  const unitLabel = (u) => (u === "kg" ? "Kg" : u === "piece" ? "Piece" : u);
  const unitOptionsFor = (editing) => {
    const cu = editing ? editing.unit : "piece";
    return (UNITS.includes(cu) ? UNITS : [cu, ...UNITS]).map((u) => `<option value="${esc(u)}" ${u === cu ? "selected" : ""}>${esc(unitLabel(u))}</option>`).join("");
  };

  function openItemModal(editing) {
    openModal(editing ? "Edit item" : "Add item", `
      <label>Name</label><input id="m_name" value="${editing ? esc(editing.name) : ""}" />
      <label>Category</label>
      <select id="m_cat">${catOptionsFor(editing)}</select>
      <input id="m_newcat" style="display:none;margin-top:6px" placeholder="New category name" />
      <div class="row"><div><label>Unit</label><select id="m_unit">${unitOptionsFor(editing)}</select></div>
        <div><label>Price (${sym})</label><input id="m_price" type="number" min="0" step="0.01" value="${editing ? editing.price / 100 : "0"}" placeholder="e.g. 10" /></div></div>
      <button id="m_save" style="margin-top:16px">${editing ? "Save changes" : "Add item"}</button>
      <p id="m_msg" class="muted">Price in ${sym} (rupees) — e.g. 10 means ${money(1000, cur)}.</p>`);
    const sel = document.getElementById("m_cat");
    const ni = document.getElementById("m_newcat");
    sel.onchange = () => { ni.style.display = sel.value === "__new__" ? "block" : "none"; if (sel.value === "__new__") ni.focus(); };
    document.getElementById("m_save").onclick = async () => {
      const msg = document.getElementById("m_msg");
      const paise = Math.round(parseFloat(document.getElementById("m_price").value || "0") * 100);
      const category = sel.value === "__new__" ? ni.value.trim() : sel.value;
      const b = { name: document.getElementById("m_name").value, category, unit: document.getElementById("m_unit").value, price: paise };
      try {
        if (editing) await api(`/api/console/providers/${providerId}/catalog/${editing.id}`, { method: "PATCH", body: b });
        else await api(`/api/console/providers/${providerId}/catalog`, { method: "POST", body: b });
        closeModal();
        consoleProvider(providerId, slug, "items");
      } catch (e) { msg.className = "err"; msg.textContent = e.message; }
    };
  }
  function openCategoryModal() {
    openModal("Add category", `<label>Category name</label><input id="m_catname" placeholder="e.g. Wash & Iron" /><button id="m_catsave" style="margin-top:16px">Add category</button><p id="m_catmsg"></p>`);
    document.getElementById("m_catsave").onclick = async () => {
      const msg = document.getElementById("m_catmsg");
      const name = document.getElementById("m_catname").value.trim();
      if (!name) { msg.className = "err"; msg.textContent = "Enter a name."; return; }
      try { await api(`/api/console/providers/${providerId}/categories`, { method: "POST", body: { name } }); closeModal(); consoleProvider(providerId, slug, "categories"); }
      catch (e) { msg.className = "err"; msg.textContent = e.message; }
    };
  }
  function openCaptainModal() {
    openModal("Add captain", `
      <label>Name</label><input id="cap_name" placeholder="Captain's name" />
      <label>Phone (with country code)</label><input id="cap_phone" inputmode="numeric" placeholder="e.g. 919812345678" />
      <button id="cap_save" style="margin-top:16px">Add captain</button>
      <p id="cap_msg"></p>`);
    document.getElementById("cap_save").onclick = async () => {
      const msg = document.getElementById("cap_msg");
      const name = document.getElementById("cap_name").value.trim();
      const phone = document.getElementById("cap_phone").value.replace(/[^\d]/g, "");
      if (!name) { msg.className = "err"; msg.textContent = "Enter a name."; return; }
      if (phone.length < 10) { msg.className = "err"; msg.textContent = "Enter a valid phone with country code (e.g. 9198…)."; return; }
      try { await api(`/api/console/providers/${providerId}/captains`, { method: "POST", body: { name, phone } }); closeModal(); consoleProvider(providerId, slug, "captains"); }
      catch (e) { msg.className = "err"; msg.textContent = e.message; }
    };
  }

  function openManagerModal() {
    openModal("Add manager", `
      <label>Name</label><input id="mgr_name" placeholder="Manager's name" />
      <label>Phone (with country code)</label><input id="mgr_phone" inputmode="numeric" placeholder="e.g. 919812345678" />
      <label>Role</label>
      <select id="mgr_tier"><option value="manager">Manager (no Managers tab)</option><option value="admin">Admin (full access)</option></select>
      <button id="mgr_save" style="margin-top:16px">Add manager</button>
      <p id="mgr_msg"></p>`);
    document.getElementById("mgr_save").onclick = async () => {
      const msg = document.getElementById("mgr_msg");
      const name = document.getElementById("mgr_name").value.trim();
      const phone = document.getElementById("mgr_phone").value.replace(/[^\d]/g, "");
      const tier = document.getElementById("mgr_tier").value;
      if (!name) { msg.className = "err"; msg.textContent = "Enter a name."; return; }
      if (phone.length < 10) { msg.className = "err"; msg.textContent = "Enter a valid phone with country code (e.g. 9198…)."; return; }
      try { await api(`/api/console/providers/${providerId}/managers`, { method: "POST", body: { name, phone, tier } }); closeModal(); consoleProvider(providerId, slug, "managers"); }
      catch (e) { msg.className = "err"; msg.textContent = e.message; }
    };
  }

  // ── Tab bodies ──
  if (tab === "details") {
    body.innerHTML = `
      <h2>Provider details</h2>
      <label>Name</label><input id="d_name" value="${esc(details.name || provider.name || "")}" />
      <label>Slug (URL)</label><input value="/${esc(details.slug || slug)}/app" readonly />
      <label>WABA phone-number-id</label><input id="d_pnid" value="${esc(details.wa_phone_number_id || "")}" placeholder="from Meta" />
      <label>Access token ${details.has_token ? "· <span class='ok'>set</span> (blank keeps)" : "· not set"}</label>
      <input id="d_token" type="password" placeholder="${details.has_token ? "•••••• unchanged" : "per-provider token (optional)"}" />
      <button id="d_save" style="margin-top:14px">Save details</button>
      <p id="d_msg"></p>`;
    document.getElementById("d_save").onclick = async () => {
      const msg = document.getElementById("d_msg");
      try {
        await api(`/api/console/providers/${providerId}`, { method: "PATCH", body: { name: document.getElementById("d_name").value, wa_phone_number_id: document.getElementById("d_pnid").value, wa_token: document.getElementById("d_token").value } });
        msg.className = "ok"; msg.textContent = "Saved.";
      } catch (e) { msg.className = "err"; msg.textContent = e.message; }
    };
  } else if (tab === "items") {
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px">
        <input id="itemsearch" placeholder="Search items…" style="max-width:300px" />
        <button class="small grow0" id="addbtn">+ Add item</button>
      </div>
      <div class="catlayout"><div class="catmenu" id="catmenu"></div><div class="catitems" id="catitems"></div></div>`;
    document.getElementById("addbtn").onclick = () => openItemModal(null);
    const predefNames = categories.map((c) => c.name);
    const isUncat = (it) => !it.category || !predefNames.includes(it.category);
    let selectedCat = "__all__";
    const menu = [{ key: "__all__", label: "All items", count: provider.catalog.length }].concat(
      categories.map((c) => ({ key: c.name, label: c.name, count: provider.catalog.filter((it) => it.category === c.name).length }))
    );
    if (provider.catalog.some(isUncat)) menu.push({ key: "__uncat__", label: "Uncategorised", count: provider.catalog.filter(isUncat).length });
    const renderMenu = () => {
      document.getElementById("catmenu").innerHTML = menu.map((m) => `<button class="catmenu-item ${m.key === selectedCat ? "active" : ""}" data-k="${esc(m.key)}"><span>${esc(m.label)}</span><span class="muted">${m.count}</span></button>`).join("");
      document.querySelectorAll(".catmenu-item").forEach((b) => (b.onclick = () => { selectedCat = b.dataset.k; renderMenu(); renderItems(); }));
    };
    const renderItems = () => {
      const q = (document.getElementById("itemsearch").value || "").trim().toLowerCase();
      let list = provider.catalog.slice();
      if (selectedCat === "__uncat__") list = list.filter(isUncat);
      else if (selectedCat !== "__all__") list = list.filter((it) => it.category === selectedCat);
      if (q) list = list.filter((it) => it.name.toLowerCase().includes(q));
      list.sort((a, b) => a.name.localeCompare(b.name));
      const box = document.getElementById("catitems");
      if (!list.length) { box.innerHTML = '<p class="muted">No items.</p>'; return; }
      box.innerHTML = list.map((c) => `<div class="order-line">
          <div><strong>${esc(c.name)}</strong> <span class="amt">${money(c.price, cur)}</span><br><span class="muted">${esc(c.category || "Uncategorised")} · ${esc(c.unit)}</span></div>
          <div class="grow0" style="display:flex;gap:6px"><button class="ghost small edit" data-id="${c.id}">Edit</button><button class="ghost small del" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button></div>
        </div>`).join("");
      box.querySelectorAll(".edit").forEach((b) => (b.onclick = () => openItemModal(provider.catalog.find((c) => c.id === b.dataset.id))));
      box.querySelectorAll(".del").forEach((b) => (b.onclick = async () => { if (!confirm(`Delete "${b.dataset.name}" from the catalog?`)) return; await api(`/api/console/providers/${providerId}/catalog/${b.dataset.id}`, { method: "DELETE" }); consoleProvider(providerId, slug, "items"); }));
    };
    document.getElementById("itemsearch").oninput = renderItems;
    renderMenu();
    renderItems();
  } else if (tab === "categories") {
    const catRows = categories.map((c) => `<div class="order-line"><div><strong>${esc(c.name)}</strong></div><button class="ghost small grow0 delcat" data-id="${c.id}" data-name="${esc(c.name)}">Delete</button></div>`).join("");
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Categories</h2><button class="small" id="addbtn">+ Add category</button></div>
      ${categories.length ? catRows : '<p class="muted">No categories yet.</p>'}`;
    document.getElementById("addbtn").onclick = openCategoryModal;
    body.querySelectorAll(".delcat").forEach((b) => (b.onclick = async () => { if (!confirm(`Delete category "${b.dataset.name}"? (Items keep their label.)`)) return; await api(`/api/console/providers/${providerId}/categories/${b.dataset.id}`, { method: "DELETE" }); consoleProvider(providerId, slug, "categories"); }));
  } else if (tab === "captains") {
    const capRows = captains.map((c) => `<div class="order-line"><div><strong>${esc(c.name || "Captain")}</strong><br><span class="muted">${esc(c.phone || "")}</span></div><button class="ghost small grow0 delcap" data-id="${c.id}" data-name="${esc(c.name || "")}">Delete</button></div>`).join("");
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Captains</h2><button class="small" id="addbtn">+ Add captain</button></div>
      ${captains.length ? capRows : '<p class="muted">No captains yet.</p>'}`;
    document.getElementById("addbtn").onclick = openCaptainModal;
    body.querySelectorAll(".delcap").forEach((b) => (b.onclick = async () => { if (!confirm(`Delete captain "${b.dataset.name}"?`)) return; await api(`/api/console/providers/${providerId}/captains/${b.dataset.id}`, { method: "DELETE" }); consoleProvider(providerId, slug, "captains"); }));
  } else if (tab === "managers") {
    const mgrRows = managers.map((m) => `<div class="order-line"><div><strong>${esc(m.name || "Manager")}</strong> <span class="tag">${esc(m.tier)}</span><br><span class="muted">${esc(m.phone || "")}</span></div><button class="ghost small grow0 delmgr" data-id="${m.id}" data-name="${esc(m.name || "")}">Delete</button></div>`).join("");
    body.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><h2 style="margin:0">Managers</h2><button class="small" id="addbtn">+ Add manager</button></div>
      <p class="muted small" style="margin:-2px 0 10px">Admins can run everything incl. adding managers; managers do everything except this tab. They sign in by texting <b>admin</b> or <b>manager</b> on WhatsApp.</p>
      ${managers.length ? mgrRows : '<p class="muted">No managers yet.</p>'}`;
    document.getElementById("addbtn").onclick = openManagerModal;
    body.querySelectorAll(".delmgr").forEach((b) => (b.onclick = async () => { if (!confirm(`Remove manager "${b.dataset.name}"?`)) return; await api(`/api/console/providers/${providerId}/managers/${b.dataset.id}`, { method: "DELETE" }); consoleProvider(providerId, slug, "managers"); }));
  } else {
    // payment (UPI)
    body.innerHTML = `
      <h2 style="margin-top:0">Payment (UPI)</h2>
      <p class="muted small" style="margin:0 0 12px">Set the UPI ID so captains can show the customer a payment QR after delivery.</p>
      <label>UPI ID (VPA)</label>
      <input id="p_upi" value="${esc(payment.upi_id || "")}" placeholder="e.g. name@okhdfcbank" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <label>Payee name (shown in the customer's UPI app)</label>
      <input id="p_upiname" value="${esc(payment.upi_name || "")}" placeholder="${esc(provider.name)}" />
      <button id="p_save" style="margin-top:14px">Save UPI</button>
      <p id="p_msg"></p>`;
    document.getElementById("p_save").onclick = async () => {
      const msg = document.getElementById("p_msg");
      try {
        await api(`/api/console/providers/${providerId}/payment`, { method: "PATCH", body: { upi_id: document.getElementById("p_upi").value.trim(), upi_name: document.getElementById("p_upiname").value.trim() } });
        msg.className = "ok"; msg.textContent = "Saved.";
      } catch (e) { msg.className = "err"; msg.textContent = e.message === "invalid_upi" ? "That doesn't look like a UPI ID (e.g. name@okhdfcbank)." : e.message; }
    };
  }
}

async function logout() {
  liveDisconnect();
  await api("/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
}

route();
