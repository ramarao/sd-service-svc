-- Contact name/phone on addresses (+ order snapshot). Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0008_address_contact.sql
ALTER TABLE customer_addresses ADD COLUMN contact_name TEXT;
ALTER TABLE customer_addresses ADD COLUMN contact_phone TEXT;
ALTER TABLE orders ADD COLUMN contact_name TEXT;
ALTER TABLE orders ADD COLUMN contact_phone TEXT;
