-- V22: only temporary Telegram presentation IDs for review cleanup.
CREATE TABLE IF NOT EXISTS topup_admin_messages (admin_tg_id INTEGER NOT NULL,topup_id INTEGER NOT NULL REFERENCES topup_requests(id),message_id INTEGER NOT NULL,PRIMARY KEY(admin_tg_id,topup_id,message_id));
CREATE INDEX IF NOT EXISTS idx_topup_admin_messages_request ON topup_admin_messages(topup_id,admin_tg_id);
