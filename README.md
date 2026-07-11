# sd-service-svc

Multi-provider **on-site service platform** (pickup → service → deliver) on a
single Cloudflare Worker. One codebase runs any number of service verticals —
laundry, dry-cleaning, tailoring, shoe/appliance repair, at-home salon — as rows
in `service_providers`, not as forks. Orders come in via a **web form** or the
**WhatsApp Business API**, and every status change notifies the customer on
WhatsApp (free text inside the 24h window, an approved **Utility template**
outside it).

Fits entirely on the Cloudflare **free plan** (Workers + D1 + Static Assets).

## Architecture

```
┌──────────────────────── one Worker ────────────────────────┐
│  /webhook/whatsapp   WABA verify + signed inbound           │
│  /auth/*             customer OTP · admin password · session│
│  /api/my/*           customer: create / list / track orders │
│  /api/admin/*        provider admin: board + status advance │
│  /api/console/*      super-admin: providers, catalog, admins│
│  everything else →   static SPA (public/) via ASSETS binding│
└─────────────────────────────────────────────────────────────┘
        D1 (SQLite): providers, catalog, customers, users,
                     orders, order_items, order_events, otp_codes
```

### Roles

| Role | Login | Scope |
|------|-------|-------|
| `customer` | WhatsApp OTP (passwordless) | own orders only (enforced by session, never client input) |
| `admin` | email + password | one provider's orders (`provider_id` scoped) |
| `super_admin` | email + password | all providers; onboards verticals, edits catalogs, creates admins |

### Order state machine

`REQUESTED → ASSIGNED → PICKED_UP → IN_SERVICE → OUT_FOR_DELIVERY → DELIVERED`
(plus `CANCELLED`). Each transition writes an `order_events` row **and** fires
`notifyCustomer`, which chooses free-text vs. Utility template based on the
customer's last-inbound timestamp (the 24h window).

## Local dev

```bash
npm install
npx wrangler d1 create sd-service-db        # paste database_id into wrangler.jsonc
cp .dev.vars.example .dev.vars              # fill in secrets (WA_* optional for UI-only testing)
npm run db:local                            # apply schema to the local D1
npm run seed:local                          # optional demo provider + catalog
npm run dev                                 # http://localhost:8787
```

Then bootstrap the first super-admin (password gets hashed server-side):

```bash
curl -X POST http://localhost:8787/api/setup/super-admin \
  -H "X-Setup-Token: dev-setup-token" -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"changeme"}'
```

Log in at `http://localhost:8787/console`, create a provider + a provider admin,
then visit the customer app at `http://localhost:8787/<slug>/app`.

## Deploy (free Cloudflare account)

```bash
npm run db:remote                           # apply schema to remote D1
npx wrangler secret put SESSION_SECRET      # long random string
npx wrangler secret put WA_TOKEN            # Meta permanent token
npx wrangler secret put WA_APP_SECRET       # Meta app secret (webhook signature)
npx wrangler secret put WA_VERIFY_TOKEN     # arbitrary; also paste into Meta
npx wrangler secret put WA_PHONE_NUMBER_ID  # fallback; providers override per-row
npx wrangler secret put SETUP_TOKEN         # guards the one-time super-admin bootstrap
npm run deploy                              # → https://sd-service-svc.<sub>.workers.dev
```

Set `PUBLIC_HOST` as a plain var (or secret) to your deployed host so WhatsApp
replies link to the right URL.

## WhatsApp Business API setup (Meta side)

1. **Meta app** → add *WhatsApp* product. Note the **phone-number-id** and
   generate a **permanent access token** (System User token with
   `whatsapp_business_messaging`). These become `WA_PHONE_NUMBER_ID` / `WA_TOKEN`.
2. **Webhook**: in the app's WhatsApp → Configuration, set callback URL to
   `https://<your-worker>/webhook/whatsapp` and the verify token to whatever you
   set as `WA_VERIFY_TOKEN`. Subscribe to the `messages` field. Copy the **App
   Secret** into `WA_APP_SECRET` (used to verify `X-Hub-Signature-256`).
3. **Multi-provider**: put each provider's phone-number-id in its
   `service_providers.wa_phone_number_id`. Inbound messages are routed to the
   right provider via `value.metadata.phone_number_id`; outbound uses that id.
4. **Utility templates**: in WhatsApp Manager → Message Templates, create
   **Utility**-category templates (they get approved fast and are the cheapest):
   `order_picked_up`, `order_in_service`, `order_out_for_delivery`,
   `order_delivered`, `login_code`. Give each a body with `{{1}}` for the order
   id (or the code, for `login_code`). Reference their names in each provider's
   `config.templates`. Until a customer messages you, only templates can be sent;
   inside 24h of their last message the Worker sends plain text.

## Free-tier notes

- 10 ms **CPU** limit per request is CPU-time, not wall-clock — the outbound
  `fetch()` to Meta is I/O and doesn't count. PBKDF2 admin-login hashing is set
  to 100k iterations to stay well under budget.
- D1 free: 5 GB, 5M reads + 100k writes/day — ample for order volume.
- `run_worker_first` in `wrangler.jsonc` sends only `/api|/auth|/webhook` to the
  Worker; all other paths are served as static assets (SPA fallback to
  `index.html`).

## Extending

- **Structured WhatsApp intake**: replace the greeting stub in `handleWebhook`
  with WhatsApp **Flows** or interactive list messages for item+qty capture.
- **Proof photos**: add an R2 bucket + presigned uploads for pickup/delivery.
- **Live board**: a Durable Object per provider to push status changes to open
  dashboards over WebSocket (SQLite-backed DOs are on the free plan).
- **Payments**: reuse the Scandeer `sd-payment-worker` white-label Razorpay flow.
