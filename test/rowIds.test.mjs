// test/rowIds.test.mjs — one card, one id (lib/rowIds.js). Fake tickers.
import { uniqueRowIds } from '../lib/rowIds.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const put = { id: 'ZZZ-20261027-0', symbol: 'ZZZ', legs: [{ right: 'P', strike: 520 }], fills: [{ id: 'a1' }] };
const call = { id: 'ZZZ-20261027-0', symbol: 'ZZZ', legs: [{ right: 'C', strike: 545 }], fills: [{ id: 'b1' }] };
const other = { id: 'YYY-1', symbol: 'YYY' };
const u = uniqueRowIds([put, call, other]);
eq('two option cards on one id: the second is renamed after its contract', u.rows.map(r => r.id), ['ZZZ-20261027-0', 'ZZZ-20261027-0-C545', 'YYY-1']);
eq('…and says so', u.renamed, [{ from: 'ZZZ-20261027-0', to: 'ZZZ-20261027-0-C545' }]);
eq('the same rows give the same names every load (server and console agree)', uniqueRowIds([put, call, other]).rows.map(r => r.id), u.rows.map(r => r.id));
eq('already renamed: left alone', uniqueRowIds(u.rows).renamed, []);
const same = [put, other];
eq('nothing duplicated: the very same array back', uniqueRowIds(same).rows === same, true);
eq('a share card with no legs: named after its first fill', uniqueRowIds([{ id: 'X', fills: [{ id: 'f1' }] }, { id: 'X', fills: [{ id: 'f2' }] }]).rows[1].id, 'X-f2');
eq('a name already taken is not reused', uniqueRowIds([{ id: 'X' }, { id: 'X-dup' }, { id: 'X' }]).rows.map(r => r.id), ['X', 'X-dup', 'X-dup-2']);

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
