// lib/stops.js — R measured from the stop a trade was entered with, however the stop moves after.
// The case that started it: a long bought at 138.18, its stop trailed to 151 to protect profits,
// and the card then showed no R at all. Made-up ticker and numbers throughout.
import { riskStop, stopChange, setInitialStop, stopStory, currentStop } from '../lib/stops.js';
import { publicView, buildClosedCard } from '../lib/tradecard.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const stop = (at) => ({ id: 's1', kind: 'stop', at });
const row = (extra = {}) => ({ id: 'XYZ-1', symbol: 'XYZ', side: 'long', levels: [stop(128.6)],
  fills: [{ id: 'f1', side: 'buy', qty: 10, price: 138.2, date: '2026-09-23' }], ...extra });

// ── RECORDING ────────────────────────────────────────────────────────────────
eq('a plan with no fill moves its stop freely', stopChange({ levels: [stop(128.6)], fills: [] }, 128.6, 131), {});
const moved = stopChange(row(), 128.6, 151, { today: '2026-10-08' });
eq('the first move after entry keeps the entry stop, dated to the entry', moved.initialStop, { at: 128.6, date: '2026-09-23', recorded: true });
eq('…and logs the move', moved.stopHistory, [{ date: '2026-10-08', from: 128.6, to: 151 }]);
const r2 = { ...row(), levels: [stop(151)], ...moved };
const again = stopChange(r2, 151, 157, { today: '2026-10-12' });
eq('a second move leaves the initial stop alone and adds to the log', [again.initialStop, again.stopHistory.length], [undefined, 2]);
eq('deleting the stop is a move too', stopChange(r2, 151, null, { today: '2026-10-13' }).stopHistory.at(-1), { date: '2026-10-13', from: 151, to: null });
eq('the same price is not a move', stopChange(r2, 151, 151), {});

// ── WHICH STOP R USES ────────────────────────────────────────────────────────
eq('R uses the initial stop once there is one', riskStop(r2), { at: 128.6, on: null, source: 'initial', reconstructed: false });
eq('…and the current stop before any move', riskStop(row()), { at: 128.6, on: null, source: 'current', reconstructed: false });
eq('the current stop is still what alerts watch', currentStop(r2).at, 151);
eq('the row says where R comes from and how the stop moved', stopStory({ ...r2, stopHistory: again.stopHistory }), 'R from the initial stop 128.6 (entry 2026-09-23) · moved 128.6 → 151 (2026-10-08), 151 → 157 (2026-10-12)');

// ── TYPED BY HAND ────────────────────────────────────────────────────────────
const typed = setInitialStop({ ...row(), levels: [stop(151)] }, 128.58, { today: '2026-10-21' });
eq('an initial stop typed after entry is a reconstruction, dated the day it was typed', typed.initialStop, { at: 128.58, date: '2026-09-23', reconstructed: '2026-10-21' });
eq('a blank clears it', setInitialStop(r2, ''), { initialStop: null });
eq('re-typing the recorded stop changes nothing', setInitialStop(r2, 128.6), {});

// ── ON THE CARDS ─────────────────────────────────────────────────────────────
const derived = { status: 'open', qty: 10, avgCost: 138.2, avgEntry: 138.2, side: 'long', firstDate: '2026-09-23', lastDate: '2026-09-23', multiplier: 1 };
const open = (r) => publicView({ ...r, price: 157.4, derived, pnl: { unrealizedPct: 13.89 } }, { today: '2026-10-21' });
eq('trailed above entry with no initial stop: no R, as before', open({ ...row(), levels: [stop(151)] }).r, null);
eq('trailed above entry with the initial stop kept: R from the entry risk', open({ ...row(), levels: [stop(151)], ...moved }).r, +((157.4 - 138.2) / (138.2 - 128.6)).toFixed(1));
eq('…marked reconstructed when it was typed in', open({ ...row(), levels: [stop(151)], ...typed }).rReconstructed, true);

const closedRow = { ...row(), levels: [stop(151)], ...typed, fills: [...row().fills, { id: 'f2', side: 'sell', qty: 10, price: 157.7, date: '2026-10-16' }],
  derived: { status: 'closed', qty: 0, avgCost: 138.2, avgEntry: 138.2, avgExit: 157.7, realizedPct: 14.11, costOut: 1382, realized: 195, side: 'long', firstDate: '2026-09-23', lastDate: '2026-10-16', multiplier: 1 } };
const line = buildClosedCard([closedRow], { today: '2026-10-21' }).embeds?.[0]?.description || JSON.stringify(buildClosedCard([closedRow], { today: '2026-10-21' }));
eq('the closed card shows the trade\'s R again, marked as reconstructed', /\+2R\*\*†/.test(line), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
