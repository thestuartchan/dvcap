// lib/checkpointPing.js — the layered trade-day pings to the trades channel (4 Nov 2026).
//
// THREE LAYERS (docs/trade-day-plans.md has the decision table and the backtest behind it):
//   1  morning (Dubai)  trade_day.plans: free / check / desk. Read on the board; nothing posts.
//   2  08:40 ET         'pre'   — Check and Desk days only: the morning verdict, P with the futures-implied
//                                 gap, the lean ("Desk: sit for the open" at P ≥ 0.55, else "Lean free:
//                                 decide at 10:00 ET") and the 10:00 / 10:30 dollar levels. Free days skip
//                                 it: their safety net is layer 3.
//   3  10:00 ET         '10:00' — every day: a CONFIRM (first 30 min ≥ 0.50σ) posts. Check and Desk days
//                                 also get the outcome: quiet (< 0.33σ) "Quiet: stand down", else
//                                 "Middle: re-check 10:30".
//      10:30 ET         '10:30' — only after a Check/Desk day's 10:00 "middle": confirm (first hour ≥
//                                 0.70σ), stand down (< 0.43σ), or no signal in between.
// At most one post per layer per New York day (Redis). Every post mentions DISCORD_USER_ID, so the phone
// notifies (Discord notifies on a new message that mentions you).
//
// HOW. A scheduled GET (.github/workflows/checkpoint-ping.yml) reaches api/tradecard.js?card=checkpoint
// behind the trade card's service-key gate. The layer is picked from the New York clock (STAGES), never
// from which cron fired. It reads the Signal Board payload the board already serves (public shape, no
// gamma levels). It never decides anything: it says what the numbers did and what such days did before.
export const CHECKPOINT_PING_KEY = 'dvcap:discord:checkpoint:v2';
// Each layer's window, New York time. GitHub schedules can run late; past the window it is not news.
export const STAGES = Object.freeze([
  { id: 'pre', from: '08:35', to: '09:25', phase: 'before the open' },
  { id: '10:00', from: '10:00', to: '10:30', phase: 'in session' },
  { id: '10:30', from: '10:30', to: '11:00', phase: 'in session' },
]);
export const PRE_LEAN_AT = 0.55;

const nyClock = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};
export const stageAt = (hm) => STAGES.find(s => hm >= s.from && hm < s.to) || null;

const VERDICT_WORD = { free: 'Free', check: 'Check', desk: 'Desk' };
const pc = (p) => `${Math.round(p * 100)}%`;
const usd = (v) => `$${v.toFixed(2)}`;
const cpOf = (td, at) => (td?.checkpoints?.QQQ || []).find(c => c?.at === at) || null;
// "10:00 ET: confirm ≥ $3.80 · quiet < $2.51" from the checkpoint thresholds × implied 1σ.
const levels = (td, at, what) => {
  const c = cpOf(td, at), sd = td?.calls?.QQQ?.implied_1sd;
  if (!c || !sd) return `**${at} ET:** levels not available`;
  return `**${at} ET:** confirm ≥ ${usd(c.confirm_at * sd)} · quiet < ${usd(c.quiet_below * sd)} (${what})`;
};
const wrap = (lines, mentionId) => ({
  content: `${mentionId ? `<@${mentionId}> ` : ''}${lines.join('\n')}\nInformation only.`,
  allowed_mentions: { users: mentionId ? [mentionId] : [] },
});
const morningRow = (pl) => `**Morning verdict:** ${VERDICT_WORD[pl.verdict]} (P ${pc(pl.p)})`;
const history = (c) => c.history ? ` · such days ended ≥1.0× ${c.history.day_ge_1_pct}% (n ${c.history.n})` : '';

// The message for one layer, from the public trade_day block, or null when that layer posts nothing. Pure.
export function stageMessage(stage, td, { mentionId = null } = {}) {
  const pl = td?.plans;
  const active = pl?.verdict === 'check' || pl?.verdict === 'desk';
  if (stage === 'pre') {
    if (!active) return null;
    const call = td.calls?.QQQ;
    if (!call?.ok) return null;
    const gap = call.inputs?.gap_sigma;
    const p = call.p_r_ge_1;
    const lean = gap == null ? 'Lean free: decide at 10:00 ET (no gap read)' : p >= PRE_LEAN_AT ? 'Desk: sit for the open' : 'Lean free: decide at 10:00 ET';
    return wrap([
      '**QQQ pre-open (08:40 ET)**',
      morningRow(pl),
      gap == null ? `**P with the gap:** not read (${(call.assumed || [])[0] || 'no implied open'})` : `**P with the gap:** ${pc(p)} (gap ${gap}σ, ${call.inputs.gap_source})`,
      `**Lean:** ${lean}`,
      levels(td, '10:00', 'first 30 min range'),
      levels(td, '10:30', 'first hour range'),
    ], mentionId);
  }
  if (stage === '10:00') {
    const c = cpOf(td, '10:00');
    if (!c?.ok) return null;
    if (c.band === 'confirm') {
      return wrap([`**QQQ 10:00 ET: Confirm, a moving day**`, `**First 30 min:** ${c.fr_sigma}σ ≥ ${c.confirm_at}σ${history(c)}`, ...(pl?.verdict ? [morningRow(pl)] : [])], mentionId);
    }
    if (!active) return null;
    const outcome = c.band === 'quiet' ? 'Quiet: stand down' : 'Middle: re-check 10:30';
    const rule = c.band === 'quiet' ? `< ${c.quiet_below}σ` : `between ${c.quiet_below}σ and ${c.confirm_at}σ`;
    return wrap([`**QQQ 10:00 ET: ${outcome}**`, `**First 30 min:** ${c.fr_sigma}σ, ${rule}${history(c)}`, morningRow(pl),
      ...(c.band === 'middle' ? [levels(td, '10:30', 'first hour range')] : [])], mentionId);
  }
  if (stage === '10:30') {
    const c0 = cpOf(td, '10:00'), c = cpOf(td, '10:30');
    if (!active || !c0?.ok || c0.band !== 'middle' || !c?.ok) return null;
    const outcome = c.band === 'confirm' ? 'Confirm, a moving day' : c.band === 'quiet' ? 'Quiet: stand down' : 'No signal: your call';
    const rule = c.band === 'confirm' ? `≥ ${c.confirm_at}σ` : c.band === 'quiet' ? `< ${c.quiet_below}σ` : `between ${c.quiet_below}σ and ${c.confirm_at}σ`;
    return wrap([`**QQQ 10:30 ET: ${outcome}**`, `**First hour:** ${c.fr_sigma}σ, ${rule}${history(c)}`, `**10:00 read:** middle (${c0.fr_sigma}σ)`, morningRow(pl)], mentionId);
  }
  return null;
}
// Kept for callers of the first version: the 10:00 message on a confirm, else null.
export const checkpointMessage = (td, o = {}) => (cpOf(td, '10:00')?.band === 'confirm' ? stageMessage('10:00', td, o) : null);

// The run. Everything external is injected so the rules are testable without a network, Redis or Discord.
export async function checkpointPing({ now = new Date(), payload, webhook, mentionId = null, kv, poster } = {}) {
  const { date, hm } = nyClock(now.getTime());
  const st = stageAt(hm);
  if (!st) return { ok: true, fired: false, skipped: `outside the layer windows (${STAGES.map(s => `${s.from}–${s.to}`).join(', ')} ET)` };
  if (!webhook) return { ok: false, fired: false, stage: st.id, skipped: 'no webhook' };
  let p;
  try { p = await payload({ now }); } catch (e) { return { ok: false, fired: false, stage: st.id, skipped: `board unavailable: ${String(e?.message || e).slice(0, 80)}` }; }
  const td = p?.trade_day;
  if (td?.phase !== st.phase || p.today !== date || (st.id === 'pre' && td.target !== date)) return { ok: true, fired: false, stage: st.id, skipped: 'no session today' };
  if (st.id !== 'pre' && !cpOf(td, st.id)?.ok) return { ok: true, fired: false, stage: st.id, skipped: `the ${st.id} read is not in yet` };
  const msg = stageMessage(st.id, td, { mentionId });
  const meta = { stage: st.id, verdict: td.plans?.verdict ?? null, band: st.id === 'pre' ? null : cpOf(td, st.id)?.band ?? null };
  if (!msg) return { ok: true, fired: false, ...meta };
  const rec = kv.configured() ? await kv.get(CHECKPOINT_PING_KEY).catch(() => null) : null;
  const sent = rec?.date === date ? { ...(rec.sent || {}) } : {};
  if (sent[st.id]) return { ok: true, fired: false, ...meta, skipped: 'already sent today' };
  const id = await poster(webhook, msg);
  if (!id) return { ok: false, fired: false, ...meta, skipped: 'Discord post failed' };
  sent[st.id] = now.toISOString();
  if (kv.configured()) await kv.set(CHECKPOINT_PING_KEY, { date, sent }).catch(() => null);
  return { ok: true, fired: true, ...meta };
}
