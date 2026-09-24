/** Card tier fees (USD) and max daily spend limits (USD). */
const CARD_TIERS = {
  blue: { key: 'blue', label: 'Blue', fee: 500, dailyLimit: 2000 },
  green: { key: 'green', label: 'Green', fee: 850, dailyLimit: 5000 },
  silver: { key: 'silver', label: 'Silver', fee: 1500, dailyLimit: 10000 },
  gold: { key: 'gold', label: 'Gold', fee: 3000, dailyLimit: 50000 }
};

function resolveTier(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return CARD_TIERS[k] || null;
}

function tierDailyMax(raw) {
  const t = resolveTier(raw);
  return t ? t.dailyLimit : 2000;
}

/** Clamp a requested daily limit to (0, tierMax]. */
function clampDailyLimit(tier, requested) {
  const max = tierDailyMax(tier);
  const n = Number(requested);
  if (!Number.isFinite(n) || n <= 0) return max;
  return Math.min(n, max);
}

module.exports = { CARD_TIERS, resolveTier, tierDailyMax, clampDailyLimit };
