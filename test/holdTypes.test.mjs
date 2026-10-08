// test/holdTypes.test.mjs — the sizer's hold types, exposure on the underlying and the
// correlation-aware cap (lib/holdTypes.js). The acceptance table of the 8 Oct brief, Part B §B6.
import { sizeTrade, sizeFuture } from '../lib/sizer.js';
import { holdTests, otherTypesLine, leveragedLongHoldNote, earningsReactions, exposurePerUnit, exposureRootOf, ccyOfSymbol,
         defaultDrawdown, returnCorrelation, correlationTable, effectiveExposure, exposureStrip, barTone, pairKey, HOLD_DEFAULTS } from '../lib/holdTypes.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// 1 · Trade: entry 100, stop 95, 1R $2,000 → 400 shares.
{
  const t = holdTests({ kind: 'stock', price: 100, entry: 100, stop: 95, atr: 3 });
  eq('1 · Trade: (100 − 95) per share against 1R $2,000 is 400 shares', t.trade.size, 400);
  eq('1 · with no stop typed, the stop is 2 ATR', holdTests({ kind: 'stock', price: 100, atr: 2.5 }).trade.size, 400);
  eq('1 · a future: points × multiplier', holdTests({ kind: 'future', price: 5000, entry: 5000, stop: 4990, multiplier: 50 }).trade.size, 4);
  eq('1 · an option: points on the underlying × |delta| × 100', holdTests({ kind: 'option', price: 100, entry: 100, stop: 95, delta: 0.5 }).trade.size, 8);
}

// 2 · Long hold: high-beta default 50%, budget 2.5% of a $550k family book → about $27.5k of exposure.
{
  const t = holdTests({ kind: 'stock', price: 100, atr: 4, atrPct: 4, settings: { familyBook: 550000 } });
  eq('2 · high-beta (ATR 4% of price) defaults to a 50% bad case', t.long.ddPct, 50);
  eq('2 · max exposure $27,500', t.long.maxExposure, 27500);
  eq('2 · = 275 shares at $100', t.long.size, 275);
  eq('2 · a quieter name defaults to 30%', defaultDrawdown({ atrPct: 1.4 }).pct, 30);
  eq('2 · without the family book it asks for it', holdTests({ kind: 'stock', price: 100, atr: 2 }).long.detail, 'set the family book value');
}

// 3 · Event: last four earnings moves 8%, 12%, 6%, 10% (average 9%), 1R $2,000 → about $22.2k.
{
  const bars = [];
  let px = 100;
  for (let i = 0; i < 300; i++) bars.push({ date: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10), close: px });
  const hit = { 40: 1.08, 120: 0.88, 200: 1.06, 280: 0.90 };   // report-day moves: +8%, −12%, +6%, −10%
  for (let i = 0; i < bars.length; i++) { if (hit[i]) px *= hit[i]; bars[i].close = +px.toFixed(4); }
  const dates = Object.keys(hit).map(i => bars[i].date);
  const r = earningsReactions(bars, dates);
  eq('3 · the four reactions', r.reactions.map(x => Math.round(Math.abs(x.movePct))), [10, 6, 12, 8]);
  eq('3 · averaging 9%', r.avgAbsPct, 9);
  const t = holdTests({ kind: 'stock', price: 50, atr: 1.5, gapPct: r.avgAbsPct, entry: 50, stop: 47 });
  ok(`3 · about $22.2k of exposure (${t.event.maxExposure.toFixed(0)})`, near(t.event.maxExposure, 22222, 1));
  eq('3 · = 444 shares at $50', t.event.size, 444);
  eq('3 · the Trade test shown beside it', otherTypesLine(t, 'event'), `As a Trade, ${t.trade.size} shares; as a Long hold, —.`);
  // A report after the close: the next day carries the gap.
  const late = bars.map(b => ({ ...b }));
  const k = 100; late[k + 1].close = late[k].close * 1.15; for (let i = k + 2; i < late.length; i++) late[i].close = late[k + 1].close;
  eq('3 · a report after the close: the next session is the reaction', earningsReactions(late, [late[k].date], { n: 1 }).reactions[0].movePct, 15);
}

// 4 · 7709: 800 shares at HKD 37.26 — exposure is 2 × value, attributed to SK hynix.
{
  eq('4 · per share: price × 2', exposurePerUnit({ kind: 'stock', price: 37.26, leverage: 2 }), 74.52);
  eq('4 · 800 shares = HKD 59,616 of SK hynix exposure', +(800 * exposurePerUnit({ kind: 'stock', price: 37.26, leverage: 2 })).toFixed(2), 59616);
  eq('4 · attributed to the underlying', exposureRootOf('7709.HK'), '000660.KS');
  eq('4 · priced in HKD', ccyOfSymbol('7709.HK'), 'HKD');
  eq('4 · the leveraged-ETF line on a Long hold', leveragedLongHoldNote('7709.HK', 'long'),
    'Daily-reset 2× ETF: over weeks it does not track 2× the underlying; volatility drag applies. Your rule: leveraged ETFs are 1–3 day trades.');
  eq('4 · and not on a Trade', leveragedLongHoldNote('7709.HK', 'trade'), null);
  // The Trade test uses the ETF's own ATR (it already contains the leverage); HKD converted to USD.
  const t = holdTests({ kind: 'stock', price: 37.26, atr: 2.2, leverage: 2, fx: 0.1286 });
  eq('4 · Trade on the ETF\'s own ATR, in USD: 2 × 2.2 HKD × 0.1286 per share', t.trade.size, Math.floor(2000 / (2 * 2.2 * 0.1286)));
  eq('4 · a leveraged product defaults to the high-beta drawdown', defaultDrawdown({ atrPct: 1, leverage: 2 }).pct, 50);
}

// 5 · Two names with ρ 0.96: near-duplicate, combined against 10%.
{
  const table = { [pairKey('000660.KS', '005930.KS')]: 0.96 };
  const eff = effectiveExposure('000660.KS', { '000660.KS': 15000, '005930.KS': 10000 }, table);
  eq('5 · one group', eff.group.sort(), ['000660.KS', '005930.KS']);
  eq('5 · summed in full', eff.groupUsd, 25000);
  const label = (s) => ({ '000660.KS': 'SK hynix', '005930.KS': 'Samsung' }[s] || s);
  const strip = exposureStrip(eff, 200000, {}, label);
  eq('5 · the near-duplicate warning', strip.warnings[0].text, 'SK hynix and Samsung move together (ρ 0.96): treated as one bet. Combined exposure $25,000 = 12.5% of NLV vs the 10% single-name cap.');
  eq('5 · the group bar is red against 10%', strip.bars.find(b => b.key === 'group').tone, 'red');
}

// 6 · ρ 0.6 contributes 0.6 × its exposure to the cluster, measured against 15%.
{
  const table = { [pairKey('MU', 'AMD')]: 0.6, [pairKey('MU', 'KO')]: 0.2 };
  const eff = effectiveExposure('MU', { MU: 10000, AMD: 20000, KO: 50000 }, table);
  eq('6 · own + 0.6 × AMD; KO below 0.5 adds nothing', eff.cluster, 22000);
  eq('6 · no near-duplicate', eff.group, ['MU']);
  const strip = exposureStrip(eff, 200000);
  eq('6 · 11% of NLV against the 15% guide: green', [strip.bars[2].pct, strip.bars[2].cap, strip.bars[2].tone], [11, 15, 'green']);
  eq('6 · amber from 80% of the guide', [barTone(12, 15), barTone(11.9, 15), barTone(15.1, 15)], ['amber', 'green', 'red']);
  const big = exposureStrip(effectiveExposure('MU', { MU: 20000, AMD: 20000 }, table), 200000);
  ok('6 · over 15%: the cluster warning names the contributors', big.warnings.some(w => w.level === 'cluster' && /16% of NLV \(cap guide 15%\)\. Largest contributors: MU \$20,000, AMD \$12,000 \(ρ 0\.60\)/.test(w.text)));
}

// 7 · Nothing blocks: every output is a number or a sentence.
{
  const t = holdTests({ kind: 'stock', price: 100, atr: 2, settings: { familyBook: 550000, oneR: 2000 } });
  ok('7 · the tests return sizes, never a refusal', ['trade', 'long', 'event'].every(k => !('blocked' in t[k])));
  const s = exposureStrip(effectiveExposure('X', { X: 1e6 }, {}), 100000);
  ok('7 · a warning is text', s.warnings.every(w => typeof w.text === 'string'));
}

// Correlation of daily returns over 120 sessions.
{
  const mk = (f) => Array.from({ length: 200 }, (_, i) => [new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString().slice(0, 10), f(i)]);
  const a = mk(i => 100 * Math.exp(0.01 * Math.sin(i * 1.7)));
  const twin = mk(i => 50 * Math.exp(0.01 * Math.sin(i * 1.7)));
  const other = mk(i => 80 * Math.exp(0.01 * Math.cos(i * 2.9)));
  eq('ρ of a series with its scaled twin is 1', returnCorrelation(a, twin), 1);
  ok('ρ with an unrelated series is small', Math.abs(returnCorrelation(a, other)) < 0.5);
  eq('the table keys every pair once', Object.keys(correlationTable({ A: a, B: twin, C: other })).sort(), ['A|B', 'A|C', 'B|C']);
  eq('too few common dates is no reading', returnCorrelation(a.slice(0, 10), twin.slice(0, 10)), null);
  eq('settings default', [HOLD_DEFAULTS.oneR, HOLD_DEFAULTS.ddBudgetPct, HOLD_DEFAULTS.singleNamePct, HOLD_DEFAULTS.clusterPct], [2000, 2.5, 10, 15]);
}


// Through the sizer: the hold type's test stands where the ATR test stood; the caps still apply.
{
  const base = { kind: 'stock', symbol: 'ABC', price: 100, atr: 2.5, atrPct: 2.5, nlv: 215000 };
  const plain = sizeTrade(base);
  eq('sizer · without a hold type nothing changes', plain.tests[0].name, 'ATR test');
  const t = sizeTrade({ ...base, hold: { type: 'trade', entry: 100, stop: 95 } });
  eq('sizer · Trade replaces the ATR test', t.tests.map(x => [x.name, x.size]), [['Trade test', 400], ['Concentration cap (10%)', 215]]);
  eq('sizer · and the cap still binds', [t.size, t.binding], [215, 'Concentration cap (10%)']);
  eq('sizer · all three come back for the panel', Object.keys(t.hold.tests), ['trade', 'long', 'event']);
  const l = sizeTrade({ ...base, hold: { type: 'long', settings: { familyBook: 550000 } } });
  eq('sizer · Long hold: 30% bad case on a 2.5%-ATR name → $45,833 → 458 shares, capped at 215', [l.tests[0].size, l.size], [458, 215]);
  const f = sizeFuture({ family: 'MES', price: 6000, atr: 60, atrPct: 1, nlv: 215000, hold: { type: 'trade' } });
  ok('sizer · a future carries the hold test through', f.ok && f.main.tests[0].name === 'Trade test' && f.main.tests[0].size === Math.floor(2000 / (2 * 60 * 5)));
  const z = sizeTrade({ kind: 'option', symbol: 'SPY', price: 700, atr: 7, delta: 0.5, mark: 1, expiry: '2026-10-08', now: new Date('2026-10-08T15:00:00Z'), nlv: 215000, hold: { type: 'trade' } });
  ok('sizer · 0DTE keeps its own rules', !z.hold);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
