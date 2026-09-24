const express = require('express');
const pool = require('../db');
const { authenticate, isAdmin } = require('../middleware/auth');
const { getUsdRates, fromUsd } = require('../services/rates');
const { normalizeCurrencyKey, ensureWallet } = require('../services/wallets');
const { logUserAudit, clientIp, safeCommit } = require('../services/audits');

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

// Debit chosen wallet by USD-equivalent and credit vault balance (USD terms).
router.post('/:id/deposit', authenticate, async (req, res) => {
  const body = req.body || {};
  const amountUsd = Number(body.amount);
  const currencyKey = normalizeCurrencyKey(body.currency || body.from || 'qfs') || 'qfs';

  if (!amountUsd || !(amountUsd > 0) || Number.isNaN(amountUsd)) {
    return res.status(400).json({ error: 'Positive amount (USD) required' });
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

    const rates = await getUsdRates();
    const debitUnits = fromUsd(amountUsd, currencyKey, rates);
    if (!debitUnits || debitUnits <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Unable to price asset "${currencyKey}" for vault deposit`
      });
    }

    const wallet = await ensureWallet(client, req.userId, currencyKey);
    const bal = Number(wallet.balance || 0);
    if (bal + 1e-12 < debitUnits) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient funds in ${currencyKey.toUpperCase()}: have ${bal}, need ${debitUnits} (~$${amountUsd} USD)`,
        balance: bal,
        required: debitUnits,
        required_usd: amountUsd,
        currency: currencyKey
      });
    }

    await client.query('UPDATE wallets SET balance = balance - $1 WHERE id = $2', [
      debitUnits,
      wallet.id
    ]);
    const updated = await client.query(
      `UPDATE vaults SET balance = COALESCE(balance,0) + $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3 RETURNING *`,
      [amountUsd, req.params.id, req.userId]
    );

    const vaultName = vaultRes.rows[0].name || req.params.id;
    await client.query('SAVEPOINT vault_dep_tx');
    try {
      await client.query(
        `INSERT INTO transactions (sender_id, receiver_id, currency, amount, amount_usd, type, status, description, created_at, updated_at)
         VALUES ($1, $1, $2, $3, $4, 'vault_deposit', 'completed', $5, NOW(), NOW())`,
        [
          req.userId,
          currencyKey,
          debitUnits,
          amountUsd,
          `Vault deposit: ${vaultName} (${currencyKey.toUpperCase()} → $${amountUsd})`
        ]
      );
      await client.query('RELEASE SAVEPOINT vault_dep_tx');
    } catch (txErr) {
      await client.query('ROLLBACK TO SAVEPOINT vault_dep_tx');
      console.warn('vault deposit tx log skipped', txErr.message);
    }

    await safeCommit(client);
    await logUserAudit({
      userId: req.userId,
      actorId: req.userId,
      action: 'vault_deposit',
      details: {
        vault_id: Number(req.params.id),
        vault_name: vaultName,
        amount_usd: amountUsd,
        currency: currencyKey,
        debited: debitUnits
      },
      ip: clientIp(req)
    });
    res.json({
      success: true,
      vault: formatVault(updated.rows[0]),
      debited: debitUnits,
      amount_usd: amountUsd,
      currency: currencyKey
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(err);
    res.status(500).json({ error: 'Failed to deposit to vault: ' + (err.message || 'server error') });
  } finally {
    client.release();
  }
});


// Delete vault. Refunds remaining USD balance into the user's QFS wallet (QFS=$1).
router.delete('/:id', authenticate, async (req, res) => {
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
    const vault = vaultRes.rows[0];
    const balUsd = Number(vault.balance || 0);
    let refunded = 0;

    if (balUsd > 0) {
      // Vault balances are stored in USD terms; credit QFS 1:1
      const wallet = await ensureWallet(client, req.userId, 'qfs');
      await client.query('UPDATE wallets SET balance = COALESCE(balance,0) + $1 WHERE id = $2', [
        balUsd,
        wallet.id
      ]);
      refunded = balUsd;
      await client.query('SAVEPOINT vault_del_tx');
      try {
        await client.query(
          `INSERT INTO transactions (sender_id, receiver_id, currency, amount, amount_usd, type, status, description, created_at, updated_at)
           VALUES ($1, $1, 'qfs', $2, $3, 'vault_withdraw', 'completed', $4, NOW(), NOW())`,
          [
            req.userId,
            balUsd,
            balUsd,
            `Vault deleted — refund: ${vault.name || req.params.id}`
          ]
        );
        await client.query('RELEASE SAVEPOINT vault_del_tx');
      } catch (txErr) {
        await client.query('ROLLBACK TO SAVEPOINT vault_del_tx');
        console.warn('vault delete tx log skipped', txErr.message);
      }
    }

    await client.query('DELETE FROM vaults WHERE id = $1 AND user_id = $2', [
      req.params.id,
      req.userId
    ]);
    await safeCommit(client);
    await logUserAudit({
      userId: req.userId,
      actorId: req.userId,
      action: 'vault_delete',
      details: {
        vault_id: Number(req.params.id),
        vault_name: vault.name,
        refunded_usd: refunded,
        refund_currency: 'qfs'
      },
      ip: clientIp(req)
    });
    res.json({ success: true, refunded_usd: refunded, currency: 'qfs' });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error(err);
    res.status(500).json({ error: 'Failed to delete vault: ' + (err.message || 'server error') });
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
