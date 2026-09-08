// test/reorder.test.mjs — the off-by-one that reordering always has.
//
// Dragging DOWN removes the row before inserting it, so every index above the origin shifts by one.
// A naive splice lands one short, and ONLY for downward moves — which is exactly the kind of bug
// that survives a manual test because the tester happens to drag upward first.
import { moveOnto } from '../lib/reorder.js';

// A REFERENCE IMPLEMENTATION, deliberately not shipped. moveOnto is checked against it below, so
// the semantics are pinned by two independent definitions rather than by one function agreeing
// with itself. It lives here because nothing in the app moves a row by an offset — the buttons
// move a row past its visible neighbour, which is a drop.
function moveBy(list = [], id, delta) {
  const from = list.findIndex(r => r && r.id === id);
  if (from < 0 || !delta) return list;
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (to === from) return list;
  const next = list.slice();
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const L = (...ids) => ids.map(id => ({ id }));
const ids = (l) => l.map(r => r.id);

// ── MOVE BY ONE ──────────────────────────────────────────────────────────────
{
  const l = L('a', 'b', 'c', 'd');
  eq('down one', ids(moveBy(l, 'b', 1)), ['a', 'c', 'b', 'd']);
  eq('up one', ids(moveBy(l, 'c', -1)), ['a', 'c', 'b', 'd']);
  eq('down two', ids(moveBy(l, 'a', 2)), ['b', 'c', 'a', 'd']);

  // Clamped, not wrapped — a row at the top moved up stays put rather than appearing at the bottom.
  eq('the top row cannot move up', ids(moveBy(l, 'a', -1)), ['a', 'b', 'c', 'd']);
  eq('nor the bottom row down', ids(moveBy(l, 'd', 1)), ['a', 'b', 'c', 'd']);
  eq('an overshoot clamps to the end', ids(moveBy(l, 'a', 99)), ['b', 'c', 'd', 'a']);
  eq('and to the start', ids(moveBy(l, 'd', -99)), ['d', 'a', 'b', 'c']);

  eq('an unknown id changes nothing', ids(moveBy(l, 'zz', 1)), ['a', 'b', 'c', 'd']);
  eq('and a zero delta changes nothing', ids(moveBy(l, 'b', 0)), ['a', 'b', 'c', 'd']);
  eq('an empty list is not an error', moveBy([], 'a', 1), []);

  // React state depends on identity changing; an in-place sort renders once and then reverts.
  ok('the input is never mutated', ids(l).join() === 'a,b,c,d');
  ok('and a real move returns a new array', moveBy(l, 'b', 1) !== l);
  ok('while a no-op returns the same one', moveBy(l, 'a', -1) === l);
}

// ── DROP ONTO ────────────────────────────────────────────────────────────────
// The direction asymmetry is the whole point of testing this separately.
{
  const l = L('a', 'b', 'c', 'd');
  eq('dropping the first onto the third takes its place', ids(moveOnto(l, 'a', 'c')), ['b', 'c', 'a', 'd']);
  eq('dropping the third onto the first takes its place', ids(moveOnto(l, 'c', 'a')), ['c', 'a', 'b', 'd']);
  eq('dropping onto the last row lands last', ids(moveOnto(l, 'a', 'd')), ['b', 'c', 'd', 'a']);
  eq('dropping onto the first lands first', ids(moveOnto(l, 'd', 'a')), ['d', 'a', 'b', 'c']);
  eq('adjacent downward is a swap', ids(moveOnto(l, 'a', 'b')), ['b', 'a', 'c', 'd']);
  eq('adjacent upward is the same swap', ids(moveOnto(l, 'b', 'a')), ['b', 'a', 'c', 'd']);

  eq('dropping a row on itself changes nothing', ids(moveOnto(l, 'b', 'b')), ['a', 'b', 'c', 'd']);
  eq('dropping on something absent changes nothing', ids(moveOnto(l, 'b', 'zz')), ['a', 'b', 'c', 'd']);
  eq('dragging something absent changes nothing', ids(moveOnto(l, 'zz', 'b')), ['a', 'b', 'c', 'd']);
  ok('the input is never mutated', ids(l).join() === 'a,b,c,d');

  // moveOnto by one step must agree with moveBy — two routes to the same reorder.
  for (const [from, to, d] of [['a', 'b', 1], ['b', 'c', 1], ['c', 'b', -1], ['d', 'c', -1]])
    eq(`dropping ${from} on ${to} equals moving it ${d > 0 ? 'down' : 'up'} one`,
       ids(moveOnto(l, from, to)), ids(moveBy(l, from, d)));
}

// ── THE VISIBLE LIST IS NOT THE STORED LIST ─────────────────────────────────
// The stored array interleaves setups and open positions; a section renders only some of them. A
// button that moved a row by one INDEX could swap it with a row this section does not show — the
// click lands, the state changes, and nothing on screen moves. Targeting the visible neighbour is
// what makes the control mean what it looks like it means, so that is asserted directly.
{
  const stored = L('setupA', 'openX', 'setupB', 'openY');
  const visible = ['openX', 'openY'];

  const down = moveOnto(stored, 'openX', visible[1]);
  eq('moving the first visible row down reorders the visible ones',
     ids(down).filter(id => visible.includes(id)), ['openY', 'openX']);
  ok('and the hidden rows are all still there', visible.concat(['setupA', 'setupB']).every(id => ids(down).includes(id)));
  eq('nothing is lost or duplicated', down.length, stored.length);

  const up = moveOnto(stored, 'openY', visible[0]);
  eq('moving the last visible row up does too',
     ids(up).filter(id => visible.includes(id)), ['openY', 'openX']);

  // The bug this replaced: by index, "down one" swapped openX with setupB and the open list looked
  // identical afterwards.
  const byIndex = moveBy(stored, 'openX', 1);
  eq('whereas moving by one index leaves the visible order untouched',
     ids(byIndex).filter(id => visible.includes(id)), ['openX', 'openY']);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
