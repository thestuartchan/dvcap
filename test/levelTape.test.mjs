// test/levelTape.test.mjs — the level tape (lib/levelTape.js): the watch list, one capture from three
// books, the Standard grading rule on 5-minute bars, the day's distinct levels, the tallies and the
// scorecard. Fake tickers and made-up numbers only.
import {
  nextSession, activeWatch, addToWatch, removeFromWatch, dvcapLevelsOf, captureOne, appendCapture, captureTape,
  sessionBars, gradeLevel, levelsForDay, scoreTape, tallyRows, scoreDay, scoreSummary, latestBoard, uwBudgetOk,
  WATCH_KEY, TAPE_KEY, TAPE_INDEX_KEY, SCORE_AGG_KEY, SCORE_DAY_KEY, TAPE_HEALTH_KEY, WATCH_MAX,
} from '../lib/levelTape.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// ── the watch list ──
eq('next session skips the weekend', nextSession('2030-01-04'), '2030-01-07');
eq('next session skips a closure', nextSession('2030-01-04', new Set(['2030-01-07'])), '2030-01-08');
{
  const today = '2030-01-02';
  let w = null;
  let r = addToWatch(w, 'xyza', { today, earnings: { ok: true, date: '2030-01-03', time: 'after close', status: 'confirmed' }, at: 'T0' });
  eq('add: upper-cased, today + next session', [r.ok, r.entry.symbol, r.entry.from, r.entry.until], [true, 'XYZA', today, '2030-01-03']);
  eq('add: keeps the earnings date', r.entry.earnings, { date: '2030-01-03', time: 'after close', status: 'confirmed' });
  w = r.watch;
  eq('add: the book pair is refused', addToWatch(w, 'QQQ', { today }).ok, false);
  eq('add: a non-root is refused', addToWatch(w, 'XYZ 100C', { today }).ok, false);
  w = addToWatch(w, 'XYZB', { today }).watch;
  w = addToWatch(w, 'XYZC', { today }).watch;
  eq(`add: a ${WATCH_MAX + 1}th name is refused`, addToWatch(w, 'XYZD', { today }).why, `${WATCH_MAX} names on already — remove one first`);
  eq('add: a name already on is extended, not doubled', addToWatch(w, 'XYZA', { today, until: '2030-01-06' }).watch.names.filter(n => n.symbol === 'XYZA').map(n => [n.until, n.earnings?.date]), [['2030-01-06', '2030-01-03']]);
  eq('active: expired names drop off', activeWatch(w, '2030-01-06').length, 0);
  eq('active: still on the next session', activeWatch(w, '2030-01-03').length, 3);
  const rm = removeFromWatch(w, 'xyzb', { today });
  eq('remove', [rm.ok, rm.watch.names.map(n => n.symbol)], [true, ['XYZA', 'XYZC']]);
  eq('remove: not on', removeFromWatch(w, 'NOPE', { today }).ok, false);
}

// ── dvcap's levels off a settled answer ──
eq('dvcap levels: own call wall and support win', dvcapLevelsOf({ ok: true, row: { callWall: 105, putWall: 90, flipLevel: 98.4 }, levels: { callWall: { strike: 104 }, support: { strike: 95 } } }),
   { callWall: 104, putWall: 95, flip: 98.4, magnet: null });
eq('dvcap levels: raw strikes when unsolved', dvcapLevelsOf({ ok: true, row: { callWall: 105, putWall: 90, flipLevel: null }, levels: {} }), { callWall: 105, putWall: 90, flip: null, magnet: null });
eq('dvcap levels: a refusal is null', dvcapLevelsOf({ ok: false, reason: 'x' }), null);

// ── one capture ──
const uwAnswer = (o) => ({ data: { call_wall: String(o.cw), put_wall: String(o.pw), gamma_flip: String(o.fl), gamma_magnet: String(o.mg), source: o.src, time: '2030-01-02T15:00:00Z' } });
const fakeUw = (log) => async (path, o = {}) => {
  log.push([path, o.query?.source || null]);
  if (/net-prem-ticks/.test(path)) return { data: [{ net_call_premium: '3000000', net_put_premium: '1000000', tape_time: 't1' }, { net_call_premium: '500000', net_put_premium: '250000', tape_time: 't2' }] };
  return o.query?.source === 'oi' ? uwAnswer({ cw: 106, pw: 94, fl: 99, mg: 100, src: 'oi' }) : uwAnswer({ cw: 102, pw: 98, fl: 100.2, mg: 101, src: 'vol' });
};
const settledOk = async (sym, { spot }) => ({ ok: true, row: { spot, callWall: 105, putWall: 92, flipLevel: 98.5 }, levels: { callWall: { strike: 104 }, support: { strike: 95 } } });
{
  const log = [];
  const deps = { spotOf: async () => 100, settled: settledOk, uw: fakeUw(log), budgetOk: () => true };
  const c = await captureOne('XYZA', { now: new Date('2030-01-02T15:00:00Z'), book: false, deps });
  eq('capture: three books', [c.dvcap.callWall, c.uwFlow.callWall, c.uwOi.callWall], [104, 102, 106]);
  eq('capture: UW asked for vol and oi, plus premium for a watch name', log.map(x => x[1] || 'prem').sort(), ['oi', 'prem', 'vol']);
  eq('capture: net premium summed', [c.prem.net, c.prem.netCall, c.prem.netPut], [2250000, 3500000, 1250000]);
  eq('capture: parts', c.parts, { dvcap: 'ok', uwFlow: 'ok', uwOi: 'ok', prem: 'ok' });
  const b = await captureOne('QQQ', { now: new Date('2030-01-02T15:00:00Z'), book: true, deps: { ...deps, uw: fakeUw([]) } });
  eq('capture: the book pair takes no premium read', ['prem' in b, Object.keys(b.parts)], [false, ['dvcap', 'uwFlow', 'uwOi']]);
  const s = await captureOne('XYZA', { deps: { ...deps, budgetOk: () => false } });
  eq('capture: over budget skips UW, dvcap still runs', [s.dvcap?.callWall, s.uwFlow, s.parts.uw], [104, null, 'skipped: over 80% of UW\'s daily allowance']);
  const n = await captureOne('XYZA', { deps: { ...deps, uw: null, settled: async () => { throw new Error('boom'); } } });
  eq('capture: no key and a failed settled read both say so', [n.parts.dvcap, n.parts.uw], ['failed: boom', 'skipped: UW_API_KEY unset']);
  eq('budget: under / over / unknown', [uwBudgetOk({ today: 100, limit: 15000 }), uwBudgetOk({ today: 12000, limit: 15000 }), uwBudgetOk({ today: null, limit: null })], [true, false, true]);
}

// ── the tape ──
{
  let t = appendCapture(null, { at: '2030-01-02T15:00:10Z', spot: 100 }, { symbol: 'XYZA', date: '2030-01-02' });
  t = appendCapture(t, { at: '2030-01-02T15:15:05Z', spot: 101 });
  t = appendCapture(t, { at: '2030-01-02T15:15:40Z', spot: 101.5 });
  eq('tape: a re-run replaces its own slot', t.captures.map(c => c.spot), [100, 101.5]);
}
function fakeKv(seed = {}) {
  const m = new Map(Object.entries(seed));
  return { m, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; }, setEx: async (k, v) => { m.set(k, v); return true; } };
}
{
  const kv = fakeKv({ [WATCH_KEY]: { names: [{ symbol: 'XYZA', from: '2030-01-02', until: '2030-01-03' }, { symbol: 'OLDX', from: '2029-12-30', until: '2029-12-31' }] } });
  const deps = { spotOf: async () => 100, settled: settledOk, uw: fakeUw([]), budgetOk: () => true };
  const out = await captureTape({ now: new Date('2030-01-02T15:00:00Z'), kv, deps });
  eq('captureTape: the pair plus live watch names', [out.ok, out.names, out.watched, out.kept], [true, 3, 1, 3]);
  eq('captureTape: a watch name is never named in the answer', Object.keys(out.parts), ['QQQ', 'SPY', 'watch1']);
  eq('captureTape: the day index', kv.m.get(TAPE_INDEX_KEY('2030-01-02')), ['QQQ', 'SPY', 'XYZA']);
  eq('captureTape: the tape kept', kv.m.get(TAPE_KEY('XYZA', '2030-01-02')).captures.length, 1);
  eq('captureTape: health carries no level', Object.keys(kv.m.get(TAPE_HEALTH_KEY)).sort(), ['at', 'date', 'parts', 'usage']);
  eq('captureTape: closed market skips', (await captureTape({ kv, deps, isOpen: () => false })).skipped, 'US market not open');
}

// ── grading on 5-minute bars ──
// 2030-01-02 is a Wednesday; 09:30 ET = 14:30Z (EST).
const T0 = Date.UTC(2030, 0, 2, 14, 30) / 1000;
const bar = (i, o, h, l, c) => ({ t: T0 + i * 300, o, h, l, c });
const flat = (from, to, px = 100) => Array.from({ length: to - from }, (_, k) => bar(from + k, px, px + 0.05, px - 0.05, px));
eq('session bars: regular hours of the date only', sessionBars([bar(-1, 1, 1, 1, 1), bar(0, 1, 1, 1, 1), bar(78, 1, 1, 1, 1), { t: T0 - 86400, h: 1, l: 1, c: 1 }], '2030-01-02').length, 1);
{
  const from = new Date((T0 + 6 * 300) * 1000).toISOString();       // 10:00 ET
  // Resistance at 101, price at 100. Bar 10 tags 100.95 (within 0.1% = 0.101), then sells off.
  const heldBars = [...flat(0, 10), bar(10, 100.6, 100.95, 100.5, 100.8), bar(11, 100.8, 100.85, 100.6, 100.7), bar(12, 100.7, 100.72, 100.7, 100.75), ...flat(13, 20)];
  eq('resistance held (bounce 0.2% away, no close through)', gradeLevel({ level: 101, spot: 100, fromIso: from, bars: heldBars }).outcome, 'held');
  const brokeBars = [...flat(0, 10), bar(10, 100.8, 101.05, 100.7, 101), bar(11, 101, 101.3, 100.95, 101.2), ...flat(12, 20, 101.2)];
  eq('resistance broke (a 5-min close more than 0.1% through)', gradeLevel({ level: 101, spot: 100, fromIso: from, bars: brokeBars }).outcome, 'broke');
  const stallBars = [...flat(0, 10), ...Array.from({ length: 8 }, (_, k) => bar(10 + k, 100.95, 101.05, 100.9, 101)), ...flat(18, 20, 101)];
  eq('tested, neither: stalled', gradeLevel({ level: 101, spot: 100, fromIso: from, bars: stallBars }).outcome, 'stalled');
  eq('never reached: untested', gradeLevel({ level: 101, spot: 100, fromIso: from, bars: flat(0, 20) }).outcome, 'untested');
  // Support at 99, price at 100: tagged at 99.05, bounced to 99.3.
  const supBars = [...flat(0, 10), bar(10, 99.4, 99.4, 99.05, 99.1), bar(11, 99.1, 99.3, 99.1, 99.25), ...flat(12, 20)];
  eq('support held', gradeLevel({ level: 99, spot: 100, fromIso: from, bars: supBars }).outcome, 'held');
  // A touch BEFORE the capture does not count.
  const early = [bar(2, 100.9, 101, 100.9, 100.95), ...flat(3, 20)];
  eq('a touch before the capture is not a test', gradeLevel({ level: 101, spot: 100, fromIso: from, bars: early }).outcome, 'untested');
  eq('the test time is the bar', gradeLevel({ level: 101, spot: 100, fromIso: from, bars: brokeBars }).testAt, new Date((T0 + 10 * 300) * 1000).toISOString());
}

// ── the day's distinct levels and the tallies ──
{
  const tape = { captures: [
    { at: '2030-01-02T15:00:00Z', spot: 100, dvcap: { callWall: 104, putWall: 95, flip: 98.5, magnet: null }, uwFlow: { callWall: 101, putWall: 99, flip: 100.2, magnet: 100 } },
    { at: '2030-01-02T15:15:00Z', spot: 100.2, dvcap: { callWall: 104, putWall: 95, flip: 98.55, magnet: null }, uwFlow: { callWall: 102, putWall: 99, flip: 100.25, magnet: 100 } },
  ] };
  const lv = levelsForDay(tape);
  eq('levels: a repeat within 0.1% is the same level', lv.filter(x => x.src === 'dvcap').map(x => [x.kind, x.level]), [['callWall', 104], ['putWall', 95], ['flip', 98.5]]);
  eq('levels: a new strike is a new level, from its own capture', lv.filter(x => x.src === 'uwFlow' && x.kind === 'callWall').map(x => [x.level, x.at]), [[101, '2030-01-02T15:00:00Z'], [102, '2030-01-02T15:15:00Z']]);
  const bars = [...flat(0, 10), bar(10, 100.6, 100.95, 100.5, 100.8), bar(11, 100.8, 100.85, 100.6, 100.7), ...flat(12, 78)];
  const rows = scoreTape(tape, bars);
  const r101 = rows.find(r => r.src === 'uwFlow' && r.level === 101);
  eq('scoreTape: grade and distance', [r101.outcome, r101.distPct], ['held', 1]);
  const t = tallyRows(rows);
  eq('tally: per source and kind', [t.uwFlow.callWall.n, t.uwFlow.callWall.held, t.uwFlow.callWall.untested, t.dvcap.callWall.untested], [2, 1, 1, 1]);
}

// ── after the close ──
{
  const date = '2030-01-02';
  const tape = { captures: [{ at: '2030-01-02T15:00:00Z', spot: 100, dvcap: { callWall: 104, putWall: 95, flip: 98.5 }, uwFlow: { callWall: 101, putWall: 99, flip: 100.2, magnet: 100 } }] };
  const kv = fakeKv({ [TAPE_INDEX_KEY(date)]: ['QQQ', 'XYZA'], [TAPE_KEY('QQQ', date)]: tape, [TAPE_KEY('XYZA', date)]: tape });
  const bars = [...flat(0, 10), bar(10, 100.6, 100.95, 100.5, 100.8), bar(11, 100.8, 100.85, 100.6, 100.7), ...flat(12, 78)];
  const out = await scoreDay({ date, kv, barsOf: async () => bars });
  eq('scoreDay: both names graded', [out.ok, out.scored], [true, 2]);
  eq('scoreDay: detail kept', Object.keys(kv.m.get(SCORE_DAY_KEY(date)).rows), ['QQQ', 'XYZA']);
  const agg = kv.m.get(SCORE_AGG_KEY);
  const q = scoreSummary(agg, 'QQQ'), w = scoreSummary(agg, 'watch');
  eq('summary: QQQ alone', [q.days, q.bySrc.uwFlow.callWall.n, q.bySrc.uwFlow.callWall.holdRate], [1, 1, 100]);
  eq('summary: watch names pooled', [w.days, w.bySrc.uwFlow.all.n], [1, 4]);
  eq('summary: rates over tested only', [q.bySrc.dvcap.all.tested, q.bySrc.dvcap.all.testRate, q.bySrc.dvcap.all.holdRate], [0, 0, null]);
  const again = await scoreDay({ date, kv, barsOf: async () => bars });
  eq('scoreDay: re-running a date replaces it, never doubles', [again.ok, scoreSummary(kv.m.get(SCORE_AGG_KEY), 'QQQ').bySrc.uwFlow.callWall.n], [true, 1]);
  eq('scoreDay: no bars is a retryable failure', (await scoreDay({ date, kv, barsOf: async () => [] })).retryable, true);
  eq('scoreDay: no tape is a quiet day', (await scoreDay({ date: '2030-01-03', kv, barsOf: async () => bars })).why, 'no tape for the date');
}

// ── the panel's board ──
{
  const b = latestBoard({ captures: [
    { at: 'a', spot: 100, dvcap: { callWall: 104 }, uwFlow: { callWall: 101 }, prem: { net: 5 } },
    { at: 'b', spot: 101, dvcap: { callWall: 105 }, uwFlow: null, prem: { net: 7 } },
  ] });
  eq('board: each column its latest answer', [b.at, b.spot, b.cols.dvcap.callWall, b.cols.uwFlow.callWall, b.cols.uwFlow.at, b.cols.uwOi], ['b', 101, 105, 101, 'a', null]);
  eq('board: premium path', [b.prem.net, b.premPath.map(p => p.net)], [7, [5, 7]]);
  eq('board: no tape', latestBoard(null), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
if (fail) process.exit(1);
