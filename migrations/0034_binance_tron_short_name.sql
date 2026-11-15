-- Rename only the current manual Binance/TRON payment method.
-- Do not change the wallet receiver, historical orders, balances or other methods.
UPDATE payment_methods SET name_ar='TRON شبكة Binance',name_en='TRON شبكة Binance',
 photo_file_id='https://raw.githubusercontent.com/akdhg8388/telegram-store-worker/main/assets/binance-tron-usdt.png'
WHERE method_key='binance_tron';
