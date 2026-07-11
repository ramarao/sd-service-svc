-- Predefined item categories per provider. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0010_provider_categories.sql
CREATE TABLE IF NOT EXISTS provider_categories (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_provcat_name ON provider_categories(provider_id, name);
