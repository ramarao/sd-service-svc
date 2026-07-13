-- Address geo points on orders + Mappls credentials in settings. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0004_geo_and_mappls.sql
ALTER TABLE orders ADD COLUMN lat REAL;
ALTER TABLE orders ADD COLUMN lng REAL;
ALTER TABLE platform_settings ADD COLUMN mappls_client_id TEXT;
ALTER TABLE platform_settings ADD COLUMN mappls_client_secret TEXT;
