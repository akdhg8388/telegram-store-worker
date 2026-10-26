-- Owner-controlled transfer fee settings; no rate, balance, order or historic quote is changed.
ALTER TABLE payment_methods ADD COLUMN quote_enabled INTEGER NOT NULL DEFAULT 1 CHECK(quote_enabled IN (0,1));
ALTER TABLE payment_methods ADD COLUMN pay_currency TEXT NOT NULL DEFAULT 'IQD' CHECK(pay_currency IN ('IQD','USD'));
ALTER TABLE payment_methods ADD COLUMN fee_mode TEXT NOT NULL DEFAULT 'none' CHECK(fee_mode IN ('none','fixed','percent'));
ALTER TABLE payment_methods ADD COLUMN fee_value INTEGER NOT NULL DEFAULT 0 CHECK(fee_value BETWEEN 0 AND 10000000);
-- Initial mapping for existing Global Razer Gold methods only; admin can change currency.
UPDATE payment_methods SET pay_currency='USD' WHERE lower(name_ar) LIKE '%razer%' OR name_ar LIKE '%رايزر%' OR lower(name_en) LIKE '%razer%';
ALTER TABLE topup_requests ADD COLUMN transfer_currency TEXT CHECK(transfer_currency IN ('IQD','USD'));
ALTER TABLE topup_requests ADD COLUMN transfer_base_minor INTEGER;
ALTER TABLE topup_requests ADD COLUMN transfer_fee_minor INTEGER;
ALTER TABLE topup_requests ADD COLUMN transfer_total_minor INTEGER;
CREATE TABLE IF NOT EXISTS topup_view_messages (
 user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
 message_id INTEGER NOT NULL CHECK(message_id>0),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_tg_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_topup_views_user ON topup_view_messages(user_tg_id,message_id DESC);
