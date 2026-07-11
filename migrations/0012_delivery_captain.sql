-- Separate pickup vs delivery captain on an order. The existing
-- agent_name / captain_phone columns now hold the PICKUP captain
-- (assigned at ASSIGNED); these hold the DELIVERY captain (assigned at
-- OUT_FOR_DELIVERY). Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0012_delivery_captain.sql
ALTER TABLE orders ADD COLUMN delivery_captain_name TEXT;
ALTER TABLE orders ADD COLUMN delivery_captain_phone TEXT;
