// fred.js — shared FRED access for the macro spine.
// Single source of the FRED key (FRED_API_KEY, matching api/indicators.js — the
// existing dvcap integration). Everything that needs a FRED series imports this;
// do not re-read the key or re-implement the fetch elsewhere.

const FRED_KEY = process.env.FRED_API_KEY;

// Latest observation for a series → { value, date }. value is null when the key
// is missing, the series has no print, or FRED returns a placeholder ".". The
// date lets callers stamp "last hard print" honestly (FRED series are daily).
export async function fredLatest(series) {
  if (!FRED_KEY) return { value: null, date: null };
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${series}&api_key=${FRED_KEY}&file_type=json&sort_order=desc&limit=1`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { value: null, date: null };
    const j = await r.json();
    const o = j?.observations?.[0];
    const raw = o?.value;
    const v = (raw === '.' || raw == null || raw === '') ? null : Number(raw);
    return { value: Number.isFinite(v) ? v : null, date: o?.date ?? null };
  } catch {
    return { value: null, date: null };
  }
}
