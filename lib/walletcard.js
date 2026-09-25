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
import { chainMark, headerMark } from './chains.js';
import { rOf } from './tradecard.js';

// The only fields that may reach a payload. Anything not named here is dropped, so a field added
// upstream is invisible until somebody decides otherwise. Split in two because the two rows publish
// deliberately different things — see the note above.
export const HOLDING_PUBLIC_FIELDS = Object.freeze(['symbol', 'chain', 'price', 'changePercent', 'thin']);
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
    // Whether anything actually trades there. USDH printed 0.99105 on this card off a pair with
    // $4,809 of daily volume, beside USDC's 1.00 off a real one, in the same typeface — and the
    // reader had no way to tell which number would survive contact with an exit.
    thin: !!row.thin,
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

// ── WHAT MAY BE PUBLISHED AT ALL ─────────────────────────────────────────────
// 2026-09-21: the card announced "🟢 Bought PONS" on a day nothing was bought, and listed PONS
// twice at two prices. The wallet had received a second token wearing PONS's name — a different
// contract, its own pool, its own price — and the card keyed holdings by the raw symbol string, so a
// lookalike was a new holding, a new holding with a pool price over $20 was a buy, and a buy is what
// it said. Three rules, applied before anything is diffed or listed:
//
//   1. IDENTITY IS THE NORMALISED SYMBOL. Fullwidth letters, zero-width joiners and stray spaces are
//      folded away; a symbol that still is not plain ASCII after that is not published. The
//      spoof vector is exactly a name that renders like another, and a channel that prints it has
//      already lost.
//   2. WHAT ARRIVED UNBIDDEN IS NOT A HOLDING. A token nobody vouched for, priced only by a pool, that
//      the chain says the wallet never gave anything up for (`acquired === false`) is an airdrop —
//      and an airdrop is not a decision, so it is neither announced nor listed. Unknown (`null`,
//      the transfer history could not be read) keeps the row: hiding real holdings on a bad fetch
//      day is the worse error.
//   3. ONE SYMBOL PER CHAIN. Two rows on one chain sharing a normalised symbol keep the verified one,
//      else the one the wallet swapped for, else neither.
export const symbolKey = (sym) => String(sym ?? '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF\u00A0\s]/g, '').toUpperCase();
// Folding is for IDENTITY — it is what makes a spoof's arrival fold into the holding it imitates
// rather than read as a buy. It is not a licence to PUBLISH the folded name. A symbol that carries
// an invisible character was built to be read as something it is not, and is never plain.
// 2026-09-25: the "PONS" in the wallet was PO\u200bNS, a mass airdrop to ~28,700 addresses with no
// pool anywhere. Unpriced, it fell off the card anyway; with a pool it would have been printed
// as PONS at its own price.
export const hasInvisible = (sym) => /[\u200B-\u200D\u2060\uFEFF\u00AD]|\p{Cf}/u.test(String(sym ?? ''));
export const isPlainSymbol = (sym) => !hasInvisible(sym) && /^[A-Z0-9][A-Z0-9._$-]{0,23}$/.test(symbolKey(sym));
export const isUnsolicited = (r) => !!r?.viaPool && !r?.verified && r?.acquired === false;

// ── PROVENANCE MEMORY ────────────────────────────────────────────────────────
// 2026-09-24: the card said "No changes today" and the real PONS was gone from the list. The
// transfer history could not be read that morning, so both PONS rows — the holding and its
// lookalike — came back with provenance unknown, and rule 3, faced with two of a name it could not
// tell apart, published neither. Nothing was sold; the card simply forgot what it knew the day
// before. Once acquired, always acquired — lib/alchemy.js already says so for a later airdrop of the
// same token — so a row whose provenance is unknown TODAY takes yesterday's answer for the same
// contract on the same chain. Matched by address where both sides carry one (rows do since this
// change); a snapshot written before addresses existed matches by symbol and exact balance, which
// is what still tells a holding from its twin on a day nothing moved. Nothing is ever downgraded:
// a row the chain answered for today keeps today's answer.
export function inheritProvenance(rows = [], prev = []) {
  const prevRows = Array.isArray(prev) ? prev.filter(r => r?.coin && r.acquired != null) : [];
  if (!prevRows.length) return { rows: Array.isArray(rows) ? rows : [], inherited: 0 };
  let inherited = 0;
  const out = (Array.isArray(rows) ? rows : []).map(r => {
    if (!r?.coin || r.acquired != null || r.verified) return r;
    const same = prevRows.filter(p => (p.chain || '') === (r.chain || '') && symbolKey(p.coin) === symbolKey(r.coin));
    const byAddr = r.address ? same.filter(p => p.address && String(p.address).toLowerCase() === String(r.address).toLowerCase()) : [];
    const byQty = same.filter(p => !p.address && num(p.total) != null && num(p.total) === num(r.total));
    const hit = byAddr.length === 1 ? byAddr[0] : (!byAddr.length && byQty.length === 1) ? byQty[0] : null;
    if (!hit) return r;
    inherited += 1;
    return { ...r, acquired: !!hit.acquired, acquiredFrom: 'snapshot' };
  });
  return { rows: out, inherited };
}

// ── AND A MEMORY THAT OUTLIVES THE SNAPSHOT ──────────────────────────────────
// The snapshot is one day deep: the morning the chain would not answer overwrote yesterday's
// answers with unknowns, and a second bad morning would find nothing to inherit. So every row the
// chain has ever confirmed as swapped for is remembered by chain and contract, for good — the same
// "once acquired, always acquired" rule, kept somewhere a bad read cannot erase. Only TRUE is
// remembered: an airdrop can later be bought, so "not acquired" is never a permanent fact.
export const provenanceKey = (r) => (r?.address ? `${r.chain || ''}:${String(r.address).toLowerCase()}` : null);
export function rememberProvenance(rows = [], memory = {}) {
  const out = { ...(memory && typeof memory === 'object' ? memory : {}) };
  let added = 0;
  for (const r of (Array.isArray(rows) ? rows : [])) {
    const k = provenanceKey(r);
    if (!k || r.acquired !== true || r.acquiredFrom) continue;
    if (!out[k]) added += 1;
    out[k] = true;
  }
  return { memory: out, added };
}
// The memory as the wallet read wants it: chain label → contract addresses. Keys are
// "<chain label>:<address>", and a label never carries a colon, so the last one splits them.
export function pinsFromMemory(memory = {}) {
  const out = {};
  for (const [k, v] of Object.entries(memory && typeof memory === 'object' ? memory : {})) {
    if (v !== true) continue;
    const at = k.lastIndexOf(':');
    if (at <= 0) continue;
    const chain = k.slice(0, at), addr = k.slice(at + 1).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    (out[chain] ||= []).push(addr);
  }
  return out;
}
export function applyMemory(rows = [], memory = {}) {
  const m = memory && typeof memory === 'object' ? memory : {};
  let applied = 0;
  const out = (Array.isArray(rows) ? rows : []).map(r => {
    if (!r?.coin || r.acquired != null || r.verified) return r;
    const k = provenanceKey(r);
    if (!k || m[k] !== true) return r;
    applied += 1;
    return { ...r, acquired: true, acquiredFrom: 'memory' };
  });
  return { rows: out, applied };
}

export function publishable(rows = []) {
  const kept = (Array.isArray(rows) ? rows : []).filter(r => r?.coin && isPlainSymbol(r.coin) && !isUnsolicited(r));
  const byKey = new Map();
  for (const r of kept) {
    const k = `${r.chain || ''}:${symbolKey(r.coin)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const out = [];
  for (const group of byKey.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const verified = group.filter(r => r.verified);
    const swapped = group.filter(r => r.acquired === true);
    const pick = verified.length === 1 ? verified[0] : (!verified.length && swapped.length === 1) ? swapped[0] : null;
    if (pick) out.push(pick);
    // Two of a name and no way to tell them apart: the channel says nothing about either.
  }
  return out;
}

// What the gate did, as counts and names — never balances — so a run's answer can say that a
// symbol the card used to carry is being withheld, and why, before anyone notices its absence.
export function publishReport(rows = []) {
  const all = (Array.isArray(rows) ? rows : []).filter(r => r?.coin);
  const kept = new Set(publishable(all).map(r => `${r.chain || ''}:${symbolKey(r.coin)}`));
  const groups = new Map();
  for (const r of all) { const k = `${r.chain || ''}:${symbolKey(r.coin)}`; groups.set(k, [...(groups.get(k) || []), r]); }
  const withheld = [];
  for (const [k, g] of groups) {
    if (kept.has(k)) continue;
    const why = !g.every(r => isPlainSymbol(r.coin)) ? 'symbol not plain'
      : g.every(isUnsolicited) ? 'unsolicited'
      : g.length > 1 ? `${g.length} of a name, provenance ${g.map(r => r.acquired === true ? 'swapped' : r.acquired === false ? 'received' : 'unknown').join('/')}`
      : 'unsolicited';
    withheld.push({ symbol: k, why });
  }
  // AND EVERY ROW RULE 2 REMOVED, even when its symbol was kept through another row. A holding
  // judged an airdrop beside a same-named row that survived is otherwise invisible: its group is
  // "listed", and the row that was listed may be the wrong one (2026-09-25, PONS). Names and
  // whether a pool priced it — never a balance.
  const airdrops = all.filter(r => isPlainSymbol(r.coin) && isUnsolicited(r))
    .map(r => ({ symbol: `${r.chain || ''}:${symbolKey(r.coin)}`, priced: r.price != null, shadowed: kept.has(`${r.chain || ''}:${symbolKey(r.coin)}`) }));
  // WHICH CONTRACT STANDS FOR A CONTESTED SYMBOL. Where more than one row shares a key, the token
  // contract that was kept and the ones that were not — public token addresses, never the
  // wallet's — so "is that the real one" is answered by the run, not by the next card.
  const pub = new Set(publishable(all));
  const contested = [...groups].filter(([, g]) => g.length > 1).map(([k, g]) => ({
    symbol: k, kept: g.find(r => pub.has(r))?.address ?? null,
    dropped: g.filter(r => !pub.has(r)).map(r => r.address ?? null),
  }));
  return { listed: kept.size, withheld, airdrops, contested };
}

// ── WHAT CHANGED, AND WHETHER IT WAS A DECISION ──────────────────────────────
// Compared on NOTIONAL, not on quantity: a thousand of something worthless and a thousandth of
// something valuable are the same number and not the same event. The notional is used to decide and
// is then thrown away — like the entry price, it never reaches the card.
export function diffHoldings(before = [], after = [], { minNotional = MIN_NOTIONAL_USD } = {}) {
  const key = (r) => `${r.chain || ''}:${symbolKey(r.coin)}`;
  // Both sides pass through the same gate, so a lookalike or an airdrop is never a buy and a
  // holding hidden for that reason is never a sale.
  const prev = new Map(publishable(before).map(r => [key(r), r]));
  const next = new Map(publishable(after).map(r => [key(r), r]));
  // ── THE GATE CAN HIDE, BUT IT MUST NOT INVENT ──
  // 2026-09-21, second morning: "Bought PONS" again. The previous snapshot was written before rows
  // carried provenance, so its real PONS and its twin were two indistinguishable rows of one name
  // and the gate kept neither — and a holding absent from the gated past is a purchase. The raw
  // snapshot still knew PONS was held. So "bought" and "sold" are judged against EVERY row that was
  // there, gated or not: a symbol the wallet held yesterday under any row is not new today, and one
  // it holds today under any row was not sold. Only the size comparison uses the gated rows.
  const rawKeys = (rows) => {
    const m = new Map();
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (!r?.coin) continue;
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const rawPrev = rawKeys(before), rawNext = rawKeys(after);
  const events = [];

  const notional = (r, qty) => {
    const p = num(r?.price);
    return p == null ? null : Math.abs(qty * p);
  };

  for (const [k, b] of next) {
    let a = prev.get(k);
    if (!a) {
      const held = rawPrev.get(k) || [];
      if (held.length) {
        // Held yesterday in some form. Same size under any of those rows is no change at all;
        // otherwise the largest is the position and the rest were the noise beside it.
        if (held.some(c => num(c.total) === num(b.total))) continue;
        a = [...held].sort((x, y) => (num(y.total) ?? 0) - (num(x.total) ?? 0))[0];
      }
    }
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
    if (next.has(k) || rawNext.has(k)) continue;
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
  // Marked, not hidden. The holding is real and belongs on the card; what is unreliable is the
  // number beside it, and that is the thing to say.
  return `**${h.symbol}** ${px ? px : '—'}${chg}${h.thin ? ' ⚠️' : ''}`;
}

// A chain earns its own section by holding more than one thing. A chain carrying only its gas token
// is not a position, it is the fee left over from making one somewhere else, and a heading
// announcing "ETH" is a lot of card for a fact nobody acts on. Two is the bar because on a chain
// where gas is held, one real position already reads as two holdings.
//
// Thin chains are dropped SILENTLY, by decision: an earlier version named them in a muted line and
// that line was more noise than the rows it replaced. A trade on a dropped chain is still announced
// in the events above, so activity always surfaces even when the standing balance does not.
export const MIN_CHAIN_HOLDINGS = 2;

// Symbols the card does not carry, whatever the wallet holds. USDH is the case: its pair turns over
// about $4,800 a day, so the price beside it was never a price anyone could act on — marking it ⚠️
// said so, but a line that always carries a warning is a line that should not be there.
//
// CARD ONLY. The console still lists it, because "what do I hold" and "what is worth publishing"
// are different questions and the wallet has not changed. Env-overridable so the next one does not
// need a deploy.
export const HIDDEN_SYMBOLS = Object.freeze(['USDH']);

export function hiddenSymbols(env = process.env) {
  const raw = String(env.WALLET_HIDE || '').trim();
  if (!raw) return new Set(HIDDEN_SYMBOLS);
  return new Set(raw.split(',').map(x => x.trim().toUpperCase()).filter(Boolean));
}

// ── THE PAYLOAD ──────────────────────────────────────────────────────────────
// Built from the allow-listed views only, so nothing rides along from upstream.
//
// ONE EMBED. It was one embed PER CHAIN, because that is the only way Discord will draw a real
// logo next to text — an embed's author icon. Four stacked boxes for one wallet read as four
// separate messages rather than one card, which is worse than the thing the logos bought.
//
// So the chains are headings inside a single description, and the mark beside each comes from
// chainMark(). That is deliberate rather than a fallback: chainMark prefers a CUSTOM DISCORD
// EMOJI when DISCORD_CHAIN_EMOJI names one, and a custom emoji is the only image Discord renders
// inline in a description. Upload the logos to the server, set the map, and this same layout
// carries the real thing — one card, real logos, no per-chain boxes.
//
// Description caps at 4096 characters. A wallet that outgrows it loses the tail rather than the
// message, and says how many it dropped.
const NEUTRAL = 0x64748B;
const DESC_MAX = 4000;

export function buildWalletCard(events = [], holdings = [], {
  title = 'Daily Summary', titleMark = '📊', header = 'Wallet', perps = [], env = process.env,
} = {}) {
  // Filtered in ONE place, so a hidden symbol cannot be announced as a buy on a card that will
  // never list it afterwards.
  const hide = hiddenSymbols(env);
  const evs = events.filter(e => e?.symbol && VERB[e.kind] && !hide.has(String(e.symbol).toUpperCase()));
  const held = holdings.filter(h => h && h.symbol && !hide.has(String(h.symbol).toUpperCase()));
  const accent = evs.some(e => e.kind === 'bought' || e.kind === 'added') ? 0x16A34A : NEUTRAL;

  const groups = new Map();
  for (const h of held) {
    const k = h.chain || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }

  // Header first, THEN the day. Inside the description, where the order is ours to choose — the
  // author slot is not, and that is why the mark is not there.
  const parts = [
    `${headerMark(env)} **${header}**`,
    evs.length ? evs.map(eventLine).join('\n') : '_No changes today._',
  ];

  // PERPS LEAD THE HOLDINGS. A leveraged position with a stop is the thing on this card that can
  // demand a decision today; a spot balance mostly cannot. Not subject to the two-holdings rule —
  // that rule exists to hide leftover gas, and one open position is the case worth showing.
  const pv = perps.filter(p => p?.symbol);
  if (pv.length) {
    parts.push(`**${chainMark('Hyperliquid')} Hyperliquid · perps**\n${pv.map(perpLine).join('\n')}`);
  }

  for (const [chain, rows] of groups) {
    if (rows.length < MIN_CHAIN_HOLDINGS) continue;
    const head = chain ? `**${chainMark(chain)} ${chain}**\n` : '';
    parts.push(head + rows.map(groupedHoldingLine).join('\n'));
  }

  let desc = parts.join('\n\n');
  if (desc.length > DESC_MAX) {
    const cut = desc.slice(0, DESC_MAX);
    desc = cut.slice(0, cut.lastIndexOf('\n')) + '\n_…truncated._';
  }

  return {
    embeds: [{
      // No author slot: Discord renders it ABOVE the title, which put the wallet line on top of
      // "Daily Summary" and read back to front. The header is the description's first line instead,
      // where the order is ours.
      //
      // A UNICODE emoji DOES render in a title — it is only CUSTOM emoji (<:name:id>) that print
      // literally there. Matches the pre-reads' house style.
      title: `${titleMark ? titleMark + ' ' : ''}${title}`,
      description: desc,
      color: accent,
      // No total, and no count of anything countable: a footer saying "12 positions" is
      // share-of-book arithmetic waiting to happen once somebody knows one of them.
      footer: { text: 'Market prices at time of post' },
      timestamp: new Date().toISOString(),
    }],
  };
}
