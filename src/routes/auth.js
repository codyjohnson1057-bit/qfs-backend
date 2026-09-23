const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bip39 = require('bip39');
const pool = require('../db');
const { createDefaultWallets } = require('../services/wallets');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { fullName, email, phone, country, password } = req.body;
  if (!fullName || !email || !phone || !country || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  let client = null;
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    client = await pool.connect();
    await client.query('BEGIN');

    const userResult = await client.query(
      `INSERT INTO users (full_name, email, phone, country, password_hash, preferred_currency, is_wallet_linked)
       VALUES ($1, $2, $3, $4, $5, 'USD', false)
       RETURNING id, full_name, email, role, preferred_currency, created_at`,
      [fullName, email, phone, country, passwordHash]
    );
    const newUser = userResult.rows[0];

    await createDefaultWallets(client, newUser.id);

    const mnemonic = bip39.generateMnemonic(128);
    const algorithm = 'aes-256-cbc';
    const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(mnemonic, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    await client.query(
      `INSERT INTO user_seeds (user_id, encrypted_mnemonic, iv) VALUES ($1, $2, $3)`,
      [newUser.id, encrypted, iv.toString('hex')]
    );

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      success: true,
      user: {
        id: newUser.id,
        fullName: newUser.full_name,
        email: newUser.email,
        role: newUser.role,
        preferred_currency: newUser.preferred_currency || 'USD',
        createdAt: newUser.created_at
      },
      token
    });
  } catch (err) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    if (client) client.release();
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  try {
    const result = await pool.query(
      'SELECT id, full_name, email, password_hash, role, is_banned, is_suspended FROM users WHERE email = $1 AND deleted_at IS NULL',
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const user = result.rows[0];
    if (user.is_banned) return res.status(403).json({ error: 'Account banned' });
    if (user.is_suspended) return res.status(403).json({ error: 'Account suspended' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        role: user.role
      },
      token
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
