// lib/fxoverlay.js — FX overlay on P&L (D5). The book holds KRW and HKD assets, but the dashboard
// quotes them in LOCAL currency. A headline "-7%" Samsung day with the won UP 1.1% is a materially
// smaller loss in USD (~-5.9%) than the local print implies — and USD is the book's base. This
// decomposes each position into local move, the FX leg, and the USD-translated move.
//
// Sign convention: USD/KRW UP = won WEAKER = a KRW asset worth LESS in USD. So
//   usdReturn ≈ localReturn − (USD/KRW change%).
// HKD is pegged (7.75–7.85 band), so its FX leg is ~0 by design — flagged, not silently dropped.

function currencyOf(sym) {
  if (/\.(KS|KQ)$/.test(sym)) return 'KRW';
  if (/\.HK$/.test(sym)) return 'HKD';
  return 'USD';
}

// positions: [{ name, sym, changePct }] (local). fx: { krw, hkd } = USD/local change% (won-weaker
// positive). hkd defaults to 0 (peg). Returns per-position local/fx/usd + a book-level note.
export function fxOverlay({ positions = [], fx = {} } = {}) {
  const krw = fx.krw ?? null, hkd = fx.hkd ?? 0;   // HKD peg → ~0 unless supplied
  const rows = [];
  for (const p of positions) {
    if (!p || p.changePct == null) continue;
    const ccy = currencyOf(p.sym);
    const fxChg = ccy === 'KRW' ? krw : ccy === 'HKD' ? hkd : 0;   // USD-base assets have no FX leg
    if (ccy !== 'USD' && fxChg == null) { rows.push({ name: p.name, sym: p.sym, ccy, local: +p.changePct.toFixed(2), fx: null, usd: null }); continue; }
    const usd = +(p.changePct - (fxChg || 0)).toFixed(2);
    rows.push({ name: p.name, sym: p.sym, ccy, local: +p.changePct.toFixed(2), fx: fxChg == null ? null : +(-fxChg).toFixed(2), usd });
  }
  // Only worth surfacing when there IS an FX leg (a non-USD position with a known move).
  const material = rows.filter(r => r.ccy !== 'USD' && r.fx != null && Math.abs(r.fx) >= 0.2);
  const available = rows.some(r => r.ccy !== 'USD' && r.usd != null);
  return {
    available,
    rows,
    hkdPegged: true,
    krwKnown: krw != null,
    note: krw == null
      ? 'USD/KRW move unavailable — Korean positions shown in local terms only.'
      : material.length
        ? `Won ${krw < 0 ? 'stronger' : 'weaker'} ${Math.abs(krw).toFixed(2)}% today — it ${krw < 0 ? 'cushions' : 'deepens'} the USD P&L on Korean names vs the local print.`
        : 'FX legs immaterial today — local and USD moves are close.',
  };
}
