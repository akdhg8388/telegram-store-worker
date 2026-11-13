
-- Retire TRC20 payment options without deleting financial history or receipts.
UPDATE payment_methods SET enabled=0,visible=0
 WHERE method_key='usdt_trc20'
    OR lower(name_ar) LIKE '%trc20%'
    OR lower(name_en) LIKE '%trc20%';

-- Keep the owner's most recent TON/Bybit method with its existing icon.
UPDATE payment_methods SET enabled=0,visible=0
 WHERE method_key LIKE 'custom_%'
   AND ((lower(name_ar) LIKE '%ton%' AND
        (lower(name_ar) LIKE '%usdt%' OR lower(name_ar) LIKE '%bybit%'))
        OR lower(name_ar) LIKE '%tether%'
        OR lower(name_ar) LIKE '%bybit%');

UPDATE payment_methods
 SET name_ar='Tether USDT • TON (Bybit)',
     name_en='Tether USDT (TON) via Bybit',
     receiver_ar='UQB8wsYDbBNZZK-vLLC_rqLbPFSdQ66zubIfs88neWP80kIE',receiver_en='UQB8wsYDbBNZZK-vLLC_rqLbPFSdQ66zubIfs88neWP80kIE',
     receiver_entities_ar='[]',receiver_entities_en='[]',
     photo_file_id=CASE WHEN length(COALESCE(photo_file_id,''))>0 THEN photo_file_id ELSE 'https://raw.githubusercontent.com/akdhg8388/telegram-store-worker/main/assets/ton-usdt-bybit.png' END,
     pay_currency='USD',quote_enabled=1,
     fee_mode='none',fee_value=0,enabled=1,visible=1
 WHERE method_key=(
   SELECT method_key FROM payment_methods
   WHERE method_key LIKE 'custom_%'
     AND ((lower(name_ar) LIKE '%ton%' AND
           (lower(name_ar) LIKE '%usdt%' OR lower(name_ar) LIKE '%bybit%'))
           OR lower(name_ar) LIKE '%tether%'
           OR lower(name_ar) LIKE '%bybit%')
   ORDER BY created_at DESC,method_key DESC LIMIT 1
 );

-- Add an approved option on a fresh install if no pre-existing matching method exists.
INSERT INTO payment_methods
 (method_key,name_ar,name_en,receiver_ar,receiver_en,photo_file_id,
  enabled,visible,pay_currency,quote_enabled,fee_mode,fee_value,sort_order)
SELECT 'ton_usdt','Tether USDT • TON (Bybit)','Tether USDT (TON) via Bybit',
       'UQB8wsYDbBNZZK-vLLC_rqLbPFSdQ66zubIfs88neWP80kIE','UQB8wsYDbBNZZK-vLLC_rqLbPFSdQ66zubIfs88neWP80kIE',
       'https://raw.githubusercontent.com/akdhg8388/telegram-store-worker/main/assets/ton-usdt-bybit.png',1,1,'USD',1,'none',0,32
WHERE NOT EXISTS (
 SELECT 1 FROM payment_methods WHERE receiver_ar='UQB8wsYDbBNZZK-vLLC_rqLbPFSdQ66zubIfs88neWP80kIE' AND enabled=1 AND visible=1
);
