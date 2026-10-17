-- V12: wallet-based checkout + immediate delivery. Preserve all historical Stars
-- orders, topups, balances and ledger entries; new purchases use a separate table.
ALTER TABLE products ADD COLUMN price_iqd INTEGER CHECK(price_iqd IS NULL OR price_iqd BETWEEN 1 AND 100000000);
ALTER TABLE products ADD COLUMN fulfillment_mode TEXT NOT NULL DEFAULT 'disabled'
  CHECK(fulfillment_mode IN ('disabled','shared','unique'));
ALTER TABLE products ADD COLUMN delivery_shared_text TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN usage_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN photo_file_id TEXT;

CREATE TABLE product_delivery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  payload TEXT NOT NULL CHECK(length(trim(payload))>0),
  used_by_purchase_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_delivery_available ON product_delivery_items(product_id,used_by_purchase_id,id);

CREATE TABLE wallet_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  price_iqd INTEGER NOT NULL CHECK(price_iqd>0),
  submission_key TEXT NOT NULL UNIQUE,
  delivery_item_id INTEGER UNIQUE REFERENCES product_delivery_items(id),
  product_name TEXT NOT NULL,
  product_description TEXT NOT NULL DEFAULT '',
  duration_months INTEGER,
  delivery_payload TEXT NOT NULL DEFAULT '',
  usage_instructions TEXT NOT NULL DEFAULT '',
  photo_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_wallet_purchases_user ON wallet_purchases(user_tg_id,id DESC);

CREATE TRIGGER wallet_purchase_validate BEFORE INSERT ON wallet_purchases
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM products p JOIN users u ON u.tg_id=NEW.user_tg_id
    WHERE p.id=NEW.product_id AND p.active=1 AND p.price_iqd=NEW.price_iqd
      AND p.price_iqd>0 AND u.wallet_balance_iqd >= NEW.price_iqd
      AND (p.stock IS NULL OR p.stock>0)
      AND ((p.fulfillment_mode='shared' AND length(trim(p.delivery_shared_text))>0
        AND NEW.delivery_item_id IS NULL)
        OR (p.fulfillment_mode='unique' AND EXISTS(
          SELECT 1 FROM product_delivery_items i WHERE i.id=NEW.delivery_item_id
            AND i.product_id=p.id AND i.used_by_purchase_id IS NULL)))
  ) THEN RAISE(ABORT,'wallet_purchase_unavailable_or_insufficient') END;
END;

CREATE TRIGGER wallet_purchase_commit AFTER INSERT ON wallet_purchases
BEGIN
  UPDATE product_delivery_items SET used_by_purchase_id=NEW.id
    WHERE id=NEW.delivery_item_id AND used_by_purchase_id IS NULL;
  SELECT CASE WHEN NEW.delivery_item_id IS NOT NULL AND changes()!=1
    THEN RAISE(ABORT,'delivery_item_already_used') END;
  INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note)
    VALUES (NEW.user_tg_id,-NEW.price_iqd,'permitted_purchase',
      'wallet_purchase:'||NEW.id,'شراء تلقائي #'||NEW.id);
  UPDATE products SET stock=stock-1,updated_at=CURRENT_TIMESTAMP
    WHERE id=NEW.product_id AND stock IS NOT NULL AND stock>0;
END;
