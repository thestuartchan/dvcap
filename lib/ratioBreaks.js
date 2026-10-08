// lib/ratioBreaks.js — the break tracker for the Ratios panel: what stage a range break is at, and a
// record of how past breaks played out.
//
// WHY STAGES. The v1 chip fired on one close outside the prior 60-session range, and one close is
// weak evidence — it often reverses the next day. And a ROLLING window can manufacture a break the
// ratio never made: when old extremes age out, the band narrows onto a flat ratio. So a break is
// tracked through stages, judged against the band edge FROZEN on its first day, and tagged with
// whether the ratio moved or the window did. The tracker informs; it never gates. The thresholds
// are a starting hypothesis, and the log exists to test them (brief of 8 Oct 2026, Part A).
//
//   inside     close within the prior 60-session closing range
//   day1       first close outside it — the crossed edge is frozen as the break level
//   confirmed  the second consecutive close beyond the frozen level
//   held       HELD_DAYS sessions (day 1 counted) with no close back inside the frozen level
//   failed     a close back inside the frozen level before Held — shown SHOW_AFTER sessions
//   ended      a Held break that closes back inside — "ended after N days", shown SHOW_AFTER sessions
//
// A HELD BREAK GIVES WAY TO A FRESH ONE. Read literally, Held lasts until a close back inside the
// frozen level, and a trend never gives one: run over two years of closes, NVDA ÷ META sat on one
// break from July 2025 for 319 sessions, and the break RSP ÷ SPY made on 7 Oct was invisible inside
// one from May 2025. So once a break is Held (its confirmation is over), a new close outside the
// CURRENT 60-session range starts a new break; the old record keeps "held" and is marked
// superseded. Before Held the frozen level governs alone, as the brief sets it.
//
// PURE: a series in, a timeline and a log out. Market data only — no position, no book.

export const BAND = 60;
export const HELD_DAYS = 5;
export const SHOW_AFTER = 5;
export const ROLL_LOOKBACK = 5;          // compare the band edge with this many sessions earlier
export const ROLL_FLAT = 0.01;           // the ratio itself within ±1% over those sessions…
export const ROLL_EDGE_MOVE = 0.02;      // …while the edge moved toward it by more than 2%
export const FWD = Object.freeze([5, 10, 20]);
const RANK = { day1: 1, confirmed: 2, held: 3 };

const minIdx = (v, a, b) => { let k = a; for (let i = a + 1; i < b; i++) if (v[i] < v[k]) k = i; return k; };
const maxIdx = (v, a, b) => { let k = a; for (let i = a + 1; i < b; i++) if (v[i] > v[k]) k = i; return k; };
// The band for day i: the closes of the BAND sessions before it.
const bandAt = (v, i) => (i < BAND ? null : { lo: v[minIdx(v, i - BAND, i)], hi: v[maxIdx(v, i - BAND, i)], loIdx: minIdx(v, i - BAND, i), hiIdx: maxIdx(v, i - BAND, i) });
const beyond = (dir, x, level) => (dir === 'below' ? x < level : x > level);

// THE TAG. A break the window made: the ratio flat over the last ROLL_LOOKBACK sessions while the
// crossed edge moved toward it by more than ROLL_EDGE_MOVE, because an old extreme aged out.
export function tagOf(points, i, dir) {
  const v = points.map(p => p.v);
  const now = bandAt(v, i), then = bandAt(v, i - ROLL_LOOKBACK);
  if (!now || !then) return { tag: 'price move', note: null };
  const moved = v[i] / v[i - ROLL_LOOKBACK] - 1;
  const edgeMove = dir === 'below' ? now.lo / then.lo - 1 : 1 - now.hi / then.hi;   // toward the ratio, as a positive number
  if (Math.abs(moved) <= ROLL_FLAT && edgeMove > ROLL_EDGE_MOVE) {
    const gone = points[dir === 'below' ? then.loIdx : then.hiIdx]?.d;
    const pct = `${moved > 0 ? '+' : moved < 0 ? '−' : ''}${Math.abs(moved * 100).toFixed(1)}%`;
    return { tag: 'window roll', note: `The range narrowed as the ${gone} ${dir === 'below' ? 'low' : 'high'} dropped out; the ratio itself moved ${pct} in ${ROLL_LOOKBACK} days.` };
  }
  return { tag: 'price move', note: null };
}

// THE TIMELINE: every day's stage, and every break as a record. `spy` is an optional
// [{ d, v }] series for the forward context columns.
export function breakTimeline(points = [], { ratio = null, spy = null } = {}) {
  const v = points.map(p => p.v);
  const days = [], breaks = [];
  const spyAt = spy ? new Map(spy.map(p => [p.d, p.v])) : null;
  let cur = null;            // the break in progress
  let shown = null;          // a failed or ended break, still on display: { kind, dir, left, ... }
  const fwd = (b) => {
    const out = {}, s = {};
    for (const n of FWD) {
      const j = b.i + n;
      out[`d${n}`] = j < v.length ? +((v[j] / b.day1_close - 1) * 100).toFixed(2) : null;
      const a = spyAt?.get(points[b.i].d), z = j < v.length ? spyAt?.get(points[j].d) : null;
      s[`d${n}`] = a && z ? +((z / a - 1) * 100).toFixed(2) : null;
    }
    return { fwd_ratio_change: out, fwd_spy_change: s };
  };
  const start = (i, dir) => {
    const band = bandAt(v, i);
    const { tag, note } = tagOf(points, i, dir);
    cur = { i, dir, day: 1, level: dir === 'below' ? band.lo : band.hi, reached: 'day1',
            rec: { ratio, direction: dir, day1_date: points[i].d, break_level: +(dir === 'below' ? band.lo : band.hi).toPrecision(6),
                   day1_close: +v[i].toPrecision(6), tag, note, reached: 'day1', failed_date: null, ended_date: null, superseded_date: null, days_beyond: 1 } };
    breaks.push(cur.rec);
    shown = null;
  };
  for (let i = 0; i < v.length; i++) {
    if (i < BAND) { days.push({ d: points[i].d, stage: null }); continue; }
    if (cur) {
      cur.day++;
      if (beyond(cur.dir, v[i], cur.level)) {
        cur.rec.days_beyond = cur.day;
        if (cur.day === 2 && RANK[cur.reached] < RANK.confirmed) cur.reached = 'confirmed';
        if (cur.day >= HELD_DAYS) cur.reached = 'held';
        cur.rec.reached = cur.reached;
      } else {
        // Back inside the frozen level: a Held break ended, anything earlier failed.
        const held = cur.reached === 'held';
        if (held) cur.rec.ended_date = points[i].d; else cur.rec.failed_date = points[i].d;
        shown = { kind: held ? 'ended' : 'failed', dir: cur.dir, left: SHOW_AFTER, level: cur.level, levelDate: cur.rec.day1_date,
                  after: cur.day - 1, tag: cur.rec.tag, reached: cur.reached };
        cur = null;
      }
    }
    // A Held break gives way to a fresh close outside the current range.
    if (cur && cur.reached === 'held') {
      const band = bandAt(v, i);
      if (v[i] < band.lo || v[i] > band.hi) { cur.rec.superseded_date = points[i].d; cur = null; }
    }
    // A new break may start on any day no break is in progress — including the day one ended.
    if (!cur) {
      const band = bandAt(v, i);
      if (v[i] < band.lo) start(i, 'below');
      else if (v[i] > band.hi) start(i, 'above');
    }
    if (cur) {
      days.push({ d: points[i].d, stage: cur.reached === 'held' ? 'held' : cur.day === 1 ? 'day1' : 'confirmed', dir: cur.dir, day: cur.day,
                  level: cur.level, levelDate: cur.rec.day1_date, tag: cur.rec.tag, note: cur.rec.note });
    } else if (shown && shown.left > 0) {
      days.push({ d: points[i].d, stage: shown.kind, dir: shown.dir, level: shown.level, levelDate: shown.levelDate, after: shown.after, tag: shown.tag, reached: shown.reached });
      shown.left--;
    } else {
      shown = null;
      days.push({ d: points[i].d, stage: 'inside' });
    }
  }
  for (const b of breaks) {
    const i = points.findIndex(p => p.d === b.day1_date);
    Object.assign(b, fwd({ i, day1_close: b.day1_close }));
  }
  return { days, breaks };
}

// ── THE CHIP ─────────────────────────────────────────────────────────────────
const arrow = (dir) => (dir === 'below' ? '▼' : '▲');
export function stageChip(day) {
  if (!day?.stage || day.stage === 'inside') return { kind: 'inside', text: '● Inside' };
  const a = arrow(day.dir);
  if (day.stage === 'day1') return { kind: 'day1', text: `${a} Break · day 1`, dir: day.dir };
  if (day.stage === 'confirmed') return { kind: 'confirmed', text: `${a} Confirmed · day ${day.day} of ${HELD_DAYS}`, dir: day.dir };
  if (day.stage === 'held') return { kind: 'held', text: `${a} Held ${HELD_DAYS}d${day.day > HELD_DAYS ? ` · day ${day.day}` : ''}`, dir: day.dir };
  if (day.stage === 'failed') return { kind: 'failed', text: '↩ Failed break', dir: day.dir };
  return { kind: 'ended', text: `↩ Break ended after ${day.after} days`, dir: day.dir };
}
// The summary's words for a stage: "▼ Confirmed (day 3)", "▼ day 1 (window roll)".
export function stageWords(day) {
  if (!day?.stage || day.stage === 'inside') return null;
  const a = arrow(day.dir);
  const roll = day.tag === 'window roll' ? ' (window roll)' : '';
  if (day.stage === 'day1') return `${a} day 1${roll}`;
  if (day.stage === 'confirmed') return `${a} Confirmed (day ${day.day})${roll}`;
  if (day.stage === 'held') return `${a} Held (day ${day.day})${roll}`;
  if (day.stage === 'failed') return `↩ failed${roll}`;
  return `↩ ended after ${day.after} days`;
}
export const isActive = (day) => ['day1', 'confirmed', 'held'].includes(day?.stage);

// ── THE LOG ──────────────────────────────────────────────────────────────────
// APPEND-ONLY. A record is keyed by ratio, direction and day-1 date; a later run may fill its
// forward fields and move it up a stage, never remove it — so history past the 2-year window the
// closes cover is kept.
export const breakId = (b) => `${b.ratio}|${b.direction}|${b.day1_date}`;
const fill = (a, b) => { const out = { ...a }; for (const k of Object.keys(b || {})) if (out[k] == null && b[k] != null) out[k] = b[k]; return out; };
export function mergeBreakLogs(stored = [], fresh = []) {
  const by = new Map((stored || []).map(b => [breakId(b), b]));
  for (const f of fresh || []) {
    const id = breakId(f), old = by.get(id);
    if (!old) { by.set(id, f); continue; }
    by.set(id, { ...old,
      reached: RANK[f.reached] > RANK[old.reached] ? f.reached : old.reached,
      failed_date: old.failed_date ?? f.failed_date ?? null, ended_date: old.ended_date ?? f.ended_date ?? null,
      superseded_date: old.superseded_date ?? f.superseded_date ?? null,
      days_beyond: Math.max(old.days_beyond || 0, f.days_beyond || 0) || null,
      fwd_ratio_change: fill(old.fwd_ratio_change, f.fwd_ratio_change), fwd_spy_change: fill(old.fwd_spy_change, f.fwd_spy_change) });
  }
  return [...by.values()].sort((a, b) => String(b.day1_date).localeCompare(String(a.day1_date)) || String(a.ratio).localeCompare(String(b.ratio)));
}

// ── THE STAGE SUMMARY ────────────────────────────────────────────────────────
// Per stage (a break counts toward every stage it reached) and per tag: how many, how many went on
// in the break's direction at d10 and d20 (of those with that many days behind them), and the
// median d20 move signed so that positive is "continued".
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export function stageSummary(log = []) {
  const rows = [];
  for (const stage of ['day1', 'confirmed', 'held']) {
    for (const tag of ['all', 'price move', 'window roll']) {
      const set = log.filter(b => RANK[b.reached] >= RANK[stage] && (tag === 'all' || b.tag === tag));
      const signed = (b, k) => { const x = b.fwd_ratio_change?.[k]; return x == null ? null : (b.direction === 'below' ? -x : x); };
      const cont = (k) => { const xs = set.map(b => signed(b, k)).filter(x => x != null); return xs.length ? { n: xs.length, pct: Math.round(100 * xs.filter(x => x > 0).length / xs.length) } : null; };
      const d20 = set.map(b => signed(b, 'd20')).filter(x => x != null);
      rows.push({ stage, tag, n: set.length, d10: cont('d10'), d20: cont('d20'), medianD20: d20.length ? +median(d20).toFixed(2) : null });
    }
  }
  return rows;
}
