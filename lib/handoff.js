// lib/handoff.js — cross-market handoff (C3, rewritten forward per P1.1). The user is in HKT and
// the sequence each day is Korea 08:00 → HK 09:30 → Europe 15:00 → US 21:30. Two questions can be
// asked of that sequence, and they are NOT the same:
//
//   BACKWARD (model validation): did Asia's last session predict the US session that has since
//   closed? Useful for calibrating the model, but not actionable — that US session is over.
//
//   FORWARD (actionable at 05:27 HKT): the US just closed. Asia opens in ~3h and has NOT yet seen
//   that session. What does the US close imply for the Asia open? Asia's last close happened
//   BEFORE the US session, so the open converges toward where the US actually finished:
//     Asia's last close BELOW the US level  → room to GAP UP  (Asia over-anticipated the downside)
//     Asia's last close ABOVE the US level  → room to GAP DOWN (Asia hasn't priced the US move yet)
//   Reference (Aug 20): SOX −2.21% but KOSPI −5.8% — Asia already priced more downside than the US
//   delivered → gap-UP risk at the open, not gap-down.
//
// The card leads with the forward read; the backward read stays as a labelled validation line.

export const HANDOFF_CFG = Object.freeze({
  asiaMinPct: 0.3,   // |Asia aggregate move| below this → too quiet to read a handoff
  gapPct:     0.5,   // |Asia − US| beyond this (pp) calls a gap direction; inside it = aligned
  nextOpenH:  3,     // ~hours to the next Asia open (KOSPI 08:00 HKT); display only
});

const sign = v => v > 0 ? 1 : v < 0 ? -1 : 0;
const fmtPct = v => v == null ? null : `${v >= 0 ? '+' : ''}${(+v).toFixed(2)}%`;

// asiaChangePct: Asia equity aggregate (mean of the region indices) — last close.
// asiaIndices: [{name, changePct}] individual Asia index closes (KOSPI/HSI/Nikkei).
// sox/wti/brent: {changePct} — the just-closed US session moves. thirtyYbps: 30Y 1d change (bps).
export function crossMarketHandoff({ asiaChangePct, asiaIndices = [], sox, tlt, wti, brent, thirtyYbps } = {}, cfg = HANDOFF_CFG) {
  if (asiaChangePct == null) return { available: false, note: 'Asia aggregate move unavailable' };
  const asiaSign = sign(asiaChangePct);

  // US session drivers (for both display and the backward vote). 30Y risk sign: yields DOWN = risk-on.
  const oilChg = wti?.changePct ?? brent?.changePct ?? null;
  const driverRows = [];
  const addDrv = (name, chg, riskSign, detail) => { if (chg != null) driverRows.push({ name, chg: +(+chg).toFixed(2), riskSign, detail }); };
  addDrv('SOX', sox?.changePct, sign(sox?.changePct), fmtPct(sox?.changePct));
  if (thirtyYbps != null) driverRows.push({ name: '30Y', chg: thirtyYbps, riskSign: -sign(thirtyYbps), detail: `${thirtyYbps >= 0 ? '+' : ''}${thirtyYbps}bp` });
  else addDrv('30Y (via TLT)', tlt?.changePct, sign(tlt?.changePct), tlt?.changePct != null ? `TLT ${fmtPct(tlt.changePct)}` : null);
  addDrv('Oil', oilChg, sign(oilChg), fmtPct(oilChg));

  const asiaCloses = (asiaIndices || []).filter(x => x && x.changePct != null)
    .map(x => ({ name: x.name, chg: +(+x.changePct).toFixed(2) }));

  // ── FORWARD — US close → Asia open (the actionable read) ──
  // Reference the primary US equity driver (SOX) against Asia's aggregate close; the open
  // converges toward the US level. Falls back to the risk-weighted driver mean if SOX is missing.
  const usRef = sox?.changePct ?? (driverRows.length ? driverRows.reduce((s, d) => s + d.riskSign * Math.abs(d.chg), 0) / driverRows.length : null);
  let forward;
  if (usRef == null) {
    forward = { available: false, note: 'No US equity driver (SOX) to reference the open against.' };
  } else {
    const gap = +(asiaChangePct - usRef).toFixed(2);   // Asia close minus US close level
    let verdict, tone, note;
    if (gap < -cfg.gapPct) {
      verdict = 'GAP-UP RISK'; tone = 'green';
      note = `Asia's last close (${fmtPct(asiaChangePct)}) sits below where the US finished (SOX ${fmtPct(usRef)}) — Asia already priced more downside than the US delivered. Convergence points UP into the open.`;
    } else if (gap > cfg.gapPct) {
      verdict = 'GAP-DOWN RISK'; tone = 'amber';
      note = `Asia's last close (${fmtPct(asiaChangePct)}) sits above where the US finished (SOX ${fmtPct(usRef)}) — Asia has not yet priced the US move. Convergence points DOWN into the open.`;
    } else {
      verdict = 'ALIGNED'; tone = 'muted';
      note = `Asia's last close (${fmtPct(asiaChangePct)}) is in line with the US finish (SOX ${fmtPct(usRef)}) — the open likely tracks the US, no strong gap edge.`;
    }
    forward = { available: true, verdict, tone, gap, usRef: +(+usRef).toFixed(2), asiaRef: +(+asiaChangePct).toFixed(2), nextOpenH: cfg.nextOpenH, drivers: driverRows, asiaCloses, note };
  }

  // ── BACKWARD — did Asia's last session confirm or diverge from the overnight drivers? ──
  // (The prior C3 read, kept as model validation. Not actionable — that US session is closed.)
  let backward;
  const live = driverRows.filter(d => d.riskSign !== 0);
  if (asiaSign === 0 || Math.abs(asiaChangePct) < cfg.asiaMinPct || !live.length) {
    backward = { available: !!live.length, verdict: 'QUIET', aligned: 0, opposed: 0,
      note: `Asia aggregate ${fmtPct(asiaChangePct)} — too quiet (or no drivers) to score confirm/diverge.` };
  } else {
    const aligned = live.filter(d => d.riskSign === asiaSign).length;
    const opposed = live.length - aligned;
    const verdict = opposed > aligned ? 'DIVERGENT' : aligned > opposed ? 'CONFIRMING' : 'MIXED';
    backward = { available: true, verdict, aligned, opposed,
      note: `Validation: Asia ${asiaChangePct >= 0 ? 'up' : 'down'} ${Math.abs(+asiaChangePct.toFixed(2))}% ${verdict === 'CONFIRMING' ? 'with' : verdict === 'DIVERGENT' ? 'against' : 'split vs'} ${Math.max(aligned, opposed)}/${live.length} of the overnight drivers.` };
  }

  return { available: true, forward, backward, drivers: driverRows, asiaCloses };
}
