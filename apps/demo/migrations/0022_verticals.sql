-- Marketplace: verticals as data + link providers to a vertical (→ its flow).
CREATE TABLE IF NOT EXISTS verticals (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  emoji       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
ALTER TABLE service_providers ADD COLUMN vertical TEXT;
CREATE INDEX IF NOT EXISTS idx_providers_vertical ON service_providers(vertical);
