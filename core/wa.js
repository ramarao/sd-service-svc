// WhatsApp Business API helpers — signature verification, sending, and the
// 24-hour-window notification gate that picks free-text vs. utility template.
import { hmacHex, timingSafeEqual } from "./crypto.js";
import { assignmentAt } from "./flow.js";

const WINDOW_MS = 24 * 60 * 60 * 1000;

// Verify Meta's X-Hub-Signature-256 over the raw request body.
export async function verifySignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected = "sha256=" + (await hmacHex(appSecret, rawBody));
  return timingSafeEqual(expected, header);
}

// Low-level send. waCfg = { token, phoneNumberId, apiVersion } — resolved from
// DB platform_settings / provider row / env by getWaConfig().
export async function sendWhatsApp(waCfg, to, payload) {
  const { token, phoneNumberId, apiVersion } = waCfg || {};
  if (!token || !phoneNumberId) {
    console.warn("[wa] missing access token or phone_number_id — skipping send");
    return { skipped: true };
  }
  const res = await fetch(
    `https://graph.facebook.com/${apiVersion || "v21.0"}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
    }
  );
  if (!res.ok) {
    console.error("[wa] send failed", res.status, await res.text());
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

// Mark an incoming message as read AND show a "typing…" bubble, in one call.
// WhatsApp keeps the indicator up for ~25s or until we send our reply, whichever
// comes first — so firing this the instant a message lands makes the bot feel
// responsive while we do the async work of composing a reply. Best-effort: a
// failure here must never affect whether the reply gets sent, so it's swallowed.
// (Distinct payload from sendWhatsApp, which injects `to`; this one carries
// status/message_id/typing_indicator instead.)
export async function sendTypingIndicator(waCfg, messageId) {
  const { token, phoneNumberId, apiVersion } = waCfg || {};
  if (!token || !phoneNumberId || !messageId) return { skipped: true };
  try {
    const res = await fetch(
      `https://graph.facebook.com/${apiVersion || "v21.0"}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
      }
    );
    if (!res.ok) {
      console.warn("[wa] typing indicator failed", res.status, await res.text().catch(() => ""));
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (e) {
    console.warn("[wa] typing indicator error", String(e));
    return { ok: false };
  }
}

// Download a media object a customer sent (e.g. a payment-receipt image) and
// return it as a base64 data URL — ready for Groq OCR and for storing against the
// order. Two hops per the Graph API: media-id → a short-lived signed URL, then
// fetch the bytes (that URL also needs the Bearer token). Returns null on any
// failure or if it's over `maxBytes` (D1 row-size guard).
export async function fetchWhatsAppMedia(waCfg, mediaId, { maxBytes = 900_000 } = {}) {
  const { token, apiVersion } = waCfg || {};
  if (!token || !mediaId) return null;
  const v = apiVersion || "v21.0";
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${v}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) { console.warn("[wa] media meta", metaRes.status); return null; }
    const meta = await metaRes.json();
    if (!meta?.url) return null;
    const mime = meta.mime_type || "image/jpeg";
    if (!/^image\//.test(mime)) return null; // only images are receipts
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!binRes.ok) { console.warn("[wa] media bytes", binRes.status); return null; }
    const buf = new Uint8Array(await binRes.arrayBuffer());
    if (buf.length > maxBytes) { console.warn("[wa] media too big", buf.length); return null; }
    // Uint8Array → base64 in chunks (btoa on a giant spread call can overflow).
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return `data:${mime};base64,${btoa(bin)}`;
  } catch (e) {
    console.warn("[wa] media fetch error", String(e));
    return null;
  }
}

export function textPayload(body) {
  return { type: "text", text: { body } };
}

// Send an image by URL. WhatsApp fetches `link` server-side, so it must be a
// public HTTPS URL returning image/png|jpeg (our QR endpoint's token URL is —
// the token is in the URL, no cookie needed). Used to deliver the UPI QR into the
// chat, where it saves to the gallery natively — the reliable path for customers
// stuck in an in-app browser that can't save from a web page.
export async function sendWhatsAppImage(waCfg, to, link, caption) {
  return sendWhatsApp(waCfg, to, { type: "image", image: { link, ...(caption ? { caption } : {}) } });
}

// Interactive Call-To-Action URL button. Renders a tappable button. Free-form
// message — valid only inside the 24h customer window.
//
// Whether the URL opens in WhatsApp's in-app browser or the device's external
// browser is NOT decided by this payload — the same shape opens in-app for a
// Meta-verified business and externally for an unverified one. Shape kept
// byte-for-byte identical to the known-good sd-vox/scandeer payload
// (recipient_type + optional image header) so the payload is ruled out as the
// variable. headerImage is optional; omitted when no brand logo is configured.
export function ctaUrlPayload(bodyText, buttonText, url, headerImage) {
  return {
    recipient_type: "individual",
    type: "interactive",
    interactive: {
      type: "cta_url",
      ...(headerImage ? { header: { type: "image", image: { link: headerImage } } } : {}),
      body: { text: bodyText },
      action: {
        name: "cta_url",
        parameters: { display_text: buttonText, url },
      },
    },
  };
}

// Utility template with positional {{1}}, {{2}}... body params.
export function templatePayload(name, langCode, bodyParams = []) {
  return {
    type: "template",
    template: {
      name,
      language: { code: langCode || "en" },
      components: bodyParams.length
        ? [{ type: "body", parameters: bodyParams.map((t) => ({ type: "text", text: String(t) })) }]
        : [],
    },
  };
}

export function withinWindow(lastInboundAt) {
  return !!lastInboundAt && Date.now() - lastInboundAt < WINDOW_MS;
}

// The core gate. Inside 24h → free text (cheap, flexible). Outside → the
// provider's approved Utility template for that status. waCfg carries the
// resolved token + phone_number_id.
export function formatMoney(paise, cur = "INR") {
  const sym = { INR: "₹", USD: "$", EUR: "€", GBP: "£" }[cur] || cur + " ";
  return sym + (Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// orderLink → a magic link that signs the customer in and opens THIS order. When
// present (and we're inside the 24h window) every order message carries an
// "Open order" CTA. Courier tracking still rides inline in the body text, since
// WhatsApp allows only one URL button per message and the order page repeats it.
// headerImage → a public image URL to show as the message's header (e.g. the
// courier receipt on a shipment notice). Falls back to the brand logo.
export async function notifyCustomer(waCfg, { flow, provider, customer, status, order, orderLink, headerImage }) {
  const cfg = safeConfig(provider.config);
  const courier = order.ship_mode === "courier";
  let label = cfg.statusLabels?.[status] || flow?.labels?.[status] || status;
  // Courier orders are "shipped", not "out for delivery".
  const asg = flow ? assignmentAt(flow, status) : null;
  if (courier && asg) label = "Your order has been shipped 📦";
  const amount = order.total ? `\nAmount: ${formatMoney(order.total, cfg.currency)}` : "";
  // Name the field agent for this status: when the status is an assignment point,
  // read the slot it assigns. (Dhobi: OUT_FOR_DELIVERY names the delivery captain.)
  const capName = asg?.slot === "delivery" ? order.delivery_captain_name : asg?.slot === "primary" ? order.agent_name : null;
  const capPhone = asg?.slot === "delivery" ? order.delivery_captain_phone : asg?.slot === "primary" ? order.captain_phone : null;
  const agentTerm = flow?.agentTerm || "Captain";
  // Courier: name the tracking link (and a prepaid nudge) instead of an agent.
  const dispatch = courier
    ? (order.courier_tracking ? `\nTrack your shipment: ${order.courier_tracking}` : "")
    : (capName ? `\n${agentTerm}: ${capName}${capPhone ? ` (+${capPhone})` : ""}` : "");
  const payNote = courier && asg && order.payment_status !== "paid" && order.total
    ? `\nPlease pay online to confirm your shipment.`
    : "";
  const freeText = `${label}\nOrder ${order.id}${amount}${dispatch}${payNote}`;

  let payload;
  if (withinWindow(customer.last_inbound_at)) {
    // Inside the 24h window we can attach an interactive CTA button.
    payload = orderLink
      ? ctaUrlPayload(freeText, "Open order", orderLink, headerImage || cfg.logo || null)
      : textPayload(freeText);
  } else {
    const templateName = cfg.templates?.[status];
    if (!templateName) {
      // No approved template for this status → best-effort text (may fail
      // outside window; logged rather than thrown so status update still commits).
      payload = textPayload(freeText);
    } else {
      payload = templatePayload(templateName, cfg.lang, [order.id]);
    }
  }
  return sendWhatsApp(waCfg, customer.wa_phone, payload);
}

export function safeConfig(raw) {
  try {
    return typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
  } catch {
    return {};
  }
}
