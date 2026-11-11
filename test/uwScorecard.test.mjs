// test/uwScorecard.test.mjs — UW build step 13 (lib/uwScorecard.js, lib/routes/flow.js scorecardOut):
// outcomes from daily closes, hit rates against the trivial guess with a Wilson range, the day count,
// and the card sent once on day 60 to the private channel. Made-up numbers only.
import { outcomesOf, wilson, scoreSignal, scorecard, scorecardCard, SIGNALS } from '../lib/uwScorecard.js';
import { scorecardOut, UW_SCORECARD_POSTED_KEY, UW_DAILY_KEY } from '../lib/routes/flow.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const memKv = () => { const m = new Map(); return { m, configured: () => true, get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };

// ── outcomes ──
const o = outcomesOf([{ date: '2030-01-02', close: 100 }, { date: '2030-01-03', close: 101 }, { date: '2030-01-06', close: 99.99 }]);
eq('outcomes: first bar has no prior close', o['2030-01-02'], undefined);
eq('outcomes: same-day move', +o['2030-01-03'].same.toFixed(4), 0.01);
eq('outcomes: next-day move', +o['2030-01-03'].next.toFixed(4), -0.01);
eq('outcomes: last bar has no next day', o['2030-01-06'].next, null);

// ── Wilson ──
eq('wilson: 50 of 100', wilson(50, 100), { lo: 0.404, hi: 0.596 });
eq('wilson: nothing', wilson(0, 0), { lo: null, hi: null });

// ── one signal ──
const days = Array.from({ length: 40 }, (_, i) => new Date(Date.UTC(2030, 0, 1) + i * 86400000).toISOString().slice(0, 10));
const sig = SIGNALS.find(s => s.id === 'QQQ_net');
// Perfect next-day forecaster: flow sign always equals the next move.
const outs = Object.fromEntries(days.map((d, i) => [d, { same: 0.01, next: i % 2 ? 0.01 : -0.01 }]));
const perfect = days.map((date, i) => ({ date, QQQ_net: i % 2 ? 5 : -5 }));
const p = scoreSignal(perfect, { QQQ: outs }, sig, 'next');
eq('signal: a perfect forecaster beats chance', [p.n, p.rate, p.guess, p.verdict], [40, 1, 0.5, 'beats chance']);
const flat = days.map((date) => ({ date, QQQ_net: 5 }));
const f = scoreSignal(flat, { QQQ: outs }, sig, 'next');
eq('signal: always-bullish on a balanced tape is no edge', [f.rate, f.verdict], [0.5, 'no edge']);
eq('signal: always-bullish matches the trivial guess on an up tape (no edge)', scoreSignal(flat, { QQQ: outs }, sig, 'same').verdict, 'no edge');
eq('signal: under 20 days is too few', scoreSignal(perfect.slice(0, 10), { QQQ: outs }, sig, 'next').verdict, 'too few');
eq('signal: zero flow and missing moves left out', scoreSignal([{ date: days[0], QQQ_net: 0 }, { date: '2031-01-01', QQQ_net: 1 }], { QQQ: outs }, sig, 'next').n, 0);

// ── the scorecard ──
const sc = scorecard({ rows: perfect, outcomes: { QQQ: outs, SPY: outs }, today: '2030-01-10',
  gamma: { SAMPLE: { sessions: 5, checks: { flip: { agree: 4, of: 5 }, regime: { agree: 5, of: 5 } }, medianFlipGapPct: 0.2 } } });
eq('scorecard: day counted from the first kept row', [sc.start, sc.day, sc.due, sc.dueDate], ['2030-01-01', 10, false, '2030-03-01']);
eq('scorecard: the read names the edge', sc.read, 'Next-day edge: QQQ net premium.');
eq('scorecard: gamma agreement summed over checks', [sc.gamma[0].agree, sc.gamma[0].of, sc.gamma[0].rate], [9, 10, 0.9]);
eq('scorecard: early days say so', scorecard({ rows: perfect.slice(0, 3), outcomes: { QQQ: outs, SPY: outs }, today: '2030-01-03' }).read, 'Too early: 3 flow days so far; a signal needs 20.');
eq('scorecard: nothing kept', scorecard({ rows: [], today: '2030-01-03' }).read, 'No flow days kept yet.');
const card = scorecardCard(sc);
eq('card: private footer', /private channel only/.test(card.embeds[0].footer.text), true);
eq('card: ends with your call', card.embeds[0].fields.at(-1).name, 'Your call');
eq('card: no mentions', card.allowed_mentions, { parse: [] });

// ── sent once, on day 60 ──
const env = { DISCORD_PRIVATE_WEBHOOK: 'https://discord.com/api/webhooks/1/tok' };
const kv = memKv(); const sent = []; let barCalls = 0;
const deliver = async (hook, payload) => { sent.push(payload); return 'msg-1'; };
const bars = async () => { barCalls++; return days.map((date, i) => ({ date, close: 100 + i })); };
kv.m.set(UW_DAILY_KEY, perfect);
eq('out: before day 60 it only counts (no price fetch)', [await scorecardOut({ kv, deliver, env, bars, now: new Date('2030-01-20T21:15:00Z') }), barCalls], ['day 20 of 60', 0]);
eq('out: day 60 posts', await scorecardOut({ kv, deliver, env, bars, now: new Date('2030-03-01T21:15:00Z') }), 'posted');
eq('out: card went out once', [sent.length, !!kv.m.get(UW_SCORECARD_POSTED_KEY)], [1, true]);
eq('out: never twice', await scorecardOut({ kv, deliver, env, bars, now: new Date('2030-03-02T21:15:00Z') }), 'already sent');
eq('out: no rows yet', await scorecardOut({ kv: memKv(), deliver, env, bars }), 'no flow days yet');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
