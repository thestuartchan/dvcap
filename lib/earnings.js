// earnings.js — one ticker's next earnings date, with whether it is confirmed.
//
// SOURCE. Nasdaq's own front-end API (api.nasdaq.com/api/analyst/<SYM>/earnings-date), keyless,
// carrying Zacks' date and — the part that matters — whether the company has confirmed it or the
// vendor has projected it from past quarters. Probed 2026-09-17: INTC "is estimated to report …
// derived from an algorithm" (estimated), MU "is expected* to report … after market close"
// (confirmed), AVGO "hasn't provided us with the upcoming earnings report date" (no date), QQQ /
// AAPU / 7709 HTTP 400 (not a listed single name). Yahoo's quoteSummary wants a crumb, Alpha
// Vantage's demo key is symbol-locked, Finnhub and FMP want keys this deployment does not hold.
// Same category of dependency as the Yahoo chart endpoint the board already uses, and the same
// discipline: a failure renders as "unavailable — check manually", never as nothing.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');

// "Oct 22, 2026" or "10/22/2026" → "2026-10-22"; anything else → null.
export function parseUsDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  return null;
}

// The feed's answer, normalised. `status` is the whole point: an estimated date moves.
export function parseNasdaqEarnings(json, symbol, { fetchedAt = new Date().toISOString() } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const code = json?.status?.rCode;
  const d = json?.data || null;
  const base = { ok: false, symbol: sym, date: null, status: 'unavailable', time: null, source: 'Nasdaq (Zacks)', fetchedAt };
  if (code === 400 || !d) return { ...base, why: 'not a listed single name on the feed' };
  const text = String(d.reportText || '');
  const ann = String(d.announcement || '');
  const fromAnn = ann.match(/:\s*([A-Za-z]{3}\s+\d{1,2},\s+\d{4})\s*$/);
  const fromText = text.match(/report earnings on\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const date = parseUsDate(fromAnn?.[1]) || parseUsDate(fromText?.[1]);
  if (!date) return { ...base, why: /hasn't provided/i.test(text) ? 'the vendor has not published a date' : 'no date in the feed\'s answer' };
  const estimated = /derived from an algorithm|is estimated to report/i.test(text);
  const time = /after market close|after the close/i.test(text) ? 'after close'
    : /before market open|before the open|pre-market/i.test(text) ? 'before open' : null;
  return { ...base, ok: true, date, status: estimated ? 'estimated' : 'confirmed', time, text: text.slice(0, 220) };
}

export const NASDAQ_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
export async function fetchEarnings(symbol, { timeoutMs = 9000 } = {}) {
  const sym = String(symbol || '').toUpperCase().trim();
  const fetchedAt = new Date().toISOString();
  try {
    const r = await fetch(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(sym)}/earnings-date`,
      { headers: { 'User-Agent': NASDAQ_UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    return parseNasdaqEarnings(j, sym, { fetchedAt });
  } catch (e) {
    return { ok: false, symbol: sym, date: null, status: 'unavailable', time: null, source: 'Nasdaq (Zacks)', fetchedAt, why: `feed error — ${String(e?.message || e)}` };
  }
}
