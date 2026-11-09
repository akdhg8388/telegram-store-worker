-- Display-only Egyptian pound. Never modify existing USD/IQD CHECKs,
-- balances, historic invoices or payment transfer currencies.
CREATE TABLE IF NOT EXISTS user_egp_display (
 user_tg_id INTEGER PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
 selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE topup_requests ADD COLUMN display_currency TEXT CHECK(display_currency IS NULL OR display_currency='EGP');
ALTER TABLE topup_requests ADD COLUMN display_amount_minor INTEGER CHECK(display_amount_minor IS NULL OR display_amount_minor>0);
ALTER TABLE topup_requests ADD COLUMN display_egp_per_usd_minor INTEGER CHECK(display_egp_per_usd_minor IS NULL OR display_egp_per_usd_minor>0);
ALTER TABLE trc20_payment_intents ADD COLUMN display_currency TEXT CHECK(display_currency IS NULL OR display_currency='EGP');
ALTER TABLE trc20_payment_intents ADD COLUMN display_amount_minor INTEGER CHECK(display_amount_minor IS NULL OR display_amount_minor>0);
ALTER TABLE trc20_payment_intents ADD COLUMN display_egp_per_usd_minor INTEGER CHECK(display_egp_per_usd_minor IS NULL OR display_egp_per_usd_minor>0);
-- Starting fixed rate is editable by the owner; no API or exchange-rate polling.
INSERT OR IGNORE INTO bot_settings(key,value) VALUES('egp_rate_per_usd','54.24');
INSERT OR IGNORE INTO bot_settings(key,value) VALUES('egp_display_enabled','true');
