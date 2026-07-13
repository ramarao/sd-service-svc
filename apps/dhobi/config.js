// Dhobi (laundry) app configuration. The order flow now lives in the shared flow
// registry (core/flows/laundry.js) and is resolved per provider; this app is a
// single-vertical Worker, so it just declares its brand + default vertical.
// (Superseded by the per-town marketplace app; kept working until retired.)
export default {
  brand: {
    name: "Dhobi",
    agentTerm: "Captain", // legacy SPA hero label; core reads agentTerm from the flow
  },
  defaultVertical: "laundry",
};
