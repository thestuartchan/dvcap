// lib/watchlist.js — "what is worth watching today", from public market data only.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE.
//
// 1. NOTHING FROM THE BOOK. The pre-read goes to a public channel. An earlier draft ranked by
//    portfolio weight and quoted a position's average cost and lot basis, which would have put
//    holdings, sizes and entry prices into a channel the standing rule keeps them out of. The
//    candidates here are the region's configured universe and nothing else — there is no argument
//    through which a position can reach this function.
//
// 2. NO QUALITY RATING. Scoring a setup is a judgement that shades into advice, and
//    assertObservational fails the brief on directive language for exactly that reason. What IS
//    objective is whether a move is CORROBORATED — alone, with its group, or against it — and that
//    turns out to be the more useful thing anyway. On 2026-09-09 knowing MU was moving alone while
//    INTC was on the same side changed the story from "MU popped" to "domestic and memory are bid
//    against the leaders", which is a different claim and only visible once corroboration is shown.
//
// Tags are words, not colours. The brief already spends colour on gauge state in its backdrop, and
// a second colour vocabulary in the same message is how the first draft became unreadable.
import { renderAdjacent } from '../data/adjacent.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

export const WATCH_MAX = 5;
// Below this a name is not moving, it is drifting, and putting it on a watchlist invents an entry.
export const WATCH_MIN_PCT = 0.75;
// How far a name has to sit from its group's median before "with the group" stops being true.
export const GROUP_TOL_PCT = 0.5;

// The group a name belongs to, for corroboration. Roles come from data/universe.js; several map to
// one bucket because "is this a chip story or a megacap story" is the question being asked.
const BUCKET = {
  gpu: 'chips', memory: 'chips', 'foundry-leading': 'chips', 'foundry-mature': 'chips',
  equip: 'chips', analog: 'chips', litho: 'chips', megacap: 'megacaps',
};
export const bucketOf = (role) => BUCKET[role] || 'other';

// ── CORROBORATION ────────────────────────────────────────────────────────────
// Against the MEDIAN of its group rather than the mean: one name moving 8% drags a mean and then
// reports itself as being in line with the group it is actually diverging from.
export function corroborate(move, peers) {
  // Peers arrive as {name, changePct}. A bare list of numbers was enough to say "alone or not"
  // and not enough to say WHO — and who is the useful half.
  const rows = (peers || []).map(p => (typeof p === 'number' ? { name: null, changePct: p } : p))
    .filter(p => num(p?.changePct) != null);
  if (!rows.length) return { tag: null, groupMove: null };

  // A MEDIAN IS THE WRONG INSTRUMENT HERE, and the live Asia brief proved it: BYD −2.44% and
  // Xiaomi −2.01% moved together, but Tencent and Alibaba sat flat, so the megacap median came out
  // at −0.3% and BOTH were tagged "moving alone". They were not alone; they were with each other.
  //
  // So corroboration is counted, not averaged. How many peers moved the same way, and how many
  // moved the other way — a question a middle cannot answer.
  const half = WATCH_MIN_PCT / 2;
  const agree = rows.filter(p => Math.sign(p.changePct) === Math.sign(move) && Math.abs(p.changePct) >= half);
  const against = rows.filter(p => Math.sign(p.changePct) !== Math.sign(move) && Math.abs(p.changePct) >= half);

  if (agree.length >= 2 && against.length >= 2) {
    return { tag: 'the group is split', split: { up: agree.length, down: against.length } };
  }
  if (!agree.length && against.length) return { tag: 'against the group', against: against.length };
  // NAME THEM WHILE THEY FIT. "with Xiaomi (−2.0%)" is a fact the reader can check; "with the
  // group" is a summary they cannot. Past two the names stop fitting and the count is the point.
  if (agree.length && agree.length <= 2 && agree.every(p => p.name)) {
    return { tag: `with ${agree.map(p => `${p.name} (${p.changePct > 0 ? '+' : ''}${p.changePct.toFixed(1)}%)`).join(' and ')}`, agree: agree.length };
  }
  if (agree.length) return { tag: `with ${agree.length} of the group`, agree: agree.length };
  // Nothing moved either way: the group is flat and this one genuinely is on its own.
  return { tag: 'moving alone', agree: 0 };
}

// `names` are the region's configured universe entries ({ name, sym, role }); `quote(sym)` returns
// { price, changePercent } or null. Returns UP TO five, biggest move first. Fewer is the normal
// outcome on a quiet day and is not remarked on anywhere — a brief that explains why it has four
// entries instead of five is spending the reader's attention on its own bookkeeping.
export function watchlist(names = [], quote = () => null, { max = WATCH_MAX, minPct = WATCH_MIN_PCT } = {}) {
  const rows = [];
  for (const n of (names || [])) {
    const q = quote(n.sym);
    const chg = num(q?.changePercent), px = num(q?.price);
    if (chg == null || px == null) continue;
    rows.push({ name: n.name, sym: n.sym, role: n.role, leader: !!n.leader,
                bucket: bucketOf(n.role), price: px, changePct: +chg.toFixed(2) });
  }
  const movers = rows.filter(r => Math.abs(r.changePct) >= minPct)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, max);
  return movers.map(r => {
    const peers = rows.filter(o => o.bucket === r.bucket && o.sym !== r.sym)
      .map(o => ({ name: o.name, changePct: o.changePct }));
    const c = corroborate(r.changePct, peers);
    return { ...r, tag: c.tag, ...(c.split ? { split: c.split } : {}) };
  });
}

// ── THE SECTION ──────────────────────────────────────────────────────────────
// Empty renders NOTHING — not "no names cleared", not a count of how many slots went unused. A
// brief that narrates its own bookkeeping spends the reader's attention on the brief instead of
// on the market.
const sign = (v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}%`;
export function renderWatchlist(rows = []) {
  if (!rows.length) return null;
  return rows.map(r => {
    const bits = [`**${r.name}**`, r.price >= 1000 ? r.price.toLocaleString() : String(r.price), sign(r.changePct)];
    let line = `• ${bits.join(' · ')}`;
    if (r.tag) line += ` — _${r.tag}_`;
    // The leveraged or inverse instrument beside the name, chosen by DIRECTION. Absent whenever
    // there is no counterpart on that side, which is most of the time and must render as nothing.
    line += renderAdjacent(r.sym, r.changePct);
    return line;
  }).join('\n');
}
