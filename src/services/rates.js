/**
 * Asset USD rates (crypto/ETF/metal) + fiat FX (USD → currency).
 * Fiat: open.er-api.com primary, frankfurter.app fallback, then FALLBACK_FIAT.
 */
const FALLBACK_USD = {
  QFS: 1, BTC: 95000, ETH: 3500, USDT: 1, TRON: 0.25, TRX: 0.25,
  BNB: 650, XRP: 2.2, XLM: 0.4, USD: 1
};

const ETF_FALLBACK = {
  VOO: 520, VTI: 290, VXUS: 65, BND: 73, QQQ: 490, SCHD: 28,
  VT: 120, VEA: 52, VWO: 45, AGG: 98, SPY: 570, IVV: 570,
  VAS: 100, VGS: 130, A200: 135, VCN: 50, XIC: 35, VEQT: 40
};

const METAL_FALLBACK = {
  GOLD: 2650, SILVER: 31, PLATINUM: 980, PALLADIUM: 1000,
  NICKEL: 7.5, TIN: 14.0, BRONZE: 4.5, COPPER: 4.2, ALUMINUM: 1.1
};

/** USD → fiat units (approx; updated by live FX when available). */
const FALLBACK_FIAT = {
  USD: 1, EUR: 0.92, GBP: 0.79, NGN: 1600, CAD: 1.36, AUD: 1.53,
  JPY: 150, CHF: 0.88, CNY: 7.25, INR: 83.5, ZAR: 18.2, GHS: 15.5,
  KES: 129, AED: 3.67, SAR: 3.75, BRL: 5.4, MXN: 18.2, TRY: 34,
  RUB: 92, SGD: 1.35, NZD: 1.65, HKD: 7.8, SEK: 10.5, NOK: 10.6,
  DKK: 6.9, PLN: 3.9, PHP: 58, THB: 35, MYR: 4.5, IDR: 16000,
  EGP: 48, PKR: 278
};

let fiatCache = { rates: { ...FALLBACK_FIAT }, fetchedAt: 0, source: 'fallback' };
const FIAT_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getUsdRates() {
  const base = { ...FALLBACK_USD, ...ETF_FALLBACK, ...METAL_FALLBACK };
  try {
    const cgRes = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tether,tron,binancecoin,ripple,stellar&vs_currencies=usd'
    );

    if (!cgRes.ok) throw new Error('CoinGecko rate fail');
    const p = await cgRes.json();

    return {
      ...base,
      QFS: 1,
      BTC: p.bitcoin?.usd || FALLBACK_USD.BTC,
      ETH: p.ethereum?.usd || FALLBACK_USD.ETH,
      USDT: p.tether?.usd || 1,
      TRON: p.tron?.usd || FALLBACK_USD.TRON,
      TRX: p.tron?.usd || FALLBACK_USD.TRON,
      BNB: p.binancecoin?.usd || FALLBACK_USD.BNB,
      XRP: p.ripple?.usd || FALLBACK_USD.XRP,
      XLM: p.stellar?.usd || FALLBACK_USD.XLM,
      USD: 1
    };
  } catch {
    return { ...base, QFS: 1 };
  }
}

function lookupRate(currency, rates) {
  const c = (currency || 'USD').toUpperCase();
  const lower = c.toLowerCase();
  return (
    rates?.[c] ??
    rates?.[lower] ??
    FALLBACK_USD[c] ??
    ETF_FALLBACK[c] ??
    METAL_FALLBACK[c] ??
    0
  );
}

function toUsd(amount, currency, rates) {
  return Number(amount || 0) * lookupRate(currency, rates);
}

function fromUsd(usdAmount, currency, rates) {
  const rate = lookupRate(currency, rates);
  if (!rate || rate <= 0) return 0;
  return Number(usdAmount || 0) / rate;
}

async function fetchFiatFromOpenEr() {
  const res = await fetch('https://open.er-api.com/v6/latest/USD');
  if (!res.ok) throw new Error('open.er-api HTTP ' + res.status);
  const data = await res.json();
  if (!data || data.result !== 'success' || !data.rates) throw new Error('open.er-api bad body');
  const rates = { USD: 1 };
  for (const [k, v] of Object.entries(data.rates)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) rates[k.toUpperCase()] = n;
  }
  return { rates, source: 'open.er-api.com' };
}

async function fetchFiatFromFrankfurter() {
  const res = await fetch('https://api.frankfurter.app/latest?from=USD');
  if (!res.ok) throw new Error('frankfurter HTTP ' + res.status);
  const data = await res.json();
  if (!data || !data.rates) throw new Error('frankfurter bad body');
  const rates = { USD: 1 };
  for (const [k, v] of Object.entries(data.rates)) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) rates[k.toUpperCase()] = n;
  }
  // Frankfurter lacks NGN etc. — merge fallback for missing
  for (const [k, v] of Object.entries(FALLBACK_FIAT)) {
    if (rates[k] == null) rates[k] = v;
  }
  return { rates, source: 'frankfurter.app' };
}

async function getFiatRates(force = false) {
  const now = Date.now();
  if (!force && fiatCache.fetchedAt && now - fiatCache.fetchedAt < FIAT_TTL_MS) {
    return {
      rates: fiatCache.rates,
      source: fiatCache.source,
      fetchedAt: fiatCache.fetchedAt,
      cached: true
    };
  }
  try {
    const live = await fetchFiatFromOpenEr();
    fiatCache = { rates: { ...FALLBACK_FIAT, ...live.rates }, fetchedAt: now, source: live.source };
  } catch (e1) {
    try {
      const live = await fetchFiatFromFrankfurter();
      fiatCache = { rates: { ...FALLBACK_FIAT, ...live.rates }, fetchedAt: now, source: live.source };
    } catch (e2) {
      console.warn('fiat FX fallback:', e1.message, e2.message);
      if (!fiatCache.fetchedAt) {
        fiatCache = { rates: { ...FALLBACK_FIAT }, fetchedAt: now, source: 'fallback' };
      }
    }
  }
  return {
    rates: fiatCache.rates,
    source: fiatCache.source,
    fetchedAt: fiatCache.fetchedAt,
    cached: false
  };
}

function usdToFiat(usdAmount, currency, fiatRates) {
  const c = String(currency || 'USD').toUpperCase();
  const rate = (fiatRates && (fiatRates[c] ?? fiatRates[c.toLowerCase()])) || FALLBACK_FIAT[c] || 1;
  return Number(usdAmount || 0) * Number(rate);
}

module.exports = {
  FALLBACK_USD,
  ETF_FALLBACK,
  METAL_FALLBACK,
  FALLBACK_FIAT,
  getUsdRates,
  toUsd,
  fromUsd,
  getFiatRates,
  usdToFiat
};
