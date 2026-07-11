-- Ola Maps API key for address autocomplete. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0005_ola_maps.sql
-- (Supersedes the unused mappls_* columns from 0004 — those can stay, they're ignored.)
ALTER TABLE platform_settings ADD COLUMN ola_maps_api_key TEXT;
