-- V29: flexible payment methods; preserve historic wallet/topup rows and IDs.
CREATE TABLE payment_methods (
  method_key TEXT PRIMARY KEY CHECK(length(method_key) BETWEEN 1 AND 32),
  name_ar TEXT NOT NULL CHECK(length(name_ar) BETWEEN 1 AND 65),
  name_en TEXT NOT NULL DEFAULT '',
  receiver_ar TEXT NOT NULL DEFAULT '',
  receiver_en TEXT NOT NULL DEFAULT '',
  receiver_entities_ar TEXT NOT NULL DEFAULT '[]',
  receiver_entities_en TEXT NOT NULL DEFAULT '[]',
  icon_custom_emoji_id TEXT,
  icon_fallback TEXT NOT NULL DEFAULT '',
  photo_file_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN (0,1)),
  legacy_setting_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO payment_methods(method_key,name_ar,name_en,icon_fallback,legacy_setting_key,enabled,visible,sort_order) VALUES
 ('zain_balance','📱 رصيد زين','📱 Zain Balance','📱','zain_balance_receiver',1,1,10),
 ('superqi','🏦 سوبر كي','🏦 Super Qi','🏦','superqi_receiver',1,1,20),
 ('binance','🟡 Binance','🟡 Binance','🟡','binance_receiver',1,1,30),
 ('asiacell','📱 آسيا سيل','📱 AsiaCell','📱','asiacell_receiver',0,0,40),
 ('zaincash','💸 زين كاش','💸 Zain Cash','💸','zaincash_receiver',0,0,50);

-- Preserve the existing financial table and all foreign-key references in place.
-- New method keys are saved separately; the immutable legacy enum keeps its constraint.
ALTER TABLE topup_requests ADD COLUMN custom_method_key TEXT;
CREATE INDEX idx_topup_custom_method ON topup_requests(custom_method_key,id DESC);
