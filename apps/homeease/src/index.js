// Worker entry for the HomeEase Guru service. Wires the shared core engine
// (../../../core) to this vertical's config, and exposes the Worker handlers.
import { createApp } from "../../../core/app.js";
import config from "../config.js";
import { handleEmail } from "../../../core/email.js";
import { OrdersHub } from "../../../core/orders-hub.js";

const app = createApp(config);

// Serve HTTP via Hono, and handle inbound email (Cloudflare Email Routing).
export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  email: (message, env, ctx) => handleEmail(message, env, ctx),
};

// Durable Object class (referenced by wrangler.jsonc durable_objects binding).
export { OrdersHub };
