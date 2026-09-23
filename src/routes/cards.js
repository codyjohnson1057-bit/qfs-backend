const express = require('express');
const pool = require('../db');
const { authenticate, isAdmin } = require('../middleware/auth');

const router = express.Router();
const CARD_FEE = 350;

function formatCard(row) {
  return {
    id: row.id,
    status: row.status,
    cardholder_name: row.cardholder_name,
    number: row.number,
    expiry: row.expiry,
    cvv: row.cvv,
    network: row.network || 'visa',
    daily_limit: row.daily_limit != null ? Number(row.daily_limit) : 2500,
    online_enabled: row.online_enabled !== false,
    frozen: !!row.frozen,
    fee_paid: !!row.fee_paid,
    fee_amount: Number(row.fee_amount != null ? row.fee_amount : CARD_FEE),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function genPlaceholderNumber() {
  // Not a real PAN — placeholder until admin sets details on activate
  const mid = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return '4111' + mid.slice(0, 8) + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(result.rows.map(formatCard));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

async function createPendingCard(userId) {
  // Look up name for cardholder placeholder
  const user = await pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
  const name = (user.rows[0]?.full_name || 'CARDHOLDER').toUpperCase();
  const result = await pool.query(
    `INSERT INTO cards (
       user_id, status, cardholder_name, number, expiry, cvv, network,
       daily_limit, online_enabled, frozen, fee_paid, fee_amount, created_at, updated_at
     ) VALUES ($1, 'pending', $2, $3, NULL, NULL, 'visa', 2500, true, false, false, $4, NOW(), NOW())
     RETURNING *`,
    [userId, name, genPlaceholderNumber(), CARD_FEE]
  );
  return result.rows[0];
}

async function handleCardRequest(req, res) {
  try {
    const pending = await pool.query(
      `SELECT id FROM cards WHERE user_id = $1 AND status = 'pending' LIMIT 1`,
      [req.userId]
    );
    if (pending.rows.length) {
      return res.json({
        id: pending.rows[0].id,
        status: 'pending',
        fee: CARD_FEE,
        message: 'Card request already pending — awaiting admin activation'
      });
    }
    const row = await createPendingCard(req.userId);
    // fee_paid=false; do NOT auto-debit $350
    res.status(201).json({
      id: row.id,
      status: 'pending',
      fee: CARD_FEE,
      message: 'Card request submitted — awaiting admin activation'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to request card' });
  }
}

router.post('/request', authenticate, handleCardRequest);
// Optional create alias
router.post('/', authenticate, handleCardRequest);

router.patch('/:id', authenticate, async (req, res) => {
  const { frozen, daily_limit, online_enabled } = req.body || {};
  try {
    const check = await pool.query(
      'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Card not found' });

    const fields = [];
    const values = [];
    let idx = 1;
    if (frozen !== undefined) {
      fields.push(`frozen = $${idx++}`);
      values.push(!!frozen);
      // Keep status in sync when freezing/unfreezing an active card
      if (frozen) {
        fields.push(`status = CASE WHEN status = 'active' THEN 'frozen' ELSE status END`);
      } else {
        fields.push(`status = CASE WHEN status = 'frozen' THEN 'active' ELSE status END`);
      }
    }
    if (daily_limit !== undefined) {
      fields.push(`daily_limit = $${idx++}`);
      values.push(Number(daily_limit));
    }
    if (online_enabled !== undefined) {
      fields.push(`online_enabled = $${idx++}`);
      values.push(!!online_enabled);
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push('updated_at = NOW()');
    values.push(req.params.id, req.userId);
    const result = await pool.query(
      `UPDATE cards SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}
       RETURNING *`,
      values
    );
    res.json(formatCard(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update card' });
  }
});

// Admin: activate pending card for user
const adminActivateRouter = express.Router({ mergeParams: true });

adminActivateRouter.post('/', authenticate, isAdmin, async (req, res) => {
  const userId = req.params.id;
  const body = req.body || {};
  try {
    let cardResult = await pool.query(
      `SELECT * FROM cards WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (!cardResult.rows.length) {
      // Activate latest card or create one
      cardResult = await pool.query(
        `SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
    }
    let card;
    if (!cardResult.rows.length) {
      card = await createPendingCard(userId);
    } else {
      card = cardResult.rows[0];
    }

    const result = await pool.query(
      `UPDATE cards SET
         status = 'active',
         fee_paid = COALESCE($1, true),
         cardholder_name = COALESCE($2, cardholder_name),
         number = COALESCE($3, number),
         expiry = COALESCE($4, expiry),
         cvv = COALESCE($5, cvv),
         frozen = false,
         activated_at = COALESCE(activated_at, NOW()),
         activated_by = COALESCE($7, activated_by),
         updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        body.fee_paid !== undefined ? !!body.fee_paid : true,
        body.cardholder_name || null,
        body.number || null,
        body.expiry || null,
        body.cvv || null,
        card.id,
        req.userId
      ]
    );

    await pool.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [req.userId, 'card_activate', userId, JSON.stringify({ card_id: result.rows[0].id })]
    );

    res.json({ success: true, card: formatCard(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to activate card' });
  }
});

const adminCardsRouter = express.Router({ mergeParams: true });

adminCardsRouter.put('/', authenticate, isAdmin, async (req, res) => {
  const userId = req.params.id;
  const body = req.body || {};
  let cardId = body.card_id || body.id;
  try {
    if (!cardId) {
      // SuperRight save often omits card_id — target latest card for user
      const latest = await pool.query(
        `SELECT id FROM cards WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (!latest.rows.length) return res.status(404).json({ error: 'No card for user' });
      cardId = latest.rows[0].id;
    }
    const check = await pool.query(
      'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
      [cardId, userId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Card not found' });

    const fields = [];
    const values = [];
    let idx = 1;
    const map = {
      cardholder_name: body.cardholder_name,
      number: body.number,
      expiry: body.expiry,
      cvv: body.cvv,
      status: body.status,
      frozen: body.frozen,
      daily_limit: body.daily_limit,
      online_enabled: body.online_enabled,
      fee_paid: body.fee_paid,
      network: body.network
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) {
        fields.push(`${col} = $${idx++}`);
        values.push(val);
      }
    }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push('updated_at = NOW()');
    values.push(cardId, userId);
    const result = await pool.query(
      `UPDATE cards SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}
       RETURNING *`,
      values
    );
    await pool.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, details, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [req.userId, 'card_update', userId, JSON.stringify(body)]
    );
    res.json({ success: true, card: formatCard(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update card' });
  }
});

adminCardsRouter.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows.map(formatCard));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

module.exports = router;
module.exports.adminActivateRouter = adminActivateRouter;
module.exports.adminCardsRouter = adminCardsRouter;
module.exports.formatCard = formatCard;
