const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const {
  formatWalletRows,
  createDefaultWallets,
  DEFAULT_CURRENCIES
} = require('../services/wallets');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    // Create-on-read: ensure every dashboard asset key exists for this user
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await createDefaultWallets(client, req.userId);
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('ensure wallets:', e.message);
    } finally {
      client.release();
    }

    const result = await pool.query(
      'SELECT currency, balance FROM wallets WHERE user_id = $1',
      [req.userId]
    );
    // Normalize currency keys to lowercase; merge legacy UPPER + lower duplicates by summing
    const map = new Map();
    for (const row of formatWalletRows(result.rows)) {
      const prev = map.get(row.currency);
      if (prev) {
        map.set(row.currency, {
          currency: row.currency,
          balance: String(Number(prev.balance) + Number(row.balance))
        });
      } else {
        map.set(row.currency, {
          currency: row.currency,
          balance: String(row.balance)
        });
      }
    }
    // Include zero rows for any DEFAULT still missing after merge (defensive)
    for (const curr of DEFAULT_CURRENCIES) {
      if (!map.has(curr)) {
        map.set(curr, { currency: curr, balance: '0' });
      }
    }
    res.json(Array.from(map.values()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
