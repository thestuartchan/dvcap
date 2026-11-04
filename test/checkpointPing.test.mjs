// test/checkpointPing.test.mjs — the daily trade-day card (lib/checkpointPing.js): one embed posted at the
// first layer and edited in place, colour = current read, no mention, QQQ and SPY. No network, Redis or Discord: everything is injected.
import { checkpointPing, stageLayer, renderCard, stageAt, CHECKPOINT_PING_KEY, STAGES, COLOUR } from '../lib/checkpointPing.js';

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
const withCalls = (t) => { t.calls.QQQ.median_r = 0.91; return t; };
const run = async (hm, t, kv = store(), calls = []) => {
  const r = await checkpointPing({ now: ET(hm), webhook: 'webhook', kv,
    payload: async () => ({ today: '2026-11-04', trade_day: t }),
    upsert: async (_w, id, body) => { calls.push({ id, body }); return { id: id || 'msg1', created: !id }; } });
  const e = calls.at(-1)?.body?.embeds?.[0];
  return { r, calls, kv, e, text: e ? [e.title, e.description, ...e.fields.map(f => `${f.name}\n${f.value}`)].join('\n') : '' };
};
const spy = (t, f10 = 0.45, band = 'confirm') => { t.calls.SPY = { ok: true, implied_1sd: 5, p_r_ge_1: 0.5 };
  t.checkpoints.SPY = [{ ticker: 'SPY', at: '10:00', ok: f10 != null, fr_sigma: f10, band, quiet_below: 0.25, confirm_at: 0.4 }, { ticker: 'SPY', at: '10:30', ok: false, quiet_below: 0.32, confirm_at: 0.55 }]; return t; };

{
  eq('the clock picks the layer', ['00:20', '00:35', '08:30', '08:40', '09:30', '10:02', '10:32', '11:05'].map(h => stageAt(h)?.id ?? null), [null, 'morning', null, 'pre', null, '10:00', '10:30', null]);
  eq('four layers', STAGES.map(s => s.id), ['morning', 'pre', '10:00', '10:30']);
}
{
  const a = await run('08:40', spy(td({ phase: 'before the open', verdict: 'check', p: 0.58 })));
  ok('pre-open posts a card, no mention', a.r.fired && a.r.created && a.calls[0].body.content === '' && JSON.stringify(a.calls[0].body.allowed_mentions) === '{"parse":[]}');
  ok('…green when P with the gap ≥ 0.55, factual label', a.e.color === COLOUR.green && a.text.includes('Pre-open · Leaning moving') && a.text.includes('62% of such days reached 1.0×') && a.text.includes('Now: Moving day'));
  ok('…carries the morning verdict and SPY', a.text.includes('Morning · Coin flip') && a.text.includes('SPY P(≥1.0×) with the gap **50%**'));
  eq('…yellow below 0.55', (await run('08:40', td({ phase: 'before the open', p: 0.5 }))).e.color, COLOUR.yellow);
  eq('…red on a likely-quiet morning', (await run('08:40', td({ phase: 'before the open', verdict: 'free', p: 0.2 }))).e.color, COLOUR.red);
  ok('no instructions anywhere', !/sit|stand down|your call|decide|make plans/i.test(a.text));
}
{
  // MORNING, 00:30 ET (08:30/09:30 Dubai): the card is born here, then edited all day.
  const kv = store(), calls = [];
  const m = await run('00:35', withCalls(td({ phase: 'before the open', verdict: 'check' })), kv, calls);
  ok('morning posts the card, yellow on a coin-flip morning', m.r.fired && m.r.created && m.e.color === COLOUR.yellow && m.text.includes('Morning · Coin flip') && m.text.includes('**41%**'));
  const p2 = await run('08:40', withCalls(td({ phase: 'before the open', p: 0.58 })), kv, calls);
  ok('pre-open edits the morning card and recolours it', calls[1].id === 'msg1' && !p2.r.created && p2.e.color === COLOUR.green && p2.e.fields.filter(f => f.name.includes('Morning')).length === 1);
  eq('morning on a likely-quiet day: red', (await run('00:35', withCalls(td({ phase: 'before the open', verdict: 'free' })))).e.color, COLOUR.red);
}
{
  // One card a day: later layers edit the same message and recolour it.
  const kv = store(), calls = [];
  await run('08:40', td({ phase: 'before the open', p: 0.58 }), kv, calls);
  const b = await run('10:02', td({ f10: 0.2 }), kv, calls);
  eq('10:00 edits the same card', [calls.length, calls[1].id, b.r.created], [2, 'msg1', false]);
  ok('…now red, quiet start, history rate', b.e.color === COLOUR.red && b.text.includes('QQQ Quiet start') && b.text.includes('67% of such days ended ≥1.0× (n 138)') && b.text.includes('Pre-open'));
  const again = await run('10:15', td({ f10: 0.2 }), kv, calls);
  eq('each layer once a day', [again.r.fired, again.r.skipped, calls.length], [false, 'already sent today', 2]);
}
{
  const mid = await run('10:02', td({ f10: 0.4 }));
  ok('10:00 middle: yellow', mid.e.color === COLOUR.yellow && mid.text.includes('10:00 ET · Middle'));
  ok('10:00 confirm: green', (await run('10:02', td({ verdict: 'free', f10: 0.62 }))).e.color === COLOUR.green);
  ok('a SPY confirm under a quiet QQQ reads undecided', (await run('10:02', spy(td({ f10: 0.2 })))).e.color === COLOUR.yellow);
  eq('10:00 not read yet: skipped', (await run('10:02', td({}))).r.skipped, 'the 10:00 read is not in yet');
}
{
  const kv = store(), calls = [];
  await run('10:02', td({ f10: 0.4, f1030: 0.8 }), kv, calls);
  const c = await run('10:32', td({ f10: 0.4, f1030: 0.8 }), kv, calls);
  ok('10:30 after a middle: green moving day, same card', c.e.color === COLOUR.green && c.text.includes('10:30 ET · Moving day') && calls[1].id === 'msg1');
  eq('10:30 after a 10:00 confirm or quiet: nothing', [(await run('10:32', td({ f10: 0.6, f1030: 0.8 }))).calls.length, (await run('10:32', td({ f10: 0.2, f1030: 0.3 }))).calls.length], [0, 0]);
  eq('10:30 no signal: yellow', (await run('10:32', td({ f10: 0.4, f1030: 0.5 }))).e.color, COLOUR.yellow);
}
{
  eq('no session today: nothing', (await run('10:02', { ...td({ f10: 0.7 }), phase: 'closed' })).r.skipped, 'no session today');
  eq('no webhook: nothing', (await checkpointPing({ now: ET('10:02'), webhook: null, kv: store(), payload: async () => ({}), upsert: async () => ({}) })).skipped, 'no webhook');
}
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
if (fail) process.exit(1);
