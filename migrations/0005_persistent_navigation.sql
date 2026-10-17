-- Persistent reply menu activation flag, one-time setup per user.
ALTER TABLE users ADD COLUMN nav_keyboard_sent INTEGER NOT NULL DEFAULT 0 CHECK(nav_keyboard_sent IN (0,1));
