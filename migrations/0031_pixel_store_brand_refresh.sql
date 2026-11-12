-- Refresh only customer-facing display settings. Never touch funds, orders,
-- product codes, payment receiver values or the Telegram bot username.
UPDATE bot_settings SET value=replace(
  replace(
    replace(value,'My Store','Pixel-Store'),
  'Pixel Store','Pixel-Store'),
' (بتوقيت بغداد)','')
WHERE key IN (
  'store_name','home_template','home_template_en','welcome_text',
  'storefront_instructions','purchase_instructions','topup_instructions',
  'payment_instructions','delivery_instructions','support_instructions',
  'terms_text','privacy_text','referral_notice_ar','referral_notice_en',
  'maintenance_message_ar','maintenance_message_en','support_direct_label'
) AND (instr(value,'My Store')>0 OR instr(value,'Pixel Store')>0 OR instr(value,' (بتوقيت بغداد)')>0);
