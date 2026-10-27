-- Additional security for the existing optional TRC20 feature.
-- Keep all previous transactions, wallet balances, FX rates and payment methods.
CREATE INDEX IF NOT EXISTS idx_trc20_recent_receiver_amount
  ON trc20_payment_intents(receiver,expected_micro,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trc20_pending_expiration
  ON trc20_payment_intents(status,expires_at);
CREATE INDEX IF NOT EXISTS idx_trc20_recent_created
  ON trc20_payment_intents(created_at DESC,status);
CREATE TABLE IF NOT EXISTS trc20_payment_alerts (
  intent_id TEXT NOT NULL REFERENCES trc20_payment_intents(id),
  txid TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(intent_id,txid)
);
