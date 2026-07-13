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

export function textPayload(body) {
  return { type: "text", text: { body } };
}

// Interactive Call-To-Action URL button. Renders a tappable button; opening it
// loads the URL inside WhatsApp's in-app browser (overlay), not an external
// browser. Free-form message — valid inside the 24h customer window.
export function ctaUrlPayload(bodyText, buttonText, url) {
  return {
    type: "interactive",
    interactive: {
      type: "cta_url",
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

export async function notifyCustomer(waCfg, { flow, provider, customer, status, order }) {
  const cfg = safeConfig(provider.config);
  const label = cfg.statusLabels?.[status] || flow?.labels?.[status] || status;
  const amount = order.total ? `\nAmount: ${formatMoney(order.total, cfg.currency)}` : "";
  // Name the field agent for this status: when the status is an assignment point,
  // read the slot it assigns. (Dhobi: OUT_FOR_DELIVERY names the delivery captain.)
  const asg = flow ? assignmentAt(flow, status) : null;
  const capName = asg?.slot === "delivery" ? order.delivery_captain_name : asg?.slot === "primary" ? order.agent_name : null;
  const capPhone = asg?.slot === "delivery" ? order.delivery_captain_phone : asg?.slot === "primary" ? order.captain_phone : null;
  const agentTerm = flow?.agentTerm || "Captain";
  const captain = capName ? `\n${agentTerm}: ${capName}${capPhone ? ` (+${capPhone})` : ""}` : "";
  const freeText = `${label}\nOrder ${order.id}${amount}${captain}`;

  let payload;
  if (withinWindow(customer.last_inbound_at)) {
    payload = textPayload(freeText);
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
