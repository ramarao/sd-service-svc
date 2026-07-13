-- Audit log of every payment email the Worker receives (for reconciliation +
-- debugging). Apply:
--   wrangler d1 execute sd-service-db --remote --file=./migrations/0020_email_log.sql
CREATE TABLE IF NOT EXISTS payment_email_log (
  id         TEXT PRIMARY KEY,
  from_addr  TEXT,
  subject    TEXT,
  parsed     TEXT,     -- JSON of what Groq extracted
  order_id   TEXT,     -- matched order id, or null
  matched_by TEXT,     -- 'order_id' | 'amount' | null
  reason     TEXT,     -- ok | no_match | no_status | groq_failed
  applied    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON payment_email_log(created_at);
