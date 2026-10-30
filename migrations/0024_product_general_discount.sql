-- General discounts are disabled by default. Apply ONLY the largest eligible
-- percentage to prevent unexpected stacked discounts or incorrect wallet debits.
-- Keep the old delivery and ledger triggers untouched.
ALTER TABLE products ADD COLUMN discount_general_percent INTEGER NOT NULL DEFAULT 0 CHECK(discount_general_percent BETWEEN 0 AND 90);
DROP TRIGGER IF EXISTS wallet_purchase_validate;
CREATE TRIGGER wallet_purchase_validate BEFORE INSERT ON wallet_purchases
BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM products p JOIN users u ON u.tg_id=NEW.user_tg_id
  WHERE p.id=NEW.product_id AND p.active=1 AND p.price_iqd>0
   AND COALESCE(NEW.unit_price_iqd,p.price_iqd)=p.price_iqd
   AND NEW.quantity BETWEEN 1 AND p.max_purchase_qty
   AND NEW.discount_percent=MAX(p.discount_general_percent,
     CASE WHEN NEW.quantity>=5 THEN p.discount_5_percent ELSE 0 END,
     CASE WHEN NEW.quantity>=20 THEN p.discount_20_percent ELSE 0 END)
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
