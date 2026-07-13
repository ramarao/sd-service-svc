// Laundry / dhobi vertical — pickup → service → deliver.
// Two field-agent slots: a pickup captain (primary) and a delivery captain
// (delivery). Payment is collected after delivery.
export default {
  agentTerm: "Captain",
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
  assignments: [
    { at: "ASSIGNED", slot: "primary", role: "pickup" },
    { at: "OUT_FOR_DELIVERY", slot: "delivery", role: "delivery" },
  ],
  advance: {
    ASSIGNED: { slot: "primary", to: "PICKED_UP", label: "Confirm pickup", section: "🧢 To pick up" },
    OUT_FOR_DELIVERY: { slot: "delivery", to: "DELIVERED", label: "Confirm delivered", section: "🛵 To deliver" },
  },
  itemsEditableAt: ["ASSIGNED"],
  paymentAfter: "DELIVERED",
};
