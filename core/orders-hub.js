// Durable Object that fans out "orders changed" events to every connected
// dashboard over WebSockets. Uses hibernatable WebSockets so idle connections
// cost nothing. One global instance; connections are tagged by scope:
//   - a provider-scoped client → tag "p:<providerId>"
//   - a super-admin (sees everything) → tag "all"
// A broadcast for provider P is sent to tag "p:P" plus tag "all".
export class OrdersHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal broadcast trigger (from the Worker after an order mutation).
    if (url.pathname === "/broadcast") {
      const { providerId } = await request.json().catch(() => ({}));
      this.broadcast(providerId);
      return new Response("ok");
    }

    // WebSocket connection from a dashboard.
    if (request.headers.get("Upgrade") === "websocket") {
      const scope = url.searchParams.get("scope") || "all"; // providerId or "all"
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server, [scope === "all" ? "all" : `p:${scope}`]);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  broadcast(providerId) {
    if (!providerId) return;
    const msg = JSON.stringify({ type: "orders_changed", providerId, at: Date.now() });
    const targets = new Set([...this.state.getWebSockets(`p:${providerId}`), ...this.state.getWebSockets("all")]);
    for (const ws of targets) {
      try { ws.send(msg); } catch {}
    }
  }

  // Keep-alive: clients may send "ping".
  webSocketMessage(ws, message) {
    if (message === "ping") { try { ws.send("pong"); } catch {} }
  }
  webSocketClose(ws) { try { ws.close(); } catch {} }
  webSocketError(ws) { try { ws.close(); } catch {} }
}

// Tell every connected dashboard for this provider that orders changed. Safe to
// call from anywhere with env; no-ops if the binding is missing (e.g. local).
export async function notifyOrders(env, providerId) {
  if (!providerId || !env.ORDERS_HUB) return;
  try {
    const stub = env.ORDERS_HUB.get(env.ORDERS_HUB.idFromName("global"));
    await stub.fetch("https://orders-hub/broadcast", { method: "POST", body: JSON.stringify({ providerId }) });
  } catch (e) {
    console.error("[ws] notify failed", e);
  }
}
