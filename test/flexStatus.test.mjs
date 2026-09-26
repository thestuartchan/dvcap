// test/flexStatus.test.mjs — the daily IBKR sync, said out loud in the console.
import { syncStatus, lastDeadline } from '../lib/flexStatus.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const T = (s) => new Date(s);

// The weekday deadline: 18:00Z, skipping weekends.
eq('Friday evening → Friday 18:00', lastDeadline(T('2026-09-25T20:00:00Z')).toISOString(), '2026-09-25T18:00:00.000Z');
eq('Friday morning → Thursday 18:00', lastDeadline(T('2026-09-25T10:00:00Z')).toISOString(), '2026-09-24T18:00:00.000Z');
eq('Saturday → Friday 18:00', lastDeadline(T('2026-09-26T10:00:00Z')).toISOString(), '2026-09-25T18:00:00.000Z');
eq('Monday morning → Friday 18:00', lastDeadline(T('2026-09-28T09:00:00Z')).toISOString(), '2026-09-25T18:00:00.000Z');

// The 2026-09-25 run, read on the Saturday: healthy and quiet.
const note = { at: '2026-09-25T16:11:33Z', asOf: '2026-09-24', applied: false, needsYou: [], agree: 16, positions: 20, summary: 'everything reconciles' };
const sat = syncStatus(note, { now: T('2026-09-26T03:00:00Z') });
eq('a healthy quiet morning says so', [sat.tone, sat.text], ['ok', 'IBKR synced 10h ago · statement 2026-09-24 · 16 of 20 positions agree · nothing new']);
eq('still fine on Monday morning (no weekend run)', syncStatus(note, { now: T('2026-09-28T11:00:00Z') }).tone, 'ok');
// Monday passes 18:00Z with no run: missed.
const mon = syncStatus(note, { now: T('2026-09-28T19:00:00Z') });
eq('a missed weekday run is a warning', [mon.tone, mon.text], ['warn', '⚠ no sync since 2026-09-25 — the 2026-09-28 run is missing · IBKR synced 3d ago']);
// Something to decide.
eq('a disagreement needs you', syncStatus({ ...note, needsYou: [{ what: 'x' }] }, { now: T('2026-09-26T03:00:00Z') }).text.endsWith('1 needs you'), true);
eq('a discarded batch is a warning', syncStatus({ ...note, discarded: 'did not reconcile' }, { now: T('2026-09-26T03:00:00Z') }).tone, 'warn');
eq('applied changes are said', syncStatus({ ...note, applied: true }, { now: T('2026-09-26T03:00:00Z') }).text.endsWith('changes applied'), true);
// An older note without the counts still reads.
eq('an older note without counts', syncStatus({ at: note.at, asOf: note.asOf }, { now: T('2026-09-26T03:00:00Z') }).text, 'IBKR synced 10h ago · statement 2026-09-24 · nothing new');
eq('no note at all', syncStatus(null).tone, 'warn');

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
