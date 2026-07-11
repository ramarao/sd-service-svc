-- Per-provider managers with two tiers: 'admin' (can manage other managers) and
-- 'manager' (everything except the Managers tab). Phone-keyed like captains, so a
-- manager can serve multiple providers. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0016_managers.sql
CREATE TABLE IF NOT EXISTS managers (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES service_providers(id),
  name        TEXT,
  phone       TEXT,                  -- E.164 digits incl. country code (no '+')
  tier        TEXT NOT NULL DEFAULT 'manager',  -- 'admin' | 'manager'
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_managers_provider ON managers(provider_id);
CREATE INDEX IF NOT EXISTS idx_managers_phone ON managers(phone);
