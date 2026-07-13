// Delivery-from-shop vertical (medical, meat, groceries…) — the shop prepares the
// order, then a delivery agent takes it to the customer. Single field-agent slot:
// the Delivery agent (primary), assigned when the order goes out for delivery.
// Payment is collected on delivery.
export default {
  agentTerm: "Delivery agent",
  statuses: ["REQUESTED", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY", "DELIVERED"],
  terminal: ["REJECTED", "DELIVERED"],
  decision: { from: "REQUESTED", accept: "ACCEPTED", reject: "REJECTED" },
  notify: ["ACCEPTED", "REJECTED", "PREPARING", "OUT_FOR_DELIVERY", "DELIVERED"],
  labels: {
    REQUESTED: "We received your order",
    ACCEPTED: "Your order has been accepted",
    REJECTED: "Sorry, we couldn't accept your order this time",
    PREPARING: "The shop is preparing your order",
    OUT_FOR_DELIVERY: "Your order is out for delivery",
    DELIVERED: "Delivered — thank you!",
  },
  // The delivery agent is assigned when the order goes out for delivery.
  assignments: [{ at: "OUT_FOR_DELIVERY", slot: "primary", role: "delivery" }],
  advance: {
    OUT_FOR_DELIVERY: { slot: "primary", to: "DELIVERED", label: "Confirm delivered", section: "🛵 To deliver" },
  },
  // Items are fixed by the customer's order; the delivery agent doesn't edit them.
  itemsEditableAt: [],
  paymentAfter: "DELIVERED",
};
