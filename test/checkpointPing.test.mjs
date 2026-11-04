// test/checkpointPing.test.mjs — the 10:00 ET checkpoint ping (lib/checkpointPing.js): fires once on a QQQ
// confirm inside the window, silent otherwise. No network, Redis or Discord: everything is injected.
import { checkpointPing, checkpointMessage, CHECKPOINT_PING_KEY, PING_WINDOW } from '../lib/checkpointPing.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const td = (band, fr = 0.62, verdict = 'free') => ({
  phase: 'in session',
  calls: { QQQ: { ok: true, implied_1sd: 7.6 } },
  plans: { verdict, p: 0.24 },
  checkpoints: { QQQ: [
    band ? { ticker: 'QQQ', at: '10:00', ok: true, fr_sigma: fr, band, confirm_at: 0.5, quiet_below: 0.33, history: { n: 138, day_ge_1_pct: 67 } }
      : { ticker: 'QQQ', at: '10:00', ok: false, confirm_at: 0.5, quiet_below: 0.33 },
    { ticker: 'QQQ', at: '10:30', ok: false } ] },
});
const store = () => { const m = new Map(); return { m, configured: () => true, get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); return true; } }; };
const at = (iso) => new Date(iso);          // 2026-11-04 is EST: 10:05 ET = 15:05 UTC
const run = async (o = {}) => {
  const sent = [];
  const kv = o.kv || store();
  const r = await checkpointPing({ now: o.now || at('2026-11-04T15:05:00Z'), webhook: 'webhook', mentionId: '123456',
    payload: async () => ({ today: '2026-11-04', trade_day: o.td ?? td('confirm') }), kv, poster: async (_w, m) => { sent.push(m); return 'msg1'; } });
  return { r, sent, kv };
};

{
  const { r, sent, kv } = await run();
  eq('a confirm inside the window fires once', [r.fired, sent.length], [true, 1]);
  ok('the message mentions the user and says what happened', sent[0].content.startsWith('<@123456> ') && sent[0].content.includes('0.62σ ≥ 0.5σ') && sent[0].content.includes('$3.80'));
  ok('…with the morning verdict and the history', sent[0].content.includes('Morning call: Free (P 24%)') && sent[0].content.includes('67%'));
  eq('only the user is pingable', sent[0].allowed_mentions, { users: ['123456'] });
  eq('the day is recorded', kv.m.get(CHECKPOINT_PING_KEY).date, '2026-11-04');
  const again = await run({ kv });
  eq('a second run the same day posts nothing', [again.r.fired, again.sent.length, again.r.skipped], [false, 0, 'already sent today']);
}
{
  eq('quiet and middle days post nothing', [(await run({ td: td('quiet', 0.2) })).sent.length, (await run({ td: td('middle', 0.4) })).sent.length], [0, 0]);
  eq('before 10:00 ET: skipped', (await run({ now: at('2026-11-04T14:55:00Z') })).r.skipped, `outside ${PING_WINDOW.from}–${PING_WINDOW.to} ET`);
  eq('after 10:45 ET: skipped', (await run({ now: at('2026-11-04T15:50:00Z') })).r.fired, false);
  eq('the 10:00 read not in yet: skipped', (await run({ td: td(null) })).r.skipped, 'the 10:00 read is not in yet');
  eq('no session (holiday payload): skipped', (await run({ td: { ...td('confirm'), phase: 'after the close' } })).r.skipped, 'no session today');
  const r = await checkpointPing({ now: at('2026-11-04T15:05:00Z'), webhook: null, payload: async () => ({}), kv: store(), poster: async () => 'x' });
  eq('no webhook: nothing posts, and it says so', [r.ok, r.skipped], [false, 'no webhook']);
  eq('checkpointMessage without a mention has no ping', checkpointMessage(td('confirm'), {}).allowed_mentions, { users: [] });
  eq('checkpointMessage on a non-confirm is null', checkpointMessage(td('middle')), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
