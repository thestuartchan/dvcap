// lib/bookSnapshot.js — the Console's book, summarised for the read-only screens beside it.
//
// The Market State IF/THEN playbooks and the stance card's DO say what to do in general terms —
// their copy ships in the page's script, which is reachable without the login, so it names no
// holding. What makes them usable is the live book beside them: "gross 1.08× against the 1.0× cap
// this stage sets". Only the Console computes the book (it needs the rows, the greeks and NLV), so
// it writes this summary to THIS BROWSER's storage when it does, and the other screens read it.
// Nothing here is sent anywhere: no network, no shared store. If the Console has not been opened
// on this device, the screens say so instead.
import { BOOK_LIMITS } from './leverage.js';

export const BOOK_SNAP_KEY = 'dvcap_book_snapshot_v1';
export const BOOK_SNAP_MAX_AGE_H = 72;

// `book` is lib/bookExposure.js's result; `rows` the console rows, for the hedge tags.
export function snapshotOf(book, rows = [], { now = Date.now() } = {}) {
  if (!book || book.ratio == null) return null;
  const largest = Object.values(book.byUnderlying || {})
    .filter(u => u.pctNlv != null && u.deltaNotional > 0)
    .sort((a, b) => b.pctNlv - a.pctNlv).slice(0, 3)
    .map(u => ({ root: u.root, pct: u.pctNlv }));
  const hedges = [...new Set((rows || [])
    .filter(r => r?.tag === 'hedge' && r?.derived?.status === 'open')
    .map(r => String(r.symbol || '').trim()).filter(Boolean))];
  return {
    at: new Date(now).toISOString(),
    gross: book.ratio, state: book.state || null,
    positionX: book.buckets?.positionX ?? null, swingX: book.buckets?.swingX ?? null,
    largest, hedges,
  };
}

export function readSnapshot({ now = Date.now(), storage = null } = {}) {
  try {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const raw = st?.getItem(BOOK_SNAP_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    const ageH = (now - Date.parse(s.at)) / 3600000;
    return Number.isFinite(ageH) ? { ...s, ageH } : null;
  } catch { return null; }
}
export function writeSnapshot(snap, { storage = null } = {}) {
  try { const st = storage || localStorage; if (snap) st.setItem(BOOK_SNAP_KEY, JSON.stringify(snap)); } catch { /* private window */ }
}

const x = (v) => (v == null ? '—' : `${(+v).toFixed(2)}×`);
const named = (s) => (s.largest?.length ? s.largest.map(l => `${l.root} ${l.pct}%`).join(', ') : 'none over 0%');
const hedged = (s) => (s.hedges?.length ? s.hedges.join(', ') : 'none tagged');

// ONE LINE PER PLAYBOOK, measured against the number that playbook's stage sets.
export function bookLine(id, s, { limits = BOOK_LIMITS } = {}) {
  if (!s) return null;
  const g = s.gross, sw = s.swingX;
  const over = (v, cap) => (v == null ? '' : v > cap ? ` — ${(v - cap).toFixed(2)}× over` : ' — inside it');
  switch (id) {
    case 'toStress': return `Gross ${x(g)} against the 1.0× cap this sets${over(g, limits.target)} · hedges held: ${hedged(s)}`;
    case 'hawkish': return `Swing bucket ${x(sw)} against the 0.15× triggered cap${over(sw, limits.swingMax / 2)} · largest: ${named(s)}`;
    case 'drain': return `Swing bucket ${x(sw)} against the 0.2× triggered cap${over(sw, 0.2)} · largest: ${named(s)}`;
    case 'inflationUp': case 'growthRolls': case 'growthBust':
      return `Gross ${x(g)} · largest: ${named(s)} · hedges held: ${hedged(s)}`;
    case 'easing': case 'relief':
      return `Gross ${x(g)} — ${g != null && g < limits.target ? `${(limits.target - g).toFixed(2)}× of room` : 'no room'} to the ${limits.target}× target · hedges to roll off: ${hedged(s)}`;
    default: return `Gross ${x(g)} · swing ${x(sw)}`;
  }
}
export const ageText = (s) => (!s ? '' : s.ageH < 1 ? 'from the Console just now' : s.ageH < 24 ? `from the Console ${Math.round(s.ageH)}h ago` : `from the Console ${Math.round(s.ageH / 24)}d ago`);
