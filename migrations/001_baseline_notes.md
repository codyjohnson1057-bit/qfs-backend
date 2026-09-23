# Migration 001 — Baseline notes

This project was bootstrapped against the live Neon schema (dump: `/workspace/Qfs/neon-schema-dump.sql`, generated 2026-09-22).

## Existing tables (do not recreate)

- `users` — auth + profile (`pin`, `is_verified`, `preferred_currency`, `is_wallet_linked`, soft-delete `deleted_at`, …)
- `wallets` — `(user_id, currency)` unique; balances `numeric(20,8)`. **Legacy rows may use UPPERCASE currency keys**; new inserts use lowercase.
- `transactions` — `tx_id` uuid, `amount_usd`, types include send/receive/deposit/withdrawal/admin_adjust/swap
- `notifications`, `kyc_submissions`, `user_seeds`, `deposit_addresses`
- `admin_audit_logs`, `audit_logs`

## Applying on a fresh Neon project

1. Create a Neon project and copy the connection string into `.env` as `DATABASE_URL` (with `?sslmode=require`).
2. Apply the baseline DDL from `neon-schema-dump.sql` (or restore a backup).
3. Run `npm run migrate` to apply `002_cards_payments_vaults_swaps.sql` (idempotent `IF NOT EXISTS`).

## Wallet currency policy

- **Write (register / admin-create):** lowercase keys matching frontend `DASHBOARD_ASSETS` (crypto + ETFs + metals).
- **Read:** normalize to lowercase; case-insensitive lookup for balance adjust / swap.
