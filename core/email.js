// Cloudflare Email Worker: incoming payment/settlement emails (e.g. Paytm for
// Business "Payment Received") are parsed with Groq to pull out the order id,
// amount and paid/failed status, then written back onto the order.
import PostalMime from "postal-mime";
import { now, getSettings } from "./db.js";
import { randomId } from "./crypto.js";
import { notifyOrders } from "./orders-hub.js";

export async function handleEmail(message, env, ctx) {
  const from = message.from || null;
  let subject = null;
  let body = null;
  try {
    const buf = await new Response(message.raw).arrayBuffer();
    const email = await PostalMime.parse(buf);
    subject = email.subject || "";
    body = email.text || stripHtml(email.html || "");
    console.log("[email] from", from, "subj", subject);
    const r = await processPaymentEmail(env, subject, body, { apply: true });
    console.log("[email] result", JSON.stringify(r));
    await logEmail(env.DB, { from, subject, body, r });
  } catch (e) {
    console.error("[email] error", e && e.stack ? e.stack : e);
    await logEmail(env.DB, { from, subject, body, r: { reason: "error", parsed: { error: String(e && e.message || e) } } }).catch(() => {});
  }
}

async function logEmail(db, { from, subject, body, r }) {
  await db
    .prepare(
      "INSERT INTO payment_email_log (id, from_addr, subject, body, parsed, order_id, matched_by, reason, applied, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    .bind(randomId(), from, subject, (body || "").slice(0, 20000) || null, JSON.stringify(r?.parsed ?? null), r?.orderId || null, r?.matchedBy || null, r?.reason || null, r?.applied ? 1 : 0, now())
    .run();
}

// Parse a payment email with Groq, match it to an order, and (optionally) record
// the payment. Returns { parsed, orderId, applied, reason }. Reused by the email
// Worker and the super-admin test endpoint.
export async function processPaymentEmail(env, subject, body, { apply = false } = {}) {
  const parsed = await groqExtract(env, subject, String(body || "").slice(0, 8000));
  if (!parsed) return { parsed: null, orderId: null, applied: false, reason: "groq_failed" };
  if (parsed.status !== "paid" && parsed.status !== "failed") return { parsed, orderId: null, applied: false, reason: "no_status" };

  const paise = Number.isFinite(+parsed.amount) ? Math.round(+parsed.amount * 100) : null;
  let order = null;
  const oid = typeof parsed.order_id === "string" && /^\d{3}-\d{6}$/.test(parsed.order_id.trim()) ? parsed.order_id.trim() : null;
  if (oid) order = await env.DB.prepare("SELECT id FROM orders WHERE id = ?").bind(oid).first();
  let matchedBy = order ? "order_id" : null;
  if (!order && paise) { order = await matchByAmount(env.DB, paise); if (order) matchedBy = "amount"; }
  if (!order) return { parsed, orderId: null, applied: false, reason: "no_match" };

  // Normalise fields for storage (Groq may return numbers; payment_ref is TEXT).
  const ref = parsed.txn_ref != null && parsed.txn_ref !== "" ? String(parsed.txn_ref).replace(/\.0+$/, "") : null;
  const payer = parsed.payer != null && parsed.payer !== "" ? String(parsed.payer) : null;
  if (apply) {
    await env.DB
      .prepare(
        "UPDATE orders SET payment_status = ?, payment_ref = COALESCE(?, payment_ref), " +
          "payment_amount = COALESCE(?, payment_amount), payment_payer = COALESCE(?, payment_payer), " +
          "payment_at = ?, updated_at = ? WHERE id = ?"
      )
      .bind(parsed.status, ref, paise, payer, now(), now(), order.id)
      .run();
    const row = await env.DB.prepare("SELECT provider_id FROM orders WHERE id = ?").bind(order.id).first();
    await notifyOrders(env, row?.provider_id);
  }
  return { parsed, orderId: order.id, matchedBy, applied: apply, reason: "ok" };
}

// Find exactly one recent unpaid delivered/out-for-delivery order whose total
// equals the paid amount (best-effort when the email carries no order id).
async function matchByAmount(db, paise) {
  const since = now() - 3 * 24 * 60 * 60 * 1000;
  const { results } = await db
    .prepare(
      "SELECT o.id FROM orders o WHERE o.payment_status IS NULL AND o.created_at > ? " +
        "AND o.status IN ('OUT_FOR_DELIVERY','DELIVERED') " +
        "AND ((SELECT COALESCE(SUM(qty*unit_price),0) FROM order_items WHERE order_id = o.id) + COALESCE(o.delivery_fee,0)) = ? " +
        "ORDER BY o.created_at DESC LIMIT 2"
    )
    .bind(since, paise)
    .all();
  return results.length === 1 ? results[0] : null; // skip if ambiguous
}

async function groqExtract(env, subject, body) {
  const settings = await getSettings(env.DB);
  const key = settings?.groq_api_key || env.GROQ_API_KEY;
  if (!key) { console.warn("[email] Groq API key not set"); return null; }
  const model = env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const sys =
    "You extract UPI/Paytm payment details from a merchant payment notification email. " +
    "Return ONLY a JSON object with these keys:\n" +
    "- order_id: our internal reference — a token like NNN-DDMMYY (3 digits, hyphen, 6 digits, e.g. 001-100726) OPTIONALLY prefixed with a short uppercase shop code and hyphen (e.g. MED-001-100726). It appears anywhere, usually in a note/remark/comment. This is NOT the gateway's own 'Order ID'. Return the full token (with the code prefix if present); if no such token exists, return null.\n" +
    "- amount: the number of rupees received (no currency symbol).\n" +
    "- status: 'paid' if the payment was received/successful, 'failed' if it failed, else 'unknown'.\n" +
    "- txn_ref: the payment gateway's own reference/order/transaction id (e.g. a Paytm 'Order ID' like 753248), or null.\n" +
    "- payer: the payer's UPI id or name if present, else null.";
  const user = `Subject: ${subject}\n\n${body}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) { console.error("[email] groq http", res.status, await res.text().catch(() => "")); return null; }
  const data = await res.json();
  try {
    return JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return null;
  }
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
