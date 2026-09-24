/**
 * Default wallet currencies (lowercase) matching frontend DASHBOARD_ASSETS.
 * Legacy rows may be uppercase — lookups are case-insensitive; reads normalize to lowercase.
 */
const DEFAULT_CURRENCIES = [
  'qfs', 'btc', 'eth', 'usdt', 'tron', 'bnb', 'xrp', 'xlm',
  'voo', 'vti', 'vxus', 'bnd', 'qqq', 'schd', 'vt', 'vea', 'vwo', 'agg', 'spy', 'ivv',
  'vas', 'vgs', 'a200', 'vcn', 'xic', 'veqt',
  'gold', 'silver', 'platinum', 'palladium', 'nickel', 'tin', 'bronze', 'copper', 'aluminum'
];

function normalizeCurrencyKey(currency) {
  let key = String(currency || '').trim().toLowerCase();
  // Frontend legacy select values used "btc_wallet" etc.
  if (key.endsWith('_wallet')) key = key.slice(0, -7);
  if (key === 'usdt_trc' || key === 'usdt-trc20' || key === 'usdt_trc20') key = 'usdt';
  return key;
}

function formatWalletRows(rows) {
  return (rows || []).map((r) => ({
    currency: normalizeCurrencyKey(r.currency),
    balance: r.balance
  }));
}

/** Insert default wallets (lowercase keys). Safe to call inside a transaction client. */
async function createDefaultWallets(client, userId) {
  for (const curr of DEFAULT_CURRENCIES) {
    await client.query(
      `INSERT INTO wallets (user_id, currency, balance) VALUES ($1, $2, 0)
       ON CONFLICT (user_id, currency) DO NOTHING`,
      [userId, curr]
    );
  }
}

/**
 * Find a wallet row for user + currency (case-insensitive).
 * Returns { id, currency, balance } or null. Optionally FOR UPDATE.
 */
async function findWallet(clientOrPool, userId, currency, { forUpdate = false } = {}) {
  const key = normalizeCurrencyKey(currency);
  const sql =
    `SELECT id, currency, balance FROM wallets
     WHERE user_id = $1 AND LOWER(currency) = $2` +
    (forUpdate ? ' FOR UPDATE' : '');
  const result = await clientOrPool.query(sql, [userId, key]);
  return result.rows[0] || null;
}

/**
 * Ensure a wallet exists for currency (stores lowercase). Returns the row.
 */
async function ensureWallet(client, userId, currency) {
  const key = normalizeCurrencyKey(currency);
  let row = await findWallet(client, userId, key, { forUpdate: true });
  if (row) return row;
  await client.query(
    `INSERT INTO wallets (user_id, currency, balance) VALUES ($1, $2, 0)
     ON CONFLICT (user_id, currency) DO NOTHING`,
    [userId, key]
  );
  row = await findWallet(client, userId, key, { forUpdate: true });
  return row;
}

module.exports = {
  DEFAULT_CURRENCIES,
  normalizeCurrencyKey,
  formatWalletRows,
  createDefaultWallets,
  findWallet,
  ensureWallet
};
