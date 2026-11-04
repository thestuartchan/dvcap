// test/checkpointPing.test.mjs — the layered trade-day pings (lib/checkpointPing.js): 08:40 pre-open on
// Check/Desk days, 10:00 confirm every day plus the outcome on Check/Desk days, 10:30 only after a 10:00
// middle. No network, Redis or Discord: everything is injected.
import { checkpointPing, stageMessage, checkpointMessage, stageAt, CHECKPOINT_PING_KEY, STAGES } from '../lib/checkpointPing.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const cp = (at, fr, q, c) => fr == null ? { ticker: 'QQQ', at, ok: false, quiet_below: q, confirm_at: c }
  : { ticker: 'QQQ', at, ok: true, fr_sigma: fr, band: fr >= c ? 'confirm' : fr < q ? 'quiet' : 'middle', quiet_below: q, confirm_at: c, history: { n: 138, day_ge_1_pct: 67 } };
// td({verdict, f10, f1030, phase, p, gap})
const td = ({ verdict = 'check', f10 = null, f1030 = null, phase = 'in session', p = 0.58, gap = 0.4 } = {}) => ({
  phase, target: '2026-11-04',
  calls: { QQQ: { ok: true, implied_1sd: 7.6, p_r_ge_1: p, inputs: { gap_sigma: gap, gap_source: gap == null ? null : 'futures-implied (NQ=F 08:40 ET)' }, assumed: gap == null ? ['gap 0 (no NQ=F print at the prior close)'] : [] } },
  plans: { verdict, p: verdict === 'free' ? 0.24 : verdict === 'desk' ? 0.52 : 0.41 },
  checkpoints: { QQQ: [cp('10:00', f10, 0.33, 0.5), cp('10:30', f1030, 0.43, 0.7)] },
});
const store = () => { const m = new Map(); return { m, configured: () => true, get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };
// 2026-11-04 is EST: ET = UTC − 5.
const ET = (hm) => new Date(`2026-11-04T${String(+hm.slice(0, 2) + 5).padStart(2, '0')}:${hm.slice(3)}:00Z`);
const run = async (hm, t, kv = store()) => {
  const sent = [];
  const r = await checkpointPing({ now: ET(hm), webhook: 'webhook', mentionId: '123456', kv,
    payload: async () => ({ today: '2026-11-04', trade_day: t }), poster: async (_w, m) => { sent.push(m); return 'msg1'; } });
  return { r, sent, kv, text: sent[0]?.content || '' };
};

{
  eq('the clock picks the layer', ['08:30', '08:40', '09:30', '10:02', '10:32', '11:05'].map(h => stageAt(h)?.id ?? null), [null, 'pre', null, '10:00', '10:30', null]);
  eq('three layers', STAGES.map(s => s.id), ['pre', '10:00', '10:30']);
}
{
  // LAYER 2, 08:40 ET.
  const a = await run('08:40', td({ phase: 'before the open', p: 0.58 }));
  eq('pre-open: a Check day posts once', [a.r.fired, a.sent.length, a.r.stage], [true, 1, 'pre']);
  ok('…label → value rows: verdict, P with the gap, the lean', a.text.includes('**Morning verdict:** Check (P 41%)') && a.text.includes('**P with the gap:** 58% (gap 0.4σ') && a.text.includes('**Lean:** Desk: sit for the open'));
  ok('…and both checkpoints\' dollar levels', a.text.includes('**10:00 ET:** confirm ≥ $3.80 · quiet < $2.51') && a.text.includes('**10:30 ET:** confirm ≥ $5.32 · quiet < $3.27'));
  ok('…with the mention', a.text.startsWith('<@123456> ') && a.sent[0].allowed_mentions.users[0] === '123456');
  ok('below 0.55: lean free', (await run('08:40', td({ phase: 'before the open', verdict: 'desk', p: 0.53 }))).text.includes('**Lean:** Lean free: decide at 10:00 ET'));
  eq('pre-open: a Free day posts nothing', (await run('08:40', td({ phase: 'before the open', verdict: 'free' }))).sent.length, 0);
  ok('no gap read: says so, leans free', (await run('08:40', td({ phase: 'before the open', gap: null }))).text.includes('**P with the gap:** not read (gap 0 (no NQ=F print'));
  const again = await run('08:50', td({ phase: 'before the open' }), a.kv);
  eq('pre-open: once a day', [again.sent.length, again.r.skipped], [0, 'already sent today']);
}
{
  // LAYER 3, 10:00 ET.
  const free = await run('10:02', td({ verdict: 'free', f10: 0.62 }));
  ok('10:00 confirm posts on a Free day', free.r.fired && free.text.includes('Confirm, a moving day') && free.text.includes('0.62σ ≥ 0.5σ') && free.text.includes('**Morning verdict:** Free'));
  eq('10:00 quiet or middle on a Free day: nothing', [(await run('10:02', td({ verdict: 'free', f10: 0.2 }))).sent.length, (await run('10:02', td({ verdict: 'free', f10: 0.4 }))).sent.length], [0, 0]);
  ok('10:00 quiet on a Check day: stand down', (await run('10:02', td({ f10: 0.2 }))).text.includes('**QQQ 10:00 ET: Quiet: stand down**'));
  const mid = await run('10:02', td({ verdict: 'desk', f10: 0.4 }));
  ok('10:00 middle on a Desk day: re-check 10:30, with the 10:30 levels', mid.text.includes('Middle: re-check 10:30') && mid.text.includes('**10:30 ET:** confirm ≥ $5.32'));
  ok('10:00 confirm on a Check day: the confirm message', (await run('10:02', td({ f10: 0.7 }))).text.includes('Confirm, a moving day'));
  eq('10:00 not read yet: skipped', (await run('10:02', td({}))).r.skipped, 'the 10:00 read is not in yet');
  const kv = store();
  await run('08:40', td({ phase: 'before the open' }), kv);
  const first = await run('10:02', td({ f10: 0.4 }), kv), second = await run('10:15', td({ f10: 0.4 }), kv);
  eq('a layer already sent does not stop the next one; each posts once', [first.sent.length, second.sent.length, Object.keys(kv.m.get(CHECKPOINT_PING_KEY).sent)], [1, 0, ['pre', '10:00']]);
}
{
  // 10:30 ET: only after a Check/Desk 10:00 middle.
  ok('10:30 after middle: confirm at ≥ 0.70σ', (await run('10:32', td({ f10: 0.4, f1030: 0.8 }))).text.includes('**QQQ 10:30 ET: Confirm, a moving day**'));
  ok('10:30 after middle: stand down below 0.43σ', (await run('10:32', td({ f10: 0.4, f1030: 0.42 }))).text.includes('Quiet: stand down'));
  ok('10:30 after middle, in between: no signal', (await run('10:32', td({ f10: 0.4, f1030: 0.5 }))).text.includes('No signal: your call'));
  eq('10:30 after a 10:00 confirm or quiet: nothing', [(await run('10:32', td({ f10: 0.6, f1030: 0.8 }))).sent.length, (await run('10:32', td({ f10: 0.2, f1030: 0.3 }))).sent.length], [0, 0]);
  eq('10:30 on a Free day: nothing', (await run('10:32', td({ verdict: 'free', f10: 0.4, f1030: 0.8 }))).sent.length, 0);
}
{
  eq('outside every window: skipped', (await run('12:00', td({ f10: 0.7 }))).r.fired, false);
  eq('no session (holiday payload): skipped', (await run('10:02', td({ f10: 0.7, phase: 'after the close' }))).r.skipped, 'no session today');
  const r = await checkpointPing({ now: ET('10:05'), webhook: null, payload: async () => ({}), kv: store(), poster: async () => 'x' });
  eq('no webhook: nothing posts, and it says so', [r.ok, r.skipped], [false, 'no webhook']);
  eq('no mention configured: nobody is pingable', stageMessage('10:00', td({ f10: 0.7 })).allowed_mentions, { users: [] });
  eq('checkpointMessage (first version) is still the 10:00 confirm or null', [!!checkpointMessage(td({ f10: 0.7 })), checkpointMessage(td({ f10: 0.4 }))], [true, null]);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
