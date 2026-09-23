-- 002_cards_payments_vaults_swaps.sql
-- Idempotent schema strengthen for cards, payments, vaults, swaps
-- Safe to re-run (IF NOT EXISTS)

-- ========== cards ==========
CREATE TABLE IF NOT EXISTS cards (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending',
  cardholder_name text,
  number text,
  expiry text,
  cvv text,
  network text DEFAULT 'visa',
  daily_limit numeric DEFAULT 2500,
  online_enabled boolean DEFAULT true,
  frozen boolean DEFAULT false,
  fee_paid boolean DEFAULT false,
  fee_amount numeric DEFAULT 350,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT cards_status_check CHECK (status IN ('pending', 'active', 'frozen', 'deactivated'))
);

CREATE INDEX IF NOT EXISTS idx_cards_user_id ON cards(user_id);
CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);

-- ========== payments ==========
CREATE TABLE IF NOT EXISTS payments (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  code text NOT NULL,
  type text NOT NULL,
  amount numeric NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  note text,
  status text NOT NULL DEFAULT 'pending_support',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT payments_type_check CHECK (type IN ('ach', 'wire')),
  CONSTRAINT payments_status_check CHECK (status IN ('pending_support', 'completed', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS payments_code_unique ON payments(code);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ========== vaults ==========
CREATE TABLE IF NOT EXISTS vaults (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  name text NOT NULL,
  balance numeric DEFAULT 0,
  target numeric,
  autosave boolean DEFAULT false,
  autosave_amount numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vaults_user_id ON vaults(user_id);

-- ========== swaps ==========
CREATE TABLE IF NOT EXISTS swaps (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  from_currency text NOT NULL,
  to_currency text NOT NULL,
  amount_usd numeric NOT NULL,
  from_debited numeric NOT NULL,
  to_credited numeric NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_swaps_user_id ON swaps(user_id);
CREATE INDEX IF NOT EXISTS idx_swaps_created_at ON swaps(created_at DESC);

-- Schema bookkeeping (optional)
CREATE TABLE IF NOT EXISTS schema_migrations (
  id serial PRIMARY KEY,
  filename text NOT NULL UNIQUE,
  applied_at timestamptz DEFAULT now()
);
