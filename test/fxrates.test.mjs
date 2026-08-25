// Regression tests for lib/fxrates.js — one convention, pegs, and null-safety.
import { ratesFrom, convert, toUsd, fxRisk, fxSymbolsFor, fmtCcy } from '../lib/fxrates.js';
let pass=0,fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};

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

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
