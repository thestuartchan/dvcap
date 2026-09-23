// test/commandBar.test.mjs — one line to add a trade (console rework, Step 4a).
import { parseCommand, resolveCandidates, commandRow, commandSummary } from '../lib/commandBar.js';
import { derivePosition } from '../lib/positions.js';
import { stateOf } from '../lib/lifecycle.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const pick = (p) => ({ symbol: p.symbol, side: p.side, instrument: p.instrument, qty: p.qty, price: p.price, error: p.error });

// ── THE BRIEF'S TWO LINES ────────────────────────────────────────────────────
{
  eq('SOFI long shares 500 @ 16.675', pick(parseCommand('SOFI long shares 500 @ 16.675')), { symbol: 'SOFI', side: 'long', instrument: 'shares', qty: 500, price: 16.675, error: null });
  eq('SOFI long spread', pick(parseCommand('SOFI long spread')), { symbol: 'SOFI', side: 'long', instrument: 'spread', qty: null, price: null, error: null });
  eq('→ OPEN in one action', commandSummary(parseCommand('SOFI long shares 500 @ 16.675')), 'SOFI · LONG · shares · 500 @ 16.675 → OPEN');
  eq('→ WATCHING with no fill', commandSummary(parseCommand('SOFI long spread')), 'SOFI · LONG · spread → WATCHING');
}

// ── EVERY WORD BUT THE TICKER IS OPTIONAL, IN ANY ORDER ──────────────────────
{
  eq('a bare ticker is a long share setup', pick(parseCommand('sofi')), { symbol: 'SOFI', side: 'long', instrument: 'shares', qty: null, price: null, error: null });
  eq('short first, then the fill', pick(parseCommand('AAPU short 300@41.2')), { symbol: 'AAPU', side: 'short', instrument: 'shares', qty: 300, price: 41.2, error: null });
  eq('"at" reads as @', pick(parseCommand('MNQ 2 at 21050 future long')), { symbol: 'MNQ', side: 'long', instrument: 'future', qty: 2, price: 21050, error: null });
  eq('a known futures root defaults to future', parseCommand('MGC').instrument, 'future');
  eq('a stock does not', parseCommand('MET').instrument, 'shares');
  eq('buy/sell are directions too', [parseCommand('X buy').side, parseCommand('X sell').side], ['long', 'short']);
  eq('stock/etf/opt/fut are instruments', [parseCommand('X stock').instrument, parseCommand('X etf').instrument, parseCommand('X opt').instrument, parseCommand('X fut').instrument], ['shares', 'shares', 'option', 'future']);
  eq('a whole contract is an option on its root', [parseCommand("QQQ Oct16'26 730C").symbol, parseCommand("QQQ Oct16'26 730C").instrument], ['QQQ', 'option']);
  eq('nothing typed asks for a ticker', parseCommand('').error, 'a ticker to start');
  ok('a quantity without a price is refused', /qty @ price/.test(parseCommand('SOFI 500').error));
  ok('a word it does not know is named', /did not understand "tomorrow"/.test(parseCommand('SOFI long tomorrow').error));
  ok('a zero quantity is refused', /above zero/.test(parseCommand('SOFI 0 @ 10').error));
  eq('a suffixed ticker survives', parseCommand('0981.HK long').symbol, '0981.HK');
}

// ── WHERE A BARE CODE LIVES ──────────────────────────────────────────────────
{
  eq('7709 is Hong Kong, zero-padded', resolveCandidates('7709').map(c => c.symbol), ['7709.HK']);
  eq('981 pads to 0981.HK', resolveCandidates('981').map(c => c.symbol), ['0981.HK']);
  eq('005930 is Korea, KOSPI then KOSDAQ', resolveCandidates('005930').map(c => c.symbol), ['005930.KS', '005930.KQ']);
  eq('COIL is a futures root', [resolveCandidates('COIL')[0].symbol, resolveCandidates('COIL')[0].future], ['COIL', true]);
  eq('SOFI is itself', resolveCandidates('SOFI').map(c => c.symbol), ['SOFI']);
  eq('a suffixed symbol is taken as typed', resolveCandidates('ASML.AS').map(c => c.why), ['as typed']);
  eq('nothing is nothing', resolveCandidates(''), []);
}

// ── THE ROW ──────────────────────────────────────────────────────────────────
{
  const r = commandRow(parseCommand('SOFI long shares 500 @ 16.675'), { date: '2026-09-24' });
  ok('a row', !!r.row);
  eq('opens as OPEN', r.opensAs, 'OPEN');
  eq('one buy fill', [r.row.fills.length, r.row.fills[0].side, r.row.fills[0].qty, r.row.fills[0].price, r.row.fills[0].date], [1, 'buy', 500, 16.675, '2026-09-24']);
  eq('shares, not margined', [r.row.instrument, r.row.margined ?? false], ['shares', false]);
  const d = derivePosition(r.row.fills, { side: r.row.side });
  eq('and the engine agrees: OPEN, 500 at 16.675', [stateOf({ derived: d }), d.qty, d.avgCost], ['OPEN', 500, 16.675]);
  const w = commandRow(parseCommand('SOFI short'), {});
  eq('no fill: WATCHING, a short', [w.opensAs, w.row.side, w.row.fills], ['WATCHING', 'short', []]);
  eq('a known future carries its multiplier', [commandRow(parseCommand('MGC long')).row.multiplier, commandRow(parseCommand('MGC long')).row.margined], [10, true]);
  eq('a short opens on a sell', commandRow(parseCommand('AAPU short 300 @ 41.2')).row.fills[0].side, 'sell');
  eq('the resolved symbol wins over the typed one', commandRow(parseCommand('7709 long'), { resolved: { symbol: '7709.HK' } }).row.symbol, '7709.HK');
  ok('a spread is refused here — its legs come from the table', /legs from the table/.test(commandRow(parseCommand('SOFI long spread')).error));
  ok('an error is passed through', /ticker/.test(commandRow(parseCommand('')).error));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
