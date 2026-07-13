-- HomeEase Guru — provider + home-appliance service catalog.
-- Prices are in paise. Apply after schema.sql:
--   wrangler d1 execute sd-homeease-db --local  -c apps/homeease/wrangler.jsonc --file apps/homeease/seed.sql
--   wrangler d1 execute sd-homeease-db --remote -c apps/homeease/wrangler.jsonc --file apps/homeease/seed.sql

INSERT OR IGNORE INTO service_providers (id, slug, name, config, upi_id, upi_name, created_at)
VALUES ('hprov1', 'homeease', 'HomeEase Guru', '{}', 'homeease@upi', 'HomeEase Guru', 1700000000000);

INSERT OR IGNORE INTO platform_settings (id, wa_api_version, updated_at)
VALUES ('global', 'v21.0', 1700000000000);

-- Categories (appliance types)
INSERT OR IGNORE INTO provider_categories (id, provider_id, name, created_at) VALUES
  ('hc_ac',       'hprov1', 'AC Services',        1700000000000),
  ('hc_fridge',   'hprov1', 'Refrigerator',       1700000000000),
  ('hc_wm',       'hprov1', 'Washing Machine',    1700000000000),
  ('hc_cctv',     'hprov1', 'CCTV',               1700000000000),
  ('hc_ro',       'hprov1', 'RO Water Purifier',  1700000000000),
  ('hc_disp',     'hprov1', 'Water Dispenser',    1700000000000),
  ('hc_mw',       'hprov1', 'Microwave',          1700000000000),
  ('hc_chimney',  'hprov1', 'Chimney',            1700000000000),
  ('hc_dish',     'hprov1', 'Dish Washer',        1700000000000),
  ('hc_gen',      'hprov1', 'Power Generators',   1700000000000),
  ('hc_inv',      'hprov1', 'Home Inverters',     1700000000000);

-- Catalog items (service jobs). unit = "service" (per-visit charge).
INSERT OR IGNORE INTO catalog_items (id, provider_id, name, category, unit, price, active) VALUES
  ('hi_ac_service',   'hprov1', 'AC Service',              'AC Services',       'service', 49900,  1),
  ('hi_ac_repair',    'hprov1', 'AC Repair',               'AC Services',       'service', 59900,  1),
  ('hi_ac_gas',       'hprov1', 'AC Gas Refill',           'AC Services',       'service', 199900, 1),
  ('hi_ac_install',   'hprov1', 'AC Installation',         'AC Services',       'service', 149900, 1),

  ('hi_fr_service',   'hprov1', 'Fridge Service',          'Refrigerator',      'service', 39900,  1),
  ('hi_fr_repair',    'hprov1', 'Fridge Repair',           'Refrigerator',      'service', 49900,  1),
  ('hi_fr_gas',       'hprov1', 'Fridge Gas Refill',       'Refrigerator',      'service', 149900, 1),

  ('hi_wm_service',   'hprov1', 'Washing Machine Service', 'Washing Machine',   'service', 49900,  1),
  ('hi_wm_repair',    'hprov1', 'Washing Machine Repair',  'Washing Machine',   'service', 59900,  1),
  ('hi_wm_install',   'hprov1', 'Washing Machine Install', 'Washing Machine',   'service', 49900,  1),

  ('hi_cctv_install', 'hprov1', 'CCTV Installation',       'CCTV',              'service', 199900, 1),
  ('hi_cctv_repair',  'hprov1', 'CCTV Repair',             'CCTV',              'service', 69900,  1),

  ('hi_ro_service',   'hprov1', 'RO Service',              'RO Water Purifier', 'service', 39900,  1),
  ('hi_ro_filter',    'hprov1', 'RO Filter Change',        'RO Water Purifier', 'service', 89900,  1),
  ('hi_ro_repair',    'hprov1', 'RO Repair',               'RO Water Purifier', 'service', 49900,  1),

  ('hi_disp_service', 'hprov1', 'Water Dispenser Service', 'Water Dispenser',   'service', 39900,  1),
  ('hi_disp_repair',  'hprov1', 'Water Dispenser Repair',  'Water Dispenser',   'service', 49900,  1),

  ('hi_mw_service',   'hprov1', 'Microwave Service',       'Microwave',         'service', 39900,  1),
  ('hi_mw_repair',    'hprov1', 'Microwave Repair',        'Microwave',         'service', 59900,  1),

  ('hi_ch_service',   'hprov1', 'Chimney Service',         'Chimney',           'service', 59900,  1),
  ('hi_ch_repair',    'hprov1', 'Chimney Repair',          'Chimney',           'service', 69900,  1),

  ('hi_dw_service',   'hprov1', 'Dishwasher Service',      'Dish Washer',       'service', 59900,  1),
  ('hi_dw_repair',    'hprov1', 'Dishwasher Repair',       'Dish Washer',       'service', 69900,  1),

  ('hi_gen_service',  'hprov1', 'Generator Service',       'Power Generators',  'service', 99900,  1),
  ('hi_gen_repair',   'hprov1', 'Generator Repair',        'Power Generators',  'service', 129900, 1),

  ('hi_inv_service',  'hprov1', 'Inverter Service',        'Home Inverters',    'service', 49900,  1),
  ('hi_inv_repair',   'hprov1', 'Inverter Repair',         'Home Inverters',    'service', 69900,  1),
  ('hi_inv_battery',  'hprov1', 'Battery Replacement',     'Home Inverters',    'service', 499900, 1);
