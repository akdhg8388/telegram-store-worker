-- Editable, public-facing configuration. Never store bot token or admin identities here.
CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE products ADD COLUMN delivery_instructions TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_users_joined ON users(joined_at);
CREATE INDEX IF NOT EXISTS idx_products_recent ON products(id DESC);
ALTER TABLE users ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0,1));
