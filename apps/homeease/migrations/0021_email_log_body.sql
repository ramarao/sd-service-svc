-- Store the parsed email body in the audit log (for debugging / re-parsing).
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0021_email_log_body.sql
ALTER TABLE payment_email_log ADD COLUMN body TEXT;
