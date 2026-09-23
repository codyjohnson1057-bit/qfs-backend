const express = require('express');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { formatWalletRows } = require('../services/wallets');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
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
    res.json(Array.from(map.values()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
