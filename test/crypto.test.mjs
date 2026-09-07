// test/crypto.test.mjs — the crypto path, end to end.
//
// Two defects, found by sweeping it rather than by anything breaking:
//
//  1. SPOT CRYPTO NEVER CLOSES, and nothing knew. `exchangeFor` fell through to the suffixless US
//     default, so BTC-USD was scored against NYSE hours: a quote fetched two minutes ago on a
//     Saturday reported "prior close". Every weekend and every night, the dashboard called a live
//     price stale — and `sessionCloseMin` handed back NYSE's 16:00 for a market with no close.
//
//  2. The guard against symbol collisions EXISTED AND WAS NOT ASKED. lib/futures.js keeps
//     ROOT_AMBIGUOUS precisely so a root that is also something else is never auto-treated as the
//     contract, with a comment warning that keying off the symbol "would silently reprice a
//     MetLife holding at x0.1 and a Colgate one at x1000". The console keyed off the multiplier
//     table anyway, which is that exact mistake.
import { exchangeFor, marketState, sessionPhase, sessionCloseMin, freshness, isHalfDay,
         closedExchanges, isWeekendIn } from '../lib/sessions.js';
import { multiplierFor, isUnambiguousFuture, ROOT_AMBIGUOUS, EQUITY_AMBIGUOUS, FUTURES_MULTIPLIER } from '../lib/futures.js';
import { roundQuote, fmtPrice } from '../lib/price.js';
import { cryptoSymbolCheck, cryptoQuoteSymbol, CRYPTO_BASES } from '../lib/crypto.js';
import { atrSummary, ATR_PERIOD } from '../lib/atr.js';
import { sizeSuggestion, roundQty } from '../lib/sizing.js';
import { buildCard, buildClosedCard, splitByClass, classOfView, publicView, PUBLIC_FIELDS } from '../lib/tradecard.js';
import { readFileSync } from 'node:fs';
import { isSpotCrypto, isCryptoAsset, assetClassGroups, priceMaxDp, CRYPTO_PRICE_DP, EQUITY_PRICE_DP } from '../lib/crypto.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const SPOT = ['BTC-USD', 'ETH-USD', 'SHIB-USD', 'DOGE-USD', 'BTC-EUR'];
const SAT   = new Date('2026-09-06T14:00:00Z');   // Saturday — crypto trades, NYSE does not
const XMAS  = new Date('2026-12-25T14:00:00Z');   // a US market holiday
const NIGHT = new Date('2026-09-09T04:00:00Z');   // midnight ET on a weekday

// ── routing ──────────────────────────────────────────────────────────────────
for (const s of SPOT) eq(`${s} routes to CRYPTO`, exchangeFor(s), 'CRYPTO');
// The fiat leg is what distinguishes a pair from an ordinary dashed ticker.
eq('BRK-B is a share class, not a pair', exchangeFor('BRK-B'), 'US');
eq('and futures still route to CME', [exchangeFor('CL=F'), exchangeFor('MBT=F')], ['CME', 'CME']);
eq('an ETF wrapper is an equity, not crypto', exchangeFor('IBIT'), 'US');

// ── it never closes ──────────────────────────────────────────────────────────
for (const [label, when] of [['Saturday', SAT], ['Christmas', XMAS], ['4am ET', NIGHT]]) {
  eq(`open on ${label}`, marketState('BTC-USD', when), 'open');
  eq(`and live on ${label}`, sessionPhase('BTC-USD', when), 'live');
}
eq('no holiday can close it', marketState('BTC-USD', XMAS), 'open');
eq('and it is never a half day', isHalfDay('BTC-USD', new Date('2026-12-24T18:00:00Z')), false);
// A market with no close has no close to measure a dated event against.
eq('no session close', sessionCloseMin('BTC-USD'), null);
ok('where an equity still has one', sessionCloseMin('NVDA')?.closeMin > 0);

// Equities and futures are UNTOUCHED — the assertion that makes this safe.
eq('NVDA still shuts at the weekend', [marketState('NVDA', SAT), sessionPhase('NVDA', SAT)], ['closed', 'weekend']);
eq('and on Christmas', marketState('NVDA', XMAS), 'holiday');
eq('CME keeps its globex week', [marketState('CL=F', SAT), marketState('CL=F', new Date('2026-09-07T03:00:00Z'))], ['closed', 'open']);

// ── freshness: the defect, and its limit ─────────────────────────────────────
{
  const at = (min) => ({ price: 111235.42, ts: Math.floor(SAT.getTime() / 1000) - min * 60 });
  eq('a two-minute-old Saturday tick is LIVE', freshness('BTC-USD', at(2), SAT.getTime()).state, 'live');
  eq('where the same tick on NVDA is a prior close', freshness('NVDA', at(2), SAT.getTime()).state, 'prior-close');
  // The fix must not make crypto immune to staleness — an always-open venue is the case where a
  // stale feed is HARDEST to notice, because nothing else explains a price that will not move.
  eq('45 minutes old is still stale', freshness('BTC-USD', at(45), SAT.getTime()).state, 'stale');
  eq('and no timestamp at all is stale, never live',
     freshness('BTC-USD', { price: 1 }, SAT.getTime()).state, 'stale');
}

// A 24/7 venue must never make a REGION look permanently open, which would disable the pre-read's
// weekend and holiday guards for any region carrying a crypto symbol.
{
  const withCrypto = closedExchanges(['NVDA', 'BTC-USD'], SAT);
  ok('crypto is excluded from the cash-exchange set', !withCrypto.exchanges.includes('CRYPTO'));
  ok('so a US weekend is still all-closed', withCrypto.allClosed);
  ok('and crypto alone yields no cash exchanges to judge', !closedExchanges(['BTC-USD'], SAT).allClosed);
  ok('the region weekend check is unaffected', isWeekendIn('America/New_York', SAT));
}

// ── the collision guard, now actually asked ──────────────────────────────────
// Typing MET meaning MetLife created a ×0.1 Micro-Ether row quoting MET=F. The set that prevents
// it was three lines away and never consulted at the point rows are made.
for (const root of ['MET', 'MBT', 'GC', 'CL', 'BTC', 'ETH']) {
  ok(`${root} is in the multiplier table`, Object.prototype.hasOwnProperty.call(FUTURES_MULTIPLIER, root));
  ok(`but ${root} is NOT unambiguous from the symbol alone`, !isUnambiguousFuture(root));
}
// BTC and ETH are the new members and the reason is different from the others: not an equity
// collision, but the ordinary name of the spot asset the contract is written on.
ok('BTC is ambiguous', ROOT_AMBIGUOUS.has('BTC'));
ok('ETH is ambiguous', ROOT_AMBIGUOUS.has('ETH'));
eq('the old export is the same set', EQUITY_AMBIGUOUS, ROOT_AMBIGUOUS);
// The genuinely unambiguous roots still are — nothing trades as MGC or MNQ except the contract.
for (const root of ['MGC', 'MNQ', 'MES', 'M6E'])
  ok(`${root} is still identified from its symbol`, isUnambiguousFuture(root));

// What the creation path now does with each.
{
  const created = (sym) => multiplierFor(sym, { margined: isUnambiguousFuture(sym) });
  eq('MET no longer becomes Micro Ether', created('MET').multiplier, 1);
  eq('CL no longer becomes 1000 barrels of crude', created('CL').multiplier, 1);
  eq('BTC no longer becomes a 5-coin contract', created('BTC').multiplier, 1);
  eq('MGC is still sized as the contract it can only be', created('MGC').multiplier, 10);
}

// ── price precision across the whole crypto range ────────────────────────────
for (const [sym, v] of [['BTC', 111235.42], ['ETH', 4128.77], ['XRP', 2.4471],
                        ['DOGE', 0.08412], ['SHIB', 0.00000892]]) {
  eq(`${sym} stores exactly`, roundQuote(v), v);
  // Sub-dollar must be faithful — that is the case two decimals destroys. At or above a unit two
  // decimals IS the intended rounding, so fidelity is not the property; reading like a price is.
  if (Math.abs(v) < 1) ok(`${sym} displays without loss`, Math.abs(+fmtPrice(v) - v) <= Math.abs(v) * 1e-7);
  else ok(`${sym} displays as an ordinary price`, /^\d+\.\d\d$/.test(fmtPrice(v)));
}
eq('a spot pair is sized as units, not a contract', multiplierFor('BTC-USD', {}).multiplier, 1);

// ── WHICH SYMBOL ACTUALLY GETS YOU THE COIN ──────────────────────────────────
// The dangerous answers do not fail, they succeed on something else. Measured against the live
// feed on 2026-09-06: BTC → Grayscale Bitcoin Mini Trust ETF at $35.31 against spot at $79,707.77;
// LINK → Interlink Electronics, an unrelated manufacturer. A real price, with a real daily move,
// for a security that was never bought.
{
  const C = cryptoSymbolCheck;
  eq('the hyphenated pair is the right answer', [C('BTC-USD').ok, C('BTC-USD').kind], [true, 'pair']);
  eq('every fiat pair passes', ['SHIB-USD', 'ETH-EUR', 'DOGE-USD'].map(s => C(s).ok), [true, true, true]);

  // Three ways of being wrong, which do not deserve the same response.
  eq('BTCUSD is punctuation', [C('BTCUSD').kind, C('BTCUSD').suggestion], ['punctuation', 'BTC-USD']);
  eq('BTCUSDT is a different quote currency', [C('BTCUSDT').kind, C('BTCUSDT').suggestion], ['stablecoin', 'BTC-USD']);
  eq('and the hyphenated stablecoin form too', C('BTC-USDC').kind, 'stablecoin');
  eq('a bare base is a different INSTRUMENT', [C('BTC').kind, C('BTC').suggestion], ['bare', 'BTC-USD']);
  ok('and the note says so rather than just "invalid"', /listed security/.test(C('BTC').note));
  ok('the stablecoin note keeps the de-peg caveat', /not the dollar/.test(C('BTCUSDT').note));

  // Only the two that name the coin unambiguously are resolved. A bare base is NEVER resolved:
  // it is a real ticker, and turning BTC into BTC-USD would be a guess about intent — the same
  // class of inference that put a MetLife row on a Micro-Ether multiplier.
  eq('punctuation resolves', cryptoQuoteSymbol('BTCUSD'), 'BTC-USD');
  eq('stablecoin resolves', cryptoQuoteSymbol('BTCUSDT'), 'BTC-USD');
  eq('a bare base is left exactly as typed', cryptoQuoteSymbol('BTC'), 'BTC');
  eq('and so is anything not crypto-shaped', [cryptoQuoteSymbol('NVDA'), cryptoQuoteSymbol('MSTR')], ['NVDA', 'MSTR']);

  // Ordinary equities must not be dragged in by a suffix that happens to look like a quote leg.
  for (const s of ['NVDA', 'MSTR', 'COIN', 'BRK-B', 'IBIT'])
    eq(`${s} raises nothing`, [C(s).ok, C(s).kind], [true, null]);
  ok('LINK is flagged — it prices an electronics manufacturer', !C('LINK').ok);
  ok('and it is in the base list for that reason', CRYPTO_BASES.has('LINK'));
}

// ── ATR: 14 BARS IS NOT 14 OF THE SAME THING ─────────────────────────────────
// On an equity, 14 periods span 14 SESSIONS — about three calendar weeks. On a 24/7 series they
// span 14 CALENDAR DAYS. Calendar days is what is wanted for crypto: a market trading through the
// weekend has no session count to fall back on, and pretending it does would skip real price
// action. The maths is unchanged; the window is now reported so the two are never read as equal.
{
  const mk = (n, skipWeekends) => {
    const out = []; let t = Date.UTC(2026, 5, 1);
    while (out.length < n) {
      const dt = new Date(t), wd = dt.getUTCDay();
      if (!skipWeekends || (wd !== 0 && wd !== 6)) {
        const c = 100 + out.length * 0.3;
        out.push({ date: dt.toISOString().slice(0, 10), high: c * 1.01, low: c * 0.99, close: c });
      }
      t += 864e5;
    }
    return out;
  };
  const equity = atrSummary(mk(40, true));
  const crypto = atrSummary(mk(40, false));

  eq('a 7-day series spans one calendar day per bar', crypto.spanDays, ATR_PERIOD);
  ok('a 5-day series spans more calendar days than bars', equity.spanDays > ATR_PERIOD);
  eq('and each says which it is', [crypto.windowLabel, equity.windowLabel],
     ['14 days', '14 sessions (18 days)']);
  eq('continuity is measured, not assumed from the symbol', [crypto.continuous, equity.continuous], [true, false]);
  // The ATR value itself is untouched by any of this.
  ok('both still produce an ATR', equity.atr > 0 && crypto.atr > 0);
  eq('and the period is reported alongside it', crypto.period, ATR_PERIOD);
  // A series too short to fill the window must not claim a window it does not have.
  const thin = atrSummary(mk(3, false));
  ok('a thin series does not overstate its span', thin.spanDays == null || thin.spanDays <= 3);
}

// ── A COIN IS DIVISIBLE, AND THE SIZER COULD NOT SAY SO ──────────────────────
// A 1% risk budget on a $200k book against BTC at 79,707 with a 75,000 stop is about a quarter of
// a coin. Floored to a whole unit it came back 0, with "the suggested size rounds to zero" — a
// sizer that cannot size the position, failing in the one way that reads as an answer.
{
  const arg = { mode: 'risk', equityInPos: 200000, price: 79707, stop: 75000, multiplier: 1 };
  eq('as whole units it cannot size BTC at all', sizeSuggestion(arg).fullQty, 0);
  const d = sizeSuggestion({ ...arg, divisible: true });
  ok('divisible sizes a real fraction', d.fullQty > 0 && d.fullQty < 1);
  ok('and the notional is a real position', d.notional > 1000);
  eq('with no rounds-to-zero warning', d.warnings.filter(w => /rounds to zero/.test(w)).length, 0);

  // The SAME fixed-decimal defect lib/price.js exists to prevent, one layer down: per-unit risk of
  // 9.2e-7 was rounded to zero, the budget was divided by nothing, and `exact` came back Infinity.
  const shib = sizeSuggestion({ mode: 'risk', equityInPos: 200000, price: 0.00000892, stop: 0.0000080, multiplier: 1, divisible: true });
  ok('a sub-cent coin sizes at all', shib.fullQty > 0);
  ok('its per-unit risk survives', shib.perUnitRisk > 0 && shib.perUnitRisk < 1e-5);
  ok('and the notional is sane rather than infinite', Number.isFinite(shib.notional) && shib.notional > 0);

  // Whole-unit instruments are untouched — the assertion that makes this safe to ship.
  eq('an equity still sizes in whole shares', sizeSuggestion({ mode: 'risk', equityInPos: 200000, price: 150, stop: 140, multiplier: 1 }).fullQty, 120);
  eq('and a contract in whole contracts', sizeSuggestion({ mode: 'risk', equityInPos: 200000, price: 4649, stop: 4600, multiplier: 10 }).fullQty, 2);
  eq('roundQty still floors shares', [roundQty(0.5), roundQty(2.7), roundQty(137)], [0, 2, 130]);
  ok('but keeps a fraction when told it is divisible', roundQty(0.254, 1, { divisible: true }) > 0.25);

  // Only the pair forms are divisible. A bare BTC prices a listed security you buy whole, and a
  // futures contract is indivisible by definition.
  eq('which rows are divisible', ['BTC-USD', 'BTCUSD', 'BTCUSDT', 'BTC', 'BTC=F', 'NVDA', 'IBIT'].map(isSpotCrypto),
     [true, true, true, false, false, false, false]);
}

// ── TRADFI AND CRYPTO ARE TWO BOOKS ──────────────────────────────────────────
// They share no session, settlement, weekend or volatility regime, and reading a coin's overnight
// move beside a share's close invites a comparison that means nothing.
{
  const row = (sym, status, pct, extra = {}) => ({
    symbol: sym, trade: '', price: 100, levels: [],
    derived: { status, avgCost: status === 'setup' ? null : 95, avgExit: extra.exit ?? null,
               qty: status === 'setup' ? 0 : 1, scaleOuts: [], firstDate: '2026-08-01',
               lastDate: extra.closedOn ?? null, realizedPct: extra.rp ?? null },
    pnl: { unrealizedPct: pct },
  });
  eq('classification', [classOfView({ symbol: 'BTC-USD' }), classOfView({ symbol: 'NVDA' }), classOfView({ symbol: 'IBIT' })],
     ['crypto', 'tradfi', 'tradfi']);
  eq('an ETF wrapper is TradFi — it settles like a share', classOfView({ symbol: 'IBIT' }), 'tradfi');

  // SPLIT ONLY WHEN BOTH ARE PRESENT. A heading over an all-equity book is a label that never
  // varies, which is exactly why the direction column was removed from this card.
  const tradfiOnly = buildCard([row('NVDA', 'open', 4.2), row('ARM', 'open', -3.1)]);
  ok('an all-TradFi card carries no heading', !/TradFi|Crypto/.test(tradfiOnly.embeds[0].description));
  const cryptoOnly = buildCard([row('BTC-USD', 'open', 4.2)]);
  ok('an all-crypto card carries none either', !/TradFi|Crypto/.test(cryptoOnly.embeds[0].description));

  const mixed = buildCard([row('NVDA', 'open', 4.2), row('BTC-USD', 'open', 8.4),
                           row('TSLA', 'setup', null), row('SOL-USD', 'setup', null)]);
  const desc = mixed.embeds[0].description;
  ok('a mixed card heads both halves', /TradFi/.test(desc) && /Crypto/.test(desc));
  ok('TradFi leads', desc.indexOf('TradFi') < desc.indexOf('Crypto'));
  ok('every position still appears', ['NVDA', 'BTC-USD'].every(s => desc.includes(s)));
  // Watching splits into two SIDE-BY-SIDE fields rather than one with a divider inside it.
  const w = (mixed.embeds[0].fields || []).filter(f => /^Watching/.test(f.name));
  eq('watching splits into two fields', w.length, 2);
  ok('and they are laid out inline', w.every(f => f.inline === true));
  ok('each names its class and count', /TradFi · 1/.test(w[0].name) && /Crypto · 1/.test(w[1].name));

  // Closed splits the same way, and only when mixed.
  const cl = (syms) => buildClosedCard(syms.map(x => row(x, 'closed', null, { exit: 110, closedOn: '2026-09-01', rp: 5 })),
                                       { today: '2026-09-05' }).embeds[0].description;
  ok('closed splits when mixed', /TradFi/.test(cl(['NVDA', 'BTC-USD'])) && /Crypto/.test(cl(['NVDA', 'BTC-USD'])));
  ok('and does not when it is one book', !/TradFi/.test(cl(['NVDA', 'ARM'])));
  ok('every closed trade still appears', ['NVDA', 'BTC-USD'].every(s => cl(['NVDA', 'BTC-USD']).includes(s)));

  // The privacy boundary is unchanged by any of this.
  ok('no size leaks into a split card', !/\bqty\b|notional/i.test(desc));
}

// ── THE ARCHIVE IS TWO RECORDS TOO ───────────────────────────────────────────
// The grouping lives in ONE place now. Four consumers need it — the Discord positions block, the
// Watching field, the closed card, and the console archive in both its wide and narrow forms — and
// any two of them disagreeing about what belongs where is a worse bug than not splitting at all.
{
  const row = (sym) => ({ symbol: sym, derived: { lastDate: '2026-09-0' + (sym.length % 9) } });
  const mixed = [row('NVDA'), row('BTC-USD'), row('ARM'), row('ETH-USD')];

  eq('one book yields one unlabelled group', assetClassGroups([row('NVDA'), row('ARM')]).map(g => g.label), [null]);
  eq('and an all-crypto book likewise', assetClassGroups([row('BTC-USD')]).map(g => g.label), [null]);
  eq('a mixed book yields two, TradFi first', assetClassGroups(mixed).map(g => g.label), ['TradFi', 'Crypto']);
  eq('with everything accounted for', assetClassGroups(mixed).reduce((n, g) => n + g.rows.length, 0), mixed.length);
  eq('and nothing duplicated across them',
     new Set(assetClassGroups(mixed).flatMap(g => g.rows.map(r => r.symbol))).size, mixed.length);

  // The sort is applied WITHIN each group, so a heading never has an out-of-order list under it.
  const byName = (a, b) => a.symbol.localeCompare(b.symbol);
  eq('sorted inside each group', assetClassGroups(mixed, { sort: byName }).map(g => g.rows.map(r => r.symbol)),
     [['ARM', 'NVDA'], ['BTC-USD', 'ETH-USD']]);
  eq('and inside the single group too', assetClassGroups([row('NVDA'), row('ARM')], { sort: byName }).map(g => g.rows.map(r => r.symbol)),
     [['ARM', 'NVDA']]);

  // An empty archive must not render a heading over nothing.
  eq('empty stays empty', assetClassGroups([]), [{ label: null, rows: [] }]);
  // The card and the archive read the SAME function, so they cannot drift.
  eq('splitByClass agrees with the grouping',
     [splitByClass(mixed).tradfi.length, splitByClass(mixed).crypto.length, splitByClass(mixed).mixed],
     [2, 2, true]);
  // A custom accessor, for callers whose rows are not shaped like a view.
  eq('symbolOf is honoured', splitByClass([{ t: 'BTC-USD' }, { t: 'NVDA' }], x => x.t).crypto.length, 1);
}

// ── LIQUIDATION IS CONSOLE-ONLY ──────────────────────────────────────────────
// Asked for explicitly: it helps plan positioning and must not reach Discord. It is also the right
// call on the card's own terms — a liquidation price is entry, leverage and size restated, and
// two of those are among the four quantities lib/tradecard.js exists to refuse.
{
  const row = (sym, extra = {}) => ({
    symbol: sym, trade: '', price: 100, levels: [{ kind: 'stop', at: 90 }],
    derived: { status: 'open', avgCost: 95, qty: 1, scaleOuts: [], firstDate: '2026-08-01' },
    pnl: { unrealizedPct: 5 }, ...extra,
  });
  // A row carrying every perp field the console shows.
  const perp = row('HL:BTC', { leverage: 10, liquidationPx: 72911, hl: { coin: 'BTC', maxLeverage: 40, mark: 79604, fundingApr: 10.95 } });
  const v = publicView(perp);

  for (const f of ['leverage', 'liquidationPx', 'liq', 'hl', 'maxLeverage', 'marginUsed', 'notional'])
    ok(`publicView drops ${f}`, !(f in v));
  ok('and PUBLIC_FIELDS never names one', !PUBLIC_FIELDS.some(f => /liquid|leverage|margin|notional/i.test(f)));

  const card = buildCard([perp, row('NVDA')]);
  const whole = JSON.stringify(card);
  for (const leak of ['liquidat', 'leverage', '72911', 'marginUsed'])
    ok(`the card never contains "${leak}"`, !new RegExp(leak, 'i').test(whole));
  // The row itself still appears — suppressing the field must not suppress the position.
  ok('the position is still on the card', /HL:BTC/.test(whole));

  // Nor on the closed card.
  const closed = buildClosedCard([{ ...perp, derived: { ...perp.derived, status: 'closed', avgExit: 110, lastDate: '2026-09-01', realizedPct: 5 } }],
                                 { today: '2026-09-05' });
  ok('nor the closed card', !/liquidat|leverage/i.test(JSON.stringify(closed)));
}

// ── FOUR DECIMALS FOR A COIN, TWO FOR A SHARE ────────────────────────────────
// The card showed `avg 63.921452` for a Hong Kong share and `2.45` for XRP: too many digits where
// the instrument is quoted in cents, and too few where it is not. Both are the same mistake — a
// fixed decimal count applied to a book that spans eleven orders of magnitude — and neither is
// fixable inside lib/price.js, which sees a number and cannot know what it prices.
//
// So the SYMBOL decides. Above a dollar a coin may carry four decimals; everything else stays at
// two. Below a dollar nothing changes: that branch is on significant figures because a fixed count
// is what destroyed MJY, and four is still fixed — it zeroes SHIB and moves DOGE by 5%.
{
  eq('spot gets four', priceMaxDp('BTC-USD'), CRYPTO_PRICE_DP);
  eq('a perp gets four', priceMaxDp('HL:BTC'), CRYPTO_PRICE_DP);
  eq('a share gets two', priceMaxDp('NVDA'), EQUITY_PRICE_DP);
  eq('a foreign listing gets two', priceMaxDp('0981.HK'), EQUITY_PRICE_DP);
  eq('a spot ETF gets two — it settles like a share', priceMaxDp('IBIT'), EQUITY_PRICE_DP);
  eq('and a missing symbol does not throw', priceMaxDp(undefined), EQUITY_PRICE_DP);

  // What each of those actually prints, which is the claim the user can see.
  const shown = (sym, v) => fmtPrice(v, { maxDp: priceMaxDp(sym) });
  eq('XRP keeps its quote', shown('XRP-USD', 2.4471), '2.4471');
  eq('SOL does not grow a tail', shown('SOL-USD', 106.05), '106.05');
  eq('BTC still reads like a price', shown('BTC-USD', 79969), '79969.00');
  eq('a perp mark keeps all four', shown('HL:BTC', 79969.1234), '79969.1234');
  eq('NVDA is rounded to cents', shown('NVDA', 234.8195), '234.82');
  eq('and the average cost that started this', shown('0981.HK', 63.921452), '63.92');
  // MJY is below a dollar, so it takes the significant-figure branch whatever its class.
  eq('MJY is untouched by either cap', shown('MJY', 0.0064105), '0.0064105');
}

// ── WHICH BOOK, AND WHETHER DIVISIBLE, ARE DIFFERENT QUESTIONS ───────────────
// Found by rendering a mixed card rather than by anything failing: HL:BTC — the most crypto thing
// in the book — appeared under TradFi. `classOfView` asked `isSpotCrypto`, which answers the
// NARROWER question "can this be held in fractions of a unit", and a Hyperliquid perp cannot: 133
// of the venue's 233 markets trade in whole units, which is why lib/sizing.js needs that answer.
// Reusing it for classification meant every perp was filed by its size step.
{
  eq('a perp is crypto', classOfView({ symbol: 'HL:BTC' }), 'crypto');
  eq('and so is spot', classOfView({ symbol: 'BTC-USD' }), 'crypto');
  eq('isCryptoAsset covers both', ['HL:BTC', 'BTC-USD', 'BTCUSDT', 'NVDA', 'IBIT'].map(isCryptoAsset),
     [true, true, true, false, false]);
  // The narrow question keeps its own answer — a perp must not be fractionally sized.
  eq('while divisibility still says no to a perp', isSpotCrypto('HL:BTC'), false);
  eq('and yes to spot', isSpotCrypto('BTC-USD'), true);

  const rows = [{ symbol: 'HL:BTC' }, { symbol: 'NVDA' }];
  eq('the perp lands in the crypto half', splitByClass(rows).crypto.map(r => r.symbol), ['HL:BTC']);
  eq('and the grouping agrees', assetClassGroups(rows).map(g => [g.label, g.rows.map(r => r.symbol)]),
     [['TradFi', ['NVDA']], ['Crypto', ['HL:BTC']]]);
}

// ── THE RENDERED CARD, WHICH IS WHERE BOTH DEFECTS WERE VISIBLE ──────────────
// Asserting on the formatter alone would have missed the classification bug entirely: the decimals
// were right in isolation and wrong on the card, because the wrong symbol was reaching the rule.
{
  const row = (sym, price, avg) => ({
    symbol: sym, trade: '', price, levels: [],
    derived: { status: 'open', avgCost: avg, qty: 1, scaleOuts: [], firstDate: '2026-08-01' },
    pnl: { unrealizedPct: 1.5 },
  });
  const desc = buildCard([row('NVDA', 258.5149, 234.8195), row('0981.HK', 68.2951, 63.921452),
                          row('MJY', 0.0064105, 0.006452), row('XRP-USD', 2.4471, 2.1038),
                          row('SOL-USD', 106.05, 99.4), row('HL:BTC', 79969.1234, 78500.5)]).embeds[0].description;

  for (const [what, s] of [['NVDA', '**NVDA** 258.51 · avg 234.82'],
                           ['the HK listing', '**0981.HK** 68.30 · avg 63.92'],
                           ['XRP', '**XRP-USD** 2.4471 · avg 2.1038'],
                           ['SOL', '**SOL-USD** 106.05 · avg 99.40'],
                           ['the perp', '**HL:BTC** 79969.1234 · avg 78500.50']])
    ok(`${what} reads correctly on the card`, desc.includes(s));
  // MJY's sub-dollar rendering is the one this file's sibling exists to protect.
  ok('MJY still carries its significant figures', /\*\*MJY\*\* 0\.0064105 · avg 0\.006452/.test(desc));
  // And the perp is under the right heading, which is the bug the card surfaced.
  ok('the perp sits below the Crypto heading', desc.indexOf('HL:BTC') > desc.indexOf('Crypto'));
  ok('and not in the TradFi half', desc.indexOf('HL:BTC') > desc.indexOf('TradFi'));
  ok('while NVDA is above the Crypto heading', desc.indexOf('NVDA') < desc.indexOf('Crypto'));
  // `avg 63.921452` was the complaint. Nothing priced at or above a dollar may carry a tail like
  // that now — MJY's 0.006452 is not one, it is the sub-dollar rule doing its job.
  ok('nothing above a dollar carries a five-decimal average', !/avg [1-9]\d*\.\d{5}/.test(desc));
}

// ── THE WALLET IS CONSOLE-ONLY, LIKE THE LIQUIDATION PRICE ───────────────────
// A holdings list is SIZE, which is the first of the four quantities lib/tradecard.js exists to
// refuse — and unlike a stop or a target, nobody ever decided to publish it. It reaches the
// console through its own authenticated field and must not have a path to a card.
{
  const src = readFileSync(new URL('../lib/tradecard.js', import.meta.url), 'utf8');
  ok('the card module knows nothing about spot balances',
     !/hyperliquidSpot|spotHoldings|fetchHlSpot|entryNtl/.test(src));
  ok('nor about the on-chain wallet', !/fetchWallet|walletBalances|balanceOf|aggregate3|hyperevm/i.test(src));
  ok('nor about wallet balances by any other name', !/\bbalances\b|\bwallet\b/i.test(src));

  // And a row that somehow carried them still publishes none of it. The private figures are
  // distinctive digit strings, asserted absent from the serialised payload — the same construction
  // the rest of this file's privacy tests use, so a future edit fails here rather than on Discord.
  const row = {
    symbol: 'HL:BTC', trade: '', price: 100, levels: [{ kind: 'stop', at: 90 }],
    derived: { status: 'open', avgCost: 95, qty: 1, scaleOuts: [], firstDate: '2026-08-01' },
    pnl: { unrealizedPct: 5 },
    // everything the wallet section shows
    hlSpot: { total: 987654.32, rows: [{ coin: 'HYPE', total: 4444.11, hold: 1111.22, value: 333322.11 }] },
    walletTotal: 987654.32, spotRows: [{ coin: 'HYPE', free: 3332.89 }],
  };
  const v = publicView(row);
  for (const f of ['hlSpot', 'walletTotal', 'spotRows'])
    ok(`publicView drops ${f}`, !(f in v));
  const whole = JSON.stringify(buildCard([row, { ...row, symbol: 'NVDA' }]));
  for (const leak of ['987654', '4444.11', '1111.22', '333322', '3332.89', 'HYPE'])
    ok(`the card never contains "${leak}"`, !whole.includes(leak));
  ok('while the position itself still appears', /HL:BTC/.test(whole));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
