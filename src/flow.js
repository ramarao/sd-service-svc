// Config-driven order state machine.
//
// A `flow` object (see each app's config.js) describes one vertical's order
// lifecycle: its ordered statuses, the accept/reject decision branch, which
// statuses notify the customer, the field-agent assignment slots, the advance
// actions a field agent can take, and where payment is collected.
//
// These helpers are pure — they read a flow and answer questions about it. The
// engine (db.js, app.js) stays vertical-agnostic by going through them instead
// of hardcoding "PICKED_UP" / "OUT_FOR_DELIVERY" etc.
//
// Slots map to fixed DB columns (schema shared across verticals):
//   primary  → agent_name / captain_phone
//   delivery → delivery_captain_name / delivery_captain_phone
// A single-assignment vertical (e.g. on-site technician) uses only `primary`.

function rankMap(flow) {
  return Object.fromEntries(flow.statuses.map((s, i) => [s, i]));
}

export function isTerminal(flow, s) {
  return (flow.terminal || []).includes(s);
}

// Is a status change allowed? accept/reject only from the decision status;
// terminal statuses are final; otherwise advance exactly one linear step forward
// (no skipping, no going back).
export function canTransition(flow, from, to) {
  if (from === to) return false;
  if (isTerminal(flow, from)) return false;
  const dec = flow.decision;
  if (dec && (to === dec.accept || to === dec.reject)) return from === dec.from;
  const rank = rankMap(flow);
  if (!(from in rank) || !(to in rank)) return false;
  const acceptRank = dec ? rank[dec.accept] : 1;
  // Must be past the decision (i.e. accepted) and move to the immediate next step.
  return rank[from] >= acceptRank && rank[to] === rank[from] + 1;
}

// Valid next statuses from a given status (drives the admin UI controls).
export function allowedTransitions(flow, from) {
  if (isTerminal(flow, from)) return [];
  const dec = flow.decision;
  if (dec && from === dec.from) return [dec.accept, dec.reject];
  return flow.statuses.filter((s) => canTransition(flow, from, s));
}

// Statuses that trigger a customer WhatsApp notification.
export function notifyStatuses(flow) {
  return new Set(flow.notify || []);
}

// The field-agent action available FROM a status: which slot may advance it, the
// target status, and UI labels. null when no field-agent action applies here.
export function advanceStep(flow, from) {
  const a = flow.advance?.[from];
  if (!a) return null;
  return { slot: a.slot || "primary", to: a.to, label: a.label, section: a.section || a.label };
}

// When transitioning TO `status`, which agent slot (if any) is assigned there.
export function assignmentAt(flow, status) {
  const a = (flow.assignments || []).find((x) => x.at === status);
  return a ? { slot: a.slot || "primary", role: a.role || null } : null;
}

// May the assigned (primary) agent still edit the order's items at this status?
export function itemsEditableAt(flow, status) {
  return (flow.itemsEditableAt || []).includes(status);
}

// The order id / phone columns backing a slot.
export function slotColumns(slot) {
  return slot === "delivery"
    ? { nameCol: "delivery_captain_name", phoneCol: "delivery_captain_phone" }
    : { nameCol: "agent_name", phoneCol: "captain_phone" };
}
