-- Captain login identity, keyed by phone so it spans every provider the captain
-- works for (captains has one row per provider; the account is one per phone).
-- pass_hash is null until the captain sets a password on first login. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0013_captain_accounts.sql
CREATE TABLE IF NOT EXISTS captain_accounts (
  phone      TEXT PRIMARY KEY,   -- E.164 digits incl. country code (no '+')
  name       TEXT,
  pass_hash  TEXT,               -- PBKDF2 'iter$salt$hash'; null until first-login setup
  created_at INTEGER NOT NULL
);
