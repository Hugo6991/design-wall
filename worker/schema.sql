CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL,          -- extension-image / extension-shot / api
  page_url TEXT, page_title TEXT, text TEXT,
  image_key TEXT NOT NULL, w INTEGER, h INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending / done / error
  kind TEXT, score INTEGER, verdict TEXT, reason TEXT, tags TEXT, palette TEXT, taste_match TEXT,
  model TEXT, error TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  dropped_at TEXT                -- 手機貼進來的時間（2026-10-05 起；舊資料庫用 ALTER TABLE 加）
);
CREATE INDEX IF NOT EXISTS items_created ON items(created_at);

-- X wall（2026-10-05）：所有按讚的推文，不管是不是設計；item_id 有值代表過規則進了設計牆
CREATE TABLE IF NOT EXISTS tweets (
  id TEXT PRIMARY KEY, url TEXT, liked_at TEXT, tweet_at TEXT, author TEXT, handle TEXT, text TEXT,
  media TEXT NOT NULL DEFAULT '[]',      -- JSON：type / w / h / key（R2 圖）/ video_key（R2 影片）/ src / thumb_src / duration
  status TEXT NOT NULL DEFAULT 'pending', -- pending / fetching / done / error / gone
  error TEXT, score INTEGER, kind TEXT, reason TEXT, item_id TEXT, fetched_at TEXT, created_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tweets_liked ON tweets(liked_at);
CREATE INDEX IF NOT EXISTS tweets_status ON tweets(status);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);   -- 排程狀態（sheet 最後讀取等）
-- 2026-10-05 下午：讚數與沒媒體推文的截圖（ALTER TABLE 加）
-- ALTER TABLE tweets ADD COLUMN likes INTEGER; replies INTEGER; reposts INTEGER; views INTEGER; shot_key TEXT; shot_w INTEGER; shot_h INTEGER
