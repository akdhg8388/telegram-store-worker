-- Display-only Egyptian pound. Never modify existing USD/IQD CHECKs,
-- balances, historic invoices or payment transfer currencies.
CREATE TABLE IF NOT EXISTS user_egp_display (
 user_tg_id INTEGER PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE topup_requests ADD COLUMN display_currency TEXT CHECK(display_currency IS NULL OR display_currency='EGP');
ALTER TABLE topup_requests ADD COLUMN display_amount_minor INTEGER CHECK(display_amount_minor IS NULL OR display_amount_minor>0);
ALTER TABLE topup_requests ADD COLUMN display_egp_per_usd_minor INTEGER CHECK(display_egp_per_usd_minor IS NULL OR display_egp_per_usd_minor>0);
ALTER TABLE trc20_payment_intents ADD COLUMN display_currency TEXT CHECK(display_currency IS NULL OR display_currency='EGP');
ALTER TABLE trc20_payment_intents ADD COLUMN display_amount_minor INTEGER CHECK(display_amount_minor IS NULL OR display_amount_minor>0);
ALTER TABLE trc20_payment_intents ADD COLUMN display_egp_per_usd_minor INTEGER CHECK(display_egp_per_usd_minor IS NULL OR display_egp_per_usd_minor>0);
 -- The initial fixed rate 54.24 EGP/USD is the local fallback. The owner can
-- replace it through bot_settings, avoiding any mutation of existing settings.
