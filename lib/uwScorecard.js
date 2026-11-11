// lib/uwScorecard.js — UW build step 13: the 60-day keep, downgrade or cancel scorecard.
//
// Every close keeps one flow row (lib/uw.js dailyRow). Here each row is set beside the session's
// outcome (QQQ/SPY close-to-close, from Yahoo's free daily bars: no UW number is an outcome) and
// scored on two horizons:
//   same day  did the flow's sign match the day's move? (describes the day; not a forecast)
//   next day  did it match the NEXT session's move? (the only horizon that could be an edge)
// A signal "beats chance" only when its 95% range sits wholly above the trivial guess (always call
// the more common direction over the same days). Fewer than 20 days: "too few".
// Plus step 11's gamma agreement. The scorecard reports; the keep / downgrade / cancel call is Stu's.
//
// Private: read through /api/flow?scorecard=1 (session) and posted once, on day 60, to the private
// channel. Nothing here reaches a public answer or a log.

export const SCORECARD = Object.freeze({ days: 60, minN: 20 });

export const SIGNALS = Object.freeze([
  { id: 'tideNet', label: 'Market Tide', target: 'SPY' },
  { id: 'QQQ_net', label: 'QQQ net premium', target: 'QQQ' },
  { id: 'SPY_net', label: 'SPY net premium', target: 'SPY' },
  { id: 'QQQ_nope', label: 'QQQ NOPE', target: 'QQQ' },
  { id: 'SPY_nope', label: 'SPY NOPE', target: 'SPY' },
]);

const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sign = (v) => (v == null || v === 0 ? 0 : v > 0 ? 1 : -1);
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);

// Daily bars → { date: { same, next } }: the session's close-to-close move and the next session's.
export function outcomesOf(bars) {
  const b = (bars || []).filter(x => x?.date && fin(x.close) != null).sort((x, y) => x.date.localeCompare(y.date));
  const out = {};
  for (let i = 1; i < b.length; i++) {
    const same = b[i].close / b[i - 1].close - 1;
    const next = i + 1 < b.length ? b[i + 1].close / b[i].close - 1 : null;
    out[b[i].date] = { same, next };
  }
  return out;
}

// Wilson 95% range for a hit rate.
export function wilson(hits, n, z = 1.96) {
  if (!n) return { lo: null, hi: null };
  const p = hits / n, z2 = z * z;
  const mid = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: +(mid - half).toFixed(3), hi: +(mid + half).toFixed(3) };
}

// One signal on one horizon. Days with no flow sign or no move are left out.
export function scoreSignal(rows, outcomes, sig, horizon, minN = SCORECARD.minN) {
  let n = 0, hits = 0, up = 0;
  for (const r of rows || []) {
    const s = sign(fin(r?.[sig.id]));
    const mv = sign(fin(outcomes?.[sig.target]?.[r?.date]?.[horizon]));
    if (!s || !mv) continue;
    n++; if (s === mv) hits++; if (mv > 0) up++;
  }
  const rate = n ? +(hits / n).toFixed(3) : null;
  const guess = n ? +Math.max(up / n, 1 - up / n).toFixed(3) : null;
  const { lo, hi } = wilson(hits, n);
  const verdict = n < minN ? 'too few' : lo > guess ? 'beats chance' : 'no edge';
  return { n, hits, rate, lo, hi, guess, verdict };
}

// The whole card's numbers. `gamma` is uwGammaScore's answer (lib/uwGamma.js).
export function scorecard({ rows = [], outcomes = {}, gamma = {}, today, days = SCORECARD.days } = {}) {
  const kept = (rows || []).filter(r => r?.date).sort((a, b) => a.date.localeCompare(b.date));
  const start = kept[0]?.date || null;
  const day = start && today ? daysBetween(start, today) + 1 : 0;
  const signals = SIGNALS.map(sig => ({ id: sig.id, label: sig.label, target: sig.target,
    same: scoreSignal(kept, outcomes, sig, 'same'), next: scoreSignal(kept, outcomes, sig, 'next') }));
  const gammaRows = Object.entries(gamma || {}).map(([symbol, g]) => {
    const t = Object.values(g.checks || {}).reduce((a, c) => ({ agree: a.agree + c.agree, of: a.of + c.of }), { agree: 0, of: 0 });
    return { symbol, readings: g.sessions, agree: t.agree, of: t.of, rate: t.of ? +(t.agree / t.of).toFixed(3) : null, medianFlipGapPct: g.medianFlipGapPct ?? null };
  });
  const edges = signals.filter(s => s.next.verdict === 'beats chance').map(s => s.label);
  const read = !start ? 'No flow days kept yet.'
    : signals.every(s => s.next.verdict === 'too few') ? `Too early: ${kept.length} flow day${kept.length === 1 ? '' : 's'} so far; a signal needs ${SCORECARD.minN}.`
      : edges.length ? `Next-day edge: ${edges.join(', ')}.` : 'No flow signal beats chance on the next day.';
  return { start, day, of: days, due: day >= days, dueDate: start ? addDays(start, days - 1) : null, sessions: kept.length, signals, gamma: gammaRows, read };
}

const pctTxt = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const cellTxt = (s) => (s.n ? `${pctTxt(s.rate)} of ${s.n} (chance ${pctTxt(s.guess)})` : 'no days');
const VERDICT_MARK = { 'beats chance': '✅', 'no edge': '·', 'too few': '…' };

// The day-60 card, PRIVATE channel only (lib/alerts.js source `flow`).
export function scorecardCard(sc) {
  if (!sc?.start) return null;
  const fields = [{ name: 'What it says', value: sc.read, inline: false }];
  fields.push({ name: 'Flow vs the next day (the forecast test)',
    value: sc.signals.map(s => `${VERDICT_MARK[s.next.verdict] || '·'} ${s.label}: ${cellTxt(s.next)}`).join('\n').slice(0, 1024), inline: false });
  fields.push({ name: 'Flow vs the same day (describes the day)',
    value: sc.signals.map(s => `${s.label}: ${cellTxt(s.same)}`).join('\n').slice(0, 1024), inline: false });
  if (sc.gamma.length) fields.push({ name: 'Gamma: UW vs dvcap',
    value: sc.gamma.map(g => `${g.symbol}: agree ${pctTxt(g.rate)} of ${g.of} checks over ${g.readings} readings${g.medianFlipGapPct != null ? ` · typical flip gap ${g.medianFlipGapPct}%` : ''}`).join('\n'), inline: false });
  fields.push({ name: 'Your call', value: 'Keep, downgrade or cancel the UW subscription.', inline: false });
  return {
    allowed_mentions: { parse: [] },
    embeds: [{ title: `🐋 UW 60-day scorecard · day ${sc.day}`, color: 0x8E6CD8, fields,
      description: `${sc.sessions} flow days since ${sc.start}. A signal beats chance only when its 95% range clears the "always guess the usual direction" rate.`,
      footer: { text: 'Unusual Whales · personal use · private channel only' } }],
  };
}
