// lib/checkpointPing.js — the daily trade-day card in the daytrade channel (4 Nov 2026).
//
// LAYERS (docs/trade-day-plans.md has the decision table and the backtest behind it), one Discord embed
// card a day, posted at the first layer and rewritten in place after (no mention; Stu, 4 Nov 2026):
//   00:30 ET  'morning' — (08:30/09:30 Dubai) posts the card: likely quiet / coin flip / likely moving, QQQ+SPY P.
//   08:40 ET  'pre'   — QQQ and SPY P(≥1.0×) with the futures gap, "Leaning moving" at P ≥ 0.55 else
//                       "Coin flip" (red on a likely-quiet morning), and the 10:00 / 10:30 dollar levels.
//   10:00 ET  '10:00' — first 30 min ÷ implied, QQQ and SPY: moving day / middle / quiet start.
//   10:30 ET  '10:30' — only after a 10:00 middle: moving day / no signal / quiet.
// The card colour is the current read: green moving, yellow undecided, red quiet. Each layer once per NY day.
//
// HOW. A scheduled GET (.github/workflows/checkpoint-ping.yml) reaches api/tradecard.js?card=checkpoint
// behind the trade card's service-key gate. The layer is picked from the New York clock (STAGES), never
// from which cron fired. It reads the Signal Board payload the board already serves (public shape, no
// gamma levels). It never decides anything: it says what the numbers did and what such days did before.
export const CHECKPOINT_PING_KEY = 'dvcap:discord:checkpoint:v3';
// Each layer's window, New York time. GitHub schedules can run late; past the window it is not news.
export const STAGES = Object.freeze([
  // 00:30 ET = 08:30 Dubai (EDT) / 09:30 Dubai (EST): the morning card, 9–10 hours before the open.
  { id: 'morning', from: '00:30', to: '01:30', phase: 'before the open' },
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

// ── ONE CARD A DAY, EDITED IN PLACE (Stu, 4 Nov 2026) ───────────────────────────────────────────────
// No mention and no new message per layer: the first layer of the day posts one embed card, later layers
// rewrite it. The card's colour is the CURRENT read: green = moving day, yellow = undecided, red = quiet.
// Labels are factual, never instructions: the read, then what such days did historically.
export const COLOUR = Object.freeze({ green: 0x2ecc71, yellow: 0xf1c40f, red: 0xe74c3c });
const STATUS_WORD = { green: 'Moving day', yellow: 'Undecided', red: 'Quiet' };
const DOT = { green: '🟢', yellow: '🟡', red: '🔴' };
const VERDICT_WORD = { free: 'Likely quiet', check: 'Coin flip', desk: 'Likely moving' };
const VERDICT_STATUS = { free: 'red', check: 'yellow', desk: 'green' };
const BAND_STATUS = { confirm: 'green', middle: 'yellow', quiet: 'red' };
const WORD = { '10:00': { confirm: 'Moving day', quiet: 'Quiet start', middle: 'Middle' }, '10:30': { confirm: 'Moving day', quiet: 'Quiet', middle: 'No signal' } };
// Backtest rates (docs/trade-day-plans.md, all days, QQQ), used only when the board carries no history.
const BASE = { '10:00': { confirm: '67%', quiet: '13%', middle: '27%' }, '10:30': { confirm: '78%', quiet: '18%', middle: '36%' } };
const pc = (p) => `${Math.round(p * 100)}%`;
const usd = (v) => `$${v.toFixed(2)}`;
const cpOfT = (td, tk, at) => (td?.checkpoints?.[tk] || []).find(c => c?.at === at) || null;
const cpOf = (td, at) => cpOfT(td, 'QQQ', at);
const lv = (td, tk, at) => {
  const c = cpOfT(td, tk, at), sd = td?.calls?.[tk]?.implied_1sd;
  return c && sd ? `moving ≥ ${usd(c.confirm_at * sd)}, quiet < ${usd(c.quiet_below * sd)}` : 'n/a';
};
const hist = (c, stage) => c.history ? `${c.history.day_ge_1_pct}% of such days ended ≥1.0× (n ${c.history.n})` : `${BASE[stage][c.band]} of such days ended ≥1.0×`;

// One layer of the card, from the public trade_day block, or null when the layer has nothing to add. Pure.
// → { id, status, title, value }
export function stageLayer(stage, td) {
  const pl = td?.plans;
  if (stage === 'morning') {
    const q = td?.calls?.QQQ, s = td?.calls?.SPY;
    if (!pl?.verdict || !q?.ok) return null;
    return { id: 'morning', status: VERDICT_STATUS[pl.verdict], title: `Morning · ${VERDICT_WORD[pl.verdict]}`, value: [
      `QQQ P(move ≥1.0× implied) **${pc(pl.p)}** · median ${q.median_r}× (gap assumed 0)${s?.ok ? ` · SPY **${pc(s.p_r_ge_1)}**, median ${s.median_r}×` : ''}`,
      `Cut-offs: < ${pc(pl.cutoffs?.free_below ?? 0.3)} likely quiet (29–35% reached 1.0×) · ≥ ${pc(pl.cutoffs?.desk_at ?? 0.5)} likely moving (61–64%)`,
      `Implied move: QQQ ±${usd(q.implied_1sd)}${s?.ok ? ` · SPY ±${usd(s.implied_1sd)}` : ''}`,
      `Next read: 08:40 ET pre-open, with the futures gap`,
    ].join('\n') };
  }
  if (stage === 'pre') {
    const q = td?.calls?.QQQ, s = td?.calls?.SPY;
    if (!q?.ok) return null;
    const gap = q.inputs?.gap_sigma, p = q.p_r_ge_1;
    const lean = pl?.verdict === 'free' ? null : gap == null ? 'Coin flip' : p >= PRE_LEAN_AT ? 'Leaning moving' : 'Coin flip';
    const rate = lean === 'Leaning moving' ? '62% of such days reached 1.0×' : lean ? '43% of such days reached 1.0×' : null;
    const status = pl?.verdict === 'free' ? 'red' : lean === 'Leaning moving' ? 'green' : 'yellow';
    return { id: 'pre', status, title: `Pre-open · ${lean || VERDICT_WORD.free}`, value: [
      `QQQ P(≥1.0×) with the gap **${pc(p)}**${gap == null ? ' (no gap read)' : ` (gap ${gap}σ)`}${rate ? ` · ${rate}` : ''}`,
      ...(s?.ok ? [`SPY P(≥1.0×) with the gap **${pc(s.p_r_ge_1)}**`] : []),
      `10:00 ET QQQ ${lv(td, 'QQQ', '10:00')}${s?.ok ? ` · SPY ${lv(td, 'SPY', '10:00')}` : ''}`,
      `10:30 ET QQQ ${lv(td, 'QQQ', '10:30')}${s?.ok ? ` · SPY ${lv(td, 'SPY', '10:30')}` : ''}`,
    ].join('\n') };
  }
  if (stage === '10:00' || stage === '10:30') {
    const c0 = { QQQ: cpOfT(td, 'QQQ', '10:00'), SPY: cpOfT(td, 'SPY', '10:00') };
    if (stage === '10:30' && c0.QQQ?.band !== 'middle' && c0.SPY?.band !== 'middle') return null;
    const rows = [], bands = {};
    for (const tk of ['QQQ', 'SPY']) {
      const c = cpOfT(td, tk, stage);
      if (!c?.ok || (stage === '10:30' && c0[tk]?.band !== 'middle')) continue;
      bands[tk] = c.band;
      const rule = c.band === 'confirm' ? ` ≥ ${c.confirm_at}σ` : c.band === 'quiet' ? ` < ${c.quiet_below}σ` : `, between ${c.quiet_below}σ and ${c.confirm_at}σ`;
      rows.push(`${DOT[BAND_STATUS[c.band]]} **${tk} ${WORD[stage][c.band]}** · ${stage === '10:00' ? 'first 30 min' : 'first hour'} ${c.fr_sigma}σ${rule} · ${hist(c, stage)}`);
    }
    if (!rows.length) return null;
    // QQQ is the primary instrument; a SPY confirm under a non-confirming QQQ reads as undecided.
    let status = BAND_STATUS[bands.QQQ ?? bands.SPY];
    if (bands.QQQ && bands.QQQ !== 'confirm' && bands.SPY === 'confirm') status = 'yellow';
    return { id: stage, status, title: `${stage} ET · ${WORD[stage][bands.QQQ ?? bands.SPY]}`, value: rows.join('\n') };
  }
  return null;
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short' });
// The whole card from the morning verdict and the layers so far. Pure.
export function renderCard(td, layers, now = new Date()) {
  const pl = td?.plans;
  const order = ['morning', 'pre', '10:00', '10:30'].filter(id => layers[id]);
  const last = order.length ? layers[order[order.length - 1]] : null;
  const status = last?.status || VERDICT_STATUS[pl?.verdict] || 'yellow';
  const fields = [];
  if (pl?.verdict && !layers.morning) fields.push({ name: `Morning · ${VERDICT_WORD[pl.verdict]}`, value: `QQQ P(move ≥1.0× implied) **${pc(pl.p)}** (gap assumed 0) · cut-offs: < ${pc(pl.cutoffs?.free_below ?? 0.3)} likely quiet, ≥ ${pc(pl.cutoffs?.desk_at ?? 0.5)} likely moving` });
  for (const id of order) fields.push({ name: `${DOT[layers[id].status]} ${layers[id].title}`, value: layers[id].value.slice(0, 1024) });
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return {
    content: '',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `QQQ · SPY trade-day read · ${DATE_FMT.format(now)}`,
      description: `${DOT[status]} **Now: ${STATUS_WORD[status]}**`,
      color: COLOUR[status],
      fields,
      footer: { text: `Information only · updated ${t} ET · green moving · yellow undecided · red quiet` },
    }],
  };
}

// The run. Everything external is injected so the rules are testable without a network, Redis or Discord.
// upsert(webhook, messageId, payload) → { id, created, failed } (lib/discord.js upsertCard).
export async function checkpointPing({ now = new Date(), payload, webhook, kv, upsert } = {}) {
  const { date, hm } = nyClock(now.getTime());
  const st = stageAt(hm);
  if (!st) return { ok: true, fired: false, skipped: `outside the layer windows (${STAGES.map(s => `${s.from}–${s.to}`).join(', ')} ET)` };
  if (!webhook) return { ok: false, fired: false, stage: st.id, skipped: 'no webhook' };
  let p;
  try { p = await payload({ now }); } catch (e) { return { ok: false, fired: false, stage: st.id, skipped: `board unavailable: ${String(e?.message || e).slice(0, 80)}` }; }
  const td = p?.trade_day;
  if (td?.phase !== st.phase || p.today !== date || ((st.id === 'pre' || st.id === 'morning') && td.target !== date)) return { ok: true, fired: false, stage: st.id, skipped: 'no session today' };
  if (st.id !== 'pre' && st.id !== 'morning' && !cpOf(td, st.id)?.ok) return { ok: true, fired: false, stage: st.id, skipped: `the ${st.id} read is not in yet` };
  const layer = stageLayer(st.id, td);
  const meta = { stage: st.id, verdict: td.plans?.verdict ?? null, band: st.id === 'pre' || st.id === 'morning' ? null : cpOf(td, st.id)?.band ?? null };
  if (!layer) return { ok: true, fired: false, ...meta };
  const rec0 = kv.configured() ? await kv.get(CHECKPOINT_PING_KEY).catch(() => null) : null;
  const rec = rec0?.date === date ? rec0 : { date, messageId: null, layers: {} };
  if (rec.layers[st.id]) return { ok: true, fired: false, ...meta, skipped: 'already sent today' };
  rec.layers[st.id] = layer;
  const r = await upsert(webhook, rec.messageId, renderCard(td, rec.layers, now));
  if (!r?.id || r.failed) return { ok: false, fired: false, ...meta, skipped: 'Discord post failed' };
  rec.messageId = r.id;
  if (kv.configured()) await kv.set(CHECKPOINT_PING_KEY, rec).catch(() => null);
  return { ok: true, fired: true, created: !!r.created, status: layer.status, ...meta };
}
