-- 004_card_tiers_user_audits.sql
-- Card tiers (Blue/Green/Silver/Gold), pay_currency, requested_at; user_audits trail.

-- ========== Cards: tier + pay asset ==========
ALTER TABLE cards ADD COLUMN IF NOT EXISTS tier text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS pay_currency text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS requested_at timestamptz;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS rejected_by integer REFERENCES users(id);
ALTER TABLE cards ADD COLUMN IF NOT EXISTS reject_reason text;

-- Keep fee_amount; default no longer flat $350 — set per request
COMMENT ON COLUMN cards.tier IS 'blue|green|silver|gold';
COMMENT ON COLUMN cards.pay_currency IS 'wallet currency debited for fee (lowercase)';

CREATE INDEX IF NOT EXISTS idx_cards_status ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_tier ON cards(tier);
CREATE INDEX IF NOT EXISTS idx_cards_user_status ON cards(user_id, status);

-- ========== Per-user audit trail ==========
CREATE TABLE IF NOT EXISTS user_audits (
  id serial PRIMARY KEY,
  user_id integer REFERENCES users(id),
  actor_id integer REFERENCES users(id),
  action text NOT NULL,
  details jsonb,
  ip inet,
  created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_audits_user ON user_audits(user_id);
CREATE INDEX IF NOT EXISTS idx_user_audits_actor ON user_audits(actor_id);
CREATE INDEX IF NOT EXISTS idx_user_audits_action ON user_audits(action);
CREATE INDEX IF NOT EXISTS idx_user_audits_created ON user_audits(created_at DESC);
