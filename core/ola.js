// Ola Maps (Krutrim) address autocomplete — server-side proxy so the API key
// stays off the client. Predictions include geometry.location lat/lng directly.

export function olaConfigured(settings) {
  return !!settings?.ola_maps_api_key;
}

// Autocomplete. Returns { suggestions: [{placeName, placeAddress, eLoc, lat, lng}] }
// or { notConfigured: true } / { error }.
export async function olaSuggest(settings, query, location) {
  if (!olaConfigured(settings)) return { notConfigured: true };

  const url = new URL("https://api.olamaps.io/places/v1/autocomplete");
  url.searchParams.set("input", query);
  url.searchParams.set("api_key", settings.ola_maps_api_key);
  if (location) url.searchParams.set("location", location); // "lat,lng" bias

  const res = await fetch(url, { headers: { "X-Request-Id": crypto.randomUUID() } });
  if (!res.ok) {
    console.error("[ola] autocomplete failed", res.status, await res.text());
    return { error: "upstream", status: res.status };
  }
  const d = await res.json();
  const suggestions = (d.predictions || []).map((p) => ({
    placeName: p.structured_formatting?.main_text || p.description,
    placeAddress: p.structured_formatting?.secondary_text || "",
    eLoc: p.place_id || null,
    lat: p.geometry?.location?.lat ?? null,
    lng: p.geometry?.location?.lng ?? null,
  }));
  return { suggestions };
}

// Reverse geocode a lat/lng → formatted address (for the map pin).
export async function olaReverse(settings, lat, lng) {
  if (!olaConfigured(settings)) return { notConfigured: true };
  const url = new URL("https://api.olamaps.io/places/v1/reverse-geocode");
  url.searchParams.set("latlng", `${lat},${lng}`);
  url.searchParams.set("api_key", settings.ola_maps_api_key);
  const res = await fetch(url, { headers: { "X-Request-Id": crypto.randomUUID() } });
  if (!res.ok) {
    console.error("[ola] reverse failed", res.status, await res.text());
    return { error: "upstream", status: res.status };
  }
  const d = await res.json();
  const r = d.results?.[0] || {};
  const formatted = r.formatted_address || "";
  // Split into an editable premise (building / landmark) and a locked remainder
  // (street, area, city, state, country) the customer must not change.
  const premise = (r.name || formatted.split(",")[0] || "").trim();
  let locked;
  if (premise && formatted.toLowerCase().startsWith(premise.toLowerCase())) {
    locked = formatted.slice(premise.length).replace(/^\s*,\s*/, "").trim();
  } else {
    locked = formatted.split(",").slice(1).map((s) => s.trim()).filter(Boolean).join(", ");
  }
  return { address: formatted, premise, locked, lat: +lat, lng: +lng };
}
