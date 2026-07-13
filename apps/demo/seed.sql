-- Demo town seed — three verticals, several providers each with a small catalog.
-- Prices in paise. Apply after schema.sql.

INSERT OR IGNORE INTO platform_settings (id, wa_api_version, wa_display_number, updated_at)
VALUES ('global', 'v21.0', '919999900000', 1700000000000);

-- ── Verticals (slug == core/flows registry key) ──────────────────────────────
INSERT OR IGNORE INTO verticals (slug, name, emoji, sort, active, created_at) VALUES
  ('laundry',   'Laundry',           '🧺', 1, 1, 1700000000000),
  ('appliance', 'Appliance Repair',  '🔧', 2, 1, 1700000000000),
  ('delivery',  'Shop Delivery',     '🛵', 3, 1, 1700000000000);

-- ── Providers (each belongs to a vertical) ───────────────────────────────────
INSERT OR IGNORE INTO service_providers (id, slug, name, vertical, config, upi_id, upi_name, created_at) VALUES
  ('p_dhobi1', 'sparkle-dhobi', 'Sparkle Dhobi',      'laundry',   '{}', 'sparkle@upi',  'Sparkle Dhobi',      1700000000000),
  ('p_dhobi2', 'fresh-fold',    'Fresh Fold Laundry', 'laundry',   '{}', 'freshfold@upi','Fresh Fold Laundry', 1700000000000),
  ('p_appl1',  'homeease',      'HomeEase Guru',      'appliance', '{}', 'homeease@upi', 'HomeEase Guru',      1700000000000),
  ('p_med1',   'city-pharmacy', 'City Pharmacy',      'delivery',  '{}', 'citypharma@upi','City Pharmacy',     1700000000000),
  ('p_chk1',   'fresh-chicken', 'Fresh Chicken Shop', 'delivery',  '{}', 'freshchick@upi','Fresh Chicken Shop',1700000000000);

-- ── Catalogs ─────────────────────────────────────────────────────────────────
-- Laundry: Sparkle Dhobi
INSERT OR IGNORE INTO provider_categories (id, provider_id, name, created_at) VALUES
  ('c_sp_wash','p_dhobi1','Wash & Iron',1700000000000), ('c_sp_dry','p_dhobi1','Dry Clean',1700000000000);
INSERT OR IGNORE INTO catalog_items (id, provider_id, name, category, unit, price, active) VALUES
  ('i_sp1','p_dhobi1','Shirt',   'Wash & Iron','piece', 2000, 1),
  ('i_sp2','p_dhobi1','Trouser', 'Wash & Iron','piece', 3000, 1),
  ('i_sp3','p_dhobi1','Saree',   'Dry Clean',  'piece', 8000, 1),
  ('i_sp4','p_dhobi1','Blazer',  'Dry Clean',  'piece', 12000,1);
-- Laundry: Fresh Fold
INSERT OR IGNORE INTO provider_categories (id, provider_id, name, created_at) VALUES
  ('c_ff_wash','p_dhobi2','Wash & Fold',1700000000000);
INSERT OR IGNORE INTO catalog_items (id, provider_id, name, category, unit, price, active) VALUES
  ('i_ff1','p_dhobi2','Mixed load (per kg)','Wash & Fold','kg', 6000, 1),
  ('i_ff2','p_dhobi2','Bedsheet',           'Wash & Fold','piece', 4000, 1);

-- Appliance: HomeEase Guru
INSERT OR IGNORE INTO provider_categories (id, provider_id, name, created_at) VALUES
  ('c_ap_ac','p_appl1','AC Services',1700000000000), ('c_ap_fr','p_appl1','Refrigerator',1700000000000),
  ('c_ap_wm','p_appl1','Washing Machine',1700000000000);
INSERT OR IGNORE INTO catalog_items (id, provider_id, name, category, unit, price, active) VALUES
  ('i_ap1','p_appl1','AC Service',              'AC Services',     'service', 49900, 1),
  ('i_ap2','p_appl1','AC Gas Refill',           'AC Services',     'service', 199900,1),
  ('i_ap3','p_appl1','Fridge Repair',           'Refrigerator',    'service', 49900, 1),
  ('i_ap4','p_appl1','Washing Machine Service', 'Washing Machine', 'service', 49900, 1);

-- Delivery: City Pharmacy (medical)
INSERT OR IGNORE INTO provider_categories (id, provider_id, name, created_at) VALUES
  ('c_md_otc','p_med1','OTC & Wellness',1700000000000), ('c_md_care','p_med1','Personal Care',1700000000000);
INSERT OR IGNORE INTO catalog_items (id, provider_id, name, category, unit, price, active) VALUES
  ('i_md1','p_med1','Paracetamol 500mg (strip)','OTC & Wellness','pack', 3000, 1),
  ('i_md2','p_med1','ORS Sachet',               'OTC & Wellness','pack', 2000, 1),
  ('i_md3','p_med1','Antiseptic Liquid 100ml',  'Personal Care', 'bottle', 8500, 1),
  ('i_md4','p_med1','Hand Sanitizer 200ml',     'Personal Care', 'bottle', 9900, 1);

-- Delivery: Fresh Chicken Shop
INSERT OR IGNORE INTO provider_categories (id, provider_id, name, created_at) VALUES
  ('c_ck_chk','p_chk1','Chicken',1700000000000), ('c_ck_eggs','p_chk1','Eggs',1700000000000);
INSERT OR IGNORE INTO catalog_items (id, provider_id, name, category, unit, price, active) VALUES
  ('i_ck1','p_chk1','Chicken Curry Cut (500g)','Chicken','pack', 18000, 1),
  ('i_ck2','p_chk1','Boneless Chicken (500g)', 'Chicken','pack', 24000, 1),
  ('i_ck3','p_chk1','Country Eggs (6)',        'Eggs',   'pack', 9000,  1);
