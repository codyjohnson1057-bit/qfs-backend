/**
 * Best-effort audit logger. Never throws to callers.
 * IMPORTANT: prefer calling AFTER the business transaction commits.
 */
const pool = require('../db');

function sanitizeInet(ip) {
  if (ip == null || ip === '') return null;
  const s = String(ip).trim();
  const v4mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4mapped) return v4mapped[1];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return s;
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) return s;
  return null;
}

async function logUserAudit({ userId, actorId, action, details, ip, userAgent, adminAuditId, client }) {
  if (!action) return;
  const db = client || pool;
  try {
    await db.query(
      `INSERT INTO user_audits (user_id, actor_id, action, details, ip, user_agent, admin_audit_id, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::inet, $6, $7, NOW())`,
      [
        userId != null ? Number(userId) : null,
        actorId != null ? Number(actorId) : null,
        String(action),
        JSON.stringify(details || {}),
        sanitizeInet(ip),
        userAgent ? String(userAgent).slice(0, 500) : null,
        adminAuditId != null ? Number(adminAuditId) : null
      ]
    );
  } catch (err) {
    // Fallback without newer columns
    try {
      await db.query(
        `INSERT INTO user_audits (user_id, actor_id, action, details, ip, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::inet, NOW())`,
        [
          userId != null ? Number(userId) : null,
          actorId != null ? Number(actorId) : null,
          String(action),
          JSON.stringify(details || {}),
          sanitizeInet(ip)
        ]
      );
    } catch (err2) {
      console.warn('user_audits log skipped:', err2.message);
    }
  }
}

/**
 * Write admin_audit_logs AND mirror into user_audits (when targetUserId set)
 * so the SuperRight "User Audits" tab shows admin actions.
 */
async function logAdminAudit({
  adminId,
  action,
  targetUserId = null,
  details = {},
  ip = null,
  userAgent = null,
  client = null,
  mirrorUserAudit = true
}) {
  if (!action) return;
  const db = client || pool;
  const safeIp = sanitizeInet(ip);
  const ua = userAgent ? String(userAgent).slice(0, 500) : null;
  const payload = Object.assign({}, details || {});
  if (ua) payload.user_agent = ua;

  let adminAuditId = null;
  try {
    const ins = await db.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, details, ip_address, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5::inet, NOW())
       RETURNING id`,
      [
        adminId != null ? Number(adminId) : null,
        String(action),
        targetUserId != null ? Number(targetUserId) : null,
        JSON.stringify(payload),
        safeIp
      ]
    );
    adminAuditId = ins.rows[0] && ins.rows[0].id;
  } catch (err) {
    try {
      const ins = await db.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, details, created_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())
         RETURNING id`,
        [
          adminId != null ? Number(adminId) : null,
          String(action),
          targetUserId != null ? Number(targetUserId) : null,
          JSON.stringify(payload)
        ]
      );
      adminAuditId = ins.rows[0] && ins.rows[0].id;
    } catch (err2) {
      console.warn('admin_audit_logs skipped:', err2.message);
    }
  }

  if (mirrorUserAudit && targetUserId != null) {
    await logUserAudit({
      userId: targetUserId,
      actorId: adminId,
      action,
      details: payload,
      ip: safeIp,
      userAgent: ua,
      adminAuditId,
      client: client || undefined
    });
  }
  return adminAuditId;
}

function clientIp(req) {
  try {
    const xf = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
    if (xf) return sanitizeInet(String(xf).split(',')[0].trim()) || null;
    return sanitizeInet(req.ip || req.socket?.remoteAddress || null);
  } catch (_) {
    return null;
  }
}

function clientUa(req) {
  try {
    const ua = req.headers && req.headers['user-agent'];
    return ua ? String(ua).slice(0, 500) : null;
  } catch (_) {
    return null;
  }
}

async function safeCommit(client) {
  const result = await client.query('COMMIT');
  if (result && result.command && result.command !== 'COMMIT') {
    throw new Error('Transaction was rolled back (COMMIT became ' + result.command + ') — a prior statement likely failed inside the transaction');
  }
  return result;
}

module.exports = {
  logUserAudit,
  logAdminAudit,
  clientIp,
  clientUa,
  sanitizeInet,
  safeCommit
};
