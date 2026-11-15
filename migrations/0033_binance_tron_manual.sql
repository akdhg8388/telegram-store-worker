-- Add a separate Binance / TRON manual payment method.
-- Keep legacy TRC20 auto-credit disabled, and preserve all historic wallet and payment data.
INSERT INTO payment_methods
 (method_key,name_ar,name_en,receiver_ar,receiver_en,photo_file_id,
  enabled,visible,icon_fallback,pay_currency,quote_enabled,fee_mode,fee_value,sort_order)
VALUES
 ('binance_tron','Binance • Tether USDT TRON (TRC20)','Binance • Tether USDT TRON (TRC20)',
  'TPmyvDW5csXNPTsTswr31SpMkQhDNWj9BK',
  'TPmyvDW5csXNPTsTswr31SpMkQhDNWj9BK',
  'https://raw.githubusercontent.com/akdhg8388/telegram-store-worker/main/assets/binance-tron-usdt.png',
  1,1,'🟡','USD',1,'none',0,33)
ON CONFLICT(method_key) DO NOTHING;
