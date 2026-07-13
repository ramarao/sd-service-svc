-- Per-day order-number counter for 001-DDMMYY ids. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0002_order_counters.sql

CREATE TABLE IF NOT EXISTS order_counters (
  day TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);
