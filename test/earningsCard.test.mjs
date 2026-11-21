// lib/earningsCard.js — which names go on the weekly earnings card, and the star cap.
import { qualifies, selectRows, capStars, cardHtml, weekDays, PER_SLOT_MAX, STAR_CAP } from '../lib/earningsCard.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w); if (a === b) { pass++; console.log('✅', n); } else { fail++; console.log('❌', n, ' got', a, 'want', b); } };
const ok = (n, c) => eq(n, !!c, true);
const row = (symbol, cap, oi, time = 'postmarket', date = '2026-11-23') => ({ symbol, marketcap: String(cap), oi, report_time: time, report_date: date, curr: '50', implied_move: '5', full_name: symbol });

ok('$5B+ with a confirmed slot is on', qualifies(row('AAA', 6e9, 10)));
ok('$1–5B with 75K+ OI is on', qualifies(row('BBB', 2e9, 80000)));
ok('$1–5B with thin options is off', !qualifies(row('CCC', 2e9, 74999)));
ok('under $1B is off however busy', !qualifies(row('DDD', 9e8, 900000)));
ok('an unconfirmed time is off', !qualifies(row('EEE', 9e10, 10, 'unknown')));

const { rows } = selectRows([row('AAA', 6e9, 10), row('FFF', 9e9, 10), row('AAA', 6e9, 10), row('GGG', 7e9, 1, 'premarket', '2026-11-24')]);
eq('biggest first within a slot, duplicates dropped, days in order', rows.map(r => r.ticker), ['FFF', 'AAA', 'GGG']);
eq('implied move shown as percent of price', rows[0].impliedPct, 10);
eq('slot mapped', rows[2].slot, 'bmo');
const many = Array.from({ length: PER_SLOT_MAX + 3 }, (_, i) => row(`Z${i}`, 6e9 + i, 1));
eq('a slot holds at most PER_SLOT_MAX names', selectRows(many).rows.length, PER_SLOT_MAX);
eq('…and the overflow is reported', selectRows(many).dropped.length, 3);

const r6 = selectRows(Array.from({ length: 7 }, (_, i) => row(`S${i}`, 6e9, 1))).rows;
eq('stars capped at five', capStars(['S0', 'S1', 'S2', 'S3', 'S4', 'S5'], r6).length, STAR_CAP);
eq('a star for a name not on the card is dropped', capStars(['NOPE', 's1'], r6), ['S1']);

eq('the week runs Monday to Friday', weekDays('2026-11-23').map(d => d.label), ['Mon 23', 'Tue 24', 'Wed 25', 'Thu 26', 'Fri 27']);
const html = cardHtml({ monday: '2026-11-23', rows, stars: ['AAA'], notes: { '2026-11-26': 'Market closed' }, headerRight: 'a\nb' });
ok('the star sits beside the ticker', html.includes('AAA<span class="star">★</span>'));
ok('holiday note shown', html.includes('Market closed'));
ok('a day with nothing says so', html.includes('No major reports'));
ok('text is escaped', cardHtml({ monday: '2026-11-23', rows: [], headerRight: '<b>x</b>' }).includes('&lt;b&gt;x'));
ok('header names the week', html.includes('Week of Nov 23, 2026'));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
