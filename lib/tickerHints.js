// lib/tickerHints.js — the feed's spelling is not yours, and the feed does not say so.
//
// 2026-09-22: the sizer was asked for WTI and answered 10,298 shares of a $3.74 stock. WTI on the
// feed is W&T Offshore, an oil-and-gas producer; West Texas crude is CL=F. Nothing on the screen
// said which one it had resolved, so a number computed on the wrong instrument looked exactly like
// a number computed on the right one. Two fixes travel together: every place the feed answers for
// a symbol now shows the NAME it resolved (api/atr.js carries it), and the handful of tickers that
// people type meaning a commodity, an index or a coin — and that the feed treats as a listed
// security — are named here with what they actually are and what was probably meant.
//
// A map, not a guess: only tickers whose bare spelling is a REAL listed security on the feed, or a
// common word the feed has no quote for at all. Anything not listed gets no hint and the resolved
// name does the talking.
export const AMBIGUOUS = Object.freeze({
  WTI:   { resolves: 'W&T Offshore, an oil-and-gas producer (a stock)',
           meant: [{ sym: 'CL=F', what: 'WTI crude, front future' }, { sym: 'MCL=F', what: 'micro WTI future' }, { sym: 'USO', what: 'US Oil Fund ETF' }] },
  BRENT: { resolves: 'nothing — the feed has no quote for the word',
           meant: [{ sym: 'BZ=F', what: 'Brent crude, front future' }, { sym: 'BNO', what: 'Brent oil ETF' }] },
  OIL:   { resolves: 'nothing the feed prices as crude',
           meant: [{ sym: 'CL=F', what: 'WTI crude, front future' }, { sym: 'BZ=F', what: 'Brent, front future' }, { sym: 'USO', what: 'US Oil Fund ETF' }] },
  CL:    { resolves: 'Colgate-Palmolive (a stock)',
           meant: [{ sym: 'CL=F', what: 'WTI crude, front future' }, { sym: 'MCL=F', what: 'micro WTI future' }] },
  GOLD:  { resolves: 'Gold.com, Inc. (a stock — not the metal)',
           meant: [{ sym: 'GC=F', what: 'gold, front future' }, { sym: 'MGC=F', what: 'micro gold future' }, { sym: 'GLD', what: 'SPDR Gold ETF' }] },
  SILVER:{ resolves: 'nothing — the feed has no quote for the word',
           meant: [{ sym: 'SI=F', what: 'silver, front future' }, { sym: 'SLV', what: 'iShares Silver ETF' }] },
  COPPER:{ resolves: 'nothing — the feed has no quote for the word',
           meant: [{ sym: 'HG=F', what: 'copper, front future' }, { sym: 'CPER', what: 'US Copper Index ETF' }] },
  NATGAS:{ resolves: 'nothing — the feed has no quote for the word',
           meant: [{ sym: 'NG=F', what: 'Henry Hub natural gas, front future' }, { sym: 'UNG', what: 'US Natural Gas ETF' }] },
  NG:    { resolves: 'NovaGold Resources, a miner (a stock)',
           meant: [{ sym: 'NG=F', what: 'Henry Hub natural gas, front future' }] },
  ES:    { resolves: 'Eversource Energy, a utility (a stock)',
           meant: [{ sym: 'ES=F', what: 'S&P 500 e-mini future' }, { sym: 'MES=F', what: 'micro e-mini' }] },
  BTC:   { resolves: 'Grayscale Bitcoin Mini Trust (an ETF)',
           meant: [{ sym: 'BTC-USD', what: 'bitcoin spot' }, { sym: 'IBIT', what: 'iShares Bitcoin ETF' }, { sym: 'MBT=F', what: 'micro bitcoin future' }] },
  ETH:   { resolves: 'Grayscale Ethereum Mini Trust (an ETF)',
           meant: [{ sym: 'ETH-USD', what: 'ether spot' }, { sym: 'ETHA', what: 'iShares Ethereum ETF' }] },
  SOL:   { resolves: 'ReneSola, a solar company (a stock)',
           meant: [{ sym: 'SOL-USD', what: 'solana spot' }] },
  VIX:   { resolves: 'nothing — the index is spelled with a caret',
           meant: [{ sym: '^VIX', what: 'the VIX index' }, { sym: 'VIXY', what: 'short-term VIX futures ETF' }] },
  SPX:   { resolves: 'nothing — the index is spelled with a caret',
           meant: [{ sym: '^GSPC', what: 'the S&P 500 index' }, { sym: 'SPY', what: 'S&P 500 ETF' }, { sym: 'ES=F', what: 'e-mini future' }] },
  NDX:   { resolves: 'nothing — the index is spelled with a caret',
           meant: [{ sym: '^NDX', what: 'the Nasdaq-100 index' }, { sym: 'QQQ', what: 'Nasdaq-100 ETF' }, { sym: 'NQ=F', what: 'e-mini future' }] },
  DXY:   { resolves: 'nothing — the dollar index has its own code',
           meant: [{ sym: 'DX-Y.NYB', what: 'the ICE dollar index' }, { sym: 'UUP', what: 'dollar bullish ETF' }] },
  HSI:   { resolves: 'nothing — the index is spelled with a caret',
           meant: [{ sym: '^HSI', what: 'the Hang Seng index' }, { sym: '2800.HK', what: 'Tracker Fund of Hong Kong' }] },
});

export function tickerHint(symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  const a = AMBIGUOUS[s];
  if (!a) return null;
  const meant = a.meant.map(m => `${m.sym} (${m.what})`).join(', ');
  return { symbol: s, resolves: a.resolves, meant: a.meant,
           text: `${s} on this feed is ${a.resolves}. If you meant the commodity, index or coin: ${meant}.` };
}

// What the feed resolved a symbol to, as one short line for a screen. Null when the feed said
// nothing about it, which is the honest output — a guessed name is worse than none.
export function resolvedLabel(hit) {
  if (!hit?.name) return null;
  const type = hit.quoteType ? String(hit.quoteType).toLowerCase() : null;
  const TYPE = { equity: 'stock', etf: 'ETF', future: 'future', index: 'index', cryptocurrency: 'crypto', mutualfund: 'fund', currency: 'FX' };
  return `${hit.name}${type ? ` · ${TYPE[type] || type}` : ''}`;
}
