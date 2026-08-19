// lib/handoff.js — cross-market handoff (C3). The user sits in HKT and trades Asia BEFORE the
// US opens: Korea 08:00 → HK 09:30 → Europe 15:00 → US 21:30. The question the sequence poses is
// whether Asia is LEADING the US, or ECHOING a US driver that has already reversed overnight.
//
// Method: compare Asia's equity direction NOW against the overnight (prior-US-session) direction
// of the actual drivers, each mapped to a risk sign (risk-on = +1):
//   • SOX (^SOX)        — semis lead Asia tech; up = risk-on.
//   • 30Y via TLT       — TLT up means yields DOWN, which is the risk-on / duration-relief case.
//   • Oil (WTI/Brent)   — reflationary; up = risk-on (context weight; the noisiest leg).
// Asia moving the SAME way as the drivers = confirming (US likely follows). Asia moving AGAINST
// them = trading stale information — a mean-reversion setup into the US open. Reference case
// (Aug 19 2026): Asia fell hard while the 30Y had already reversed and rejected 5.335 overnight
// → DIVERGENT, and it was invisible until Korea had already dropped 7%.

export const HANDOFF_CFG = Object.freeze({
  asiaMinPct: 0.3,   // |Asia aggregate move| below this → too quiet to read a handoff
});

// asiaChangePct: signed % (Asia equity aggregate, e.g. mean of the region indices).
// Each driver row: { changePct } — the prior-US-session move. Missing legs are excluded, not
// guessed. Returns a verdict + the per-driver alignment so the card is fully auditable.
export function crossMarketHandoff({ asiaChangePct, sox, tlt, wti, brent } = {}, cfg = HANDOFF_CFG) {
  if (asiaChangePct == null) return { available: false, note: 'Asia aggregate move unavailable' };
  const asiaSign = asiaChangePct > 0 ? 1 : asiaChangePct < 0 ? -1 : 0;

  const drivers = [];
  const add = (name, chg, detail) => {
    if (chg == null) { drivers.push({ name, available: false }); return; }
    const riskSign = chg > 0 ? 1 : chg < 0 ? -1 : 0;
    drivers.push({ name, available: true, chg: +(+chg).toFixed(2), riskSign, aligned: riskSign === asiaSign, detail });
  };
  add('SOX', sox?.changePct, sox?.changePct != null ? `${sox.changePct >= 0 ? '+' : ''}${(+sox.changePct).toFixed(2)}%` : null);
  add('30Y (via TLT)', tlt?.changePct, tlt?.changePct != null ? `TLT ${tlt.changePct >= 0 ? '+' : ''}${(+tlt.changePct).toFixed(2)}%` : null);
  const oilChg = wti?.changePct ?? brent?.changePct ?? null;
  add('Oil', oilChg, oilChg != null ? `${oilChg >= 0 ? '+' : ''}${(+oilChg).toFixed(2)}%` : null);

  const live = drivers.filter(d => d.available && d.riskSign !== 0);
  if (asiaSign === 0 || Math.abs(asiaChangePct) < cfg.asiaMinPct) {
    return { available: true, verdict: 'QUIET', tone: 'muted', asiaChangePct: +(+asiaChangePct).toFixed(2),
             drivers, aligned: 0, opposed: 0,
             note: `Asia aggregate ${asiaChangePct >= 0 ? '+' : ''}${(+asiaChangePct).toFixed(2)}% — too quiet to read a lead/echo signal.` };
  }
  if (!live.length) {
    return { available: false, note: 'No overnight driver direction available (SOX / TLT / oil all flat or missing).' };
  }

  const aligned = live.filter(d => d.aligned).length;
  const opposed = live.length - aligned;
  let verdict, tone, note;
  if (opposed > aligned) {
    verdict = 'DIVERGENT'; tone = 'amber';
    note = `Asia ${asiaChangePct >= 0 ? 'up' : 'down'} ${Math.abs(+asiaChangePct.toFixed(2))}% against ${opposed}/${live.length} overnight drivers — Asia is trading stale information. Mean-reversion setup into the US open.`;
  } else if (aligned > opposed) {
    verdict = 'CONFIRMING'; tone = 'green';
    note = `Asia ${asiaChangePct >= 0 ? 'up' : 'down'} ${Math.abs(+asiaChangePct.toFixed(2))}% with ${aligned}/${live.length} overnight drivers — Asia is confirming; the US session likely follows.`;
  } else {
    verdict = 'MIXED'; tone = 'muted';
    note = `Asia split against the overnight drivers (${aligned} with, ${opposed} against) — no clean lead/echo signal.`;
  }
  return { available: true, verdict, tone, asiaChangePct: +(+asiaChangePct).toFixed(2), drivers, aligned, opposed, note };
}
