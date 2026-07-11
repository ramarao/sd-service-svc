-- Category for catalog items. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0009_catalog_category.sql
ALTER TABLE catalog_items ADD COLUMN category TEXT;
