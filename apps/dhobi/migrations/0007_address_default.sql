-- Default flag for the customer address book. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0007_address_default.sql
ALTER TABLE customer_addresses ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
