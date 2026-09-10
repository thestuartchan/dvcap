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
import { watchName, watchLevels } from '../data/watchMeta.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

export const WATCH_MAX = 5;
// Below this a name is not moving, it is drifting, and putting it on a watchlist invents an entry.
export const WATCH_MIN_PCT = 0.75;
// How far a name has to sit from its group's median before "with the group" stops being true.
export const GROUP_TOL_PCT = 0.5;

// ── WHICH PEERS ──────────────────────────────────────────────────────────────
// Corroboration is only as good as the group it compares against, and the first version had no
// real group at all: `role` is only set on the ten-name semis list in data/universe.js, so every
// one of the sixty-three names the watch universe actually scans fell through to a single bucket
// called 'other'. Sixty-three names always contain something up and something down, which is why
// the live Asia brief tagged all five rows "the group is split" — the same words every time, on
// every name. A bucket that cannot produce a second answer is not a measurement.
//
// TWO LEVELS, NARROWEST FIRST (data/watchMeta.js): the industry, then the sector. Neither works
// alone. "tech" is fifty-three names and reproduces the bug one level up; "solar" is one name and
// fails the other way — a lone member has no peers, and reporting it as "moving alone" claims its
// peers went elsewhere when it does not have any.
//
// So the sub-group is used when it has enough members to carry a verdict, and the comparison
// WIDENS to the sector when it does not.
//
// ONE PEER IS THE FLOOR, not two. Two was tried and it silenced the rows most in need of context:
// GOOGL and META are the only two internet names in the US universe, so each had exactly one peer,
// widened to a sector holding the same two, and came out with no tag at all. One peer cannot
// support a claim about a GROUP — but it fully supports a claim about that peer, and "with META
// (−2.1%)" is a checkable fact where "with the group" is a summary the reader cannot verify. The
// naming rule below is what makes the floor safe: at one or two peers they are named individually,
// and only past that does the output speak about a group.
export const GROUP_MIN_PEERS = 1;

// The narrowest level that has enough peers IN THIS REGION'S SCANNED ROWS — availability is
// counted against what was actually quoted today, not against the size of the universe, because a
// group whose members all failed to quote is thin in exactly the way that matters.
export function groupFor(sym, rows = []) {
  const levels = watchLevels(sym);
  for (const lvl of levels) {
    const peers = rows.filter(o => o.sym !== sym && o.levels?.includes(lvl));
    if (peers.length >= GROUP_MIN_PEERS) return { level: lvl, peers };
  }
  // A name with no level, or with no populated one, is compared against NOTHING rather than
  // against everything. The row then carries no tag at all, which is the honest output.
  return { level: null, peers: [] };
}

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
  // NAME THE OTHER SIDE TOO. "against the group" over a single peer describes a group of one,
  // which is not a group — and the reader cannot tell from those words whether they are being told
  // about one name or twelve.
  if (!agree.length && against.length) {
    if (against.length <= 2 && against.every(p => p.name)) {
      return { tag: `against ${against.map(p => `${p.name} (${p.changePct > 0 ? '+' : ''}${p.changePct.toFixed(1)}%)`).join(' and ')}`, against: against.length };
    }
    return { tag: 'against the group', against: against.length };
  }
  // NAME THEM WHILE THEY FIT. "with Xiaomi (−2.0%)" is a fact the reader can check; "with the
  // group" is a summary they cannot. Past two the names stop fitting and the count is the point.
  if (agree.length && agree.length <= 2 && agree.every(p => p.name)) {
    return { tag: `with ${agree.map(p => `${p.name} (${p.changePct > 0 ? '+' : ''}${p.changePct.toFixed(1)}%)`).join(' and ')}`, agree: agree.length };
  }
  // "with 4 of the group" reads as four out of the group's total; it is four members that agreed,
  // out of however many there are. "with 4 others in" says the second thing and cannot be read as
  // the first.
  // "with 4 of the group" reads as four out of the group's total; it is four members that agreed,
  // out of however many there are. "with 4 others in" says the second thing and cannot be read as
  // the first. Reached at one only when that peer has no name to print.
  if (agree.length) {
    return { tag: `with ${agree.length} other${agree.length === 1 ? '' : 's'} in the group`, agree: agree.length };
  }
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
    // The DISPLAY name, resolved here rather than at the render site, so a row carries the same
    // string everywhere it is used. "373220.KS" is a correct identifier and not a readable one.
    rows.push({ name: n.name && n.name !== n.sym ? n.name : watchName(n.sym), sym: n.sym,
                levels: watchLevels(n.sym), leader: !!n.leader, price: px, changePct: +chg.toFixed(2) });
  }
  const movers = rows.filter(r => Math.abs(r.changePct) >= minPct)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, max);
  return movers.map(r => {
    const { level, peers } = groupFor(r.sym, rows);
    if (!peers.length) return { ...r, group: null, tag: null };
    const c = corroborate(r.changePct, peers.map(o => ({ name: o.name, changePct: o.changePct })));
    // The GROUP IS NAMED. "the group is split" never said which group, so a reader could not tell
    // whether the split was among twelve chipmakers or among everything quoted that morning — and
    // those are opposite pieces of news.
    const tag = c.tag ? c.tag.replace(/\bthe group\b/g, level) : null;
    return { ...r, group: level, tag, ...(c.split ? { split: c.split } : {}) };
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
    // ── BOTH, NOT EITHER ───────────────────────────────────────────────────────
    // The first version shipped bare tickers: "373220.KS +6.46%" told a reader nothing about what
    // it was. Replacing them with names shipped the opposite failure — "Largan · 6,870 · +5.69%"
    // is recognisable and cannot be typed into an order ticket. The name is what makes the row
    // worth reading; the ticker is what makes it actionable, and a watchlist needs to be both.
    //
    // In a code span, so the ticker is visually separate from the prose and can be copied out of
    // Discord as one tap without catching the surrounding punctuation.
    const ident = r.sym && r.sym !== r.name ? `**${r.name}** \`${r.sym}\`` : `**${r.name}**`;
    const bits = [ident, r.price >= 1000 ? r.price.toLocaleString() : String(r.price), sign(r.changePct)];
    let line = `• ${bits.join(' · ')}`;
    if (r.tag) line += ` — _${r.tag}_`;
    // The leveraged or inverse instrument beside the name, chosen by DIRECTION. Absent whenever
    // there is no counterpart on that side, which is most of the time and must render as nothing.
    line += renderAdjacent(r.sym, r.changePct);
    return line;
  }).join('\n');
}
