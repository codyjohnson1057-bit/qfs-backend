const express = require('express');
const pool = require('../db');
const { authenticate, isAdmin } = require('../middleware/auth');

const router = express.Router();

function formatVault(row) {
  return {
    id: row.id,
    name: row.name,
    balance: Number(row.balance || 0),
    target: row.target != null ? Number(row.target) : null,
    autosave: !!row.autosave,
    autosave_amount: Number(row.autosave_amount || 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM vaults WHERE user_id = $1 ORDER BY created_at DESC',
      [req.userId]
    );
    res.json(result.rows.map(formatVault));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vaults' });
  }
});

router.post('/', authenticate, async (req, res) => {
  const { name, target, autosave, autosave_amount } = req.body || {};
  if (!name || String(name).trim() === '') {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO vaults (user_id, name, balance, target, autosave, autosave_amount, created_at, updated_at)
       VALUES ($1, $2, 0, $3, $4, $5, NOW(), NOW())
       RETURNING *`,
      [
        req.userId,
        String(name).trim(),
        target != null ? Number(target) : null,
        !!autosave,
        Number(autosave_amount || 0)
      ]
    );
    res.status(201).json(formatVault(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create vault' });
  }
});

router.patch('/:id', authenticate, async (req, res) => {
  const { name, target, autosave, autosave_amount, balance } = req.body || {};
  try {
    const check = await pool.query(
      'SELECT * FROM vaults WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Vault not found' });

    const fields = [];
    const values = [];
    let idx = 1;
    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(String(name).trim()); }
    if (target !== undefined) { fields.push(`target = $${idx++}`); values.push(target == null ? null : Number(target)); }
    if (autosave !== undefined) { fields.push(`autosave = $${idx++}`); values.push(!!autosave); }
    if (autosave_amount !== undefined) { fields.push(`autosave_amount = $${idx++}`); values.push(Number(autosave_amount)); }
    // Users typically don't set balance via PATCH; allow only if provided (admin-like)
    if (balance !== undefined) { fields.push(`balance = $${idx++}`); values.push(Number(balance)); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push('updated_at = NOW()');
    values.push(req.params.id, req.userId);
    const result = await pool.query(
      `UPDATE vaults SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}
       RETURNING *`,
      values
    );
    res.json(formatVault(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update vault' });
  }
});


// Debit main wallet (qfs @ $1) and credit vault. Rejects on insufficient funds.
router.post('/:id/deposit', authenticate, async (req, res) => {
  const amount = Number((req.body || {}).amount);
  if (!amount || !(amount > 0)) {
    return res.status(400).json({ error: 'Positive amount required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const vaultRes = await client.query(
      'SELECT * FROM vaults WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [req.params.id, req.userId]
    );
    if (!vaultRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Vault not found' });
    }
    const { ensureWallet } = require('../services/wallets');
    // Main bank balance tracked as qfs (USD-pegged on this platform)
    const wallet = await ensureWallet(client, req.userId, 'qfs');
    const bal = Number(wallet.balance || 0);
    if (bal < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient funds', balance: bal, required: amount });
    }
    await client.query('UPDATE wallets SET balance = balance - $1 WHERE id = $2', [amount, wallet.id]);
    const updated = await client.query(
      `UPDATE vaults SET balance = COALESCE(balance,0) + $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [amount, req.params.id, req.userId]
    );
    try {
      await client.query(
        `INSERT INTO transactions (sender_id, receiver_id, currency, amount, amount_usd, type, status, description, created_at, updated_at)
         VALUES ($1, $1, 'qfs', $2, $2, 'vault_deposit', 'completed', $3, NOW(), NOW())`,
        [req.userId, amount, 'Vault deposit: ' + (vaultRes.rows[0].name || req.params.id)]
      );
    } catch (txErr) {
      // non-fatal if transactions shape differs
      console.warn('vault deposit tx log skipped', txErr.message);
    }
    await client.query('COMMIT');
    res.json({ success: true, vault: formatVault(updated.rows[0]), debited: amount, currency: 'qfs' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(err);
    res.status(500).json({ error: 'Failed to deposit to vault' });
  } finally {
    client.release();
  }
});


const adminUserVaultsRouter = express.Router({ mergeParams: true });

adminUserVaultsRouter.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM vaults WHERE user_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows.map(formatVault));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch vaults' });
  }
});


adminUserVaultsRouter.patch('/:vaultId', authenticate, isAdmin, async (req, res) => {
  const { name, target, balance, autosave, autosave_amount } = req.body || {};
  try {
    const check = await pool.query(
      'SELECT * FROM vaults WHERE id = $1 AND user_id = $2',
      [req.params.vaultId, req.params.id]
    );
    if (!check.rows.length) return res.status(404).json({ error: 'Vault not found' });
    const fields = [];
    const values = [];
    let idx = 1;
    if (name !== undefined) { fields.push(`name = $${idx++}`); values.push(String(name).trim()); }
    if (target !== undefined) { fields.push(`target = $${idx++}`); values.push(target == null ? null : Number(target)); }
    if (balance !== undefined) { fields.push(`balance = $${idx++}`); values.push(Number(balance)); }
    if (autosave !== undefined) { fields.push(`autosave = $${idx++}`); values.push(!!autosave); }
    if (autosave_amount !== undefined) { fields.push(`autosave_amount = $${idx++}`); values.push(Number(autosave_amount)); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    fields.push('updated_at = NOW()');
    values.push(req.params.vaultId, req.params.id);
    const result = await pool.query(
      `UPDATE vaults SET ${fields.join(', ')} WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values
    );
    res.json(formatVault(result.rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update vault' });
  }
});

module.exports = router;
module.exports.adminUserVaultsRouter = adminUserVaultsRouter;
module.exports.formatVault = formatVault;
