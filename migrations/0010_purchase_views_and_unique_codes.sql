-- V13: only Telegram identifiers of temporary purchase displays. No financial rows touched.
CREATE TABLE IF NOT EXISTS purchase_view_messages (
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  message_id INTEGER NOT NULL CHECK(message_id>0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_tg_id,message_id)
);
CREATE INDEX IF NOT EXISTS idx_purchase_views_user ON purchase_view_messages(user_tg_id,message_id DESC);

-- Fast duplicate detection without requiring old data to be unique.
CREATE INDEX IF NOT EXISTS idx_product_delivery_payload ON product_delivery_items(product_id,payload);

-- Prevent any newly-added copy of an existing code, even if it was already sold.
CREATE TRIGGER IF NOT EXISTS prevent_duplicate_delivery_payload BEFORE INSERT ON product_delivery_items
WHEN EXISTS (SELECT 1 FROM product_delivery_items
             WHERE product_id=NEW.product_id AND payload=NEW.payload)
BEGIN
  SELECT RAISE(IGNORE);
END;
