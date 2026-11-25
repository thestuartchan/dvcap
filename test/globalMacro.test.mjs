// test/globalMacro.test.mjs — the Daily Global Macro Overview (lib/globalMacro.js): the multi-session
// read (1/5/20 sessions, the 60-session band, trend / turning / breakout / range), FX in the dollar's
// frame, the derived copper ÷ gold row, dollar breadth, the week's global calendar, and the 🌐 delta
// line the regional briefs carry. Constructed series and made-up numbers only.
import { todayAgainst, againstWeek,
  seriesStats, trendRead, fxRow, crossRow, dollarBreadth, globalDeltaLine, globalCalendar, fetchCloses, ratioRows,
  GLOBAL_FX, GLOBAL_CROSS, GLOBAL_SYMBOLS, RATIO_SYMBOLS,
} from '../lib/globalMacro.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// A year of weekday closes from a generator f(i).
const days = (n) => { const out = []; let t = Date.UTC(2029, 0, 1); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 86400000; } return out; };
const series = (n, f) => days(n).map((d, i) => [d, f(i)]);
const wiggle = (i) => 100 + 2 * Math.sin(i / 3);

// ── the read ──
{
  eq('too short a series reads nothing', seriesStats(series(60, wiggle)), null);
  const flat = seriesStats(series(260, (i) => (i === 259 ? 100 : wiggle(i))));   // ends mid-band
  ok('a year of closes reads', flat && flat.ch1 != null && flat.ch5 != null && flat.ch20 != null);
  eq('a range-bound series is inside its range', trendRead(flat).shape, 'range');
  const up = seriesStats(series(260, (i) => (i < 230 ? wiggle(i) : wiggle(i) + (i - 229) * 0.6)));
  eq('a close above the prior 60-session band is a breakout', [trendRead(up).shape, trendRead(up).dir], ['breakout', 'up']);
  // Flat, then twenty sessions up, then the last five down: a 20-session rise the week disagrees with.
  const turn = seriesStats(series(260, (i) => (i < 235 ? 100 : i < 255 ? 100 + (i - 234) * 0.4 : 108 - (i - 254) * 0.4)));
  eq('the last five sessions against the twenty read as a turn', [trendRead(turn).shape, trendRead(turn).dir], ['turning', 'up']);
  eq('no statistics, no read', trendRead(null), null);
}

// ── FX in the dollar's frame ──
{
  const eur = GLOBAL_FX.find(d => d.sym === 'EURUSD=X');
  const falling = series(260, (i) => (i < 230 ? 1.1 + 0.005 * Math.sin(i / 3) : 1.1 - (i - 229) * 0.002));
  const r = fxRow(eur, falling);
  ok('EUR/USD falling is the dollar rising', r.usd20 > 0 && r.usdDir === 'up');
  ok('and the line reads the dollar\'s move with a plus sign', /USD \+/.test(r.line));
  ok('the break is said in the dollar\'s frame', /USD broke above its 60-session range/.test(r.line));
  ok('with the dollar-frame meaning', /dollar firmer against the euro/.test(r.line));
  const jpy = GLOBAL_FX.find(d => d.sym === 'JPY=X');
  const rj = fxRow(jpy, series(260, (i) => 150 + 0.5 * Math.sin(i / 3)));
  ok('USD/JPY is read the way it is quoted', rj.usd20 === rj.usd20 && /^\*\*JPY\*\*/.test(rj.line));
  eq('dollar breadth: every leg firmer', dollarBreadth([{ sym: 'EURUSD=X', usd20: 0.01 }, { sym: 'JPY=X', usd20: 0.02 }]), '👉 Over 20 sessions the dollar is firmer against every leg.');
  ok('dollar breadth: a split says read the legs', /read the legs, not the index/.test(dollarBreadth([{ sym: 'EURUSD=X', usd20: 0.01 }, { sym: 'JPY=X', usd20: -0.02 }, { sym: 'KRW=X', usd20: 0.01 }])));
  eq('dollar breadth: no legs', dollarBreadth([{ sym: 'DX-Y.NYB', usd20: 0.01 }]), null);
}

// ── cross-asset, and the derived ratio ──
{
  const cu = GLOBAL_CROSS.find(d => d.id === 'cu-au');
  const closes = { 'HG=F': series(260, (i) => 5 + 0.05 * Math.sin(i / 3)), 'GC=F': series(260, (i) => (i < 230 ? 3000 : 3000 + (i - 229) * 20)) };
  const r = crossRow(cu, closes);
  ok('copper ÷ gold is built from the two legs', r && r.last > 0 && r.last < 0.01);
  eq('gold racing ahead is fear winning over growth', [r.trend.dir, /fear winning over growth/.test(r.line)], ['down', true]);
  const gold = crossRow(GLOBAL_CROSS.find(d => d.sym === 'GC=F'), closes);
  ok('gold breaking up reads as haven demand', /broke above its 60-session range: haven and real-rate hedge in demand/.test(gold.line));
  eq('a leg with no closes is no row', crossRow(GLOBAL_CROSS.find(d => d.sym === 'BTC-USD'), closes), null);
}

// ── the ratios, through the panel's own cards ──
{
  const closes = {};
  for (const s of RATIO_SYMBOLS) closes[s] = series(270, (i) => 100 + Math.sin(i / 4 + s.length));
  const r = ratioRows(closes, { now: Date.parse(`${closes.SPY.at(-1)[0]}T23:00:00Z`) });
  eq('every card renders a line', r.lines.length, 7);
  ok('each line names its 20-day and 5-day change', r.lines.every(l => (/20d/.test(l) && /5d/.test(l)) || /waiting on data/.test(l)));
  ok('no line says "reversing" next to the old direction', r.lines.every(l => !/reversing/.test(l)));
  ok('no bare "failed" or "the other way"', r.lines.every(l => !/↩|failed|the other way/.test(l)));
  ok('stale legs say they are waiting, not a guess', ratioRows({}, {}).lines.every(l => /waiting on data/.test(l)));
}

// ── the symbol lists ──
ok('the yuan is read onshore (the feed keeps no CNH history)', GLOBAL_SYMBOLS.includes('CNY=X') && !GLOBAL_SYMBOLS.includes('CNH=X'));
ok('copper ÷ gold pulls both legs', GLOBAL_SYMBOLS.includes('HG=F') && GLOBAL_SYMBOLS.includes('GC=F'));

// ── the 🌐 line ──
{
  const base = { vix: 22, oas: 3.4, us10y: 5.1, us30y: 5.46, wti: 82, gold: 340, dxy: 103.9, usdjpy: 159.5, cnh: 6.66, wires: { 'Fear climbing': false } };
  const at = '2030-01-02T22:20:00Z', ref = new Date('2030-01-03T12:40:00Z');
  eq('nothing moved: one quiet line', globalDeltaLine(base, base, { at, ref }), '🌐 **GLOBAL** · nothing material has moved since the Overview (22:20Z)');
  const moved = globalDeltaLine({ ...base, vix: 24.5, us10y: 5.18, wti: 85, dxy: 104.1, wires: { 'Fear climbing': true } }, base, { at, ref });
  ok('a tripwire crossing leads', /since the Overview \(22:20Z\): 🔴 Fear climbing/.test(moved));
  ok('VIX in points', /VIX 22\.0 → \*\*24\.5\*\*/.test(moved));
  ok('the 10-year in percentage points', /10yr 5\.10 → \*\*5\.18\*\*%/.test(moved));
  ok('oil in per cent', /oil \*\*\+3\.7%\*\*/.test(moved));
  ok('a move under its threshold is left out', !/dollar/.test(moved));
  ok('an Overview over a day old shows its date', /\(01-02 22:20Z\)/.test(globalDeltaLine(base, base, { at, ref: new Date('2030-01-04T12:40:00Z') })));
  eq('no Overview, no line', globalDeltaLine(base, null), null);
}

// ── the week, globally ──
{
  const ev = [
    { date: '2030-01-02', title: 'US CPI (Dec)', time: '08:30', tz: 'America/New_York' },
    { date: '2030-01-03', title: 'FOMC minutes', time: '14:00', tz: 'America/New_York' },
    { date: '2030-01-03', title: 'Some retailer earnings (BMO) — the consumer', tier: 2 },
    { date: '2030-01-06', title: 'Bellwether earnings (AC) — the AI capex bellwether', tier: 1 },
    { date: '2030-01-07', title: 'PBoC Loan Prime Rate', time: '09:15', tz: 'Asia/Shanghai' },
    { date: '2030-01-08', title: 'Sector flash PMI', scope: 'global' },
    { date: '2030-01-04', title: 'ECB rate decision', reported: true },
    { date: '2030-01-20', title: 'BoJ decision' },
  ];
  eq('central banks, rate-setting data, tier-1 and global only; upcoming; seven days', globalCalendar(ev, { today: '2030-01-02' }), [
    '**Thu 3** FOMC minutes · 14:00 ET',
    '**Sun 6** Bellwether earnings (AC)',
    '**Mon 7** PBoC Loan Prime Rate · 09:15 Shanghai',
    '**Tue 8** Sector flash PMI',
  ]);
  eq('no date, no calendar', globalCalendar(ev, {}), []);
}

// ── fetching ──
{
  const asked = [];
  const out = await fetchCloses(['A', 'B', 'C', 'D', 'E'], { fetchCloses: async (s, range) => { asked.push([s, range]); return s === 'C' ? { ok: false } : { ok: true, closes: [['2030-01-02', 1]] }; }, range: '1y', batch: 2, pauseMs: 0 });
  eq('every symbol asked, at the range given', asked.map(a => a.join(':')), ['A:1y', 'B:1y', 'C:1y', 'D:1y', 'E:1y']);
  eq('a failed leg is an empty series, not a throw', out.C, []);
}

eq('a big day against the 20-day trend is said', todayAgainst('up', -0.258, 0.08), ' · **today ran the other way:** −25.8%, 3.2× a normal day');
eq('an ordinary day against it is not', todayAgainst('up', -0.05, 0.08), null);
eq('a big day with the trend is not', todayAgainst('down', -0.2, 0.05), null);
eq('a flat trend has nothing to run against', todayAgainst('flat', -0.2, 0.05), null);
const gpu = { up: 'the market is still funding the GPU clouds', down: 'the GPU clouds are weakening first, the funding-stress tell' };
eq('a week bigger than the month leads, with the week\'s meaning', againstWeek({ ch5: -0.146, ch20: 0.003, meansFor: (d) => gpu[d] }),
  { lead: 'down', text: '**turning:** the GPU clouds are weakening first, the funding-stress tell; this week undid the 20-day gain' });
const nm = { up: 'the market is paying the supplier', down: 'the market is paying the spender' };
eq('a smaller week is a counter-move inside the trend', againstWeek({ ch5: 0.049, ch20: -0.25, meansFor: (d) => nm[d] }),
  { lead: 'down', text: 'the market is paying the spender · bounced this week, not yet a turn' });
eq('and a pullback reads as one', againstWeek({ ch5: -0.02, ch20: 0.08, meansFor: () => null }).text, 'pulled back this week, not yet a turn');
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
if (fail) process.exit(1);
