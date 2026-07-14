// Groq vision — read a customer-uploaded photo (a shopping list, a prescription,
// a pile of laundry, a broken appliance) and turn it into a structured item list
// that pre-fills the order. Which providers may use this is gated by
// service_providers.photo_order (configured per provider in the super-admin console).
import { getSettings } from "./db.js";

// Per-vertical hint so the model knows what counts as a "real" item for this shop.
const VERTICAL_HINTS = {
  laundry: "garments and laundry articles (shirts, sarees, trousers, bedsheets, curtains…). Group identical garments and count them.",
  appliance: "home appliances or devices needing repair/service (fridge, washing machine, AC, microwave, geyser…).",
  delivery: "goods this shop sells for delivery — e.g. medicines/medical items from a prescription for a pharmacy, vegetables for a veg seller, chicken/meat cuts for a meat shop, groceries for a kirana.",
};

/**
 * Extract orderable items from an image.
 * @returns {Promise<{ok:boolean, items?:Array<{name:string,qty:number,inCatalog:boolean,relevant:boolean,note:string}>, error?:string}>}
 */
export async function extractItemsFromImage(env, db, provider, dataUrl) {
  if (!dataUrl || !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(dataUrl)) {
    return { ok: false, error: "bad_image" };
  }
  const settings = await getSettings(db);
  const key = settings?.groq_api_key || env.GROQ_API_KEY;
  if (!key) return { ok: false, error: "groq_not_configured" };
  const model = env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

  // The provider's own catalog anchors names + tells us what's genuinely on sale.
  const { results: catalog } = await db
    .prepare("SELECT name FROM catalog_items WHERE provider_id = ? AND active = 1")
    .bind(provider.id)
    .all();
  const catalogNames = (catalog || []).map((r) => String(r.name)).filter(Boolean);
  const vertical = provider.vertical || "";
  const hint = VERTICAL_HINTS[vertical] || "the goods or services this shop provides.";

  const sys =
    `You read an image a customer sent to the shop "${provider.name}". ` +
    `This shop deals in: ${hint}\n` +
    (catalogNames.length
      ? `Its catalog (preferred spellings): ${catalogNames.join(", ")}.\n`
      : "") +
    "Identify every distinct real-world item visible (handwritten list, printed list, prescription, or a photo of the goods themselves). " +
    "For each item decide whether it plausibly belongs to THIS shop's line of business. " +
    "Return ONLY a JSON object of the form " +
    `{"items":[{"name": string, "qty": integer>=1, "inCatalog": boolean, "relevant": boolean, "note": string}]}. ` +
    "Rules: 'name' — use the catalog spelling when it matches, else a clean singular name. " +
    "'qty' — the count/quantity shown (default 1). " +
    "'inCatalog' — true only if it clearly matches a catalog name above. " +
    "'relevant' — true if it belongs to this shop's business, false for unrelated things (e.g. an iPhone on a vegetable list). " +
    "'note' — short reason when relevant is false or qty/unit is ambiguous, else empty string. " +
    "Do not invent items that are not in the image. Return valid JSON only.";

  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
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
    parsed = JSON.parse(data.choices?.[0]?.message?.content || "{}");
  } catch {
    return { ok: false, error: "groq_bad_json" };
  }

  const items = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((it) => ({
      name: String(it?.name || "").trim(),
      qty: Math.max(1, parseInt(it?.qty, 10) || 1),
      inCatalog: !!it?.inCatalog,
      relevant: it?.relevant !== false, // default to relevant unless the model says otherwise
      note: String(it?.note || "").trim(),
    }))
    .filter((it) => it.name);

  return { ok: true, items };
}
