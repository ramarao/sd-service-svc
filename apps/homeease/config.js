// HomeEase Guru app configuration. The on-site flow now lives in the shared flow
// registry (core/flows/appliance.js) and is resolved per provider; this app is a
// single-vertical Worker, so it just declares its brand + default vertical.
// (Superseded by the per-town marketplace app; kept working until retired.)
export default {
  brand: {
    name: "HomeEase Guru",
    agentTerm: "Technician", // legacy SPA hero label; core reads agentTerm from the flow
  },
  defaultVertical: "appliance",
};
