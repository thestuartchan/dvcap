// fred.js — shared FRED access for the macro spine.
// Single source of the FRED key (FRED_API_KEY, matching api/indicators.js — the
// existing dvcap integration). Everything that needs a FRED series imports this;
// do not re-read the key or re-implement the fetch elsewhere.

const FRED_KEY = process.env.FRED_API_KEY;

// ── ONE GATE, ONE BUDGET ─────────────────────────────────────────────────────
// FRED allows 120 requests a minute per key, and the key is per ACCOUNT — every consumer in this
// project spends from the same allowance whether or not it knows the others exist.
//
// api/indicators.js knew that and built itself a limiter. lib/fred.js did not: four exported
// functions each calling fetch directly, no gate, no retry, one 429 fatal. lib/quotes.js drives
// thirteen call sites through them, and a Macro tab load fires BOTH files at once — so the route
// that throttled was politely queueing behind thirteen requests that were not. Observed
// 2026-09-09: five feeds back 429, and PCEPILFE and CPILFESL are in both files, so they were
// being asked for twice in the same load.
//
// The gate moves here, where the fetch is, and both sides spend from it. A limiter still only
// bounds ONE serverless invocation — nothing in-process can throttle across concurrent ones — but
// the collision being fixed is inside a single page load, which is exactly what it can reach.
//
// Six rather than eight: the two files together field far more call sites than either alone, and
// the requests were never the slow part of a cold load.
import { limiter, backoffMs, sleep } from './throttle.js';
export const FRED_MAX_CONCURRENT = 6;
export const fredGate = limiter(FRED_MAX_CONCURRENT);

// Three tries, backing OFF rather than re-colliding — a fixed wait is the burst again in
// miniature, since everything throttled together retries together. Full jitter spreads them.
// A 429 or a 5xx is worth another ask; a 400 means the request itself is wrong and a retry fails
// identically. Returns the parsed body, or null with the reason logged.
export async function fredJson(url, label = 'FRED', tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fredGate(() => fetch(url, { signal: AbortSignal.timeout(8000) }));
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) { last = String(e?.message || e); }
    if (i + 1 < tries) await sleep(backoffMs(i));
  }
  console.error(`FRED fetch failed (${label}):`, last);
  return null;
}

// Latest observation for a series → { value, date }. value is null when the key
// is missing, the series has no print, or FRED returns a placeholder ".". The
// date lets callers stamp "last hard print" honestly (FRED series are daily).
export async function fredLatest(series) {
  if (!FRED_KEY) return { value: null, date: null };
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`;
  const j = await fredJson(url, series);
  if (!j) return { value: null, date: null };
  const o = j?.observations?.[0];
  const raw = o?.value;
  const v = (raw === '.' || raw == null || raw === '') ? null : Number(raw);
  return { value: Number.isFinite(v) ? v : null, date: o?.date ?? null };
}

// Last N real observations, ASCENDING by date → [{ date, value }]. This is the stored prior
// series behind every 2-D gate: direction over 1d/5d and "N consecutive sessions widening"
// are computed from these real prints, never from a single current reading.
export async function fredSeries(series, limit = 30) {
  if (!FRED_KEY) return [];
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=${limit}`;
  const j = await fredJson(url, `${series} (history)`);
  if (!j) return [];
  return (j?.observations || [])
      .filter(o => o.value !== '.' && o.value != null && o.value !== '')
      .map(o => ({ date: o.date, value: Number(o.value) }))
      .filter(o => Number.isFinite(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Latest TWO real observations → { value, date, prev, prevDate }. Fetches a small window
// and skips "." placeholders so the delta is a true period-over-period change (for the
// macro-strip direction pointers), not "since we last fetched".
export async function fredLatest2(series) {
  if (!FRED_KEY) return { value: null, date: null, prev: null, prevDate: null };
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=8`;
  const j = await fredJson(url, series);
  if (!j) return { value: null, date: null, prev: null, prevDate: null };
  const obs = (j?.observations || [])
      .filter(o => o.value !== '.' && o.value != null && o.value !== '')
      .map(o => ({ value: Number(o.value), date: o.date }))
      .filter(o => Number.isFinite(o.value));
  return {
    value: obs[0]?.value ?? null, date: obs[0]?.date ?? null,
    prev:  obs[1]?.value ?? null, prevDate: obs[1]?.date ?? null,
  };
}

// Year-over-year percent, computed by FRED (units=pc1) rather than here — the base-period maths is
// theirs and a locally-computed YoY off two index levels is one release-timing edge case away from
// being wrong. Same "." filtering as fredLatest: a placeholder row is a missing print, not a zero.
export async function fredYoYLatest(series) {
  if (!FRED_KEY) return { value: null, date: null };
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${series}&units=pc1&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=4`;
  const j = await fredJson(url, `${series} (yoy)`);
  if (!j) return { value: null, date: null };
  const o = j?.observations?.find(x => x.value !== '.' && x.value != null && x.value !== '');
  const v = o ? Number(o.value) : null;
  return { value: Number.isFinite(v) ? +v.toFixed(2) : null, date: o?.date ?? null };
}
