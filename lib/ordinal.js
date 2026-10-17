// lib/ordinal.js — 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 42nd. "42th percentile" and "2th pct"
// were live on the Drivers tab (17 Oct audit).
export function ordinal(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return String(n);
  const t = Math.abs(v) % 100, u = Math.abs(v) % 10;
  return `${v}${t >= 11 && t <= 13 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th'}`;
}
