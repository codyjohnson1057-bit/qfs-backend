const express = require('express');
const pool = require('../db');
const { authenticate, isAdmin } = require('../middleware/auth');
const { getUsdRates, fromUsd } = require('../services/rates');
const {
  normalizeCurrencyKey,
  formatWalletRows,
  findWallet,
  ensureWallet
} = require('../services/wallets');
const { logUserAudit, clientIp, safeCommit } = require('../services/audits');

const router = express.Router();

router.post('/', authenticate, async (req, res) => {
  const { from, to, amount, pin } = req.body || {};
  const fromKey = normalizeCurrencyKey(from);
  const toKey = normalizeCurrencyKey(to);
  const amountUsd = Number(amount);

  if (!fromKey || !toKey) {
    return res.status(400).json({ error: 'from and to currencies required' });
  }
  if (fromKey === toKey) {
    return res.status(400).json({ error: 'from and to must differ' });
  }
  if (!amountUsd || amountUsd <= 0 || isNaN(amountUsd)) {
    return res.status(400).json({ error: 'Valid amount (USD) required' });
  }
  if (pin === undefined || pin === null || String(pin).trim() === '') {
    return res.status(400).json({ error: 'pin required' });
  }

  const client = await pool.connect();
  try {
    const userResult = await client.query(
      'SELECT pin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.userId]
    );
    if (!userResult.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    const storedPin = String(userResult.rows[0].pin ?? '0000');
    if (String(pin) !== storedPin) {
      return res.status(400).json({ error: 'Invalid pin' });
    }

    const rates = await getUsdRates();
    const fromDebited = fromUsd(amountUsd, fromKey, rates);
    const toCredited = fromUsd(amountUsd, toKey, rates);
    if (!fromDebited || !toCredited) {
      return res.status(400).json({ error: 'Unable to price one or both assets' });
    }

    await client.query('BEGIN');

    const fromWallet = await ensureWallet(client, req.userId, fromKey);
    const toWallet = await ensureWallet(client, req.userId, toKey);

    const fromBal = Number(fromWallet.balance);
    if (fromBal + 1e-12 < fromDebited) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `Insufficient funds in ${fromKey.toUpperCase()}: have ${fromBal}, need ${fromDebited}`, balance: fromBal, required: fromDebited, currency: fromKey });
    }

    const newFrom = fromBal - fromDebited;
    const newTo = Number(toWallet.balance) + toCredited;

    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [newFrom, fromWallet.id]);
    await client.query('UPDATE wallets SET balance = $1 WHERE id = $2', [newTo, toWallet.id]);

    const swapResult = await client.query(
      `INSERT INTO swaps (user_id, from_currency, to_currency, amount_usd, from_debited, to_credited, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [req.userId, fromKey, toKey, amountUsd, fromDebited, toCredited]
    );

    await client.query(
      `INSERT INTO transactions
         (sender_id, receiver_id, currency, amount, amount_usd, type, status, description, created_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, 'swap', 'completed', $5, NOW(), NOW())`,
      [
        req.userId,
        fromKey,
        fromDebited,
        amountUsd,
        `Swap ${fromKey} → ${toKey}`
      ]
    );
    await client.query(
      `INSERT INTO transactions
         (sender_id, receiver_id, currency, amount, amount_usd, type, status, description, created_at, updated_at)
       VALUES ($1, $1, $2, $3, $4, 'swap', 'completed', $5, NOW(), NOW())`,
      [
        req.userId,
        toKey,
        toCredited,
        amountUsd,
        `Swap ${fromKey} → ${toKey}`
      ]
    );

    await safeCommit(client);
    await logUserAudit({
      userId: req.userId,
      actorId: req.userId,
      action: 'swap',
      details: {
        from: fromKey,
        to: toKey,
        amount_usd: amountUsd,
        from_debited: fromDebited,
        to_credited: toCredited,
        swap_id: swapResult.rows[0].id
      },
      ip: clientIp(req)
    });

    const wallets = await pool.query(
      'SELECT currency, balance FROM wallets WHERE user_id = $1',
      [req.userId]
    );

    res.json({
      success: true,
      from: fromKey,
      to: toKey,
      amount_usd: amountUsd,
      from_debited: fromDebited,
      to_credited: toCredited,
      swap_id: swapResult.rows[0].id,
      wallets: formatWalletRows(wallets.rows)
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(err);
    res.status(500).json({ error: err.message || 'Swap failed' });
  } finally {
    client.release();
  }
});

const adminRouter = express.Router();

adminRouter.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u.full_name as user_name, u.email as user_email
       FROM swaps s
       LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.created_at DESC
       LIMIT 300`
    );
    res.json(result.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      from: row.from_currency,
      to: row.to_currency,
      amount_usd: Number(row.amount_usd),
      from_debited: Number(row.from_debited),
      to_credited: Number(row.to_credited),
      created_at: row.created_at,
      user_name: row.user_name,
      user_email: row.user_email
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch swaps' });
  }
});

module.exports = router;
module.exports.adminRouter = adminRouter;
