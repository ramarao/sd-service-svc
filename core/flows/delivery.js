// Delivery-from-shop vertical (medical, meat, groceries…) — the shop prepares the
// order, then a delivery agent takes it to the customer. Single field-agent slot:
// the Delivery agent (primary), assigned when the order goes out for delivery.
// Payment is collected on delivery.
export default {
  agentTerm: "Delivery agent",
  statuses: ["REQUESTED", "QUOTED", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY", "DELIVERED"],
  terminal: ["REJECTED", "DELIVERED"],
  decision: { from: "REQUESTED", accept: "ACCEPTED", reject: "REJECTED" },
  // Quote-and-confirm branch (photo/list orders): the shop prices the order and
  // sends it (REQUESTED→QUOTED); the customer then approves or rejects.
  extraTransitions: [["REQUESTED", "QUOTED"], ["QUOTED", "ACCEPTED"], ["QUOTED", "REJECTED"]],
  notify: ["QUOTED", "ACCEPTED", "REJECTED", "PREPARING", "OUT_FOR_DELIVERY", "DELIVERED"],
  labels: {
    REQUESTED: "We received your order",
    QUOTED: "Your order has been priced — please review and confirm",
    ACCEPTED: "Your order is confirmed",
    REJECTED: "Order cancelled",
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
