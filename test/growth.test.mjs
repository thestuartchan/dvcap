// test/growth.test.mjs — the weekly leg of the growth axis.
//
// Built from inputs, never from a captured output: every fixture is a synthetic FRED block with
// the shape api/indicators.js produces, so the verdict is exercised on the arithmetic, and the
// clock is pinned so no assertion here can drift with the calendar.
import { growthPulse, marketPulse, growthAxis, MARKET_LABEL, MARKET_PAIRS, MARKET_LOOKBACK, GROWTH_SERIES, CLAIMS_WINDOW, CLAIMS_LOOKBACK, CLAIMS_RISE_PCT, WEI_STRONG, GDPNOW_STRONG, GDPNOW_WEAK, MIN_LEGS } from '../lib/growth.js';

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
  ok('but the read names claims as weakening, with the series name in its own case', /Initial claims weakening/.test(p.read));
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

// ── WORDING: NAMES KEEP THEIR CASE, BARS PRINT ONE DECIMAL ───────────────────
{
  const p = growthPulse({ claims: flatClaims(), continuing: flatCont(), wei: weiAt(1.9), gdpNow: gdpNow(2.4) }, { now: NOW });
  ok('the split sentence prints GDPNow, not gdpnow', /GDPNow firm/.test(p.read) && !/gdpnow/.test(p.read));
  ok('and the WEI by its full name', /Weekly Economic Index/.test(p.read));
  ok('a bar prints with one decimal', /GDPNow below 2\.0/.test(p.flipsIf) && /WEI below 1\.5/.test(p.flipsIf));
}

// ── THE MARKET LEG ───────────────────────────────────────────────────────────
// Daily ratio series ending on a Friday (2026-09-11) for a Monday clock; `n` sessions.
function daily(endDate, n, gen) {
  const out = []; const d = new Date(endDate + 'T00:00:00Z'); let i = n - 1;
  while (out.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) { out.unshift({ date: d.toISOString().slice(0, 10), value: gen(i, n) }); i--; }
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}
const ratio = (series) => ({ ok: true, series });
const flatPairs = () => Object.fromEntries(Object.keys(MARKET_PAIRS).map(k => [k, ratio(daily('2026-09-11', 45, () => 1.0))]));
{
  const p = marketPulse({ pairs: flatPairs() }, { now: NOW });
  eq('five flat ratios read MIXED', [p.verdict, p.usable, p.of], ['MIXED', 5, 5]);
  ok('the read says the ratios sit inside their bands', /All 5 market ratios sit inside their bands/.test(p.read));
  const c = p.legs.find(l => l.key === 'cyclicals');
  eq(`the change is measured over ${MARKET_LOOKBACK} sessions`, c.change, 0);
  ok('and the flip names the pair, both bars and the base date', /XLY\/XLP above 1\.02 \(\+2\.0%\) or below 0\.98 \(−2\.0%\) vs the 2026-08-14 base/.test(c.flip));
  eq('a flat market leg is labelled FLAT for the reader while the verdict token stays shared', [p.label, p.verdict], ['FLAT', 'MIXED']);
  ok('and the read uses the market\'s own words', /no growth tilt priced/.test(p.read));
}
{
  // Cyclicals +3% over the month, copper/gold −5%, breadth +2%, the rest flat.
  const pairs = flatPairs();
  pairs.cyclicals = ratio(daily('2026-09-11', 45, (i, n) => i >= n - 1 ? 1.03 : 1.0));
  pairs.copperGold = ratio(daily('2026-09-11', 45, (i, n) => i >= n - 1 ? 0.95 : 1.0));
  pairs.breadth = ratio(daily('2026-09-11', 45, (i, n) => i >= n - 1 ? 1.02 : 1.0));
  const p = marketPulse({ pairs }, { now: NOW });
  eq('cyclicals +3% votes for growth', p.legs.find(l => l.key === 'cyclicals').score, 1);
  eq('copper/gold −5% votes against, past its wider 4% bar', p.legs.find(l => l.key === 'copperGold').score, -1);
  eq('breadth +2% votes for, past its 1.5% bar', p.legs.find(l => l.key === 'breadth').score, 1);
  eq('two for, one against, two flat is EXPANDING on the sum', [p.verdict, p.score], ['EXPANDING', 1]);
  eq('shown to the reader as PAYING FOR GROWTH', p.label, MARKET_LABEL.EXPANDING);
  ok('the read names the pairs by label', /Copper \/ gold weakening/.test(p.read) && /Cyclicals \/ defensives, Equal-weight \/ cap-weight firm/.test(p.read));
  ok('a moving pair reads paying for growth or safety', /paying for growth/.test(p.legs.find(l => l.key === 'cyclicals').read) && /paying for safety/.test(p.legs.find(l => l.key === 'copperGold').read));
}
{
  // A ratio whose last session is nine business days old is a broken feed, not a flat market.
  const pairs = flatPairs();
  pairs.transports = ratio(daily('2026-09-01', 45, () => 1.0));
  const p = marketPulse({ pairs }, { now: NOW });
  const t = p.legs.find(l => l.key === 'transports');
  eq('a quiet feed is excluded', t.available, false);
  ok('with its last session and age', /has not printed since 2026-09-01 \(9 business days\)/.test(t.reason));
  const short = marketPulse({ pairs: { ...flatPairs(), breadth: ratio(daily('2026-09-11', 12, () => 1.0)) } }, { now: NOW });
  ok('too few sessions is excluded with the count', /needs 21 sessions, have 12/.test(short.legs.find(l => l.key === 'breadth').reason));
  const none = marketPulse({}, { now: NOW });
  eq('no pairs at all is INSUFFICIENT with every ratio excluded', [none.verdict, none.excluded.length], ['INSUFFICIENT', 5]);
  eq('a market leg never reports unverified series — there is no title to check', none.unverified, []);
  // Copper/gold sits near 0.0013: a bar has to print as a number the reader can watch for.
  const tiny = marketPulse({ pairs: { ...flatPairs(), copperGold: ratio(daily('2026-09-11', 45, () => 0.001312)) } }, { now: NOW });
  const cg = tiny.legs.find(l => l.key === 'copperGold');
  ok('a ratio near zero prints its bars to four significant figures', /above 0\.001364/.test(cg.flip) && /below 0\.00126/.test(cg.flip));
  eq('the weekly leg keeps its own label', growthPulse({ claims: flatClaims(), continuing: flatCont(), wei: weiAt(1.9), gdpNow: gdpNow(2.4) }, { now: NOW }).label, 'EXPANDING');
}

// ── THE AXIS: THE TWO LEGS AGAINST EACH OTHER ────────────────────────────────
{
  const V = v => ({ verdict: v });
  eq('agreement up is confirmed', growthAxis({ weekly: V('EXPANDING'), market: V('EXPANDING') }).state, 'confirmed');
  eq('agreement down is confirmed', growthAxis({ weekly: V('CONTRACTING'), market: V('SOFTENING') }).state, 'confirmed');
  eq('market paying for safety against firm data is turning-down', growthAxis({ weekly: V('EXPANDING'), market: V('CONTRACTING') }).state, 'turning-down');
  eq('market paying for growth against soft data is turning-up', growthAxis({ weekly: V('SOFTENING'), market: V('EXPANDING') }).state, 'turning-up');
  ok('and the read says the market leads', /the market leads/.test(growthAxis({ weekly: V('MIXED'), market: V('CONTRACTING') }).read));
  eq('one leg missing is named as the only reader', growthAxis({ weekly: V('INSUFFICIENT'), market: V('EXPANDING') }).state, 'market-only');
  eq('both missing is insufficient', growthAxis({}).state, 'insufficient');
  eq('firm market against mixed data is turning-up as well — mixed is not firm', growthAxis({ weekly: V('MIXED'), market: V('EXPANDING') }).state, 'turning-up');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
