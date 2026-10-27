-- Optional, off by default: confirmed TRC20 USDT payment verified by on-chain TXID.
-- Does not change exchange rates, existing payment methods, balances or history.
INSERT INTO payment_methods
 (method_key,name_ar,name_en,receiver_ar,enabled,visible,icon_fallback,sort_order,pay_currency,quote_enabled)
VALUES ('usdt_trc20','USDT شبكة TRC20','USDT TRC20','','0','0','🔴',80,'USD',1);
CREATE TABLE trc20_payment_intents (
 id TEXT PRIMARY KEY,
 user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
 receiver TEXT NOT NULL,
 amount_iqd INTEGER NOT NULL CHECK(amount_iqd BETWEEN 1000 AND 10000000),
 requested_currency TEXT NOT NULL CHECK(requested_currency IN ('IQD','USD')),
 requested_amount_minor INTEGER NOT NULL CHECK(requested_amount_minor>0),
 quoted_rate_iqd INTEGER NOT NULL CHECK(quoted_rate_iqd>0),
 payment_base_minor INTEGER NOT NULL CHECK(payment_base_minor>0),
 expected_micro INTEGER NOT NULL CHECK(expected_micro>0),
 status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','cancelled','expired','credited')),
 txid TEXT UNIQUE,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 expires_at INTEGER NOT NULL,
 credited_at INTEGER
);
CREATE UNIQUE INDEX idx_trc20_open_amount ON trc20_payment_intents(receiver,expected_micro) WHERE status='waiting';
CREATE INDEX idx_trc20_user_recent ON trc20_payment_intents(user_tg_id,created_at DESC);
