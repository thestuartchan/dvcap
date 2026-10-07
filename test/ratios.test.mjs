// test/ratios.test.mjs — the Ratios panel's arithmetic (lib/ratios.js), on synthetic series.
import { CARDS, LEGS, ratioSeries, cardStats, staleness, buildCard, nowSentence, statusOf, toneOf, summaryLine, lastSettledSession, sessionsBetween, BAND_SESSIONS } from '../lib/ratios.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const near = (n, g, w, tol = 1e-9) => ok(`${n} (${g} ≈ ${w})`, g != null && Math.abs(g - w) <= tol);

// US sessions ending at a given date, oldest first.
const sessions = (count, end = '2026-10-06') => {
  const out = []; let d = new Date(`${end}T12:00:00Z`);
  while (out.length < count) { const dow = d.getUTCDay(); const iso = d.toISOString().slice(0, 10); if (dow && dow !== 6 && iso !== '2026-09-07' && iso !== '2026-07-03' && iso !== '2026-05-25') out.push(iso); d = new Date(d - 86400000); }
  return out.reverse();
};
const NOW = Date.parse('2026-10-07T01:00:00Z');   // after the 6 Oct close, before the 7 Oct open
const D = sessions(300);
const series = (f) => D.map((d, i) => [d, f(i)]);
const flat = series(() => 100);

// ── the calendar ──
eq('settled session: before the 7 Oct open it is 6 Oct', lastSettledSession(NOW), '2026-10-06');
eq('after the 7 Oct close it is 7 Oct', lastSettledSession(Date.parse('2026-10-07T20:30:00Z')), '2026-10-07');
eq('on a Saturday it is Friday', lastSettledSession(Date.parse('2026-10-10T15:00:00Z')), '2026-10-09');
eq('sessions between Fri and Tue', sessionsBetween('2026-10-02', '2026-10-06'), 2);

// ── the cards ──
eq('seven cards, numbered', CARDS.map(c => c.n), [1, 2, 3, 4, 5, 6, 7]);
eq('every leg once', LEGS, ['NVDA', 'META', 'SMH', 'MSFT', 'GOOGL', 'AMZN', 'MU', 'CRWV', 'RSP', 'SPY', 'IWM', 'XLY', 'XLP']);
eq('AI cycle cards 1–4, risk appetite 5–7', CARDS.map(c => c.group), ['ai', 'ai', 'ai', 'ai', 'risk', 'risk', 'risk']);
ok('every card carries its copy', CARDS.every(c => c.title && c.formula && c.up && c.down && c.why && c.a && c.b));

// ── a plain ratio ──
const c1 = CARDS[0];
const r1 = ratioSeries(c1, { NVDA: series(i => 100 + i), META: series(() => 200) });
near('a plain price ratio', r1.points.at(-1).v, (100 + 299) / 200);
eq('no basket, no base date', r1.base, null);

// ── the basket (acceptance 3) ──
const c2 = CARDS[1];
const closes2 = { SMH: series(i => (i < 299 ? 100 : 110)), MSFT: series(i => (i < 299 ? 400 : 440)), GOOGL: series(() => 150), AMZN: series(() => 200), META: series(() => 700) };
const r2 = ratioSeries(c2, closes2);
near('basket: indexed to 100 at the start, so it starts at 1', r2.points[0].v, 1);
// SMH +10%; basket = (110 + 100 + 100 + 100) / 4 = 102.5 → 110 / 102.5
near('basket: equal-weight indexed average', r2.points.at(-1).v, 110 / 102.5);
eq('basket: says from when', r2.base, D[0]);

// ── breaks (acceptance 2) ──
const up = cardStats(D.map((d, i) => ({ d, v: i === 299 ? 1.2 : 1 + 0.01 * Math.sin(i) })));
eq('a close above the prior 60-session high', [up.broke, statusOf(up)[0].text], ['above', '▲ Broke ABOVE its 60-day range']);
const dn = cardStats(D.map((d, i) => ({ d, v: i === 299 ? 0.8 : 1 + 0.01 * Math.sin(i) })));
eq('below the prior 60-session low', statusOf(dn)[0].text, '▼ Broke BELOW its 60-day range');
const inside = cardStats(D.map((d, i) => ({ d, v: 1 + 0.01 * Math.sin(i) })));
eq('inside', statusOf(inside).map(s => s.kind), ['inside']);
ok('the band is the 60 sessions BEFORE today', up.bandHi < 1.2 && up.chart.at(-1).hi === up.bandHi);
eq('chart is six months', up.chart.length, 126);

// ── fast move ──
const calm = D.map((d, i) => ({ d, v: 1 + 0.002 * Math.sin(i / 3) }));
calm[299] = { d: D[299], v: calm[279].v * 1.15 };
const fast = cardStats(calm);
ok(`a 20-session move far outside a year of them is flagged (z ${fast.z?.toFixed(1)})`, fast.fast && statusOf(fast).some(s => s.kind === 'fast'));
ok('and shows beside a break chip', statusOf(fast).length === 2);
ok('an ordinary series is not', !inside.fast);

// ── changes and the year ──
const lin = cardStats(D.map((d, i) => ({ d, v: 1 + i / 1000 })));
near('5-session change', lin.ch5, (1.299 / 1.294) - 1);
near('20-session change', lin.ch20, (1.299 / 1.279) - 1);
near('at the top of its year', lin.yearPos, 1);
eq('the NOW sentence, with context only near an edge', nowSentence(c1, lin), 'NVDA is beating META over 20 days, near its 1-year high.');
eq('mid-range: no context', nowSentence(c1, { ch20: -0.02, yearPos: 0.5 }), 'NVDA is lagging META over 20 days.');
eq('the sentence capitalises the first side', nowSentence(CARDS[4], { ch20: 0.01, yearPos: 0.05 }), 'The average stock (RSP) is beating the giant stocks (SPY) over 20 days, near its 1-year low.');

eq('a plural side reads "are"', nowSentence(CARDS[5], { ch20: -0.06, yearPos: 0.19 }), 'Small caps (IWM) are lagging large caps (SPY) over 20 days.');

// ── colour roles (acceptance 5) ──
eq('AI cards: blue/amber roles', [toneOf(c1, { ch20: 0.1 }), toneOf(c1, { ch20: -0.1 })], ['boom', 'caution']);
eq('risk cards: green/red roles', [toneOf(CARDS[5], { ch20: 0.1 }), toneOf(CARDS[5], { ch20: -0.1 })], ['healthy', 'unhealthy']);

// ── staleness (acceptance 4) ──
const lag = { NVDA: series(() => 100), META: series(() => 200).slice(0, -3) };   // META's last close three sessions back
const st = staleness(c1, lag, { now: NOW });
eq('a leg three sessions old greys the card', [st?.since, st?.legs], [D[296], ['META']]);
const b = buildCard(c1, lag, { now: NOW });
ok('and nothing is computed from it', b.stale && b.stats === null);
eq('one session behind is not stale', staleness(c1, { NVDA: series(() => 1), META: series(() => 1).slice(0, -1) }, { now: NOW }), null);
eq('a missing leg is stale', staleness(c1, { NVDA: flat }, { now: NOW })?.legs, ['META']);

// ── the summary line ──
const built = [
  { card: CARDS[0], stats: { ch20: -0.1, broke: null } }, { card: CARDS[1], stats: { ch20: -0.1, broke: null } },
  { card: CARDS[2], stats: { ch20: -0.1, broke: 'below' } }, { card: CARDS[3], stats: { ch20: 0.1, broke: null } },
  { card: CARDS[4], stats: { ch20: 0.1, broke: null } }, { card: CARDS[5], stats: { ch20: 0.1, broke: null } }, { card: CARDS[6], stats: { ch20: -0.1, broke: null } },
];
eq('the summary line', summaryLine(built), 'Risk appetite: 2 of 3 rising · AI cycle: caution side leading on 3 of 4 · 1 range break today (MU ÷ SMH ▼)');
eq('quiet day', summaryLine(built.map(x => ({ ...x, stats: { ...x.stats, broke: null } }))).endsWith('no range breaks today'), true);
ok('a short history is not a card', cardStats(D.slice(0, BAND_SESSIONS).map(d => ({ d, v: 1 }))) === null);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
