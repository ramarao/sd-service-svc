-- Snapshot the unit price on each order item. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0003_order_item_price.sql
ALTER TABLE order_items ADD COLUMN unit_price INTEGER NOT NULL DEFAULT 0;
