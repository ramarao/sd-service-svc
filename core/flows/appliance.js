// Appliance-repair vertical — on-site visit. Single field-agent slot: the
// Technician (primary). Payment is collected after the job is COMPLETED.
export default {
  agentTerm: "Technician",
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
  assignments: [{ at: "ASSIGNED", slot: "primary", role: "technician" }],
  advance: {
    ASSIGNED: { slot: "primary", to: "EN_ROUTE", label: "Start travel", section: "📋 To start" },
    EN_ROUTE: { slot: "primary", to: "ARRIVED", label: "Mark arrived", section: "🚗 En route" },
    ARRIVED: { slot: "primary", to: "IN_SERVICE", label: "Start service", section: "📍 On site" },
    IN_SERVICE: { slot: "primary", to: "COMPLETED", label: "Mark completed", section: "🔧 In service" },
  },
  itemsEditableAt: ["ASSIGNED", "ARRIVED", "IN_SERVICE"],
  paymentAfter: "COMPLETED",
};
