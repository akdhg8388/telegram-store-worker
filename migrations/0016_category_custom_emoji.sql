-- Category-level Telegram custom emoji icons. Existing category names, Unicode emoji, products, and wallet data remain unchanged.
ALTER TABLE categories ADD COLUMN custom_emoji_id TEXT DEFAULT NULL;
