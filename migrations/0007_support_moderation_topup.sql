-- Preserve original financial and customer records; only add audited capabilities.
ALTER TABLE topup_requests ADD COLUMN credited_amount_iqd INTEGER
  CHECK (credited_amount_iqd IS NULL OR credited_amount_iqd BETWEEN 1 AND 10000000);
ALTER TABLE topup_requests ADD COLUMN admin_notice_message_id INTEGER;
ALTER TABLE users ADD COLUMN suspended_until INTEGER;
ALTER TABLE users ADD COLUMN restriction_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN restricted_by INTEGER;
ALTER TABLE users ADD COLUMN restricted_at TEXT;
CREATE INDEX idx_users_suspensions ON users(suspended_until);

CREATE TABLE support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  direction TEXT NOT NULL CHECK (direction IN ('incoming','outgoing')),
  kind TEXT NOT NULL CHECK (kind IN ('text','photo','video')),
  body TEXT NOT NULL DEFAULT '',
  telegram_file_id TEXT,
  customer_message_id INTEGER,
  admin_notice_message_id INTEGER,
  is_unread INTEGER NOT NULL DEFAULT 0 CHECK (is_unread IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (kind='text' OR telegram_file_id IS NOT NULL)
);
CREATE UNIQUE INDEX idx_support_inbound_unique ON support_messages(user_tg_id,customer_message_id)
  WHERE direction='incoming' AND customer_message_id IS NOT NULL;
CREATE INDEX idx_support_thread ON support_messages(user_tg_id,id DESC);
CREATE INDEX idx_support_inbox ON support_messages(is_unread,user_tg_id,id DESC);

ALTER TABLE notification_outbox ADD COLUMN support_message_id INTEGER;
ALTER TABLE notification_outbox ADD COLUMN topup_request_id INTEGER;
