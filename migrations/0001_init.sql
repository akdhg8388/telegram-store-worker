PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  username TEXT,
  language TEXT NOT NULL DEFAULT 'ar' CHECK (language IN ('ar','en')),
  wallet_balance_iqd INTEGER NOT NULL DEFAULT 0 CHECK (wallet_balance_iqd >= 0),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  delta_iqd INTEGER NOT NULL CHECK (delta_iqd <> 0),
  kind TEXT NOT NULL CHECK (kind IN ('topup','adjustment','refund','permitted_purchase')),
  source_key TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger(user_tg_id,id DESC);

CREATE TRIGGER IF NOT EXISTS wallet_no_overdraft BEFORE INSERT ON wallet_ledger
BEGIN
  SELECT CASE WHEN (SELECT wallet_balance_iqd FROM users WHERE tg_id=NEW.user_tg_id) + NEW.delta_iqd < 0
     THEN RAISE(ABORT, 'insufficient_wallet_funds') END;
END;
CREATE TRIGGER IF NOT EXISTS wallet_apply_entry AFTER INSERT ON wallet_ledger
BEGIN
  UPDATE users SET wallet_balance_iqd=wallet_balance_iqd+NEW.delta_iqd, updated_at=CURRENT_TIMESTAMP WHERE tg_id=NEW.user_tg_id;
END;

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🛍️',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1))
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration_months INTEGER CHECK (duration_months IS NULL OR duration_months > 0),
  price_stars INTEGER NOT NULL CHECK (price_stars > 0),
  stock INTEGER CHECK (stock IS NULL OR stock >= 0),
  featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id,active,id DESC);

CREATE TABLE IF NOT EXISTS favorites (
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  PRIMARY KEY(user_tg_id,product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 10),
  unit_price_stars INTEGER NOT NULL CHECK (unit_price_stars > 0),
  total_stars INTEGER NOT NULL CHECK (total_stars > 0),
  status TEXT NOT NULL DEFAULT 'awaiting_admin' CHECK (status IN ('awaiting_admin','awaiting_payment','paid_pending_delivery','delivered','rejected','refunded')),
  payment_charge_id TEXT UNIQUE,
  source_callback_id TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_tg_id,id DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status,id DESC);

-- Reserve stock *only* after admin approves an unpaid order.
CREATE TRIGGER IF NOT EXISTS order_validate_reservation BEFORE UPDATE OF status ON orders
WHEN OLD.status='awaiting_admin' AND NEW.status='awaiting_payment'
BEGIN
  SELECT CASE WHEN (SELECT active FROM products WHERE id=NEW.product_id) != 1
     THEN RAISE(ABORT,'product_unavailable') END;
  SELECT CASE WHEN (SELECT stock FROM products WHERE id=NEW.product_id) IS NOT NULL
    AND (SELECT stock FROM products WHERE id=NEW.product_id) < NEW.quantity
     THEN RAISE(ABORT,'insufficient_stock') END;
END;
CREATE TRIGGER IF NOT EXISTS order_reserve_stock AFTER UPDATE OF status ON orders
WHEN OLD.status='awaiting_admin' AND NEW.status='awaiting_payment'
BEGIN
  UPDATE products SET stock=stock-NEW.quantity WHERE id=NEW.product_id AND stock IS NOT NULL;
END;
CREATE TRIGGER IF NOT EXISTS order_release_stock AFTER UPDATE OF status ON orders
WHEN (OLD.status='awaiting_payment' AND NEW.status='rejected')
  OR (OLD.status='paid_pending_delivery' AND NEW.status='refunded')
BEGIN
  UPDATE products SET stock=stock+NEW.quantity WHERE id=NEW.product_id AND stock IS NOT NULL;
END;

CREATE TABLE IF NOT EXISTS topup_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  method TEXT NOT NULL CHECK (method IN ('asiacell','zaincash','superqi')),
  amount_iqd INTEGER NOT NULL CHECK (amount_iqd BETWEEN 1000 AND 10000000),
  transfer_reference TEXT,
  proof_file_id TEXT,
  proof_unique_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  CHECK (transfer_reference IS NOT NULL OR proof_file_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_reference ON topup_requests(method,transfer_reference) WHERE transfer_reference IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_topup_proof ON topup_requests(proof_unique_id) WHERE proof_unique_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_topup_status ON topup_requests(status,id DESC);

CREATE TABLE IF NOT EXISTS payment_records (
  telegram_payment_charge_id TEXT PRIMARY KEY,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  user_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  amount_stars INTEGER NOT NULL CHECK (amount_stars > 0),
  state TEXT NOT NULL DEFAULT 'paid' CHECK (state IN ('paid','refunded')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referrals (
  user_tg_id INTEGER PRIMARY KEY REFERENCES users(tg_id),
  referrer_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (user_tg_id <> referrer_tg_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_tg_id);

CREATE TABLE IF NOT EXISTS user_sessions (
  user_tg_id INTEGER PRIMARY KEY REFERENCES users(tg_id),
  action TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON notification_outbox(state,id);
CREATE TABLE IF NOT EXISTS admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_tg_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Categories are examples; actual sellable products must be added by an admin.
INSERT OR IGNORE INTO categories(slug,title,emoji) VALUES
 ('chatgpt','ChatGPT','🤖'),('gemini','Gemini','✨'),('claude','Claude','🧠'),
 ('grok','Grok','🚀'),('ai-tools','أدوات الذكاء الاصطناعي','⚙️'),('hosting-apps','استضافة التطبيقات','📱'),
 ('hosting-web','استضافة المواقع','🌐'),('design','التصميم','🎨'),('software','البرامج','💻'),
 ('security','الحماية و VPN','🔐');
