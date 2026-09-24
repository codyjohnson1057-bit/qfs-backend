const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bip39 = require('bip39');
const pool = require('../db');
const { authenticate, isAdmin } = require('../middleware/auth');
const { getUsdRates, toUsd } = require('../services/rates');
const {
  createDefaultWallets,
  findWallet,
  ensureWallet,
  formatWalletRows,
  normalizeCurrencyKey
} = require('../services/wallets');
const { formatCard } = require('./cards');
const { formatVault } = require('./vaults');
const { logAdminAudit, clientIp, clientUa } = require('../services/audits');

const router = express.Router();

router.use(authenticate, isAdmin);

router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, full_name, email, phone, country, role,
              is_banned, is_suspended, is_verified, is_wallet_linked,
              preferred_currency, income, expenses, created_at
       FROM users
       WHERE deleted_at IS NULL
       ORDER BY id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const userResult = await pool.query(
      `SELECT id, full_name, email, phone, country, role,
              is_banned, is_suspended, is_verified, is_wallet_linked,
              preferred_currency, profile_image, income, expenses, created_at
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];
    const walletResult = await pool.query(
      'SELECT currency, balance FROM wallets WHERE user_id = $1',
      [id]
    );
    user.wallets = formatWalletRows(walletResult.rows);
    const txResult = await pool.query(
      `SELECT * FROM transactions
       WHERE sender_id = $1 OR receiver_id = $1
       ORDER BY created_at DESC LIMIT 100`,
      [id]
    );
    user.transactions = txResult.rows;
    try {
      const cards = await pool.query(
        'SELECT * FROM cards WHERE user_id = $1 ORDER BY created_at DESC',
        [id]
      );
      user.cards = cards.rows.map(formatCard);
    } catch (_) {
      user.cards = [];
    }
    try {
      const vaults = await pool.query(
        'SELECT * FROM vaults WHERE user_id = $1 ORDER BY created_at DESC',
        [id]
      );
      user.vaults = vaults.rows.map(formatVault);
    } catch (_) {
      user.vaults = [];
    }
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

router.post('/users/:id/ban', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  // Accept ban | banned | is_banned (frontend sends { ban })
  const ban = body.ban !== undefined ? body.ban
    : (body.banned !== undefined ? body.banned
      : (body.is_banned !== undefined ? body.is_banned : true));
  try {
    await pool.query('UPDATE users SET is_banned = $1 WHERE id = $2', [!!ban, id]);
    await logAdminAudit({
      adminId: req.userId,
      action: ban ? 'ban_user' : 'unban_user',
      targetUserId: id,
      details: { ban: !!ban },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    res.json({ success: true, is_banned: !!ban });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update ban status' });
  }
});

router.post('/users/:id/suspend', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const suspend = body.suspend !== undefined ? body.suspend
    : (body.suspended !== undefined ? body.suspended
      : (body.is_suspended !== undefined ? body.is_suspended : true));
  const reason = body.reason;
  try {
    await pool.query(
      'UPDATE users SET is_suspended = $1, suspension_reason = $2 WHERE id = $3',
      [!!suspend, suspend ? (reason || 'Suspended by admin') : null, id]
    );
    await logAdminAudit({
      adminId: req.userId,
      action: suspend ? 'suspend_user' : 'unsuspend_user',
      targetUserId: id,
      details: { suspend: !!suspend, reason },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    res.json({ success: true, is_suspended: !!suspend });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update suspend status' });
  }
});

router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [id]);
    await logAdminAudit({
      adminId: req.userId,
      action: 'delete_user',
      targetUserId: id,
      details: {},
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

router.post('/users/:id/verify', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  // Default to verify=true when body omits the flag (common admin "Verify" action)
  const verify = body.verify !== undefined ? body.verify : (body.verified !== undefined ? body.verified : true);
  try {
    await pool.query('UPDATE users SET is_verified = $1 WHERE id = $2', [!!verify, id]);
    await logAdminAudit({
      adminId: req.userId,
      action: verify ? 'verify_user' : 'unverify_user',
      targetUserId: id,
      details: { verify },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update verification' });
  }
});

router.post('/users/:id/wallet-link', async (req, res) => {
  const { id } = req.params;
  const body = req.body || {};
  const linked = body.linked !== undefined ? body.linked
    : (body.is_wallet_linked !== undefined ? body.is_wallet_linked : true);
  try {
    await pool.query(
      'UPDATE users SET is_wallet_linked = $1 WHERE id = $2',
      [!!linked, id]
    );
    await logAdminAudit({
      adminId: req.userId,
      action: linked ? 'wallet_link' : 'wallet_unlink',
      targetUserId: id,
      details: { linked: !!linked },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    res.json({ success: true, is_wallet_linked: !!linked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update wallet link status' });
  }
});

router.post('/users/:id/balance', async (req, res) => {
  const { id } = req.params;
  const { currency, amount, description } = req.body;
  // Accept both operation (legacy) and action (contract)
  const operation = req.body.operation || req.body.action;
  if (!currency || !amount || !operation) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const wallet = await ensureWallet(client, id, currency);
    if (!wallet) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Wallet not found' });
    }

    let currentBalance = Number(wallet.balance);
    let newBalance;
    let senderId = null;
    let receiverId = null;
    const txType = 'admin_adjust';
    const op = String(operation).toLowerCase();

    if (op === 'credit' || op === 'add' || op === 'deposit') {
      newBalance = currentBalance + numericAmount;
      receiverId = id;
    } else if (op === 'debit' || op === 'subtract' || op === 'withdraw') {
      if (currentBalance < numericAmount) {
        throw new Error('Insufficient balance');
      }
      newBalance = currentBalance - numericAmount;
      senderId = id;
    } else {
      throw new Error('Invalid operation');
    }

    await client.query(
      'UPDATE wallets SET balance = $1 WHERE id = $2',
      [newBalance, wallet.id]
    );

    const rates = await getUsdRates();
    const amountUsd = toUsd(numericAmount, currency, rates);
    const desc = description || `${op} by admin`;

    await client.query(
      `INSERT INTO transactions
         (sender_id, receiver_id, currency, amount, amount_usd, type, status, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [senderId, receiverId, normalizeCurrencyKey(currency), numericAmount, amountUsd, txType, 'completed', desc]
    );

    await client.query('COMMIT');
    await logAdminAudit({
      adminId: req.userId,
      action: 'balance_adjust',
      targetUserId: id,
      details: {
        currency: normalizeCurrencyKey(currency),
        amount: numericAmount,
        amount_usd: amountUsd,
        operation: op,
        before_balance: currentBalance,
        after_balance: newBalance,
        description: desc
      },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    res.json({ success: true, newBalance, amount_usd: amountUsd });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to adjust balance' });
  } finally {
    client.release();
  }
});

router.post('/impersonate/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, email, role FROM users WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = result.rows[0];
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    await logAdminAudit({
      adminId: req.userId,
      action: 'impersonate',
      targetUserId: id,
      details: {},
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to impersonate' });
  }
});

router.post('/notifications', async (req, res) => {
  const userId = req.body.user_id ?? req.body.userId ?? null;
  const { title, message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    if (userId && userId !== 'all' && userId !== null) {
      await pool.query(
        `INSERT INTO notifications (user_id, title, message, is_read, created_at)
         VALUES ($1, $2, $3, false, NOW())`,
        [userId, title || 'Admin Notification', message]
      );
    } else {
      const users = await pool.query('SELECT id FROM users WHERE deleted_at IS NULL');
      for (const row of users.rows) {
        await pool.query(
          `INSERT INTO notifications (user_id, title, message, is_read, created_at)
           VALUES ($1, $2, $3, false, NOW())`,
          [row.id, title || 'Admin Notification', message]
        );
      }
    }

    const notifTarget =
      userId && userId !== 'all' && userId !== null ? Number(userId) : null;
    await logAdminAudit({
      adminId: req.userId,
      action: 'send_notification',
      targetUserId: Number.isFinite(notifTarget) ? notifTarget : null,
      details: { userId, title, message },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

router.get('/notifications', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT n.id, n.user_id, n.title, n.message, n.is_read, n.created_at,
              u.full_name as user_name, u.email as user_email
       FROM notifications n
       LEFT JOIN users u ON u.id = n.user_id
       ORDER BY n.created_at DESC
       LIMIT 200`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

router.put('/notifications/:id', async (req, res) => {
  const { id } = req.params;
  const { title, message } = req.body;
  try {
    const result = await pool.query(
      `UPDATE notifications SET title = COALESCE($1, title), message = COALESCE($2, message)
       WHERE id = $3 RETURNING *`,
      [title, message, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ success: true, notification: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

router.delete('/notifications/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM notifications WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete notification' });
  }
});

router.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const {
    full_name, email, phone, country, role,
    is_banned, is_suspended, is_verified, is_wallet_linked,
    preferred_currency, income, expenses
  } = req.body;

  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (full_name !== undefined) { fields.push(`full_name = $${idx++}`); values.push(full_name); }
    if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email); }
    if (phone !== undefined) { fields.push(`phone = $${idx++}`); values.push(phone); }
    if (country !== undefined) { fields.push(`country = $${idx++}`); values.push(country); }
    if (role !== undefined) { fields.push(`role = $${idx++}`); values.push(role); }
    if (is_banned !== undefined) { fields.push(`is_banned = $${idx++}`); values.push(is_banned); }
    if (is_suspended !== undefined) { fields.push(`is_suspended = $${idx++}`); values.push(is_suspended); }
    if (is_verified !== undefined) { fields.push(`is_verified = $${idx++}`); values.push(is_verified); }
    if (is_wallet_linked !== undefined) { fields.push(`is_wallet_linked = $${idx++}`); values.push(!!is_wallet_linked); }
    if (preferred_currency !== undefined) { fields.push(`preferred_currency = $${idx++}`); values.push(preferred_currency); }
    if (income !== undefined) { fields.push(`income = $${idx++}`); values.push(Number(income)); }
    if (expenses !== undefined) { fields.push(`expenses = $${idx++}`); values.push(Number(expenses)); }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(id);
    const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}
                   RETURNING id, full_name, email, phone, country, role, is_banned, is_suspended,
                             is_verified, is_wallet_linked, preferred_currency, income, expenses`;
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await logAdminAudit({
      adminId: req.userId,
      action: 'update_user',
      targetUserId: id,
      details: req.body,
      ip: clientIp(req),
      userAgent: clientUa(req)
    });

    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.post('/users', async (req, res) => {
  const { full_name, email, phone, country, password, role } = req.body;
  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'Name, email and password required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await client.query(
      `INSERT INTO users (full_name, email, phone, country, password_hash, role, preferred_currency, is_wallet_linked)
       VALUES ($1, $2, $3, $4, $5, $6, 'USD', false)
       RETURNING id, full_name, email, phone, country, role, preferred_currency, created_at`,
      [full_name, email, phone || null, country || null, passwordHash, role || 'user']
    );
    const newUser = result.rows[0];
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
    await logAdminAudit({
      adminId: req.userId,
      action: 'create_user',
      targetUserId: newUser.id,
      details: { full_name, email, phone, country, role },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });
    res.status(201).json({ success: true, user: newUser });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Failed to create user' });
  } finally {
    client.release();
  }
});

router.get('/transactions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*,
              s.full_name as sender_name, s.email as sender_email,
              r.full_name as receiver_name, r.email as receiver_email
       FROM transactions t
       LEFT JOIN users s ON s.id = t.sender_id
       LEFT JOIN users r ON r.id = t.receiver_id
       ORDER BY t.created_at DESC
       LIMIT 300`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

router.put('/transactions/:id', async (req, res) => {
  const { id } = req.params;
  const { type, status, amount, currency, description } = req.body;

  try {
    const fields = [];
    const values = [];
    let idx = 1;

    if (type !== undefined) { fields.push(`type = $${idx++}`); values.push(type); }
    if (status !== undefined) { fields.push(`status = $${idx++}`); values.push(status); }
    if (amount !== undefined) { fields.push(`amount = $${idx++}`); values.push(Number(amount)); }
    if (currency !== undefined) { fields.push(`currency = $${idx++}`); values.push(currency); }
    if (description !== undefined) { fields.push(`description = $${idx++}`); values.push(description); }

    if (amount !== undefined || currency !== undefined) {
      const cur = await pool.query('SELECT amount, currency FROM transactions WHERE id = $1', [id]);
      if (cur.rows.length) {
        const a = amount !== undefined ? Number(amount) : Number(cur.rows[0].amount);
        const c = currency !== undefined ? currency : cur.rows[0].currency;
        const rates = await getUsdRates();
        fields.push(`amount_usd = $${idx++}`);
        values.push(toUsd(a, c, rates));
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const result = await pool.query(
      `UPDATE transactions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const txRow = result.rows[0];
    await logAdminAudit({
      adminId: req.userId,
      action: 'update_transaction',
      targetUserId: txRow.receiver_id || txRow.sender_id || null,
      details: { tx_id: id, ...req.body, before: { status: txRow.status, amount: txRow.amount, currency: txRow.currency } },
      ip: clientIp(req),
      userAgent: clientUa(req)
    });

    res.json({ success: true, transaction: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update transaction' });
  }
});

router.post('/transactions', async (req, res) => {
  const { user_id, type, status, amount, currency, description } = req.body;
  if (!user_id || !type || !amount || !currency) {
    return res.status(400).json({ error: 'user_id, type, amount, currency required' });
  }

  try {
    let senderId = null;
    let receiverId = null;

    if (['receive', 'deposit'].includes(type)) {
      receiverId = user_id;
    } else if (['send', 'withdrawal'].includes(type)) {
      senderId = user_id;
    } else {
      receiverId = user_id;
    }

    const rates = await getUsdRates();
    const amountUsd = toUsd(Number(amount), currency, rates);

    const result = await pool.query(
      `INSERT INTO transactions
         (sender_id, receiver_id, type, status, amount, amount_usd, currency, description, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
       RETURNING *`,
      [senderId, receiverId, type, status || 'completed', Number(amount), amountUsd, currency, description || null]
    );

    await logAdminAudit({
      adminId: req.userId,
      action: 'create_transaction',
      targetUserId: user_id,
      details: req.body,
      ip: clientIp(req),
      userAgent: clientUa(req)
    });

    res.status(201).json({ success: true, transaction: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

router.get('/audit', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.id, a.admin_id, a.action, a.target_user_id, a.details, a.created_at,
              u.full_name as admin_name,
              t.full_name as target_user_name
       FROM admin_audit_logs a
       LEFT JOIN users u ON u.id = a.admin_id
       LEFT JOIN users t ON t.id = a.target_user_id
       ORDER BY a.created_at DESC
       LIMIT 300`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch audit logs' });
  }
});


router.get('/user-audits', async (req, res) => {
  try {
    const userIdRaw = req.query.user_id || req.query.userId || null;
    const qRaw = (req.query.q || req.query.search || req.query.email || '').toString().trim();
    const params = [];
    const filters = [];

    if (userIdRaw && String(userIdRaw).match(/^\d+$/)) {
      params.push(Number(userIdRaw));
      filters.push(`ua.user_id = $${params.length}`);
    } else if (userIdRaw) {
      params.push('%' + String(userIdRaw).toLowerCase() + '%');
      filters.push(`(LOWER(COALESCE(u.email,'')) LIKE $${params.length} OR LOWER(COALESCE(u.full_name,'')) LIKE $${params.length})`);
    }

    if (qRaw) {
      if (qRaw.match(/^\d+$/)) {
        params.push(Number(qRaw));
        filters.push(`ua.user_id = $${params.length}`);
      } else {
        params.push('%' + qRaw.toLowerCase() + '%');
        filters.push(`(LOWER(COALESCE(u.email,'')) LIKE $${params.length} OR LOWER(COALESCE(u.full_name,'')) LIKE $${params.length})`);
      }
    }

    const where = filters.length ? ('WHERE ' + filters.join(' AND ')) : '';
    const sql =
      `SELECT ua.id, ua.user_id, ua.actor_id, ua.action, ua.details, ua.ip::text AS ip, ua.created_at,
              u.full_name as user_name, u.email as user_email,
              a.full_name as actor_name
       FROM user_audits ua
       LEFT JOIN users u ON u.id = ua.user_id
       LEFT JOIN users a ON a.id = ua.actor_id
       ` + where + `
       ORDER BY ua.created_at DESC
       LIMIT 500`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch user audits' });
  }
});

router.get('/cards/pending', async (req, res) => {
  try {
    let result;
    try {
      result = await pool.query(
        `SELECT c.*, u.full_name as user_name, u.email as user_email
         FROM cards c
         LEFT JOIN users u ON u.id = c.user_id
         WHERE c.status = 'pending'
         ORDER BY COALESCE(c.requested_at, c.created_at) DESC
         LIMIT 300`
      );
    } catch (sqlErr) {
      console.warn('pending cards COALESCE(requested_at) failed, fallback:', sqlErr.message);
      result = await pool.query(
        `SELECT c.*, u.full_name as user_name, u.email as user_email
         FROM cards c
         LEFT JOIN users u ON u.id = c.user_id
         WHERE c.status = 'pending'
         ORDER BY c.created_at DESC
         LIMIT 300`
      );
    }
    res.json(result.rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      status: row.status,
      tier: row.tier,
      fee_amount: Number(row.fee_amount || 0),
      fee_paid: !!row.fee_paid,
      pay_currency: row.pay_currency,
      cardholder_name: row.cardholder_name,
      requested_at: row.requested_at || row.created_at,
      created_at: row.created_at,
      user_name: row.user_name,
      user_email: row.user_email
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list pending cards: ' + (err.message || 'server error') });
  }
});

module.exports = router;
