// Regression tests for lib/fxrates.js — one convention, pegs, and null-safety.
import { ratesFrom, convert, toUsd, fxRisk, fxSymbolsFor, fmtCcy , resolveRowCurrency } from '../lib/fxrates.js';
let pass=0,fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};
const ok=(n,c)=>eq(n,!!c,true);

// Live quotes as verified against Yahoo (XXX=X == units of XXX per 1 USD).
const prices = { 'HKD=X':{price:7.8375}, 'AED=X':{price:3.6726}, 'KRW=X':{price:1382.21}, 'EUR=X':{price:0.8562} };
const { rates, sources } = ratesFrom(prices);

eq('USD is exactly 1', rates.USD, 1);
eq('HKD rate', rates.HKD, 7.8375);
eq('source recorded', sources.KRW, 'KRW=X');

// One direction for every currency — HK$78,375 is $10,000.
eq('HKD -> USD', Math.round(toUsd(78375, 'HKD', rates)), 10000);
eq('USD -> HKD', Math.round(convert(10000, 'USD', 'HKD', rates)), 78375);
// EUR uses the SAME convention (units per USD), not the inverted EURUSD quote.
eq('EUR -> USD', +toUsd(856.2, 'EUR', rates).toFixed(2), 1000);
eq('cross HKD -> KRW', Math.round(convert(7837.5, 'HKD', 'KRW', rates)), 1382210);
eq('same currency is identity', convert(123, 'EUR', 'EUR', rates), 123);

// Missing rate must read as missing, never as an unconverted number.
eq('missing rate -> null', convert(100, 'JPY', 'USD', rates), null);
eq('non-numeric -> null', convert('abc', 'HKD', 'USD', rates), null);

// A hard peg falls back to published parity — a real rate, not a guess.
const pegOnly = ratesFrom({});
eq('AED falls back to peg', pegOnly.rates.AED, 3.6725);
eq('HKD does NOT fake a rate', pegOnly.rates.HKD, undefined);

// Peg awareness: HKD/AED carry no FX risk vs USD; EUR/KRW do.
eq('HKD no FX risk', fxRisk('HKD','USD').real, false);
eq('AED no FX risk', fxRisk('AED','USD').real, false);
eq('EUR has FX risk', fxRisk('EUR','USD').real, true);
eq('KRW has FX risk', fxRisk('KRW','USD').real, true);
eq('CNY managed but real', fxRisk('CNY','USD').real, true);
eq('same ccy no risk', fxRisk('USD','USD').real, false);

eq('USD needs no fx symbol', fxSymbolsFor(['USD']), []);
eq('symbols for book', fxSymbolsFor(['USD','HKD','AED']), ['HKD=X','AED=X']);
eq('formats with sign', fmtCcy(1234.5,'HKD'), 'HK$1,235');

// ── ONE MONEY FORMAT ─────────────────────────────────────────────────────────
// The rule was `abs >= 1000 ? 0 : 2`, so "$847.20" and "$1,203" sat in the same column and a book
// total silently changed its own precision as it crossed a thousand. Money is whole units now.
eq('under a thousand loses its cents too', fmtCcy(847.2, 'USD'), '$847');
eq('over a thousand is unchanged', fmtCcy(1203, 'USD'), '$1,203');
eq('the old boundary no longer changes shape', [fmtCcy(999.5, 'USD'), fmtCcy(1000.5, 'USD')], ['$1,000', '$1,001']);
eq('a round number carries no .00', fmtCcy(2000, 'USD'), '$2,000');
eq('zero is zero', fmtCcy(0, 'USD'), '$0');

// THE ONE EXCEPTION, and it is the repo's standing rule: a non-zero figure must never render as
// zero. Per-unit risk is the case that bites — $0.42 a share is a real number and "$0" is not a
// rounder version of it, it is a different claim.
eq('a real sub-unit amount keeps its cents', fmtCcy(0.42, 'USD'), '$0.42');
eq('and a smaller one goes further rather than vanishing', fmtCcy(0.004, 'USD'), '$0.0040');
// ...but the ladder stops rather than claiming precision it does not have: "$0.0000" says we
// measured to a hundredth of a cent and found nothing, where "$0" says it is nothing.
eq('below that it says zero honestly', fmtCcy(0.00004, 'USD'), '$0');

// THE SIGN GOES OUTSIDE. "$-1,235" reads as a currency called "$-" before it reads as a loss.
eq('negatives lead with the minus', fmtCcy(-1234.56, 'USD'), '-$1,235');
eq('and so do sub-unit negatives', fmtCcy(-0.42, 'USD'), '-$0.42');
eq('a value that rounds to nothing is never "-$0"', fmtCcy(-0.00004, 'USD'), '$0');

// Currencies with no minor unit never get one, even to avoid a zero — ¥0.42 is not a thing.
eq('won has no sub-unit', [fmtCcy(1234.5, 'KRW'), fmtCcy(0.42, 'KRW')], ['₩1,235', '₩0']);
eq('nor yen', fmtCcy(0.42, 'JPY'), '¥0');
eq('but its negatives still lead', fmtCcy(-1234.5, 'KRW'), '-₩1,235');

// An unknown code still formats rather than throwing.
eq('unknown currency falls back to its code', fmtCcy(1234.5, 'ZZZ'), 'ZZZ 1,235');
eq('and null is a dash', [fmtCcy(null, 'USD'), fmtCcy(NaN, 'USD')], ['—', '—']);


// ─── resolveRowCurrency ──────────────────────────────────────────────────────
// A row's currency belongs to the exchange, not to a preference, and every new row used to be
// seeded USD regardless. The whole question is whether money has been recorded against the row.
{
  const r = resolveRowCurrency({ rowCcy: 'USD', quoteCcy: 'HKD' });
  eq('an empty row takes the exchange\'s answer', [r.action, r.currency], ['adopt', 'HKD']);
  ok('and says where it came from', /set from the exchange/.test(r.note));
}
{
  const r = resolveRowCurrency({ rowCcy: 'USD', quoteCcy: 'HKD', hasFills: true });
  eq('a row with fills is never rewritten underneath them', [r.action, r.currency], ['warn', 'USD']);
  ok('it names both currencies', /USD/.test(r.note) && /HKD/.test(r.note));
  ok('and says the money figures are the thing that is wrong', /cost basis and P&L are out/.test(r.note));
}
{
  const r = resolveRowCurrency({ rowCcy: 'JPY', quoteCcy: 'HKD', userSet: true });
  eq('a deliberate choice is not overruled on an empty row either', r.action, 'warn');
  eq('and the row keeps what was chosen', r.currency, 'JPY');
}
{
  eq('agreement is silent', resolveRowCurrency({ rowCcy: 'HKD', quoteCcy: 'HKD' }).action, 'ok');
  eq('and case does not manufacture a disagreement', resolveRowCurrency({ rowCcy: 'hkd', quoteCcy: 'HKD' }).action, 'ok');
}
{
  // Silence is not disagreement. MNQ has no Yahoo listing at all; futures and unknown tickers must
  // not be able to flip a currency to null or warn about one.
  eq('no quote leaves the row alone', resolveRowCurrency({ rowCcy: 'USD', quoteCcy: null }).action, 'ok');
  eq('and a junk code is ignored, not adopted', resolveRowCurrency({ rowCcy: 'USD', quoteCcy: 'US' }).action, 'ok');
  eq('as is an empty string', resolveRowCurrency({ rowCcy: 'USD', quoteCcy: '' }).action, 'ok');
  eq('a missing row currency still defaults to USD', resolveRowCurrency({ quoteCcy: 'USD' }).currency, 'USD');
  eq('and an entirely empty call does not throw', resolveRowCurrency().action, 'ok');
}
{
  // Adoption must be idempotent, or the effect that applies it loops forever.
  const first = resolveRowCurrency({ rowCcy: 'USD', quoteCcy: 'KRW' });
  const again = resolveRowCurrency({ rowCcy: first.currency, quoteCcy: 'KRW' });
  eq('adopting once settles it', again.action, 'ok');
}

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
