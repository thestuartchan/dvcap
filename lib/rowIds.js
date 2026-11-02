// lib/rowIds.js — one card, one id.
//
// MSFT, 2 Nov 2026. Two option cards, the 520 put and the 545 call, carried the SAME id. A card
// split into trades (TradeConsole splitRow) was named `${symbol}-${first fill date}-${n}`, and an
// option card's symbol is its underlying, so two legs opened the same day both became
// MSFT-<date>-0. Everything that finds a card by id then found the first one: the banner's "Record
// it" on the call opened the put, and a fill saved to either would have been written onto BOTH.
//
// Renamed the same way on every load, server and console alike, so the banner's ids (built by the
// sync from the stored rows) match the cards on screen: the first card keeps its id, each later one
// is renamed after its own contract (or its first fill), which does not depend on load order.
const tagOf = (r) => {
  const legs = Array.isArray(r?.legs) ? r.legs : [];
  const t = legs.map(l => `${l.right || ''}${l.strike ?? ''}`).join('').replace(/[^A-Za-z0-9.]/g, '');
  return t || String(r?.fills?.[0]?.id || '').replace(/[^A-Za-z0-9]/g, '') || 'dup';
};

// THE STORE KEEPS 48 CHARACTERS of an id (api/manual-entry.js). A renamed id longer than that was
// cut back to the original on the next save, and the duplicate came back; the suffix is fitted
// inside the limit instead.
export const ROW_ID_MAX = 48;
const fit = (base, suffix) => `${String(base).slice(0, Math.max(1, ROW_ID_MAX - suffix.length - 1))}-${suffix}`;
// A new id from a base and a suffix that keeps the suffix whole. A base too long to fit is shortened
// and given a short hash of itself, so two long bases that share a prefix still come out different.
const hash36 = (s) => { let h = 5381; for (const ch of String(s)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0; return h.toString(36); };
export function fitId(base, suffix = '') {
  const b = String(base || ''), sfx = String(suffix || '');
  const whole = sfx ? `${b}-${sfx}` : b;
  if (whole.length <= ROW_ID_MAX) return whole;
  const h = hash36(whole).slice(0, 6);
  const room = ROW_ID_MAX - h.length - 1 - (sfx ? sfx.length + 1 : 0);
  return `${b.slice(0, Math.max(1, room))}-${h}${sfx ? `-${sfx}` : ''}`;
}

// → { rows, renamed: [{ from, to }] }. Rows already unique come back as the same array.
export function uniqueRowIds(rows = []) {
  if (!Array.isArray(rows)) return { rows, renamed: [] };
  const seen = new Set(), all = new Set(rows.map(r => r?.id)), renamed = [];
  let changed = false;
  const out = rows.map(r => {
    if (!r || r.id == null) return r;
    if (!seen.has(r.id)) { seen.add(r.id); return r; }
    let to = fit(r.id, tagOf(r)), n = 2;
    while (seen.has(to) || (all.has(to) && to !== r.id)) to = fit(r.id, `${tagOf(r)}-${n++}`);
    seen.add(to); renamed.push({ from: r.id, to }); changed = true;
    return { ...r, id: to };
  });
  return { rows: changed ? out : rows, renamed };
}
