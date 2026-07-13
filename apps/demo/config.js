// Demo town configuration — one town = one Worker + D1 + WhatsApp number + domain,
// hosting MANY verticals (laundry, appliance, delivery…) as data. The order flow
// is resolved per provider → its vertical from the shared registry (core/flows),
// so this config only carries town branding + a default vertical fallback.
export default {
  brand: {
    name: "Manasanta",
    host: "demo.manasanta.in", // used to build WhatsApp magic-links from the webhook
  },
  defaultVertical: "laundry",
};
