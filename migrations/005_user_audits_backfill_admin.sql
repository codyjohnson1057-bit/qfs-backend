-- 005_user_audits_backfill_admin.sql
-- Additive: optional user_agent; backfill user_audits from admin_audit_logs
-- so SuperRight "User Audits" shows historical admin actions.

ALTER TABLE user_audits ADD COLUMN IF NOT EXISTS user_agent text;
ALTER TABLE user_audits ADD COLUMN IF NOT EXISTS admin_audit_id integer;

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_audits_admin_audit_id
  ON user_audits (admin_audit_id)
  WHERE admin_audit_id IS NOT NULL;

-- Backfill admin actions that targeted a user and are not already mirrored
INSERT INTO user_audits (user_id, actor_id, action, details, ip, created_at, admin_audit_id)
SELECT
  a.target_user_id,
  a.admin_id,
  a.action,
  COALESCE(a.details, '{}'::jsonb),
  a.ip_address,
  COALESCE(a.created_at::timestamptz, NOW()),
  a.id
FROM admin_audit_logs a
WHERE a.target_user_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM user_audits ua WHERE ua.admin_audit_id = a.id
  )
ON CONFLICT DO NOTHING;
