const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { authenticate } = require('../middleware/auth');
const { getUsdRates, toUsd } = require('../services/rates');

const router = express.Router();

router.get('/', authenticate, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT id, full_name, email, phone, role, is_banned, is_suspended, is_verified,
              preferred_currency, profile_image, is_wallet_linked, created_at
       FROM users WHERE id = $1`,
      [req.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    const txResult = await pool.query(
      `SELECT amount, currency, type, sender_id, receiver_id, amount_usd, status
       FROM transactions
       WHERE (sender_id = $1 OR receiver_id = $1) AND status = 'completed'`,
      [req.userId]
    );

    const rates = await getUsdRates();
    let income = 0;
    let expenses = 0;

    for (const tx of txResult.rows) {
      let usd = Number(tx.amount_usd);
      if (!usd || isNaN(usd) || usd === 0) {
        usd = toUsd(tx.amount, tx.currency, rates);
      }

      const isIn =
        String(tx.receiver_id) === String(req.userId) &&
        ['receive', 'deposit', 'admin_adjust'].includes(tx.type);
      const isOut =
        String(tx.sender_id) === String(req.userId) &&
        ['send', 'withdrawal', 'admin_adjust'].includes(tx.type);

      if (isIn) income += usd;
      if (isOut) expenses += usd;
    }

    await pool.query(
      'UPDATE users SET income = $1, expenses = $2 WHERE id = $3',
      [income, expenses, req.userId]
    );

    res.json({
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      phone: user.phone || null,
      role: user.role,
      is_banned: user.is_banned,
      is_suspended: user.is_suspended,
      is_verified: user.is_verified,
      preferred_currency: user.preferred_currency || 'USD',
      profile_image: user.profile_image || null,
      is_wallet_linked: !!user.is_wallet_linked,
      created_at: user.created_at,
      income,
      expenses
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/name', authenticate, async (req, res) => {
  const { full_name } = req.body || {};
  if (!full_name || String(full_name).trim() === '') {
    return res.status(400).json({ error: 'full_name is required' });
  }
  try {
    const result = await pool.query(
      'UPDATE users SET full_name = $1 WHERE id = $2 RETURNING full_name',
      [String(full_name).trim(), req.userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, full_name: result.rows[0].full_name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update name' });
  }
});

router.post('/phone', authenticate, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number is required' });
  try {
    await pool.query('UPDATE users SET phone = $1 WHERE id = $2', [phone, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update phone' });
  }
});

router.post('/email', authenticate, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update email' });
  }
});

router.post('/password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  try {
    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const match = await bcrypt.compare(currentPassword, userResult.rows[0].password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect current password' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

router.post('/currency', authenticate, async (req, res) => {
  const { currency } = req.body;
  if (!currency) return res.status(400).json({ error: 'Currency required' });
  try {
    await pool.query('UPDATE users SET preferred_currency = $1 WHERE id = $2', [currency, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update currency' });
  }
});

router.post('/profile-image', authenticate, async (req, res) => {
  const { profile_image } = req.body;
  if (!profile_image || typeof profile_image !== 'string') {
    return res.status(400).json({ error: 'profile_image (base64 data URL) required' });
  }
  if (profile_image.length > 2800000) {
    return res.status(400).json({ error: 'Image too large (max ~2MB)' });
  }
  if (!profile_image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'Must be a data:image/... base64 string' });
  }
  try {
    await pool.query(
      'UPDATE users SET profile_image = $1 WHERE id = $2',
      [profile_image, req.userId]
    );
    res.json({ success: true, profile_image });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save profile image' });
  }
});


router.post('/pin', authenticate, async (req, res) => {
  const { currentPin, newPin } = req.body || {};
  if (currentPin === undefined || currentPin === null || newPin === undefined || newPin === null) {
    return res.status(400).json({ error: 'currentPin and newPin required' });
  }
  const next = String(newPin).trim();
  if (!/^\d{4,8}$/.test(next)) {
    return res.status(400).json({ error: 'PIN must be 4–8 digits' });
  }
  try {
    const userResult = await pool.query(
      'SELECT pin FROM users WHERE id = $1 AND deleted_at IS NULL',
      [req.userId]
    );
    if (!userResult.rows.length) return res.status(404).json({ error: 'User not found' });
    const stored = String(userResult.rows[0].pin ?? '0000');
    if (String(currentPin) !== stored) {
      return res.status(401).json({ error: 'Incorrect current PIN' });
    }
    await pool.query('UPDATE users SET pin = $1 WHERE id = $2', [next, req.userId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update PIN' });
  }
});

module.exports = router;
