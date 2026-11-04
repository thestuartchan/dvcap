// lib/checkpointPing.js — one Discord ping when QQQ's first 30 minutes confirm a moving day (4 Nov 2026).
//
// WHY. The morning plans verdict (lib/signalBoard.js plansVerdict) says "free" on about 4 days in 10, and
// about 1 in 7 of those still turn into a big day (R ≥ 1.3). The 10:00 ET checkpoint — the first 30
// minutes' range ≥ 0.50 × the implied 1σ (CHECKPOINTS.QQQ['10:00'].confirm) — is the safety net: in the
// backtest it caught 5 of the 13 free-day big sessions from 2025 on (docs/trade-day-plans.md). This
// turns it into a phone notification so a free day does not hide a big one.
//
// HOW. A scheduled GET (.github/workflows/checkpoint-ping.yml, just after 10:00 ET) reaches
// api/tradecard.js?card=checkpoint behind the same service-key gate as the trade card. It reads the
// Signal Board payload the board already serves (public shape, no gamma levels), takes QQQ's 10:00
// checkpoint and, when the band is `confirm`, posts ONE new message to the trades channel webhook with
// the DISCORD_USER_ID mention — the push the trade alerts already use (Discord notifies on a new
// message that mentions you). Quiet and middle days post nothing. One ping per New York date (Redis).
//
// It never decides anything. It says what the first 30 minutes did and what such days did in the past.
export const CHECKPOINT_PING_KEY = 'dvcap:discord:checkpoint:v1';
// The window the ping is allowed in, New York time. The 10:00 read exists from 10:00; GitHub schedules
// can run late, and a confirm read at 10:40 is still worth knowing — past that it is not news.
export const PING_WINDOW = Object.freeze({ from: '10:00', to: '10:45' });

const nyClock = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};

const VERDICT_WORD = { free: 'Free', check: 'Check', desk: 'Desk' };
// The message, from the public trade_day block. Pure.
export function checkpointMessage(td, { mentionId = null } = {}) {
  const cp = (td?.checkpoints?.QQQ || []).find(c => c?.at === '10:00');
  if (!cp?.ok || cp.band !== 'confirm') return null;
  const h = cp.history || {};
  const pl = td.plans;
  const sd = td.calls?.QQQ?.implied_1sd;
  const who = mentionId ? `<@${mentionId}> ` : '';
  const morning = pl?.verdict ? ` Morning call: ${VERDICT_WORD[pl.verdict]} (P ${Math.round(pl.p * 100)}%).` : '';
  const dist = sd ? ` (confirm at $${(cp.confirm_at * sd).toFixed(2)})` : '';
  return {
    content: `${who}📈 QQQ 10:00 ET: first 30 min range ${cp.fr_sigma}σ ≥ ${cp.confirm_at}σ${dist}, confirms a moving day. Such days ended ≥1.0× ${h.day_ge_1_pct}% of the time (n ${h.n}).${morning} Information only.`,
    allowed_mentions: { users: mentionId ? [mentionId] : [] },
  };
}

// The run. Everything external is injected so the rule is testable without a network, Redis or Discord.
export async function checkpointPing({ now = new Date(), payload, webhook, mentionId = null, kv, poster } = {}) {
  const { date, hm } = nyClock(now.getTime());
  if (hm < PING_WINDOW.from || hm >= PING_WINDOW.to) return { ok: true, fired: false, skipped: `outside ${PING_WINDOW.from}–${PING_WINDOW.to} ET` };
  if (!webhook) return { ok: false, fired: false, skipped: 'no webhook' };
  let p;
  try { p = await payload({ now }); } catch (e) { return { ok: false, fired: false, skipped: `board unavailable: ${String(e?.message || e).slice(0, 80)}` }; }
  const td = p?.trade_day;
  if (td?.phase !== 'in session' || p.today !== date) return { ok: true, fired: false, skipped: 'no session today' };
  const cp = (td.checkpoints?.QQQ || []).find(c => c?.at === '10:00');
  if (!cp?.ok) return { ok: true, fired: false, skipped: 'the 10:00 read is not in yet' };
  const msg = checkpointMessage(td, { mentionId });
  if (!msg) return { ok: true, fired: false, band: cp.band, fr_sigma: cp.fr_sigma };
  const last = kv.configured() ? await kv.get(CHECKPOINT_PING_KEY).catch(() => null) : null;
  if (last?.date === date) return { ok: true, fired: false, band: cp.band, fr_sigma: cp.fr_sigma, skipped: 'already sent today' };
  const id = await poster(webhook, msg);
  if (!id) return { ok: false, fired: false, band: cp.band, skipped: 'Discord post failed' };
  if (kv.configured()) await kv.set(CHECKPOINT_PING_KEY, { date, at: now.toISOString(), fr_sigma: cp.fr_sigma }).catch(() => null);
  return { ok: true, fired: true, band: cp.band, fr_sigma: cp.fr_sigma };
}
