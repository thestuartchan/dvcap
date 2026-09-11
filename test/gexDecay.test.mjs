// test/gexDecay.test.mjs — what stops existing at the next expiry.
import { decayRead, decayLines, strikeSupport, WALL_MOVE_PCT, SUPPORT_HEAVY } from '../lib/gexDecay.js';
import { assertObservational } from '../lib/read.js';
// THE `flip` HANDED IN MUST BE THE FULL-CHAIN FLIP. In production it is summary.flipLevel, which
// gexSummary computes with the same function and the same convention this module removes the front
// expiry from — so the two are comparable. A hard-coded number in a test is not, and would report
// a pivot move on every board.
import { flipLevel } from '../lib/gex.js';
const fullFlip = (chain, S, now) => flipLevel(chain, { S, now }).level;

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const NOW = '2026-09-10T15:00:00Z';
const S = 710;
// Contracts carry the fields contractGamma reads: strike, type, expiry, oi, iv.
const c = (expiry, type, strike, oi, iv = 0.22) => ({ expiry, type, strike, oi, iv });

// ── THE WALL THAT IS A FLOOR UNTIL 4PM ──────────────────────────────────────
// A put wall carrying 6.5× the calls is a floor. The same wall at 62% today's expiry is a floor
// until the close, and the board rendered the two identically.
{
  const chain = [
    // Today's book piles into 710 on the put side and nothing else does.
    c('2026-09-10', 'put', 710, 60000), c('2026-09-10', 'call', 722, 20000),
    // Behind it, the September monthly peaks at 700 and 730.
    c('2026-09-18', 'put', 700, 30000), c('2026-09-18', 'call', 730, 25000),
    c('2026-09-18', 'put', 710, 8000),
    c('2026-10-16', 'put', 690, 12000), c('2026-10-16', 'call', 750, 10000),
  ];
  const d = decayRead(chain, { S, now: NOW, today: '2026-09-10',
    callWall: 722, putWall: 710, flip: fullFlip(chain, S, NOW), frontExpiry: '2026-09-10', frontShare: 36.7 });

  eq('the front expiry is named', d.front, '2026-09-10');
  eq('and recognised as today', d.expiringToday, true);
  eq('with what rolls off it', d.rollingOff.oi, 80000);
  eq('and what is left behind', d.remainingExpiries, ['2026-09-18', '2026-10-16']);

  // THE EXACT QUESTION, ASKED EXACTLY. How much of THIS STRIKE is today — not the expiry's share
  // of the whole book, which is a different number: a 36.7% front expiry can be 90% of one strike.
  ok('the put wall is mostly today', d.support.put.frontShare > SUPPORT_HEAVY);
  ok('and it is not the same number as the book-wide share', d.support.put.frontShare !== 36.7);

  // WHAT SURVIVES, computed rather than guessed: walls() over the chain with the front removed.
  eq('the put wall does not survive', d.after.putWall, 700);
  eq('and the move is material', d.moves.putWall.material, true);
  eq('the call wall does not either', d.after.callWall, 730);

  ok('the lines name the replacement level',
     d.lines.some(l => /put wall at 710/.test(l) && /\*\*700\*\*/.test(l)));
  ok('and say how much of the book goes', d.lines.some(l => /36\.7% of the gamma in the expiries read expires at today's close/.test(l)));
  // THE DENOMINATOR IS NAMED. This read covers six expiries of roughly twenty (lib/occ.js), so a
  // share of it is not a share of the whole listed book — and a smaller denominator rounds the
  // number UP, on a figure whose whole job is to say how much of what you see is about to go.
  ok('and never claims to be a share of the whole book', !d.lines.some(l => /gross gamma/.test(l)));
}

// ── A LEVEL THAT SURVIVES IS A DIFFERENT STATEMENT ──────────────────────────
// A tile that reports "no change" every day trains a reader to skip it on the day there is one,
// so a surviving board says so once and stops.
{
  const chain = [
    c('2026-09-10', 'put', 700, 20000), c('2026-09-10', 'call', 730, 15000),
    c('2026-09-18', 'put', 700, 50000), c('2026-09-18', 'call', 730, 40000),
    c('2026-10-16', 'put', 700, 20000), c('2026-10-16', 'call', 730, 18000),
  ];
  const d = decayRead(chain, { S, now: NOW, today: '2026-09-10',
    callWall: 730, putWall: 700, flip: fullFlip(chain, S, NOW), frontExpiry: '2026-09-10', frontShare: 18 });
  eq('the walls hold', [d.after.putWall, d.after.callWall], [700, 730]);
  eq('so neither move is material', [d.moves.putWall.material, d.moves.callWall.material], [false, false]);
  // THE PIVOT IS NOT A WALL AND MOVES ANYWAY. Removing an expiry changes the whole net-gamma
  // profile, not just the peaks, so a board whose walls both survive can still have its pivot
  // shift — and that is worth its own line rather than being folded into "nothing changed".
  ok('but the pivot still shifts, and says so', d.lines.some(l => /pivot/.test(l)));
  eq('and nothing else is claimed', d.lines.length, 2);

  // A genuinely unchanged board: the front expiry is small enough to move nothing.
  const quietChain = [
    c('2026-09-10', 'put', 700, 200), c('2026-09-10', 'call', 730, 150),
    c('2026-09-18', 'put', 700, 50000), c('2026-09-18', 'call', 730, 40000),
    c('2026-10-16', 'put', 700, 20000), c('2026-10-16', 'call', 730, 18000),
  ];
  const quiet = decayRead(quietChain, { S, now: NOW, today: '2026-09-10', callWall: 730, putWall: 700,
       flip: fullFlip(quietChain, S, NOW), frontExpiry: '2026-09-10', frontShare: 1 });
  ok('a board that survives intact says so once', quiet.lines.some(l => /not one expiry/.test(l)));
  eq('and stops there', quiet.lines.length, 2);
}

// ── A STRIKE THAT IS MOSTLY TODAY BUT STILL HOLDS ───────────────────────────
// Both facts are true at once and the useful sentence says so: most of it goes, and the strike
// survives because later books peak there too.
{
  const chain = [
    c('2026-09-10', 'put', 700, 90000),
    c('2026-09-18', 'put', 700, 20000), c('2026-09-18', 'put', 690, 5000),
    c('2026-09-18', 'call', 730, 10000), c('2026-09-10', 'call', 730, 5000),
  ];
  const d = decayRead(chain, { S, now: NOW, today: '2026-09-10',
    callWall: 730, putWall: 700, flip: fullFlip(chain, S, NOW), frontExpiry: '2026-09-10', frontShare: 60 });
  ok('most of the wall is today', d.support.put.frontShare > SUPPORT_HEAVY);
  eq('and yet the strike holds', d.after.putWall, 700);
  ok('the line holds both facts', d.lines.some(l => /but the strike holds/.test(l)));
}

// ── THE WHOLE BOARD EXPIRING IS ITS OWN STATE ───────────────────────────────
{
  const chain = [c('2026-09-10', 'put', 700, 20000), c('2026-09-10', 'call', 730, 15000)];
  const d = decayRead(chain, { S, now: NOW, today: '2026-09-10',
    callWall: 730, putWall: 700, flip: fullFlip(chain, S, NOW), frontExpiry: '2026-09-10', frontShare: 100 });
  eq('nothing survives', d.remainingExpiries, []);
  eq('and the walls after are empty', [d.after.putWall, d.after.callWall], [null, null]);
  ok('the tile says so plainly', /Every contract on the board expires/.test(d.lines[0]));
  eq('and says nothing else', d.lines.length, 1);
}

// ── STRIKE SUPPORT ON ITS OWN ───────────────────────────────────────────────
{
  const chain = [c('2026-09-10', 'put', 700, 75000), c('2026-09-18', 'put', 700, 25000),
                 c('2026-09-10', 'call', 700, 40000)];
  const sup = strikeSupport(chain, 700, '2026-09-10', 'put', { S, now: NOW });
  const bothSides = strikeSupport(chain, 700, '2026-09-10', null, { S, now: NOW });
  // The 40k calls sitting on the same strike are all front-expiry, so counting them would push the
  // share up. A put wall is a statement about puts.
  ok('the side is respected — calls at the same strike do not count', bothSides.total > sup.total);
  ok('and counting them would change the answer', bothSides.frontShare > sup.frontShare);
  // GAMMA-WEIGHTED, NOT OI-WEIGHTED. 75k of 100k contracts is 75% of the open interest and not
  // 75% of the gamma: a near-dated out-of-the-money option carries less of it than a far-dated
  // one. The walls this supports are gamma-weighted, so this is too.
  ok('the share is gamma-weighted, not a contract count', Math.abs(sup.frontShare - 75) > 5);
  eq('an absent strike has no support reading', strikeSupport(chain, 999, '2026-09-10', 'put', { S, now: NOW }), null);
  eq('and neither does a missing front', strikeSupport(chain, 700, null, 'put', { S, now: NOW }), null);
}

// ── NOTHING TO READ IS NULL, NOT A GUESS ────────────────────────────────────
{
  eq('no chain, no reading', decayRead([], { S, now: NOW }), null);
  eq('no spot, no reading', decayRead([c('2026-09-10', 'put', 700, 10)], { S: 0, now: NOW }), null);
  eq('no expiries, no reading', decayRead([{ type: 'put', strike: 700, oi: 10 }], { S, now: NOW }), null);
  ok('the move threshold is a named constant', WALL_MOVE_PCT > 0 && WALL_MOVE_PCT < 1);
  eq('empty inputs render nothing rather than a sentence about nothing', decayLines({ rest: 1 }), []);
}

// ── OBSERVATION, NOT INSTRUCTION ────────────────────────────────────────────
{
  const chain = [
    c('2026-09-10', 'put', 710, 60000), c('2026-09-10', 'call', 722, 20000),
    c('2026-09-18', 'put', 700, 30000), c('2026-09-18', 'call', 730, 25000),
  ];
  const d = decayRead(chain, { S, now: NOW, today: '2026-09-10',
    callWall: 722, putWall: 710, flip: fullFlip(chain, S, NOW), frontExpiry: '2026-09-10', frontShare: 40 });
  ok('there is something to check', d.lines.length >= 2);
  for (const l of d.lines) ok(`observational: "${l.replace(/\*/g, '').slice(0, 40)}"`, assertObservational(l).ok);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
