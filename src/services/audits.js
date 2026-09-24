/**
 * Best-effort user_audits logger. Never throws to callers.
 * IMPORTANT: prefer calling AFTER the business transaction commits.
 * If used inside a transaction, a failed INSERT (e.g. invalid inet)
 * aborts the whole PG transaction; node-pg may then treat COMMIT as
 * ROLLBACK without throwing — causing silent data loss with HTTP 201.
 */
const pool = require('../db');

function sanitizeInet(ip) {
  if (ip == null || ip === '') return null;
  const s = String(ip).trim();
  // Strip IPv4-mapped IPv6 prefix Express often yields
  const v4mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4mapped) return v4mapped[1];
  // Basic IPv4
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return s;
  // Basic IPv6 (hex + colons)
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) return s;
  return null;
}

async function logUserAudit({ userId, actorId, action, details, ip, client }) {
  if (!action) return;
  const db = client || pool;
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
  } catch (err) {
    console.warn('user_audits log skipped:', err.message);
  }
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

/**
 * COMMIT that throws if PostgreSQL converted it to ROLLBACK
 * (happens when a prior statement aborted the transaction).
 */
async function safeCommit(client) {
  const result = await client.query('COMMIT');
  if (result && result.command && result.command !== 'COMMIT') {
    throw new Error('Transaction was rolled back (COMMIT became ' + result.command + ') — a prior statement likely failed inside the transaction');
  }
  return result;
}

module.exports = { logUserAudit, clientIp, sanitizeInet, safeCommit };
