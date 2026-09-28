// test/factorExposure.test.mjs — realised factor betas from fills × closes; the oil-shock scenario.
import { FACTORS, OIL_SHOCK, TAGS, tagOf, closesOf, calendarOf, closeOn, factorMoves, holdingsOf, qtyAt,
         linePnl, ols, olsMulti, factorExposure, scenarioPnl, overnightFlag } from '../lib/factorExposure.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);
const near = (n, g, w, tol) => ok(`${n} (got ${g}, want ${w} ±${tol})`, g != null && Math.abs(g - w) <= tol);

// ── a deterministic market ──
let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
const N = 90;
const dates = [];
for (let t = Date.parse('2026-05-01T00:00:00Z'); dates.length < N; t += 86400000) {
  const d = new Date(t); if (d.getUTCDay() % 6) dates.push(d.toISOString().slice(0, 10));
}
// Daily moves in percent (bp for the 10-year), with oil and gold loosely tied to each other.
const mv = { qqq: [], brent: [], wti: [], gold: [], us10y: [], dxy: [], usdjpy: [] };
for (let i = 0; i < N; i++) {
  const oil = rnd() * 4, q = rnd() * 2.5;
  mv.qqq.push(q); mv.brent.push(oil); mv.wti.push(oil * 0.95 + rnd() * 0.4);
  mv.gold.push(rnd() * 1.8 + oil * 0.1); mv.us10y.push(rnd() * 12); mv.dxy.push(rnd() * 0.8); mv.usdjpy.push(rnd() * 1.1);
}
const path = (start, m, kind = 'pct') => { let v = start; return dates.map((d, i) => { if (i) v = kind === 'bp' ? v + m[i] / 100 : v * (1 + m[i] / 100); return { date: d, close: +v.toFixed(6) }; }); };
const fc = { brent: path(98, mv.brent), wti: path(94, mv.wti), qqq: path(745, mv.qqq), us10y: path(5.2, mv.us10y, 'bp'),
             dxy: path(101, mv.dxy), usdjpy: path(147, mv.usdjpy), gold: path(4250, mv.gold) };
// Instruments priced off the factors: MNQ at ~41× QQQ, MGC ≈ gold, BRNT ≈ Brent.
const mnq = fc.qqq.map(b => ({ date: b.date, close: +(b.close * 41).toFixed(2) }));
const mgc = fc.gold.map(b => ({ date: b.date, close: b.close }));
const brnt = fc.brent.map(b => ({ date: b.date, close: +(b.close * 1.005).toFixed(4) }));
// Three small equity lines that load a little on QQQ, and one on oil.
const stock = (k, bq, bo) => { let v = 50; return dates.map((d, i) => { if (i) v *= 1 + (bq * mv.qqq[i] + bo * mv.brent[i] + rnd() * 1.5) / 100; return { date: d, close: +v.toFixed(4) }; }); };
const aaa = stock(1, 0.9, 0), bbb = stock(2, 0.6, 0), xle = stock(3, 0.2, 0.5);
const d0 = dates[0];
const fill = (qty, price, side = 'buy', date = d0) => ({ side, qty, price, date });

const rows = {
  MNQ:  { id: 'MNQ', symbol: 'MNQ', margined: true, multiplier: 2, side: 'long', tag: 'hedge', fills: [fill(1, 30000)] },
  MGC:  { id: 'MGC', symbol: 'MGC', margined: true, multiplier: 10, side: 'long', tag: 'position', fills: [fill(1, 4200)] },
  BRNT: { id: 'BRNT', symbol: 'BRNT', side: 'long', tag: 'hedge', fills: [fill(200, 95)] },
  AAA:  { id: 'AAA', symbol: 'AAA', side: 'long', tag: 'position', fills: [fill(100, 50)] },
  BBB:  { id: 'BBB', symbol: 'BBB', side: 'long', tag: 'position', fills: [fill(150, 50)] },
  XLE:  { id: 'XLE', symbol: 'XLE', side: 'short', tag: 'position', fills: [fill(300, 50, 'sell')] },
};
const lineOf = (r, closes) => {
  const h = holdingsOf(r);
  return { id: r.id, label: r.symbol, tag: tagOf(r), closes, perUnit: r.multiplier || 1, fx: 1, holdings: h, qtyNow: h.at(-1)?.[1] ?? 0 };
};
const lines = [lineOf(rows.MNQ, mnq), lineOf(rows.MGC, mgc), lineOf(rows.BRNT, brnt), lineOf(rows.AAA, aaa), lineOf(rows.BBB, bbb), lineOf(rows.XLE, xle)];

{
  eq('seven factors, the brief\'s', FACTORS.map(f => f.symbol), ['BZ=F', 'CL=F', 'QQQ', '^TNX', 'DX-Y.NYB', 'JPY=X', 'GC=F']);
  eq('the 10-year is reported per 10bp, the rest per 1%', FACTORS.map(f => f.unit), ['1%', '1%', '1%', '10bp', '1%', '1%', '1%']);
  eq('the oil-shock day', OIL_SHOCK.shocks, { brent: 4, us10y: 15, qqq: -1.5, gold: -1 });
  eq('four tags; anything else is no tag', [TAGS, tagOf({ tag: 'hedge' }), tagOf({ tag: 'Hedge' }), tagOf({})], [['hedge', 'position', 'swing', 'intraday'], 'hedge', null, null]);
}
{
  eq('closes from either shape, sorted, bad ones dropped', closesOf({ '2026-01-02': 2, '2026-01-01': 1, '2026-01-03': null }), [['2026-01-01', 1], ['2026-01-02', 2]]);
  eq('the calendar is the days every factor printed', calendarOf({ a: [['2026-01-01', 1], ['2026-01-02', 1]], b: [['2026-01-02', 1], ['2026-01-03', 1]] }), ['2026-01-02']);
  eq('a line carries its last close forward, but not for ever',
     closeOn([['2026-01-01', 10], ['2026-01-02', 11]], ['2026-01-02', '2026-01-05', '2026-01-10']), [11, 11, null]);
  eq('a price factor moves in %, the yield in bp', [factorMoves([['2026-01-01', 100], ['2026-01-02', 101]], ['2026-01-01', '2026-01-02'], 'pct')[1], factorMoves([['2026-01-01', 5.2], ['2026-01-02', 5.35]], ['2026-01-01', '2026-01-02'], 'bp')[1]], [1, 15]);
}
{
  const r = { side: 'long', fills: [fill(10, 5, 'buy', '2026-02-01'), fill(5, 6, 'buy', '2026-02-03'), fill(15, 7, 'sell', '2026-02-05')] };
  const h = holdingsOf(r);
  eq('position history from the fills', h, [['2026-02-01', 10], ['2026-02-03', 15], ['2026-02-05', 0]]);
  eq('quantity as of a date', [qtyAt(h, '2026-01-31'), qtyAt(h, '2026-02-02'), qtyAt(h, '2026-02-04'), qtyAt(h, '2026-02-06')], [0, 10, 15, 0]);
  eq('a short holds a negative quantity', holdingsOf({ side: 'short', fills: [fill(3, 10, 'sell', '2026-02-01')] }), [['2026-02-01', -3]]);
  const pnl = linePnl({ closes: [['2026-02-01', 5], ['2026-02-02', 6], ['2026-02-03', 7], ['2026-02-04', 6]], holdings: h, perUnit: 1, fx: 1 },
                      ['2026-02-01', '2026-02-02', '2026-02-03', '2026-02-04']);
  eq('P&L is the quantity held at the PREVIOUS close × the move', pnl, [null, 10, 10, -15]);
  eq('…or today\'s quantity throughout', linePnl({ closes: [['2026-01-01', 5], ['2026-01-02', 6]], qtyNow: 2, perUnit: 10, fx: 0.5 }, ['2026-01-01', '2026-01-02'], { mode: 'current' }), [null, 10]);
}
{
  const f = ols([2, 4, 6, 8], [1, 2, 3, 4]);
  eq('a straight line: slope 2, R² 1', [f.slope, f.r2], [2, 1]);
  const b = olsMulti([2, 5, 3, 8, 6, 11, 9], [[0, 1, 0, 2, 1, 3, 2], [1, 1, 2, 1, 2, 1, 2]]);
  ok('two regressors recovered', b && Math.abs(b[0] - 3) < 1e-9 && Math.abs(b[1] - 1) < 1e-9);
  eq('a factor that never moved is singular', olsMulti([1, 2, 3, 4, 5, 6], [[1, 1, 1, 1, 1, 1]]), null);
}
{
  const fx = factorExposure({ factorCloses: fc, lines, nlv: 250000 });
  ok('it computes', fx.ok && fx.windows[20].length === 7 && fx.windows[60].length === 7);
  const w60 = Object.fromEntries(fx.windows[60].map(r => [r.factor, r]));
  const w20 = Object.fromEntries(fx.windows[20].map(r => [r.factor, r]));
  // ACCEPTANCE — MNQ ×1 and MGC ×1 are the top contributors to QQQ and gold beta.
  eq('ACCEPTANCE: MNQ drives the QQQ beta (60d)', w60.qqq.top[0].id, 'MNQ');
  eq('ACCEPTANCE: MNQ drives the QQQ beta (20d)', w20.qqq.top[0].id, 'MNQ');
  eq('ACCEPTANCE: MGC drives the gold beta (60d)', w60.gold.top[0].id, 'MGC');
  eq('ACCEPTANCE: MGC drives the gold beta (20d)', w20.gold.top[0].id, 'MGC');
  // One MNQ is $2 × ~30,500 ≈ $61k of QQQ: ~$610 per 1% of QQQ.
  near('MNQ ×1 is worth about $610 per 1% of QQQ', w60.qqq.top[0].usd, 2 * 41 * fc.qqq.at(-1).close / 100, 60);
  // ACCEPTANCE — the BRNT hedge has a positive Brent beta.
  const brntBrent = w60.brent.top.find(c => c.id === 'BRNT');
  ok('ACCEPTANCE: BRNT tagged hedge shows a positive Brent beta', brntBrent && brntBrent.usd > 0 && brntBrent.tag === 'hedge');
  near('…about 200 × $98.6 / 100 ≈ $197 per 1%', brntBrent.usd, 197, 25);
  const all = Object.fromEntries(factorExposure({ factorCloses: fc, lines, nlv: 250000, top: 10 }).windows[60].map(r => [r.factor, r]));
  const sum = all.qqq.top.reduce((s, c) => s + c.usd, 0);
  near('the lines\' contributions add up to the book\'s slope', sum, w60.qqq.usdPerUnit, 1);
  ok('beta is the slope as a share of NLV', Math.abs(w60.qqq.beta - w60.qqq.usdPerUnit / 250000 * 100) < 0.001);
  ok('R² is a fraction', w60.qqq.r2 > 0.5 && w60.qqq.r2 <= 1);
  ok('five at most', fx.windows[60].every(r => r.top.length <= 5));
  eq('no NLV, no beta — the dollars still print', factorExposure({ factorCloses: fc, lines }).windows[60][2].beta, null);
  eq('a line with no history is listed, not dropped silently', factorExposure({ factorCloses: fc, lines: [...lines, { id: 'X', label: 'HL:XYZ', closes: [] }] }).skipped,
     [{ id: 'X', label: 'HL:XYZ', why: 'no price history' }]);
}
{
  // Position history matters: a line bought ten days ago has no part in the 60-day window before it.
  const late = { ...rows.MGC, id: 'MGC2', fills: [fill(1, 4300, 'buy', dates[N - 10])] };
  const fx = factorExposure({ factorCloses: fc, lines: [lineOf(late, mgc)] });
  const g = Object.fromEntries(fx.windows[60].map(r => [r.factor, r])).gold;
  const cur = Object.fromEntries(factorExposure({ factorCloses: fc, lines: [lineOf(late, mgc)], mode: 'current' }).windows[60].map(r => [r.factor, r])).gold;
  ok('as held, a late entry is a fraction of its full slope; on today\'s book it is the whole of it', g.usdPerUnit < cur.usdPerUnit * 0.4 && cur.usdPerUnit > 350);
}
{
  const sc = scenarioPnl({ factorCloses: fc, lines });
  ok('the scenario computes', sc.ok);
  eq('ACCEPTANCE: the hedge lines are listed', sc.hedges.map(h => h.id).sort(), ['BRNT', 'MNQ']);
  ok('ACCEPTANCE: coverage is a single whole %', Number.isInteger(sc.coverage));
  near('book = hedges + the rest', sc.book, sc.hedge + sc.exposed, 0.05);
  const by = Object.fromEntries(sc.lines.map(l => [l.id, l.usd]));
  // BRNT +4% on ~$19.7k ≈ +$790; MNQ −1.5% on ~$61k ≈ −$915; MGC −1% on ~$42.5k ≈ −$425.
  near('BRNT on the shock', by.BRNT, 0.04 * 200 * brnt.at(-1).close, 80);
  near('MNQ on the shock', by.MNQ, -0.015 * 2 * mnq.at(-1).close, 80);
  near('MGC on the shock', by.MGC, -0.01 * 10 * mgc.at(-1).close, 80);
  near('coverage = hedge ÷ loss', sc.coverage, Math.round(sc.hedge / -sc.exposed * 100), 0);
  const gain = scenarioPnl({ factorCloses: fc, lines: [lineOf(rows.BRNT, brnt), lineOf({ ...rows.XLE, tag: 'position' }, xle)] });
  ok('nothing to cover when the rest of the book gains', gain.exposed >= 0 ? gain.coverage === null : true);
}
{
  const today = '2026-09-28';
  const held = { symbol: 'MNQ', margined: true, tag: 'hedge', derived: { lots: [{ date: '2026-09-25' }] } };
  ok('a future held past the session, tagged hedge, is flagged', /held since 2026-09-25, tagged hedge/.test(overnightFlag(held, { today })?.text));
  eq('tagged swing is not', overnightFlag({ ...held, tag: 'swing' }, { today }), null);
  eq('opened today is not', overnightFlag({ ...held, derived: { lots: [{ date: today }] } }, { today }), null);
  ok('a leveraged ETF untagged is flagged', overnightFlag({ symbol: 'TQQQ', derived: { lots: [{ date: '2026-09-20' }] } }, { today })?.what === 'leveraged ETF');
  eq('a share is not', overnightFlag({ symbol: 'QQQ', derived: { lots: [{ date: '2026-09-20' }] } }, { today }), null);
  eq('a closed line is not', overnightFlag(held, { today, open: false }), null);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
