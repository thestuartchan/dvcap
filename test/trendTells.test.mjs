// test/trendTells.test.mjs — the trend-day tells and their fifteen-year rates (lib/trendTells.js).
import { tellsFor, tellsHeadline, shownTells, firstHourBands, BACKTEST, BASE_RATE } from '../lib/trendTells.js';
import { parseDix, gexPercentile } from '../lib/squeeze.js';
import { firstHourFrom } from '../lib/yahoo.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

// 8 Oct before the open: VIX 15.08 / VIX3M 17.72 at the 7 Oct close; gamma and prior-close location illustrative.
{
  const t = tellsFor({ vixPrev: 15.08, vix3mPrev: 17.72, gexPct: 0.92, prevLoc: 0.88 });
  const by = Object.fromEntries(t.map(x => [x.key, x]));
  eq('the VIX bucket and its rate', [by.vix.bucket, by.vix.rate, by.vix.word], ['14–16', 23.5, 'about average']);
  eq('the curve: lower is steeper, and steep has meant fewer trend days', [by.curve.bucket, by.curve.rate, by.curve.word], ['0.85–0.9', 23.1, 'about average']);
  ok('the curve in words: VIX3M x% above VIX', /contango: VIX3M 18% above VIX/.test(by.curve.text));
  eq('high dealer gamma: fewer trend days', [by.gex.bucket, by.gex.rate, by.gex.word], ['0.8–1.01', 18.4, 'less often']);
  eq('the gap and the first hour wait for their time', [by.gap.text, by.firstHour.text], ['known at the open', 'known at 10:30 New York']);
  ok('the flip says it has no long record', /no long record/.test(by.flip.text) || by.flip.text === 'known at the open');
  eq('the headline before the open: the lean, then the first hour in points', tellsHeadline(t, { atr: 9.15, symbol: 'QQQ' }),
    'Before the open the lean is toward fewer trend days than usual — range more likely. The first hour decides: QQQ ±4.58 or more from the open by 10:30 → 59% trend days; inside ±1.83 → 8%.');
  eq('only the tells that move the odds are shown', shownTells(t).map(x => x.key), ['firstHour', 'curve', 'gex', 'gap']);
  eq('the bands in points', firstHourBands(9.15), { trend: 4.58, range: 1.83 });
}
// After 10:30: the first hour leads.
{
  const t = tellsFor({ vixPrev: 18, vix3mPrev: 19, firstHourAtr: -0.62, gapAtr: 0.3, openVsFlipAtr: 1.1 });
  const fh = t.find(x => x.key === 'firstHour');
  eq('a 0.62 ATR first hour', [fh.bucket, fh.rate, fh.word], ['0.5–0.75 ATR', 59.4, 'strong']);
  eq('the headline is the first hour', tellsHeadline(t), 'The first hour moved 0.5–0.75 ATR: 59.4% of such days became trend days (2.86× the 20.8% base), and trend days have gone the first hour\'s way 96–100% of the time.');
  ok('the open against the flip, in ATR, with its caveat', /\+1\.10 ATR above — no long record/.test(t.find(x => x.key === 'flip').text));
  eq('a quiet first hour reads as a range day', tellsHeadline(tellsFor({ firstHourAtr: 0.05 })).startsWith('A quiet first hour'), true);
  eq('an inverted curve', tellsFor({ vixPrev: 30, vix3mPrev: 27 }).find(x => x.key === 'curve').rate, 31.6);
}
// The fifteen-year table is whole.
{
  ok('every table covers 0 upward without gaps', Object.entries(BACKTEST).filter(([k]) => k !== 'source').every(([, rows]) => rows[0][0] === 0 && rows.every((r, i) => i === 0 || r[0] === rows[i - 1][1])));
  eq('the base rate', BASE_RATE, 24.1);
}
// SqueezeMetrics' CSV and the percentile against the trailing year.
{
  const csv = 'date,price,dix,gex\n' + Array.from({ length: 260 }, (_, i) => `2025-01-${String(i).padStart(3, '0')},1,0.4,${i}`).join('\n');
  const rows = parseDix(csv.replace(/2025-01-(\d{3})/g, (_, n) => new Date(Date.UTC(2025, 0, 1) + n * 86400000).toISOString().slice(0, 10)));
  eq('parsed', rows.length, 260);
  eq('the newest value above every one of the year before it', gexPercentile(rows, rows[259][0]), 1);
  eq('too early for a year', gexPercentile(rows, rows[100][0]), null);
}
// The first hourly bar of each session from Yahoo's 60m series (EDT, −4h).
{
  const t = (iso) => Date.parse(iso) / 1000;
  const res = { meta: { gmtoffset: -14400 }, timestamp: [t('2026-10-07T13:30:00Z'), t('2026-10-07T14:30:00Z'), t('2026-10-08T13:30:00Z')],
    indicators: { quote: [{ open: [753.79, 755, 757], close: [755.2, 756, 754.1] }] } };
  eq('09:30 bars only, by date', firstHourFrom(res), { '2026-10-07': { open: 753.79, close: 755.2 }, '2026-10-08': { open: 757, close: 754.1 } });
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
