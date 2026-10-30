-- Wallet quantities and discounts; preserves historical balances and orders.
ALTER TABLE products ADD COLUMN max_purchase_qty INTEGER NOT NULL DEFAULT 100 CHECK(max_purchase_qty BETWEEN 1 AND 100);
ALTER TABLE products ADD COLUMN discount_5_percent INTEGER NOT NULL DEFAULT 0 CHECK(discount_5_percent BETWEEN 0 AND 90);
ALTER TABLE products ADD COLUMN discount_20_percent INTEGER NOT NULL DEFAULT 0 CHECK(discount_20_percent BETWEEN 0 AND 90);
ALTER TABLE wallet_purchases ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 100);
ALTER TABLE wallet_purchases ADD COLUMN unit_price_iqd INTEGER;
ALTER TABLE wallet_purchases ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 90);
ALTER TABLE product_delivery_items ADD COLUMN bulk_purchase_id INTEGER REFERENCES wallet_purchases(id);
CREATE INDEX idx_delivery_bulk_purchase ON product_delivery_items(bulk_purchase_id,id);
DROP TRIGGER wallet_purchase_validate;
DROP TRIGGER wallet_purchase_commit;
CREATE TRIGGER wallet_purchase_validate BEFORE INSERT ON wallet_purchases
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM products p JOIN users u ON u.tg_id=NEW.user_tg_id
  WHERE p.id=NEW.product_id AND p.active=1 AND p.price_iqd>0
   AND NEW.unit_price_iqd=p.price_iqd
   AND NEW.quantity BETWEEN 1 AND p.max_purchase_qty
   AND NEW.discount_percent=(CASE WHEN NEW.quantity>=20 THEN p.discount_20_percent
     WHEN NEW.quantity>=5 THEN p.discount_5_percent ELSE 0 END)
   AND NEW.price_iqd=(p.price_iqd*NEW.quantity*(100-NEW.discount_percent)+50)/100
   AND u.wallet_balance_iqd>=NEW.price_iqd
   AND (p.stock IS NULL OR p.stock>=NEW.quantity)
   AND (
     (p.fulfillment_mode='shared' AND length(trim(p.delivery_shared_text))>0 AND NEW.delivery_item_id IS NULL)
     OR (p.fulfillment_mode='unique'
        AND (SELECT COUNT(*) FROM product_delivery_items i
          WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
            WHERE older.product_id=i.product_id AND older.payload=i.payload
             AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL))
        )>=NEW.quantity
        AND NEW.delivery_item_id=(
          SELECT i.id FROM product_delivery_items i
          WHERE i.product_id=p.id AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL
           AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
            WHERE older.product_id=i.product_id AND older.payload=i.payload
             AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL))
          ORDER BY i.id LIMIT 1))
   )
 ) THEN RAISE(ABORT,'wallet_purchase_unavailable_or_insufficient') END;
END;
CREATE TRIGGER wallet_purchase_commit AFTER INSERT ON wallet_purchases
BEGIN
 UPDATE product_delivery_items SET used_by_purchase_id=NEW.id
  WHERE id=NEW.delivery_item_id AND used_by_purchase_id IS NULL AND bulk_purchase_id IS NULL;
 SELECT CASE WHEN NEW.delivery_item_id IS NOT NULL AND changes()!=1
   THEN RAISE(ABORT,'delivery_item_already_used') END;
 UPDATE product_delivery_items SET bulk_purchase_id=NEW.id
  WHERE NEW.delivery_item_id IS NOT NULL AND id IN(
    SELECT i.id FROM product_delivery_items i
    WHERE i.product_id=NEW.product_id
     AND i.used_by_purchase_id IS NULL AND i.bulk_purchase_id IS NULL
     AND NOT EXISTS(SELECT 1 FROM product_delivery_items older
       WHERE older.product_id=i.product_id AND older.payload=i.payload
       AND (older.id<i.id OR older.used_by_purchase_id IS NOT NULL OR older.bulk_purchase_id IS NOT NULL))
     ORDER BY i.id LIMIT (NEW.quantity-1)
  );
 SELECT CASE WHEN NEW.delivery_item_id IS NOT NULL AND changes()!=NEW.quantity-1
   THEN RAISE(ABORT,'delivery_items_insufficient') END;
 INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note)
  VALUES (NEW.user_tg_id,-NEW.price_iqd,'permitted_purchase',
   'wallet_purchase:'||NEW.id,'شراء تلقائي بالكمية #'||NEW.id);
 UPDATE products SET stock=stock-NEW.quantity,updated_at=CURRENT_TIMESTAMP
  WHERE id=NEW.product_id AND stock IS NOT NULL AND stock>=NEW.quantity;
END;
