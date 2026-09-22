// lib/leverage.js — a leveraged ETF's exposure is its cost times its factor.
//
// 2026-09-22: the sizer, asked for TQQQ as a Stock, suggested 291 shares — $21,200 of cost and
// $64,000 of index delta, which took the book through the 1.5× ceiling while the panel printed a
// tick. Same failure as the QQQ 730 calls and CL=F: a test passed because it measured the wrong
// quantity. The factor lives here, signed (an inverse product is negative and REDUCES book delta),
// with the underlying it tracks and its reset. Unknown tickers are 1, as they always were; a
// name that reads like a leveraged product ("2X", "Ultra", "Daily Bull") earns a prompt to set
// the factor, never a guess. Editable: this is the seed.
export const LEVERAGE = Object.freeze({
  TQQQ: { factor: 3,  underlying: 'QQQ',  reset: 'daily' },
  SQQQ: { factor: -3, underlying: 'QQQ',  reset: 'daily' },
  QLD:  { factor: 2,  underlying: 'QQQ',  reset: 'daily' },
  QID:  { factor: -2, underlying: 'QQQ',  reset: 'daily' },
  UPRO: { factor: 3,  underlying: 'SPY',  reset: 'daily' },
  SPXL: { factor: 3,  underlying: 'SPY',  reset: 'daily' },
  SPXU: { factor: -3, underlying: 'SPY',  reset: 'daily' },
  SPXS: { factor: -3, underlying: 'SPY',  reset: 'daily' },
  SSO:  { factor: 2,  underlying: 'SPY',  reset: 'daily' },
  SDS:  { factor: -2, underlying: 'SPY',  reset: 'daily' },
  SOXL: { factor: 3,  underlying: 'SOXX', reset: 'daily' },
  SOXS: { factor: -3, underlying: 'SOXX', reset: 'daily' },
  TNA:  { factor: 3,  underlying: 'IWM',  reset: 'daily' },
  TZA:  { factor: -3, underlying: 'IWM',  reset: 'daily' },
  FNGU: { factor: 3,  underlying: 'FNGS', reset: 'daily' },
  UVXY: { factor: 1.5, underlying: 'VIX futures', reset: 'daily' },
  // CSOP's Hong Kong leveraged products. The brief filed 7709.HK as 2× Nikkei; every other record
  // in this codebase — the Korea panel that tracks its units beside SK Hynix, the watchlist
  // bracket that used to print it after 000660.KS — has it as the SK Hynix 2× product. Factor 2
  // either way ("up to 2x", flexible since 2026-08-03); the underlying is the one the records say.
  '7709.HK': { factor: 2,  underlying: '000660.KS', reset: 'daily', note: 'CSOP SK Hynix daily (2x) leveraged — flexible factor, up to 2x' },
  '7747.HK': { factor: 2,  underlying: '005930.KS', reset: 'daily' },
  '7347.HK': { factor: -2, underlying: '005930.KS', reset: 'daily' },
  // Single-stock 2× wrappers.
  AAPU: { factor: 2, underlying: 'AAPL', reset: 'daily' }, TSLL: { factor: 2, underlying: 'TSLA', reset: 'daily' },
  NVDL: { factor: 2, underlying: 'NVDA', reset: 'daily' }, MSFU: { factor: 2, underlying: 'MSFT', reset: 'daily' },
  AMZU: { factor: 2, underlying: 'AMZN', reset: 'daily' }, GGLL: { factor: 2, underlying: 'GOOGL', reset: 'daily' },
  METU: { factor: 2, underlying: 'META', reset: 'daily' }, PLTU: { factor: 2, underlying: 'PLTR', reset: 'daily' },
  CONL: { factor: 2, underlying: 'COIN', reset: 'daily' },
});

export function leverageFor(symbol) {
  const k = String(symbol || '').toUpperCase().trim();
  const e = LEVERAGE[k];
  if (!e) return { symbol: k || null, factor: 1, underlying: null, reset: 'none', known: false };
  return { symbol: k, ...e, known: true };
}
export const isLeveraged = (symbol) => leverageFor(symbol).factor !== 1;
// The words a leveraged product's name carries. A hit on an UNKNOWN ticker earns the prompt.
export const looksLeveraged = (text) => /\b(2X|3X|ULTRA(PRO|SHORT)?|DAILY|BULL|BEAR|INVERSE|LEVERAGED)\b/i.test(String(text || ''));

// ── THE SWING BUCKET (rule decided 22 Sep 2026) ──────────────────────────────
// Delta-notional is split against the same 1.5× ceiling: a POSITION BOOK of views (≤1.2× NLV)
// and a SWING BUCKET of one-to-three-session trades (≤0.3× NLV) — leveraged and inverse ETFs,
// index futures held overnight, event trades. The swing bucket is RESERVED, not residual: a
// position book above 1.2× shows swing room as negative and says the position book is using it.
export const SWING = Object.freeze({ positionMax: 1.2, swingMax: 0.3, maxSessions: 3 });
// While the position book is inside 1.2×, the room is the reserve less what swing already uses.
// Once it is over, the room is the SHORTFALL, negative — 1.38× on $220k is −$39,600 — and no swing
// trade is sized until the position book is back under its limit. The reserve does not shrink
// quietly; the number goes below zero and says why.
export function swingRoom({ nlv, positionUsd = 0, swingUsd = 0, L = SWING } = {}) {
  const eq = Number(nlv) || 0;
  const pos = Number(positionUsd) || 0, sw = Number(swingUsd) || 0;
  const posLimit = eq * L.positionMax, reserved = eq * L.swingMax;
  const positionOver = Math.max(0, pos - posLimit);
  const room = positionOver > 0 ? -positionOver : reserved - sw;
  return {
    positionUsd: +pos.toFixed(2), positionX: eq > 0 ? +(pos / eq).toFixed(2) : null,
    positionLimit: L.positionMax, positionLimitUsd: +posLimit.toFixed(2), positionOverUsd: +positionOver.toFixed(2),
    swingUsd: +sw.toFixed(2), swingX: eq > 0 ? +(sw / eq).toFixed(2) : null, swingLimit: L.swingMax, reservedUsd: +reserved.toFixed(2),
    roomUsd: +room.toFixed(2), negative: room < 0,
    note: room < 0
      ? `swing room −$${Math.round(-room).toLocaleString('en-US')}: position book is using it — $${Math.round(positionOver).toLocaleString('en-US')} over its ${L.positionMax}× limit`
      : `swing room $${Math.round(room).toLocaleString('en-US')} of $${Math.round(reserved).toLocaleString('en-US')} reserved${sw > 0 ? ` ($${Math.round(sw).toLocaleString('en-US')} in use)` : ''}`,
  };
}
// The swing room in every wrapper the account actually trades, so the instrument choice is visible
// at a glance: "$66k delta ≈ $22k TQQQ (~300 sh) ≈ 89 QQQ sh ≈ 1.1 MNQ".
export function roomInWrappers(roomUsd, { tqqq = null, qqq = null, mnq = null, mnqMultiplier = 2 } = {}) {
  const r = Number(roomUsd) || 0;
  if (r <= 0) return [];
  const out = [];
  if (tqqq > 0) out.push({ symbol: 'TQQQ', usd: +(r / 3).toFixed(0), units: Math.floor(r / 3 / tqqq), unit: 'sh' });
  if (qqq > 0) out.push({ symbol: 'QQQ', units: Math.floor(r / qqq), unit: 'sh' });
  if (mnq > 0) out.push({ symbol: 'MNQ', units: +(r / (mnq * mnqMultiplier)).toFixed(1), unit: 'contracts' });
  return out;
}
