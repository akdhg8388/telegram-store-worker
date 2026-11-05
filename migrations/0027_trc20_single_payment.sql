-- Replace installment purchasing with ONE confirmed and uniquely assigned transfer
-- per NEW request. Historical split payments remain intact for accounting.
ALTER TABLE trc20_payment_intents ADD COLUMN flexible_amount INTEGER NOT NULL DEFAULT 0
  CHECK(flexible_amount IN (0,1));
-- No backfill: old requests retain exact-amount verification rules.
CREATE TABLE IF NOT EXISTS trc20_single_transfers (
 intent_id TEXT PRIMARY KEY REFERENCES trc20_payment_intents(id),
 txid TEXT NOT NULL UNIQUE,
 amount_micro INTEGER NOT NULL CHECK(amount_micro>0),
 credited_iqd INTEGER NOT NULL CHECK(credited_iqd BETWEEN 1000 AND 10000000),
 block_timestamp INTEGER NOT NULL CHECK(block_timestamp>0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE notification_outbox ADD COLUMN trc20_single_intent_id TEXT;
ALTER TABLE notification_outbox ADD COLUMN trc20_single_recipient_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trc20_single_notice
 ON notification_outbox(trc20_single_intent_id,trc20_single_recipient_id)
 WHERE trc20_single_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trc20_single_txid
 ON trc20_single_transfers(txid);
-- Pending legacy installment reservations cannot be used as newly quoted payments.
UPDATE trc20_payment_quotes SET status='cancelled' WHERE status='waiting';
