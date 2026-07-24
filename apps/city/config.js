// Standalone single-city config. One city = one Worker + D1 + WhatsApp number +
// domain. Everything else (WhatsApp/Groq/Maps keys, providers, verticals,
// catalogs, and even the displayed city name) is set AT RUNTIME in the admin
// dashboard at /console — no control plane, no redeploy. `brand.name` here is
// only a fallback until the admin sets the city name in the dashboard.
export default {
  brand: {
    name: "My City", // fallback only — override in the dashboard (Settings → City name)
    host: "example.com", // set to this city's domain; used to build WhatsApp magic links
  },
  defaultVertical: "delivery",
};
