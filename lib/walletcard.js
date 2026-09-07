// lib/walletcard.js — the wallet, for a PUBLIC channel.
//
// The console's wallet view is the opposite of publishable: it exists to show balances, free versus
// resting, dollar values and a cross-chain total. This takes the same data and publishes what a
// stranger may see — which is the composition and the prices, and none of the size.
//
// SAME DOCTRINE AS lib/tradecard.js, because the reasoning is identical. Four quantities never
// leave: SIZE, ABSOLUTE P&L, MARKET VALUE, SHARE OF BOOK. A price is the idea and is published
// deliberately; a quantity is the size of the account and is not. Enforced the way that file
// enforces it — by construction, with an allow-list rather than a deny-list, and by tests that
// build rows whose private values are distinctive digit strings and assert those strings appear
// nowhere in the serialised output.
//
// WHAT PUBLISHING THIS STILL DISCLOSES, stated once because it is not obvious: a public list of
// holdings plus buy and sell prices is enough for someone to FIND the wallet on chain by matching
// the trades, and the address then reveals everything this file is careful to withhold. The size
// is not in the card; the card is a fingerprint that leads to it. That is a judgement for the
// account owner and it has been made — it is recorded here so the next reader does not have to
// rediscover it.

import { fmtPrice } from './price.js';
import { priceMaxDp } from './crypto.js';

// The only fields that may reach a payload. Anything not named here is dropped, so a field added
// upstream is invisible here until somebody decides otherwise.
export const WALLET_PUBLIC_FIELDS = Object.freeze(['symbol', 'chain', 'price', 'changePercent', 'kind', 'at']);

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

// ── WHAT CHANGED, AND WHETHER IT WAS A DECISION ──────────────────────────────
// Compared on NOTIONAL, not on quantity: a thousand of something worthless and a thousandth of
// something valuable are the same number and not the same event. The notional is used to decide
// and is then thrown away — it never reaches the card.
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
    // An unpriced token cannot be shown to be material, so it is not reported. Silence beats a
    // card about a token nobody can value.
    if (moved == null || moved < minNotional) continue;
    events.push({ kind: a ? (delta > 0 ? 'added' : 'trimmed') : 'bought',
                  symbol: String(b.coin), chain: b.chain ?? null, price: num(b.price) });
  }
  for (const [k, a] of prev) {
    if (next.has(k)) continue;
    const moved = notional(a, num(a.total) ?? 0);
    if (moved == null || moved < minNotional) continue;
    events.push({ kind: 'sold', symbol: String(a.coin), chain: a.chain ?? null, price: num(a.price) });
  }
  // Bought and sold first — they are decisions. Adjustments after.
  const rank = { bought: 0, sold: 1, added: 2, trimmed: 3 };
  events.sort((x, y) => (rank[x.kind] - rank[y.kind]) || String(x.symbol).localeCompare(String(y.symbol)));
  return events;
}

const VERB = Object.freeze({ bought: '🟢 Bought', sold: '🔴 Sold', added: '🟢 Added to', trimmed: '🔴 Trimmed' });

export function eventLine(e) {
  const px = e.price == null ? null : fmtPrice(e.price, { maxDp: priceMaxDp(e.symbol) });
  return `${VERB[e.kind] || e.kind} **${e.symbol}**${px ? ` @ ${px}` : ''}${e.chain ? ` · ${e.chain}` : ''}`;
}

export function holdingLine(h) {
  const px = h.price == null ? null : fmtPrice(h.price, { maxDp: priceMaxDp(h.symbol) });
  const chg = h.changePercent == null ? '' : ` (${h.changePercent > 0 ? '+' : ''}${h.changePercent}%)`;
  return `**${h.symbol}** ${px ? px : '—'}${chg}${h.chain ? ` · ${h.chain}` : ''}`;
}

// The payload. Built from the allow-listed view only, so nothing can ride along from upstream.
export function buildWalletCard(events = [], holdings = [], { title = 'Wallet' } = {}) {
  const evs = events.filter(e => e?.symbol && VERB[e.kind]);
  const held = holdings.map(h => (h && h.symbol ? h : null)).filter(Boolean);
  const desc = [
    evs.length ? evs.map(eventLine).join('\n') : null,
    held.length ? `__**Holdings**__\n${held.map(holdingLine).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');
  return {
    embeds: [{
      title,
      description: desc || 'No holdings.',
      color: evs.some(e => e.kind === 'bought' || e.kind === 'added') ? 0x16A34A : 0x64748B,
      // No total, no count of anything countable — a footer saying "12 positions" is share-of-book
      // arithmetic waiting to happen once somebody knows one of them.
      footer: { text: 'Prices only — no sizes, balances or totals are published.' },
      timestamp: new Date().toISOString(),
    }],
  };
}
