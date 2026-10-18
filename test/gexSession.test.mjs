// test/gexSession.test.mjs — which session a gamma board belongs to (lib/gexSession.js), and the
// session-aware age the Gamma header reads (lib/gexRead.js ageOf). P3, 18 Oct audit.
import { boardSession, sinceSession, monthlyExpiry, expiryKind, isTradingDay } from '../lib/gexSession.js';
import { ageOf } from '../lib/gexRead.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

// ── the calendar ──
eq('the monthly expiry is the third Friday', [monthlyExpiry('2026-10'), monthlyExpiry('2026-11'), monthlyExpiry('2027-01')], ['2026-10-16', '2026-11-20', '2027-01-15']);
eq('an expiry Friday that is a holiday moves to the Thursday (Juneteenth, 18 Jun 2027)', [monthlyExpiry('2027-06'), expiryKind('2027-06-17')], ['2027-06-17', 'quarterly']);
eq('quarterly months are named', [expiryKind('2026-10-16'), expiryKind('2026-12-18'), expiryKind('2026-10-15')], ['monthly', 'quarterly', null]);
eq('weekends and holidays do not trade', [isTradingDay('2026-10-17'), isTradingDay('2026-11-26'), isTradingDay('2026-10-19')], [false, false, true]);

// ── the session a capture belongs to ──
const s = (t) => { const x = boardSession(t); return x && [x.date, x.phase, x.label]; };
eq('the Friday close run at 00:10Z Saturday is Friday\'s close, after the monthly expiry', s('2026-10-17T00:10:19Z'), ['2026-10-16', 'close', 'Fri 16 Oct close ET, after monthly expiry']);
eq('an ordinary Thursday close has no expiry tag', s('2026-10-16T01:30:00Z'), ['2026-10-15', 'close', 'Thu 15 Oct close ET']);
eq('a capture on a Sunday is the last session\'s close', s('2026-10-18T15:00:00Z'), ['2026-10-16', 'close', 'Fri 16 Oct close ET, after monthly expiry']);
eq('mid-session reads its clock', s('2026-10-15T15:15:00Z'), ['2026-10-15', 'intraday', 'Thu 15 Oct 19:15 Dubai (11:15 ET)']);
eq('Monday before the open, after an expiry Friday', s('2026-10-19T12:00:00Z'), ['2026-10-19', 'pre', 'Mon 19 Oct pre-open ET, after monthly expiry']);
eq('the day after Thanksgiving closes at 13:00 ET', s('2026-11-27T18:30:00Z')[1], 'close');
eq('no time is no session', boardSession(null), null);

// ── has anything traded since ──
const fri = boardSession('2026-10-17T00:10:19Z');
eq('Saturday: nothing has traded since the Friday close', sinceSession(fri, new Date('2026-10-17T15:00:00Z')).tradedSince, false);
eq('Monday 09:00 ET: still nothing', sinceSession(fri, new Date('2026-10-19T13:00:00Z')).tradedSince, false);
eq('Monday 10:00 ET: the next session has opened', [sinceSession(fri, new Date('2026-10-19T14:00:00Z')).tradedSince, sinceSession(fri, new Date('2026-10-19T14:00:00Z')).nextOpened], [true, true]);

// ── the age the header prints ──
const cap = '2026-10-17T00:10:19Z';
const at = (n) => { const a = ageOf(cap, new Date(n)); return [a.level, a.label]; };
eq('the weekend board 3.4h on is not "fresh" — it is a close, not an intraday print', at('2026-10-17T03:34:00Z'), ['aging', '3.4h ago']);
eq('on Sunday it is stale, and says nothing has traded since', at('2026-10-18T12:00:00Z'), ['stale', '1d ago · no trading since']);
eq('it is not called a previous session before Monday\'s open', at('2026-10-19T13:00:00Z')[0], 'stale');
eq('after Monday\'s open it is', at('2026-10-19T14:00:00Z')[0], 'previous-session');
eq('a Thursday close is a previous session at Friday 10:00 ET, 12.5h on', ageOf('2026-10-16T01:30:00Z', new Date('2026-10-16T14:00:00Z')).level, 'previous-session');
eq('a midday board is stale once the session has closed, 5.3h on', ageOf('2026-10-15T15:15:00Z', new Date('2026-10-15T20:30:00Z')).level, 'stale');
eq('and still fresh inside the session', ageOf('2026-10-15T15:15:00Z', new Date('2026-10-15T16:00:00Z')).level, 'fresh');
eq('the session rides on the age', ageOf(cap, new Date('2026-10-17T03:34:00Z')).session.label, 'Fri 16 Oct close ET, after monthly expiry');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
