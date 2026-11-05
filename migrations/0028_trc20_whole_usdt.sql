-- New whole-USDT requests share the same receiving address and cannot be
-- attributed to an individual solely using a public transaction hash.
ALTER TABLE trc20_payment_intents ADD COLUMN integer_only INTEGER NOT NULL DEFAULT 0 CHECK(integer_only IN (0,1));
DROP INDEX IF EXISTS idx_trc20_open_amount;
CREATE UNIQUE INDEX idx_trc20_open_amount ON trc20_payment_intents(receiver,expected_micro)
 WHERE status='waiting' AND integer_only=0;
CREATE INDEX idx_trc20_whole_active ON trc20_payment_intents(integer_only,status,created_at DESC);
