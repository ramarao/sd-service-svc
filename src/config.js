// Dhobi (laundry) app configuration — the one vertical this Worker serves.
// The engine (core: app.js, db.js, wa.js, flow.js) is vertical-agnostic and is
// driven entirely by this object. A second service (e.g. HomeEase Guru) is a
// separate Worker with its own config.js importing the same core.
//
// flow: the order lifecycle — pickup → service → deliver.
//   REQUESTED → ACCEPTED → ASSIGNED → PICKED_UP → IN_SERVICE → OUT_FOR_DELIVERY → DELIVERED
//   (REJECTED is a terminal branch off REQUESTED.)
// Two field-agent slots: a pickup captain (primary) and a delivery captain
// (delivery). Payment is collected after delivery.

export default {
  brand: {
    name: "Dhobi",
    agentTerm: "Captain", // what the field agent is called in the UI + notifications
  },
  flow: {
    statuses: ["REQUESTED", "ACCEPTED", "ASSIGNED", "PICKED_UP", "IN_SERVICE", "OUT_FOR_DELIVERY", "DELIVERED"],
    terminal: ["REJECTED", "DELIVERED"],
    decision: { from: "REQUESTED", accept: "ACCEPTED", reject: "REJECTED" },
    notify: ["ACCEPTED", "REJECTED", "PICKED_UP", "IN_SERVICE", "OUT_FOR_DELIVERY", "DELIVERED"],
    labels: {
      REQUESTED: "We received your request",
      ACCEPTED: "Your request has been accepted",
      REJECTED: "Sorry, we couldn't accept your request this time",
      ASSIGNED: "A captain has been assigned to your order",
      PICKED_UP: "We've collected your items",
      IN_SERVICE: "Your order is being processed",
      OUT_FOR_DELIVERY: "Out for delivery",
      DELIVERED: "Delivered — thank you!",
    },
    // Which status assigns a field agent, and to which slot.
    assignments: [
      { at: "ASSIGNED", slot: "primary", role: "pickup" },
      { at: "OUT_FOR_DELIVERY", slot: "delivery", role: "delivery" },
    ],
    // Field-agent advance actions: from status X, the given slot moves it to `to`.
    // `label` is the confirm button; `section` groups the job list.
    advance: {
      ASSIGNED: { slot: "primary", to: "PICKED_UP", label: "Confirm pickup", section: "🧢 To pick up" },
      OUT_FOR_DELIVERY: { slot: "delivery", to: "DELIVERED", label: "Confirm delivered", section: "🛵 To deliver" },
    },
    // The (primary) pickup captain may reconcile items only while at these statuses.
    itemsEditableAt: ["ASSIGNED"],
    // Payment QR is offered once the order reaches this status.
    paymentAfter: "DELIVERED",
  },
};
