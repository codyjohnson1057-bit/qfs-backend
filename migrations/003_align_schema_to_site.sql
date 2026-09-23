-- 003_align_schema_to_site.sql
-- Align Neon with QFS frontend: lowercase wallet keys, full asset set,
-- strengthen cards/payments/vaults/swaps/transactions to match API contracts.

-- ========== 1) Normalize wallet currency keys to lowercase (merge duplicates) ==========
DO $$
DECLARE
  r RECORD;
  lid INTEGER;
BEGIN
  FOR r IN
    SELECT id, user_id, currency, balance
    FROM wallets
    WHERE currency <> LOWER(currency)
  LOOP
    SELECT id INTO lid
    FROM wallets
    WHERE user_id = r.user_id
      AND currency = LOWER(r.currency)
      AND id <> r.id
    LIMIT 1;

    IF lid IS NOT NULL THEN
      UPDATE wallets
      SET balance = COALESCE(balance, 0) + COALESCE(r.balance, 0)
      WHERE id = lid;
      DELETE FROM wallets WHERE id = r.id;
    ELSE
      UPDATE wallets SET currency = LOWER(currency) WHERE id = r.id;
    END IF;
  END LOOP;
END $$;

-- ========== 2) Normalize related currency columns ==========
UPDATE transactions SET currency = LOWER(currency) WHERE currency <> LOWER(currency);
UPDATE deposit_addresses SET currency = LOWER(currency) WHERE currency <> LOWER(currency);
UPDATE swaps SET from_currency = LOWER(from_currency) WHERE from_currency <> LOWER(from_currency);
UPDATE swaps SET to_currency = LOWER(to_currency) WHERE to_currency <> LOWER(to_currency);
UPDATE payments SET currency = UPPER(currency) WHERE currency IS NOT NULL;
-- payments.currency is fiat (USD) — keep uppercase ISO; undo lower if any slipped
UPDATE payments SET currency = 'USD' WHERE currency IS NULL OR TRIM(currency) = '';

-- ========== 3) Ensure one clean unique on wallets(user_id, currency) ==========
-- Drop duplicate UNIQUE constraint if present; keep/create wallets_user_currency_unique
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'wallets_user_id_currency_key' AND conrelid = 'public.wallets'::regclass
  ) THEN
    ALTER TABLE wallets DROP CONSTRAINT wallets_user_id_currency_key;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS wallets_user_currency_unique ON wallets (user_id, currency);

-- ========== 4) Seed every active user with full dashboard asset set (lowercase) ==========
-- Matches frontend DASHBOARD_ASSETS / src/services/wallets.js DEFAULT_CURRENCIES
INSERT INTO wallets (user_id, currency, balance)
SELECT u.id, c.currency, 0
FROM users u
CROSS JOIN (VALUES
  ('qfs'), ('btc'), ('eth'), ('usdt'), ('tron'), ('bnb'), ('xrp'), ('xlm'),
  ('voo'), ('vti'), ('vxus'), ('bnd'), ('qqq'), ('schd'), ('vt'), ('vea'), ('vwo'), ('agg'), ('spy'), ('ivv'),
  ('vas'), ('vgs'), ('a200'), ('vcn'), ('xic'), ('veqt'),
  ('gold'), ('silver'), ('platinum'), ('palladium'), ('nickel'), ('tin'), ('bronze'), ('copper'), ('aluminum')
) AS c(currency)
WHERE u.deleted_at IS NULL
ON CONFLICT (user_id, currency) DO NOTHING;

-- ========== 5) Strengthen payments for SuperRight / support queue ==========
ALTER TABLE payments ADD COLUMN IF NOT EXISTS admin_note text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reviewed_by integer REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

-- ========== 6) Strengthen cards ==========
ALTER TABLE cards ADD COLUMN IF NOT EXISTS activated_at timestamptz;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS activated_by integer REFERENCES users(id);
-- Ensure fee default stays $350
ALTER TABLE cards ALTER COLUMN fee_amount SET DEFAULT 350;

-- ========== 7) Strengthen vaults ==========
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
ALTER TABLE vaults ADD COLUMN IF NOT EXISTS description text;

-- ========== 8) Strengthen swaps (audit-friendly) ==========
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed';
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS rate_usd numeric;
ALTER TABLE swaps ADD COLUMN IF NOT EXISTS note text;

-- ========== 9) Useful indexes for site queries ==========
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_currency ON wallets(currency);
CREATE INDEX IF NOT EXISTS idx_transactions_sender ON transactions(sender_id);
CREATE INDEX IF NOT EXISTS idx_transactions_receiver ON transactions(receiver_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role) WHERE deleted_at IS NULL;

-- ========== 10) Users: ensure pin + preferred_currency defaults match site ==========
ALTER TABLE users ALTER COLUMN pin SET DEFAULT '0000';
ALTER TABLE users ALTER COLUMN preferred_currency SET DEFAULT 'USD';
UPDATE users SET pin = '0000' WHERE pin IS NULL OR TRIM(pin) = '';
UPDATE users SET preferred_currency = 'USD' WHERE preferred_currency IS NULL OR TRIM(preferred_currency) = '';
