// data/adjacent.js — the leveraged or inverse instrument beside a name, if one exists.
//
// DIRECTIONAL, because a single ticker per name only works if you are always long. A falling name
// wants the inverse; a rising one wants the leveraged long. Getting this wrong points a reader at
// an instrument that moves against the observation it is attached to, which is worse than showing
// nothing — and the risk is not hypothetical: RGTZ reads like a 2x long RGTI and is a 2x SHORT.
//
// VENUE MARKED WHERE IT IS NOT US. The core ticker decides which brief a name appears in, so an
// Asian name carries its Hong Kong product; the venue is stated so nobody reaches for it in the
// wrong session. A US-listed wrapper on an Asian underlying is not carried at all — see the note
// on SK Hynix below.
//
// EVERY ENTRY VERIFIED TWICE: identified from the issuer's own product page, then confirmed to
// return a live price through this project's own feed. Nothing here is inferred from a ticker's
// shape. Where no counterpart exists the field is null and the bracket is simply absent — SK Hynix
// has a 2x long and no inverse, and inventing one would be the most expensive kind of helpful.
//
// The multiple is stated because it is not uniform: Direxion's bear products are 1x inverse against
// a 2x bull, and CSOP moved its single-stock range to a FLEXIBLE factor on 3 August 2026 — up to a
// 2x maximum that varies daily, so anyone sizing off an assumed constant 2x would be wrong.
export const ADJACENT = Object.freeze({
  // ── US, Direxion single-stock pairs (2x bull / 1x bear) ────────────────────
  NVDA:  { up: 'NVDU', down: 'NVDD', upX: '2x', downX: '-1x' },
  TSLA:  { up: 'TSLL', down: 'TSLS', upX: '2x', downX: '-1x' },
  AAPL:  { up: 'AAPU', down: 'AAPD', upX: '2x', downX: '-1x' },
  MSFT:  { up: 'MSFU', down: 'MSFD', upX: '2x', downX: '-1x' },
  META:  { up: 'METU', down: 'METD', upX: '2x', downX: '-1x' },
  AMZN:  { up: 'AMZU', down: 'AMZD', upX: '2x', downX: '-1x' },
  GOOGL: { up: 'GGLL', down: 'GGLS', upX: '2x', downX: '-1x' },
  NFLX:  { up: 'NFXL', down: 'NFXS', upX: '2x', downX: '-1x' },
  ORCL:  { up: 'ORCU', down: 'ORCS', upX: '2x', downX: '-1x' },
  PLTR:  { up: 'PLTU', down: 'PLTD', upX: '2x', downX: '-1x' },
  QCOM:  { up: 'QCMU', down: 'QCMD', upX: '2x', downX: '-1x' },
  MU:    { up: 'MUU',  down: 'MUD',  upX: '2x', downX: '-1x' },
  PYPL:  { up: 'PYPU', down: null,   upX: '2x' },

  // ── US, other issuers ──────────────────────────────────────────────────────
  AMD:   { up: 'AMDL', down: 'AMDD', upX: '2x', downX: '-2x' },   // Defiance
  UNH:   { up: 'UNHG', down: null,   upX: '2x' },                 // Leverage Shares
  IREN:  { up: 'IRE',  down: null,   upX: '2x' },                 // Defiance — reads like a stock
  RGTI:  { up: 'RGTX', down: 'RGTZ', upX: '2x', downX: '-2x' },   // Defiance — RGTZ is the SHORT

  // ── Asia, CSOP on HKEX ─────────────────────────────────────────────────────
  // Flexible factor since 2026-08-03: up to 2x, varying daily. Stated as a maximum, not a constant.
  // The CORE ticker is the Korean primary listing, never a US proxy or ADR. SKHL (Leverage
  // Shares 2X Long SK Hynix, US) tracks the same company and is deliberately NOT here: a US
  // wrapper trades in a different session against a different close, so a move measured on the
  // Seoul tape does not describe what that wrapper did. It was carried for a while in an `also`
  // field that nothing read — dead data shaped like a decision — and is removed rather than wired.
  '000660.KS': { up: '7709.HK', down: null, upX: 'up to 2x', venue: 'HKEX' },
  '005930.KS': { up: '7747.HK', down: '7347.HK', upX: 'up to 2x', downX: 'up to -2x', venue: 'HKEX' },
});

// The bracket for a name given which way it moved. Returns null when there is no instrument on
// that side — the common case, and one the caller must render as nothing rather than as a guess.
export function adjacentFor(sym, changePct) {
  const a = ADJACENT[sym];
  if (!a || !Number.isFinite(+changePct) || +changePct === 0) return null;
  const upside = +changePct > 0;
  const t = upside ? a.up : a.down;
  if (!t) return null;
  const mult = upside ? a.upX : a.downX;
  return { ticker: t, mult: mult || null, venue: a.venue && a.venue !== 'US' ? a.venue : null };
}

// "[METU 2x]" · "[7709.HK up to 2x · HKEX]"
export function renderAdjacent(sym, changePct) {
  const a = adjacentFor(sym, changePct);
  if (!a) return '';
  return ` [${[a.ticker, a.mult, a.venue].filter(Boolean).join(a.venue ? ' ' : ' ').replace(/ (HKEX|KRX|LSE)$/, ' · $1')}]`;
}
