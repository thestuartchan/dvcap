// Regression tests for lib/sizing.js — position-aware sizing for spot / swing / long holds.
import { sizeSuggestion, regimeMultiplier, riskAtStop, REGIME_SIZING, CREDIT_DANGER_CAP } from '../lib/sizing.js';
let pass=0,fail=0;
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
eq('risk: per-share risk', risk.perShareRisk, 10);
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

// ── risk at stop ──
eq('risk at stop', riskAtStop({qty:100, price:100, stop:90}), 1000);
eq('risk at stop needs all three', riskAtStop({qty:100, price:100}), null);

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
