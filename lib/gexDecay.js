// lib/gexDecay.js — what stops existing at the next expiry, and what the book looks like after.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// Every level on the GEX board is a statement about positioning that has an expiry date, and the
// board never said when. A put wall carrying 6.5× the calls is a floor; a put wall carrying 6.5×
// the calls that is 62% today's expiry is a floor until 4pm. Those are different facts and they
// rendered identically.
//
// The pieces were already computed and thrown away: gammaGrid knows each expiry's share of the
// gross gamma and where each expiry's own book peaks, and walls()/flipLevel() will run over any
// subset of the chain. So the question "what survives tonight" is answerable exactly, by running
// the same functions over the chain with the front expiry removed — no estimate, no new fetch.
//
// OBSERVATIONAL. This says what an arrangement is and what it becomes; it never says what to do
// about it. lib/read.js's assertion runs over these strings.
import { walls, flipLevel, contractGamma } from './gex.js';

// How far a wall has to move before the move is worth a sentence. Below this the level is the same
// level with a different rounding, and reporting it as a shift trains a reader to ignore the line.
export const WALL_MOVE_PCT = 0.15;
// A wall this much of one expiry is that expiry's opinion. Below it, other books are holding the
// strike up too and it does not vanish with the front.
export const SUPPORT_HEAVY = 50;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (a, b) => (b > 0 ? +((a / b) * 100).toFixed(1) : null);

// Gamma-weighted open interest at ONE strike, split into the front expiry and everything else.
// This is the question "how much of this wall is today" asked exactly rather than inferred from
// the expiry's share of the whole book — a 36% front expiry can be 80% of one strike.
export function strikeSupport(chain = [], strike, front, side, opts = {}) {
  if (strike == null || !front) return null;
  let frontG = 0, total = 0;
  for (const c of (Array.isArray(chain) ? chain : [])) {
    if (num(c?.strike) !== num(strike)) continue;
    if (side && c.type !== side) continue;
    const oi = num(c?.oi), g = contractGamma(c, opts);
    if (oi == null || g == null || oi <= 0) continue;
    const w = g * oi;
    total += w;
    if (c.expiry === front) frontG += w;
  }
  if (!(total > 0)) return null;
  return { frontShare: pct(frontG, total), total, front: frontG };
}

const moved = (from, to, spot) => {
  if (from == null || to == null || !(spot > 0)) return null;
  const deltaPct = ((to - from) / spot) * 100;
  return { from, to, delta: +(to - from).toFixed(2), deltaPct: +deltaPct.toFixed(2),
           material: Math.abs(deltaPct) >= WALL_MOVE_PCT };
};

export function decayRead(chain = [], { S, r = 0, q = 0, now, callWall = null, putWall = null,
                                         flip = null, frontExpiry = null, frontShare = null,
                                         today = null } = {}) {
  const rows = Array.isArray(chain) ? chain : [];
  if (!rows.length || !(S > 0)) return null;
  const opts = { S, r, q, now };
  const front = frontExpiry || rows.map(c => c.expiry).filter(Boolean).sort()[0] || null;
  if (!front) return null;

  const rest = rows.filter(c => c.expiry !== front);
  // Nothing behind the front expiry is a real state and a loud one: the entire book expires today.
  const after = rest.length ? walls(rest, opts) : { callWall: null, putWall: null };
  const flipAfter = rest.length ? flipLevel(rest, opts) : null;

  let callOi = 0, putOi = 0;
  for (const c of rows) {
    if (c.expiry !== front) continue;
    const oi = num(c?.oi) || 0;
    if (c.type === 'call') callOi += oi; else putOi += oi;
  }

  const dayOf = (t) => String(t || '').slice(0, 10);
  const nowDay = today || dayOf(now) || new Date().toISOString().slice(0, 10);
  const expiringToday = front === nowDay;

  const support = {
    call: strikeSupport(rows, callWall, front, 'call', opts),
    put: strikeSupport(rows, putWall, front, 'put', opts),
  };
  const moves = {
    callWall: moved(callWall, after.callWall, S),
    putWall: moved(putWall, after.putWall, S),
    flip: moved(flip, flipAfter?.level ?? flipAfter ?? null, S),
  };

  return {
    front, frontShare, expiringToday,
    rollingOff: { callOi, putOi, oi: callOi + putOi },
    remainingExpiries: [...new Set(rest.map(c => c.expiry).filter(Boolean))].sort(),
    after: { callWall: after.callWall, putWall: after.putWall, flip: flipAfter?.level ?? flipAfter ?? null },
    support, moves,
    lines: decayLines({ front, frontShare, expiringToday, support, moves, rest: rest.length }),
  };
}

// ── SAID IN WORDS ────────────────────────────────────────────────────────────
// A level that survives is worth one line; a level that does not is worth the sentence that names
// its replacement. Nothing here is rendered when nothing moves and nothing is one expiry's book —
// a tile that reports "no change" every day trains a reader to skip it on the day there is one.
export function decayLines({ front, frontShare, expiringToday, support, moves, rest } = {}) {
  const out = [];
  const when = expiringToday ? "today's close" : `${front}`;
  if (!rest) {
    out.push(`**Every contract on the board expires at ${when}.** After it there is no positioning left to hold anything.`);
    return out;
  }
  if (frontShare != null) {
    out.push(`**${frontShare}% of the gross gamma expires at ${when}**${expiringToday ? '' : ` (${front})`}.`);
  }
  const wall = (label, s, m) => {
    if (!m) return;
    const heavy = s?.frontShare != null && s.frontShare >= SUPPORT_HEAVY;
    if (m.material) {
      out.push(`The **${label} at ${m.from}** ${heavy ? `is ${s.frontShare}% that expiry, and ` : ''}`
        + `does not survive it — the heaviest ${label.split(' ')[0]} positioning behind it sits at **${m.to}** `
        + `(${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}%).`);
    } else if (heavy) {
      // The strike holds even though most of it goes: other expiries peak there too.
      out.push(`The **${label} at ${m.from}** is ${s.frontShare}% that expiry, but the strike holds — later books peak there as well.`);
    }
  };
  wall('put wall', support?.put, moves?.putWall);
  wall('call wall', support?.call, moves?.callWall);
  if (moves?.flip?.material) {
    out.push(`The **pivot** moves from ${moves.flip.from} to **${moves.flip.to}** once that book is gone `
      + `(${moves.flip.deltaPct > 0 ? '+' : ''}${moves.flip.deltaPct}%).`);
  }
  if (out.length === 1 && frontShare != null) {
    out.push('Both walls and the pivot survive it — the levels on this board are not one expiry’s book.');
  }
  return out;
}
