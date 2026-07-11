-- Adds DB-managed WhatsApp config. Apply to an existing deployment:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0001_whatsapp_settings.sql

CREATE TABLE IF NOT EXISTS platform_settings (
  id              TEXT PRIMARY KEY,
  wa_verify_token TEXT,
  wa_app_secret   TEXT,
  wa_token        TEXT,
  wa_api_version  TEXT NOT NULL DEFAULT 'v21.0',
  updated_at      INTEGER
);

-- SQLite has no "ADD COLUMN IF NOT EXISTS"; this errors harmlessly if already added.
ALTER TABLE service_providers ADD COLUMN wa_token TEXT;
