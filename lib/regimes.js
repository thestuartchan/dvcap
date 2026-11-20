// lib/regimes.js — the four macro regimes.
//
// Pure data + the derived colour/label decoration. Extracted from App.jsx so both the dashboard
// and the Console (which labels a position's regime fit and stamps sizing multipliers) read one
// definition rather than each carrying a copy.
import { C, P } from './tokens.js';
import { REGIME_NAMES } from './regimeNames.js';

// The four regimes are an IDENTITY palette, not a status palette. They are mutually exclusive
// scenarios and none is "worse" than another — Deflation is the most damaging
// outcome yet renders calm blue, which is correct, because the colour says WHICH scenario, not
// HOW BAD. That distinction is why these must never be expressed as STATUS tokens: doing so
// would paint 55% Stagflation amber and 20% Deflation blue, implying stagflation
// is the more severe read. The hues sit deliberately clear of lib/status.js so the two
// vocabularies cannot collide again (check-status-tokens.mjs exempts category palettes by
// design — see its scope note).
export const REGIME_PALETTE = Object.freeze({
  stag: { color: P.amber700, bg: P.yellow50, bdr: P.amber200 },  // amber
  ref:  { color: P.green700, bg: P.emerald50, bdr: P.emerald300 },  // green
  def:  { color: C.blue, bg: C.blBg, bdr: C.blBdr },  // blue
  inf:  { color: P.violet600, bg: P.violet50, bdr: P.violet300 },  // purple
});

export const REGIMES = [
  {
    id:"stag",label:REGIME_NAMES.stag.label,prob:45,
    desc:"High inflation + slowing growth. Iran war oil shock, tariffs embedding in CPI, Fed trapped.",
    best:["Gold / Physical (GLD)","Consumer Staples (XLP, PG, KO)","Energy Pipelines (EPD, ET)","Farmland","Short-duration T-bills"],
    worst:["Long-Duration Bonds (TLT)","Growth / high-multiple tech","Unprofitable tech"],
    trigger:"Supply shock resolves → Goldilocks  OR  demand destruction → Deflation",
  },
  {
    id:"ref",label:REGIME_NAMES.ref.label,prob:30,
    desc:"Gulf peace deal → oil falls. Fed resumes cutting. AI capex starts generating productivity gains.",
    best:["Broad equities (SPY, QQQ)","AI infrastructure (NVDA, AVGO)","REITs","Emerging markets"],
    worst:["Gold (risk-on removes safe haven bid)","Short-duration T-bills (yield falls)","Defensive staples"],
    trigger:"Weak productivity + fiscal deterioration → back to Stagflation  OR  credit excess → Reflation",
  },
  {
    id:"def",label:REGIME_NAMES.def.label,prob:20,
    desc:"Demand destruction wins. HY credit spreads blow out >6%. Unemployment surges >5.5%.",
    best:["Long Treasuries (TLT, ZROZ)","Cash (BIL, SGOV)","Gold (safe haven)","Consumer Staples"],
    worst:["Commodities (demand collapses)","Energy","Emerging markets","High-yield credit"],
    trigger:"Massive fiscal stimulus + QE → recovery into Goldilocks or Reflation (standard post-recession)",
  },
  {
    id:"inf",label:REGIME_NAMES.inf.label,prob:5,
    desc:"Dalio scenario: AI productivity surprise + fiscal dominance + dollar structural decline → persistent inflation >4%.",
    best:["Commodities","Energy stocks","Gold Miners","Bitcoin","EM commodity exporters"],
    worst:["Long bonds","Cash (real yields negative)","Defensive staples"],
    trigger:"Debt unsustainability → fiscal crisis → hyperinflation or forced deflation",
  },
].map(r => {
  const pal = REGIME_PALETTE[r.id];
  // Fail loudly at load rather than rendering `border: "4px solid undefined"` — the exact
  // silent failure that blanked these cards and the stacked bar beneath them.
  if (!pal) throw new Error(`REGIME_PALETTE is missing an entry for regime "${r.id}"`);
  return { ...r, ...pal };
});
