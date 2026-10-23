// test/wallRoll.test.mjs — the wall roll: each monthly's call and put wall, session to session,
// read in English. Hand-made rows whose answers are known by construction.
import { expiryPeaks, wallRoll, callRead, putRead, boxVerdict, swing, ROLL_READ_SESSIONS } from '../lib/wallRoll.js';
import { backfillPeaks, RAW_KEY } from '../lib/gexStore.js';
import { feedLeaks, gexFeedPayload, wallRollBlock } from '../lib/gexFeed.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// ── expiryPeaks: the heatmap's ringed cell either side, per dated expiry ──
{
  const grid = {
    expiries: [{ expiry: '2026-11-20', peakCallStrike: 800, peakPutStrike: 750 }, { expiry: 'other', peakCallStrike: 1, peakPutStrike: 1 }],
    cells: [{ expiry: '2026-11-20', strike: 800, netGexUsd: 339.4 }, { expiry: '2026-11-20', strike: 750, netGexUsd: -240.6 }],
  };
  eq('one row per dated expiry, with the gamma at each wall', expiryPeaks(grid), [{ e: '2026-11-20', c: 800, p: 750, cv: 339, pv: -241 }]);
  eq('no grid, no rows', expiryPeaks(null), []);
}

// ── a SPY-like history: November's box shifting up with the price ──
const day = (date, spot, nov, dec, oct = null) => ({ date, spot, expiryPeaks: [
  ...(oct ? [{ e: '2026-10-16', c: oct[0], p: oct[1] }] : []),
  { e: '2026-10-23', c: 790, p: 769 },
  { e: '2026-11-20', c: nov[0], p: nov[1] }, { e: '2026-12-18', c: dec[0], p: dec[1] }] });
const rows = [
  { date: '2026-10-01', spot: 760 },                                   // before the log: skipped
  day('2026-10-05', 762, [790, 740], [810, 735], [775, 760]),
  day('2026-10-06', 765, [790, 740], [810, 735], [780, 765]),
  day('2026-10-07', 768, [795, 745], [810, 735], [780, 765]),
  day('2026-10-08', 770, [795, 745], [810, 735], [780, 770]),
  day('2026-10-09', 772, [800, 750], [810, 735], [785, 770]),
  day('2026-10-12', 776, [800, 750], [810, 735], [785, 772]),
];
{
  const w = wallRoll(rows, { today: '2026-10-13', symbol: 'SPY' });
  eq('the monthlies still to come are tracked, a weekly is not', w.expiries.map(e => e.expiry), ['2026-10-16', '2026-11-20', '2026-12-18']);
  const nov = w.expiries[1];
  eq('November over the last week: calls 790 → 800, puts 740 → 750, SPY +1.84%',
    [nov.call.from, nov.call.to, nov.put.from, nov.put.to, nov.spot_pct], [790, 800, 740, 750, 1.84]);
  eq('…two steps each side', [nov.call.steps, nov.put.steps], [2, 2]);
  eq('…read: ceiling lifting with the rally', nov.read.call.text.startsWith('Ceiling lifting with the rally: the Nov 20 call wall moved 790 → 800 as SPY rose 1.8%'), true);
  eq('…hedges rolled up, a sign of confidence', [nov.read.put.tone, nov.read.put.text.includes('a sign of confidence')], ['up', true]);
  eq('…the whole box shifting up with the price', nov.read.box, 'The whole box is shifting up with the price: calls and hedges both rolled higher.');
  eq('…the box today, and its width', nov.box, { put: 750, call: 800, width_pct: 6.4 });
  const dec = w.expiries[2];
  eq('December unchanged: both walls holding', [dec.read.call.text.startsWith('Ceiling unchanged at 810'), dec.read.box], [true, 'The box is unchanged.']);
  eq('the path is the logged sessions only, oldest first', nov.path.map(p => p.date), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']);
  eq('the read window is about a week', ROLL_READ_SESSIONS, 5);
  eq('the feed\'s banned words never appear in the read', feedLeaks(JSON.stringify(w)), []);
  const today = wallRoll(rows, { today: '2026-10-17', symbol: 'SPY' });
  eq('an expired monthly drops out', today.expiries.map(e => e.expiry), ['2026-11-20', '2026-12-18']);
  eq('nothing logged: unavailable, with a reason', wallRoll([{ date: '2026-10-01', spot: 1 }]), { available: false, reason: 'no wall history logged yet' });
  const one = wallRoll([day('2026-10-12', 776, [800, 750], [810, 735])], { today: '2026-10-13' });
  eq('one session: no read yet, and it says why', [one.expiries[0].read, one.expiries[0].reason], [null, 'one session logged — the roll shows from the next capture']);
}

// ── every branch of the English, against the price ──
{
  const up = 1.2, dn = -1.4, flat = 0.1;
  ok('calls up, price flat: new call open interest higher up', callRead('QQQ', '2026-11-20', 760, 775, flat).text.includes('Ceiling lifted without the price'));
  ok('calls down, price down: following price down', callRead('QQQ', '2026-11-20', 775, 760, dn).text.startsWith('Ceiling following price down'));
  ok('calls down, price up: ceiling lowered, rallies stall sooner', callRead('QQQ', '2026-11-20', 775, 760, up).text.includes('rallies are likely to stall nearer 760'));
  eq('puts up, price flat: protection moving closer — a warning', putRead('QQQ', '2026-11-20', 720, 730, flat).tone, 'warn');
  ok('puts up, price down: also a warning', putRead('QQQ', '2026-11-20', 720, 730, dn).text.includes('a warning'));
  ok('puts down, price down: reset lower', putRead('QQQ', '2026-11-20', 730, 720, dn).text.startsWith('Hedges following price down'));
  ok('puts down, price up: pushed further away', putRead('QQQ', '2026-11-20', 730, 720, up).text.startsWith('Hedges pushed further away'));
  eq('the box: widening and narrowing', [boxVerdict('up', 'down'), boxVerdict('down', 'up')],
    ['The box is widening: a bigger range is being priced either way.', 'The box is narrowing: walls closing in, a pin is building.']);
  eq('one side moved, the other held: no box verdict', boxVerdict('up', 'same'), null);
  eq('puts up with the calls, price flat: the range reset, not a scramble', [putRead('SPY', '2026-11-20', 740, 750, flat, 'up').tone,
    putRead('SPY', '2026-11-20', 740, 750, flat, 'up').text.startsWith('Hedges stepped up with the calls: the Nov 20 put wall moved 740 → 750')], ['neutral', true]);
  eq('…but puts up alone, price flat: still the warning', putRead('SPY', '2026-11-20', 740, 750, flat, 'same').tone, 'warn');
  eq('the box against the price', [boxVerdict('up', 'up', 'flat'), boxVerdict('down', 'down', 'up')],
    ['The whole box stepped up without the price: the range being priced is moving higher.', 'The whole box stepped down without the price: the range being priced is moving lower — a caution.']);
}

// ── the backfill: from the kept raw chain, bounded, never past the retention cutoff ──
{
  const chain = [
    { expiry: '2026-11-20', type: 'call', strike: 800, oi: 1000, iv: 0.15 },
    { expiry: '2026-11-20', type: 'put', strike: 750, oi: 1000, iv: 0.18 },
  ];
  const store = { [RAW_KEY('SPY', '2026-10-08')]: { spot: 770, asOf: '2026-10-08T20:00:00Z', contracts: chain } };
  const getJson = async (k) => store[k] ?? null;
  const rs = [{ date: '2026-09-01', spot: 700 }, { date: '2026-10-07', spot: 768 }, { date: '2026-10-08', spot: 770 }, { date: '2026-10-09', spot: 772, expiryPeaks: [{ e: 'x' }] }];
  const out = await backfillPeaks('SPY', rs, '2026-09-15', { getJson });
  eq('older than the cutoff: left alone', out[0].expiryPeaks, undefined);
  eq('no raw kept: marked empty so it is not retried', out[1].expiryPeaks, []);
  eq('raw kept: the walls rebuilt from it', out[2].expiryPeaks.map(p => [p.e, p.c, p.p]), [['2026-11-20', 800, 750]]);
  eq('already logged: untouched', out[3].expiryPeaks, [{ e: 'x' }]);
  const capped = await backfillPeaks('SPY', rs, '2026-09-15', { getJson, limit: 1 });
  eq('bounded per run', [capped[1].expiryPeaks, capped[2].expiryPeaks], [[], undefined]);
}
// ── the feed carries it (and the MCP board, which is the feed's payload) ──
{
  const w = wallRoll(rows, { today: '2026-10-13', symbol: 'SPY' });
  const f = gexFeedPayload('SPY', { row: { spot: 776, asOf: '2026-10-13T14:00:00Z' } }, { today: '2026-10-13', wallRoll: w });
  eq('wall_roll on the feed: one block per tracked monthly, the read as plain text', [f.wall_roll.available, f.wall_roll.expiries.length, typeof f.wall_roll.expiries[1].read.call], [true, 3, 'string']);
  eq('…with the path but not the per-wall gamma', Object.keys(f.wall_roll.expiries[1].path[0]), ['date', 'spot', 'call', 'put']);
  eq('…and no banned word anywhere in the payload', feedLeaks(JSON.stringify(f)), []);
  eq('no roll passed (SPX): no field at all', 'wall_roll' in gexFeedPayload('SPX', { row: { spot: 1 } }, { today: '2026-10-13' }), false);
  eq('nothing logged: unavailable with its reason', wallRollBlock(wallRoll([])), { available: false, reason: 'no wall history logged yet' });
}
// ── A WALL SWINGING BETWEEN STRIKES (23 Oct, the QQQ card) ──
{
  const q = (date, spot, nov, dec) => ({ date, spot, expiryPeaks: [{ e: '2026-11-20', c: nov[0], p: nov[1] }, { e: '2026-12-18', c: dec[0], p: dec[1] }] });
  const qq = [
    q('2026-10-15', 726, [760, 720], [760, 690]), q('2026-10-16', 710, [760, 700], [760, 690]),
    q('2026-10-19', 718, [760, 700], [760, 690]), q('2026-10-20', 718, [775, 700], [780, 690]),
    q('2026-10-21', 725, [775, 700], [780, 690]), q('2026-10-22', 703, [760, 700], [770, 690]),
  ];
  const w = wallRoll(qq, { today: '2026-10-23', symbol: 'QQQ' });
  const [nov, dec] = w.expiries;
  eq('a wall back where it started after a swing is unsettled, not unchanged', [nov.call.dir, nov.call.zone], ['unsettled', { lo: 760, hi: 775, now: 760 }]);
  eq('…and says so', nov.read.call.text, 'Ceiling unsettled: the Nov 20 call wall has swung between 760 and 775 this week (now 760) while QQQ fell 3.2% — two strikes of near-equal weight trading places, so read it as a 760–775 zone, not a move.');
  eq('760 → 780 → 770 against a falling price is a zone, not a lifted ceiling', [dec.call.dir, dec.call.zone, /lifted/.test(dec.read.call.text)], ['unsettled', { lo: 760, hi: 780, now: 770 }, false]);
  eq('a single step down stays a move', [nov.put.dir, /Hedges following price down/.test(nov.read.put.text)], ['down', true]);
  eq('an unsettled side makes no box claim', [nov.read.box, dec.read.box], [null, null]);
  eq('steps in one direction are not a swing', swing([{ c: 790 }, { c: 795 }, { c: 800 }], 'c'), null);
  eq('no change at all is not a swing', swing([{ c: 790 }, { c: 790 }], 'c'), null);
  eq('both sides swinging: the box edges are zones', boxVerdict('unsettled', 'unsettled'), 'Both walls are swinging between strikes: the box edges are zones this week, not lines.');
  ok('feed-safe wording', !feedLeaks(JSON.stringify(w)).length);
}
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
