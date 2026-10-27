-- Save verified USDT installments; each TXID may be assigned only once.
-- Already-approved topups and historical ledgers remain unchanged.
CREATE TABLE IF NOT EXISTS trc20_payment_parts (
 txid TEXT PRIMARY KEY NOT NULL,
 intent_id TEXT NOT NULL REFERENCES trc20_payment_intents(id),
 amount_micro INTEGER NOT NULL CHECK(amount_micro>0),
 block_timestamp INTEGER NOT NULL CHECK(block_timestamp>0),
 recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trc20_parts_intent
 ON trc20_payment_parts(intent_id,block_timestamp);
