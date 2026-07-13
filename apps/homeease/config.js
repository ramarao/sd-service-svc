// HomeEase Guru app configuration — home-appliance repair, an on-site vertical.
// Imports the same core engine as Dhobi (../../../core); only this config differs.
//
// flow: an on-site visit — no pickup/delivery legs.
//   REQUESTED → ACCEPTED → ASSIGNED → EN_ROUTE → ARRIVED → IN_SERVICE → COMPLETED
//   (REJECTED is a terminal branch off REQUESTED.)
// A single field-agent slot: the Technician (primary). Payment is collected after
// the job is COMPLETED. The delivery slot is unused for this vertical.

export default {
  brand: {
    name: "HomeEase Guru",
    agentTerm: "Technician",
  },
  flow: {
    statuses: ["REQUESTED", "ACCEPTED", "ASSIGNED", "EN_ROUTE", "ARRIVED", "IN_SERVICE", "COMPLETED"],
    terminal: ["REJECTED", "COMPLETED"],
    decision: { from: "REQUESTED", accept: "ACCEPTED", reject: "REJECTED" },
    notify: ["ACCEPTED", "REJECTED", "ASSIGNED", "EN_ROUTE", "ARRIVED", "IN_SERVICE", "COMPLETED"],
    labels: {
      REQUESTED: "We received your service request",
      ACCEPTED: "Your service request has been accepted",
      REJECTED: "Sorry, we couldn't accept your request this time",
      ASSIGNED: "A technician has been assigned to your job",
      EN_ROUTE: "Your technician is on the way",
      ARRIVED: "Your technician has arrived",
      IN_SERVICE: "Service in progress",
      COMPLETED: "Service completed — thank you!",
    },
    // Single assignment point: the technician is assigned at ASSIGNED (primary slot).
    assignments: [{ at: "ASSIGNED", slot: "primary", role: "technician" }],
    // The technician (primary slot) walks the job through each on-site step.
    advance: {
      ASSIGNED: { slot: "primary", to: "EN_ROUTE", label: "Start travel", section: "📋 To start" },
      EN_ROUTE: { slot: "primary", to: "ARRIVED", label: "Mark arrived", section: "🚗 En route" },
      ARRIVED: { slot: "primary", to: "IN_SERVICE", label: "Start service", section: "📍 On site" },
      IN_SERVICE: { slot: "primary", to: "COMPLETED", label: "Mark completed", section: "🔧 In service" },
    },
    // The technician can adjust the quote (add/remove services & parts) on-site,
    // from arrival until the job is completed.
    itemsEditableAt: ["ASSIGNED", "ARRIVED", "IN_SERVICE"],
    // Payment QR is offered once the job is COMPLETED.
    paymentAfter: "COMPLETED",
  },
};
