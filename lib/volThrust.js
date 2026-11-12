// lib/volThrust.js — the Signal Board's 9-to-1 row: NYSE up volume vs down volume per session (Lowry /
// Desmond 2002, "90% days"). PURE: sessions in, row fields out; the fetch is lib/volThrustFeed.js.
//
// DEFINITIONS (scripts/vol-thrust-backtest.py uses the same ones):
//   up share     up volume ÷ (up volume + down volume)
//   90% up day   up share ≥ 0.90 (≈ 9 to 1)     90% down day   up share ≤ 0.10
//   80% days     the same at 0.80 / 0.20 — context only, counted, never a state
// STATES (the latest session is session 0; "the last 5 sessions" are sessions 0–4):
//   thrust        (risk-on)  two 90% up days within the last 5 sessions, OR a 90% up day in the last 5
//                            sessions with a 90% down day in the 10 sessions before it
//   capitulation  (risk-off) a 90% down day in the last 5 sessions and no 90% up day since it
//   neutral       otherwise
// Flags: '90up' / '90down' when the latest session is one; 'double90up' when two 90% up days fall within
// the last 5 sessions. Shown, NOT voted (docs/vol-thrust/README.md has the 2000–2026 test).

export const VT = Object.freeze({ up90: 0.90, down90: 0.10, up80: 0.80, down80: 0.20, live: 5, after: 10, lookback: 20 });

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const shareOf = (s) => {
  const u = +s?.up, d = +s?.down;
  return Number.isFinite(u) && Number.isFinite(d) && u >= 0 && d >= 0 && u + d > 0 ? u / (u + d) : null;
};
const ratioText = (sh) => (sh >= 0.5 ? `${(sh / Math.max(1e-9, 1 - sh)).toFixed(1)}:1 up` : `${((1 - sh) / Math.max(1e-9, sh)).toFixed(1)}:1 down`);

// sessions: [{date, up, down}] in any order; duplicates keep the last given. Returns null when no session
// has a usable share.
export function volThrustRead(sessions = []) {
  const byDate = new Map();
  for (const s of sessions || []) { const sh = shareOf(s); if (s?.date && sh != null) byDate.set(s.date, { date: s.date, share: sh, source: s.source ?? null }); }
  const d = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!d.length) return null;
  const n = d.length, is90u = (i) => d[i].share >= VT.up90, is90d = (i) => d[i].share <= VT.down90;
  const lastIdx = n - 1, liveFrom = Math.max(0, n - VT.live);
  const live = []; for (let i = liveFrom; i < n; i++) live.push(i);
  const up5 = live.filter(is90u), dn5 = live.filter(is90d);
  const double90up = up5.length >= 2;
  const upAfterDown = up5.some(i => { for (let k = Math.max(0, i - VT.after); k < i; k++) if (is90d(k)) return true; return false; });
  const lastDown = dn5.length ? dn5[dn5.length - 1] : null;
  const upSinceDown = lastDown != null && live.some(i => i > lastDown && is90u(i));
  const signal = double90up || upAfterDown ? 'thrust' : lastDown != null && !upSinceDown ? 'capitulation' : null;
  const window = d.slice(-VT.lookback);
  const count = (f) => window.filter(x => f(x.share)).length;
  return {
    latest: { ...d[lastIdx], share: Math.round(d[lastIdx].share * 1000) / 1000 }, signal, double90up, up_after_down: upAfterDown,
    up90_last5: up5.length, down90_last5: dn5.length,
    counts_last20: { sessions: window.length, up90: count(s => s >= VT.up90), down90: count(s => s <= VT.down90), up80: count(s => s >= VT.up80), down80: count(s => s <= VT.down80) },
    last_90up: [...d].reverse().find(x => x.share >= VT.up90)?.date ?? null,
    last_90down: [...d].reverse().find(x => x.share <= VT.down90)?.date ?? null,
    recent: d.slice(-10).map(x => [x.date, r1(x.share * 100)]),
  };
}

// The row's fields (lib/signalBoard.js wraps them with row()). `stale` is set by the board when the latest
// session is more than two sessions old (the TradingView daily bar lands after the close).
export function volThrustFields(sessions = [], { stale = false } = {}) {
  const r = volThrustRead(sessions);
  if (!r) return { value: null, state: null, text: 'no NYSE up/down volume', flags: [], asOf: null, extra: {} };
  const { latest, signal } = r;
  const pct = latest.share * 100;
  const kind = latest.share >= VT.up90 ? 'a 9-to-1 up day' : latest.share <= VT.down90 ? 'a 9-to-1 down day'
    : latest.share >= VT.up80 ? `an 80% up day (${ratioText(latest.share)})` : latest.share <= VT.down80 ? `an 80% down day (${ratioText(latest.share)})` : ratioText(latest.share);
  const nIn5 = latest.share >= VT.up90 ? r.up90_last5 : latest.share <= VT.down90 ? r.down90_last5 : r.up90_last5 + r.down90_last5;
  const tail = latest.share >= VT.up90 || latest.share <= VT.down90
    ? `${nIn5} such day${nIn5 === 1 ? '' : 's'} in the last 5 sessions`
    : r.counts_last20.up90 + r.counts_last20.down90 === 0 ? `no 9-to-1 day in the last ${r.counts_last20.sessions} sessions`
      : `9-to-1 days in the last ${r.counts_last20.sessions} sessions: ${r.counts_last20.up90} up, ${r.counts_last20.down90} down`;
  const sig = signal === 'thrust' ? (r.double90up ? ' — THRUST: two 9-to-1 up days within 5 sessions' : ' — THRUST: a 9-to-1 up day within 10 sessions of a 9-to-1 down day')
    : signal === 'capitulation' ? ' — CAPITULATION: a 9-to-1 down day in the last 5 sessions, no 9-to-1 up day since' : '';
  const flags = [];
  if (latest.share >= VT.up90) flags.push('90up');
  if (latest.share <= VT.down90) flags.push('90down');
  if (r.double90up) flags.push('double90up');
  if (stale) flags.push('stale');
  return {
    value: r1(pct), state: signal === 'thrust' ? 'on' : signal === 'capitulation' ? 'off' : 'neutral',
    text: `NYSE up volume ${Math.round(pct)}% of total — ${kind}; ${tail}${sig}${stale ? ` (stale: last print ${latest.date})` : ''}`,
    flags, asOf: latest.date,
    extra: { signal: signal ?? 'neutral', ratio: ratioText(latest.share), source: latest.source, read: r },
  };
}
