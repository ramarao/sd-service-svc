-- Optional local dev seed. Run AFTER schema.sql:
--   npm run seed:local
-- Creates one demo provider + catalog. (No admin/super-admin here — create the
-- super-admin via the /api/setup/super-admin bootstrap so the password is hashed.)

INSERT OR IGNORE INTO service_providers (id, slug, name, wa_phone_number_id, config, created_at)
VALUES (
  'demo-provider',
  'demo-laundry',
  'Demo Laundry',
  NULL,
  json('{"currency":"INR","lang":"en","statusLabels":{"PICKED_UP":"We''ve collected your items","IN_SERVICE":"Your order is being processed","OUT_FOR_DELIVERY":"Out for delivery","DELIVERED":"Delivered — thank you!"},"templates":{"PICKED_UP":"order_picked_up","IN_SERVICE":"order_in_service","OUT_FOR_DELIVERY":"order_out_for_delivery","DELIVERED":"order_delivered","login_code":"login_code"}}'),
  strftime('%s','now') * 1000
);

INSERT OR IGNORE INTO catalog_items (id, provider_id, name, unit, price, active) VALUES
  ('ci-shirt', 'demo-provider', 'Shirt',    'piece', 2000, 1),
  ('ci-trouser','demo-provider','Trouser',  'piece', 2500, 1),
  ('ci-saree', 'demo-provider', 'Saree',    'piece', 5000, 1),
  ('ci-bulk',  'demo-provider', 'Mixed wash','kg',    8000, 1);
