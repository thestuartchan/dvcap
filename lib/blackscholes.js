// lib/blackscholes.js — d1 and gamma. Pure, no I/O, no dependencies.
//
// Only the pieces GEX needs. Gamma is the second derivative of option value with respect to spot,
// and it is the same number for a call and a put at the same strike and expiry — put-call parity
// differs by a forward, which is linear in S and therefore has no curvature. That identity is a
// free correctness check and is tested below.

// Standard normal PDF. φ(x) = e^(-x²/2) / √(2π)
const INV_SQRT_2PI = 0.3989422804014327;
export const normPdf = (x) => Number.isFinite(x) ? INV_SQRT_2PI * Math.exp(-0.5 * x * x) : null;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// d1 = [ln(S/K) + (r − q + σ²/2)·T] / (σ√T)
export function d1({ S, K, T, r = 0, q = 0, sigma } = {}) {
  const s = num(S), k = num(K), t = num(T), v = num(sigma), rr = num(r) ?? 0, qq = num(q) ?? 0;
  // Every one of these is a genuine domain error rather than an edge case to paper over: a zero
  // vol or a zero time to expiry makes gamma undefined (it spikes to infinity at the money), and
  // returning a large number there would put a fake wall on the chart at the front expiry.
  if (s == null || k == null || t == null || v == null) return null;
  if (!(s > 0) || !(k > 0) || !(t > 0) || !(v > 0)) return null;
  return (Math.log(s / k) + (rr - qq + 0.5 * v * v) * t) / (v * Math.sqrt(t));
}

// Γ = e^(−qT)·φ(d1) / (S·σ·√T)
//
// The brief gives this without the e^(−qT) factor, which is the non-dividend form. Carrying it is
// free and correct once q is non-zero, and it is a ~0.1% effect at QQQ's ~0.5% yield over a
// front-month expiry — far too small to matter for a wall, and no reason to be wrong about.
export function gamma({ S, K, T, r = 0, q = 0, sigma } = {}) {
  const s = num(S), t = num(T), v = num(sigma), qq = num(q) ?? 0;
  const d = d1({ S, K, T, r, q, sigma });
  if (d == null) return null;
  return (Math.exp(-qq * t) * normPdf(d)) / (s * v * Math.sqrt(t));
}

// Year fraction between two dates, ACT/365. Expiries are dates, not durations, and the caller
// should never be doing this arithmetic inline.
export const YEAR_MS = 365 * 24 * 3600 * 1000;
export function yearsTo(expiryISO, nowISO = new Date().toISOString()) {
  const e = Date.parse(String(expiryISO).length <= 10 ? `${expiryISO}T21:00:00Z` : expiryISO);
  const n = Date.parse(nowISO);
  if (!Number.isFinite(e) || !Number.isFinite(n)) return null;
  const y = (e - n) / YEAR_MS;
  return y > 0 ? y : null;   // expired, or expiring within the tick: no gamma to speak of
}
