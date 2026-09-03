// test/quotes.test.mjs — the FX sign convention, which is the one place this panel can say the
// same thing twice with opposite signs.
import { usdLeg, fxDivergence } from '../lib/quotes.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}`); } };
const eq = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}  got ${g} want ${w}`); } };

// ── THE SCREEN THAT PROMPTED THIS ───────────────────────────────────────────
// 2026-09-03: EUR/USD +0.09%, USD/JPY −2.03%, USD/KRW −1.08%, DXY −0.27%. Every one of them means
// a weaker dollar, and only one of them carries a plus sign.
const LEGS = [
  { sym: 'EURUSD=X', name: 'EUR/USD', changePct: 0.09 },
  { sym: 'JPY=X', name: 'USD/JPY', changePct: -2.03 },
  { sym: 'KRW=X', name: 'USD/KRW', changePct: -1.08 },
];
{
  const legs = LEGS.map(usdLeg);
  ok('all three legs report the same dollar direction', legs.every(l => l.dir === 'weaker'));
  ok('even though the quoted signs disagree', new Set(LEGS.map(r => Math.sign(r.changePct))).size === 2);
  eq('the euro leg is inverted', legs[0].pct, -0.09);
  eq('and marked as such, so the tooltip can explain why', legs[0].inverted, true);
  eq('the yen leg is not', legs[1].pct, -2.03);
  eq('nor the won', legs[2].inverted, false);

  // THE POINT OF THE WHOLE CHANGE: the card must now agree with the note above it.
  const note = fxDivergence(LEGS).note;
  ok('the note says USD −0.09% vs EUR', note.includes('USD -0.09% vs EUR') || note.includes('USD −0.09% vs EUR'));
  ok('and so does the card', legs[0].label === 'USD -0.09% vs EUR');
  ok('the note reads the legs as agreeing', note.startsWith('DXY representative'));
}

// ── WHAT MUST NOT BE TOUCHED ────────────────────────────────────────────────
{
  // The quoted percentage is what every other source shows. Inverting it would make this panel
  // the odd one out, so usdLeg is strictly additive and never rewrites the row.
  const row = { sym: 'EURUSD=X', name: 'EUR/USD', changePct: 0.09 };
  const before = JSON.stringify(row);
  usdLeg(row);
  eq('usdLeg does not mutate the row it is given', JSON.stringify(row), before);
}

// ── ONLY FX LEGS GET ONE ────────────────────────────────────────────────────
{
  eq('DXY is the dollar already, not a leg of it', usdLeg({ sym: 'DX-Y.NYB', changePct: -0.27 }), null);
  eq('an equity is not an FX leg', usdLeg({ sym: 'TLT', changePct: 0.1 }), null);
  eq('nor is a vol index', usdLeg({ sym: '^VIX', changePct: 0.07 }), null);
  eq('no change, no reading', usdLeg({ sym: 'JPY=X', changePct: null }), null);
  eq('nor a non-numeric one', usdLeg({ sym: 'JPY=X', changePct: 'x' }), null);
  eq('an empty row does not throw', usdLeg(null), null);
}

// ── SIGNS AND EDGES ─────────────────────────────────────────────────────────
{
  eq('a stronger dollar vs the euro means EUR/USD fell', usdLeg({ sym: 'EURUSD=X', changePct: -0.50 }).dir, 'stronger');
  eq('and vs the yen it means USD/JPY rose', usdLeg({ sym: 'JPY=X', changePct: 0.50 }).dir, 'stronger');
  // A rounding hair is noise, not a direction — and −0.00% would otherwise print as a move.
  eq('a hair is flat, not weaker', usdLeg({ sym: 'JPY=X', changePct: 0.001 }).dir, 'flat');
  eq('and reads as zero rather than a signed nothing', usdLeg({ sym: 'JPY=X', changePct: 0.001 }).pct, 0);
  // Inverting must not turn a legitimate zero into a negative zero in the label.
  ok('no negative zero in the label', !usdLeg({ sym: 'EURUSD=X', changePct: 0 }).label.includes('-0.00'));
  // The two conventions are exact mirrors: same magnitude, opposite sign, for the same event.
  const eurLeg = usdLeg({ sym: 'EURUSD=X', changePct: 1.25 });
  eq('inversion is exact, not approximate', eurLeg.pct, -1.25);
}

// ── DIVERGENCE STILL WORKS OFF THE SAME CONVENTION ──────────────────────────
{
  // Dollar stronger vs EUR (EUR/USD down) but weaker vs JPY (USD/JPY down) — the case DXY hides.
  const rows = [{ sym: 'EURUSD=X', changePct: -0.40 }, { sym: 'JPY=X', changePct: -0.60 }];
  const d = fxDivergence(rows);
  eq('diverging legs are flagged', d.diverging, true);
  eq('and usdLeg agrees with it on the euro', usdLeg(rows[0]).pct, d.usdVsEur);
  eq('and on the yen', usdLeg(rows[1]).pct, d.usdVsJpy);
  eq('a missing leg is not assessed', fxDivergence([]).available, false);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
