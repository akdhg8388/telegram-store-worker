-- Durable, rate-limited administrative announcements. No existing settings,
-- currency choices, wallet balances, payment records or message history change.
CREATE TABLE IF NOT EXISTS maintenance_broadcast_jobs (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL CHECK(kind IN ('manual','resume')),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 3500),
 cursor_user_id INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
 queued_count INTEGER NOT NULL DEFAULT 0,
 created_by INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintenance_broadcast_pending
 ON maintenance_broadcast_jobs(status,id);
ALTER TABLE notification_outbox ADD COLUMN broadcast_job_id INTEGER REFERENCES maintenance_broadcast_jobs(id);
ALTER TABLE notification_outbox ADD COLUMN broadcast_user_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_maintenance_broadcast_exactly_once
 ON notification_outbox(broadcast_job_id,broadcast_user_id)
 WHERE broadcast_job_id IS NOT NULL AND broadcast_user_id IS NOT NULL;
