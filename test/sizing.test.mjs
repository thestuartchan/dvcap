// Regression tests for lib/sizing.js — position-aware sizing for spot / swing / long holds.
import { sizeSuggestion, regimeMultiplier, riskAtStop, roundQty, equityFreshness, EQUITY_STALE_DAYS, REGIME_SIZING, CREDIT_DANGER_CAP } from '../lib/sizing.js';
let pass=0,fail=0;
const ok=(n,c)=>eq(n,!!c,true);
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};

// ── regime multiplier ──
eq('ref full size',        regimeMultiplier({regimeId:'ref'}).mult, 1);
eq('stag scales down',     regimeMultiplier({regimeId:'stag'}).mult, 0.6);
eq('credit danger caps',   regimeMultiplier({regimeId:'ref',creditDanger:true}).mult, CREDIT_DANGER_CAP);
eq('contested haircut',    regimeMultiplier({regimeId:'ref',contested:true}).mult, 0.7);
eq('def + pinned',         regimeMultiplier({regimeId:'def',pinnedDiverged:true}).mult, 0.28);
eq('unknown regime is conservative', regimeMultiplier({regimeId:'zzz'}).mult, 0.6);

// ── RISK mode: equity 100k, 1% risk, ref regime (x1), price 100, stop 90 -> $1000 / $10 = 100 ──
const risk = sizeSuggestion({mode:'risk', equityInPos:100000, price:100, stop:90, baseRiskPct:1, regime:{regimeId:'ref'}});
eq('risk: full size', risk.fullQty, 100);
eq('risk: amount risked', risk.riskAmount, 1000);
eq('risk: point distance', risk.pointRisk, 10);
eq('risk: cost of that distance on one unit', risk.perUnitRisk, 10);   // ×1, so the two agree
eq('risk: what the size actually risks', risk.riskAtSize, 1000);
eq('risk: notional', risk.notional, 10000);
eq('risk: % of book', risk.notionalPctOfBook, 10);

// regime scales it: stagflation x0.6 -> 60 shares
eq('risk: stag scales size', sizeSuggestion({mode:'risk', equityInPos:100000, price:100, stop:90, baseRiskPct:1, regime:{regimeId:'stag'}}).fullQty, 60);

// ── risk mode is UNDEFINED without a stop — it must say so, not invent one ──
const noStop = sizeSuggestion({mode:'risk', equityInPos:100000, price:100, regime:{regimeId:'ref'}});
eq('risk without stop: not ok', noStop.ok, false);
eq('risk without stop: explains + offers allocation', /needs a stop level.*allocation/.test(noStop.why), true);
eq('stop equal to price rejected', sizeSuggestion({mode:'risk', equityInPos:100000, price:100, stop:100, regime:{regimeId:'ref'}}).ok, false);

// ── ALLOCATION mode: for a long hold with no stop. 5% of 100k at $50 = 100 shares ──
const alloc = sizeSuggestion({mode:'allocation', equityInPos:100000, price:50, targetPct:5, regime:{regimeId:'ref'}});
eq('allocation: full size', alloc.fullQty, 100);
eq('allocation: needs no stop', alloc.ok, true);
eq('allocation: no risk amount', alloc.riskAmount, null);

// ── POSITION AWARENESS: the point of the rewrite ──
const scaled = sizeSuggestion({mode:'risk', equityInPos:100000, price:100, stop:90, baseRiskPct:1, regime:{regimeId:'ref'}, heldQty:40});
eq('held is reported', scaled.heldQty, 40);
eq('room is net of holding', scaled.roomQty, 60);
eq('full size unchanged', scaled.fullQty, 100);

const full = sizeSuggestion({mode:'risk', equityInPos:100000, price:100, stop:90, baseRiskPct:1, regime:{regimeId:'ref'}, heldQty:120});
eq('over full size: no room', full.roomQty, 0);
eq('over full size: warns', /already at or above full size/.test(full.warnings[0]), true);

// ── tranches: scaling in ──
const tr = sizeSuggestion({mode:'risk', equityInPos:100000, price:100, stop:90, baseRiskPct:1, regime:{regimeId:'ref'}, tranches:3});
eq('tranche size', tr.trancheQty, 33);
eq('tranche count', tr.tranches, 3);
const trHeld = sizeSuggestion({mode:'risk', equityInPos:100000, price:100, stop:90, baseRiskPct:1, regime:{regimeId:'ref'}, heldQty:40, tranches:3});
eq('tranches split the ROOM, not the full size', trHeld.trancheQty, 20);

// ── missing inputs are explained, never guessed ──
eq('no equity -> explains', /account equity/.test(sizeSuggestion({mode:'risk', price:100, stop:90}).why), true);
eq('no price -> explains',  /no live price/.test(sizeSuggestion({mode:'risk', equityInPos:100000, stop:90}).why), true);
eq('tiny budget warns',     sizeSuggestion({mode:'allocation', equityInPos:100, price:5000, targetPct:1, regime:{regimeId:'ref'}}).warnings.length > 0, true);

// ── equity is APPROXIMATE, so sizes are rounded rather than implying false precision ──
eq('small sizes keep every share', roundQty(7), 7);
eq('tens round to 5',              roundQty(43), 40);
eq('hundreds round to 10',         roundQty(137), 130);
eq('thousands round to 25',        roundQty(1058), 1050);
eq('ten-thousands round to 100',   roundQty(12345), 12300);
eq('zero stays zero',              roundQty(0), 0);
eq('junk is zero',                 roundQty(NaN), 0);

const rounded = sizeSuggestion({mode:'risk', equityInPos:208597, price:100, stop:90, baseRiskPct:1, regime:{regimeId:'stag'}});
eq('suggestion is rounded',   rounded.fullQty, 120);
eq('exact is still reported', rounded.fullExact, 125);
eq('rounding is flagged',     rounded.rounded, true);
// The question a moving account balance actually raises: how much would being wrong cost me?
eq('sensitivity to equity',   rounded.perTenPctEquity, 12);

// ── equity freshness: generous, because sizing is linear in equity ──
eq('same day is fresh',   equityFreshness('2026-08-26','2026-08-26').stale, false);
eq('a week is fine',      equityFreshness('2026-08-19','2026-08-26').stale, false);
eq('past threshold flags', equityFreshness('2026-08-01','2026-08-26').stale, true);
eq('days counted',        equityFreshness('2026-08-01','2026-08-26').days, 25);
eq('no date -> explains', /no date recorded/.test(equityFreshness(null).note), true);
eq('threshold is generous', EQUITY_STALE_DAYS >= 7, true);

// ── risk at stop ──
eq('risk at stop', riskAtStop({qty:100, price:100, stop:90}), 1000);
eq('risk at stop needs all three', riskAtStop({qty:100, price:100}), null);
// A contract is not a share here either — this is the function the console displays the headline
// risk from, so leaving the multiplier out of it reintroduces the bug one line further on.
eq('risk at stop scales by the multiplier', riskAtStop({qty:1, price:4649.70, stop:4435, multiplier:10}), 2147);
eq('a missing multiplier is one, not zero', riskAtStop({qty:1, price:100, stop:90, multiplier:null}), 10);

// ── THE CONTRACT MULTIPLIER ──────────────────────────────────────────────────
// One MGC is ten ounces of gold. Sized as though it were one ounce, the divisor is ten times too
// small and the position comes out ten times too large — in the direction that loses money.
{
  const eqty = 208597, px = 4649.70, stp = 4435;   // the live book, MGC Dec at its GTC stop
  const asShares = sizeSuggestion({mode:'risk', equityInPos:eqty, price:px, stop:stp, baseRiskPct:1, regime:{regimeId:'stag'}});
  const asContracts = sizeSuggestion({mode:'risk', equityInPos:eqty, price:px, stop:stp, multiplier:10, baseRiskPct:1, regime:{regimeId:'stag'}});
  eq('the point distance is the same either way', [asShares.pointRisk, asContracts.pointRisk], [214.7, 214.7]);
  eq('but one contract risks ten times one point', asContracts.perUnitRisk, 2147);
  eq('so the old answer was five contracts', asShares.fullQty, 5);
  eq('and the right answer is none', asContracts.fullQty, 0);
  // Five contracts would have risked 5 × $2,147 = $10,735 against a $1,251 budget — 8.6× over.
  eq('the size that was suggested risks this much', riskAtStop({qty:asShares.fullQty, price:px, stop:stp, multiplier:10}), 10735);
  ok('which is many times the budget', 10735 > asContracts.riskAmount * 8);
}
// MNQ ×2: the same arithmetic where the answer is not zero.
{
  const mnq = sizeSuggestion({mode:'risk', equityInPos:208597, price:29533, stop:29044, multiplier:2, baseRiskPct:1, regime:{regimeId:'stag'}});
  eq('MNQ point distance', mnq.pointRisk, 489);
  eq('doubled per contract', mnq.perUnitRisk, 978);
  eq('one contract fits the budget', mnq.fullQty, 1);
  eq('and it risks what one contract risks', mnq.riskAtSize, 978);
  eq('notional is what the contract controls', mnq.notional, +(29533 * 2).toFixed(2));
}
// THE MINIMUM TRADEABLE UNIT, when it is larger than the model's answer. Not an edge case on an
// account this size — it is the common case for gold.
{
  const sub = sizeSuggestion({mode:'risk', equityInPos:208597, price:4649.70, stop:4435, multiplier:10, baseRiskPct:1, regime:{regimeId:'stag'}});
  eq('it rounds to nothing', sub.fullQty, 0);
  ok('and says why, in the position that would be taken', /one contract is the minimum/.test(sub.warnings[0]));
  ok('naming both percentages', /1\.03% of equity against a 0\.6% budget/.test(sub.warnings[0]));
  ok('and what is actually setting the size', /contract size is setting this position/.test(sub.warnings[0]));
  // The generic "rounds to zero" message is replaced, not stacked on top of it.
  ok('one message, not two', sub.warnings.filter(w => /rounds to zero/.test(w)).length === 0);
}
// ALLOCATION mode needs the multiplier too — one contract costs price × multiplier to control.
{
  const alloc10 = sizeSuggestion({mode:'allocation', equityInPos:1000000, price:4649.70, multiplier:10, targetPct:5, regime:{regimeId:'ref'}});
  eq('one unit costs price times the multiplier', alloc10.unitCost, 46497);
  eq('so 5% of a million buys one, not ten', alloc10.fullQty, 1);
  eq('and the notional is what it controls', alloc10.notional, 46497);
}
// THE DISPLAYED RISK IS THE ROUNDED SIZE'S RISK, not the budget it was derived from. This is the
// assertion that pins the bug: they used to be the same field.
{
  const r = sizeSuggestion({mode:'risk', equityInPos:208597, price:100, stop:90, baseRiskPct:1, regime:{regimeId:'stag'}});
  eq('rounded down from the exact answer', [r.fullExact, r.fullQty], [125, 120]);
  eq('risk follows the quantity', r.riskAtSize, +(r.fullQty * r.perUnitRisk).toFixed(2));
  ok('which is not the budget', r.riskAtSize !== r.riskAmount);
  ok('and is lower, because the size rounded down', r.riskAtSize < r.riskAmount);
  eq('stated as a share of equity too', r.riskAtSizePct, +((1200 / 208597) * 100).toFixed(3));
}
// Rounding: contracts are whole units, shares keep their magnitude buckets.
eq('contracts round to whole units', roundQty(43, 10), 43);
eq('shares still bucket', roundQty(43, 1), 40);
eq('and a contract below one is none', roundQty(0.4, 10), 0);

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
