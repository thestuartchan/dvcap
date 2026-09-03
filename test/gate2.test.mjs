// test/gate2.test.mjs — Gate 2 was citing DXY as evidence of a broad dollar move on the same
// screen that declared DXY to be reporting one managed pair.
import { wonRead, CORROBORATION_RATIO } from '../lib/fx.js';
import { contamination } from '../lib/intervention.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const JPY_FLAGGED = contamination({
  regimes: { JPY: { currency: 'JPY', grade: 'SUSPECTED', since: '2026-08-21' } }, events: {},
}, '2026-09-03');
const NO_FLAGS = contamination({ regimes: {}, events: {} }, '2026-09-03');

// ── THE SCREEN THAT PROMPTED THIS ───────────────────────────────────────────
// 2026-09-03: KRW −1.08%, DXY −0.27%, JPY −2.03% (flagged), EUR/USD +0.09%.
const TODAY = { krwChangePct: -1.08, dxyChangePct: -0.27, jpyChangePct: -2.03, eurChangePct: 0.09 };
{
  const r = wonRead({ ...TODAY, contamination: JPY_FLAGGED });
  eq('Gate 2 reads SUSPECT, not CLEAN', r.gate2, 'suspect');
  eq('driven by the won alone', r.driver, 'KOREA_SPECIFIC');
  eq('half of 1.08% is what a clean leg had to match', r.needed, 0.54);
  eq('and the yen is named as the flagged leg', r.flaggedLegs, ['JPY']);
  ok('the note says DXY is not evidence', r.note.includes('not evidence'));
  ok('and that no unflagged leg moved far enough', r.note.includes('half as far'));

  // AND THE FLAG IS WHAT DECIDES IT. The identical numbers with nothing flagged read CLEAN, because
  // the yen is then a legitimate corroborating leg and it moved four times the needed magnitude.
  // That is the old answer, and it was reasonable arithmetic on a false premise — the premise being
  // that the yen was pricing rather than being managed.
  const unflagged = wonRead({ ...TODAY, contamination: NO_FLAGS });
  eq('the same numbers unflagged read CLEAN', unflagged.gate2, 'clean');
  eq('off the yen', unflagged.corroboratedBy, ['JPY']);
  ok('so the flag, not the arithmetic, is what moves Gate 2', unflagged.gate2 !== r.gate2);
}

// ── WHAT A CLEAN READ ACTUALLY REQUIRES ─────────────────────────────────────
{
  // The euro moving half the won's magnitude, in the same dollar direction.
  const r = wonRead({ ...TODAY, eurChangePct: 0.60, contamination: JPY_FLAGGED });
  eq('a clean leg moving far enough restores CLEAN', r.gate2, 'clean');
  eq('and names which leg did it', r.corroboratedBy, ['EUR']);
  eq('the driver is macro', r.driver, 'MACRO');

  // Exactly half qualifies; a hair under does not.
  eq('exactly half corroborates', wonRead({ ...TODAY, eurChangePct: 0.54, contamination: JPY_FLAGGED }).gate2, 'clean');
  eq('a hair under does not', wonRead({ ...TODAY, eurChangePct: 0.53, contamination: JPY_FLAGGED }).gate2, 'suspect');
  // WRONG DIRECTION IS NOT CORROBORATION. A euro moving the other way is evidence against.
  eq('a big move the wrong way does not corroborate',
    wonRead({ ...TODAY, eurChangePct: -0.90, contamination: JPY_FLAGGED }).gate2, 'suspect');
  eq('the ratio is stated, not buried', CORROBORATION_RATIO, 0.5);
}

// ── THE FLAGGED LEG IS NEVER THE EVIDENCE ───────────────────────────────────
{
  // The yen moved twice the won's magnitude in the right direction — and is flagged, so it cannot
  // be what makes this clean. This is the exact substitution the old rule made.
  const r = wonRead({ krwChangePct: -1.08, dxyChangePct: -0.90, jpyChangePct: -2.03, eurChangePct: 0.02,
    contamination: JPY_FLAGGED });
  eq('a flagged leg cannot corroborate however far it moved', r.gate2, 'suspect');
  // Unflag it and the same numbers read clean — proving the flag, not the arithmetic, is deciding.
  eq('unflagged, the same yen move does corroborate',
    wonRead({ krwChangePct: -1.08, dxyChangePct: -0.90, jpyChangePct: -2.03, eurChangePct: 0.02,
      contamination: NO_FLAGS }).gate2, 'clean');
}
{
  // Every corroborating leg flagged: unresolved, NOT clean and not a Korea-specific finding either.
  const both = contamination({ regimes: {
    JPY: { currency: 'JPY', grade: 'SUSPECTED', since: '2026-08-21' },
  }, events: {} }, '2026-09-03');
  const r = wonRead({ krwChangePct: -1.08, dxyChangePct: -0.27, jpyChangePct: -2.03, contamination: both });
  eq('with only a flagged leg to look at, Gate 2 is unresolved', r.gate2, 'unknown');
  eq('and says so rather than guessing', r.available, false);
  ok('naming the problem', r.note.includes('nothing clean'));
}

// ── THE REST OF THE STATES SURVIVE ──────────────────────────────────────────
{
  eq('no won print, no read', wonRead({ krwChangePct: null }).gate2, 'unknown');
  eq('no corroborating leg at all is unresolved', wonRead({ krwChangePct: -1.08 }).gate2, 'unknown');
  const weak = wonRead({ krwChangePct: 0.80, dxyChangePct: 0.40, eurChangePct: -0.50, contamination: NO_FLAGS });
  eq('a weakening won still reports', weak.gate2, 'weakening');
  eq('and reads macro when the dollar is broadly firm', weak.driver, 'MACRO');
  // With a flag, a weakening won must not be attributed to a broad dollar move off DXY.
  const weakFlagged = wonRead({ krwChangePct: 0.80, dxyChangePct: 0.40, jpyChangePct: 2.0, contamination: JPY_FLAGGED });
  eq('with a flag it will not claim macro off DXY', weakFlagged.driver, 'MIXED');
  eq('an empty call does not throw', wonRead().gate2, 'unknown');
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
