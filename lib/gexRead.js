// lib/gexRead.js — the gamma tab, in sentences.
//
// Everything else on that tab is a number that means nothing without the mechanism behind it, and
// the mechanism is not complicated: dealers hedge, and their hedging either leans against a move
// or into it. Above the flip they lean against it and the tape goes sticky; below it they lean
// into it and moves extend. This turns the stored row into that statement, deterministically —
// there is no model call here and every clause is traceable to a field.
//
// THE HARDEST PART IS SAYING "I DON'T KNOW". Spot sitting inside the flip zone is the common case
// on a real chain, and it is genuinely not a regime read — the honest output is that there isn't
// one, not a confident sentence built on a midpoint. A read that never abstains is a read nobody
// should size off.

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const f2 = (v) => v == null ? '—' : (+v).toFixed(2);
const pct = (v) => v == null ? '—' : `${v >= 0 ? '+' : ''}${(+v).toFixed(2)}%`;
const usdB = (v) => v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(v / 1e9).toFixed(2)}B`;

// How old, in hours. A daily figure quoted to two decimals at 14:00 off an 09:00 capture is the
// failure this exists to make visible: it is not wrong, it is stale, and stale reads precise.
export function ageOf(asOf, now = new Date()) {
  const t = asOf ? Date.parse(asOf) : null;
  if (!Number.isFinite(t)) return { hours: null, label: 'no capture time on this row', stale: true, level: 'unknown' };
  const hours = (now.getTime() - t) / 3600000;
  const h = +hours.toFixed(1);
  // Under two hours the positioning has barely repriced. Past six the session has moved around it.
  // Past eighteen it is a previous session's reading and belongs behind a warning, not a label.
  const level = h < 2 ? 'fresh' : h < 6 ? 'aging' : h < 18 ? 'stale' : 'previous-session';
  return {
    hours: h, level, stale: h >= 6,
    label: h < 1 ? `${Math.round(h * 60)} min ago`
      : h < 18 ? `${h.toFixed(1)}h ago`
      : `${Math.round(h / 24)}d ago — a previous session`,
  };
}

// Where spot sits relative to the flip ZONE, not the flip number. Inside the zone is its own
// answer and by far the most common one.
// CLEARING THE ZONE BY A HAIR IS NOT A REGIME. The zone already models how far the flip moves as
// the DEALER PUT ASSUMPTION varies. It does not model how far it moves as the method or the data
// vintage varies, and that turns out to be the bigger term near the edge.
//
// Measured, not guessed: on 2026-09-08 this board and an independent GEX source read the same QQQ
// chain at effectively the same spot (718.96 against 719.06) and solved the flip 1.14 apart —
// 718.27 against 719.41, or 0.16% of spot. Spot sat between the two, so the board called positive
// gamma and the other source called negative, from the same underlying at the same moment. The
// board was not wrong by its own arithmetic; it was confident inside the width of a disagreement.
//
// So a margin: outside the zone counts as a regime only when it is outside by more than this. 0.25%
// is that observed 0.16% with headroom, and it is a floor on the CLAIM rather than on the number —
// the distance is still reported exactly, and the lean is still named. What goes away is the
// stance that tells you how to size.
export const FLIP_MARGIN_PCT = 0.25;

export function regimeOf({ spot, flipLevel, flipZoneLo, flipZoneHi } = {}, { marginPct = FLIP_MARGIN_PCT } = {}) {
  const s = num(spot), f = num(flipLevel);
  const lo = num(flipZoneLo) ?? f, hi = num(flipZoneHi) ?? f;
  if (s == null || f == null) return { state: 'unknown', reason: 'no flip solved for this chain' };
  if (lo != null && hi != null && s >= lo && s <= hi) {
    return { state: 'inside', reason: `spot ${f2(s)} is inside the flip zone ${f2(lo)}–${f2(hi)}`,
      zoneWidth: +(hi - lo).toFixed(2) };
  }
  const below = s < f;
  const edge = below ? lo : hi;                 // distance to the ZONE, not to the level
  const distance = +Math.abs(s - (below ? f : f)).toFixed(2);
  const clearance = +Math.abs(s - edge).toFixed(2);
  const clearancePct = s ? (clearance / s) * 100 : null;
  const lean = below ? 'below' : 'above';
  if (clearancePct != null && clearancePct < marginPct) {
    return { state: 'edge', lean, distance, clearance, clearancePct: +clearancePct.toFixed(3),
      reason: `spot ${f2(s)} is ${lean} the flip zone (${f2(lo)}–${f2(hi)}) by ${f2(clearance)}, which is ${clearancePct.toFixed(2)}% of spot — inside the margin two sources routinely disagree by` };
  }
  return below
    ? { state: 'below', lean, reason: `spot ${f2(s)} is below the whole flip zone (${f2(lo)}–${f2(hi)})`, distance, clearance }
    : { state: 'above', lean, reason: `spot ${f2(s)} is above the whole flip zone (${f2(lo)}–${f2(hi)})`, distance, clearance };
}

// Net gamma either side of spot. The flip can be unusable while this is perfectly clear, and when
// it is, this is the read — it says which direction the dealer hedging is stacked against.
export function skewOf(byStrike = [], spot) {
  const s = num(spot);
  if (s == null || !Array.isArray(byStrike) || !byStrike.length) return null;
  let above = 0, below = 0;
  for (const r of byStrike) {
    const v = num(r?.netGexUsd), k = num(r?.strike);
    if (v == null || k == null) continue;
    if (k > s) above += v; else if (k < s) below += v;
  }
  const ratio = (above !== 0) ? Math.abs(below / above) : null;
  return {
    above: +above.toFixed(0), below: +below.toFixed(0), ratio: ratio == null ? null : +ratio.toFixed(2),
    // Only a finding when it is lopsided AND the heavier side is negative — a symmetric book, or
    // one heavy on the positive side, is not the thing worth naming.
    heavier: Math.abs(below) > Math.abs(above) * 1.5 && below < 0 ? 'below'
      : Math.abs(above) > Math.abs(below) * 1.5 && above < 0 ? 'above' : null,
  };
}

// ── DO THE WALLS ACTUALLY HOLD ACROSS EXPIRIES? ──────────────────────────────
// This used to be inferred from gamma CONCENTRATION: if no single expiry carried half the gross
// gamma, the read declared "the walls hold across N expiries — a level rather than one day's
// positioning". Those are different claims and the second does not follow from the first.
//
// Measured on QQQ, 2026-09-08: front share 24.9%, so the old test passed and the panel said the
// walls held across six expiries. The per-expiry peaks it printed directly underneath were
// 717/720, 714/722, 715/725, 700/730, 700/750 and 660/780 — ONE of the six sat at the headline
// walls, and it was the front expiry, which expired that afternoon. The panel was reassuring the
// reader that a 0DTE book was a durable level.
//
// So it is counted now. Exact strike match, because a wall three strikes away is a different wall.
const todayIn = (now) => {
  try { return new Date(now).toISOString().slice(0, 10); } catch { return null; }
};

export function wallAgreement(grid, callWall, putWall) {
  const rows = grid?.expiries || [];
  const c = num(callWall), p = num(putWall);
  if (!rows.length || (c == null && p == null)) return null;
  const matched = [], callMatched = [], putMatched = [];
  for (const r of rows) {
    const okC = c == null || num(r.peakCallStrike) === c;
    const okP = p == null || num(r.peakPutStrike) === p;
    if (okC) callMatched.push(r.expiry);
    if (okP) putMatched.push(r.expiry);
    if (okC && okP) matched.push(r.expiry);
  }
  // PER WALL AS WELL AS BOTH. The combined count was the only figure reported, and it hid the
  // case in front of us on 2026-09-09: the put wall at 700 was 2026-09-18's own peak while no
  // expiry peaked at the 720 call wall, and the summary said "0 of 6" — true of the pair and
  // false of either wall taken alone. The panel's per-row badge used the looser either-wall test,
  // so the same screen said 0 of 6 and marked a row as matching. Two walls, two answers.
  return { total: rows.length, agree: matched.length, matched,
           majority: matched.length * 2 >= rows.length,
           call: { agree: callMatched.length, matched: callMatched },
           put: { agree: putMatched.length, matched: putMatched } };
}

// The whole read. `row` is a stored or live summary; `byStrike` optional; `now` injected.
export function gexRead({ row, byStrike = [], grid = null, now = new Date(), live = false } = {}) {
  if (!row) return { ok: false, headline: 'No capture yet', state: 'none', lines: ['Nothing has been captured for this symbol.'], age: null };

  const age = ageOf(row.asOf || (row.date ? `${row.date}T13:00:00Z` : null), now);
  const reg = regimeOf(row);
  const skew = skewOf(byStrike, row.spot);
  const gex = num(row.gexUsd);
  const lines = [];

  // ── the headline ──
  let headline, state, stance;
  if (reg.state === 'below') {
    headline = 'Negative gamma — moves amplify';
    state = 'amplify';
    stance = 'Expect follow-through rather than fades. A stop sized for a normal day is more likely to be taken out by noise, so widen it or size down — not both by half measures.';
  } else if (reg.state === 'above') {
    headline = 'Positive gamma — moves damp';
    state = 'damp';
    stance = 'Expect chop and mean reversion. Breakouts tend to fail back into the range; a tight stop is more affordable here than below the flip.';
  } else if (reg.state === 'edge') {
    // Names the lean, refuses the stance. Which side of the line spot sits on is a fact and worth
    // printing; what it implies for sizing is not, at this distance.
    headline = 'At the flip — no regime edge';
    state = 'unclear';
    stance = `Do not size off the flip. Spot is ${reg.lean} the zone by ${pct(reg.clearancePct)} of spot, which is inside the margin two independent reads of the same chain routinely differ by — the sign here is arithmetic, not a finding.`;
  } else {
    headline = reg.state === 'inside' ? 'No usable regime read' : 'No flip solved';
    state = 'unclear';
    stance = 'Do not size off the flip today. The zone is wide enough that "above" and "below" are both defensible, which means neither is a finding.';
  }

  lines.push(reg.reason + '.');

  if (reg.state === 'inside') {
    lines.push(`The zone is ${f2(reg.zoneWidth)} wide — that is how far the flip moves as the dealer put assumption varies, so a single level would be false precision.`);
  } else if (reg.distance != null && row.spot) {
    lines.push(`That is ${f2(reg.distance)} away, ${pct((reg.distance / row.spot) * 100 * (reg.lean === 'below' ? 1 : -1))} of spot.`);
  }

  // ── the skew, which often survives when the flip does not ──
  if (skew?.heavier === 'below') {
    lines.push(`Net gamma below spot (${usdB(skew.below)}) is ${skew.ratio ? `${skew.ratio}x` : 'well'} heavier than above (${usdB(skew.above)}) — dealer selling is stacked underneath, so declines accelerate more than rallies do.`);
  } else if (skew?.heavier === 'above') {
    lines.push(`Net gamma above spot (${usdB(skew.above)}) is heavier than below (${usdB(skew.below)}) — the amplification is stacked into strength rather than weakness.`);
  } else if (skew) {
    lines.push(`Gamma is roughly balanced either side of spot (${usdB(skew.below)} below, ${usdB(skew.above)} above).`);
  }

  // ── the walls ──
  const cw = num(row.callWall), pw = num(row.putWall), s = num(row.spot);
  if (cw != null && pw != null && s != null) {
    lines.push(`Walls at ${f2(pw)} and ${f2(cw)} — the strikes carrying the most gamma-weighted open interest, where hedging is densest and price tends to slow.`);
  }

  // ── WHOSE BOOK ARE THE WALLS ──
  // This used to live only in the expiry card, several screens down. But it is not a detail about
  // the breakdown, it is a qualifier on the two numbers in the line immediately above: a wall that
  // is one expiry's positioning stops existing when that expiry does, and anyone sizing a stop
  // against it needs to know that BEFORE they scroll. Same fact, moved to where it changes a
  // decision.
  const wa = wallAgreement(grid, row.callWall, row.putWall);
  if (grid?.dominated && grid.frontExpiry) {
    lines.push(`⚠ ${grid.frontExpiry} carries ${grid.frontShare}% of the gamma in the expiries read — those walls are largely one expiry's book, and it expires. Treat them as today's levels, not the week's.`);
  } else if (wa && wa.total > 1) {
    // Named either way, because "these walls are today's book" and "these walls are a standing
    // level" call for opposite things from a stop, and the reader cannot tell them apart from two
    // numbers on a line.
    if (wa.majority) {
      lines.push(`The walls hold across ${wa.agree} of ${wa.total} expiries${grid.frontShare != null ? `, the nearest carrying ${grid.frontShare}%` : ''} — a level rather than one day's positioning.`);
    } else {
      // EACH WALL ON ITS OWN TERMS. "Only 0 of 6" was accurate about the PAIR and misleading
      // about both halves of it, and its "the rest peak wider" clause implies a remainder that a
      // zero count does not have. On 2026-09-09 the put wall at 700 was 2026-09-18's own peak
      // while nothing peaked at the 720 call wall, and the same card printed "0 of 6" beside a
      // row badged as matching, because the badge used the looser either-wall test.
      const named = (w) => w.agree > 0 && w.agree <= 2
        ? ` (${w.matched.map(m => String(m) === todayIn(now) ? `${m}, expiring today` : m).join(' / ')})` : '';
      const side = (label, strike, w) => strike == null ? null : `${label} ${strike}: ${w.agree} of ${wa.total}${named(w)}`;
      const parts = [side('call wall', row.callWall, wa.call), side('put wall', row.putWall, wa.put)].filter(Boolean);
      const lead = wa.agree === 0
        ? 'No expiry peaks at both walls'
        : `Only ${wa.agree} of ${wa.total} expiries peaks at both walls${named(wa)}`;
      // Which wall is the weak one, because they call for different things. A call wall no expiry
      // owns is a zone to fade into; a put wall no expiry owns is not a floor at all.
      const weak = [wa.call.agree === 0 ? 'call' : null, wa.put.agree === 0 ? 'put' : null].filter(Boolean);
      const tail = weak.length === 2
        ? 'Neither is any single expiry\'s peak — both are sums across expiries that peak elsewhere, so read them as zones rather than lines.'
        : weak.length === 1
          ? `No expiry peaks at the ${weak[0]} wall — it is a sum rather than a level, so read that one as a zone.`
          : 'Each wall is some expiry\'s own peak, but no single expiry claims both, so they are not one book\'s level.';
      lines.push(`⚠ ${lead} — ${parts.join('; ')}. ${tail}`);
    }
  }

  // ── freshness, stated as a caveat rather than a footnote ──
  if (live) lines.push('This is a live recompute: the same settled open interest, repriced at the current spot and time decay.');
  else if (age.level === 'previous-session') lines.push(`⚠ This is a ${age.label} reading. Open interest has settled since; refresh before acting on it.`);
  else if (age.stale) lines.push(`⚠ Captured ${age.label}. Spot and time decay have moved since, and the flip moves with them — refresh before sizing.`);

  return {
    ok: true, headline, state, stance, lines, age, regime: reg, skew,
    concentrated: !!grid?.dominated,
    // Concentration does not make the REGIME read wrong — the flip is still the flip — so it does
    // not knock a clear read down to low. It qualifies the walls, and it says so in a line.
    gexUsd: gex, confidence: reg.state === 'inside' ? 'none' : row.flipFragile ? 'low' : 'clear',
  };
}
