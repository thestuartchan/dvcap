// test/growth.test.mjs — the weekly leg of the growth axis.
//
// Built from inputs, never from a captured output: every fixture is a synthetic FRED block with
// the shape api/indicators.js produces, so the verdict is exercised on the arithmetic, and the
// clock is pinned so no assertion here can drift with the calendar.
import { growthPulse, GROWTH_SERIES, CLAIMS_WINDOW, CLAIMS_LOOKBACK, CLAIMS_RISE_PCT, WEI_STRONG, GDPNOW_STRONG, GDPNOW_WEAK, MIN_LEGS } from '../lib/growth.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const NOW = new Date('2026-09-14T14:00:00Z');   // a Monday
// Weekly history ending on a Saturday, ascending, `n` prints, values from a generator.
function weekly(endDate, n, gen) {
  const out = [];
  const end = new Date(endDate + 'T00:00:00Z');
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end); d.setUTCDate(d.getUTCDate() - 7 * i);
    out.push({ date: d.toISOString().slice(0, 10), value: gen(n - 1 - i, n) });
  }
  return out;
}
const series = (id, history, extra = {}) => ({ id, ok: true, verified: true, mismatch: null,
  value: history.at(-1).value, date: history.at(-1).date, prev: history.at(-2)?.value ?? null, history, ...extra });

// Base case: claims flat around 230k, continuing flat at 1.9M, WEI 1.9, GDPNow 2.4 for Q3.
const flatClaims = () => series('ICSA', weekly('2026-09-05', 20, () => 230000));
const flatCont   = () => series('CCSA', weekly('2026-08-29', 20, () => 1900000));
const weiAt = v => series('WEI', weekly('2026-09-05', 20, () => v));
const gdpNow = (value, prev = null) => ({ id: 'GDPNOW', ok: true, verified: true, mismatch: null,
  quarter: 'Q3 2026', value, asOf: '2026-09-10', prev, prevAsOf: '2026-09-03', history: [] });

// ── UNITS AND WINDOWS ────────────────────────────────────────────────────────
{
  const p = growthPulse({ claims: flatClaims(), continuing: flatCont(), wei: weiAt(1.9), gdpNow: gdpNow(2.4, 2.2) }, { now: NOW });
  const c = p.legs.find(l => l.key === 'claims');
  eq('claims are reported in thousands, not persons', c.value, 230);
  eq('the smoothing window and lookback are the named constants', [CLAIMS_WINDOW, CLAIMS_LOOKBACK], [4, 12]);
  eq('a flat series changes 0% quarter on quarter', c.change, 0);
  eq('four usable legs', [p.usable, p.of], [4, 4]);
  eq('flat claims, strong WEI and strong GDPNow read EXPANDING', p.verdict, 'EXPANDING');
  eq('and map onto BENIGN — one leg of one axis never breaches anything alone', p.status, 'BENIGN');
  eq('two legs voting, two flat, is a split not a confirmation', p.agreement, 'split');
  ok('the read names which legs are firm and which steady', /firm/.test(p.read) && /steady/.test(p.read));
  ok('the flips-if line carries every usable leg', p.flipsIf.startsWith('Flips if ') && p.legs.filter(l => l.available).every(l => p.flipsIf.includes(l.flip)));
}

// ── CLAIMS TURNING ───────────────────────────────────────────────────────────
{
  // 230k a quarter ago, stepping to 258k over the last four weeks: +12%, past the +10% bar.
  const rising = series('ICSA', weekly('2026-09-05', 20, i => i >= 16 ? 258000 : 230000));
  const p = growthPulse({ claims: rising, continuing: flatCont(), wei: weiAt(1.9), gdpNow: gdpNow(2.4) }, { now: NOW });
  const c = p.legs.find(l => l.key === 'claims');
  eq('a 12% rise in the 4-week average votes against growth', c.score, -1);
  eq('with the change computed against the average a quarter earlier', [c.avg, c.prior, c.change], [258, 230, 12.2]);
  ok('the flip names the level the average has to fall back below, from the prior base', /back below 253k/.test(c.flip));
  eq('one leg against, two for, is still EXPANDING on the sum', p.verdict, 'EXPANDING');
  ok('but the read names claims as weakening', /initial claims weakening/.test(p.read));
  // And a bar computed from the constant: +10% of 230k = 253k, printed on the flat leg's flip.
  const flat = growthPulse({ claims: flatClaims(), continuing: flatCont(), wei: weiAt(1.9), gdpNow: gdpNow(2.4) }, { now: NOW }).legs.find(l => l.key === 'claims');
  ok(`a steady leg's flip states both bars (${CLAIMS_RISE_PCT}% either way)`, /above 253k/.test(flat.flip) && /below 207k/.test(flat.flip));
}

// ── ALL LEGS DOWN ────────────────────────────────────────────────────────────
{
  const rising = series('ICSA', weekly('2026-09-05', 20, i => i >= 16 ? 262000 : 230000));
  const contUp = series('CCSA', weekly('2026-08-29', 20, i => i >= 16 ? 2020000 : 1900000));
  const p = growthPulse({ claims: rising, continuing: contUp, wei: weiAt(-0.4), gdpNow: gdpNow(0.6, 1.4) }, { now: NOW });
  eq('every leg negative reads CONTRACTING', p.verdict, 'CONTRACTING');
  eq('which is ELEVATED, never DANGER', p.status, 'ELEVATED');
  eq('and the agreement is confirmed', p.agreement, 'confirmed');
  ok('the read says all legs agree', /All 4 weekly legs point to weakening/.test(p.read));
  const g = p.legs.find(l => l.key === 'gdpNow');
  ok('GDPNow carries its change vs the prior estimate of the SAME quarter', /−0.8pp vs the prior estimate/.test(g.read));
  ok('continuing claims are printed in millions above a thousand thousand', /2\.02M/.test(p.legs.find(l => l.key === 'continuing').read));
}

// ── SOFTENING vs MIXED ───────────────────────────────────────────────────────
{
  const p = growthPulse({ claims: flatClaims(), continuing: flatCont(), wei: weiAt(0.8), gdpNow: gdpNow(0.7) }, { now: NOW });
  eq('one leg against and none for is SOFTENING', p.verdict, 'SOFTENING');
  const q = growthPulse({ claims: flatClaims(), continuing: flatCont(), wei: weiAt(0.8), gdpNow: gdpNow(1.4) }, { now: NOW });
  eq('all legs inside their bands is MIXED', q.verdict, 'MIXED');
  ok('and says so — below trend, not turning', /below trend, not turning/.test(q.read));
  eq('the WEI bands are the constants', [WEI_STRONG, GDPNOW_STRONG, GDPNOW_WEAK], [1.5, 2.0, 1.0]);
}

// ── STALENESS IS EXCLUSION, NOT A FOOTNOTE ───────────────────────────────────
{
  // Claims last printed for the week ending 2026-08-15: 21 business days by the 14th, past the 8-day rhythm.
  const stale = series('ICSA', weekly('2026-08-15', 20, () => 230000));
  const p = growthPulse({ claims: stale, continuing: flatCont(), wei: weiAt(1.9), gdpNow: gdpNow(2.4) }, { now: NOW });
  const c = p.legs.find(l => l.key === 'claims');
  eq('a late leg is excluded', c.available, false);
  ok('with the reason stating the last print and its age', /has not printed since 2026-08-15 \(21 business days\)/.test(c.reason));
  eq('and the excluded list names it', p.excluded.map(e => e.key), ['claims']);
  eq('three legs still read', p.usable, 3);
  ok('the flips-if line does not carry the excluded leg', !/initial claims/.test(p.flipsIf));
  // Same input, clock pinned a month earlier: fresh.
  const early = growthPulse({ claims: stale }, { now: new Date('2026-08-20T14:00:00Z') });
  eq('the same print is fresh when the clock says so — the clock is an input, not the wall', early.legs.find(l => l.key === 'claims').available, true);
}

// ── TOO FEW LEGS → NO VERDICT ────────────────────────────────────────────────
{
  const p = growthPulse({ claims: flatClaims() }, { now: NOW });
  eq(`fewer than ${MIN_LEGS} usable legs is INSUFFICIENT`, p.verdict, 'INSUFFICIENT');
  eq('which renders as WATCH, not BENIGN', p.status, 'WATCH');
  ok('the read says how many legs were usable', /Only 1 of 4 weekly legs usable/.test(p.read));
  ok('and the flips line says what it is waiting on', /Reads once/.test(p.flipsIf));
  const none = growthPulse({}, { now: NOW });
  eq('no input at all is INSUFFICIENT with every leg excluded', [none.verdict, none.excluded.length], ['INSUFFICIENT', 4]);
  const short = growthPulse({ claims: series('ICSA', weekly('2026-09-05', 10, () => 230000)), wei: weiAt(1.9), gdpNow: gdpNow(2.4) }, { now: NOW });
  ok('a history too short for the window is excluded with the count', /needs 16 weekly prints, have 10/.test(short.legs[0].reason));
}

// ── A WRONG SERIES ID IS SURFACED, NOT RENDERED AS THE RIGHT ONE ─────────────
{
  const wrong = { ...flatClaims(), verified: false, mismatch: 'expected title containing "initial claims", FRED returned "Something else"' };
  const p = growthPulse({ claims: wrong, continuing: flatCont(), wei: weiAt(1.9), gdpNow: gdpNow(2.4) }, { now: NOW });
  eq('an unverified series is named', p.unverified.map(u => u.key), ['claims']);
  ok('every series in the contract asserts a title fragment', Object.values(GROWTH_SERIES).every(m => m.expectTitle && m.lagBizDays > 0));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
