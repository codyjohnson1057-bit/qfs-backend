/**
 * Best-effort user_audits logger. Never throws to callers.
 */
const pool = require('../db');

async function logUserAudit({ userId, actorId, action, details, ip, client }) {
  if (!action) return;
  const db = client || pool;
  try {
    await db.query(
      `INSERT INTO user_audits (user_id, actor_id, action, details, ip, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())`,
      [
        userId != null ? Number(userId) : null,
        actorId != null ? Number(actorId) : null,
        String(action),
        JSON.stringify(details || {}),
        ip || null
      ]
    );
  } catch (err) {
    console.warn('user_audits log skipped:', err.message);
  }
}

function clientIp(req) {
  try {
    const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
    if (xf) return String(xf).split(',')[0].trim();
    return (req.ip || req.socket?.remoteAddress || null);
  } catch (_) {
    return null;
  }
}

module.exports = { logUserAudit, clientIp };
