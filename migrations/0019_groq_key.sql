-- Groq API key for parsing payment emails, stored in platform settings and
-- editable from the super-admin console (like the Ola Maps key). Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0019_groq_key.sql
ALTER TABLE platform_settings ADD COLUMN groq_api_key TEXT;
