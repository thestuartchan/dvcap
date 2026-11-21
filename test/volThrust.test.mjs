// test/volThrust.test.mjs — the 9-to-1 row: the pattern logic (lib/volThrust.js), its row on the Signal Board
// (lib/signalBoard.js volThrustRows: dim tape, never voted) and the feed's pure parsers (lib/volThrustFeed.js).
import { volThrustRead, volThrustFields, VT } from '../lib/volThrust.js';
import { volThrustRows, buildSignalBoard, clusterOf, CLUSTERS } from '../lib/signalBoard.js';
import { parseWsjDiary, tvBars, tvFrames, tvMsg, nyseVolumeInputs, historySessions } from '../lib/volThrustFeed.js';
import { feedLeaks } from '../lib/gexFeed.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

// Sessions from up shares (oldest first), weekdays ending 2026-11-11.
const days = (n, end = '2026-11-11') => {
  const out = []; let t = Date.parse(`${end}T12:00:00Z`);
  while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10)); t -= 864e5; }
  return out;
};
const ses = (shares, end) => { const ds = days(shares.length, end); return shares.map((s, i) => ({ date: ds[i], up: Math.round(s * 1000), down: Math.round((1 - s) * 1000) })); };
const quiet = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? 0.45 : 0.6));

// ── the pattern ──
eq('thresholds', [VT.up90, VT.down90, VT.up80, VT.down80], [0.9, 0.1, 0.8, 0.2]);
eq('empty → null', volThrustRead([]), null);
eq('no 9-to-1 day → neutral', volThrustFields(ses(quiet(20))).state, 'neutral');
ok('…text says none in 20 sessions', /no 9-to-1 day in the last 20 sessions/.test(volThrustFields(ses(quiet(20))).text));

let f = volThrustFields(ses([...quiet(15), 0.93, 0.5, 0.6, 0.91, 0.55]));
eq('two 90% up days within 5 sessions → thrust, risk-on, double90up', [f.state, f.extra.signal, f.flags], ['on', 'thrust', ['double90up']]);
f = volThrustFields(ses([...quiet(13), 0.93, 0.5, 0.6, 0.55, 0.6, 0.55, 0.91]));
eq('two 90% up days 6 sessions apart → not a double; the first is outside the 5', [f.state, f.flags], ['neutral', ['90up']]);
ok('…today is a 9-to-1 up day, 1 in 5', /a 9-to-1 up day; 1 such day in the last 5 sessions/.test(f.text));

f = volThrustFields(ses([...quiet(10), 0.06, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.92, 0.6, 0.6]));
eq('90% up day 7 sessions after a 90% down day, within the last 5 → thrust', [f.state, f.extra.read.up_after_down], ['on', true]);
f = volThrustFields(ses([...quiet(8), 0.06, ...Array(11).fill(0.5), 0.92]));
eq('90% up day 12 sessions after the down day → not a thrust', [f.state, f.extra.read.up_after_down], ['neutral', false]);

f = volThrustFields(ses([...quiet(16), 0.5, 0.08, 0.4, 0.6]));
eq('90% down day in the last 5, no 90% up since → capitulation, risk-off', [f.state, f.extra.signal], ['off', 'capitulation']);
f = volThrustFields(ses([...quiet(16), 0.5, 0.08, 0.4, 0.95]));
eq('…a 90% up day after it → thrust instead (up after down)', [f.state, f.flags], ['on', ['90up']]);
f = volThrustFields(ses([...quiet(14), 0.08, 0.5, 0.5, 0.5, 0.5, 0.5]));
eq('90% down day 6 sessions back → neutral', f.state, 'neutral');
f = volThrustFields(ses([...quiet(19), 0.07]));
eq('today a 9-to-1 down day: flag 90down, value', [f.flags, f.value, f.state], [['90down'], 7, 'off']);
ok('…text', /NYSE up volume 7% of total — a 9-to-1 down day; 1 such day in the last 5 sessions/.test(f.text));
f = volThrustFields(ses([...quiet(19), 0.16]));
ok('80% down day named as context with its ratio', /an 80% down day \(5\.3:1 down\)/.test(f.text) && f.extra.read.counts_last20.down80 === 1);
eq('bad rows ignored (zero volume, negatives)', volThrustRead([{ date: '2026-11-10', up: 0, down: 0 }, { date: '2026-11-11', up: -1, down: 5 }]), null);

// ── the board row ──
const S = { nyseVol: ses([...quiet(15), 0.93, 0.5, 0.6, 0.91, 0.55]) };
const [r] = volThrustRows(S, { today: '2026-11-12' });
eq('row: dim tape, id, never voted, thrust on', [r.dim, r.id, r.vote, r.state, r.signal, r.flip, r.stale], ['tape', 'vol_thrust', false, 'on', 'thrust', null, false]);
eq('row: thresholds carried', r.thresholds, { on: 90, off: 10, dir: 1, unit: '% up volume' });
const b = buildSignalBoard(S, { today: '2026-11-12' });
const tape = clusterOf(b.rows, CLUSTERS.find(c => c.id === 'tape'));
eq('board: the row is present but the Tape cluster does not count it', [b.rows.some(x => x.id === 'vol_thrust'), tape.rows, tape.on], [true, 0, 0]);
const [st] = volThrustRows({ nyseVol: ses(quiet(20), '2026-11-02') }, { today: '2026-11-12' });
eq('row: last print 8 sessions old → stale flag', [st.stale, st.flags.includes('stale'), /stale: last print 2026-11-02/.test(st.text)], [true, true, true]);
eq('row: no data → null state, says so', (([x]) => [x.state, x.text, x.vote])(volThrustRows({}, { today: '2026-11-12' })), [null, 'no NYSE up/down volume', false]);
eq('row JSON has no banned word', feedLeaks(JSON.stringify(b.rows.find(x => x.id === 'vol_thrust'))), []);

// ── the feed's parsers ──
const wsj = { data: { timestamp: '4:00 PM EST 11/12/26', instrumentSets: [
  { headerFields: [{ value: 'name', label: 'Issues' }], instruments: [{ name: 'Advancing', NYSE: '896' }] },
  { headerFields: [{ value: 'name', label: 'Share Volume' }], instruments: [{ name: 'Total', NYSE: '4,000' }, { name: 'Advancing', NYSE: '3,700,000' }, { name: 'Declining', NYSE: '300,000' }] }] } };
eq('WSJ diary parsed', parseWsjDiary(wsj), { date: '2026-11-12', at: '16:00', up: 3700000, down: 300000 });
eq('WSJ diary midday time', parseWsjDiary({ data: { ...wsj.data, timestamp: '12:26 PM EST 11/12/26' } }).at, '12:26');
eq('WSJ diary bad shape → null', parseWsjDiary({ data: { timestamp: 'x' } }), null);
eq('TV frames split, heartbeat kept', tvFrames('~m~4~m~~h~1~m~2~m~{}'), ['~h~1', '{}']);
ok('TV message framed with its length', /^~m~\d+~m~\{"m":"x","p":\[1\]\}$/.test(tvMsg('x', [1])));
eq('TV timescale_update → date map (New York date of the session open)', tvBars(JSON.stringify({ m: 'timescale_update', p: ['cs', { sds_1: { s: [{ i: 0, v: [1794407400, 1, 1, 1, 604460518, null] }] } }] })), { '2026-11-11': 604460518 });
eq('TV other frame → null', tvBars('{"m":"du"}'), null);
ok('history file: rows, newest last, a usable share', (() => { const h = historySessions(); return h.length > 100 && h.at(-1).date > h[0].date && volThrustRead(h) != null; })());

{
  // Layers: history, TradingView overrides a date, WSJ fills today only when the others lack it.
  const hist = { rows: [['2026-11-10', 400, 600], ['2026-11-11', 500, 500]] };
  const tv = async (sym) => (sym === 'USI:UVOL' ? { '2026-11-11': 900, '2026-11-12': 950 } : { '2026-11-11': 100, '2026-11-12': 50 });
  const wsjF = async ({ today }) => ({ date: today, up: 1, down: 9, source: 'WSJ diary (consolidated volume)' });
  // 17:00 ET on 12 Nov (22:00 UTC).
  let out = await nyseVolumeInputs({ now: new Date('2026-11-12T22:00:00Z'), tv, wsj: wsjF, hist });
  eq('layers after the close: TV wins its dates, today from TV, no WSJ', out.sessions.map(s => [s.date, s.up, s.source]), [['2026-11-10', 400, 'TradingView (history file)'], ['2026-11-11', 900, 'TradingView'], ['2026-11-12', 950, 'TradingView']]);
  // 12:00 ET: TV's forming bar for today is dropped; WSJ is asked (its own 4 PM rule lives in wsjToday).
  out = await nyseVolumeInputs({ now: new Date('2026-11-12T17:00:00Z'), tv, wsj: async () => null, hist });
  eq('in session: today\'s forming TV bar dropped', out.sessions.map(s => s.date), ['2026-11-10', '2026-11-11']);
  out = await nyseVolumeInputs({ now: new Date('2026-11-12T22:00:00Z'), tv: async () => null, wsj: wsjF, hist });
  eq('TV down: history + WSJ today, the error named', [out.sessions.map(s => [s.date, s.source]), out.errors.map(e => e.series)],
    [[['2026-11-10', 'TradingView (history file)'], ['2026-11-11', 'TradingView (history file)'], ['2026-11-12', 'WSJ diary (consolidated volume)']], ['TradingView USI:UVOL/DVOL']]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
