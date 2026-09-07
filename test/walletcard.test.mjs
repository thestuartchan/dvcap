// test/walletcard.test.mjs — the wallet, for a PUBLIC channel.
//
// The console's wallet view exists to show balances, free versus resting, dollar values and a
// cross-chain total. This publishes the same data with all of that removed: composition and MARKET
// prices, never size and never an ENTRY price. Same four forbidden quantities as lib/tradecard.js — SIZE, ABSOLUTE P&L, MARKET
// VALUE, SHARE OF BOOK — for the same reason, and tested the same way: rows whose private values
// are distinctive digit strings, asserted to appear nowhere in the serialised output.
import { chainMark, chainLogo } from '../lib/chains.js';
import { walletPublicView, diffHoldings, buildWalletCard, eventLine, holdingLine, groupedHoldingLine, mergePending,
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
  eq('the view is exactly the allow-list', Object.keys(v).sort(), ['chain', 'changePercent', 'price', 'symbol']);
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
  eq('a quiet day says so rather than rendering blank', empty.embeds[0].description, '_No changes today._');
  ok('and still dates its prices', /at time of post/i.test(JSON.stringify(empty)));
  // A malformed event is dropped rather than rendered as "undefined".
  eq('unknown event kinds are dropped', buildWalletCard([{ kind: 'wat', symbol: 'X' }], []).embeds[0].description, '_No changes today._');
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

  const card = buildWalletCard(evs, [{ symbol: 'NUDES', chain: 'Robinhood Chain', price: ENTRY, changePercent: 8.4 }]);
  const desc = card.embeds[0].description;
  ok('the event line does not carry the entry price', !desc.includes('0174299'));
  ok('no @ pricing syntax survives on any event line', !desc.includes('@'));
  const holdText = card.embeds.slice(1).map(e => e.description).join('\n');
  ok('the holdings line still does carry the market price', holdText.includes('0.0174'));
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

// ── GROUPED BY CHAIN, WITH REAL LOGOS ────────────────────────────────────────
// Discord will not draw an image inside an embed description, so the only way to show a real chain
// logo is one embed per chain with the logo as its author icon. That is the shape being tested.
{
  const h = (symbol, chain) => ({ symbol, chain, price: 1, changePercent: null });
  const card = buildWalletCard([], [
    h('ETH', 'Ethereum'), h('ETH', 'Arbitrum'),
    h('PONS', 'Robinhood Chain'), h('NUDES', 'Robinhood Chain'),
  ]);

  eq('one embed leads, then one per chain', card.embeds.length, 4);
  eq('the lead embed holds the day, not the holdings', card.embeds[0].description, '_No changes today._');
  eq('each chain embed is headed by its chain',
     card.embeds.slice(1).map(e => e.author.name), ['Ethereum', 'Arbitrum', 'Robinhood Chain']);
  ok('and by that chain\'s logo',
     card.embeds.slice(1).every(e => /^https:\/\//.test(e.author.icon_url)));
  eq('a chain with two holdings keeps them in one embed',
     card.embeds[3].description, '**PONS** 1.00\n**NUDES** 1.00');
  ok('a grouped line does not repeat the chain name',
     !card.embeds[3].description.includes('Robinhood'));

  // Footer and timestamp belong to the last embed only, or the card says the same thing four times.
  eq('only one embed carries the footer', card.embeds.filter(e => e.footer).length, 1);
  ok('and it is the last', !!card.embeds[card.embeds.length - 1].footer);
  eq('only one carries a timestamp', card.embeds.filter(e => e.timestamp).length, 1);

  // Colour means "something happened" rather than decorating every block.
  const busy = buildWalletCard([{ kind: 'bought', symbol: 'X', chain: 'Base' }], [h('X', 'Base')]);
  eq('the lead embed takes the accent when something was bought', busy.embeds[0].color, 0x16A34A);
  eq('the inventory stays neutral', busy.embeds[1].color, 0x64748B);

  // A chain with no logo must still render — name only, never a broken image.
  const unknown = buildWalletCard([], [h('FOO', 'Someswap Chain')]);
  eq('an unknown chain still gets its own embed and name', unknown.embeds[1].author.name, 'Someswap Chain');
  ok('but no icon_url at all rather than a dead link', !('icon_url' in unknown.embeds[1].author));
  eq('and chainLogo says so plainly', chainLogo('Someswap Chain'), null);
  ok('a known chain has one', /^https:\/\//.test(chainLogo('Ethereum')));

  // Ten embeds is Discord's cap. Beyond nine chains the card must degrade, not truncate.
  const many = buildWalletCard([], Array.from({ length: 12 }, (_, i) => h('T' + i, 'Chain' + i)));
  ok('past the embed cap it falls back to one flat list', many.embeds.length === 1);
  ok('and that list still names every holding',
     Array.from({ length: 12 }, (_, i) => 'T' + i).every(t => many.embeds[0].description.includes(t)));
  ok('and marks each row with its chain, since nothing else does', many.embeds[0].description.includes('⬦'));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
