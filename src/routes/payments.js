const express = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { authenticate, isAdmin } = require('../middleware/auth');
const { logUserAudit, clientIp } = require('../services/audits');

const router = express.Router();

function formatPayment(row) {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    type: row.type,
    amount: Number(row.amount),
    currency: row.currency,
    note: row.note || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM payments WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json(result.rows.map(formatPayment));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

router.post('/', authenticate, async (req, res) => {
  const { type, amount, currency, note, code } = req.body || {};
  if (!type || !['ach', 'wire'].includes(String(type).toLowerCase())) {
    return res.status(400).json({ error: 'type must be ach or wire' });
  }
  const numericAmount = Number(amount);
  if (!numericAmount || numericAmount <= 0) {
    return res.status(400).json({ error: 'Valid amount required' });
  }
  const payCode = (code && String(code).trim()) || crypto.randomUUID();
  try {
    const result = await pool.query(
      `INSERT INTO payments (user_id, code, type, amount, currency, note, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_support', NOW(), NOW())
       RETURNING *`,
      [
        req.userId,
        payCode,
        String(type).toLowerCase(),
        numericAmount,
        (currency || 'USD').toUpperCase(),
        note || null
      ]
    );
    const row = result.rows[0];
    await logUserAudit({
      userId: req.userId,
      actorId: req.userId,
      action: 'payment_submit',
      details: {
        payment_id: row.id,
        code: row.code,
        type: row.type,
        amount: Number(row.amount),
        currency: row.currency
      },
      ip: clientIp(req)
    });
    res.status(201).json({
      id: row.id,
      code: row.code,
      status: 'pending_support',
      type: row.type,
      amount: Number(row.amount),
      currency: row.currency,
      message: 'Contact support to complete ACH/wire'
    });
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Payment code already exists' });
    }
    res.status(500).json({ error: 'Failed to create payment' });
  }
});

const adminRouter = express.Router();

adminRouter.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.full_name as user_name, u.email as user_email
       FROM payments p
       LEFT JOIN users u ON u.id = p.user_id
       ORDER BY p.created_at DESC
       LIMIT 300`
    );
    res.json(result.rows.map((row) => ({
      ...formatPayment(row),
      user_id: row.user_id,
      user_name: row.user_name,
      user_email: row.user_email
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

adminRouter.patch('/:id', authenticate, isAdmin, async (req, res) => {
  let { status, note, admin_note } = req.body || {};
  // Aliases from UI / older clients
  if (status === 'approved' || status === 'complete') status = 'completed';
  if (status === 'reject' || status === 'denied') status = 'rejected';
  if (status && !['pending_support', 'completed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const adminNote = admin_note !== undefined ? admin_note : note;
  try {
    const fields = [];
    const values = [];
    let idx = 1;
    if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
    if (adminNote !== undefined) { fields.push(`admin_note = $${idx++}`); values.push(adminNote); }
    if (status === 'completed' || status === 'rejected') {
      fields.push(`reviewed_by = $${idx++}`);
      values.push(req.userId);
      fields.push('reviewed_at = NOW()');
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push('updated_at = NOW()');
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE payments SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Payment not found' });
    await pool.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [req.userId, 'payment_update', result.rows[0].user_id, JSON.stringify(req.body)]
    );
    res.json({ success: true, payment: formatPayment(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update payment' });
  }
});

module.exports = router;
module.exports.adminRouter = adminRouter;
