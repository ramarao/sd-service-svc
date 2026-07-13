-- Control-plane (super-admin) registry DB. Separate from any town's D1.

-- The one super-admin (or a few). Password login; bootstrap via SETUP_TOKEN.
CREATE TABLE IF NOT EXISTS admin_users (
  id         TEXT PRIMARY KEY,
  email      TEXT UNIQUE NOT NULL,
  pass_hash  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Cloudflare accounts the control plane can deploy town Workers onto. The
-- cf_api_token is a scoped account token (Workers Scripts + D1 + Workers Routes edit).
CREATE TABLE IF NOT EXISTS deploy_targets (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,              -- e.g. "ramarao.satti@gmail.com"
  cf_account_id TEXT NOT NULL,
  cf_api_token  TEXT NOT NULL,
  zone_id       TEXT,                        -- zone for the custom domain (manasanta.in)
  created_at    INTEGER NOT NULL
);

-- One row per town (a deployed marketplace Worker, possibly on another CF account).
-- The control_token is that town's CONTROL_TOKEN secret; url is its base origin.
CREATE TABLE IF NOT EXISTS towns (
  id            TEXT PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,             -- e.g. https://demo.manasanta.in
  control_token TEXT NOT NULL,             -- the town Worker's CONTROL_TOKEN
  wa_number     TEXT,                       -- the town's WhatsApp number (display)
  domain        TEXT,
  cf_account    TEXT,                       -- label of the CF account it's deployed to
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL
);
