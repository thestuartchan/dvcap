// lib/regimes.js — the four macro regimes.
//
// Pure data + the derived colour/label decoration. Extracted from App.jsx so both the dashboard
// and the Console (which labels a position's regime fit and stamps sizing multipliers) read one
// definition rather than each carrying a copy.

// The four regimes are an IDENTITY palette, not a status palette. They are mutually exclusive
// scenarios and none is "worse" than another — Deflationary Recession is the most damaging
// outcome yet renders calm blue, which is correct, because the colour says WHICH scenario, not
// HOW BAD. That distinction is why these must never be expressed as STATUS tokens: doing so
// would paint 55% Stagflation amber and 20% Deflationary Recession blue, implying stagflation
// is the more severe read. The hues sit deliberately clear of lib/status.js so the two
// vocabularies cannot collide again (check-status-tokens.mjs exempts category palettes by
// design — see its scope note).
export const REGIME_PALETTE = Object.freeze({
  stag: { color: "#B45309", bg: "#FEFCE8", bdr: "#FDE68A" },  // amber
  ref:  { color: "#15803D", bg: "#ECFDF5", bdr: "#6EE7B7" },  // green
  def:  { color: "#1E40AF", bg: "#EFF6FF", bdr: "#BFDBFE" },  // blue
  inf:  { color: "#7C3AED", bg: "#F5F3FF", bdr: "#C4B5FD" },  // purple
});

export const REGIMES = [
  {
    id:"stag",label:"Stagflation",prob:45,
    desc:"High inflation + slowing growth. Iran war oil shock, tariffs embedding in CPI, Fed trapped.",
    best:["Gold / Physical (GLD)","Consumer Staples (XLP, PG, KO)","Energy Pipelines (EPD, ET)","Farmland","Short-duration T-bills"],
    worst:["Long-Duration Bonds (TLT)","Growth / high-multiple tech","Unprofitable tech"],
    trigger:"Supply shock resolves → reflationary growth  OR  demand destruction → deflationary recession",
  },
  {
    id:"ref",label:"Reflationary Growth",prob:30,
    desc:"Gulf peace deal → oil falls. Fed resumes cutting. AI capex starts generating productivity gains.",
    best:["Broad equities (SPY, QQQ)","AI infrastructure (NVDA, AVGO)","REITs","Emerging markets"],
    worst:["Gold (risk-on removes safe haven bid)","Short-duration T-bills (yield falls)","Defensive staples"],
    trigger:"Weak productivity + fiscal deterioration → back to stagflation  OR  credit excess → inflationary boom",
  },
  {
    id:"def",label:"Deflationary Recession",prob:20,
    desc:"Demand destruction wins. HY credit spreads blow out >6%. Unemployment surges >5.5%.",
    best:["Long Treasuries (TLT, ZROZ)","Cash (BIL, SGOV)","Gold (safe haven)","Consumer Staples"],
    worst:["Commodities (demand collapses)","Energy","Emerging markets","High-yield credit"],
    trigger:"Massive fiscal stimulus + QE → reflationary recovery (standard post-recession)",
  },
  {
    id:"inf",label:"Inflationary Boom",prob:5,
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
