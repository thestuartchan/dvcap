// lib/wallRoll.js — where each monthly expiry's call and put walls have moved, session to session.
//
// WHY (13 Oct). One board says where the walls are; it cannot say whether they are moving. The read
// that matters for a week or a month is the drift: November's call wall stepping 790 → 800 → 810
// while the index rallies says the ceiling is following price; the put wall stepping up says
// hedgers are moving protection higher. So every daily capture logs each expiry's heaviest strike
// either side (expiryPeaks, the same cell the heatmap rings), and this reads the path.
//
// THE WALLS ARE GAMMA PEAKS, and gamma reprices with spot: a strike nearer the price weighs more
// even if no contract changed. So a wall that moves WITH price is reported as following it, and only
// a move AGAINST or without price is read as new open interest. That is the honest limit of a
// gamma map; it never says who bought or sold.
//
// Market data only. The feed's banned-word check runs over this text too, so it avoids those words.
import { isMonthlyOpex } from './gex.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
export const ROLL_PATH_SESSIONS = 10;   // the path shown
export const ROLL_READ_SESSIONS = 5;    // the read: about a week
export const ROLL_FLAT_PCT = 0.5;       // a spot move under this, either way, is "flat"

// Each expiry's heaviest positive and negative strike, from gammaGrid's rows, with the gamma there.
export function expiryPeaks(grid) {
  const at = new Map();
  for (const c of grid?.cells || []) at.set(`${c.expiry}|${c.strike}`, num(c.netGexUsd));
  return (grid?.expiries || []).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(String(e.expiry))).map(e => ({
    e: e.expiry,
    c: num(e.peakCallStrike), p: num(e.peakPutStrike),
    cv: e.peakCallStrike != null ? Math.round(at.get(`${e.expiry}|${e.peakCallStrike}`) ?? 0) : null,
    pv: e.peakPutStrike != null ? Math.round(at.get(`${e.expiry}|${e.peakPutStrike}`) ?? 0) : null,
  }));
}

const pct = (a, b) => (a && b != null) ? +(((b - a) / a) * 100).toFixed(2) : null;
const dir = (a, b) => (a == null || b == null) ? null : b > a ? 'up' : b < a ? 'down' : 'same';
const priceWord = (p) => p == null ? 'flat' : p >= ROLL_FLAT_PCT ? 'up' : p <= -ROLL_FLAT_PCT ? 'down' : 'flat';
const moved = (p) => p == null ? 'was flat' : p >= ROLL_FLAT_PCT ? `rose ${p.toFixed(1)}%` : p <= -ROLL_FLAT_PCT ? `fell ${Math.abs(p).toFixed(1)}%` : `was flat (${p >= 0 ? '+' : ''}${p.toFixed(1)}%)`;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mmdd = (d) => `${MON[+String(d).slice(5, 7) - 1]} ${+String(d).slice(8, 10)}`;

// The call side, in English, and what it implies.
export function callRead(sym, e, a, b, sp) {
  const d = dir(a, b), px = priceWord(sp), m = moved(sp);
  if (d === 'same') return { tone: 'neutral', text: `Ceiling unchanged at ${b} while ${sym} ${m}: the call wall is holding where it was.` };
  if (d === 'up' && px === 'up') return { tone: 'up', text: `Ceiling lifting with the rally: the ${mmdd(e)} call wall moved ${a} → ${b} as ${sym} ${m}. Call sellers are rolling their strikes up, so there is more room overhead than ${a} suggested.` };
  if (d === 'up') return { tone: 'up', text: `Ceiling lifted without the price: the ${mmdd(e)} call wall moved ${a} → ${b} while ${sym} ${m}. New call open interest higher up — upside buying, or call sellers reaching further. Either way the cap is now ${b}.` };
  if (px === 'down') return { tone: 'down', text: `Ceiling following price down: the ${mmdd(e)} call wall moved ${a} → ${b} as ${sym} ${m}. Rallies now meet call selling sooner, around ${b}.` };
  return { tone: 'down', text: `Ceiling lowered: the ${mmdd(e)} call wall moved ${a} → ${b} while ${sym} ${m}. Call selling has moved closer to the price, so rallies are likely to stall nearer ${b}.` };
}

// The put side: hedges, and what their drift implies. callDir matters when the price did not move:
// puts stepping up WITH the calls is the range being reset, not a scramble for protection.
export function putRead(sym, e, a, b, sp, callDir = null) {
  const d = dir(a, b), px = priceWord(sp), m = moved(sp);
  if (d === 'same') return { tone: 'neutral', text: `Put wall unchanged at ${b} while ${sym} ${m}: the hedges have not moved.` };
  if (d === 'up' && px !== 'up' && callDir === 'up') return { tone: 'neutral', text: `Hedges stepped up with the calls: the ${mmdd(e)} put wall moved ${a} → ${b} while ${sym} ${m}. The range is being reset higher, but protection now sits closer to the price — the faster, dealer-selling zone starts at ${b}.` };
  if (d === 'up' && px === 'up') return { tone: 'up', text: `Hedges rolled up: the ${mmdd(e)} put wall moved ${a} → ${b} as ${sym} ${m}. Hedgers are locking in gains and moving protection higher — a sign of confidence. The faster, dealer-selling zone now starts at ${b}.` };
  if (d === 'up') return { tone: 'warn', text: `Protection moving closer: the ${mmdd(e)} put wall moved ${a} → ${b} while ${sym} ${m}. Demand for hedges near the price is rising — a warning. A break of ${b} is where dealer selling picks up.` };
  if (px === 'down') return { tone: 'down', text: `Hedges following price down: the ${mmdd(e)} put wall moved ${a} → ${b} as ${sym} ${m}. Protection is being reset lower; the next air pocket is ${b}.` };
  return { tone: 'neutral', text: `Hedges pushed further away: the ${mmdd(e)} put wall moved ${a} → ${b} while ${sym} ${m}. Less demand for near-the-money protection — calmer, or hedges cashed in.` };
}

// A WALL SWINGING BETWEEN STRIKES (23 Oct). QQQ's December call wall read 760 → 780 → 770 over three
// sessions while the price fell, and the card called it a ceiling "lifted without the price"; the
// November wall went 760 → 775 → 760 and was "unchanged". Two strikes of near-equal gamma trade
// places as open interest and spot move a little — far out of the money, where gamma is small,
// that happens session to session. A wall that changes direction inside the read window is not a
// move: it is a zone, low to high, read as such.
export function swing(win, key) {
  const v = win.map(x => x[key]).filter(x => x != null);
  const d = [];
  for (let i = 1; i < v.length; i++) if (v[i] !== v[i - 1]) d.push(Math.sign(v[i] - v[i - 1]));
  const reversed = d.some((x, i) => i && x !== d[i - 1]);
  return reversed ? { lo: Math.min(...v), hi: Math.max(...v), now: v[v.length - 1] } : null;
}
export function swingRead(side, sym, e, z, sp) {
  const what = side === 'call' ? 'Ceiling' : 'Hedges';
  const wall = side === 'call' ? 'call wall' : 'put wall';
  return { tone: 'neutral', text: `${what} unsettled: the ${mmdd(e)} ${wall} has swung between ${z.lo} and ${z.hi} this week (now ${z.now}) while ${sym} ${moved(sp)} — two strikes of near-equal weight trading places, so read it as a ${z.lo}–${z.hi} zone, not a move.` };
}

// Both sides together: what the box is doing, against the price.
export function boxVerdict(cd, pd, px = null) {
  if (cd === 'up' && pd === 'up') return px === 'up' ? 'The whole box is shifting up with the price: calls and hedges both rolled higher.'
    : 'The whole box stepped up without the price: the range being priced is moving higher.';
  if (cd === 'down' && pd === 'down') return px === 'down' ? 'The whole box is shifting down with the price: calls and hedges both rolled lower.'
    : 'The whole box stepped down without the price: the range being priced is moving lower — a caution.';
  if (cd === 'up' && pd === 'down') return 'The box is widening: a bigger range is being priced either way.';
  if (cd === 'down' && pd === 'up') return 'The box is narrowing: walls closing in, a pin is building.';
  if (cd === 'same' && pd === 'same') return 'The box is unchanged.';
  if (cd === 'unsettled' && pd === 'unsettled') return 'Both walls are swinging between strikes: the box edges are zones this week, not lines.';
  return null;
}

// rows: the stored daily series, oldest first (each with date, spot and expiryPeaks).
export function wallRoll(rows, { today = null, symbol = '', pathSessions = ROLL_PATH_SESSIONS, readSessions = ROLL_READ_SESSIONS } = {}) {
  const logged = (Array.isArray(rows) ? rows : []).filter(r => r?.date && Array.isArray(r.expiryPeaks) && r.expiryPeaks.length);
  if (!logged.length) return { available: false, reason: 'no wall history logged yet' };
  const last = logged[logged.length - 1];
  const listed = new Set(last.expiryPeaks.map(p => p.e));
  const from = today && today > last.date ? today : last.date;
  const tracked = last.expiryPeaks.filter(p => p.e >= from && isMonthlyOpex(p.e, listed)).map(p => p.e);
  const expiries = [];
  for (const e of tracked) {
    const path = logged.map(r => { const p = r.expiryPeaks.find(x => x.e === e); return p ? { date: r.date, spot: num(r.spot), call: p.c, put: p.p, callGex: p.cv, putGex: p.pv } : null; })
      .filter(Boolean).slice(-pathSessions);
    if (path.length < 2) { expiries.push({ expiry: e, sessions: path.length, path, read: null, reason: 'one session logged — the roll shows from the next capture' }); continue; }
    const win = path.slice(-Math.min(readSessions + 1, path.length));
    const a = win[0], b = win[win.length - 1];
    const sp = pct(a.spot, b.spot);
    const cz = swing(win, 'call'), pz = swing(win, 'put');
    // An unsettled side is a zone, not a direction: it says nothing to the box verdict.
    const cd = cz ? 'unsettled' : dir(a.call, b.call), pd = pz ? 'unsettled' : dir(a.put, b.put);
    const cr = cz ? swingRead('call', symbol, e, cz, sp) : callRead(symbol, e, a.call, b.call, sp);
    const pr = pz ? swingRead('put', symbol, e, pz, sp) : putRead(symbol, e, a.put, b.put, sp, cd);
    expiries.push({
      expiry: e, sessions: path.length, since: a.date, path,
      spot_pct: sp,
      call: { from: a.call, to: b.call, dir: cd, steps: path.filter((x, i) => i && x.call !== path[i - 1].call).length, ...(cz ? { zone: cz } : {}) },
      put: { from: a.put, to: b.put, dir: pd, steps: path.filter((x, i) => i && x.put !== path[i - 1].put).length, ...(pz ? { zone: pz } : {}) },
      box: b.put != null && b.call != null && b.spot ? { put: b.put, call: b.call, width_pct: +(((b.call - b.put) / b.spot) * 100).toFixed(1) } : null,
      read: { call: cr, put: pr, box: boxVerdict(cd, pd, priceWord(sp)) },
    });
  }
  return { available: true, as_of: last.date, symbol, spot: num(last.spot), expiries,
           note: 'Walls are each expiry\'s heaviest gamma strike either side, one reading per session. Gamma reprices with spot, so a wall moving WITH price may be repricing as much as new open interest; a move against or without price is new open interest.' };
}
