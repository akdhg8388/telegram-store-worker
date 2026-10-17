-- V9: ephemeral Telegram presentation only. Never alter financial/customer records.
-- Store message identifiers (not content) for user-requested cleanup when Home is pressed.
CREATE TABLE IF NOT EXISTS chat_cleanup_messages (
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  message_id INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_tg_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_cleanup_recent ON chat_cleanup_messages(user_tg_id,created_at);
