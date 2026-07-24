# Standalone city

A single, self-contained city you can deploy to Cloudflare on its own — **no
super-admin control plane**. After deploy, one admin logs in and configures
everything (WhatsApp, Groq, Maps, providers, verticals, catalogs, city name)
from the dashboard at **`/console`**.

One city = one Worker + one D1 database + one WhatsApp number + one domain.

## Deploy

From the repo root, with `wrangler` installed and `wrangler login` done:

1. **Name it.** In `apps/city/wrangler.jsonc` set `name` (e.g. `sd-tanuku-svc`),
   the `d1_databases[0].database_name` (e.g. `sd-tanuku-db`), and the `routes`
   domain — or delete `routes` to use the free `*.workers.dev` URL.

2. **Create the database** and paste its id into `wrangler.jsonc`:
   ```bash
   npx wrangler d1 create sd-city-db
   # copy the printed database_id → d1_databases[0].database_id
   ```

3. **Create the tables:**
   ```bash
   npx wrangler d1 execute sd-city-db --remote -c apps/city/wrangler.jsonc --file=./apps/city/schema.sql
   ```

4. **Set the one required secret** (any long random string) and the domain:
   ```bash
   npx wrangler secret put SESSION_SECRET -c apps/city/wrangler.jsonc
   npx wrangler secret put PUBLIC_HOST   -c apps/city/wrangler.jsonc   # your city's domain, e.g. tanuku.example.com
   ```

5. **Deploy:**
   ```bash
   npx wrangler deploy -c apps/city/wrangler.jsonc
   ```

## First login

1. Open `https://<your-domain>/console`.
2. Log in with **`admin` / `admin`** — this creates the admin account on first use.
3. You're immediately asked to **set a new password** (min 8 chars). Do it.
4. In the dashboard:
   - **Settings** → set the **City name**, then the **WhatsApp / Meta** creds
     (verify token, app secret, access token, phone-number-id), the **Groq** key
     (payment-receipt reading), and **Ola Maps** key (address autocomplete).
   - **Providers** → add your shops, their verticals, catalogs, managers, captains.
5. In **Meta → WhatsApp → Configuration**, paste the **Webhook URL** and **verify
   token** shown on the Settings tab, and subscribe to the `messages` field.

That's it — the city is live and fully self-managed. `admin`/`admin` only works
until the first login; after that the account has your chosen password and the
default no longer works.

## Local dev

```bash
cp apps/city/.dev.vars.example apps/city/.dev.vars   # then edit SESSION_SECRET
npx wrangler d1 execute sd-city-db --local -c apps/city/wrangler.jsonc --file=./apps/city/schema.sql
npx wrangler dev -c apps/city/wrangler.jsonc --port 8790 --local
```

## Notes

- **Shared engine, own front end.** The backend is the shared `core/` (imported by
  `src/index.js`); `public/` is this city's own copy of the SPA. If you pull core
  changes that touch the UI, re-copy `apps/demo/public` → `apps/city/public`.
- **No control plane.** This city does not need and is not managed by
  `apps/admin`. The `CONTROL_TOKEN` secret is optional (only used if you ever
  attach a control plane).
