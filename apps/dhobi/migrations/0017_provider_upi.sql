-- Per-provider UPI details for collecting payment. Captains show a UPI QR to the
-- customer after delivery. Set by the provider's *admin* on the manager app's
-- Payment tab. Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0017_provider_upi.sql
ALTER TABLE service_providers ADD COLUMN upi_id   TEXT;  -- VPA, e.g. name@okhdfcbank
ALTER TABLE service_providers ADD COLUMN upi_name TEXT;  -- payee name shown in the UPI app
