// Flow registry — maps a vertical slug to its flow definition. A provider's
// `vertical` column (== a key here) selects the flow that drives its orders, so
// one Worker (one town) can run many verticals side by side.
//
// Adding a brand-new flow shape = add a file here + register it. Enabling it in a
// town + attaching providers is pure data (the `verticals` table + provider rows).
import laundry from "./laundry.js";
import appliance from "./appliance.js";
import delivery from "./delivery.js";
import courier from "./courier.js";

export const FLOWS = { laundry, appliance, delivery, courier };

// The default vertical used when a provider has no `vertical` set — set once per
// Worker by createApp(config.defaultVertical). Keeps single-vertical apps (dhobi,
// homeease) working before the multi-vertical `verticals`/`provider.vertical`
// data exists; in a town every provider carries an explicit vertical.
let _defaultVertical = "laundry";
export function setDefaultVertical(v) {
  if (v && FLOWS[v]) _defaultVertical = v;
}

// Resolve the flow for a provider row. Prefers the flow of the provider's vertical
// (populated as `vertical_flow` by getProvider's join) so many verticals can share
// one flow — e.g. medical/fruits/milk verticals all run 'delivery'. Falls back to
// treating the vertical slug itself as a flow key (legacy: slug == flow key), then
// to the Worker's default vertical.
export function flowForProvider(provider) {
  const key = provider?.vertical_flow || provider?.vertical || _defaultVertical;
  return FLOWS[key] || FLOWS[_defaultVertical];
}

// Resolve a flow directly by vertical slug (null if unknown).
export function flowForVertical(slug) {
  return FLOWS[slug] || FLOWS[_defaultVertical] || null;
}
