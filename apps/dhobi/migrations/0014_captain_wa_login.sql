-- WhatsApp QR / click-to-chat login for captains (like WhatsApp Web pairing).
-- The browser holds the long `nonce` (polling key); the WhatsApp message carries
-- the short `code`. The webhook sets `phone` when the captain sends the message;
-- the browser then polls by nonce and gets a session. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0014_captain_wa_login.sql
CREATE TABLE IF NOT EXISTS captain_login_sessions (
  nonce      TEXT PRIMARY KEY,   -- long secret shown only to the browser
  code       TEXT NOT NULL,      -- short code embedded in the WhatsApp message
  phone      TEXT,               -- captain's verified number, set by the webhook
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_caplogin_code ON captain_login_sessions(code);

-- The WhatsApp display number captains message to log in (E.164 digits, no '+').
ALTER TABLE platform_settings ADD COLUMN wa_display_number TEXT;
