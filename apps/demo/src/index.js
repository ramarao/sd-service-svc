// Worker entry for a marketplace town. Wires the shared core engine to this
// town's config; the flow is resolved per provider's vertical at request time.
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
