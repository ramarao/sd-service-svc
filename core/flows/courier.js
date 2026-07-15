// Courier vertical — the shop accepts, packs, and hands the parcel to a
// third-party courier (DTDC, Delhivery, India Post, Blue Dart…), recording the
// courier + tracking number. No own delivery agent; the shop drives every step.
// Courier orders are prepaid, so the customer gets a UPI pay link once shipped.
export default {
  agentTerm: "Courier",
  statuses: ["REQUESTED", "ACCEPTED", "PREPARING", "SHIPPED", "DELIVERED"],
  terminal: ["REJECTED", "DELIVERED"],
  decision: { from: "REQUESTED", accept: "ACCEPTED", reject: "REJECTED" },
  notify: ["ACCEPTED", "REJECTED", "PREPARING", "SHIPPED", "DELIVERED"],
  labels: {
    REQUESTED: "We received your order",
    ACCEPTED: "Your order is confirmed",
    REJECTED: "Order cancelled",
    PREPARING: "The shop is packing your order",
    SHIPPED: "Your order has been shipped 📦",
    DELIVERED: "Delivered — thank you!",
  },
  // Courier + tracking are captured when the order is shipped (role 'courier' →
  // the dispatch UI shows courier/tracking inputs instead of a field-agent picker).
  assignments: [{ at: "SHIPPED", slot: "primary", role: "courier" }],
  advance: {}, // no field-agent app actions — the shop advances every step
  itemsEditableAt: [],
  paymentAfter: "SHIPPED",
};
