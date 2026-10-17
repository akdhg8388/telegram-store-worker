-- V15: optional, per-product warranty display and immutable purchase-time snapshots.
-- Existing products remain unchanged visually until the owner explicitly enables warranty.
ALTER TABLE products ADD COLUMN warranty_visible INTEGER NOT NULL DEFAULT 0 CHECK(warranty_visible IN (0,1));
ALTER TABLE products ADD COLUMN warranty_available INTEGER NOT NULL DEFAULT 0 CHECK(warranty_available IN (0,1));
ALTER TABLE products ADD COLUMN warranty_terms_ar TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN warranty_terms_en TEXT DEFAULT '';
ALTER TABLE wallet_purchases ADD COLUMN warranty_visible INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallet_purchases ADD COLUMN warranty_available INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallet_purchases ADD COLUMN warranty_terms_ar TEXT DEFAULT '';
ALTER TABLE wallet_purchases ADD COLUMN warranty_terms_en TEXT DEFAULT '';
