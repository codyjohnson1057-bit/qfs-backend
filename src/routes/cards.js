const express = require('express');
const pool = require('../db');
const { authenticate, isAdmin } = require('../middleware/auth');
const { getUsdRates, fromUsd, toUsd } = require('../services/rates');
const { normalizeCurrencyKey, ensureWallet } = require('../services/wallets');
const { logUserAudit, clientIp } = require('../services/audits');

const router = express.Router();

const CARD_TIERS = {
  blue: { key: 'blue', label: 'Blue', fee: 500 },
  green: { key: 'green', label: 'Green', fee: 850 },
  silver: { key: 'silver', label: 'Silver', fee: 1500 },
  gold: { key: 'gold', label: 'Gold', fee: 3000 }
};

function resolveTier(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return CARD_TIERS[k] || null;
}

function formatCard(row) {
  return {
    id: row.id,
    status: row.status,
    tier: row.tier || null,
    cardholder_name: row.cardholder_name,
    number: row.number,
    expiry: row.expiry,
    cvv: row.cvv,
    network: row.network || 'visa',
    daily_limit: row.daily_limit != null ? Number(row.daily_limit) : 2500,
    online_enabled: row.online_enabled !== false,
    frozen: !!row.frozen,
    fee_paid: !!row.fee_paid,
    fee_amount: Number(row.fee_amount != null ? row.fee_amount : 0),
    pay_currency: row.pay_currency ? normalizeCurrencyKey(row.pay_currency) : null,
    requested_at: row.requested_at || row.created_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function genPlaceholderNumber() {
  const mid = String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
  return '4111' + mid.slice(0, 8) + String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

function genExpiry() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 3);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return mm + '/' + yy;
}

function genCvv() {
  return String(Math.floor(Math.random() * 900) + 100);
}

router.get('/tiers', authenticate, (req, res) => {
  res.json(Object.values(CARD_TIERS));
});

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

async function handleCardRequest(req, res) {
  const body = req.body || {};
  const tierInfo = resolveTier(body.tier || body.card_tier);
  if (!tierInfo) {
    return res.status(400).json({
      error: 'tier required (blue|green|silver|gold)',
      tiers: Object.values(CARD_TIERS)
    });
  }
  const payCurrency = normalizeCurrencyKey(body.currency || body.pay_currency || body.from || 'qfs') || 'qfs';
  const feeUsd = tierInfo.fee;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const blocking = await client.query(
      `SELECT id, status FROM cards
       WHERE user_id = $1 AND status IN ('pending', 'active', 'frozen')
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [req.userId]
    );
    if (blocking.rows.length) {
      const st = blocking.rows[0].status;
      await client.query('ROLLBACK');
      if (st === 'pending') {
        return res.status(409).json({
          error: 'Card request already pending — awaiting admin activation',
          id: blocking.rows[0].id,
          status: 'pending'
        });
      }
      return res.status(409).json({
        error: 'You already have an active card',
        id: blocking.rows[0].id,
        status: st
      });
    }

    const rates = await getUsdRates();
    const debitUnits = fromUsd(feeUsd, payCurrency, rates);
    if (!debitUnits || debitUnits <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Unable to price asset "${payCurrency}" for card fee` });
    }

    const wallet = await ensureWallet(client, req.userId, payCurrency);
    const bal = Number(wallet.balance || 0);
    const balUsd = toUsd(bal, payCurrency, rates);
    if (bal + 1e-12 < debitUnits) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient funds for ${tierInfo.label} card ($${feeUsd}). ${payCurrency.toUpperCase()} balance ≈ $${balUsd.toFixed(2)}, need $${feeUsd}`,
        balance: bal,
        balance_usd: balUsd,
        required: debitUnits,
        required_usd: feeUsd,
        currency: payCurrency,
        tier: tierInfo.key
      });
    }

    await client.query('UPDATE wallets SET balance = balance - $1 WHERE id = $2', [
      debitUnits,
      wallet.id
    ]);

    const user = await client.query('SELECT full_name, email FROM users WHERE id = $1', [req.userId]);
    const name = (user.rows[0]?.full_name || 'CARDHOLDER').toUpperCase();

    const insert = await client.query(
      `INSERT INTO cards (
         user_id, status, tier, cardholder_name, number, expiry, cvv, network,
         daily_limit, online_enabled, frozen, fee_paid, fee_amount, pay_currency,
         requested_at, created_at, updated_at
       ) VALUES (
         $1, 'pending', $2, $3, $4, NULL, NULL, 'visa',
         2500, true, false, true, $5, $6,
         NOW(), NOW(), NOW()
       ) RETURNING *`,
      [req.userId, tierInfo.key, name, genPlaceholderNumber(), feeUsd, payCurrency]
    );
    const row = insert.rows[0];

    try {
      await client.query(
        `INSERT INTO transactions (sender_id, receiver_id, currency, amount, amount_usd, type, status, description, created_at, updated_at)
         VALUES ($1, $1, $2, $3, $4, 'card_fee', 'completed', $5, NOW(), NOW())`,
        [
          req.userId,
          payCurrency,
          debitUnits,
          feeUsd,
          `Card fee ${tierInfo.label} ($${feeUsd}) paid from ${payCurrency.toUpperCase()}`
        ]
      );
    } catch (txErr) {
      console.warn('card fee tx log skipped', txErr.message);
    }

    await logUserAudit({
      client,
      userId: req.userId,
      actorId: req.userId,
      action: 'card_request',
      details: {
        card_id: row.id,
        tier: tierInfo.key,
        fee_usd: feeUsd,
        pay_currency: payCurrency,
        debited: debitUnits,
        user_name: user.rows[0]?.full_name || null,
        user_email: user.rows[0]?.email || null
      },
      ip: clientIp(req)
    });

    await client.query('COMMIT');
    res.status(201).json({
      id: row.id,
      status: 'pending',
      tier: tierInfo.key,
      fee: feeUsd,
      fee_paid: true,
      pay_currency: payCurrency,
      debited: debitUnits,
      message: `${tierInfo.label} card request submitted ($${feeUsd} fee debited). Awaiting admin activation.`
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(err);
    res.status(500).json({ error: 'Failed to request card: ' + (err.message || 'server error') });
  } finally {
    client.release();
  }
}

router.post('/request', authenticate, handleCardRequest);
router.post('/', authenticate, handleCardRequest);

router.patch('/:id', authenticate, async (req, res) => {
  const { frozen, daily_limit, online_enabled } = req.body || {};
  try {
    const check = await pool.query(
      'SELECT * FROM cards WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Card not found' });
    if (String(check.rows[0].status).toLowerCase() !== 'active' &&
        String(check.rows[0].status).toLowerCase() !== 'frozen') {
      return res.status(400).json({ error: 'Card is not active yet' });
    }

    const fields = [];
    const values = [];
    let idx = 1;
    if (frozen !== undefined) {
      fields.push(`frozen = $${idx++}`);
      values.push(!!frozen);
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

// Admin: list all pending cards (hub)
router.get('/admin/pending', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.full_name as user_name, u.email as user_email
       FROM cards c
       LEFT JOIN users u ON u.id = c.user_id
       WHERE c.status = 'pending'
       ORDER BY COALESCE(c.requested_at, c.created_at) DESC
       LIMIT 300`
    );
    res.json(result.rows.map((row) => ({
      ...formatCard(row),
      user_id: row.user_id,
      user_name: row.user_name,
      user_email: row.user_email
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list pending cards' });
  }
});

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
      cardResult = await pool.query(
        `SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
    }
    if (!cardResult.rows.length) {
      return res.status(404).json({ error: 'No card found for user' });
    }
    const card = cardResult.rows[0];

    // Resolve name from body → card → users.full_name
    let holderName = (body.cardholder_name || card.cardholder_name || '').toString().trim();
    if (!holderName) {
      try {
        const u = await pool.query('SELECT full_name FROM users WHERE id = $1', [userId]);
        holderName = (u.rows[0] && u.rows[0].full_name) || 'CARDHOLDER';
      } catch (_) {
        holderName = 'CARDHOLDER';
      }
    }
    holderName = String(holderName).toUpperCase();

    const number = (body.number || card.number || '').toString().trim() || genPlaceholderNumber();
    const expiry = (body.expiry || card.expiry || '').toString().trim() || genExpiry();
    const cvv = (body.cvv || card.cvv || '').toString().trim() || genCvv();
    const feePaid = body.fee_paid !== undefined ? !!body.fee_paid : true;

    let result;
    try {
      result = await pool.query(
        `UPDATE cards SET
           status = 'active',
           fee_paid = COALESCE($1, fee_paid, true),
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
        [feePaid, holderName, number, expiry, cvv, card.id, req.userId]
      );
    } catch (sqlErr) {
      // Tolerant path if optional columns (activated_by / activated_at) missing
      console.warn('activate full UPDATE failed, retrying minimal:', sqlErr.message);
      result = await pool.query(
        `UPDATE cards SET
           status = 'active',
           fee_paid = COALESCE($1, fee_paid, true),
           cardholder_name = COALESCE($2, cardholder_name),
           number = COALESCE($3, number),
           expiry = COALESCE($4, expiry),
           cvv = COALESCE($5, cvv),
           frozen = false,
           updated_at = NOW()
         WHERE id = $6
         RETURNING *`,
        [feePaid, holderName, number, expiry, cvv, card.id]
      );
    }

    try {
      await pool.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, details, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [req.userId, 'card_activate', userId, JSON.stringify({ card_id: result.rows[0].id, tier: result.rows[0].tier })]
      );
    } catch (_) {}

    try {
      await logUserAudit({
        userId: Number(userId),
        actorId: req.userId,
        action: 'card_approve',
        details: { card_id: result.rows[0].id, tier: result.rows[0].tier, fee_amount: result.rows[0].fee_amount },
        ip: clientIp(req)
      });
    } catch (_) {}

    res.json({ success: true, card: formatCard(result.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to activate card: ' + (err.message || 'server error') });
  }
});

// Admin reject + refund fee
const adminRejectRouter = express.Router({ mergeParams: true });

adminRejectRouter.post('/', authenticate, isAdmin, async (req, res) => {
  const userId = req.params.id;
  const body = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let cardResult = await client.query(
      `SELECT * FROM cards WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [userId]
    );
    if (!cardResult.rows.length && body.card_id) {
      cardResult = await client.query(
        `SELECT * FROM cards WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [body.card_id, userId]
      );
    }
    if (!cardResult.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No pending card to reject' });
    }
    const card = cardResult.rows[0];
    let refunded = 0;
    let refundCurrency = card.pay_currency || 'qfs';

    if (card.fee_paid && Number(card.fee_amount) > 0) {
      const rates = await getUsdRates();
      const curr = normalizeCurrencyKey(card.pay_currency || 'qfs') || 'qfs';
      refundCurrency = curr;
      const units = fromUsd(Number(card.fee_amount), curr, rates);
      if (units > 0) {
        const wallet = await ensureWallet(client, userId, curr);
        await client.query('UPDATE wallets SET balance = balance + $1 WHERE id = $2', [
          units,
          wallet.id
        ]);
        refunded = units;
        try {
          await client.query(
            `INSERT INTO transactions (sender_id, receiver_id, currency, amount, amount_usd, type, status, description, created_at, updated_at)
             VALUES ($1, $1, $2, $3, $4, 'card_fee_refund', 'completed', $5, NOW(), NOW())`,
            [
              userId,
              curr,
              units,
              Number(card.fee_amount),
              `Card fee refund (rejected ${card.tier || 'card'})`
            ]
          );
        } catch (txErr) {
          console.warn('card refund tx skipped', txErr.message);
        }
      }
    }

    const updated = await client.query(
      `UPDATE cards SET
         status = 'rejected',
         fee_paid = false,
         rejected_at = NOW(),
         rejected_by = $2,
         reject_reason = $3,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [card.id, req.userId, body.reason || body.reject_reason || 'Rejected by admin']
    );

    try {
      await client.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, details, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [
          req.userId,
          'card_reject',
          userId,
          JSON.stringify({ card_id: card.id, refunded, refund_currency: refundCurrency })
        ]
      );
    } catch (_) {}

    await logUserAudit({
      client,
      userId: Number(userId),
      actorId: req.userId,
      action: 'card_reject',
      details: {
        card_id: card.id,
        tier: card.tier,
        refunded,
        refund_currency: refundCurrency,
        reason: body.reason || null
      },
      ip: clientIp(req)
    });

    await client.query('COMMIT');
    res.json({
      success: true,
      card: formatCard(updated.rows[0]),
      refunded,
      refund_currency: refundCurrency
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(err);
    res.status(500).json({ error: 'Failed to reject card' });
  } finally {
    client.release();
  }
});

const adminCardsRouter = express.Router({ mergeParams: true });

adminCardsRouter.put('/', authenticate, isAdmin, async (req, res) => {
  const userId = req.params.id;
  const body = req.body || {};
  let cardId = body.card_id || body.id;
  try {
    if (!cardId) {
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
      network: body.network,
      tier: body.tier,
      pay_currency: body.pay_currency != null ? normalizeCurrencyKey(body.pay_currency) : undefined,
      fee_amount: body.fee_amount
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
    try {
      await pool.query(
        `INSERT INTO admin_audit_logs (admin_id, action, target_user_id, details, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [req.userId, 'card_update', userId, JSON.stringify(body)]
      );
    } catch (_) {}
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
module.exports.adminRejectRouter = adminRejectRouter;
module.exports.adminCardsRouter = adminCardsRouter;
module.exports.formatCard = formatCard;
module.exports.CARD_TIERS = CARD_TIERS;
