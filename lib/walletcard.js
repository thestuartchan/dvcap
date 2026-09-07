// lib/walletcard.js — the wallet, for a PUBLIC channel.
//
// The console's wallet view is the opposite of publishable: it exists to show balances, free versus
// resting, dollar values and a cross-chain total. This takes the same data and publishes what a
// stranger may see — which is the composition and the market prices, and none of the size.
//
// SAME DOCTRINE AS lib/tradecard.js, because the reasoning is identical. Four quantities never
// leave: SIZE, ABSOLUTE P&L, MARKET VALUE, SHARE OF BOOK. Enforced the way that file enforces it —
// by construction, with an allow-list rather than a deny-list, and by tests that build rows whose
// private values are distinctive digit strings and assert those strings appear nowhere in the
// serialised output.
//
// ── TWO THINGS ARE CALLED "PRICE" AND ONLY ONE OF THEM IS ABOUT THE OWNER ──────────────────────
// A HOLDINGS price is the current market price of a token. It is identical for every holder on
// earth and is already on Dexscreener. It is published, because it is the whole point of a holdings
// overview and it identifies nobody.
//
// An ENTRY price is what THIS wallet paid, and it belongs to one transaction. Published next to a
// token and a time window, it pins a single swap out of the few in that window — and a swap names
// an address. So it is NOT published, and it is not even carried on the event object: EVENT_PUBLIC
// _FIELDS has no price in it, so it cannot reach a payload by accident.
//
// WHAT PUBLISHING THIS STILL DISCLOSES, stated plainly because it is the part no field-level rule
// fixes: the holdings SET is itself a fingerprint. ERC-20 holder lists are public and indexed, so
// intersecting the holders of two or three obscure tokens very likely yields one address — with no
// timing and no prices needed. That is accepted knowingly here: this is a bounded project wallet,
// not a net-worth account, and the tokens are the reason the card exists. It is recorded so the
// next reader does not mistake the price rules for a solution to it.

import { fmtPrice } from './price.js';
import { priceMaxDp } from './crypto.js';
import { chainMark, chainLogo } from './chains.js';
import { rOf } from './tradecard.js';

// The only fields that may reach a payload. Anything not named here is dropped, so a field added
// upstream is invisible until somebody decides otherwise. Split in two because the two rows publish
// deliberately different things — see the note above.
export const HOLDING_PUBLIC_FIELDS = Object.freeze(['symbol', 'chain', 'price', 'changePercent']);
export const EVENT_PUBLIC_FIELDS = Object.freeze(['kind', 'symbol', 'chain']);
// Kept as the union under its old name so anything importing it still gets a true answer.
export const WALLET_PUBLIC_FIELDS = Object.freeze([...new Set([...HOLDING_PUBLIC_FIELDS, ...EVENT_PUBLIC_FIELDS])]);

// Below this, nothing is said. Gas dust moves a native balance on every transaction, and a card
// that fires on it is a card nobody reads. Set from how the account actually trades: tranches are
// not bought under twenty dollars, so a change smaller than that is not a decision.
export const MIN_NOTIONAL_USD = 20;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// One holding, stripped to what a stranger may see. No total, no free/hold split, no value.
export function walletPublicView(row, chain) {
  if (!row?.coin) return null;
  return {
    symbol: String(row.coin),
    chain: chain ?? null,
    price: num(row.price),
    changePercent: num(row.changePercent),
  };
}

// ── PERPS ────────────────────────────────────────────────────────────────────
// A perp is not a holding and is not diffed like one. A holding has a quantity that went up or
// down; a perp is a POSITION with a direction, an invalidation level and an objective, and the
// interesting thing about it is the shape of the risk rather than the change in the balance.
//
// PUBLISHED: symbol, direction, mark, the stop and target LEVELS, and R. Levels and R are what a
// trade-idea channel is for — they are the idea — and lib/tradecard.js has published exactly these
// for the swing book since it was written. R is computed by that same rOf, not reimplemented: one
// definition of R across both cards, and it already handles a short correctly, which is the part a
// second implementation would get wrong.
//
// NEVER: size, notional, margin used, unrealised P&L, leverage — the forbidden four plus the two
// that stand in for them. And NOT the LIQUIDATION price, which is excluded by instruction and would
// leak size anyway, being a function of margin.
//
// ENTRY IS NOT PRINTED, and it is worth saying why that is presentation rather than protection:
// entry is recoverable from the mark, the stop and R by algebra. It is left off because it was not
// asked for and the line is better short, not because publishing R conceals it.
export const PERP_PUBLIC_FIELDS = Object.freeze(['symbol', 'side', 'price', 'stop', 'target', 'r', 'targetR']);

// The operative level is the one that would fire FIRST — nearest the mark on its own side. A
// position can rest several; the far ones are not what is currently at stake.
const nearest = (levels, price) => {
  if (!levels?.length || price == null) return levels?.length ? levels[0] : null;
  return levels.reduce((best, l) => (Math.abs(l - price) < Math.abs(best - price) ? l : best), levels[0]);
};

export function perpPublicView(pos, levels = null, price = null) {
  if (!pos?.coin) return null;
  const side = pos.side === 'short' ? 'short' : 'long';
  const mark = num(price) ?? num(pos.price);
  const stop = nearest(levels?.stops, mark);
  const target = nearest(levels?.targets, mark);
  return {
    symbol: String(pos.coin),
    side,
    price: mark,
    stop: num(stop),
    target: num(target),
    // Where the trade is now, and what the objective is worth, both in units of the risk taken.
    // Null without a stop, which is rOf's own answer: there is nothing for R to be a multiple of.
    r: rOf(mark, pos.entry, stop, side),
    targetR: rOf(target, pos.entry, stop, side),
  };
}

const rTag = (r) => (r == null ? '' : ` (${r > 0 ? '+' : ''}${r}R)`);

export function perpLine(v) {
  const px = (n) => (n == null ? '—' : fmtPrice(n, { maxDp: priceMaxDp(v.symbol) }));
  // Direction is spelled out on every line rather than marked. On the swing card the marker is
  // hidden for an all-long book, which is right there and wrong here: a short read as a long is the
  // worst error this card can make, and there are few enough lines to spend the word.
  const dot = v.r == null ? '⚪' : (v.r > 0 ? '🟢' : '🔴');
  const bits = [`${dot} **${v.symbol}** ${v.side === 'short' ? 'Short' : 'Long'} ${px(v.price)}${rTag(v.r)}`];
  if (v.stop != null) bits.push(`SL ${px(v.stop)}`);
  if (v.target != null) bits.push(`TP ${px(v.target)}${rTag(v.targetR)}`);
  // Said out loud rather than left as an absence: a missing stop on a leveraged position is the
  // single most important thing a glance at this card could tell you.
  if (v.stop == null) bits.push('_no stop_');
  return bits.join(' · ');
}

// ── WHAT CHANGED, AND WHETHER IT WAS A DECISION ──────────────────────────────
// Compared on NOTIONAL, not on quantity: a thousand of something worthless and a thousandth of
// something valuable are the same number and not the same event. The notional is used to decide and
// is then thrown away — like the entry price, it never reaches the card.
export function diffHoldings(before = [], after = [], { minNotional = MIN_NOTIONAL_USD } = {}) {
  const key = (r) => `${r.chain || ''}:${r.coin}`;
  const prev = new Map(before.filter(r => r?.coin).map(r => [key(r), r]));
  const next = new Map(after.filter(r => r?.coin).map(r => [key(r), r]));
  const events = [];

  const notional = (r, qty) => {
    const p = num(r?.price);
    return p == null ? null : Math.abs(qty * p);
  };

  for (const [k, b] of next) {
    const a = prev.get(k);
    const qb = num(b.total) ?? 0, qa = num(a?.total) ?? 0;
    const delta = qb - qa;
    if (delta === 0) continue;
    const moved = notional(b, delta);
    // An unpriced token cannot be shown to be material, so it is not reported. Silence beats a card
    // about a token nobody can value.
    if (moved == null || moved < minNotional) continue;
    events.push({ kind: a ? (delta > 0 ? 'added' : 'trimmed') : 'bought',
                  symbol: String(b.coin), chain: b.chain ?? null });
  }
  for (const [k, a] of prev) {
    if (next.has(k)) continue;
    const moved = notional(a, num(a.total) ?? 0);
    if (moved == null || moved < minNotional) continue;
    events.push({ kind: 'sold', symbol: String(a.coin), chain: a.chain ?? null });
  }
  return sortEvents(events);
}

// Bought and sold first — they are decisions. Adjustments after.
const RANK = { bought: 0, sold: 1, added: 2, trimmed: 3 };
function sortEvents(events) {
  return events.slice().sort((x, y) =>
    (RANK[x.kind] - RANK[y.kind]) || String(x.symbol).localeCompare(String(y.symbol)));
}

// ── ACCUMULATING A DAY ───────────────────────────────────────────────────────
// Detection runs every half hour so a position opened and closed inside one day is still seen;
// posting happens once. This merges a fresh batch into the buffered one.
//
// Identity is (kind, symbol, chain) — which since the entry price left is the WHOLE event, so
// collapsing on it loses nothing. That makes the merge idempotent: a run that detected, buffered,
// then failed to advance its snapshot re-detects the same events next time and they fold back into
// the one entry instead of appearing twice. Buying and later trimming the same token are different
// kinds, so both survive — that is a real pair of decisions and the card should say so.
export function mergePending(pending = [], fresh = []) {
  const seen = new Map();
  for (const e of [...pending, ...fresh]) {
    if (!e?.symbol || !RANK.hasOwnProperty(e.kind)) continue;
    const k = `${e.kind}:${e.chain || ''}:${e.symbol}`;
    if (!seen.has(k)) seen.set(k, { kind: e.kind, symbol: String(e.symbol), chain: e.chain ?? null });
  }
  return sortEvents([...seen.values()]);
}

const VERB = Object.freeze({ bought: '🟢 Bought', sold: '🔴 Sold', added: '🟢 Added to', trimmed: '🔴 Trimmed' });

// No price. The verb and the token are the idea; the number was the fingerprint.
export function eventLine(e) {
  return `${VERB[e.kind] || e.kind} **${e.symbol}**${e.chain ? ` · ${e.chain}` : ''}`;
}

// Used only when the card cannot group by chain — see buildWalletCard. Carries the chain's mark
// and its name, because in that layout nothing else says which chain a row belongs to.
export function holdingLine(h) {
  const px = h.price == null ? null : fmtPrice(h.price, { maxDp: priceMaxDp(h.symbol) });
  const chg = h.changePercent == null ? '' : ` (${h.changePercent > 0 ? '+' : ''}${h.changePercent}%)`;
  return `${chainMark(h.chain)} **${h.symbol}** ${px ? px : '—'}${chg}${h.chain ? ` · ${h.chain}` : ''}`;
}

// The grouped form: no mark and no chain name, because the embed this sits in is headed by both.
export function groupedHoldingLine(h) {
  const px = h.price == null ? null : fmtPrice(h.price, { maxDp: priceMaxDp(h.symbol) });
  const chg = h.changePercent == null ? '' : ` (${h.changePercent > 0 ? '+' : ''}${h.changePercent}%)`;
  return `**${h.symbol}** ${px ? px : '—'}${chg}`;
}

// ── THE PAYLOAD ──────────────────────────────────────────────────────────────
// Built from the allow-listed views only, so nothing rides along from upstream.
//
// Holdings are GROUPED INTO ONE EMBED PER CHAIN, each headed by that chain's real logo. That shape
// is forced by Discord rather than chosen for looks: an embed description cannot carry inline
// images and markdown image syntax does not render inside one, so an embed's author icon is the
// only place an arbitrary image can sit next to text. Grouping also shortens every line, since the
// chain no longer has to be repeated on each.
//
// A message takes at most ten embeds. One is spent on the day's events, so beyond nine chains the
// card falls back to a single flat list marked with the Unicode chain marks — fewer decorations
// rather than a truncated wallet.
const MAX_EMBEDS = 10;
const NEUTRAL = 0x64748B;

// A chain earns its own section by holding more than one thing. A chain carrying only its gas token
// is not a position, it is the fee left over from making one somewhere else, and a logo-headed
// section announcing "ETH" is a lot of card for a fact nobody acts on. Two is the bar because on a
// chain where gas is held, one real position already reads as two holdings.
//
// Thin chains are dropped SILENTLY, by decision: an earlier version named them in a muted line and
// that line was more noise than the rows it replaced. Nothing is lost that the card was for — a
// trade on a dropped chain is still announced in the events above, so activity always surfaces even
// when the standing balance does not. The console remains the place that shows everything.
export const MIN_CHAIN_HOLDINGS = 2;

export function buildWalletCard(events = [], holdings = [], { title = 'Wallet · today', perps = [] } = {}) {
  const evs = events.filter(e => e?.symbol && VERB[e.kind]);
  const held = holdings.filter(h => h && h.symbol);
  const accent = evs.some(e => e.kind === 'bought' || e.kind === 'added') ? 0x16A34A : NEUTRAL;

  // Grouped in first-seen order, which diffHoldings already sorted.
  const groups = new Map();
  for (const h of held) {
    const k = h.chain || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }

  // Dropped BEFORE the embed cap is measured, so thin chains cannot push a real one out.
  const shown = new Map();
  for (const [chain, rows] of groups) {
    if (rows.length >= MIN_CHAIN_HOLDINGS) shown.set(chain, rows);
  }

  const lead = {
    title,
    description: evs.length ? evs.map(eventLine).join('\n') : '_No changes today._',
    color: accent,
  };
  const embeds = [lead];

  // PERPS LEAD THE HOLDINGS. A leveraged position with a stop is the thing on this card that can
  // demand a decision today; a spot balance mostly cannot. It is also NOT subject to the
  // two-holdings rule that thins the chain sections — one open position is exactly the case worth
  // showing, and the rule exists to hide leftover gas rather than positions.
  const pv = perps.map(p => (p?.symbol ? p : null)).filter(Boolean);
  if (pv.length) {
    const icon = chainLogo('Hyperliquid');
    embeds.push({
      author: { name: 'Hyperliquid · perps', ...(icon ? { icon_url: icon } : {}) },
      description: pv.map(perpLine).join('\n'),
      color: NEUTRAL,
    });
  }

  if (shown.size && shown.size <= MAX_EMBEDS - embeds.length) {
    for (const [chain, rows] of shown) {
      const icon = chainLogo(chain);
      embeds.push({
        // The events embed carries the accent; the inventory stays neutral, so the colour means
        // "something happened" rather than decorating every block.
        ...(chain ? { author: { name: chain, ...(icon ? { icon_url: icon } : {}) } } : {}),
        description: rows.map(groupedHoldingLine).join('\n'),
        color: NEUTRAL,
      });
    }
  } else if (shown.size) {
    const flat = [...shown.values()].flat();
    lead.description += `\n\n__**Holdings**__\n${flat.map(holdingLine).join('\n')}`;
  }

  // Footer and timestamp on the LAST embed only — Discord draws them per embed, and repeating them
  // under every chain would say the same thing four times.
  // No total, and no count of anything countable: a footer saying "12 positions" is share-of-book
  // arithmetic waiting to happen once somebody knows one of them.
  const last = embeds[embeds.length - 1];
  last.footer = { text: 'Market prices at time of post' };
  last.timestamp = new Date().toISOString();
  return { embeds };
}
