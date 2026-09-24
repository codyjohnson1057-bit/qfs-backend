-- 006_card_tier_daily_limits.sql
-- Set daily_limit from tier max (Blue 2000, Green 5000, Silver 10000, Gold 50000).
-- Additive / safe: only updates cards whose limit is NULL, 0, 2500 (legacy default),
-- or above the new tier max (clamp down). Leaves intentional mid-range values alone
-- when they are already within the tier cap.

UPDATE cards SET daily_limit = 2000
WHERE LOWER(COALESCE(tier, 'blue')) = 'blue'
  AND (daily_limit IS NULL OR daily_limit = 0 OR daily_limit = 2500 OR daily_limit > 2000);

UPDATE cards SET daily_limit = 5000
WHERE LOWER(tier) = 'green'
  AND (daily_limit IS NULL OR daily_limit = 0 OR daily_limit = 2500 OR daily_limit > 5000);

UPDATE cards SET daily_limit = 10000
WHERE LOWER(tier) = 'silver'
  AND (daily_limit IS NULL OR daily_limit = 0 OR daily_limit = 2500 OR daily_limit > 10000);

UPDATE cards SET daily_limit = 50000
WHERE LOWER(tier) = 'gold'
  AND (daily_limit IS NULL OR daily_limit = 0 OR daily_limit = 2500 OR daily_limit > 50000);

-- Untiered cards: treat as blue max
UPDATE cards SET daily_limit = 2000, tier = COALESCE(tier, 'blue')
WHERE tier IS NULL AND (daily_limit IS NULL OR daily_limit = 0 OR daily_limit = 2500 OR daily_limit > 2000);
