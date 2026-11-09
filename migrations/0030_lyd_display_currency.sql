-- Add only a presentation-currency overlay: financial ledger stays in IQD.
CREATE TABLE IF NOT EXISTS user_lyd_display(
 user_tg_id INTEGER PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Quote snapshots preserve the rate and displayed amount in LYD milli-dinars.
ALTER TABLE topup_requests ADD COLUMN display_lyd_per_usd_milli INTEGER;
ALTER TABLE topup_requests ADD COLUMN display_lyd_amount_milli INTEGER;
ALTER TABLE trc20_payment_intents ADD COLUMN display_lyd_per_usd_milli INTEGER;
ALTER TABLE trc20_payment_intents ADD COLUMN display_lyd_amount_milli INTEGER;
-- Rate defaults are in code, not remote API. No existing balance is modified.
