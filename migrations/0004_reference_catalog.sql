-- Visual catalog structure observed in the user's original Telegram reference video.
-- Categories are navigation only; no fake or unauthorized products are inserted.
ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 900;

INSERT OR IGNORE INTO categories (slug,title,emoji) VALUES
  ('codex-api','Codex API','💠'),
  ('kimi','Kimi','🅺'),
  ('video-ai','Video AI','🎬'),
  ('elevenlabs','ElevenLabs','🎙️'),
  ('qwen-api','Qwen API','🟣'),
  ('deepseek','DeepSeek','🐋'),
  ('cursor-api','Cursor API','🖥️'),
  ('adobe','Adobe','🎨'),
  ('autodesk','Autodesk','📐'),
  ('office','Office','🗂️'),
  ('education','التعليم','🎓'),
  ('streaming','البث','📺'),
  ('music','الموسيقى','🎧'),
  ('vpn','VPN','🔐'),
  ('games','الألعاب','🎮'),
  ('social','Social','🌐'),
  ('discord','Discord','💬');

UPDATE categories SET sort_order = CASE slug
  WHEN 'chatgpt' THEN 10
  WHEN 'gemini' THEN 20
  WHEN 'grok' THEN 30
  WHEN 'codex-api' THEN 40
  WHEN 'claude' THEN 50
  WHEN 'kimi' THEN 60
  WHEN 'video-ai' THEN 70
  WHEN 'elevenlabs' THEN 80
  WHEN 'ai-tools' THEN 90
  WHEN 'qwen-api' THEN 100
  WHEN 'deepseek' THEN 110
  WHEN 'cursor-api' THEN 120
  WHEN 'adobe' THEN 130
  WHEN 'autodesk' THEN 140
  WHEN 'design' THEN 150
  WHEN 'office' THEN 160
  WHEN 'education' THEN 170
  WHEN 'streaming' THEN 180
  WHEN 'music' THEN 190
  WHEN 'vpn' THEN 200
  WHEN 'security' THEN 210
  WHEN 'games' THEN 220
  WHEN 'social' THEN 230
  WHEN 'discord' THEN 240
  WHEN 'hosting-apps' THEN 250
  WHEN 'hosting-web' THEN 260
  WHEN 'software' THEN 270
  ELSE 900+id
END;

UPDATE categories SET title='الحماية' WHERE slug='security' AND title='الحماية و VPN';
CREATE INDEX IF NOT EXISTS idx_category_visible_order ON categories(active,sort_order,id);
