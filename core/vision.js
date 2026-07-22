// Groq vision — read a customer-uploaded photo (a shopping list, a prescription,
// a pile of laundry, a broken appliance) and turn it into a structured item list
// that pre-fills the order. Which providers may use this is gated by
// service_providers.photo_order (configured per provider in the super-admin console).
import { getSettings } from "./db.js";

// Groq's current vision model (Llama-4 Scout/Maverick were retired from the plan
// 2026-07; Qwen 3.6 is what's left that accepts images). Override via
// env.GROQ_VISION_MODEL. Qwen is a REASONING model — it emits <think>…</think>
// before the answer, which is why we DON'T use response_format:json_object
// (it rejects the thinking) and parse the JSON out loosely instead.
const VISION_MODEL = "qwen/qwen3.6-27b";

// Pull the JSON object out of a model reply that may be wrapped in <think> blocks
// or ```code fences```. Returns null if there's no parseable object.
function parseJsonLoose(content) {
  if (!content) return null;
  const s = String(content).replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// Per-vertical hint so the model knows what counts as a "real" item for this shop.
const VERTICAL_HINTS = {
  laundry: "garments and laundry articles (shirts, sarees, trousers, bedsheets, curtains…). Group identical garments and count them.",
  appliance: "home appliances or devices needing repair/service (fridge, washing machine, AC, microwave, geyser…).",
  delivery: "goods this shop sells for delivery — e.g. medicines/medical items from a prescription for a pharmacy, vegetables for a veg seller, chicken/meat cuts for a meat shop, groceries for a kirana.",
};

/**
 * Extract orderable items from an image.
 * @returns {Promise<{ok:boolean, items?:Array<{name:string,amount:string,qty:number,inCatalog:boolean,relevant:boolean,note:string}>, error?:string}>}
 */
export async function extractItemsFromImage(env, db, provider, dataUrl) {
  if (!dataUrl || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) {
    return { ok: false, error: "bad_image" };
  }
  const settings = await getSettings(db);
  const key = settings?.groq_api_key || env.GROQ_API_KEY;
  if (!key) return { ok: false, error: "groq_not_configured" };
  const model = env.GROQ_VISION_MODEL || VISION_MODEL; // see VISION_MODEL note above

  // The provider's own catalog anchors names + tells us what's genuinely on sale.
  const { results: catalog } = await db
    .prepare("SELECT name FROM catalog_items WHERE provider_id = ? AND active = 1")
    .bind(provider.id)
    .all();
  const catalogNames = (catalog || []).map((r) => String(r.name)).filter(Boolean);
  const vertical = provider.vertical || "";
  const hint = VERTICAL_HINTS[vertical] || "the goods or services this shop provides.";

  const sys =
    `You transcribe a photo a customer sent to the shop "${provider.name}". ` +
    "It is usually a handwritten or printed shopping list, a prescription, or a photo of the goods themselves. " +
    "The writing is often in a regional Indian language (Telugu, Hindi, Tamil, Kannada, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Odia, Urdu) or a mix with English, and may be old or faded.\n" +
    `This shop deals in: ${hint}\n` +
    (catalogNames.length ? `For spelling reference only, its catalog is: ${catalogNames.join(", ")}.\n` : "") +
    "TRANSCRIBE FAITHFULLY. Read the ACTUAL word on each line and give its common English name (transliterate/translate exactly what is written). " +
    "You MUST NOT substitute a typical/generic product, and MUST NOT invent items from the shop's usual inventory. " +
    "If a line is illegible, skip it — do NOT guess. It is far better to return fewer, correct items than to fabricate a plausible list. " +
    "A line usually has an item, then a quantity/weight, and sometimes a price in rupees — capture the item and its quantity/weight, but IGNORE money/prices.\n" +
    "Return ONLY a JSON object of the form " +
    `{"items":[{"name": string, "amount": string, "qty": integer>=1, "inCatalog": boolean, "relevant": boolean, "note": string}]}. ` +
    "'name' — the item's English name, faithful to what is written. Examples (Telugu): 'కంది పప్పు'→'Toor dal', 'పెసర పప్పు'→'Moong dal', 'మినప పప్పు'→'Urad dal', 'శనగ పప్పు'→'Chana dal', 'ఆవాలు'→'Mustard seeds', 'జీలకర్ర'→'Cumin', 'మెంతులు'→'Fenugreek seeds', 'మిరపకాయలు'→'Red chilli', 'ఇంగువ'→'Asafoetida', 'నూనె'→'Oil', 'పంచదార'→'Sugar', 'నెయ్యి'→'Ghee', 'సబ్బు'→'Soap'. " +
    "'amount' — the quantity/weight EXACTLY as written next to the item, e.g. '3 kg', '1/2 kg', '1/4 kg', '250 g', '2 packets'; empty string if none is written. " +
    "'qty' — a whole-number count of packs/pieces (default 1); when the amount is a weight, keep qty 1 and put the weight in 'amount'. " +
    "'inCatalog' — true only if the item clearly matches a catalog name above. " +
    "'relevant' — true if it belongs to this shop's business, false only for clearly unrelated things. " +
    "'note' — the original-script text or a short clarification when useful, else empty string. " +
    "Return valid JSON only.";

  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the items from this image." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    console.error("[vision] fetch failed", String(e));
    return { ok: false, error: "groq_unreachable" };
  }
  if (!res.ok) {
    console.error("[vision] groq http", res.status, await res.text().catch(() => ""));
    return { ok: false, error: "groq_http_" + res.status };
  }
  let parsed;
  try {
    const data = await res.json();
    parsed = parseJsonLoose(data.choices?.[0]?.message?.content);
  } catch {
    return { ok: false, error: "groq_bad_json" };
  }
  if (!parsed) return { ok: false, error: "groq_bad_json" };

  const items = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((it) => ({
      name: String(it?.name || "").trim(),
      amount: String(it?.amount || "").trim(), // written quantity/weight, e.g. "3 kg", "1/2 kg"
      qty: Math.max(1, parseInt(it?.qty, 10) || 1),
      inCatalog: !!it?.inCatalog,
      relevant: it?.relevant !== false, // default to relevant unless the model says otherwise
      note: String(it?.note || "").trim(),
    }))
    .filter((it) => it.name);

  return { ok: true, items };
}

/**
 * Read a UPI payment receipt/screenshot the customer uploaded.
 *
 * This ASSISTS the shop — it never decides. The admin still confirms or rejects,
 * so a mis-read costs a second look, not money. We deliberately do not fail the
 * upload when Groq is down or unsure: the admin can always read the image.
 *
 * @returns {Promise<{ok:boolean, amount:number|null, ref:string, orderRef:string, payer:string, paidAt:string, paidAtISO:string, status:string, error?:string}>}
 *          amount is in paise, to match order.total.
 */
export async function extractReceipt(env, db, dataUrl) {
  if (!dataUrl || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) {
    return { ok: false, error: "bad_image" };
  }
  const settings = await getSettings(db);
  const key = settings?.groq_api_key || env.GROQ_API_KEY;
  if (!key) return { ok: false, error: "groq_not_configured" };
  const model = env.GROQ_VISION_MODEL || VISION_MODEL; // see VISION_MODEL note above

  const sys =
    "You read a payment receipt screenshot from an Indian UPI app (GPay, PhonePe, Paytm, BHIM, a bank app) " +
    "that a customer sent to a shop as proof of payment.\n" +
    "TRANSCRIBE ONLY WHAT IS VISIBLE. Never guess or invent a value — if a field is not clearly readable, return it empty/null. " +
    "A wrong value is far worse than an empty one.\n" +
    "Return ONLY a JSON object of the form " +
    `{"amount": number|null, "ref": string, "orderRef": string, "payer": string, "paidAt": string, "paidAtISO": string, "status": string}.\n` +
    "'amount' — the rupee amount PAID, as a plain number (e.g. 347 or 347.50). Read the big headline amount, " +
    "not a balance, cashback or fee. Strip '₹', 'Rs.' and thousands separators. null if unreadable.\n" +
    "'ref' — the transaction reference: UPI transaction ID / UTR. Copy the characters EXACTLY, " +
    "including case and length; do not normalise or shorten. Empty string if absent.\n" +
    "'orderRef' — an order id in the payment note/remarks/message, if shown. It looks like a short code with " +
    "hyphens, e.g. 'VDR-001-210726' or 'Order MED-014-070726' (return just the code). This is different from " +
    "the UTR. Copy it EXACTLY. Empty string if no such note is visible.\n" +
    "'payer' — who paid: their name or UPI id (VPA) as shown. Copy a VPA exactly, keeping the full suffix " +
    "after '@' (e.g. 'name@okhdfcbank' — never truncate the bank part). Empty string if absent.\n" +
    "'paidAt' — the date/time shown, exactly as printed. Empty string if absent.\n" +
    "'paidAtISO' — the SAME date/time normalised to ISO 8601 with the Indian Standard Time offset, " +
    "e.g. '2026-07-21T16:15:00+05:30'. Assume IST and the current year if the receipt omits them. " +
    "Empty string if you cannot read a date confidently.\n" +
    "'status' — the outcome word shown, lowercased: 'success', 'completed', 'paid', 'pending', 'failed'. " +
    "Empty string if not shown. Do NOT assume success.\n" +
    "Return valid JSON only.";

  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          { role: "system", content: sys },
          {
            role: "user",
            content: [
              { type: "text", text: "Read this payment receipt." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });
  } catch (e) {
    console.error("[vision] receipt fetch failed", String(e));
    return { ok: false, error: "groq_unreachable" };
  }
  if (!res.ok) {
    console.error("[vision] receipt groq http", res.status, await res.text().catch(() => ""));
    return { ok: false, error: "groq_http_" + res.status };
  }
  let parsed;
  try {
    const data = await res.json();
    parsed = parseJsonLoose(data.choices?.[0]?.message?.content);
  } catch {
    return { ok: false, error: "groq_bad_json" };
  }
  if (!parsed) return { ok: false, error: "groq_bad_json" };

  // Rupees → paise, so it compares directly against order.total.
  const rupees = Number(parsed?.amount);
  const amount = Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : null;
  return {
    ok: true,
    amount,
    ref: String(parsed?.ref || "").trim(),
    // The order id, if the customer's UPI note carried it (proves they used our QR).
    orderRef: String(parsed?.orderRef || "").trim(),
    payer: String(parsed?.payer || "").trim(),
    paidAt: String(parsed?.paidAt || "").trim(),
    paidAtISO: String(parsed?.paidAtISO || "").trim(), // normalised, for the date-after-QR check
    status: String(parsed?.status || "").trim().toLowerCase(),
  };
}
