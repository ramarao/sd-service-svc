-- Payment reconciliation from Paytm/UPI settlement emails (parsed by the email
-- Worker + Groq). Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0018_order_payment.sql
ALTER TABLE orders ADD COLUMN payment_status TEXT;      -- 'paid' | 'failed' | null (unpaid)
ALTER TABLE orders ADD COLUMN payment_ref    TEXT;      -- gateway txn / order id
ALTER TABLE orders ADD COLUMN payment_amount INTEGER;   -- amount received, in paise
ALTER TABLE orders ADD COLUMN payment_payer  TEXT;      -- payer VPA / name
ALTER TABLE orders ADD COLUMN payment_at     INTEGER;   -- epoch ms when recorded
