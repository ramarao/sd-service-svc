-- Captain roster per provider + assigned-captain phone on orders. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0011_captains.sql
CREATE TABLE IF NOT EXISTS captains (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name        TEXT,
  phone       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captains_provider ON captains(provider_id);
ALTER TABLE orders ADD COLUMN captain_phone TEXT;
