-- Wallet requests and currency preference; preserves legacy users, topups, and ledger.
ALTER TABLE users ADD COLUMN currency_preference TEXT NOT NULL DEFAULT 'IQD'
  CHECK (currency_preference IN ('IQD','USD'));

-- SQLite cannot expand an existing CHECK constraint, so copy rows into a compatible table.
-- No existing table has a foreign key pointing at topup_requests.
CREATE TABLE topup_requests_v6 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  method TEXT NOT NULL CHECK (method IN ('asiacell','zaincash','zain_balance','superqi','binance')),
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd BETWEEN 1000 AND 10000000),
  transfer_reference TEXT,
  proof_file_id TEXT,
  proof_unique_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  requested_currency TEXT NOT NULL DEFAULT 'IQD' CHECK (requested_currency IN ('USD','IQD')),
  requested_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (requested_amount_minor >= 0),
  quoted_rate_iqd INTEGER,
  source_message_id INTEGER,
  submission_key TEXT UNIQUE,
  CHECK (transfer_reference IS NOT NULL OR proof_file_id IS NOT NULL)
);
INSERT INTO topup_requests_v6
(id,user_tg_id,method,amount_iqd,transfer_reference,proof_file_id,proof_unique_id,status,decided_by,created_at,decided_at,requested_currency,requested_amount_minor)
SELECT id,user_tg_id,method,amount_iqd,transfer_reference,proof_file_id,proof_unique_id,status,decided_by,created_at,decided_at,'IQD',amount_iqd
FROM topup_requests;
DROP TABLE topup_requests;
ALTER TABLE topup_requests_v6 RENAME TO topup_requests;
CREATE UNIQUE INDEX idx_topup_reference ON topup_requests(method,transfer_reference) WHERE transfer_reference IS NOT NULL;
CREATE UNIQUE INDEX idx_topup_proof ON topup_requests(proof_unique_id) WHERE proof_unique_id IS NOT NULL;
CREATE UNIQUE INDEX idx_topup_source_message ON topup_requests(user_tg_id,source_message_id) WHERE source_message_id IS NOT NULL;
CREATE INDEX idx_topup_status ON topup_requests(status,id DESC);
CREATE INDEX idx_topup_user_recent ON topup_requests(user_tg_id,id DESC);
