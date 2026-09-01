// test/atr.test.mjs — ATR, and the percentile that makes it mean something.
// The cases that matter are the ones where a point value would mislead: a roll gap scored as a
// real day's move, a thin series producing a confident percentile, and a missing ATR reading as
// a stop that passed.
import { trueRange, atrSeries, atrSummary, stopInAtr, stopWidth, ATR_PERIOD, ATR_TIGHT_STOP, ATR_STATUS } from '../lib/atr.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (n, g, w, tol = 1e-6) => eq(n, g != null && Math.abs(g - w) < tol, true);

const bar = (h, l, c, date = null) => ({ date, high: h, low: l, close: c });
const flat = (n, h = 101, l = 99, c = 100) => Array.from({ length: n }, (_, i) => bar(h, l, c, `d${String(i).padStart(3, '0')}`));

// ── true range ───────────────────────────────────────────────────────────────
{
  const tr = trueRange([bar(10, 8, 9), bar(12, 11, 11.5)]);
  eq('one true range from two bars', tr.length, 1);
  // high-low is 1, but the gap from the prior close of 9 up to today's high of 12 is 3.
  near('the gap beats the intraday range', tr[0].tr, 3);
}
{
  const tr = trueRange([bar(10, 8, 9), bar(7, 5, 6)]);
  near('a gap DOWN is measured from the prior close too', tr[0].tr, 4);
}
{
  eq('a single bar has no true range rather than a fabricated one', trueRange([bar(10, 8, 9)]).length, 0);
  eq('no bars, no range', trueRange([]).length, 0);
  eq('a non-array does not throw', trueRange(null).length, 0);
}
{
  // A bar missing any leg is dropped whole — a high without its low is not a range.
  const tr = trueRange([bar(10, 8, 9), { high: 12, close: 11 }, bar(11, 10, 10.5)]);
  eq('a half-filled bar is dropped, not half-used', tr.length, 1);
}

// ── the series ───────────────────────────────────────────────────────────────
{
  const s = atrSeries(flat(40), 14);
  near('a constant 2-point range gives an ATR of 2', s[s.length - 1].atr, 2);
  // 40 bars -> 39 true ranges -> 39-14+1 = 26 ATR observations.
  eq('one observation per bar once seeded', s.length, 26);
}
{
  eq('fewer bars than the period yields nothing, not a partial seed', atrSeries(flat(10), 14).length, 0);
  eq('exactly enough to seed gives exactly one', atrSeries(flat(15), 14).length, 1);
}
{
  // Wilder smoothing, not a simple mean — a single 10x day must NOT move the ATR by a tenth of
  // its excess, which is what a rolling mean of 14 would do.
  const bars = [...flat(30), bar(120, 80, 100, 'spike')];
  const before = atrSeries(flat(30), 14).at(-1).atr;
  const after = atrSeries(bars, 14).at(-1).atr;
  ok('a violent day raises the ATR', after > before);
  ok('but smoothed, not averaged in whole', after < before + 40 / 14 + 1e-9);
}

// ── the summary ──────────────────────────────────────────────────────────────
{
  const s = atrSummary(flat(300), 14);
  near('atr', s.atr, 2);
  near('atrPct is ATR as a share of price — the only cross-instrument form', s.atrPct, 2);
  eq('a flat series sits at its own median', s.median250, 2);
  eq('and reports the observation count', s.n, 286);
  eq('with the date of the last bar', s.date, 'd299');
}
{
  // The whole point of the module. Two series with the SAME ATR and different percentiles.
  const calm = [...flat(200, 110, 90, 100), ...flat(60, 101, 99, 100)];   // 20-wide year, 2-wide now
  const wild = [...flat(200, 100.5, 99.5, 100), ...flat(60, 101, 99, 100)]; // 1-wide year, 2-wide now
  const a = atrSummary(calm), b = atrSummary(wild);
  ok('both end at a similar ATR', Math.abs(a.atr - b.atr) < 0.5);
  ok('but the calm-now name sits low in its own year', a.percentile250 < 50);
  ok('and the expanding one sits high', b.percentile250 > 50);
}
{
  const thin = atrSummary(flat(40), 14);
  eq('a thin series refuses a 250-day percentile rather than implying one', thin.percentile250, null);
  eq('and refuses the 60-day one too', thin.percentile60, null);
  ok('while still reporting the ATR it can compute', thin.atr != null);
}
{
  const e = atrSummary([], 14);
  eq('no bars gives a fully null summary', [e.atr, e.atrPct, e.percentile250, e.median250], [null, null, null, null]);
  eq('and says how many observations it had', e.n, 0);
}

// ── the roll gap: why futures use per-contract bars ───────────────────────────
{
  // A quiet contract, a stitched roll gap of 40 points, then the same quiet 2-point range at the
  // new price. This is what a continuous series looks like, and the gap is not a day anyone could
  // have traded — the instrument did not move, the series changed instrument.
  const base = atrSeries(flat(60, 101, 99, 100), 14).at(-1).atr;
  const stitched = atrSeries(
    [...flat(30, 101, 99, 100), bar(141, 139, 140, 'roll'), ...flat(29, 141, 139, 140, 'x')], 14);
  const roll = stitched.findIndex(s => s.date === 'roll');
  const at = k => stitched[roll + k].atr / base;

  near('the clean contract sits at its true 2-point range', base, 2);
  ok('the roll gap more than doubles the ATR on the day', at(0) > 2.3);
  // Wilder smoothing is why this is a sizing problem and not a one-day blip: the decay is slow,
  // and a full trading month after the roll the ATR is still a third too wide — which is exactly
  // the month in which the new contract is being sized off it.
  ok('a week later it is still nearly double', at(5) > 1.9);
  ok('and a trading month later still a third too wide', at(20) > 1.3);
  ok('decaying, never correcting', at(0) > at(5) && at(5) > at(20));
  // The counterfactual: per-contract bars see no gap at all, because there is none.
  near('bars from the new contract alone show the real range', atrSeries(flat(60, 141, 139, 140), 14).at(-1).atr, 2);
}

// ── stop distance ────────────────────────────────────────────────────────────
{
  near('three points against a 2-point ATR is 1.5 ATR', stopInAtr({ price: 100, stop: 97, atr: 2 }), 1.5);
  near('direction does not matter — distance does', stopInAtr({ price: 100, stop: 103, atr: 2 }), 1.5);
  eq('no ATR, no answer', stopInAtr({ price: 100, stop: 97, atr: null }), null);
  eq('no stop, no answer', stopInAtr({ price: 100, stop: null, atr: 2 }), null);
  eq('a zero ATR does not divide by zero', stopInAtr({ price: 100, stop: 97, atr: 0 }), null);
}
{
  const tight = stopWidth({ price: 100, stop: 99, atr: 2 });
  eq('half an ATR is flagged tight', [tight.tight, tight.known, tight.atrs], [true, true, 0.5]);
  ok('and says why in words', /ordinary daily range/.test(tight.note));

  const fine = stopWidth({ price: 100, stop: 96, atr: 2 });
  eq('two ATRs is not', [fine.tight, fine.known], [false, true]);

  // The boundary is exclusive: exactly 1.0 ATR is not "inside the daily range".
  eq('exactly one ATR is not tight', stopWidth({ price: 100, stop: 98, atr: 2 }).tight, false);
}
{
  // The failure that would matter: unknown must never render as a passing check.
  const noAtr = stopWidth({ price: 100, stop: 99, atr: null });
  eq('a missing ATR is unknown, never a pass', [noAtr.known, noAtr.tight, noAtr.atrs], [false, false, null]);
  // This used to assert the note said "no ATR", which was the generic string five different
  // causes shared. With no status supplied the caller has not said why, so it reports the most
  // common cause by name rather than a catch-all.
  eq('and defaults to a NAMED cause, not a catch-all', noAtr.status, ATR_STATUS.NOT_REQUESTED);
  ok('with a sentence a reader can act on', /not requested/.test(noAtr.note));

  const noStop = stopWidth({ price: 100, stop: null, atr: 2 });
  eq('and so is a missing stop', [noStop.known, noStop.tight], [false, false]);
  ok('with its own reason', /no stop set/.test(noStop.note));
}
{
  eq('the period is Wilder\'s 14', ATR_PERIOD, 14);
  eq('and the tight-stop threshold is one ATR', ATR_TIGHT_STOP, 1.0);
  eq('an empty call does not throw', stopWidth().known, false);
}

// ── WHY THERE IS NO ATR ──────────────────────────────────────────────────────
// Five causes used to share one string, "no ATR for this symbol": never requested, request failed,
// ticker unknown, too few bars, still loading. One message for five problems is indistinguishable
// from a broken feature. Each has a different remedy, so each gets its own status and sentence.
{
  const S = ATR_STATUS;
  const w = (o) => stopWidth({ price: 100, stop: 95, atr: null, ...o });

  eq('still loading says so', w({ status: S.LOADING }).status, S.LOADING);
  ok('and reads as temporary', /loading/i.test(w({ status: S.LOADING }).note));

  eq('never requested is its own state', w({ status: S.NOT_REQUESTED }).status, S.NOT_REQUESTED);
  ok('and says the row was not asked about', /not requested/i.test(w({ status: S.NOT_REQUESTED }).note));

  const f = w({ status: S.FETCH_FAILED, detail: { httpStatus: 429 } });
  eq('a failed fetch is distinct from missing data', f.status, S.FETCH_FAILED);
  ok('it names the HTTP status', /429/.test(f.note));
  ok('and says it is worth retrying', /retryable/.test(f.note));

  const nd = w({ status: S.NO_DATA, detail: { symbol: 'ASTX' } });
  eq('an unknown ticker is not a failed fetch', nd.status, S.NO_DATA);
  ok('and points at the ticker, which is the thing to fix', /check the ticker/.test(nd.note));
  ok('naming it', /ASTX/.test(nd.note));

  const sh = w({ status: S.SHORT_HISTORY, detail: { bars: 6, needed: 15, period: 14 } });
  eq('a recent listing is not an error at all', sh.status, S.SHORT_HISTORY);
  ok('it says how many bars there are', /6 bars/.test(sh.note));
  ok('and how many are needed', /needs 15/.test(sh.note));

  // Every one of the five must produce a DIFFERENT sentence, which is the whole point.
  const notes = [S.LOADING, S.NOT_REQUESTED, S.FETCH_FAILED, S.NO_DATA, S.SHORT_HISTORY]
    .map(st => w({ status: st, detail: { httpStatus: 500, symbol: 'X', bars: 1, needed: 15 } }).note);
  eq('five causes, five distinct messages', new Set(notes).size, 5);
}
{
  // A missing stop is reported ahead of any ATR problem: it is the user's to fix, not the feed's,
  // and it is a real finding rather than an absence of data.
  const noStop = stopWidth({ price: 100, stop: null, atr: null, status: ATR_STATUS.FETCH_FAILED });
  eq('no stop wins over a feed problem', noStop.status, ATR_STATUS.NO_STOP);
  ok('and says so plainly', /no stop set/.test(noStop.note));
  const good = stopWidth({ price: 100, stop: 92, atr: 4 });
  eq('a computed width is ok', good.status, ATR_STATUS.OK);
}

console.log(`\n${fail ? '❌' : '✅'} ${fail ? `${fail} FAILED, ` : 'ALL '}${pass} PASSED`);
process.exit(fail ? 1 : 0);
