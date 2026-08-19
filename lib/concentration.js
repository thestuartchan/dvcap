// lib/concentration.js — SMH − SOXX spread (D3). Both are semiconductor ETFs, but weighted very
// differently: SMH is mega-cap-concentrated (NVDA ~15.6%, TSM ~9.8%), SOXX is more evenly spread
// across the cycle (~8% / ~4% for the same names). So the SMH − SOXX return spread reads WHICH
// kind of semi leadership is in force:
//   SMH outperforming (spread > 0)  → mega-cap-only leadership — narrow, top-heavy tape
//   SOXX outperforming (spread < 0)  → the cycle is broadening — the picks-and-shovels thesis
//                                       (Layer 4) confirming
// Caveat rendered always: SMH holds the TSM ADR at ~10%, so on a US semi-rout night the ADR can
// print red while 2330.TW holds green in Taipei — the spread distorts, read it with that in mind.

export const SMH_SOXX_CFG = Object.freeze({ band: 0.4 });   // |spread| within this (pp) → "in line"

export function smhSoxxTell({ smh, soxx } = {}, cfg = SMH_SOXX_CFG) {
  const a = smh?.changePct ?? null, b = soxx?.changePct ?? null;
  if (a == null || b == null) {
    return { available: false, note: 'SMH − SOXX spread unavailable — need both ETF prints.' };
  }
  const spread = +(a - b).toFixed(2);
  let reading, tone;
  if (spread > cfg.band)       { reading = 'mega-cap-only leadership'; tone = 'amber'; }
  else if (spread < -cfg.band) { reading = 'cycle broadening (picks-and-shovels confirming)'; tone = 'green'; }
  else                         { reading = 'in line — no concentration signal'; tone = 'muted'; }
  return {
    available: true, spread, tone, reading,
    smhPct: +a.toFixed(2), soxxPct: +b.toFixed(2),
    note: 'SMH holds the TSM ADR at ~10% — on a US semi-rout night that ADR can print red while 2330.TW holds green, distorting the spread.',
  };
}
