// Worker entry for the Dhobi service. Wires the shared core engine (app.js) to
// this vertical's config, and exposes the Cloudflare Worker handlers.
//
// A second service (e.g. HomeEase) is a separate Worker: same import of ./app.js
// and the core modules, a different ./config.js.
import { createApp } from "./app.js";
import config from "./config.js";
import { handleEmail } from "./email.js";
import { OrdersHub } from "./orders-hub.js";

const app = createApp(config);

// Serve HTTP via Hono, and handle inbound email (Cloudflare Email Routing).
export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  email: (message, env, ctx) => handleEmail(message, env, ctx),
};

// Durable Object class (referenced by wrangler.jsonc durable_objects binding).
export { OrdersHub };
