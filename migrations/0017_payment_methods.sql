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

-- Existing method CHECK in topup_requests must be expanded to support new
-- administrator-defined method keys; otherwise a new method cannot be saved.
-- D1 migrations run atomically. Defer FK validation until the table is
-- re-created under its original name (topup_admin_messages FK stays valid).
PRAGMA defer_foreign_keys=ON;
CREATE TABLE topup_requests_v29 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  method TEXT NOT NULL CHECK(length(method) BETWEEN 1 AND 32),
  amount_iqd INTEGER NOT NULL CHECK(amount_iqd BETWEEN 1000 AND 10000000),
  transfer_reference TEXT,
  proof_file_id TEXT,
  proof_unique_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  decided_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  requested_currency TEXT NOT NULL DEFAULT 'IQD' CHECK(requested_currency IN ('USD','IQD')),
  requested_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(requested_amount_minor>=0),
  quoted_rate_iqd INTEGER,
  source_message_id INTEGER,
  submission_key TEXT UNIQUE,
  credited_amount_iqd INTEGER CHECK(credited_amount_iqd IS NULL OR credited_amount_iqd BETWEEN 1 AND 10000000),
  admin_notice_message_id INTEGER,
  CHECK(transfer_reference IS NOT NULL OR proof_file_id IS NOT NULL)
);
INSERT INTO topup_requests_v29 (
 id,user_tg_id,method,amount_iqd,transfer_reference,proof_file_id,proof_unique_id,
 status,decided_by,created_at,decided_at,requested_currency,requested_amount_minor,
 quoted_rate_iqd,source_message_id,submission_key,credited_amount_iqd,admin_notice_message_id
) SELECT id,user_tg_id,method,amount_iqd,transfer_reference,proof_file_id,proof_unique_id,
 status,decided_by,created_at,decided_at,requested_currency,requested_amount_minor,
 quoted_rate_iqd,source_message_id,submission_key,credited_amount_iqd,admin_notice_message_id
 FROM topup_requests;
DROP TABLE topup_requests;
ALTER TABLE topup_requests_v29 RENAME TO topup_requests;
CREATE UNIQUE INDEX idx_topup_reference ON topup_requests(method,transfer_reference) WHERE transfer_reference IS NOT NULL;
CREATE UNIQUE INDEX idx_topup_proof ON topup_requests(proof_unique_id) WHERE proof_unique_id IS NOT NULL;
CREATE UNIQUE INDEX idx_topup_source_message ON topup_requests(user_tg_id,source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX idx_topup_status ON topup_requests(status,id DESC);
CREATE INDEX idx_topup_user_recent ON topup_requests(user_tg_id,id DESC);
