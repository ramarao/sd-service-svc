-- Customer address book + order link. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0006_address_book.sql
CREATE TABLE IF NOT EXISTS customer_addresses (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  label       TEXT,
  line1       TEXT,
  area        TEXT,
  lat         REAL,
  lng         REAL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addr_customer ON customer_addresses(customer_id);
ALTER TABLE orders ADD COLUMN address_id TEXT;
