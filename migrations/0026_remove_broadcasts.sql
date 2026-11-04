-- Retire announcements while keeping orders, money, support and maintenance untouched.
-- Cancel all remaining jobs. Sent messages already delivered cannot be recalled.
UPDATE maintenance_broadcast_jobs
  SET status='cancelled',finished_at=COALESCE(finished_at,CURRENT_TIMESTAMP)
  WHERE status='pending';
DELETE FROM notification_outbox WHERE broadcast_job_id IS NOT NULL AND state!='sent';
DELETE FROM user_sessions WHERE action IN
  ('owner_broadcast_compose','owner_broadcast_review','owner_maintenance_resume_text');
DELETE FROM bot_settings WHERE key='maintenance_resume_message_ar';
