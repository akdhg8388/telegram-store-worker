-- Each optional TRC20 installment has a payment amount issued BEFORE its transfer.
-- TXID alone is public and cannot prove ownership of an unreserved deposit.
ALTER TABLE trc20_payment_intents ADD COLUMN full_quote_active INTEGER NOT NULL DEFAULT 1 CHECK(full_quote_active IN (0,1));
CREATE TABLE IF NOT EXISTS trc20_payment_quotes (
 id TEXT PRIMARY KEY,
 intent_id TEXT NOT NULL REFERENCES trc20_payment_intents(id),
 amount_micro INTEGER NOT NULL CHECK(amount_micro>0),
 status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','used','cancelled')),
 created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trc20_one_open_part ON trc20_payment_quotes(intent_id) WHERE status='waiting';
CREATE UNIQUE INDEX IF NOT EXISTS idx_trc20_unique_open_amount ON trc20_payment_quotes(amount_micro) WHERE status='waiting';
CREATE INDEX IF NOT EXISTS idx_trc20_quote_history ON trc20_payment_quotes(amount_micro,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trc20_quote_intent ON trc20_payment_quotes(intent_id,status);
-- Security first: earlier unreserved partial deposits may NOT be used for new
-- auto-credit requests. Preserve their audit history for manual resolution.
UPDATE trc20_payment_intents SET full_quote_active=0
 WHERE status='waiting' AND EXISTS(
   SELECT 1 FROM trc20_payment_parts p WHERE p.intent_id=trc20_payment_intents.id
 );
