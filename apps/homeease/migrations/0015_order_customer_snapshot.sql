-- Snapshot the ordering customer's name + WhatsApp phone onto the order, so the
-- captain (and admin) can see who placed it without a join and even if the
-- customer record later changes. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0015_order_customer_snapshot.sql
ALTER TABLE orders ADD COLUMN customer_name TEXT;
ALTER TABLE orders ADD COLUMN customer_phone TEXT;
