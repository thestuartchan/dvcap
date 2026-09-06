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
  ok(`${sym} displays without loss`, Math.abs(+fmtPrice(v) - v) <= Math.abs(v) * 1e-7);
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

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
