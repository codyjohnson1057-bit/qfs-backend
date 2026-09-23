/**
 * USD conversion rates for crypto / ETFs / metals.
 * Live crypto via CoinGecko + GeckoTerminal (QFS). ETF/metal use placeholders
 * when Yahoo/live feeds are unavailable — see FALLBACK_USD / ETF_FALLBACK / METAL_FALLBACK.
 */
const FALLBACK_USD = {
  QFS: 0.00001623, BTC: 95000, ETH: 3500, USDT: 1, TRON: 0.25, TRX: 0.25,
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

async function getUsdRates() {
  const base = { ...FALLBACK_USD, ...ETF_FALLBACK, ...METAL_FALLBACK };
  try {
    const [cgRes, gtRes] = await Promise.all([
      fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tether,tron,binancecoin,ripple,stellar&vs_currencies=usd'
      ),
      fetch(
        'https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/5rpEoZcrd5oJvEWcqHfzD8k4axJXhNW9fZ5putdsmoon'
      )
    ]);

    if (!cgRes.ok) throw new Error('CoinGecko rate fail');
    const p = await cgRes.json();

    let qfsPrice = FALLBACK_USD.QFS;
    if (gtRes.ok) {
      const gt = await gtRes.json();
      const priceStr =
        gt?.data?.attributes?.token_prices?.[
          '5rpEoZcrd5oJvEWcqHfzD8k4axJXhNW9fZ5putdsmoon'
        ];
      if (priceStr) qfsPrice = parseFloat(priceStr);
    }

    return {
      ...base,
      QFS: qfsPrice,
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
    return { ...base };
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

/** Units of `currency` needed for `usdAmount` USD notional. */
function fromUsd(usdAmount, currency, rates) {
  const rate = lookupRate(currency, rates);
  if (!rate || rate <= 0) return 0;
  return Number(usdAmount || 0) / rate;
}

module.exports = {
  FALLBACK_USD,
  ETF_FALLBACK,
  METAL_FALLBACK,
  getUsdRates,
  toUsd,
  fromUsd
};
