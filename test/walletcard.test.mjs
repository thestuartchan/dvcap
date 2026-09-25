// test/walletcard.test.mjs — the wallet, for a PUBLIC channel.
//
// The console's wallet view exists to show balances, free versus resting, dollar values and a
// cross-chain total. This publishes the same data with all of that removed: composition and MARKET
// prices, never size and never an ENTRY price. Same four forbidden quantities as lib/tradecard.js — SIZE, ABSOLUTE P&L, MARKET
// VALUE, SHARE OF BOOK — for the same reason, and tested the same way: rows whose private values
// are distinctive digit strings, asserted to appear nowhere in the serialised output.
import { chainMark, headerMark, WALLET_MARK } from '../lib/chains.js';
import { classifyTrigger, parseTriggerOrders } from '../lib/hyperliquid.js';
import { walletPublicView, diffHoldings, buildWalletCard, eventLine, holdingLine, groupedHoldingLine, mergePending, MIN_CHAIN_HOLDINGS, publishable, symbolKey, isPlainSymbol, isUnsolicited, inheritProvenance, rememberProvenance, applyMemory, provenanceKey, publishReport,
         HIDDEN_SYMBOLS, hiddenSymbols,
         perpPublicView, perpLine, PERP_PUBLIC_FIELDS,
         WALLET_PUBLIC_FIELDS, EVENT_PUBLIC_FIELDS, MIN_NOTIONAL_USD } from '../lib/walletcard.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// Values that could not occur by chance, so a leak is unmistakable.
const SECRET = { qty: 987654.321, free: 876543.21, hold: 111111.11, value: 555444.33, total: 999888.77 };
const row = (o = {}) => ({
  coin: 'PONS', chain: 'Robinhood Chain', price: 0.7121, changePercent: -17.68,
  total: SECRET.qty, free: SECRET.free, hold: SECRET.hold, value: SECRET.value,
  pnl: 4321.99, pnlPct: 12.5, entryNtl: 3210.55, acquired: true, verified: false, viaPool: 'WETH',
  ...o,
});

// ── NOTHING THAT SIZES THE ACCOUNT ───────────────────────────────────────────
{
  const v = walletPublicView(row(), 'Robinhood Chain');
  eq('the view is exactly the allow-list', Object.keys(v).sort(), ['chain', 'changePercent', 'price', 'symbol', 'thin']);
  for (const f of ['total', 'free', 'hold', 'value', 'pnl', 'entryNtl', 'acquired', 'verified', 'viaPool'])
    ok(`the view drops ${f}`, !(f in v));
  // The allow-list is the contract; a deny-list would let a new upstream field ride along.
  ok('and every published key is declared', Object.keys(v).every(k => WALLET_PUBLIC_FIELDS.includes(k)));
  eq('a row with no symbol is not a holding', walletPublicView({}, 'x'), null);

  // THE ASSERTION THAT MATTERS: build a whole card from rows carrying every private figure, and
  // look for those digits anywhere in the payload.
  const card = buildWalletCard(
    diffHoldings([], [row(), row({ coin: 'NUDES', price: 0.01742 })]),
    [row(), row({ coin: 'NUDES', price: 0.01742 })].map(r => walletPublicView(r, r.chain)));
  const whole = JSON.stringify(card);
  for (const [name, n] of Object.entries(SECRET))
    ok(`the card never contains the ${name} (${n})`, !whole.includes(String(n)) && !whole.includes(String(n).split('.')[0]));
  for (const leak of ['4321.99', '3210.55'])
    ok(`nor "${leak}"`, !whole.includes(leak));
  // The footer used to recite what was withheld, which meant this check had to be scoped to the
  // description or it tripped on the disclaimer's own words. The footer is now four words, so the
  // size words can be banned from the ENTIRE payload — a strictly stronger assertion.
  for (const word of ['balance', 'qty', 'quantity', 'holding count', 'total'])
    ok(`the payload never says "${word}"`, !new RegExp(word, 'i').test(whole));
  // Prices and percentages ARE published — they are the idea, not the size.
  ok('but the price is there', whole.includes('0.7121'));
  ok('and the symbol', whole.includes('PONS'));
  ok('the footer dates the prices without reciting a disclaimer',
     card.embeds[card.embeds.length - 1].footer.text === 'Market prices at time of post');
}

// ── MATERIALITY, ON NOTIONAL RATHER THAN QUANTITY ────────────────────────────
// A thousand of something worthless and a thousandth of something valuable are the same number and
// not the same event. And gas dust moves a native balance on every single transaction — a card
// that fires on that is a card nobody reads.
{
  const at = (coin, total, price) => ({ coin, chain: 'Base', total, price });
  eq('the floor is declared', MIN_NOTIONAL_USD, 20);

  // $15 of movement says nothing; $50 does.
  eq('a sub-threshold buy is silent', diffHoldings([], [at('X', 15, 1)]).length, 0);
  eq('and a real one is not', diffHoldings([], [at('X', 50, 1)]).map(e => e.kind), ['bought']);
  // Quantity alone decides nothing: three units of a $100 token is material, 10,000 of a $0.0001 is not.
  eq('a small quantity of an expensive token counts', diffHoldings([], [at('X', 3, 100)]).map(e => e.kind), ['bought']);
  eq('a huge quantity of a worthless one does not', diffHoldings([], [at('X', 10_000, 0.0001)]).length, 0);
  // Gas: an ETH balance drifting down by a few cents must never post.
  eq('gas dust is not an event', diffHoldings([at('ETH', 1.0, 2494)], [at('ETH', 0.99999, 2494)]).length, 0);

  // An UNPRICED token cannot be shown to be material, so nothing is said about it. Silence beats a
  // card about a token nobody can value.
  eq('an unpriced arrival is not announced', diffHoldings([], [at('X', 1e9, null)]).length, 0);
  eq('nor an unpriced exit', diffHoldings([at('X', 1e9, null)], []).length, 0);
}

// ── WHAT CHANGED ─────────────────────────────────────────────────────────────
{
  const at = (coin, total, price = 1) => ({ coin, chain: 'Base', total, price });
  const evs = diffHoldings(
    [at('KEEP', 100), at('SOLD', 100), at('TRIM', 200)],
    [at('KEEP', 100), at('NEW', 100), at('TRIM', 100)]);
  eq('bought, sold, added and trimmed are distinguished',
     evs.map(e => `${e.kind}:${e.symbol}`), ['bought:NEW', 'sold:SOLD', 'trimmed:TRIM']);
  ok('an unchanged holding is not an event', !evs.some(e => e.symbol === 'KEEP'));
  eq('decisions lead, adjustments follow', evs.map(e => e.kind), ['bought', 'sold', 'trimmed']);

  // The SAME symbol on two chains is two holdings — bridging is not a trade, and conflating them
  // would report a phantom buy and a phantom sale.
  const cross = diffHoldings([{ coin: 'USDC', chain: 'Base', total: 100, price: 1 }],
                             [{ coin: 'USDC', chain: 'Arbitrum', total: 100, price: 1 }]);
  eq('the same token on another chain is its own holding', cross.map(e => `${e.kind}:${e.chain}`),
     ['bought:Arbitrum', 'sold:Base']);

  eq('nothing changed is no events', diffHoldings([at('A', 1, 100)], [at('A', 1, 100)]), []);
  eq('an empty wallet on both sides is quiet', diffHoldings([], []), []);
}

// ── THE LINES ────────────────────────────────────────────────────────────────
{
  ok('a buy names the token and the direction, not the price', eventLine({ kind: 'bought', symbol: 'NUDES', chain: 'Robinhood Chain' })
     === '🟢 Bought **NUDES** · Robinhood Chain');
  // Belt and braces: even if a caller hands eventLine a price, the line must not render it.
  ok('an entry price handed in anyway is still not rendered',
     !/0\.01742|@/.test(eventLine({ kind: 'bought', symbol: 'NUDES', price: 0.01742, chain: 'Robinhood Chain' })));
  ok('a chainless event still reads', /Sold \*\*X\*\*$/.test(eventLine({ kind: 'sold', symbol: 'X', chain: null })));
  // Crypto keeps four decimals above a dollar, equities two — the rule lib/crypto.js owns.
  ok('a holding line is led by its chain mark and carries price and day move',
     holdingLine({ symbol: 'PONS', price: 0.7121, changePercent: -17.68, chain: 'Robinhood Chain' })
     === '🪶 **PONS** 0.7121 (-17.68%) · Robinhood Chain');
  ok('and omits a missing day move rather than printing zero',
     !/%/.test(holdingLine({ symbol: 'X', price: 1, changePercent: null, chain: null })));

  eq('a grouped line drops the mark and the chain, which its embed already carries',
     groupedHoldingLine({ symbol: 'PONS', price: 0.7121, changePercent: -17.68, chain: 'Robinhood Chain' }),
     '**PONS** 0.7121 (-17.68%)');

  const empty = buildWalletCard([], []);
  eq('a quiet day says so rather than rendering blank',
     empty.embeds[0].description.split('\n\n')[1], '_No changes today._');
  ok('and still dates its prices', /at time of post/i.test(JSON.stringify(empty)));
  // A malformed event is dropped rather than rendered as "undefined".
  eq('unknown event kinds are dropped',
     buildWalletCard([{ kind: 'wat', symbol: 'X' }], []).embeds[0].description.split('\n\n')[1], '_No changes today._');
}

// ── THE ENTRY PRICE IS GONE, AND CANNOT COME BACK BY ACCIDENT ────────────────
// The holdings price is a public property of the token and stays. The entry price belongs to one
// transaction and is what lets an observer pin that transaction, so it must not survive anywhere in
// the payload — not on the event object, not in the rendered line.
{
  eq('an event carries only kind, symbol and chain', EVENT_PUBLIC_FIELDS.slice().sort(), ['chain', 'kind', 'symbol']);

  const ENTRY = 0.0174299;   // distinctive: appears nowhere unless something leaked it
  const evs = diffHoldings(
    [{ coin: 'NUDES', chain: 'Robinhood Chain', total: 0,    price: ENTRY }],
    [{ coin: 'NUDES', chain: 'Robinhood Chain', total: 5000, price: ENTRY }]);
  eq('the buy is detected', evs.length, 1);
  eq('and the event object has no price field', Object.keys(evs[0]).sort(), ['chain', 'kind', 'symbol']);

  // Two holdings so the chain earns its own section — a lone one is folded away, which would make
  // this assert nothing at all.
  const card = buildWalletCard(evs, [
    { symbol: 'NUDES', chain: 'Robinhood Chain', price: ENTRY, changePercent: 8.4 },
    { symbol: 'PONS', chain: 'Robinhood Chain', price: 0.7121, changePercent: -1 },
  ]);
  const desc = card.embeds[0].description;
  // One embed now, so events and holdings share a description. The events are the first block —
  // the entry price must be absent from THERE, while the holdings block legitimately carries the
  // market price, which in this fixture happens to be the same figure.
  const eventPart = desc.split('\n\n')[1];   // [0] is the header line
  ok('the event line does not carry the entry price', !eventPart.includes('0174299'));
  ok('no @ pricing syntax survives on any event line', !eventPart.includes('@'));
  ok('the holdings block still does carry the market price', desc.includes('0.0174'));
}

// ── ACCUMULATING A DAY ───────────────────────────────────────────────────────
// Detection runs half-hourly and posting runs once, so events buffer. Folding must be idempotent
// (a retried detection must not double-report) without collapsing genuinely different decisions.
{
  const e = (kind, symbol, chain = 'Base') => ({ kind, symbol, chain });

  eq('an empty day merges to nothing', mergePending([], []).length, 0);
  eq('a fresh event joins an empty buffer', mergePending([], [e('bought', 'A')]).length, 1);

  // The retry case: the same detection seen twice must appear once.
  eq('the same event detected twice is reported once',
     mergePending([e('bought', 'A')], [e('bought', 'A')]).length, 1);

  // Buying and later trimming the same token are two real decisions and both must survive.
  const both = mergePending([e('bought', 'A')], [e('trimmed', 'A')]);
  eq('buying then trimming the same token keeps both', both.length, 2);
  eq('and decisions still lead adjustments', both.map(x => x.kind), ['bought', 'trimmed']);

  // The same symbol on two chains is two holdings, so two events.
  eq('the same token on another chain is its own event',
     mergePending([], [e('bought', 'A', 'Base'), e('bought', 'A', 'Arbitrum')]).length, 2);

  eq('malformed entries are dropped rather than buffered',
     mergePending([], [{ kind: 'wat', symbol: 'A' }, { kind: 'bought' }, null]).length, 0);

  // Nothing that reaches the buffer may carry a price, or the buffer becomes the leak.
  const merged = mergePending([], [{ kind: 'bought', symbol: 'A', chain: 'Base', price: 0.0174299 }]);
  ok('a price handed to the buffer is stripped', !JSON.stringify(merged).includes('0174299'));
}

// ── CHAIN MARKS ──────────────────────────────────────────────────────────────
// Unicode has no chain logos; real ones are custom Discord emoji, which are per-server and set
// through DISCORD_CHAIN_EMOJI. The built-ins must work with nothing configured, and a malformed
// override must never take the card down.
{
  const E = {};   // nothing configured
  eq('each chain has its own mark', chainMark('Robinhood Chain', E), '🪶');
  eq('and another does not borrow it', chainMark('Ethereum', E), '⟠');
  ok('every configured chain has a distinct mark', (() => {
    const marks = ['Ethereum', 'Arbitrum', 'Base', 'Polygon', 'Robinhood Chain'].map(c => chainMark(c, E));
    return new Set(marks).size === marks.length;
  })());
  eq('an unknown chain still gets a mark rather than "undefined"', chainMark('Solana', E), '⬦');
  eq('and so does a missing one', chainMark(null, E), '⬦');

  // A custom emoji wins, and only for the chain it names.
  const custom = { DISCORD_CHAIN_EMOJI: '{"Ethereum":"<:eth:12345>"}' };
  eq('a custom emoji overrides the built-in', chainMark('Ethereum', custom), '<:eth:12345>');
  eq('a chain the override omits keeps its built-in', chainMark('Base', custom), '🔵');

  // Every failure path must fall back rather than throw — a typo in an env var must not stop the
  // daily card from posting.
  for (const [name, raw] of Object.entries({
    'malformed JSON': '{not json',
    'an array': '["a","b"]',
    'a bare string': '"nope"',
    'a null': 'null',
  })) eq(`${name} falls back to the built-in`, chainMark('Ethereum', { DISCORD_CHAIN_EMOJI: raw }), '⟠');

  eq('a non-string value is rejected', chainMark('Ethereum', { DISCORD_CHAIN_EMOJI: '{"Ethereum":42}' }), '⟠');
  eq('and one carrying a newline is too, since it would break the layout',
     chainMark('Ethereum', { DISCORD_CHAIN_EMOJI: '{"Ethereum":"a\\nb"}' }), '⟠');
}

// ── ONE CARD, GROUPED BY CHAIN ───────────────────────────────────────────────
// It was one embed PER CHAIN, because an embed's author icon is the only place Discord will draw a
// real logo next to text. Four stacked boxes for one wallet read as four separate messages rather
// than one card, which is worse than the thing the logos bought. So: headings inside a single
// description, with chainMark() beside each — which prefers a CUSTOM DISCORD EMOJI when one is
// configured, and a custom emoji is the only image Discord renders inline. Same layout carries the
// real logos the moment DISCORD_CHAIN_EMOJI names them.
{
  const h = (symbol, chain) => ({ symbol, chain, price: 1, changePercent: null });
  const card = buildWalletCard([], [
    h('ETH', 'Ethereum'), h('USDC', 'Ethereum'),
    h('ETH', 'Arbitrum'), h('ARB', 'Arbitrum'),
    h('PONS', 'Robinhood Chain'), h('NUDES', 'Robinhood Chain'),
  ]);
  const d = card.embeds[0].description;

  eq('there is exactly one embed', card.embeds.length, 1);
  ok('the header leads the description', d.startsWith('🦊 **Wallet**'));
  for (const c of ['Ethereum', 'Arbitrum', 'Robinhood Chain'])
    ok(`${c} is a heading inside it`, d.includes(`**${chainMark(c)} ${c}**`));
  ok('each chain carries its mark', d.includes('⟠ Ethereum') && d.includes('🪶 Robinhood Chain'));
  ok('holdings sit under their chain', /Robinhood Chain\*\*\n\*\*PONS\*\*/.test(d));
  ok('and a grouped line does not repeat the chain name',
     !/\*\*PONS\*\* 1\.00 · Robinhood/.test(d));

  // The mark is where a custom emoji lands, which is the whole route to real logos on one card.
  eq('a configured emoji is what the heading would carry',
     chainMark('Ethereum', { DISCORD_CHAIN_EMOJI: '{"Ethereum":"<:eth:1>"}' }), '<:eth:1>');

  eq('one footer, on the only embed', card.embeds.filter(e => e.footer).length, 1);
  eq('and one timestamp', card.embeds.filter(e => e.timestamp).length, 1);

  const busy = buildWalletCard([{ kind: 'bought', symbol: 'X', chain: 'Base' }],
                               [h('X', 'Base'), h('Y', 'Base')]);
  eq('the card takes the accent when something was bought', busy.embeds[0].color, 0x16A34A);
  eq('and stays neutral otherwise', card.embeds[0].color, 0x64748B);

  // A chain with no mark still gets a heading rather than a broken one.
  const unknown = buildWalletCard([], [h('FOO', 'Someswap Chain'), h('BAR', 'Someswap Chain')]);
  ok('an unmapped chain still reads', unknown.embeds[0].description.includes('Someswap Chain'));

  // A wallet too big for one description loses the tail and says so, rather than the message.
  const many = buildWalletCard([], Array.from({ length: 400 }, (_, i) => i)
    .flatMap(i => [h('TOKEN' + i, 'Chain' + (i % 3)), h('OTHER' + i, 'Chain' + (i % 3))]));
  ok('an oversized wallet is truncated, not dropped', many.embeds[0].description.length <= 4096);
  ok('and it says it was truncated', /truncated/.test(many.embeds[0].description));
}

// ── A CHAIN EARNS ITS SECTION ────────────────────────────────────────────────
// A chain holding only its gas token is not a position, and a logo-headed section announcing "ETH"
// is a lot of card for a fact nobody acts on. But a holdings overview that quietly omits a holding
// cannot be trusted as a list, so the folded chains are named in one muted line.
{
  const h = (symbol, chain) => ({ symbol, chain, price: 1, changePercent: null });
  eq('the bar is two', MIN_CHAIN_HOLDINGS, 2);

  const card = buildWalletCard([], [
    h('ETH', 'Ethereum'), h('ETH', 'Arbitrum'),
    h('PONS', 'Robinhood Chain'), h('NUDES', 'Robinhood Chain'),
  ]);
  const d0 = card.embeds[0].description;
  ok('a one-holding chain gets no section of its own', !d0.includes('Ethereum') && !d0.includes('Arbitrum'));
  ok('and the chain that earned one still has it', d0.includes('Robinhood Chain'));
  // Dropped silently, by decision — the note that used to name them was more noise than the rows
  // it replaced. Nothing about a thin chain reaches the card at all.
  eq('a quiet day with thin chains says just that',
     card.embeds[0].description.split('\n\n')[1], '_No changes today._');
  ok('the dropped chains are not named', !/Ethereum|Arbitrum/.test(card.embeds[0].description));
  ok('nor is anything they hold', !/\bETH\b/.test(card.embeds[0].description));

  // The whole point of the fold is that it hides NOISE, not activity. A trade on a folded chain is
  // still a decision and must still be announced.
  const traded = buildWalletCard([{ kind: 'bought', symbol: 'ETH', chain: 'Ethereum' }],
                                 [h('ETH', 'Ethereum'), h('A', 'Base'), h('B', 'Base')]);
  ok('a trade on a folded chain is still announced',
     traded.embeds[0].description.includes('🟢 Bought **ETH** · Ethereum'));

  // A second token arriving is what promotes a chain — the behaviour asked for.
  const grown = buildWalletCard([], [h('ETH', 'Ethereum'), h('LINK', 'Ethereum'), h('A', 'Base'), h('B', 'Base')]);
  ok('a second holding promotes the chain to its own section',
     grown.embeds[0].description.includes('Ethereum'));
  ok('and the lead embed is untouched by any of it', !/not shown/.test(grown.embeds[0].description));

  // Everything thin: the card is still a card, and still says what it left out.
  const allThin = buildWalletCard([], [h('ETH', 'Ethereum'), h('ETH', 'Arbitrum')]);
  eq('a wallet of nothing but thin chains is still one embed', allThin.embeds.length, 1);
  ok('which still carries the footer', !!allThin.embeds[0].footer);
  eq('and reads as a quiet day rather than a broken card',
     allThin.embeds[0].description.split('\n\n')[1], '_No changes today._');
}

// ── PERPS ────────────────────────────────────────────────────────────────────
// A perp is a position, not a balance. What may be published is the idea — direction, levels, R —
// and never the size or anything that stands in for it.
{
  // Every private figure a distinctive digit string, so a leak shows up as itself.
  const POS = {
    coin: 'HYPE', side: 'long', entry: 76.9573,
    qty: 267672.19, notional: 22743562.99, unrealizedPnl: 2144219.48,
    marginUsed: 4548712.59, liquidationPx: 40.5283732382, leverage: 5, leverageType: 'cross',
  };
  const v = perpPublicView(POS, { stops: [70, 64], targets: [110, 130] }, 84.966);

  eq('the view is exactly the allow-list', Object.keys(v).sort(), PERP_PUBLIC_FIELDS.slice().sort());
  eq('the operative stop is the one nearest the mark', v.stop, 70);
  eq('and so is the operative target', v.target, 110);

  // R against the swing card's own definition: entry 76.9573, stop 70 risks 6.9573; at 84.966 the
  // trade is up 8.0087, which is 1.2R. The target at 110 is worth 4.7R.
  eq('R is where the trade is now, in units of the risk taken', v.r, 1.2);
  eq('and the target carries its own R', v.targetR, 4.7);

  const whole = JSON.stringify(buildWalletCard([], [], { perps: [v] }));
  for (const [name, n] of Object.entries({
    size: 267672.19, notional: 22743562.99, pnl: 2144219.48, margin: 4548712.59,
  })) ok(`the card never carries the ${name}`, !whole.includes(String(n)) && !whole.includes(String(n).split('.')[0]));
  // Excluded by instruction, and it leaks size anyway — it is a function of margin.
  ok('nor the liquidation price', !whole.includes('40.52') && !whole.includes('40.5283732382'));
  ok('nor the leverage', !/"leverage"/.test(whole));
  ok('nor the entry price', !whole.includes('76.9573'));

  // A SHORT MUST NEVER READ AS A LONG. Entry 98000, stop 104000 risks 6000; at 96500 it is +0.3R,
  // and the target at 86000 is +2R. rOf keyed off (e - s) alone would return null for every short.
  const sh = perpPublicView({ coin: 'BTC', side: 'short', entry: 98000 },
                            { stops: [104000], targets: [86000] }, 96500);
  eq('a short in profit is positive R, not null', sh.r, 0.3);
  eq('and its target too', sh.targetR, 2);
  ok('the line says Short in words', /\bShort\b/.test(perpLine(sh)));
  ok('and a long says Long', /\bLong\b/.test(perpLine(v)));

  // R exists only if a stop does — tradecard's rule, inherited rather than restated.
  const bare = perpPublicView({ coin: 'SOL', side: 'long', entry: 180 }, null, 175);
  eq('no stop means no R rather than a zero', bare.r, null);
  ok('and the line says so out loud', /_no stop_/.test(perpLine(bare)));
  ok('rather than silently omitting it', !/SL/.test(perpLine(bare)));

  // A stop the safe side of entry is not a risk unit.
  const locked = perpPublicView({ coin: 'ETH', side: 'long', entry: 3000 }, { stops: [3200], targets: [] }, 3400);
  eq('a stop above entry on a long is not a risk unit', locked.r, null);

  // The perps section is exempt from the two-holdings rule — one open position is the case worth
  // showing, and that rule exists to hide leftover gas.
  const card = buildWalletCard([], [{ symbol: 'ETH', chain: 'Base', price: 1, changePercent: null }], { perps: [v] });
  const cd = card.embeds[0].description;
  ok('one perp and one thin chain leaves the perp standing', /Hyperliquid · perps/.test(cd));
  ok('and the thin chain is still dropped', !/Base/.test(cd));
  ok('perps lead the holdings', (() => {
    const d2 = buildWalletCard([], [
      { symbol: 'A', chain: 'Base', price: 1, changePercent: null },
      { symbol: 'B', chain: 'Base', price: 1, changePercent: null },
    ], { perps: [v] }).embeds[0].description;
    return d2.indexOf('Hyperliquid · perps') < d2.indexOf('Base');
  })());
}

// ── TELLING A STOP FROM A TARGET ─────────────────────────────────────────────
// Getting this backwards would not fail loudly — it would invert R and look plausible. The label is
// consulted first because it alone describes a stop moved past entry; geometry decides when the
// label is not recognised, which is the case that matters since the exact strings are unconfirmed.
{
  const long = { side: 'long', entry: 100 }, short = { side: 'short', entry: 100 };
  const o = (orderType, triggerPx) => ({ isTrigger: true, coin: 'X', orderType, triggerPx: String(triggerPx) });

  eq('a labelled stop is a stop', classifyTrigger(o('Stop Market', 90), long), 'stop');
  eq('a labelled take profit is a target', classifyTrigger(o('Take Profit Limit', 120), long), 'target');
  eq('the label is read case-insensitively', classifyTrigger(o('take profit market', 120), long), 'target');

  // The case only the label can see: a stop moved past entry to lock a gain in sits on the
  // target's side of entry, so geometry alone would file it as a target.
  eq('a stop moved past entry is still a stop', classifyTrigger(o('Stop Market', 110), long), 'stop');

  // Unrecognised label → geometry, which must be right for both directions.
  eq('below entry on a long is a stop', classifyTrigger(o('Wat', 90), long), 'stop');
  eq('above entry on a long is a target', classifyTrigger(o('Wat', 120), long), 'target');
  eq('above entry on a SHORT is a stop', classifyTrigger(o('Wat', 120), short), 'stop');
  eq('below entry on a SHORT is a target', classifyTrigger(o('Wat', 90), short), 'target');
  eq('with no position to compare against it is unknown', classifyTrigger(o('Wat', 90), null), null);
  eq('and a trigger exactly at entry is not a level', classifyTrigger(o('Wat', 100), long), null);

  const orders = [
    o('Stop Market', 90), o('Take Profit Market', 120),
    { isTrigger: false, coin: 'X', orderType: 'Limit', triggerPx: '0.0' },   // an ordinary order
    { isTrigger: true, coin: 'X', orderType: 'Stop Market', triggerPx: '0.0' }, // no real level
    { isTrigger: true, coin: '', orderType: 'Stop Market', triggerPx: '80' },   // no coin
  ];
  const lv = parseTriggerOrders(orders, [{ coin: 'X', side: 'long', entry: 100 }]);
  eq('only real trigger levels are kept', lv.get('X'), { stops: [90], targets: [120] });
  ok('an ordinary limit order is not a level', lv.get('X').stops.length === 1);
  eq('a coin with no orders has no entry at all', lv.get('Y'), undefined);
  eq('and a non-array payload is empty rather than a throw', parseTriggerOrders(null, []).size, 0);
}

// ── ORDER BEATS FIDELITY ─────────────────────────────────────────────────────
// The header went through the embed's AUTHOR slot first, which takes an image URL and so rendered
// the real MetaMask logo with no setup at all. Unusable, for a reason no configuration fixes:
// Discord renders `author` ABOVE `title`, always, so the wallet line landed on top of "Daily
// Summary" and the card read back to front.
//
// So the header is the description's first line, where the order is ours, and the mark is a unicode
// fox — not the MetaMask logo, but the same animal, and it renders in any slot with nothing set up.
{
  const h = (symbol, chain) => ({ symbol, chain, price: 1, changePercent: null });
  const c = buildWalletCard([], [h('PONS', 'Robinhood Chain'), h('NUDES', 'Robinhood Chain')], { env: {} }).embeds[0];

  ok('there is no author slot to jump the title', !('author' in c));
  eq('the title comes first', c.title, '📊 Daily Summary');
  ok('and the wallet line is inside the description, after it',
     c.description.startsWith(`${WALLET_MARK} **Wallet**`));
  ok('the day follows the header', c.description.split('\n\n')[1] === '_No changes today._');

  eq('the mark needs nothing configured', headerMark({}), '🦊');
  eq('the header is a parameter', buildWalletCard([], [], { header: 'Project wallet', env: {} })
     .embeds[0].description.startsWith('🦊 **Project wallet**'), true);

  // The upgrade path stays open: an id, if one ever turns up, swaps the real logo in HERE with no
  // other change — same line, same order.
  const withId = { DISCORD_CHAIN_EMOJI: '{"Wallet":"<:Metamask:123>"}' };
  eq('a configured id replaces the fox in place', headerMark(withId), '<:Metamask:123>');
  ok('on the same line, in the same order',
     buildWalletCard([], [], { env: withId }).embeds[0].description.startsWith('<:Metamask:123> **Wallet**'));
  eq('and a malformed map falls back to the fox', headerMark({ DISCORD_CHAIN_EMOJI: '{oops' }), '🦊');

  // Chain headings are the same mechanism, one line down.
  eq('a chain heading still takes a custom emoji when configured',
     chainMark('Robinhood Chain', { DISCORD_CHAIN_EMOJI: '{"Robinhood Chain":"<:rh:43>"}' }), '<:rh:43>');
  ok('and falls back to its built-in mark otherwise', /🪶/.test(c.description));
}

// ── WHAT THE CARD DOES NOT CARRY ─────────────────────────────────────────────
// USDH's pair turns over about $4,800 a day, so the price beside it was never one anyone could act
// on. Marking it ⚠️ said so; a line that always carries a warning is a line that should not be
// there. Card only — the console still lists it, because "what do I hold" and "what is worth
// publishing" are different questions.
{
  const h = (symbol, chain) => ({ symbol, chain, price: 1, changePercent: null });
  const rows = [h('USDC', 'Hyperliquid'), h('USDH', 'Hyperliquid'),
                h('PONS', 'Robinhood Chain'), h('NUDES', 'Robinhood Chain')];

  const d = buildWalletCard([], rows, { env: {} }).embeds[0].description;
  ok('USDH is not on the card', !/USDH/.test(d));
  // And the knock-on the wallet's owner predicted: USDC alone is one holding, which is under the
  // bar, so the whole section goes with it.
  ok('nor is the section it left with one holding in it', !/Hyperliquid/.test(d));
  ok('while the chain that still has two is untouched', /Robinhood Chain/.test(d) && /PONS/.test(d));

  // A hidden symbol must not be announced as a buy on a card that will never list it.
  const ev = buildWalletCard([{ kind: 'bought', symbol: 'USDH', chain: 'Hyperliquid' },
                              { kind: 'bought', symbol: 'PONS', chain: 'Robinhood Chain' }],
                             rows, { env: {} }).embeds[0].description;
  ok('a hidden symbol is not announced either', !/USDH/.test(ev));
  ok('but a listed one still is', /Bought \*\*PONS\*\*/.test(ev));

  eq('the default list is USDH', [...HIDDEN_SYMBOLS], ['USDH']);
  eq('an env override replaces it', [...hiddenSymbols({ WALLET_HIDE: 'FOO, bar' })].sort(), ['BAR', 'FOO']);
  eq('matching is case-insensitive', [...hiddenSymbols({ WALLET_HIDE: 'usdh' })], ['USDH']);
  eq('an empty override falls back to the default', [...hiddenSymbols({ WALLET_HIDE: '  ' })], ['USDH']);
  ok('and an override can hide nothing at all by naming something else',
     !hiddenSymbols({ WALLET_HIDE: 'NOTHING' }).has('USDH'));
}

// ── A UNICODE MARK DOES WORK IN A TITLE ──────────────────────────────────────
// It is only CUSTOM emoji that print literally there. So the title carries one and the wallet's own
// custom mark stays on the first description line, where Discord will draw it.
{
  const c = buildWalletCard([], [], { env: {} }).embeds[0];
  eq('the title carries a unicode mark', c.title, '📊 Daily Summary');
  ok('and still no custom emoji, which would print as text', !/<:/.test(c.title));
  eq('the mark is a parameter', buildWalletCard([], [], { titleMark: '🧾', env: {} }).embeds[0].title, '🧾 Daily Summary');
  eq('and can be turned off', buildWalletCard([], [], { titleMark: '', env: {} }).embeds[0].title, 'Daily Summary');
}

// ── A NAME THAT LOOKS LIKE ANOTHER, AND A TOKEN NOBODY ASKED FOR ────────────
// 2026-09-21: "🟢 Bought PONS" on a day nothing was bought, and PONS listed twice at two prices — a
// second contract wearing the name. Identity is the normalised symbol; what arrived unbidden is
// neither announced nor listed; one symbol per chain.
{
  const RH = 'Robinhood Chain';
  const real = { coin: 'PONS', chain: RH, total: 4000, price: 0.5906, viaPool: 'WETH', verified: false, acquired: true };
  const twinCyrillic = { coin: 'P\u041eNS', chain: RH, total: 900, price: 0.5782, viaPool: 'WETH', verified: false, acquired: false };
  const twinFullwidth = { coin: '\uff30\uff2f\uff2e\uff33', chain: RH, total: 900, price: 0.5782, viaPool: 'WETH', verified: false, acquired: false };
  const twinSpaced = { coin: 'PONS\u200b', chain: RH, total: 900, price: 0.5782, viaPool: 'WETH', verified: false, acquired: false };
  const eth = { coin: 'ETH', chain: RH, total: 0.02, price: 2636.4, native: true, verified: true, acquired: null };
  const before = [real, eth];

  eq('fullwidth and zero-width fold to the plain symbol', [symbolKey(twinFullwidth.coin), symbolKey(twinSpaced.coin), symbolKey(' pons ')], ['PONS', 'PONS', 'PONS']);
  eq('an invisible character folds for identity but is never plain', [symbolKey('PO\u200bNS'), isPlainSymbol('PO\u200bNS'), isPlainSymbol('PONS\u200b'), isPlainSymbol('PO\u2060NS')], ['PONS', false, false, false]);
  // The spoof as it actually arrived: priced by a pool, provenance unknown. Alone, it is withheld.
  eq('the zero-width spoof alone is withheld, not printed as PONS', publishable([{ ...twinSpaced, coin: 'PO\u200bNS', acquired: null }, eth]).map(r => r.coin), ['ETH']);
  eq('and the report says why', publishReport([{ ...twinSpaced, coin: 'PO\u200bNS', acquired: null }, eth]).withheld, [{ symbol: 'Robinhood Chain:PONS', why: 'symbol not plain' }]);
  eq('a Cyrillic О does not fold, so the name is not plain', [isPlainSymbol(twinCyrillic.coin), isPlainSymbol('PONS'), isPlainSymbol('USDT0'), isPlainSymbol('')], [false, true, true, false]);
  eq('unbidden = pool-priced, unvouched, and the chain says nothing was given up', [isUnsolicited(twinCyrillic), isUnsolicited(real), isUnsolicited({ ...real, acquired: null }), isUnsolicited({ ...twinCyrillic, verified: true })], [true, false, false, false]);

  for (const [name, twin] of [['Cyrillic', twinCyrillic], ['fullwidth', twinFullwidth], ['zero-width', twinSpaced]]) {
    const after = [real, eth, twin];
    eq(`a ${name} twin arriving is not a buy`, diffHoldings(before, after), []);
    eq(`and the ${name} twin is not listed`, publishable(after).map(r => r.coin), ['PONS', 'ETH']);
  }
  // The airdrop with an honest name is still an airdrop.
  const airdrop = { coin: 'FREEMONEY', chain: RH, total: 1e6, price: 0.001, viaPool: 'WETH', verified: false, acquired: false };
  eq('an unbidden token is not a buy', diffHoldings(before, [real, eth, airdrop]), []);
  eq('nor a holding', publishable([real, eth, airdrop]).map(r => r.coin), ['PONS', 'ETH']);
  // …and hiding it is not a sale.
  eq('and its later disappearance is not a sale', diffHoldings([real, eth, airdrop], before), []);
  // A token the wallet DID swap for, unvouched and pool-priced, is a real buy — that is PONS itself.
  eq('a swapped-for unvouched token is a buy', diffHoldings([eth], before).map(e => `${e.kind} ${e.symbol}`), ['bought PONS']);
  // Unknown acquisition keeps the row: a bad transfer-history day must not hide the book.
  const unknown = { ...real, acquired: null };
  eq('unknown acquisition keeps the holding', publishable([unknown, eth]).map(r => r.coin), ['PONS', 'ETH']);
  // Two plain PONS on one chain: verified wins, else swapped-for, else neither.
  const plainTwin = { ...real, coin: 'PONS', total: 900, price: 0.5782, acquired: null };
  eq('two of a name: the swapped-for one is kept', publishable([real, plainTwin, eth]).map(r => r.price), [0.5906, 2636.4]);
  eq('two of a name and no way to tell: neither', publishable([{ ...real, acquired: null }, plainTwin, eth]).map(r => r.coin), ['ETH']);
  eq('but a verified one always wins', publishable([{ ...real, verified: true, acquired: null }, plainTwin, eth]).map(r => r.price), [0.5906, 2636.4]);
  // ── THE SECOND MORNING ─────────────────────────────────────────────────────
  // The snapshot written the day before carried no provenance: two plain rows of one name, which
  // the gate keeps neither of. That must not turn a holding the wallet had all along into a buy.
  const legacyReal = { coin: 'PONS', chain: RH, total: 4000, price: 0.5906 };
  const legacyTwin = { coin: 'PONS\u200b', chain: RH, total: 900, price: 0.5782 };
  const legacyEth = { coin: 'ETH', chain: RH, total: 0.02, price: 2622.4 };
  eq('a name held yesterday under indistinguishable rows is not bought today', diffHoldings([legacyReal, legacyTwin, legacyEth], [real, eth, twinSpaced]), []);
  eq('…and a real top-up of it is still an add', diffHoldings([legacyReal, legacyTwin, legacyEth], [{ ...real, total: 4400 }, eth, twinSpaced]).map(e => e.kind), ['added']);
  eq('…while the gate still lists it once', publishable([real, eth, twinSpaced]).map(r => r.coin), ['PONS', 'ETH']);
  // The mirror: a holding the gate cannot resolve today was not sold.
  eq('a name still held under unresolvable rows is not sold', diffHoldings([real, eth], [{ ...real, acquired: null }, plainTwin, eth]), []);
  eq('but one that is really gone is', diffHoldings([real, eth], [eth]).map(e => e.kind), ['sold']);

  // The whole card, end to end: nothing about the twin anywhere in the payload.
  const card = buildWalletCard(diffHoldings(before, [real, eth, twinCyrillic]),
    publishable([real, eth, twinCyrillic]).map(r => walletPublicView(r, r.chain)));
  const desc = card.embeds[0].description;
  ok('the card says no changes', /No changes today/.test(desc));
  eq('and lists PONS once', (desc.match(/PONS/g) || []).length, 1);
  ok('and never the twin', !desc.includes('\u041e') && !desc.includes('0.5782'));
}

// ── THE MORNING THE CHAIN WOULD NOT ANSWER ───────────────────────────────────
// 2026-09-24: "No changes today", and the real PONS gone from the list. The transfer history could
// not be read, both PONS rows came back with provenance unknown, and two of a name with nothing to
// tell them apart published neither. Yesterday's snapshot knew which was which.
{
  const real = { coin: 'PONS', chain: 'Robinhood Chain', total: 0.6918, price: 0.69, viaPool: true, verified: false, acquired: true, address: '0xreal' };
  const twin = { coin: 'PONS', chain: 'Robinhood Chain', total: 12345, price: 0.02, viaPool: true, verified: false, acquired: false, address: '0xtwin' };
  const yesterday = [real, twin, { coin: 'ETH', chain: 'Robinhood Chain', total: 1, price: 2691, verified: true, native: true, acquired: null }];
  const today = yesterday.map(r => ({ ...r, acquired: null }));
  eq('with provenance unknown, both PONS rows vanish and nothing is said', [publishable(today).map(r => r.coin), diffHoldings(yesterday, today)], [['ETH'], []]);
  const carried = inheritProvenance(today, yesterday);
  eq('yesterday\'s answer is carried forward for both', [carried.inherited, carried.rows.map(r => r.acquired)], [2, [true, false, null]]);
  eq('and it says where it came from', carried.rows[0].acquiredFrom, 'snapshot');
  eq('so the real PONS is listed and the twin is not', publishable(carried.rows).map(r => [r.coin, r.address]), [['PONS', '0xreal'], ['ETH', undefined]]);
  eq('and there are still no events', diffHoldings(yesterday, carried.rows), []);
  // A snapshot from before addresses existed still tells them apart by exact balance.
  const old = yesterday.map(r => { const { address: _a, ...rest } = r; return rest; });
  const viaQty = inheritProvenance(today, old);
  eq('matched by balance when the snapshot has no address', viaQty.rows.map(r => r.acquired), [true, false, null]);
  eq('but not when the balance moved — that is a new question for the chain', inheritProvenance([{ ...today[0], total: 0.5 }], old).rows[0].acquired, null);
  // Nothing is ever downgraded, and a verified row needs no memory.
  eq('today\'s own answer wins', inheritProvenance([{ ...today[0], acquired: false }], yesterday).rows[0].acquired, false);
  eq('a verified row is left alone', inheritProvenance([{ ...today[0], verified: true }], yesterday).inherited, 0);
  eq('no snapshot, no change', inheritProvenance(today, null).inherited, 0);

  // The long memory: what the chain ever confirmed, by contract, applied on a day it will not.
  const mem = rememberProvenance(yesterday, {});
  eq('only the confirmed row is remembered', [mem.added, Object.keys(mem.memory)], [1, ['Robinhood Chain:0xreal']]);
  eq('remembering twice adds nothing', rememberProvenance(yesterday, mem.memory).added, 0);
  const fromMem = applyMemory(today, mem.memory);
  eq('the memory answers for the real one and says so', [fromMem.applied, fromMem.rows[0].acquired, fromMem.rows[0].acquiredFrom, fromMem.rows[1].acquired], [1, true, 'memory', null]);
  eq('an inherited or remembered answer is not written back as a fresh confirmation', rememberProvenance(fromMem.rows, {}).added, 0);
  eq('a row with no address has no key', provenanceKey({ coin: 'X', chain: 'Base' }), null);
  eq('the twin, later bought, would be remembered then', rememberProvenance([{ ...twin, acquired: true }], mem.memory).added, 1);
  // The run's answer names what is withheld, and why — never a balance.
  eq('the bad morning, reported', publishReport(today), { listed: 1, withheld: [{ symbol: 'Robinhood Chain:PONS', why: '2 of a name, provenance unknown/unknown' }], airdrops: [],
    contested: [{ symbol: 'Robinhood Chain:PONS', kept: null, dropped: ['0xreal', '0xtwin'] }] });
  eq('with the answer carried, nothing is withheld', [publishReport(carried.rows).listed, publishReport(carried.rows).withheld], [2, []]);
  // …and the twin, dropped INSIDE a group that was kept, is named rather than silent. This is the
  // shape that hid the real PONS: the group was "listed" while the wrong row stood for it.
  eq('the twin dropped inside a kept group is named, as shadowed', publishReport(carried.rows).airdrops.map(a => [a.symbol, a.shadowed]), [['Robinhood Chain:PONS', true]]);
  eq('an airdrop alone is withheld as unsolicited', [publishReport([twin]).listed, publishReport([twin]).withheld], [0, [{ symbol: 'Robinhood Chain:PONS', why: 'unsolicited' }]]);
  eq('and named as an airdrop, not shadowed', publishReport([twin]).airdrops.map(a => a.shadowed), [false]);
  eq('a contested symbol names the contract that stands for it', publishReport(carried.rows).contested, [{ symbol: 'Robinhood Chain:PONS', kept: '0xreal', dropped: ['0xtwin'] }]);
  eq('and one with no contest is not listed there', publishReport([real, yesterday[2]]).contested, []);
  ok('and nothing in the report is a quantity', !JSON.stringify(publishReport(today)).includes('0.6918'));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
