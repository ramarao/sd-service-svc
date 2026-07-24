// Worker entry for a standalone single-city deployment. Wires the shared core
// engine to this city's config. No control plane — the admin configures
// everything from the dashboard at /console after first login (admin / admin).
import { createApp } from "../../../core/app.js";
import config from "../config.js";
import { handleEmail } from "../../../core/email.js";
import { OrdersHub } from "../../../core/orders-hub.js";

const app = createApp(config);

export default {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  email: (message, env, ctx) => handleEmail(message, env, ctx),
};

export { OrdersHub };
