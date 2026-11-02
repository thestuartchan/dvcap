// test/rowRepairs.test.mjs — rows read the same way everywhere (lib/rowRepairs.js), and the
// statement building a credit combo as what it is (lib/flex.js optionAdds). Fake tickers.
import { creditCombos, normalizeRows } from '../lib/rowRepairs.js';
import { optionAdds } from '../lib/flex.js';
import { derivePosition } from '../lib/positions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// An iron condor sold for a 1.20 credit, stored the old way: long, legs as held, entry at −1.20,
// then expired: "sold at 0".
const legs = [{ right: 'P', strike: 95, side: 'long', expiry: '2026-10-30', ratio: 1 }, { right: 'P', strike: 100, side: 'short', expiry: '2026-10-30', ratio: 1 },
  { right: 'C', strike: 145, side: 'short', expiry: '2026-10-30', ratio: 1 }, { right: 'C', strike: 150, side: 'long', expiry: '2026-10-30', ratio: 1 }];
const bad = { id: 'ZZZ-flex-opt-1', symbol: 'ZZZ', underlying: 'ZZZ', instrument: 'spread', side: 'long', multiplier: 100, legs,
  fills: [{ id: 'f0', side: 'buy', qty: 1, price: -1.2, date: '2026-10-29' }, { id: 'x', side: 'sell', qty: 1, price: 0, date: '2026-10-30' }] };
const { rows: [good], fixed } = creditCombos([bad]);
eq('a credit stored long at a negative price becomes a short card', [good.side, good.fills.map(f => `${f.side}@${f.price}`)], ['short', ['sell@1.2', 'buy@0']]);
eq('…legs written as the spread sold', good.legs.map(l => l.side), ['short', 'long', 'long', 'short']);
eq('…and its P&L reads: the whole credit kept', derivePosition(good.fills, { multiplier: 100, side: 'short' }).realized, 120);
eq('named, and left alone the second time', [fixed, creditCombos([good]).fixed], [['ZZZ-flex-opt-1'], []]);
eq('nothing to do: the very same array', (() => { const a = [good]; return normalizeRows(a).rows === a; })(), true);

// The statement builds it right in the first place.
const line = (k, pc, qty, cost) => ({ root: 'ZZZ', symbol: `ZZZ ${k}${pc}`, conid: `${k}${pc}`, strike: k, putCall: pc, expiry: '20261030', qty, costBasisPrice: cost, multiplier: 100, currency: 'USD', openDate: '2026-10-29' });
const { rows: [made] } = optionAdds([line(95, 'P', 1, 0.5), line(100, 'P', -1, 1.1), line(145, 'C', -1, 1.0), line(150, 'C', 1, 0.4)], { asOf: '2026-10-29' });
eq('a condor sold: built short at the credit', [made.side, made.fills[0].side, made.fills[0].price], ['short', 'sell', 1.2]);
eq('…legs as the spread sold', made.legs.map(l => `${l.strike}${l.right}:${l.side}`), ['95P:short', '100P:long', '145C:long', '150C:short']);
const { rows: [debit] } = optionAdds([line(95, 'C', 1, 2.0), line(100, 'C', -1, 0.8)], { asOf: '2026-10-29' });
eq('a debit spread is unchanged: long at the debit', [debit.side, debit.fills[0].price], ['long', 1.2]);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
