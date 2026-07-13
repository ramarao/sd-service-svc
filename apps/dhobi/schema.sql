-- sd-service-svc schema (Cloudflare D1 / SQLite)
-- Generic pickup → service → deliver platform. Nothing here is vertical-specific;
-- a "laundry" and a "shoe repair" are just two rows in service_providers.

-- ── Platform settings (single 'global' row) ──────────────────────────────────
-- App-level WhatsApp/Meta config. One Meta app = one webhook, so App Secret and
-- Verify Token are platform-wide. Managed from the super-admin console.
CREATE TABLE IF NOT EXISTS platform_settings (
  id                    TEXT PRIMARY KEY,      -- always 'global'
  wa_verify_token       TEXT,                   -- you choose this; also pasted into Meta
  wa_app_secret         TEXT,                   -- Meta App Secret (verifies webhook sig)
  wa_token              TEXT,                   -- default access token (providers can override)
  wa_api_version        TEXT NOT NULL DEFAULT 'v21.0',
  ola_maps_api_key      TEXT,                   -- Ola Maps API key (address autocomplete)
  wa_display_number     TEXT,                   -- WhatsApp number captains message to log in (E.164 digits)
  groq_api_key          TEXT,                   -- Groq API key (parse payment emails)
  updated_at            INTEGER
);

-- ── Providers (verticals / shops) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_providers (
  id                 TEXT PRIMARY KEY,
  slug               TEXT UNIQUE NOT NULL,      -- used in URLs: /{slug}/app
  name               TEXT NOT NULL,
  wa_phone_number_id TEXT,                       -- WABA phone-number-id for this provider
  wa_token           TEXT,                       -- optional per-provider access token override
  config             TEXT NOT NULL DEFAULT '{}', -- JSON: labels, currency, template names
  upi_id             TEXT,                        -- VPA for collecting payment (e.g. name@okhdfcbank)
  upi_name           TEXT,                        -- payee name shown in the UPI app
  created_at         INTEGER NOT NULL
);

-- ── Catalog (what can be ordered) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS catalog_items (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  name        TEXT NOT NULL,          -- 'Shirt', 'Saree', 'Shoe resole'
  category    TEXT,                   -- e.g. 'Wash & Iron', 'Dry Clean'
  unit        TEXT NOT NULL DEFAULT 'piece',
  price       INTEGER DEFAULT 0,      -- minor units (paise), optional
  active      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_catalog_provider ON catalog_items(provider_id);

-- Predefined item categories per provider (managed in the console).
CREATE TABLE IF NOT EXISTS provider_categories (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provcat_name ON provider_categories(provider_id, name);

-- ── Captains (pickup/delivery staff) per provider ────────────────────────────
CREATE TABLE IF NOT EXISTS captains (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  name        TEXT,
  phone       TEXT,                  -- E.164 digits incl. country code (no '+')
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captains_provider ON captains(provider_id);

-- ── Managers (per-provider staff who run the admin app) ──────────────────────
-- tier 'admin' can add/remove other managers; tier 'manager' cannot. Phone-keyed
-- so one person can manage multiple providers.
CREATE TABLE IF NOT EXISTS managers (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  name        TEXT,
  phone       TEXT,
  tier        TEXT NOT NULL DEFAULT 'manager',  -- 'admin' | 'manager'
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managers_provider ON managers(provider_id);
CREATE INDEX IF NOT EXISTS idx_managers_phone ON managers(phone);

-- Captain login identity, keyed by phone (spans every provider the captain works
-- for). pass_hash is null until the captain sets a password on first login.
CREATE TABLE IF NOT EXISTS captain_accounts (
  phone      TEXT PRIMARY KEY,   -- E.164 digits incl. country code (no '+')
  name       TEXT,
  pass_hash  TEXT,               -- PBKDF2 'iter$salt$hash'; null until first-login setup
  created_at INTEGER NOT NULL
);

-- WhatsApp QR / click-to-chat login pairing (browser ⇄ WhatsApp message).
CREATE TABLE IF NOT EXISTS captain_login_sessions (
  nonce      TEXT PRIMARY KEY,   -- long secret shown only to the browser (polling key)
  code       TEXT NOT NULL,      -- short code embedded in the WhatsApp message
  phone      TEXT,               -- captain's verified number, set by the webhook
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_caplogin_code ON captain_login_sessions(code);

-- ── Customers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customers (
  id              TEXT PRIMARY KEY,
  wa_phone        TEXT UNIQUE NOT NULL,   -- E.164 digits, no '+'
  name            TEXT,
  address         TEXT,
  last_inbound_at INTEGER,                -- epoch ms of last WhatsApp msg → 24h window gate
  created_at      INTEGER NOT NULL
);

-- ── Customer address book ────────────────────────────────────────────────────
-- line1 = manually entered (flat/floor/street/landmark); area = map-derived
-- (locality/city/state/pincode from reverse geocode); lat/lng = the map pin.
CREATE TABLE IF NOT EXISTS customer_addresses (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  label         TEXT,
  contact_name  TEXT,
  contact_phone TEXT,
  line1         TEXT,
  area          TEXT,
  lat           REAL,
  lng           REAL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addr_customer ON customer_addresses(customer_id);

-- ── Users (auth) — customers (OTP) and admins (password) ─────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  role        TEXT NOT NULL,             -- 'customer' | 'admin' | 'super_admin'
  wa_phone    TEXT UNIQUE,               -- customers
  email       TEXT UNIQUE,               -- admins / super_admin
  pass_hash   TEXT,                      -- admins only: 'iterations$saltHex$hashHex'
  provider_id TEXT REFERENCES service_providers(id),  -- admin's shop (null for super_admin)
  customer_id TEXT REFERENCES customers(id),           -- role=customer link
  created_at  INTEGER NOT NULL
);

-- ── OTP codes (customer passwordless login) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  wa_phone   TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

-- ── Orders ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL REFERENCES service_providers(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  status       TEXT NOT NULL DEFAULT 'REQUESTED',
  address       TEXT,
  lat           REAL,                    -- geo point (from map picker)
  lng           REAL,
  address_id    TEXT REFERENCES customer_addresses(id),  -- saved address used, if any
  customer_name  TEXT,                   -- ordering customer's name (snapshot)
  customer_phone TEXT,                   -- ordering customer's WhatsApp number (snapshot)
  contact_name  TEXT,                    -- contact at the pickup point (snapshot)
  contact_phone TEXT,
  agent_name    TEXT,                    -- PICKUP captain name (assigned at ASSIGNED)
  captain_phone TEXT,                    -- PICKUP captain phone (snapshot)
  delivery_captain_name  TEXT,           -- DELIVERY captain name (assigned at OUT_FOR_DELIVERY)
  delivery_captain_phone TEXT,           -- DELIVERY captain phone (snapshot)
  payment_status TEXT,                   -- 'paid' | 'failed' | null (from settlement email)
  payment_ref    TEXT,                   -- gateway txn / order id
  payment_amount INTEGER,                -- amount received, in paise
  payment_payer  TEXT,                   -- payer VPA / name
  payment_at     INTEGER,                -- epoch ms when recorded
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_provider ON orders(provider_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_items (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  name       TEXT NOT NULL,
  qty        INTEGER NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0   -- paise, snapshot from catalog at order time
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- ── Per-day order-number counter (drives 001-DDMMYY ids) ─────────────────────
CREATE TABLE IF NOT EXISTS order_counters (
  day TEXT PRIMARY KEY,     -- 'DDMMYY' (IST)
  seq INTEGER NOT NULL
);

-- ── Status history / audit ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS order_events (
  id       TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  status   TEXT NOT NULL,
  actor    TEXT NOT NULL,                -- 'customer' | 'admin' | 'system'
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);

-- ── Payment email audit log (Worker email handler) ───────────────────────────
CREATE TABLE IF NOT EXISTS payment_email_log (
  id         TEXT PRIMARY KEY,
  from_addr  TEXT,
  subject    TEXT,
  body       TEXT,
  parsed     TEXT,
  order_id   TEXT,
  matched_by TEXT,
  reason     TEXT,
  applied    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON payment_email_log(created_at);
