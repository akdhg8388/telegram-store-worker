-- Store one order per buyer and confirmation message (even for different callback IDs).
ALTER TABLE orders ADD COLUMN source_message_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_confirmation_message
  ON orders(user_tg_id,source_message_id) WHERE source_message_id IS NOT NULL;

-- Queue retry scheduling avoids tight retry loops during Telegram outages.
ALTER TABLE notification_outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_notification_due ON notification_outbox(state,next_attempt_at,id);
