# rat-backend (Robinhood Alliance / QFS)

Express + Postgres (Neon) API used by the Railway-hosted frontend.

## Quick start

```bash
cp .env.example .env
# fill DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
npm install
npm run migrate
npm start
```

Health check: `GET /api/health`

## Environment

| Variable | Purpose |
|----------|---------|
| `PORT` | Listen port (default `5000`) |
| `DATABASE_URL` | Neon/Postgres URL (`?sslmode=require`) |
| `JWT_SECRET` | Bearer JWT signing |
| `ENCRYPTION_KEY` | 64-hex AES key for seed phrases |

**Never commit `.env`.** See `.env.example` for placeholders only.

## Migrations

SQL files live in `migrations/` (numeric order). Runner:

```bash
npm run migrate
```

- Uses `DATABASE_URL` with SSL.
- Records applied files in `schema_migrations`.
- `002_cards_payments_vaults_swaps.sql` is idempotent (`IF NOT EXISTS`).

Baseline tables are documented in `migrations/001_baseline_notes.md` .

## Layout

```
server.js                 # listen + CORS + mount routes
src/db.js
src/middleware/auth.js
src/services/rates.js     # toUsd / getUsdRates (+ ETF/metal placeholders)
src/services/wallets.js   # default lowercase assets, case-insensitive lookup
src/routes/*.js           # auth, user, wallets, transactions, notifications, kyc,
                          # admin, cards, payments, vaults, swap
migrations/
scripts/migrate.js
```

## Deploy (Railway)

1. Set the same env vars in the Railway service.
2. Release command or one-off: `npm run migrate` (after baseline exists).
3. Start: `npm start` (`node server.js`).
4. Do **not** push secrets; keep `.env` local / in the host secret store.

## Wallet currencies

New users get lowercase dashboard assets (crypto + common ETFs + metals).  
`GET /api/wallets` normalizes keys to lowercase. Balance/swap lookups accept legacy uppercase rows.

## Swap rates

Crypto prices prefer CoinGecko + GeckoTerminal (QFS). ETF/metal rates use documented placeholders in `src/services/rates.js` when live feeds are unavailable.
