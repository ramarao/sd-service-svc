// Courier vertical — the shop accepts, packs, and hands the parcel to a
// third-party courier (DTDC, Delhivery, India Post, Blue Dart…), recording a
// tracking link that's forwarded to the customer. No own delivery agent; the
// shop drives every step.
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
  // A tracking link is captured when the order is shipped (role 'courier' →
  // the dispatch UI shows a tracking-URL input instead of a field-agent picker).
  assignments: [{ at: "SHIPPED", slot: "primary", role: "courier" }],
  advance: {}, // no field-agent app actions — the shop advances every step
  itemsEditableAt: [],
  paymentAfter: "SHIPPED",
  // Prepaid: the parcel leaves the shop, so there's no cash-on-delivery moment.
  // Forces payment_method='upi' and gates packing on a confirmed payment.
  prepaid: true,
};
