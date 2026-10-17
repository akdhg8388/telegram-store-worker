-- Optional visual settings and bilingual catalog text.
-- No existing balances, purchases, deliverables, or Arabic content are changed.
ALTER TABLE products ADD COLUMN custom_emoji_id TEXT DEFAULT NULL;
ALTER TABLE products ADD COLUMN title_en TEXT DEFAULT NULL;
ALTER TABLE products ADD COLUMN description_en TEXT DEFAULT NULL;
ALTER TABLE products ADD COLUMN usage_instructions_en TEXT DEFAULT NULL;
ALTER TABLE categories ADD COLUMN title_en TEXT DEFAULT NULL;
-- Localize built-in categories without overwriting administrator-supplied names.
UPDATE categories SET title_en=CASE slug
 WHEN 'ai-tools' THEN 'AI Tools'
 WHEN 'hosting-apps' THEN 'App Hosting'
 WHEN 'hosting-web' THEN 'Website Hosting'
 WHEN 'design' THEN 'Design'
 WHEN 'software' THEN 'Software'
 WHEN 'security' THEN 'Security'
 WHEN 'education' THEN 'Education'
 WHEN 'streaming' THEN 'Streaming'
 WHEN 'music' THEN 'Music'
 WHEN 'games' THEN 'Games'
 ELSE title
 END WHERE title_en IS NULL;
