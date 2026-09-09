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
  const vals = peers.map(num).filter(v => v != null).sort((a, b) => a - b);
  // ONE PEER IS ENOUGH. Requiring two silently dropped the tag from every megacap, because the US
  // universe carries exactly two of them — so the entries most in need of context were the ones
  // that got none. With a single peer the comparison is just that peer, which is still a fact.
  if (!vals.length) return { tag: null, groupMove: null };

  // A SPLIT GROUP HAS NO MIDDLE. With chips at −0.91, −0.83, +1.03, +2.75 the median is +0.10 and
  // every member reads as "moving alone against a flat group" — which is false twice over: the
  // group is not flat, and the members are not alone. Two of them are on each side. That is a
  // rotation, it is the most informative thing on the board when it happens, and taking a median
  // through the middle of it destroys exactly that.
  const half = WATCH_MIN_PCT / 2;
  const up = vals.filter(v => v >= half).length, down = vals.filter(v => v <= -half).length;
  if (up >= 2 && down >= 2) return { tag: 'the group is split', groupMove: null, split: { up, down } };

  const mid = vals.length % 2 ? vals[(vals.length - 1) / 2]
    : (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2;
  const groupMove = +mid.toFixed(2);
  // Opposite signs and the group actually moved: this one is going the other way.
  if (Math.sign(move) !== Math.sign(groupMove) && Math.abs(groupMove) >= half) {
    return { tag: 'against the group', groupMove };
  }
  if (Math.abs(move - groupMove) <= GROUP_TOL_PCT) return { tag: 'with the group', groupMove };
  return { tag: 'moving alone', groupMove };
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
    const peers = rows.filter(o => o.bucket === r.bucket && o.sym !== r.sym).map(o => o.changePct);
    const c = corroborate(r.changePct, peers);
    return { ...r, tag: c.tag, groupMove: c.groupMove, ...(c.split ? { split: c.split } : {}) };
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
    return line;
  }).join('\n');
}
