// test/uwGamma.test.mjs — UW build step 11 (lib/uwGamma.js): UW's open-interest gamma book read into
// the CBOE comparison's shape, scored on dvcap's definitions plus flip and regime, kept per capture
// moment, and tallied into the running score. Fake ticker and made-up numbers only.
import { uwStrikeBook, flipChecks, uwGammaCheck, keepUwGamma, uwGammaScore, UW_GAMMA_KEY, UW_GAMMA_HEALTH_KEY } from '../lib/uwGamma.js';
import { compareGex } from '../lib/cboe.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// UW's shape: strings, call gamma positive, put gamma negative.
const strike = (k, c, p, extra = {}) => ({ ticker: 'SAMPLE', strike: String(k), call_gamma_oi: String(c), put_gamma_oi: String(p), price: '100.5', time: '2030-01-02T15:15:00Z', ...extra });
const rows = [strike(95, 1e6, -9e6), strike(98, 2e6, -4e6), strike(100, 5e6, -3e6), strike(102, 8e6, -1e6), strike(104, 3e6, -0.5e6)];

// ── the book ──
const book = uwStrikeBook({ data: rows });
eq('book: call wall = heaviest call gamma', book.callWall, 102);
eq('book: put wall = heaviest put gamma', book.putWall, 95);
eq('book: put side stored as a magnitude', book.byStrike[0].put, 9e6);
eq('book: net at the put wall is negative', book.putWallNet, -8e6);
eq('book: spot from the rows', book.spot, 100.5);
eq('book: strike count', book.strikes, 5);
eq('book: empty answer → null', uwStrikeBook({ data: [] }), null);
eq('book: junk rows skipped', uwStrikeBook([{ strike: 'x' }]), null);

// ── flip and regime ──
const f = flipChecks(99, 99.3, 100);
eq('flip: within 0.5% of spot is near', f[0].state, 'near');
eq('flip: gap in % of spot', f[0].gapPct, 0.3);
eq('regime: both above → match', f[1].state, 'match');
const f2 = flipChecks(99, 101, 100);
eq('flip: 2% apart differs', f2[0].state, 'differ');
eq('regime: opposite sides differ', f2[1].state, 'differ');
eq('flip: missing side is unknown', flipChecks(null, 99, 100)[0].state, 'unknown');

// ── vendor wording on the shared comparison ──
const cmpUw = compareGex({ spot: 100, callWall: 102, putWall: 95 }, { callWall: 104, putWall: 95, spot: 100 }, { vendor: 'UW' });
eq('compareGex: verdict names the vendor', /UW/.test(cmpUw.verdict) && !/CBOE/.test(cmpUw.verdict), true);
eq('compareGex: CBOE stays the default', /CBOE/.test(compareGex({ spot: 100, callWall: 102 }, { callWall: 102, spot: 100 }).verdict), true);

// ── one symbol, one moment ──
const calls = [];
const get = async (path, o = {}) => {
  calls.push({ path, query: o.query });
  if (/spot-exposures\/strike/.test(path)) return { data: rows };
  if (/gex-levels/.test(path)) return { data: { call_wall: '102', put_wall: '95', gamma_flip: '99.2', gamma_magnet: '100', source: 'oi' } };
  throw new Error('unexpected');
};
const ours = { spot: 100, callWall: 102, putWall: 95, flipLevel: 99 };
const levels = { callWall: { strike: 102, source: 'largest positive net node above spot' }, support: { strike: 98 }, trapdoor: { near: { strike: 95 } } };
const r = await uwGammaCheck({ symbol: 'SAMPLE', ours, levels, get, now: new Date('2030-01-02T15:15:30Z') });
eq('check: ok', r.ok, true);
eq('check: per-strike read on a ±10% band', [calls[0].query.min_strike, calls[0].query.max_strike], [90, 110]);
eq('check: levels read on open interest', calls.find(c => /gex-levels/.test(c.path)).query, { source: 'oi' });
eq('check: one page when under 500 strikes', calls.filter(c => /spot-exposures/.test(c.path)).length, 1);
const byName = Object.fromEntries(r.checks.map(c => [c.name, c.state]));
eq('check: call wall on dvcap\'s definition matches', byName['call wall'], 'match');
eq('check: negative UW put wall compared to our trapdoor', byName['put wall ↔ trapdoor'], 'match');
eq('check: flip near', byName.flip, 'near');
eq('check: regime match', byName.regime, 'match');
eq('check: no OI/IV/spot rows (UW has no totals)', r.checks.some(c => /OI|IV|^spot$/.test(c.name)), false);
eq('check: verdict', r.verdict, 'agrees with UW on all 4 checks');
eq('check: UW levels kept beside', r.uwLevels.flip, 99.2);
const bad = await uwGammaCheck({ symbol: 'SAMPLE', ours, get: async () => { throw new Error('UW 500'); } });
eq('check: a failing call returns a reason, never throws', [bad.ok, bad.reason], [false, 'UW 500']);
eq('check: no spot → refused', (await uwGammaCheck({ symbol: 'SAMPLE', ours: {}, get })).reason, 'no dvcap spot');

// paging: a full page asks for the next
let pages = 0;
const many = Array.from({ length: 500 }, (_, i) => strike(50 + i * 0.1, 1e5, -1e5));
await uwGammaCheck({ symbol: 'SAMPLE', ours, get: async (path) => { if (/spot-exposures/.test(path)) { pages++; return { data: pages === 1 ? many : rows }; } return { data: {} }; } });
eq('check: a full page walks to the next', pages, 2);

// ── keeping the moment ──
const store = new Map();
const kv = { configured: () => true, get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); return true; } };
await keepUwGamma([r, { symbol: 'SAMPLF', ok: false, skipped: true }], { date: '2030-01-02', session: 'open', kv });
eq('keep: one row kept for the scored symbol', store.get(UW_GAMMA_KEY).length, 1);
eq('keep: health holds part states only', store.get(UW_GAMMA_HEALTH_KEY).parts, { SAMPLE: 'ok', SAMPLF: 'skipped' });
eq('keep: health carries no numbers', /\d{3}/.test(JSON.stringify(store.get(UW_GAMMA_HEALTH_KEY).parts)), false);
await keepUwGamma([r], { date: '2030-01-02', session: 'open', kv });
eq('keep: same moment replaces, never duplicates', store.get(UW_GAMMA_KEY).length, 1);
await keepUwGamma([{ ...r, checks: r.checks.map(c => (c.name === 'flip' ? { ...c, state: 'differ', theirs: 101 } : c)) }], { date: '2030-01-02', session: 'close', kv });
eq('keep: the close is its own row', store.get(UW_GAMMA_KEY).length, 2);
eq('keep: Redis off → nothing kept', (await keepUwGamma([r], { date: 'x', session: 'open', kv: { configured: () => false } })).kept, 0);

// ── the running score ──
const sc = uwGammaScore(store.get(UW_GAMMA_KEY));
eq('score: sessions counted', sc.SAMPLE.sessions, 2);
eq('score: call wall agreed both times', sc.SAMPLE.checks['call wall'], { agree: 2, of: 2 });
eq('score: flip agreed once of twice', sc.SAMPLE.checks.flip, { agree: 1, of: 2 });
eq('score: typical flip gap in % of spot', sc.SAMPLE.medianFlipGapPct, 2);
eq('score: session filter', uwGammaScore(store.get(UW_GAMMA_KEY), { session: 'open' }).SAMPLE.sessions, 1);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
