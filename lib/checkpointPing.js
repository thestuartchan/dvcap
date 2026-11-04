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

// One layer of the card, per ticker, from the public trade_day block, or null when the layer has nothing
// to add. Pure. → { id, status (QQQ's, else SPY's), tickers: { QQQ?: {status, line}, SPY?: {status, line} } }
// Minimal and split by ticker (Stu, 4 Nov 2026): one short line per ticker per layer.
const LABEL = { morning: 'Morning', pre: 'Pre-open', '10:00': '10:00', '10:30': '10:30' };
const pStatus = (p, cut) => p < (cut?.free_below ?? 0.3) ? 'red' : p >= (cut?.desk_at ?? 0.5) ? 'green' : 'yellow';
const pWord = { red: 'likely quiet', yellow: 'coin flip', green: 'likely moving' };
export function stageLayer(stage, td) {
  const pl = td?.plans, cut = pl?.cutoffs, out = {};
  if (stage === 'morning' || stage === 'pre') {
    if (stage === 'morning' && !pl?.verdict) return null;
    for (const tk of ['QQQ', 'SPY']) {
      const c = td?.calls?.[tk];
      if (!c?.ok) continue;
      // Morning: QQQ uses the board's verdict P (gap 0); SPY its own P against the same cut-offs.
      const p = stage === 'morning' && tk === 'QQQ' ? pl.p : c.p_r_ge_1;
      let status, word;
      if (stage === 'morning') { status = tk === 'QQQ' ? VERDICT_STATUS[pl.verdict] : pStatus(p, cut); word = pWord[status]; }
      else if (pl?.verdict === 'free' && tk === 'QQQ') { status = 'red'; word = 'likely quiet'; }
      else { status = p >= PRE_LEAN_AT ? 'green' : 'yellow'; word = p >= PRE_LEAN_AT ? 'leaning moving' : 'coin flip'; }
      const gap = stage === 'pre' && c.inputs?.gap_sigma != null ? ` · gap ${c.inputs.gap_sigma}σ` : '';
      out[tk] = { status, line: `${DOT[status]} **${LABEL[stage]}** ${pc(p)} ${word}${gap}` };
    }
  } else if (stage === '10:00' || stage === '10:30') {
    for (const tk of ['QQQ', 'SPY']) {
      const c = cpOfT(td, tk, stage), c0 = cpOfT(td, tk, '10:00');
      if (!c?.ok || (stage === '10:30' && c0?.band !== 'middle')) continue;
      const status = BAND_STATUS[c.band];
      const rate = c.history ? `${c.history.day_ge_1_pct}%` : BASE[stage][c.band];
      out[tk] = { status, line: `${DOT[status]} **${LABEL[stage]}** ${c.fr_sigma}σ ${WORD[stage][c.band].toLowerCase()} · ${rate} hist.` };
    }
  }
  if (!Object.keys(out).length) return null;
  return { id: stage, status: (out.QQQ || out.SPY).status, tickers: out };
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', weekday: 'short', day: 'numeric', month: 'short' });
const latest = (layers, tk) => ['10:30', '10:00', 'pre', 'morning'].map(id => layers[id]?.tickers?.[tk]).find(Boolean) || null;
const NOW_WORD = { green: 'Moving day', yellow: 'Undecided', red: 'Quiet' };
// The card: ONE message with TWO stacked embeds, QQQ on top and SPY below, each coloured by its own current
// read and titled with it (Stu, 4 Nov 2026: narrow channel, no side-by-side, no shared colour). Pure.
export function renderCard(td, layers, now = new Date()) {
  const order = ['morning', 'pre', '10:00', '10:30'].filter(id => layers[id]);
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  const embed = (tk) => {
    const cur = latest(layers, tk);
    const lines = order.map(id => layers[id].tickers?.[tk]?.line).filter(Boolean);
    if (!cur || !lines.length) return null;
    const sd = td?.calls?.[tk]?.implied_1sd, c10 = cpOfT(td, tk, '10:00');
    if (sd && c10 && !layers['10:00']) lines.push(`10:00 ET levels: moving ≥ ${usd(c10.confirm_at * sd)} · quiet < ${usd(c10.quiet_below * sd)}`);
    return {
      title: `${DOT[cur.status]} ${tk} · Current read: ${NOW_WORD[cur.status]}`,
      description: lines.join('\n').slice(0, 4000),
      color: COLOUR[cur.status],
      footer: { text: `${tk === 'QQQ' ? `${DATE_FMT.format(now)} · ` : ''}${sd ? `implied ±${usd(sd)} · ` : ''}% = chance of a ≥1.0× day · hist. = such days that got there · ${t} ET` },
    };
  };
  return { content: '', allowed_mentions: { parse: [] }, embeds: [embed('QQQ'), embed('SPY')].filter(Boolean) };
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
