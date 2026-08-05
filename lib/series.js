// series.js — the dated observation store behind every trend claim.
//
// Why this exists: panels were rendering directional words ("widening", "deleveraging",
// "exhausting") off a SINGLE current value, with no stored prior to justify them. And the
// manual-entry history was keyed by SAVE TIMESTAMP, not by the observation's own as-of date,
// so saving twice in one day produced duplicate rows at the same x — which is what rendered
// the Margin Loans chart as a flat line across out-of-order dates (07-21, 07-21, 07-23).
//
// The contract here is deliberate:
//   • one row per (key, observation date) — last write for a date wins
//   • rows sorted ascending by date, always
//   • trend() returns null when there is no valid prior — callers must then render NO trend
//     word. Never fabricate direction from a single reading.

// Append-or-replace one observation into a key's series. Returns the new ordered array.
// `date` is the observation's own as-of (YYYY-MM-DD), NOT the time it was saved.
export function upsertObservation(rows, obs) {
  if (!obs || !obs.date || obs.value == null) return rows || [];
  const keep = (rows || []).filter(r => r.date !== obs.date);   // last write wins per date
  keep.push({ date: obs.date, value: obs.value, unit: obs.unit ?? null,
              delta: obs.delta ?? null, pct: obs.pct ?? null });
  return keep.sort((a, b) => a.date.localeCompare(b.date));
}

// Dedupe a WIDE record by date, preserving every field on it.
//
// upsertObservation above is for SCALAR series and deliberately whitelists
// {date,value,unit,delta,pct} — that whitelist is what keeps a scalar store from accreting
// junk. Routing a wide, many-field record through it therefore destroys the record: it keeps
// the date and silently drops everything the row existed to carry. Use this instead when the
// row IS the payload rather than one reading of one number.
export function upsertByDate(rows, row) {
  if (!row || !row.date) return rows || [];
  const keep = (rows || []).filter(r => r.date !== row.date);   // last write wins per date
  keep.push(row);
  return keep.sort((a, b) => a.date.localeCompare(b.date));
}

// Normalize an existing series: drop undated/valueless rows, dedupe by date (last wins),
// sort ascending. Used to repair stores written before the dated-row contract existed.
export function normalizeSeries(rows) {
  const byDate = new Map();
  for (const r of rows || []) {
    if (!r || !r.date || r.value == null) continue;
    byDate.set(r.date, r);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Backfill per-key series from the legacy snapshot history (rows keyed by savedAt, each
// carrying {key: {value, asOf}}). Later snapshots overwrite earlier ones for the same
// observation date, which is what collapses the duplicate 07-21 rows into one.
export function seriesFromHistory(history, keys) {
  const out = {};
  for (const k of keys) out[k] = [];
  for (const snap of history || []) {
    for (const k of keys) {
      const cell = snap?.[k];
      if (!cell || cell.value == null || !cell.asOf) continue;
      out[k] = upsertObservation(out[k], { date: cell.asOf, value: cell.value, unit: cell.unit ?? null });
    }
  }
  return out;
}

// Direction over an explicit lookback, computed ONLY from a stored prior.
// `lookbackDays`: 1 = most recent prior observation (the "1d" read); N = the last row dated
// at least N days before the latest. Returns null when no valid prior exists — the caller
// must then show the value with no trend word.
//   → { dir: 'rising'|'falling'|'flat', delta, pct, from, to, fromDate, toDate, basis }
export function trend(rows, { lookbackDays = 1, flatEps = 0 } = {}) {
  const s = normalizeSeries(rows);
  if (s.length < 2) return null;
  const last = s[s.length - 1];

  let prior = null;
  if (lookbackDays <= 1) {
    prior = s[s.length - 2];
  } else {
    const cutoff = new Date(last.date + 'T00:00:00Z');
    cutoff.setUTCDate(cutoff.getUTCDate() - lookbackDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    for (let i = s.length - 2; i >= 0; i--) {
      if (s[i].date <= cutoffStr) { prior = s[i]; break; }
    }
    if (!prior) return null;               // no observation that far back — do NOT approximate
  }
  if (!prior) return null;

  const delta = last.value - prior.value;
  const pct = prior.value !== 0 ? (delta / Math.abs(prior.value)) * 100 : null;
  const dir = Math.abs(delta) <= flatEps ? 'flat' : delta > 0 ? 'rising' : 'falling';
  return {
    dir, delta, pct,
    from: prior.value, to: last.value,
    fromDate: prior.date, toDate: last.date,
    basis: lookbackDays <= 1 ? '1d' : `${lookbackDays}d`,
  };
}

// Render the delta that JUSTIFIES a trend word, e.g. "+0.02 vs 1d". Returns "" when there
// is no trend — so a caller that concatenates this can never imply direction without proof.
export function trendNote(t, { digits = 2, unit = '' } = {}) {
  if (!t) return '';
  const sign = t.delta > 0 ? '+' : t.delta < 0 ? '−' : '';
  return `${sign}${Math.abs(t.delta).toFixed(digits)}${unit} vs ${t.basis}`;
}

// Guard for trend vocabulary: returns the word only when a stored prior justifies it.
// `words` maps direction → the domain word (e.g. {rising:'widening', falling:'tightening'}).
export function trendWord(t, words) {
  if (!t) return null;
  return words[t.dir] ?? null;
}
