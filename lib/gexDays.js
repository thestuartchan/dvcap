// lib/gexDays.js — did the gamma regime show up in the day's price action?
//
// Each daily capture says where spot sat against the flip (above: dealers long gamma, which damps
// moves; below: short gamma, which in theory amplifies them) and where the walls were. This joins
// each capture to that session's daily bar and measures what the day actually did, in units of
// the ATR of the 14 sessions BEFORE it:
//   range       (high − low) / ATR                    how far it travelled
//   move        |close − open| / ATR                  how far it got
//   efficiency  |close − open| / (high − low)         how one-way it was
//   trend day   move ≥ TREND_MOVE and efficiency ≥ TREND_EFF
//   wide day    range ≥ WIDE_RANGE
//   wall break  the high above the previous capture's call wall, or the low below its put wall
// Then a scoreboard by regime, on MEDIANS — thirteen days' average is one outlier's average — and
// a summary that says what the record shows and how much of a record it is. Market data only.
//
// LABELLED AT THE OPEN (8 Oct). The stored captures are stamped mid-afternoon New York, so a day
// labelled by its own capture was labelled partly by its own move: a strong rally closed above the
// flip and was filed as long gamma because of the rally. 21 Sep was called "the day QQQ crossed the
// flip" — it opened at 727.89 against a 720.32 flip and never went near it; the cross was the 18
// Sep close. Each day is now labelled by its OPEN against the PREVIOUS session's capture (flip and
// walls), which is what was known before the bell. The first capture has no previous one and is
// not scored.

export const ATR_SESSIONS = 14;
export const TREND_MOVE = 0.6;
export const TREND_EFF = 0.6;
export const WIDE_RANGE = 1.2;
export const THIN_CUSHION_PCT = 1;
export const MIN_EACH = 8;          // fewer days than this in a regime: no comparison is drawn
export const FIRM_AT = 60;          // sessions at which the read stops being an early one

const median = (a) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r2 = (x) => (x == null ? null : +x.toFixed(2));

// bars: [{ date, open, high, low, close }] oldest first, settled sessions only.
export function gexDays(captures = [], bars = []) {
  const b = (bars || []).filter(x => x && [x.open, x.high, x.low, x.close].every(Number.isFinite));
  const idx = new Map(b.map((x, i) => [x.date, i]));
  const tr = (i) => Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
  const caps = [...(captures || [])].filter(c => c?.date).sort((x, y) => x.date.localeCompare(y.date));
  const out = [];
  for (let j = 1; j < caps.length; j++) {
    const prev = caps[j - 1], c = caps[j];
    const i = idx.get(c.date);
    if (i == null || i < ATR_SESSIONS + 1 || !(prev.flipLevel > 0)) continue;
    let s = 0; for (let k = i - ATR_SESSIONS; k < i; k++) s += tr(k);
    const atr = s / ATR_SESSIONS, d = b[i];
    if (!(atr > 0)) continue;
    const range = (d.high - d.low) / atr, move = Math.abs(d.close - d.open) / atr;
    const eff = d.high > d.low ? Math.abs(d.close - d.open) / (d.high - d.low) : 0;
    out.push({
      date: c.date, regime: d.open < prev.flipLevel ? 'short' : 'long', flip: prev.flipLevel, open: d.open,
      cushionPct: r2((d.open / prev.flipLevel - 1) * 100),
      gexAdvPct: prev.gexPctOfAdv ?? null, range: r2(range), move: r2(move), eff: r2(eff),
      ret: r2((d.close / b[i - 1].close - 1) * 100), up: d.close >= d.open,
      trend: move >= TREND_MOVE && eff >= TREND_EFF, wide: range >= WIDE_RANGE,
      brokeCall: prev.callWall != null && d.high > prev.callWall, brokePut: prev.putWall != null && d.low < prev.putWall,
    });
  }
  for (const x of out) x.brokeWall = x.brokeCall || x.brokePut;
  return out;
}

export function scoreboard(days = []) {
  const group = (xs) => ({
    n: xs.length, range: r2(median(xs.map(x => x.range))), move: r2(median(xs.map(x => x.move))), eff: r2(median(xs.map(x => x.eff))),
    trend: xs.filter(x => x.trend).length, wide: xs.filter(x => x.wide).length, walls: xs.filter(x => x.brokeWall).length,
  });
  return { short: group(days.filter(x => x.regime === 'short')), long: group(days.filter(x => x.regime === 'long')), all: group(days) };
}

const pct = (a, b) => (a != null && b > 0 ? Math.round((a / b - 1) * 100) : null);
const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}`;

// THE SUMMARY: what the record shows, the trend days, the walls, where today sits and what days
// like it have done, and how much of a record it is.
export function gexSummary(days = [], latest = null, { symbol = '' } = {}) {
  const sb = scoreboard(days), S = sb.short, L = sb.long, n = sb.all.n;
  const lines = [];
  const confidence = n < 20 ? 'too few sessions to read yet' : n < FIRM_AT ? `an early read — it firms up around ${FIRM_AT} sessions` : 'enough sessions for a read';
  let headline = null;
  if (S.n >= MIN_EACH && L.n >= MIN_EACH) {
    const rr = S.range / L.range, mm = L.move > 0 ? S.move / L.move : null;
    headline = rr > 1.1 && mm != null && mm <= 1 ? 'Short gamma has meant wider, choppier days; long gamma, steadier direction.'
      : rr > 1.1 && mm != null && mm > 1.1 ? 'Short gamma has meant wider AND more directional days: it has been accelerating moves.'
      : rr < 0.9 ? 'Short-gamma days have been the quieter ones — against the usual pattern.'
      : 'No clear difference between the regimes yet.';
    // WHERE THE TREND DAYS FELL. Medians describe the typical day; a regime can look ordinary there
    // and still hold most of the days worth trading. Four or more, two-thirds in one regime: said.
    // As a RATE, not a count: long-gamma opens can outnumber short two to one, and a count would
    // credit the regime for being common.
    const tAll = S.trend + L.trend, rl = L.trend / L.n, rs = S.trend / S.n;
    const top = rl >= rs ? 'long' : 'short', hi = Math.max(rl, rs), lo = Math.min(rl, rs);
    if (tAll >= 4 && hi >= 2 * lo && hi - lo >= 0.1) {
      const lead = headline.startsWith('No clear difference') ? 'Typical days look alike in both regimes; ' : `${headline.replace(/\.$/, '')} — and `;
      headline = `${lead}trend days have come more often after a ${top}-gamma open (${Math.round(hi * 100)}% of those days vs ${Math.round(lo * 100)}%).`;
    }
    lines.push(`Median range: ${S.range} ATR on short-gamma days vs ${L.range} on long-gamma days (${signed(pct(S.range, L.range))}%). Median open→close: ${S.move} vs ${L.move} ATR; ${Math.round(S.eff * 100)}% vs ${Math.round(L.eff * 100)}% of the range kept.`);
  } else {
    lines.push(`Not enough days in both regimes to compare: ${S.n} below the flip, ${L.n} above (${MIN_EACH} each needed).`);
  }

  const share = (g) => (g.n ? `${g.trend} of ${g.n} (${Math.round(100 * g.trend / g.n)}%)` : '0 of 0');
  if (n) lines.push(`Trend days (≥${TREND_MOVE} ATR open→close, keeping ≥${Math.round(TREND_EFF * 100)}% of the range): ${share(L)} of long-gamma opens, ${share(S)} of short-gamma opens. Wide days (≥${WIDE_RANGE} ATR): ${L.wide} long, ${S.wide} short.`);
  if (n) {
    const w = sb.all.walls;
    lines.push(`Price traded through a wall on ${w} of ${n} days: ${w / n > 0.6 ? 'the walls have not held as intraday limits — treat them as magnets at most' : w / n < 0.3 ? 'the walls have mostly held as intraday limits' : 'the walls hold about as often as they break'}.`);
  }
  let now = null;
  if (latest?.spot > 0 && latest?.flipLevel > 0) {
    const c = +((latest.spot / latest.flipLevel - 1) * 100).toFixed(1);
    const reg = c < 0 ? 'short' : 'long';
    const like = reg === 'short' ? S : L;
    const thin = Math.abs(c) < THIN_CUSHION_PCT ? ` — a thin cushion; a ${Math.abs(c)}% move ${reg === 'long' ? 'down' : 'up'} changes the regime` : '';
    now = `Now: ${symbol} ${latest.spot} is ${Math.abs(c)}% ${c < 0 ? 'below' : 'above'} the flip (${latest.flipLevel.toFixed(2)}), so ${reg} gamma${thin}.`
      + (like.n >= MIN_EACH ? ` ${reg === 'long' ? 'Long' : 'Short'}-gamma days so far: median range ${like.range} ATR, open→close ${like.move}.` : '');
  }
  return { headline, lines, now, confidence: `${n} session${n === 1 ? '' : 's'} — ${confidence}. Each day is labelled by its open against the previous session's flip — what was known before the bell.`, scoreboard: sb };
}
