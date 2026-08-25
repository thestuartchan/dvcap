import { useState, useEffect, useCallback, useMemo, Component, Fragment } from "react";
import {
  AreaChart, Area, BarChart, Bar, RadarChart, PolarGrid,
  PolarAngleAxis, Radar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea, LabelList,
} from "recharts";
import { kofiaStale, parseKofia, kofiaDisplay, kofiaStoredLine, KOFIA_NAME_BY_KEY, KOFIA_CURRENCY, KOFIA_FLOWS, toWonTrillions, koreaFlowRead, koreaFlowImplication, withCommas } from "../lib/kofia.js";
import { freshnessText, humanizeAge } from "../lib/sessions.js";
import { interventionAnnotation } from "../lib/fx.js";
import { unInversionPhase, yieldCurveStatus, NORMAL_SPREAD } from "../lib/yieldcurve.js";
import { pendingReconciliations, reconStats } from "../lib/recon.js";
import { deriveRegimeProbabilities, CONTESTED_GAP } from "../lib/regimeProb.js";
import { minersPairImplication } from "../lib/regimeState.js";
import { southboundTrend, southboundLevelTrend, southboundRead, ahPremiumRead, sbStale } from "../lib/southbound.js";
import { STATUS, creditStatus, deriveAction, headerSignal, STAGES } from "../lib/status.js";
import { HORIZON, HORIZON_LABEL, horizonOf, consensusFor, calendarWindow, dispersionRead, sourceScore, lastRevision, blockOf, BLOCK_LABEL, NO_CONVERSION_NOTE } from "../lib/recession.js";
import { buildViews, evaluateViews, regimeCluster, divergenceRead } from "../lib/analystViews.js";
import { REGIME_SIZING, rMultiple, positionSize, regimeMultiplier, suggestedSize, distanceToLevels, triggeredLevels, tradeSide, DEFAULT_BASE_RISK_PCT } from "../lib/console.js";
import { observationAge } from "../lib/gates.js";
import { trend as trendOf } from "../lib/series.js";

// Change over N sessions, in basis points, from a dated FRED series. Returns null rather than
// approximating when the series does not reach back far enough.
function trendBps(series, lookbackDays) {
  const t = trendOf(series, { lookbackDays });
  return t ? Math.round(t.delta * 100) : null;
}
import { laborStress, sahmAnnotation, laborVerdict, laborSummary, laborDeteriorationTrigger, primeAgeRead, longTermRead, u6SpreadRead, payrollsRead, surveyDivergenceRead, quitsRead, revisionTrackerRead, twelveMonthAvgRead, ytdDivergenceRead } from "../lib/labor.js";
import { handoffChain } from "../lib/handoff.js";
import { SEC_YIELDS, PROXY, secYieldProxy, proxyDivergence, apyFromSec, afterWht, compareCash } from "../lib/cashyield.js";

// ─── TOKENS ──────────────────────────────────────────────────────────────────
const C = {
  bg:"#F2F3F7", surf:"#FFFFFF", bdr:"#E4E7F0", bdrMd:"#C9D0E4",
  text:"#1C1F2E", mid:"#4B5068", muted:"#7C82A0", lbl:"#9CA3C0",
  green:"#166534", gBg:"#F0FDF4", gBdr:"#86EFAC",
  amber:"#92400E", aBg:"#FFFBEB", aBdr:"#FCD34D",
  red:"#991B1B",   rBg:"#FEF2F2", rBdr:"#FCA5A5",
  blue:"#1E40AF",  blBg:"#EFF6FF", blBdr:"#BFDBFE",
};
const SC = ["#1E40AF","#166534","#D97706","#6D28D9","#B45309","#BE185D","#0F766E","#F59E0B"];

// ─── CHART DATA ───────────────────────────────────────────────────────────────
const YIELD_DATA = [
  {d:"Jan'22",v:0.78},{d:"Apr'22",v:0.21},{d:"Jul'22",v:-0.14},{d:"Oct'22",v:-0.40},
  {d:"Jan'23",v:-0.68},{d:"Jul'23",v:-0.93},{d:"Jan'24",v:-0.26},{d:"Jul'24",v:-0.25},
  {d:"Jan'25",v:0.36},{d:"Apr'25",v:0.50},{d:"Dec'25",v:0.48},{d:"Jun'26",v:0.38},
];
const UNEMP_DATA = [
  {d:"Jan'22",v:4.0},{d:"Jul'22",v:3.5},{d:"Jan'23",v:3.4},{d:"Jul'23",v:3.5},
  {d:"Jan'24",v:3.7},{d:"Jul'24",v:4.3},{d:"Jan'25",v:4.0},{d:"Apr'25",v:4.2},
  {d:"Dec'25",v:4.2},{d:"Jun'26",v:4.4},
];
const CREDIT_DATA = [
  {d:"Jan'22",v:3.1},{d:"Jul'22",v:5.6},{d:"Jan'23",v:4.8},{d:"Jul'23",v:4.0},
  {d:"Jan'24",v:3.5},{d:"Jul'24",v:3.2},{d:"Jan'25",v:2.9},{d:"Apr'25",v:3.4},
  {d:"Dec'25",v:2.8},{d:"Jun'26",v:2.75},
];

// ─── INDICATORS ───────────────────────────────────────────────────────────────
const INDICATORS = [
  {
    id:"yield", name:"Yield Curve (10Y – 2Y)", current:"+0.38%",
    status:"AMBER", label:"Watch", color:"#92400E", areaColor:"#F59E0B",
    dataKey:"yieldHistory", data:YIELD_DATA, refLine:0, yDomain:[-1.2,1.0],
    yFmt: v=>`${v>=0?"+":""}${v.toFixed(2)}%`,
    // The un-inversion narrative is DATE arithmetic, so it is computed from the history
    // (second arg) rather than stated. Falls back to a level-only sentence when the history
    // is absent, instead of asserting a window it cannot locate.
    detail: (v, hist) => {
      const ph = unInversionPhase(hist || []);
      const head = `Currently ${v >= 0 ? "+" : ""}${v.toFixed(2)}% after the longest inversion in modern history. `;
      const tail = ` A fully normal curve is above +${NORMAL_SPREAD.toFixed(1)}%.`;
      return head + ph.note + tail;
    },
    thresholds:[
      {val:-0.5, label:"Deep inversion", color:"#DC2626", dash:"4 2"},
      {val:0,    label:"Inversion line",  color:"#D97706", dash:"5 3"},
      {val:1.0,  label:"Normal",          color:"#16A34A", dash:"4 2"},
    ],
    // Returns independent assessment based on this indicator's own live value
    signal(liveVal, hist) {
      const v = liveVal ?? 0.38;
      if (v < -0.5) return { label: "Deep Inversion", text: "Severe inversion — historically the strongest recession predictor. Average lead time: 12–18 months.", state: "DANGER" };
      if (v < 0)    return { label: "Inverted", text: "Curve still inverted — markets pricing Fed cuts ahead of deteriorating growth.", state: "DANGER" };
      // Positive but not yet normal. WHICH reading this is depends on how long ago the curve
      // un-inverted, not on the level — inside the window and past it are opposite calls, and
      // the old level-only test could not tell them apart.
      const ph = unInversionPhase(hist || []);
      const st = yieldCurveStatus(v, ph);
      if (v < NORMAL_SPREAD) return { label: st.label, text: ph.note, state: st.state };
      return { label: "Normal", text: `Curve fully normalized (above +${NORMAL_SPREAD.toFixed(1)}%). ` + ph.note, state: "BENIGN" };
    },
  },
  {
    id:"unemp", name:"Unemployment Rate", current:"4.4%",
    status:"AMBER", label:"↑ since '23 low", color:"#92400E", areaColor:"#F59E0B",
    dataKey:"unempHistory", data:UNEMP_DATA, refLine:4.0, yDomain:[3.0,5.5],
    yFmt: v=>`${v.toFixed(1)}%`,
    detail: (v) => `Currently ${v.toFixed(1)}% — rose from a 3.4% trough (Jan 2023), a ${(v - 3.4).toFixed(1)}pp rise. Sahm Rule triggers at 0.5pp above the 12-month low. ${v >= 4.5 ? "The Sahm Rule has triggered — recession risk is elevated." : v >= 4.0 ? "We are approaching the Sahm Rule threshold. Direction is the concern." : "Still below the Sahm Rule trigger zone."}`,
    thresholds:[
      {val:3.5, label:"Pre-pandemic low",   color:"#16A34A", dash:"4 2"},
      {val:4.0, label:"Historical avg",     color:"#D97706", dash:"5 3"},
      {val:4.5, label:"Sahm Rule zone",     color:"#DC2626", dash:"4 2"},
      {val:5.0, label:"Recession confirmed",color:"#7F1D1D", dash:"3 2"},
    ],
    signal(liveVal) {
      const v = liveVal ?? 4.4;
      if (v >= 5.5)  return { label:"Recession Confirmed",  text:"Unemployment above 5.5% — recession is underway by historical standards. Capital preservation is the priority.", state:"DANGER" };
      if (v >= 5.0)  return { label:"Recession Zone",       text:"Crossed 5.0% — recession historically confirmed at this level. Defensive positioning warranted.",              state:"DANGER" };
      if (v >= 4.5)  return { label:"Sahm Rule Triggered",  text:"At or above the Sahm Rule threshold. Labour market deteriorating — leading indicator for recession.",           state:"WATCH" };
      if (v >= 4.0)  return { label:"Elevated vs '23 low",  text:"Above the 4.0% historical average and well up from the 3.4% '23 trough — but that's the trend-since-low read; check the last-vs-prior print for near-term direction.", state:"ELEVATED" };
      return           { label:"Healthy",                   text:"Below historical average. Labour market resilient — low near-term recession risk from this indicator.",         state:"BENIGN" };
    },
  },
  {
    id:"credit", name:"HY Credit Spreads (ICE BofA OAS)", current:"2.75%",
    status:"GREEN", label:"Benign", color:"#166534", areaColor:"#22C55E",
    dataKey:"creditHistory", data:CREDIT_DATA, refLine:4.5, yDomain:[1.5,7.0],
    yFmt: v=>`${v.toFixed(2)}%`,
    detail: (v) => `At ${v.toFixed(2)}%, markets are ${v < 3.0 ? "NOT pricing stress — calm conditions prevail" : v < 4.5 ? "beginning to price some stress — watch closely" : "pricing significant stress — act defensively"}. This is your best leading indicator. GFC peak: 21.8%. COVID peak: 10.9%. ${v >= 4.5 ? "⚠️ Alert threshold breached." : "Alert threshold: 4.5%."}`,
    thresholds:[
      {val:3.0, label:"Mild stress",         color:"#D97706", dash:"4 2"},
      {val:4.5, label:"⚠ Alert threshold",   color:"#F97316", dash:"5 3"},
      {val:6.0, label:"🔴 Recession likely", color:"#DC2626", dash:"4 2"},
    ],
    signal(liveVal) {
      const v = liveVal ?? 2.75;
      if (v >= 6.0)  return { label:"Recession Imminent",  text:"Spreads above 6% — markets pricing systemic stress. This is the deflationary trip wire. Rotate to Treasuries and cash immediately.", state:"DANGER" };
      if (v >= 4.5)  return { label:"Alert — Act Now",     text:"Breached the 4.5% alert threshold. Insurance accumulation phase is over — full defensive rotation warranted.",                      state:"DANGER" };
      if (v >= 3.5)  return { label:"Widening — Watch",    text:"Spreads widening toward the alert zone. Begin building insurance positions. Don't wait for 4.5% to confirm.",                       state:"WATCH" };
      if (v >= 3.0)  return { label:"Mild Stress",         text:"Mild stress appearing. Markets slightly nervous but not panicking. Monitor weekly.",                                                  state:"ELEVATED" };
      return           { label:"Benign — No Stress",       text:"Markets are calm. No credit stress priced. This is the window to accumulate insurance cheaply before spreads move.",                 state:"BENIGN" };
    },
  },
];

// ─── INSURANCE ASSETS ─────────────────────────────────────────────────────────
// The best→worst bar ranks these six by macro regime (stagRank/defRank/refRank/infRank). Cross-tab
// consistency with the SCENARIO_MATRIX, audited Aug-20:
//   • stag ↔ matrix `stag` column, def ↔ matrix `def` column — DIRECT maps. The bar order follows the
//     matrix glyphs (✅✅>✅>⚠️>❌), ties broken by 2022 evidence. stag: gold>staples>miners>farmland>btc>tlt.
//     def: tbonds>gold>staples>miners>farmland>btc.
//   • inf = Inflationary BOOM — explicitly NOT the matrix `inf` (=Debasement crisis) column, so ranked by
//     regime logic: gold>btc>miners>farmland>staples>tbonds (real assets win, miners cap below physical
//     gold per B1, the leveraged farmland REIT lags the metals, bonds toxic).
//   • ref = Reflationary Growth — a benign regime with no matrix column. Miners lag BY DESIGN (the gold
//     safe-haven bid fades), so here alone farmland outranks miners; staples/farmland lead.
// Invariant: the farmland REIT sits BELOW the gold-linked miners in every regime except reflationary
// growth (2022: GDX −9% vs FPI −14%), and miners NEVER outrank physical gold anywhere.
const ASSETS = [
  {
    // Aug-20 Part B — Physical Gold is its own asset, distinct from miners (which only ever
    // EXPRESS a gold view, with equity beta). The primary real-asset hold; ranks above miners in
    // every regime. Matches the SCENARIO_MATRIX, which already separates GLD from GDX.
    id:"gold", name:"Physical Gold", icon:"🥇", color:"#B45309", bg:"#FFFBEB", bdr:"#FDE68A",
    stagRank:1, defRank:2, refRank:4, infRank:1, volatility:"MED",
    stagNote:"The classic stagflation hedge — monetary, no growth dependency (1970s: $35 → ~$850). The primary real-asset hold; miners are only a cautioned, leveraged expression of it.",
    crisisScore:80, inflationScore:88, deflationScore:60, liquidityScore:55, stagScore:90,
    verdict:"THE debasement + stagflation hedge. Held value where miners collapsed (2008). SOLD in a liquidity dash-for-cash (−12% over 8 sessions, Mar 2020), then rips. Sits above miners in every regime.",
    tickers:[
      {t:"GLD",     name:"SPDR Gold Trust",       type:"ETF", note:"Largest, most liquid. 0.40% fee."},
      {t:"IAU",     name:"iShares Gold Trust",    type:"ETF", note:"Lower fee (0.25%). Same physical exposure."},
      {t:"SGOL",    name:"abrdn Physical Gold",   type:"ETF", note:"Swiss-vaulted. 0.17% fee — cheapest."},
      {t:"2840.HK", name:"SPDR Gold Trust (HK)",  type:"ETF", note:"HKD-pegged, zero HK withholding tax. Use via IBKR HK account.", link:"https://www.hkex.com.hk"},
    ],
  },
  {
    id:"miners", name:"Gold Miners", icon:"⛏️", state:"WATCH",
    // P0.3 + Aug-20 B1 — miners NEVER rank above physical gold, in any regime. Evidence: GDX lagged
    // GLD ~6.5%/yr since 2006 (~−350% cumulative), worst during equity crises; ~2× the volatility,
    // asymmetric; the "2–3×" is sell-side convention (only ~1.2× realised through 2023–25). Even in a
    // pure gold bull (debasement) they merely MATCH gold while carrying equity beta. So they sit below
    // Physical Gold everywhere — including a demotion from #1 in Inflationary Boom to #4.
    stagRank:3, defRank:4, refRank:5, infRank:3, volatility:"HIGH",
    stagNote:"⚠️ Cautioned in stagflation — miners are equities with operating leverage to gold (equity beta, sold in liquidity events: GDX fell ~70% in 2008). The stagflation hedge is physical gold (GLD / 2840.HK); miners are a leveraged, cautioned expression of the view, not a hedge. Add only after a VIX peak confirms the liquidity phase has passed. Rank #3 only because they stay gold-linked (2022: GDX ~−9% vs the farmland REIT −14% and BTC −64%) — not a promotion to hedge status.",
    crisisScore:70, inflationScore:82, deflationScore:30, liquidityScore:40, stagScore:50,
    verdict:"A leveraged EXPRESSION of gold, never a substitute — it has lagged GLD ~6.5%/yr since 2006 and is worst in crises. Even in a debasement bull it only matches gold while carrying equity beta, dilution and cost inflation. Physical gold is the hedge; miners never rank above it.",
    tickers:[
      {t:"GDX",  name:"VanEck Gold Miners ETF",     type:"ETF",   note:"Best entry. $33B AUM, 57 miners. Top: AEM, NEM, ABX."},
      {t:"GDXJ", name:"VanEck Junior Gold Miners",  type:"ETF",   note:"Higher beta. More upside, more volatile."},
      {t:"RING", name:"iShares MSCI Global Gold",   type:"ETF",   note:"Lower fee (0.39%). Concentrated in top 3 miners."},
      {t:"AEM",  name:"Agnico Eagle Mines",          type:"Stock", note:"Highest quality senior miner. Strong balance sheet."},
      {t:"NEM",  name:"Newmont Corporation",         type:"Stock", note:"World's largest miner. Dividend payer."},
      {t:"ABX",  name:"Barrick Mining (fmr GOLD)",  type:"Stock", note:"#2 global miner. 5 continents."},
      {t:"WPM",  name:"Wheaton Precious Metals",    type:"Stock", note:"Streaming model — lower operating risk."},
      {t:"2840.HK", name:"SPDR Gold Trust HK",     type:"ETF",   note:"Physical gold ETF on HKEX. HKD/USD pegged = no FX drag vs GLD. Zero HK withholding tax. Use if holding via IBKR HK account.", link:"https://www.hkex.com.hk"},
    ],
    regionalNote:"Physical Gold (Dubai): 0% VAT on gold purchases in UAE. Available via Dubai Gold Souk, DMCC dealers, or Emirates NBD/ADCB gold savings accounts. No FX risk given AED/USD peg. Best local debasement hedge for UAE residents.",
  },
  {
    id:"farmland", name:"Farmland REIT", icon:"🌾", state:"BENIGN",
    // Aug-20 B4 + Recovery-brief D — ONE definition: the investable instrument (FPI / LAND) is a
    // small-cap farmland REIT, not raw farmland. So it is RATE-SENSITIVE — it trades like small-cap
    // REITs regardless of the underlying acreage. The decisive test is 2022: the unleveraged NCREIF
    // land index returned +9.64% while FPI FELL >14%. The wrapper does not deliver the land's inflation
    // hedge — so it drops below miners in stagflation (#4, not #3). NCREIF itself is not investable here.
    stagRank:4, defRank:5, refRank:3, infRank:4, volatility:"MED",
    stagNote:"The REIT is NOT the land. FPI/LAND are small-cap, leveraged, rate-sensitive REITs: in 2022 (the closest stagflation test) the unleveraged NCREIF land index returned +9.64% while FPI fell >14%. Real-value protection is capped by the wrapper — below physical gold, energy and even the gold-linked miners in a stagflation.",
    crisisScore:55, inflationScore:80, deflationScore:45, liquidityScore:55, stagScore:60,
    verdict:"A small-cap farmland REIT (FPI / LAND) — real-asset exposure diluted by REIT rate-sensitivity, leverage and small-cap beta. NOT a proxy for the land: 2022 the NCREIF index rose +9.64% while FPI fell. Extra return drivers unrelated to farmland — NAV discount (FPI 25–30%) and US-situs estate exposure. Below gold, energy and miners as a stagflation hedge; sold in a hawkish repricing.",
    tickers:[
      {t:"LAND", name:"Gladstone Land",    type:"REIT", note:"Berry & vegetable farms. ~$350M cap. Thinly traded."},
      {t:"FPI",  name:"Farmland Partners", type:"REIT", note:"Row-crop (corn, soy, wheat). Geographic diversity."},
    ],
  },
  {
    id:"tbonds", name:"Treasury Bonds", icon:"🏛️", color:"#1E40AF", bg:"#EFF6FF", bdr:"#BFDBFE",
    // Aug-20 — the best asset in a deflationary recession (#1), the worst in stagflation / hawkish
    // repricing / inflationary boom (rising yields crush duration). Re-ranked with Physical Gold added.
    stagRank:6, defRank:1, refRank:6, infRank:6, volatility:"MED",
    stagNote:"WORST stagflation asset. Inflation erodes real value; rate hikes crush price. TLT lost 30%+ in 2022.",
    crisisScore:75, inflationScore:20, deflationScore:95, liquidityScore:95, stagScore:10,
    verdict:"Works in deflation/growth-scare recessions (2008, 2020). Fails in stagflation. Know your recession type first.",
    tickers:[
      {t:"TLT",  name:"iShares 20+ Year Treasury", type:"ETF", note:"Max duration. ~16% price sensitivity per 1% rate move."},
      {t:"IEF",  name:"iShares 7-10 Year Treasury",type:"ETF", note:"Lower duration alternative to TLT. Use if uncertain about crash depth or speed of recovery. 100bps cut ≈ 7-8% NAV appreciation vs TLT's 15-18%. Less reward, less risk."},
      {t:"ZROZ", name:"PIMCO 25+ Zero Coupon",     type:"ETF", note:"Maximum duration. High conviction rate cut only."},
      {t:"BIL",  name:"SPDR 1-3 Month T-Bill",     type:"ETF", note:"Essentially cash. Yield tracks the T-bill curve — see the Income tab for the live rate."},
    ],
  },
  {
    id:"staples", name:"Consumer Staples", icon:"🛒", color:"#5B21B6", bg:"#F5F3FF", bdr:"#C4B5FD",
    // Aug-20 B2 — the best defensive EQUITY in stagflation (pricing power, non-discretionary demand),
    // but that is a narrower claim than "top hold": gold and energy are the primary hedges (2022: XLE
    // +64%, XLP ~−3%). So #2 behind Physical Gold in stagflation. Best defensive in reflationary growth.
    stagRank:2, defRank:3, refRank:1, infRank:5, volatility:"LOW",
    stagNote:"Best defensive EQUITY in stagflation — brand pricing power passes through inflation, non-discretionary demand holds. But gold and energy outrank it as the primary hedges; staples are adequate, not standout (2022: XLE +64%, XLP ~−3%).",
    crisisScore:75, inflationScore:60, deflationScore:70, liquidityScore:90, stagScore:75,
    verdict:"Most reliable defensive sector. Brands = pricing power. Non-discretionary = recession-proof demand.",
    tickers:[
      {t:"XLP",  name:"Consumer Staples SPDR",    type:"ETF",   note:"Best ETF. Top 5: PG, COST, KO, PEP, PM."},
      {t:"PG",   name:"Procter & Gamble",          type:"Stock", note:"69yr dividend streak. Dividend King."},
      {t:"KO",   name:"Coca-Cola",                 type:"Stock", note:"Berkshire #3. 2.7% yield. 100+ yr brand."},
      {t:"PEP",  name:"PepsiCo",                   type:"Stock", note:"Frito-Lay diversification. Aristocrat."},
      {t:"WMT",  name:"Walmart",                   type:"Stock", note:"Recession beneficiary — budget trade-down."},
      {t:"COST", name:"Costco",                    type:"Stock", note:"Membership = sticky revenue."},
      {t:"MDLZ", name:"Mondelez",                  type:"Stock", note:"Global snacks. 3.5% dividend."},
    ],
  },
  {
    id:"btc", name:"Bitcoin", icon:"₿", color:"#F7931A", bg:"#FFF8F0", bdr:"#F7931A",
    // Aug-20 B7 — the debasement correlation is real but YOUNG (~2yr consistent); −50% in 48h (Mar
    // 2020), −64% through 2022. Correct direction, thin evidence — so it sits below Physical Gold in
    // debasement / inflationary boom, not alongside it.
    stagRank:5, defRank:6, refRank:2, infRank:2, volatility:"VERY HIGH",
    stagNote:"Mixed in stagflation — debasement tailwind, but risk-off selloffs hit it hard (−64% through 2022, the deepest drawdown of any bar asset). Shines only once panic clears and the dollar-credibility narrative takes over. Short (~2yr) debasement track record.",
    crisisScore:40, inflationScore:85, deflationScore:20, liquidityScore:90, stagScore:55,
    verdict:"Hardest debasement hedge in existence — fixed supply, no central bank, no balance sheet. Best in class if the thesis is dollar credibility loss or Fed balance sheet explosion. Critical caveat: in a liquidity crisis onset (2008-style, March 2020-style), BTC sells off WITH equities — it dropped 50% in 48 hours in March 2020. It is NOT crash protection. It is post-crash, post-panic, debasement-phase protection. Correlation to Nasdaq in risk-off stress periods remains ~0.6–0.7. Size as high-conviction, long-horizon, volatile insurance — meaningful but not dominant.",
    uaeBenefit:"No UAE capital gains tax on crypto. AED/USD peg means no FX drag. IBKR Singapore supports BTC exposure via IBIT ETF.",
    tickers:[
      {t:"IBIT",    name:"iShares Bitcoin Trust",       type:"ETF",    note:"BlackRock ETF. Most liquid US access to BTC. $50B+ AUM. Use this over direct BTC for IBKR trading."},
      {t:"BTC-USD", name:"Bitcoin spot",                type:"Crypto", note:"Direct spot via Binance or Hyperliquid. Use for sizing beyond ETF or for crypto-native accounts."},
      {t:"FBTC",    name:"Fidelity Wise Origin Bitcoin",type:"ETF",    note:"Alternative to IBIT. Slightly lower expense ratio. Same exposure."},
    ],
  },
];

// ─── INSURANCE TRIGGERS ───────────────────────────────────────────────────────
// Per-ticker activation signal. Falls back to the bucket-level trigger when a
// ticker has no specific entry. NOTE: SQQQ / VIX calls / VXX / HYG·JNK puts /
// SOXX·SMH puts / SPY·QQQ put spreads are NOT yet present as Insurance buckets —
// their triggers are staged below, ready to wire once those instruments are added.
const BUCKET_TRIGGERS = {
  miners:   "Credit spreads >400bps OR CPI re-accelerates above 4.5%",
  farmland: "Stagflationary regime active. Long-duration inflation hedge.",
  tbonds:   "Unemployment >5.5% AND yield curve deeply inverted (growth scare, not inflation)",
  staples:  "Unemployment rising + consumer confidence falling. Defensive rotation.",
};
const TICKER_TRIGGERS = {
  // Gold miners
  GDX:"Credit spreads >400bps OR CPI re-accelerates above 4.5%",
  GDXJ:"Credit spreads >400bps OR CPI re-accelerates above 4.5%",
  GLD:"Credit spreads >400bps OR CPI re-accelerates above 4.5%",
  // Treasuries
  TLT:"Unemployment >5.5% AND yield curve deeply inverted (growth scare, not inflation)",
  // Staples
  XLP:"Unemployment rising + consumer confidence falling. Defensive rotation.",
  // Farmland
  LAND:"Stagflationary regime active. Long-duration inflation hedge.",
  FPI:"Stagflationary regime active. Long-duration inflation hedge.",
  // Staged — not yet wired as Insurance buckets:
  SQQQ:"QQQ breaks 200-day MA on weekly close. Hold max 3–5 days.",
  VXX:"VIX <18 AND DANGER signal active. Buy convexity cheap before spike.",
  HYG:"HY spread >400bps and widening. Credit leads equity by 6–12 weeks.",
  JNK:"HY spread >400bps and widening. Credit leads equity by 6–12 weeks.",
  SOXX:"AI capex guidance miss OR semi earnings disappointment.",
  SMH:"AI capex guidance miss OR semi earnings disappointment.",
};

// ─── CROSS-TAB ASSET RATING INVARIANT ─────────────────────────────────────────
// One definition of WHY gold miners are not a gold hedge, referenced by both the Macro regime
// lists and the Insurance matrix so the two tabs can never contradict again. Miners once read as
// a "best asset" under Stagflation on Macro while the Insurance matrix rated GDX/GDXJ ⚠️ — same
// regime, same asset, opposite guidance. Resolved toward the Insurance caution.
//
// INVARIANT: any asset that appears in BOTH a Macro regime best/worst list AND an Insurance
// SCENARIO_MATRIX column must carry the SAME rating. Audit at time of writing — all consistent:
//   • Gold miners  — Stagflation: Macro no longer lists as "best" (see below); Insurance ⚠️.  ✓ fixed
//                    Inflationary Boom / Debasement: Macro best · Insurance ✅✅.               ✓
//   • TLT          — Stag: Macro worst · Insurance ❌ | Def: Macro best · Insurance ✅✅.        ✓
//   • Cash/T-bills — Def: Macro best · Insurance ✅✅ | Debasement: Macro worst · Insurance ⚠️.  ✓
//   • Gold (GLD)   — Def: Macro best · Insurance ✅.                                            ✓
//   • Staples/XLP  — Stag: Macro best · Insurance ✅✅ | Def: Macro best · Insurance ✅.          ✓
//   • Energy/BTC/Commodities — Debasement: Macro best · Insurance ✅✅ | Def: Macro worst/❌.     ✓
const GOLD_MINERS_WHY = "Gold miners are equities with operating leverage to gold, not gold itself — they carry equity beta and are sold in liquidity events (GDX fell ~70% in 2008). They express a gold view; they do not hedge one. The stagflation hedge is physical gold (GLD); miners are a cautioned, leveraged expression of it.";

// ─── INSURANCE PHASE NOTES ────────────────────────────────────────────────────
// Three-state crash-scenario overrides (onset / deflationary / inflationary) for
// the phase-sensitive buckets. The first character of each note drives colour:
// ⚠️ = amber, ✅ = green, ❌ = red (see AssetDetail phase-note render).
// Keyed by INSURANCE_PHASES `.k` (preCrash / liquidity / def / inf / stag / hawkish).
const PHASE_NOTES = {
  miners: {
    preCrash:     "GLD is more stable than miners as signals deteriorate — hold GLD first, add miners after the policy response. ⚠️ PRE-CRASH: Miners carry equity beta and sell with the market. Hold light; GLD is the better pre-crash hedge.",
    liquidity:    "❌ LIQUIDITY PHASE: Miners are sold hard in a dash-for-cash — GDX fell ~70% in 2008 as equity beta and gold's liquidity-event drop compounded. Do not hold miners through the drawdown; wait for the policy response to become visible.",
    recovery:     "✅✅ RECOVERY / POST-TROUGH: This is the whole point of miners — a post-trough TRADE, never a hedge and never a hold. The Gold Miners Index ran +100% Oct'07→Mar'09 (S&P −57%), +40% in a single month (Apr'20), +27% in a day (Nov'08) — all of it off the trough. Trigger: VIX term structure flips backwardation → contango. Take the recovery move; don't carry it into the resolution.",
    def:          "GLD outperforms miners in deflation — prefer GLD over GDX here. ⚠️ RESOLUTION — DEFLATIONARY: Gold moderate in deflation, miners underperform gold. Only add after Fed pivot signal confirmed.",
    inf:          "Both GLD and GDX/GDXJ win here — miners provide 2-3× leverage to gold price. ✅✅ RESOLUTION — DEBASEMENT: This is where miners shine. Gold up 20% = miners up 40–60%. Add aggressively after VIX peak.",
    stag:         "GLD grinds higher steadily. Miners amplify but with more volatility. ⚠️ RESOLUTION — STAGFLATION: Gold grinds higher but without the explosive move of a debasement crash. Miners underperform in a slow grind, carry equity beta, and are sold in liquidity events — they express a gold view, they do not hedge one. Physical gold (GLD) is the hedge; hold miners moderate as a cautioned leveraged expression, don't over-allocate waiting for a spike that may take years.",
    hawkish:      "❌ HAWKISH RATES REPRICING: Gold −2% and miners worse when real yields rise and gold's zero-yield bid competes with cash. Not the hedge here — the front end is.",
  },
  btc: {
    preCrash:     "❌ PRE-CRASH: BTC dropped 50% in 48 hours in March 2020. Not pre-crash protection. Wait for panic to clear.",
    liquidity:    "❌ LIQUIDITY PHASE: BTC is high-beta and sells with risk assets in a dash-for-cash. Avoid until the policy response is visible.",
    recovery:     "✅✅ RECOVERY / POST-TROUGH: Highest beta to returning liquidity — BTC leads off the trough once forced selling is exhausted. Trigger: VIX term structure flips backwardation → contango. A recovery buy alongside miners and equities, funded by selling the decay hedges.",
    def:          "❌ RESOLUTION — DEFLATIONARY: BTC performs poorly in deflationary crashes — no yield, high beta, sells with risk assets. Avoid.",
    inf:          "✅✅ RESOLUTION — DEBASEMENT: Post-panic BTC is the highest-conviction debasement play. Fixed supply vs exploding Fed balance sheet. Enter after VIX peaks.",
    stag:         "⚠️ RESOLUTION — STAGFLATION: No clear catalyst for BTC in persistent stagflation. Inflation present but not acute enough to drive the debasement narrative. Equity correlation remains. Hold existing, don't add aggressively.",
    hawkish:      "❌ HAWKISH RATES REPRICING: Risk-off plus higher real yields hit BTC. Not a hedge for a rates repricing.",
  },
  tbonds: {
    preCrash:     "⚠️ PRE-CRASH: Only works if the crash is confirming deflationary — falling CPI, growth scare, 10Y yield falling. In stagflation TLT is a trap even here. Do not buy until deflation is confirmed.",
    liquidity:    "⚠️ LIQUIDITY PHASE: Even Treasuries can sell in the worst of a dash-for-cash (March 2020 saw brief forced Treasury selling) before they rally. Size for the resolution, not the drawdown.",
    recovery:     "⚠️ RECOVERY / POST-TROUGH: TLT's recovery role depends entirely on the resolution — it rallies hard into a deflationary recession but is a trap into debasement or stagflation. Don't buy duration off the trough on reflex; wait for the resolution column to declare (OAS direction, breakevens). The recovery buy is equities/miners/BTC, not bonds.",
    def:          "✅✅ RESOLUTION — DEFLATIONARY: TLT is your best instrument here. Rates fall, bonds rally hard. Also consider IEF (7-10yr) as a lower-volatility alternative — less upside, less drawdown if the recovery is faster than expected.",
    inf:          "❌ RESOLUTION — DEBASEMENT: TLT gets crushed. Sticky inflation + Fed balance-sheet expansion = bond bear market. Avoid entirely. 2022 repeat risk.",
    stag:         "❌ RESOLUTION — STAGFLATION: Avoid. Inflation stays sticky — rates cannot fall meaningfully. TLT grinds lower as real yields stay elevated. Worst regime for long-duration bonds.",
    hawkish:      "❌ HAWKISH RATES REPRICING: Duration IS the risk here — a rates repricing hits TLT directly (−0.87% on 2026-07-31). Front end only.",
  },
};

// ─── INSURANCE CRASH-SCENARIO PHASES ──────────────────────────────────────────
// Four-state toggle for the Insurance tab. The user reads the scenario matrix +
// live-signal lean, then sets this manually. It does NOT auto-drive the toggle.
// `col` maps each phase to its SCENARIO_MATRIX field; colour set is reused by the
// interactive guide (active column) and the phase-note callouts.
// Six columns. Crash TIMELINE (Pre-Crash → Liquidity Phase) then crash OUTCOMES
// (Resolution: Deflationary / Debasement / Stagflation), plus the Hawkish Rates Repricing
// macro state (not a crash, but its insurance behaves least intuitively — every yield-competing
// asset, including the usual defensives, is sold at once). The `Resolution:` prefix marks the
// three outcome columns as crash resolutions, NOT current-state regimes — critically, this
// "Debasement" column is a CRISIS and is the OPPOSITE of Macro's "Inflationary Boom".
const INSURANCE_PHASES = [
  { k:"preCrash",  col:"preCrash",  label:"Pre-Crash",                 short:"Pre-Crash",         color:STATUS.WATCH.color,  bg:STATUS.WATCH.bg,  bdr:STATUS.WATCH.bdr,  desc:"Signals deteriorating, no drawdown yet — the accumulation window. Protection is cheap: puts and VIX calls are the right instruments here, before IV reprices. GLD works; miners lag (equity beta).", size:{ band:"0–3%", note:"protection is cheap (VIX low, IV not yet repriced) — begin sizing puts / VIX calls; don't fully activate yet." } },
  { k:"liquidity", col:"liquidity", label:"Liquidity Phase",           short:"Liquidity Phase",   color:STATUS.DANGER.color, bg:STATUS.DANGER.bg, bdr:STATUS.DANGER.bdr, desc:"Drawdown underway — margin calls, correlations going to 1. Gold is SOLD here because it is liquid and profitable: it fell ~12% over ~8 sessions in March 2020 and ~30% from its March 2008 high to its October 2008 low, both times while equities collapsed. Miners are worse (GDX ~−70% in 2008). Protection bought now is expensive — IV has already repriced, so puts and VIX calls are a poor purchase. Cash is the only thing that works cleanly.", size:{ band:"hold · add ~0%", note:"protection is now expensive (IV repriced) — don't chase it. Raise cash and prepare the recovery buy." } },
  { k:"recovery",  col:"recovery",  label:"Recovery / Post-Trough",    short:"Recovery",          color:"#047857", bg:"#ECFDF5", bdr:"#A7F3D0", desc:"VIX has peaked and is rolling over, credit has stopped widening, forced selling is exhausted — resolution not yet determined. This is THE BUY: gold miners, BTC and equities lead off the trough (the NYSE Arca Gold Miners Index ran +100% Oct'07→Mar'09 while the S&P fell 57%, +40% in Apr'20, +27% in a single day Nov'08 — all of it here, none in the collapse column). Sell the decay hedges into the vol collapse: holding the right hedge past its window is where most insurance P&L is given back. Miners here are a post-trough TRADE with a trigger, never a hedge and never a hold.", size:{ band:"insurance → ~0%", note:"unwind the decay hedges into the vol collapse and rotate the proceeds + dry powder into the recovery buy (miners / BTC / equities)." } },
  { k:"def",       col:"def",       label:"Deflationary Recession",    short:"Defl. Recession",   color:"#1E40AF", bg:"#EFF6FF", bdr:"#BFDBFE", desc:"Crash resolves through debt deflation — falling prices, Japan-style. TLT wins. Gold moderate. BTC loses. Same term as the Macro tab's regime: a deflationary recession, whether you're forecasting it (Macro) or hedging its arrival (here).", size:{ band:"10–18%", note:"the highest insurance allocation — TLT and SPY puts dominate; add IEF as a lower-vol duration alternative." } },
  { k:"inf",       col:"inf",       label:"Resolution: Debasement",    short:"Res: Debasement",   color:"#7C3AED", bg:"#F5F3FF", bdr:"#C4B5FD", desc:"Crash resolves through DEBASEMENT — Fed prints, dollar credibility erodes, currency stress, loss of monetary confidence. Gold and BTC win; TLT is a trap. This is a CRISIS — the OPPOSITE of Macro's 'Inflationary Boom' (a good, growth-strong outcome you'd want to be long). Read at speed, the shared word invites exactly the wrong action; hence 'Resolution: Debasement'. Its slow-motion, multi-year cousin — Financial Repression (negative real yields held for years, Japan-style) — is a Macro-tab regime STATE, not a crash resolution; see the Regime-shift scenarios there, not a column here.", size:{ band:"5–10%", note:"gold and BTC as MONETARY insurance (not crash insurance) — TLT is a trap here." } },
  { k:"stag",      col:"stag",      label:"Resolution: Stagflation",   short:"Res: Stagflation",  color:"#0F766E", bg:"#F0FDFA", bdr:"#5EEAD1", desc:"Persistent stagflation — slow grind, not a sharp crash. Favour passive real-asset hedges (GLD, XLP, farmland, HYG puts) over active short instruments. Avoid VIX calls (contango) and SQQQ (daily decay). Size conservatively; favour longer-dated instruments to reduce theta bleed.", size:{ band:"8–15%", note:"gold / staples / HYG puts; size conservatively and favour longer-dated to cut theta bleed over a slow grind." } },
  { k:"hawkish",   col:"hawkish",   label:"Hawkish Rates Repricing",   short:"Hawkish Repricing", color:"#B45309", bg:"#FFF7ED", bdr:"#FED7AA", desc:"Not a crash — a rates repricing (occurred 2026-07-31: gold −2.07%, TLT −0.87%, XLU −0.37%, XLP −0.80%, IWM −0.70%, BTC −1.8%, SPY roughly flat). Nothing hedges this except the front end. Duration is the risk, and every asset that competes with cash for yield gets sold simultaneously — including the defensives (GLD, TLT, staples) that work in every other scenario.", size:{ band:"front-end only", note:"nothing hedges a rates repricing except the front end (bills / USFR) — duration IS the risk." } },
];

// P1.3 — the six columns are TWO dimensions: crash TIME PHASES (pre-crash / liquidity) and crash
// RESOLUTIONS (deflationary / debasement / stagflation / hawkish). Picking a flat column answered
// two questions at once. The matrix now offers a phase-dimension selector; the resolution
// dimension expands to its four outcome columns. One asset can then carry three ratings —
// e.g. gold ✅ pre-crash, ⚠️ liquidity, and varying by resolution — which a flat row can't show.
const INS_PHASE_DIMS = { preCrash: ["preCrash"], liquidity: ["liquidity"], recovery: ["recovery"], resolution: ["def", "inf", "stag", "hawkish"] };
const INS_DIM_LABELS = { preCrash: "Pre-Crash", liquidity: "Liquidity", recovery: "Recovery", resolution: "Resolution" };
const insDimOf = k => k === "preCrash" ? "preCrash" : k === "liquidity" ? "liquidity" : k === "recovery" ? "recovery" : "resolution";

// Permanent, non-interactive reference. Six columns, grouped by hedge family (group header rows
// rendered in the table). ✅✅ = primary · ✅ = works well · ⚠️ = caution/timing · ❌ = avoid.
// GLD/Physical Gold and GDX/GDXJ are intentionally separate rows — GLD held value where GDX did
// not. Cash is its own top row: the only instrument that works across the crash timeline AND the
// hawkish repricing.
// `inf` column = the DEBASEMENT resolution. Aug-20 Part B corrections applied:
//  B1 miners capped at ✅, never above physical gold (GDX has lagged GLD ~6.5%/yr since 2006,
//     worst in crises; ~2× vol, asymmetric). B2 stagflation re-tiered (Gold/Energy ✅✅, Staples ✅).
//  B3 TIPS added · B5 Cash in deflation ✅ (TLT is the best asset) · B6 Energy hawkish ✅ conditional
//  B7 BTC debasement ✅ (short record) + broad commodities added.
// Column order per row: preCrash · liquidity · recovery · def · inf(=Debasement) · stag · hawkish.
// `cat` classes the row for hold/exit logic (Part B): decay = sold, not held (theta/contango/daily
// decay); tactical = post-trough TRADE with a trigger (miners, BTC — never a hedge, never a hold);
// regime = held until the Macro-tab regime flips, NOT sold on a liquidity-phase drawdown; cash = held
// until the deployment trigger, and the only asset that flips ✅✅→❌ on a REGIME (Debasement), not a phase.
const SCENARIO_MATRIX = [
  { group:"Cash / Front End",       row:"Cash / SGOV / USFR",  cat:"cash",     preCrash:"✅✅", liquidity:"✅✅", recovery:"🔻", def:"✅",  inf:"⚠️", stag:"⚠️", hawkish:"✅✅",
    carry:"positive T-bill carry — you're paid to wait", carryBy:{ inf:"real carry erodes vs. sticky CPI", stag:"real carry erodes — nominal still paid", recovery:"opportunity cost — every day unspent is return foregone" } },
  { group:"Gold & Precious Metals", row:"GLD / Physical Gold", cat:"regime",   preCrash:"✅",  liquidity:"⚠️", recovery:"✅",  def:"✅",  inf:"✅✅", stag:"✅✅", hawkish:"❌",
    carry:"zero yield, ~0.4% fee — slight negative carry" },
  { group:"Gold & Precious Metals", row:"GDX / GDXJ",          cat:"tactical", preCrash:"⚠️", liquidity:"❌", recovery:"✅✅", def:"⚠️", inf:"✅",  stag:"⚠️", hawkish:"❌", note:"Never a hedge, never a hold — a post-trough TRADE with a trigger. Collapsed −70% (Mar→Oct 2008) then ran +100% Oct'07→Mar'09 vs S&P −57%; +40% month (Apr'20), +27% day (Nov'08). Baur: −6.5%/yr vs bullion buy-and-hold — a poor permanent allocation, an excellent tactical one.",
    carry:"zero yield + equity beta — negative carry, drawdown-prone" },
  { group:"Gold & Precious Metals", row:"Silver (SLV / SIL)",  cat:"regime",   preCrash:"⚠️", liquidity:"❌", recovery:"✅✅", def:"❌", inf:"✅✅", stag:"⚠️", hawkish:"❌", note:"Half industrial, so it behaves unlike gold: more beta than gold in debasement and off the trough, but falls HARDER in the liquidity phase and in deflation as industrial demand drops. ~1.6× gold's volatility.",
    carry:"zero yield + storage — negative carry; ~1.6× gold's vol" },
  { group:"Inflation-Linked",       row:"TIPS (STIP / TIP)",   cat:"regime",   preCrash:"⚠️", liquidity:"⚠️", recovery:"⚠️", def:"⚠️", inf:"✅",  stag:"✅✅", hawkish:"❌", note:"The direct inflation instrument. STIP (0–5yr) is less rate-sensitive — the better fit for a crisis matrix; breakevens fall in deflation, real yields rise in a hawkish repricing.",
    carry:"real-yield carry — positive while reals > 0", carryBy:{ inf:"CPI accrual on principal — favorable", hawkish:"rising reals hit price — negative" } },
  { group:"Macro / Rate Hedges",    row:"TLT / IEF",           cat:"regime",   preCrash:"⚠️", liquidity:"⚠️", recovery:"⚠️", def:"✅✅", inf:"❌",  stag:"❌",  hawkish:"❌",
    carry:"coupon vs. MTM — carry swings with rates", carryBy:{ def:"coupon + duration gains as rates fall — favorable", inf:"negative real carry — coupon can't offset the bleed", stag:"negative real carry — grinds lower", hawkish:"duration IS the risk — worst carry" } },
  { group:"Macro / Rate Hedges",    row:"HYG / JNK Puts",      cat:"decay",    preCrash:"✅",  liquidity:"✅",  recovery:"🔻", def:"✅",  inf:"✅",  stag:"✅",  hawkish:"⚠️",
    carry:"option theta — negative carry, decays while you wait", carryBy:{ recovery:"spreads compress + IV crush — the fastest bleed here" } },
  { group:"Macro / Rate Hedges",    row:"VIX Calls / VXX",     cat:"decay",    preCrash:"✅✅", liquidity:"⚠️", recovery:"🔻", def:"✅",  inf:"✅",  stag:"❌",  hawkish:"⚠️",
    carry:"steep theta + contango roll — expensive to hold", carryBy:{ preCrash:"cheap now — IV low before the repricing", liquidity:"IV already repriced — poor entry, dear to hold", recovery:"vol collapse — the single most expensive thing to hold here", stag:"contango bleeds hard in a slow grind" } },
  { group:"Equity Shorts",          row:"SPY / QQQ Puts",      cat:"decay",    preCrash:"✅✅", liquidity:"⚠️", recovery:"🔻", def:"✅",  inf:"✅",  stag:"⚠️", hawkish:"⚠️", note:"Tenor matters: short-dated (30d) is a Pre-Crash instrument; longer-dated (3–6mo) is a hold-through-the-phase instrument with more carry but a wider window.",
    carry:"option theta — negative carry, worse the longer you wait", carryBy:{ recovery:"IV crush + delta both against you" } },
  { group:"Equity Shorts",          row:"SQQQ / 7568.HK",      cat:"decay",    preCrash:"✅",  liquidity:"⚠️", recovery:"🔻", def:"✅",  inf:"✅",  stag:"⚠️", hawkish:"⚠️",
    carry:"daily-rebalance decay — bleeds in flat/choppy tape", carryBy:{ recovery:"daily decay against a rising tape — sell" } },
  { group:"Defensive Income",       row:"XLP / Staples",       cat:"regime",   preCrash:"✅",  liquidity:"⚠️", recovery:"⚠️", def:"✅",  inf:"⚠️", stag:"✅",  hawkish:"❌", note:"Best defensive EQUITY in stagflation (pricing power, non-discretionary demand) — but gold and energy outrank it as the primary hedges (2022: XLE +64%, XLP ~−3%). Lags in the recovery — defensives are what you rotate OUT of off the trough.",
    carry:"≈2.5% dividend — positive carry, cheap to hold" },
  { group:"Commodities / Energy",   row:"CNOOC / Energy",      cat:"regime",   preCrash:"⚠️", liquidity:"❌", recovery:"✅",  def:"❌",  inf:"✅✅", stag:"✅✅", hawkish:"✅", note:"Hawkish repricing: ✅ if INFLATION-driven (breakevens rising) · ⚠️ if TERM-PREMIUM / supply-driven (today's case — breakevens flat). 2022 (inflation-driven) XLE was the best sector, +64%.",
    carry:"dividend + futures roll — carry varies", carryBy:{ inf:"backwardation adds positive roll carry", stag:"dividend + roll — favorable" } },
  { group:"Commodities / Energy",   row:"DBC / PDBC (broad)",  cat:"regime",   preCrash:"⚠️", liquidity:"❌", recovery:"✅",  def:"❌",  inf:"✅",  stag:"✅✅", hawkish:"✅", note:"Broad commodities — the best-performing asset class of 2022; energy alone doesn't cover it. Same hawkish condition as energy.",
    carry:"futures roll — backwardation +, contango −" },
  { group:"Debasement / Monetary",  row:"BTC",                 cat:"tactical", preCrash:"❌", liquidity:"❌", recovery:"✅✅", def:"❌",  inf:"✅",  stag:"⚠️", hawkish:"❌", note:"Highest beta to returning liquidity — the recovery is where it earns its place. Short debasement record (~2yr; −50% in 48h Mar 2020, −64% through 2022). Correct direction, thin evidence for a top tier alongside physical gold in the resolutions.",
    carry:"zero yield; funding cost if levered — negative carry" },
  { group:"Real Assets / Farmland", row:"Farmland REITs (LAND / FPI)", cat:"regime", preCrash:"⚠️", liquidity:"❌", recovery:"✅", def:"❌", inf:"⚠️", stag:"⚠️", hawkish:"❌", note:"The only investable farmland here — and it's a REIT, NOT a proxy for the land. The unleveraged NCREIF index returned +9.64% in 2022 while FPI fell >14%; LAND max drawdown −76.56% (worse than GDX in 2008). Extra risks: NAV discount (FPI 25–30%, a return driver unrelated to farmland) and US-situs estate tax.",
    carry:"small-cap REIT beta + leverage — LAND/FPI 0.68%/2.10% 10yr, deep drawdowns" },
];

// B7 — per-cell ACTION + CARRY. The glyph rates HOW GOOD an instrument is in a scenario; these
// answer WHAT TO DO with it. Action is derived per cell from the glyph + phase — pre-crash is the
// cheap accumulation window (INITIATE), the liquidity phase has already repriced IV (HOLD what
// works, don't chase), the resolution columns are where you position for the confirmed outcome —
// with an override table for the cells whose timing is non-obvious (miners add only after the VIX
// peak, TLT only on the pivot, gold gets trimmed into the dash-for-cash). Carry is the instrument's
// cost-to-hold (row-level `carry`), overridden by `carryBy` in the scenarios where the sign flips.
const CELL_ACT_OVERRIDES = {
  "Cash / SGOV / USFR|preCrash": "HOLD",
  "Cash / SGOV / USFR|liquidity": "HOLD",
  "Cash / SGOV / USFR|recovery": "DEPLOY",
  "GLD / Physical Gold|liquidity": "TRIM→cash",
  "GDX / GDXJ|inf": "STAGE",
  "GDX / GDXJ|stag": "HOLD LIGHT",
  "TLT / IEF|def": "ON PIVOT",
  "HYG / JNK Puts|liquidity": "HOLD",
  "VIX Calls / VXX|liquidity": "HOLD",
  "SPY / QQQ Puts|liquidity": "HOLD",
  "SQQQ / 7568.HK|liquidity": "HOLD",
  "BTC|inf": "STAGE",
  "CNOOC / Energy|hawkish": "CONDITIONAL",
  "DBC / PDBC (broad)|hawkish": "CONDITIONAL",
};
function cellAction(glyph, phaseKey, row) {
  const g = String(glyph);
  if (g === "—" || g.toLowerCase() === "n/a" || g === "") return ""; // no tactical position
  if (g.startsWith("🔻")) return phaseKey === "recovery" && /Cash/.test(String(row)) ? "DEPLOY" : "SELL";
  const ov = CELL_ACT_OVERRIDES[`${row}|${phaseKey}`];
  if (ov) return ov;
  if (g.startsWith("❌")) return "AVOID";
  if (g.startsWith("⚠️")) return phaseKey === "preCrash" ? "WAIT" : "HOLD LIGHT";
  if (phaseKey === "preCrash") return "INITIATE";
  if (phaseKey === "liquidity") return "HOLD";
  if (phaseKey === "recovery") return "BUY"; // off the trough — this is the buy, not the resolutions
  return "INITIATE"; // resolution columns — position for the confirmed outcome
}
// Chip palette. INITIATE / BUY read as go now (green); STAGE / ON PIVOT / DEPLOY as go on the trigger
// (blue); HOLD as keep-don't-chase (grey); WAIT / CONDITIONAL / TRIM as caution (amber); AVOID as
// stop (red); SELL as unwind-now (rose — deliberately distinct from AVOID's don't-buy red).
const ACT_STYLE = {
  "INITIATE":    { color:"#047857", bg:"#ECFDF5", bdr:"#A7F3D0" },
  "BUY":         { color:"#047857", bg:"#ECFDF5", bdr:"#A7F3D0" },
  "STAGE":       { color:"#1D4ED8", bg:"#EFF6FF", bdr:"#BFDBFE" },
  "ON PIVOT":    { color:"#1D4ED8", bg:"#EFF6FF", bdr:"#BFDBFE" },
  "DEPLOY":      { color:"#1D4ED8", bg:"#EFF6FF", bdr:"#BFDBFE" },
  "HOLD":        { color:"#6B7280", bg:"#F9FAFB", bdr:"#E5E7EB" },
  "HOLD LIGHT":  { color:"#6B7280", bg:"#F9FAFB", bdr:"#E5E7EB" },
  "WAIT":        { color:"#B45309", bg:"#FFF7ED", bdr:"#FED7AA" },
  "CONDITIONAL": { color:"#B45309", bg:"#FFF7ED", bdr:"#FED7AA" },
  "TRIM→cash":   { color:"#B45309", bg:"#FFF7ED", bdr:"#FED7AA" },
  "AVOID":       { color:"#B91C1C", bg:"#FEF2F2", bdr:"#FECACA" },
  "SELL":        { color:"#BE123C", bg:"#FFF1F2", bdr:"#FECDD3" },
};
const actStyle = a => ACT_STYLE[a] || ACT_STYLE.HOLD;

// Part B — holding period + exit trigger by category. Three (plus tactical) different exit rules:
// most insurance losses come not from buying the wrong hedge but from holding the right hedge past
// its window. Rendered per cell (in the selected column) so the exit rule travels with the rating.
const HOLD_LOGIC = {
  decay:    { horizon:"days–weeks",           horizonShort:"days–wks",   exit:"VIX term structure flips back to contango",              exitShort:"vol → contango",       note:"Sold, not held — bleeds continuously (theta / contango roll / daily decay). Holding through the peak gives back the entire gain." },
  tactical: { horizon:"weeks — post-trough window", horizonShort:"wks",   exit:"the recovery rally matures / the resolution confirms",    exitShort:"rally matures",        note:"A VIX-peak TRADE, not a hedge and not a hold. Take the off-the-trough move; don't carry it into the resolution." },
  regime:   { horizon:"months — until the regime changes", horizonShort:"months", exit:"the Macro-tab regime state changes",             exitShort:"Macro regime flips",   note:"Exit on a regime change, NOT on a liquidity-phase drawdown — that drawdown is how liquid, profitable positions get sold to meet margin (gold −12% over 8 sessions Mar 2020, then all-time highs by August)." },
  cash:     { horizon:"until the deployment trigger", horizonShort:"to trigger", exit:"bills → duration at the pivot → equities 30–60d after the first cut", exitShort:"deployment sequence", note:"The only asset whose worst outcome is being right and doing nothing. Flips ✅✅→❌ on a REGIME change (Debasement — loses purchasing power), not on a phase change." },
};

// A3 — auto-suggest the Insurance phase from the VIX term-structure regime + the OAS 20-obs trend.
//   BACKWARDATION → Liquidity Phase (front above back; stress / forced selling).
//   CONTANGO + OAS off its lows and rolling over → Recovery (credit stabilising AFTER a widening).
//   CONTANGO + OAS calm/tight → Pre-Crash (the accumulation window).
//   FLAT → regime transition; no confident call, leave the user's selection alone.
// The OAS 20-obs change is the discriminator between Pre-Crash and Recovery — both read contango, but
// recovery follows a widening and pre-crash does not. Suggestion only; the user can pin (see A3 banner).
function suggestInsurancePhase(volTerm, oasSeries) {
  if (!volTerm?.available || !volTerm.regime) return null;
  if (volTerm.regime === "BACKWARDATION") return { phase: "liquidity", why: "VIX backwardation — front above back; a stress / forced-selling regime" };
  if (volTerm.regime === "FLAT") return null; // transition — don't override a manual read
  const vals = (oasSeries || []).map(x => (typeof x === "number" ? x : (x?.value ?? x?.oas ?? null))).filter(v => v != null);
  if (vals.length >= 6) {
    const last = vals[vals.length - 1];
    const back = vals[Math.max(0, vals.length - 21)];
    const widened = last - back; // OAS units (percentage points); positive = wider than ~20 obs ago
    if (widened >= 0.2) return { phase: "recovery", why: `VIX contango + credit stabilising after a widening (OAS +${widened.toFixed(2)} over ~20 obs)` };
  }
  return { phase: "preCrash", why: "VIX contango + credit calm — the accumulation window" };
}

// Live-signal anchor — auto-computed lean from liveInd. Informational only;
// the user still sets the toggle. Safe to call with {} when liveInd is null.
// Uses cpiYoY (year-over-year %) — NOT the raw CPIAUCSL index level, which is
// ~315 and would always read as inflationary.
function getCrashSignalRead(liveInd, activeRegime) {
  // Stagflation: the dashboard's active regime is already stagflationary. This
  // connects the regime engine directly to the Insurance tab's signal anchor.
  // `phaseKey` names the INSURANCE_PHASES column the lean maps to, so the callout can link.
  if (activeRegime?.id === "stag") return {
    lean: "Resolution: Stagflation", phaseKey: "stag",
    reason: "active regime is stagflationary — inflation sticky, growth slowing. Favour staples, GLD, HYG puts over short-dated puts and VIX calls",
  };
  const inflationary = liveInd.cpiYoY > 4.0 && liveInd.m2Rising;
  const deflationary = liveInd.yieldSpread < -0.5 && liveInd.creditSpread > 4.5;
  if (inflationary) return {
    lean: "Resolution: Debasement", phaseKey: "inf",
    reason: `CPI ${liveInd.cpiYoY?.toFixed(1)}% YoY, M2 rising, sticky inflation environment`,
  };
  if (deflationary) return {
    lean: "Deflationary Recession", phaseKey: "def",
    reason: `Yield curve ${liveInd.yieldSpread?.toFixed(2)}%, credit spreads ${liveInd.creditSpread?.toFixed(1)}%`,
  };
  return {
    lean: "Pre-Crash / Unclear", phaseKey: "preCrash",
    reason: "Signals mixed — monitor credit spreads and CPI trajectory",
  };
}

// ─── PORTFOLIO POSTURE ────────────────────────────────────────────────────────
// Fund-manager allocation framework. Keyed by regime (activeRegime.id); "baseline"
// is the fallback. Methodology: volatility-adjusted risk contribution per bucket,
// regime-specific correlation structure, hardcoded 25% cash floor (no employment
// income). Stage tracker (below) is driven separately by the live signal + manual
// toggles — allocations = regime, stages = where we are in the cycle.
const POSTURE_ALLOCATIONS = {
  baseline: {
    cash:            { range: "55–65%", status: "HOLD",       note: "Core liquidity. Floor: never below 25%. Current optimal hold: USFR (WisdomTree Floating Rate Treasury ETF) for bulk — yield resets weekly, tracks T-bill/Fed funds, currently {{CASH}} annualized. SGOV for trading-ready portion — marginally lower yield but identical liquidity. IBKR cash sweep for active trading float (tracks Fed funds less a spread) — automatic, zero friction. UAE bank account for AED living expenses only. Do not hold investment capital in bank accounts earning 2-3%." },
    insurance:       { range: "0–3%",   status: "PREPARE",    note: "Insurance is cheap now (VIX <20). Begin sizing positions. Don't activate yet." },
    income:          { range: "8–12%",  status: "HOLD",       note: "Regime-agnostic yield plays. Pipelines, utilities, dividend aristocrats." },
    longTermHolds:   { range: "15–20%", status: "HOLD",       note: "AI infrastructure hardware. Quality compounders. Hold through volatility." },
    deploymentReady: { range: "5–10%",  status: "WATCH",      note: "Stage-gated. Do not deploy until Stage 4 triggered." },
    categoryNote:    "AI infrastructure hardware (semiconductors, compute) and highest-quality compounders with pricing power.",
  },
  stag: {
    cash:            { range: "50–60%", status: "HOLD",       note: "Preserve optionality. Real yield eroding in real terms but cash dominates over equity drawdowns. Hold USFR — floating rate means yield stays elevated as long as rates hold. With the Fed on hold, USFR continues earning {{CASH}}. Do not rotate out of USFR until Fed pivot is confirmed. Bank AED expenses only." },
    insurance:       { range: "8–15%",  status: "ACTIVATE",   note: "Gold miners, GLD, put spreads. TLT is a trap in stagflation — avoid bonds here." },
    income:          { range: "12–18%", status: "ACCUMULATE", note: "Pipelines and utilities with inflation pass-through contracts. Real asset income only." },
    longTermHolds:   { range: "12–18%", status: "HOLD",       note: "Hardware only. Avoid high-multiple software — multiples compress with sticky inflation." },
    deploymentReady: { range: "0–5%",   status: "PAUSE",      note: "Do not deploy into stagflation. Wait for regime shift before adding exposure." },
    categoryNote:    "AI infrastructure hardware only (ASML, AVGO, AMAT). No software adds until regime clears.",
  },
  def: {
    cash:            { range: "60–70%", status: "HOLD",       note: "Cash is king in deflation — purchasing power rises as prices fall. Hold USFR until Fed pivot signal confirmed, then rotate immediately: USFR → IEF (7-10yr Treasuries) on pivot day. IEF appreciates ~7-8% per 100bps of cuts on top of coupon. TLT for more aggressive duration play if deflation is deep. Do NOT rotate to IEF/TLT before pivot confirmation — in crash onset, USFR stays put and earns yield while you wait." },
    insurance:       { range: "10–18%", status: "ACTIVATE",   note: "TLT and SPY puts dominate. Gold moderate. Miners underperform until Fed pivots." },
    income:          { range: "8–12%",  status: "SELECTIVE",  note: "Dividend aristocrats with 20+ year track records only. Avoid high-yield — default risk spikes." },
    longTermHolds:   { range: "8–12%",  status: "REDUCE",     note: "Equity multiples compress in deflation. Hold only highest-conviction names. Trim speculative." },
    deploymentReady: { range: "0–3%",   status: "PAUSE",      note: "Near zero deployment. This is the crash phase — preserve cash for Stage 4 entry." },
    categoryNote:    "Highest-quality compounders with pricing power and zero leverage only. No new positions.",
  },
  ref: {
    cash:            { range: "25–35%", status: "DEPLOY",     note: "Pivot confirmed — cash is now a drag in real terms as rates fall and yield compresses. Execute rotation immediately: (1) Sell USFR — yield collapsing as rates cut. (2) Buy IEF same day — captures rate duration appreciation. (3) Begin Stage 4 equity deployment 30-60 days after first cut — software sleeve first, then hardware. (4) Maintain 25% cash floor throughout — deploy into equities from IEF proceeds as positions fill. UAE banks lag Fed cuts by 1-2 months — briefly check FAB/Emirates NBD term deposit rates post-pivot, may briefly exceed T-bill yields." },
    insurance:       { range: "0–3%",   status: "REDUCE",     note: "Roll off puts as VIX normalises. Minimal insurance — you want exposure, not hedges." },
    income:          { range: "12–18%", status: "ACCUMULATE", note: "REITs and dividend growers re-rate on rate cuts. Best income regime." },
    longTermHolds:   { range: "25–35%", status: "ACCUMULATE", note: "Full AI infrastructure stack — hardware and software. Growth names re-rate on cuts." },
    deploymentReady: { range: "20–30%", status: "ACTIVATE",   note: "Stage 4 deployment window. Software sleeve first, then hardware fills. ARM adds $360–375." },
    categoryNote:    "Full AI infrastructure stack: hardware (ASML, AVGO, AMAT, ARM) + software (NOW, DDOG, CRWD, PLTR, SNOW). Drift to 50/50 by mid-2027.",
  },
  inf: {
    cash:            { range: "40–50%", status: "HOLD",       note: "Cash erodes in real terms but maintains optionality. Hold USFR — floating rate captures elevated yield. Do not extend duration into TLT/IEF — inflation persistence means rates stay higher for longer. Monitor for debasement signals: Fed balance sheet expanding + CPI sticky above 4% = begin building BTC and gold positions from cash. Maintain floor." },
    insurance:       { range: "5–10%",  status: "HOLD",       note: "Gold and BTC as debasement hedges. Not crash insurance — monetary system insurance." },
    income:          { range: "15–20%", status: "ACCUMULATE", note: "Pipelines and energy infrastructure with inflation escalator contracts. Highest income allocation of any regime." },
    longTermHolds:   { range: "15–20%", status: "SELECTIVE",  note: "Names with hard pricing power only. Avoid pure software multiples — rate pressure compresses them." },
    deploymentReady: { range: "5–10%",  status: "SELECTIVE",  note: "Selective only. Real asset adjacent tech and commodity-linked names with pricing power." },
    categoryNote:    "Pricing power names only: AVGO, ASML, AMAT. Avoid high-multiple software. Add energy-adjacent infrastructure.",
  },
};
const POSTURE_BUCKET_META = [
  { key:"cash",            name:"Cash",             icon:"💵", sub:"dry powder · 25% floor" },
  { key:"insurance",       name:"Insurance",        icon:"🛡️", sub:"active hedges · links to Insurance tab", link:"insurance" },
  { key:"income",          name:"Income",           icon:"💰", sub:"regime-ranked yield · links to Income tab", link:"income" },
  { key:"longTermHolds",   name:"Long-term holds",  icon:"🏛️", sub:"core conviction positions" },
  { key:"deploymentReady", name:"Deployment ready", icon:"🚀", sub:"stage-gated adds" },
];
const POSTURE_STATUS = {
  HOLD:       { color:"#6B7280", bg:"#F9FAFB", bdr:"#E5E7EB" },
  PREPARE:    { color:"#1E40AF", bg:"#EFF6FF", bdr:"#BFDBFE" },
  WATCH:      { state:"WATCH" },
  ACTIVATE:   { state:"BENIGN" },
  ACCUMULATE: { state:"BENIGN" },
  DEPLOY:     { state:"BENIGN" },
  SELECTIVE:  { state:"WATCH" },
  REDUCE:     { color:"#B45309", bg:"#FFF7ED", bdr:"#FED7AA" },
  PAUSE:      { state:"DANGER" },
};
// Midpoint of a "60–70%" style range, for the allocation donut.
function postureMid(range) {
  const nums = String(range).replace(/%/g, "").split("–").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
  return nums.length === 2 ? (nums[0] + nums[1]) / 2 : (nums[0] || 0);
}
// Stages 1–3 auto-trigger from the live signal (same thresholds as the Indicators
// action card). Stages 4–5 are manual toggles persisted to localStorage.
const DEPLOY_STAGES = [
  { n:1, label:"Surveillance",     auto:true,  trigger:"WATCH signal (spread <4.5% & UE <5%)",   note:"All signals within normal range. Monitoring only. No action required." },
  { n:2, label:"Warning",          auto:true,  trigger:"ALERT signal (spread >4.5% OR UE >5%)",  note:"Buy first insurance tranche. SPY puts 90% strike, 90-day expiry, ~1.5% of portfolio in premium. Reduce leveraged positions." },
  { n:3, label:"Correction Onset", auto:true,  trigger:"DANGER signal (spread >6% OR UE >5.5%)", note:"Full insurance active. Deploy no new equity. Let puts work. Path 2 corrections average 18 months — do not deploy cash yet." },
  { n:4, label:"Deploy",           auto:false, trigger:"Manual toggle — judgment call",          note:"Fed pivot confirmed. Two-step sequence: (1) Rotate USFR → IEF immediately on pivot signal — captures rate duration appreciation while assessing equity entry. (2) Begin equity deployment 30-60 days after first cut — software sleeve first (NOW, DDOG, CRWD, PLTR, SNOW), then hardware fills (ASML, AVGO, AMAT), then ARM adds at $360-375. Roll IEF proceeds into equities as positions fill. Maintain 25% cash floor throughout — this never reaches zero." },
  { n:5, label:"Full Deployment",  auto:false, trigger:"Manual toggle — judgment call",          note:"Fully deployed. Drift toward 50/50 hardware/software by mid-2027. Roll off insurance as VIX normalises below 20." },
];

// ─── INCOME PLAYS ─────────────────────────────────────────────────────────────
const INCOME_PLAYS = [
  {
    rank:1, defRank:5, refRank:5, infRank:1, category:"Energy Pipelines / MLPs", icon:"🛢️", yieldRange:"5–9%", stagProof:true,
    color:"#B45309", bg:"#FFFBEB",
    why:"Toll-road model — fee-based contracts insulated from commodity price swings. AI data center power demand driving new gas pipeline demand. Pass inflation through contract escalators.",
    globalNote:"Canadian & HK holders: use AMLP ETF to avoid K-1 tax form complexity. US withholding on distributions varies — check with local tax advisor.",
    risks:"MLPs issue K-1 tax forms (complex for international filers). Distribution cuts possible in severe oil crashes.",
    tickers:[
      {t:"EPD",  name:"Enterprise Products Partners", yield:"6.8%", note:"27 consecutive distribution increases. A- credit. Best in class."},
      {t:"ET",   name:"Energy Transfer",              yield:"7.5%", note:"Largest US midstream network. Higher yield, more leverage."},
      {t:"MPLX", name:"MPLX LP",                     yield:"8.1%", note:"Marathon Petroleum subsidiary. Highest yield of majors."},
      {t:"KMI",  name:"Kinder Morgan",               yield:"5.2%", note:"C-corp structure — no K-1. Better for international accounts."},
      {t:"AMLP", name:"Alerian MLP ETF",             yield:"7.2%", note:"ETF wrapper avoids K-1. Best for HK/Canada holders."},
      {t:"ENB",  name:"Enbridge (TSX/NYSE)",         yield:"5.0%", note:"30+ consecutive dividend increases. ~5% yield. 98% contracted. Best-in-class pipeline income. 15% Canadian withholding tax."},
      {t:"ADNOCGAS.AE", name:"ADNOC Gas (ADX)",      yield:"5.0%", note:"UAE energy infrastructure. Inflation pass-through. Stable dividends. Zero UAE tax. Check ADX directly for price.", link:"https://www.adx.ae"},
      {t:"0883.HK", name:"CNOOC (HKEX)",             yield:"7.0%", note:"~6-8% yield. Chinese offshore oil. High yield energy income. China geopolitical risk — tactical only. Zero HK withholding tax.", link:"https://www.hkex.com.hk"},
    ],
  },
  {
    rank:2, defRank:3, refRank:1, infRank:3, category:"Triple-Net Lease REITs", icon:"🏪", yieldRange:"4–7%", stagProof:true,
    color:"#1E40AF", bg:"#EFF6FF",
    why:"Tenants pay taxes, insurance, maintenance. Landlord gets pure rental income insulated from rising costs. Long-term leases = predictable cash flows. Monthly payers available.",
    globalNote:"Accessible via IBKR from all your family jurisdictions. 30% US withholding for non-US (15% for Canada under treaty, 30% for HK unless treaty applies).",
    risks:"Rate sensitivity — REIT prices fall when rates rise. Commercial real estate weakens in severe recessions.",
    tickers:[
      {t:"O",    name:"Realty Income",   yield:"5.8%", note:"667 consecutive monthly dividends since 1969. Gold standard."},
      {t:"NNN",  name:"NNN REIT",        yield:"5.7%", note:"35yr dividend increases. 3,500+ retail properties."},
      {t:"WPC",  name:"W.P. Carey",      yield:"5.9%", note:"Industrial + retail + office. International exposure."},
      {t:"STAG", name:"STAG Industrial", yield:"4.3%", note:"Industrial/logistics. Monthly dividend."},
      {t:"EMAAR.AE", name:"Emaar Properties (DFM)", yield:"7.0%", note:"~7% dividend yield. Dominant Dubai developer. Tied to UAE premium property demand. Zero UAE tax. Price: check DFM directly.", link:"https://www.dfm.ae"},
    ],
  },
  {
    rank:3, defRank:2, refRank:2, infRank:4, category:"Dividend Aristocrats", icon:"👑", yieldRange:"2.5–5%", stagProof:true,
    color:"#5B21B6", bg:"#F5F3FF",
    why:"25+ years of consecutive dividend increases. Pricing power means dividends grow with inflation. Capital preservation + income growth.",
    globalNote:"Most accessible globally via IBKR. 15% US withholding for Canada (treaty), 30% for HK. SCHD is the ETF wrapper with quality screening.",
    risks:"Lower current yields than MLPs/REITs. Slower income build but more reliable long-term.",
    tickers:[
      {t:"PG",   name:"Procter & Gamble",              yield:"2.5%", note:"69yr streak. Dividend King."},
      {t:"KO",   name:"Coca-Cola",                      yield:"2.7%", note:"62yr streak. Berkshire's #3."},
      {t:"JNJ",  name:"Johnson & Johnson",              yield:"3.1%", note:"62yr streak. Healthcare moat."},
      {t:"SCHD", name:"Schwab US Dividend Equity ETF",  yield:"3.8%", note:"Best dividend growth ETF. Quality-screened."},
      {t:"VIG",  name:"Vanguard Dividend Appreciation", yield:"1.8%", note:"Dividend growth focus. Lower yield, higher quality."},
      {t:"FTS",  name:"Fortis Inc (TSX/NYSE)",          yield:"3.3%", note:"Utility · 52 consecutive dividend increases. ~3.3% yield. Regulated utility. 15% Canadian withholding tax."},
      {t:"DEWA.AE", name:"DEWA (DFM)",                  yield:"4.5%", note:"Utility · Dubai electricity/water monopoly. ~4-5% yield. Regime-agnostic defensive income. Zero UAE tax. Check DFM for price.", link:"https://www.dfm.ae"},
      {t:"0005.HK", name:"HSBC Holdings (HKEX)",        yield:"6.5%", note:"Financials · ~6-7% yield. Global bank, Asia-focused. Consistent dividends. Zero HK withholding tax.", link:"https://www.hkex.com.hk"},
      {t:"FAB.AE", name:"First Abu Dhabi Bank (ADX)",   yield:"5.5%", note:"Financials · UAE's largest bank. ~5-6% yield. USD-pegged income. Zero UAE tax. Check ADX for price.", link:"https://www.adx.ae"},
      {t:"1299.HK", name:"AIA Group (HKEX)",            yield:"2.0%", note:"Financials · Pan-Asian life insurer. ~2% yield but strong dividend growth. Growing Asian middle class tailwind. Zero HK withholding tax.", link:"https://www.hkex.com.hk"},
      {t:"3070.HK", name:"Hang Seng China High Div ETF", yield:"6.0%", note:"Financials/ETF · Broad HK/China high-dividend exposure. ~5-7% yield. Alternative to individual H-shares. Zero HK withholding tax.", link:"https://www.hkex.com.hk"},
    ],
  },
  {
    rank:4, defRank:6, refRank:3, infRank:2, category:"Covered Call ETFs", icon:"📈", yieldRange:"7–12%", stagProof:false,
    color:"#166534", bg:"#F0FDF4",
    why:"Sell calls against existing holdings to generate premium income. Works well in volatile, sideways markets — exactly the stagflationary environment. Non-correlated income.",
    globalNote:"Accessible from all jurisdictions via IBKR. Income treated as ordinary income in most jurisdictions.",
    risks:"You give up upside beyond the strike. Income falls in low-volatility bull markets. Net losers in strong rallies.",
    tickers:[
      {t:"JEPI",  name:"JPMorgan Equity Premium Income", yield:"7.5%",  note:"S&P 500 covered calls. Monthly income."},
      {t:"JEPQ",  name:"JPMorgan Nasdaq Equity Premium", yield:"9.2%",  note:"Nasdaq covered calls. Higher yield."},
      {t:"XYLD",  name:"Global X S&P 500 Covered Call",  yield:"10.5%", note:"At-the-money calls. High income, capped appreciation."},
    ],
  },
  {
    rank:5, defRank:4, refRank:4, infRank:5, category:"Preferred Shares", icon:"💳", yieldRange:"5–8%", stagProof:false,
    color:"#0F766E", bg:"#F0FDFA",
    why:"Fixed dividend, senior to common equity, junior to debt. Yielding 6–7% currently. More liquid than bonds.",
    globalNote:"Monthly income. Subject to US withholding. PFF is the most accessible ETF wrapper.",
    risks:"Rate sensitive. Callable risk. Not ideal in rising rate environment.",
    tickers:[
      {t:"PFF",  name:"iShares Preferred & Income Securities", yield:"6.2%", note:"Largest preferred ETF. 500+ holdings."},
      {t:"PFFD", name:"Global X U.S. Preferred ETF",          yield:"6.8%", note:"Monthly income. Lower fee than PFF."},
    ],
  },
  {
    rank:6, defRank:1, refRank:6, infRank:6, category:"Short-Duration / Cash", icon:"💵", yieldRange:"3.5–5%", stagProof:true,
    color:"#374151", bg:"#F9FAFB",
    why:"T-bills yield ~4.2% — risk-free income while you wait for dislocations. Berkshire's $397B strategy. Optionality > chasing yield in uncertain environments.",
    globalNote:"Best for all your family members as safe USD yield. Fully liquid. No withholding tax complexity.",
    risks:"Yield falls when Fed cuts. No capital appreciation. Inflation erodes real returns over time.",
    tickers:[
      {t:"BIL",  name:"SPDR 1-3 Month T-Bill ETF",          rateLinked:true, note:"Safest USD yield. Essentially cash with income."},
      {t:"SGOV", name:"iShares 0-3 Month T-Bill",           rateLinked:true, note:"Minimal duration risk."},
      {t:"USFR", name:"WisdomTree Floating Rate Treasury",  rateLinked:true, note:"Adjusts with Fed. Rate rise protection."},
    ],
  },
];

// ─── FUND DEFAULTS ────────────────────────────────────────────────────────────
const DEFAULT_FUNDS = [
  {
    id:"berkshire", name:"Berkshire Hathaway", manager:"Greg Abel (Buffett chairman)",
    aum:"$323.8B equity (Q2 13F) · $365.5B cash (Q2 10-Q, Aug 8)", style:"Quality compounder / Value", color:"#1E40AF",
    turnover:"Low–Medium", signal:"NET BUYER", signalColor:"#166534",
    lastUpdated:"Q2 2026 · as of Jun 30 · cash Q2 10-Q Aug 8",
    regimeBet:"Deploying — net buyer (first cash drawdown in ~4yr)",
    regimeBetColor:"#166534",
    regimeBetSignal:"NOT agnostic in Q2: net buyer of ~$19.8B ($23.5B bought vs $3.7B sold) — the largest single-quarter net buying in 3.5yr, ending a 14-quarter selling streak. Cash FELL to $365.5B (Q2 10-Q, Aug 8) from $397B — its first quarterly decline in ~4 years. Buybacks $4.5B (vs $235M in Q1).",
    thesis:"Q2 marks a turn: after 14 straight quarters of net selling, Berkshire was a NET BUYER of ~$19.8B ($23.5B purchased vs $3.7B sold) — the biggest single-quarter net buying in at least 3.5 years — and bought back $4.5B of stock (vs $235M in Q1). Cash fell to $365.5B (Q2 10-Q, Aug 8) from $397B, the first quarterly decline in ~4 years. The equity story is still Alphabet: GOOGL added to $28.2B plus a new $9.6B GOOG Class C stake (~12.6%, top-4, its most AI-adjacent bet though still no chips), on top of a separate $10B Alphabet private placement outside the 13F. Top five are now ~66% of the $323.8B book, up ~5pts q/q. Value/quality, not growth. Positions as of Jun 30.",
    holdings:[
      {name:"AAPL", shares:227917808, pct:22.0,value:65.95,sector:"Tech",      action:"hold"},
      {name:"AXP",  shares:151610700, pct:17.1,value:51.28,sector:"Financials",action:"hold"},
      {name:"KO",   shares:400000000, pct:10.9,value:32.51,sector:"Consumer",  action:"hold"},
      {name:"GOOGL",shares:78791167, pct:9.4, value:28.16,sector:"Tech",      action:"added"},
      {name:"BAC",  shares:483394015, pct:9.2, value:27.54,sector:"Financials",action:"hold"},
      {name:"CVX",  shares:84375856, pct:4.7, value:13.99,sector:"Energy",    action:"hold"},
      {name:"OXY",  shares:264941431, pct:4.3, value:12.87,sector:"Energy",    action:"hold"},
      {name:"CB",   shares:34249183, pct:3.9, value:11.67,sector:"Insurance", action:"hold"},
      {name:"MCO",  shares:24669778, pct:3.7, value:11.17,sector:"Financials",action:"hold"},
      {name:"GOOG", shares:27188433, pct:3.2, value:9.61,sector:"Tech",       action:"bought"},
      {name:"KHC",  shares:325634818, pct:2.6, value:7.69,sector:"Consumer",   action:"hold"},
      {name:"DVA",  shares:28880209, pct:2.1, value:6.43,sector:"Healthcare", action:"hold"},
      {name:"DAL",  shares:57320000, pct:1.8, value:5.37,sector:"Airlines",   action:"hold"},
      {name:"Other",pct:5.0, value:15.1,sector:"Mix",        action:"hold"},
    ],
    sectors:[{name:"Tech",pct:35},{name:"Financials",pct:30},{name:"Consumer",pct:13},{name:"Energy",pct:9},{name:"Insurance",pct:4},{name:"Healthcare",pct:2},{name:"Airlines",pct:2},{name:"Other",pct:5}],
    recentBuys:["Alphabet GOOGL — added +$11.6B → $28.2B","Alphabet GOOG Class C — new $9.6B","Combined Alphabet ~12.6% (top-4)"],
    recentSells:["(no confirmed Q2 exits vs the Q1 book)"],
    radar:[{axis:"Value",score:88},{axis:"Growth",score:35},{axis:"Defensiveness",score:83},{axis:"AI Exposure",score:48},{axis:"International",score:10},{axis:"Income",score:68}],
  },
  {
    id:"pershing", name:"Pershing Square", manager:"Bill Ackman",
    aum:"$19.5B (Q2 13F, via Pershing Square Inc.)", style:"Concentrated activist", color:"#6D28D9",
    turnover:"Medium", signal:"QUALITY COMPOUNDERS", signalColor:"#1E40AF",
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"Quality compounding / soft landing",
    regimeBetColor:"#6D28D9",
    regimeBetSignal:"Q2 book now filed via the public parent Pershing Square Inc. (Capital Management filed a 13F-NT notice). NEW Visa, Mastercard, S&P Global, Netflix — a tilt into payment networks and financial-data compounders. Uber now #1; Amazon trimmed. Not crisis positioning.",
    thesis:"Q2: reporting consolidated under the public parent Pershing Square Inc. — Capital Management filed a 13F-NT notice pointing to the parent, whose filing now carries the whole $19.5B book. Diversified out of the ultra-concentrated 10-name Q1 book: NEW stakes in Visa, Mastercard, S&P Global and Netflix (payment networks + financial-data compounders) plus a Pershing Square USA Ltd position. Uber is now #1 (added), ahead of Brookfield (trimmed) and Microsoft (added); Amazon trimmed ~25%; the small Alphabet stub exited. Still quality compounders, not crisis positioning. Positions as of Jun 30.",
    holdings:[
      {name:"UBER", shares:34326200, pct:12.7,value:2.48,sector:"Transport",     action:"added"},
      {name:"BN",   shares:57481047, pct:12.6,value:2.45,sector:"Alts/RE",       action:"trim"},
      {name:"MSFT", shares:6206730, pct:11.9,value:2.32,sector:"Tech",          action:"added"},
      {name:"AMZN", shares:8563857, pct:10.5,value:2.04,sector:"Tech",          action:"trim"},
      {name:"HHH",  shares:27852064, pct:10.2,value:1.99,sector:"Real Estate",   action:"hold"},
      {name:"QSR",  shares:25821284, pct:9.6, value:1.87,sector:"Consumer",      action:"added"},
      {name:"META", shares:3196062, pct:9.3, value:1.80,sector:"Tech",          action:"added"},
      {name:"V",    shares:3270470, pct:5.8, value:1.12,sector:"Payments",      action:"bought"},
      {name:"MA",   shares:2124646, pct:5.6, value:1.09,sector:"Payments",      action:"bought"},
      {name:"SPGI", shares:2593155, pct:5.4, value:1.06,sector:"Fin Data",      action:"bought"},
      {name:"NFLX", shares:13081465, pct:4.8, value:0.93,sector:"Tech/Media",    action:"bought"},
      {name:"Other",pct:1.6, value:0.32,sector:"Mix (PSUS, Seaport, Hertz)", action:"hold"},
    ],
    sectors:[{name:"Tech",pct:35},{name:"Payments/Fin-Data",pct:17},{name:"Alts/RE",pct:23},{name:"Transport",pct:13},{name:"Consumer",pct:10},{name:"Other",pct:2}],
    recentBuys:["Visa, Mastercard, S&P Global, Netflix (NEW compounders)","Uber (added — now #1)","Meta + QSR + MSFT (added)"],
    recentSells:["Amazon (trimmed ~25%)","Alphabet (exited small stub)","Brookfield (trimmed)"],
    radar:[{axis:"Value",score:62},{axis:"Growth",score:66},{axis:"Defensiveness",score:52},{axis:"AI Exposure",score:52},{axis:"International",score:22},{axis:"Income",score:32}],
  },
  {
    id:"bridgewater", name:"Bridgewater Associates", manager:"Karniol-Tambour / Prince / Jensen",
    aum:"$24.4B (13F) · $92B total", style:"Global macro / Risk parity", color:"#166534",
    turnover:"High (~40%)", signal:"AI CHIPS + GOLD", signalColor:"#92400E",
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"Stagflation + normalization",
    regimeBetColor:"#92400E",
    regimeBetSignal:"Still adding AI chips (NVDA/AVGO/LRCX/AMD) alongside gold (Newmont + Barrick). Hedging both stagflation and recovery.",
    thesis:"~1,000 holdings — a systematic risk-parity book, not stock-picking. Core is the S&P 500 ETFs (SPY + IVV ≈ 25%), then a long diversified tail: AI/semis (NVDA, AVGO, LRCX, AMD, AMAT, MU) and mega-cap tech (GOOGL, MSFT, ORCL), with a gold tilt (Newmont + Barrick) and Korea (EWY). Q2: chip sleeve maintained/added, added Seagate + GE Vernova in the AI-infra tail. Broad equity beta tilted to AI infrastructure, hedged with gold and international. Positions as of Jun 30.",
    holdings:[
      {name:"SPY",  shares:5320308, pct:16.3,value:3.97,sector:"Passive",     action:"trim"},
      {name:"IVV",  shares:3002286, pct:9.2, value:2.25,sector:"Passive",     action:"trim"},
      {name:"NVDA", shares:3866195, pct:3.2, value:0.77,sector:"Semis",       action:"added"},
      {name:"AVGO", shares:1317923, pct:2.0, value:0.50,sector:"Semis",       action:"added"},
      {name:"AMZN", shares:2025481, pct:2.0, value:0.48,sector:"Consumer",    action:"hold"},
      {name:"GOOGL",shares:1322176, pct:1.9, value:0.47,sector:"Tech",        action:"hold"},
      {name:"LRCX", shares:938224, pct:1.7, value:0.41,sector:"Semis",       action:"hold"},
      {name:"VOO",  shares:458381, pct:1.3, value:0.31,sector:"Passive",     action:"hold"},
      {name:"AMD",  shares:538632, pct:1.3, value:0.31,sector:"Semis",       action:"hold"},
      {name:"EWY",  shares:1384772, pct:1.1, value:0.28,sector:"EM/Korea",    action:"hold"},
      {name:"MSFT", shares:711896, pct:1.1, value:0.27,sector:"Tech",        action:"hold"},
      {name:"NEM",  shares:2695170, pct:1.0, value:0.25,sector:"Gold",        action:"added"},
      {name:"AMAT", shares:291426, pct:0.9, value:0.21,sector:"Semis",       action:"hold"},
      {name:"ORCL", shares:1432967, pct:0.9, value:0.21,sector:"Tech",        action:"hold"},
      {name:"STX",  shares:199822, pct:0.8, value:0.19,sector:"Semis",       action:"bought"},
      {name:"Other",pct:55.3,value:13.5,sector:"Mix",         action:"hold"},
    ],
    sectors:[{name:"Passive ETFs",pct:27},{name:"Semis/AI",pct:11},{name:"Tech/Cloud",pct:6},{name:"Gold/Commodities",pct:3},{name:"EM/Intl",pct:8},{name:"Consumer",pct:6},{name:"Other",pct:39}],
    recentBuys:["NVDA (added — largest single stock)","Seagate STX (added)","GE Vernova, Celestica (AI-infra tail)"],
    recentSells:["SPY / IVV (trimmed — still the core)"],
    radar:[{axis:"Value",score:50},{axis:"Growth",score:62},{axis:"Defensiveness",score:63},{axis:"AI Exposure",score:78},{axis:"International",score:78},{axis:"Income",score:45}],
  },
  {
    id:"duquesne", name:"Duquesne Family Office", manager:"Stanley Druckenmiller",
    aum:"$5.2B (13F)", style:"Global macro / Top-down rotator", color:"#B45309",
    turnover:"Very High (38–43%)", signal:"EM + COMMODITIES", signalColor:"#6D28D9",
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"Stagflation / supercycle",
    regimeBetColor:"#B45309",
    regimeBetSignal:"~25–30% gold off-13F — held through gold's worst quarter since 2013 (−20–24%), now +17% in August. EM hard assets (Brazil/Argentina). Q2 reversal: re-entered AMZN + GOOGL after exiting in Q1.",
    thesis:"Q2 reversal — RE-ENTERED mega-cap tech (AMZN + GOOGL) after fully exiting both in Q1. Natera (NTRA) still #1 at 16.6%; biotech sleeve (INSM, Revolution, NewAmsterdam) deep. New STMicro (STM); semis via TSM, Seagate, SanDisk. EM/macro: Brazil (EWZ + calls), Argentina (YPF), Mexico (BBB Foods), Sea Ltd. Heavy call usage for leverage (RSP/IWM/SPY/EWZ/INSM/TSLA calls, in Other). ~25–30% gold remains off-13F. GOLD MARK-TO-MARKET: the position was deeply underwater at the filing date — gold fell 20–24% in Q2 (its worst quarter since 2013) from a Jan 28 record near $5,589 to ~$4,000 by Aug 1 — and is now the best-performing bet in the set: ~$4,680 today (GLD 427.33), ~+17% in August, its best month since January. Positions as of Jun 30.",
    holdings:[
      {name:"NTRA", shares:3186306, pct:16.6,value:0.86,sector:"Biotech",      action:"hold"},
      {name:"TSM",  shares:589680, pct:5.4, value:0.28,sector:"Semis",        action:"added"},
      {name:"STM",  shares:3102880, pct:4.5, value:0.23,sector:"Semis",        action:"bought"},
      {name:"INSM", shares:1424690, pct:2.9, value:0.15,sector:"Biotech",      action:"added"},
      {name:"YPF",  shares:3138897, pct:2.7, value:0.14,sector:"EM/Argentina", action:"added"},
      {name:"AMZN", shares:541600, pct:2.5, value:0.13,sector:"Consumer",     action:"bought"},
      {name:"BBB",  shares:2901733, pct:2.3, value:0.12,sector:"EM/Mexico",    action:"bought"},
      {name:"GOOGL",shares:336300, pct:2.3, value:0.12,sector:"Tech",         action:"bought"},
      {name:"EWZ",  shares:3436170, pct:2.3, value:0.12,sector:"EM/Brazil",    action:"hold"},
      {name:"STX",  shares:122000, pct:2.3, value:0.12,sector:"Semis",        action:"hold"},
      {name:"FOXA", shares:2204600, pct:2.2, value:0.11,sector:"Media",        action:"bought"},
      {name:"UAL",  shares:794795, pct:2.1, value:0.11,sector:"Airlines",     action:"bought"},
      {name:"SE",   shares:1099905, pct:2.0, value:0.11,sector:"China/EM",     action:"hold"},
      {name:"CDW",  shares:743950, pct:2.0, value:0.10,sector:"Tech",         action:"bought"},
      {name:"Other",pct:47.9,value:2.49,sector:"Mix (incl. RSP/EWZ/INSM/IWM/TSLA calls)", action:"mixed"},
    ],
    sectors:[{name:"Biotech/Health",pct:26},{name:"Semis/AI",pct:14},{name:"EM / Macro ETFs",pct:18},{name:"Tech",pct:7},{name:"Gold/Commodities (off-13F)",pct:25},{name:"Other",pct:10}],
    recentBuys:["STMicro STM (new)","AMZN + GOOGL (re-entered mega-cap)","YPF, Fox, United, CDW (added)"],
    recentSells:["(rotated within EM/biotech; gold stays off-13F)"],
    radar:[{axis:"Value",score:42},{axis:"Growth",score:58},{axis:"Defensiveness",score:30},{axis:"AI Exposure",score:55},{axis:"International",score:85},{axis:"Income",score:20}],
  },
  {
    id:"tiger", name:"Tiger Global", manager:"Chase Coleman",
    aum:"$24B", style:"Global tech / Growth", color:"#BE185D",
    turnover:"High", signal:"TECH BULL", signalColor:"#166534",
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"Reflationary recovery",
    regimeBetColor:"#166534",
    regimeBetSignal:"AI chips moved to the TOP — TSM now #1, added Lam/Applied, NEW Cerebras, re-entered Intel. Trimmed GOOGL from #1.",
    thesis:"Q2: the AI-chip sleeve moved to the very top — TSM is now #1 (added), with NVDA, Lam (added), Applied Materials (added), Broadcom, a NEW Cerebras (private-AI-chip) stake, and a RE-ENTERED Intel. GOOGL trimmed from #1 to ~8.7%. Still AI-consensus at the core, now tilted toward the picks-and-shovels chip layer. Sea Ltd (SE) the SE-Asia growth play; Corpay + GE Vernova the non-tech adds. Positions as of Jun 30.",
    holdings:[
      {name:"TSM",   shares:4881008, pct:9.7, value:2.33,sector:"Semis",      action:"added"},
      {name:"AMZN",  shares:9683558, pct:9.6, value:2.31,sector:"Tech",       action:"hold"},
      {name:"NVDA",  shares:11198773, pct:9.3, value:2.24,sector:"Semis",      action:"hold"},
      {name:"GOOGL", shares:5805687, pct:8.7, value:2.07,sector:"Tech",       action:"trim"},
      {name:"META",  shares:2823180, pct:6.6, value:1.59,sector:"Tech",       action:"hold"},
      {name:"LRCX",  shares:3163495, pct:5.7, value:1.37,sector:"Semis",      action:"added"},
      {name:"SE",    shares:12559152, pct:5.0, value:1.20,sector:"China/EM",   action:"hold"},
      {name:"AMAT",  shares:1632210, pct:4.9, value:1.18,sector:"Semis",      action:"added"},
      {name:"GEV",   shares:797511, pct:3.9, value:0.94,sector:"Industrials",action:"hold"},
      {name:"MSFT",  shares:2266913, pct:3.5, value:0.85,sector:"Tech",       action:"hold"},
      {name:"CPAY",  shares:2149877, pct:3.0, value:0.72,sector:"Fintech",    action:"hold"},
      {name:"CBRS",  shares:2999000, pct:2.8, value:0.66,sector:"Semis/AI",   action:"bought"},
      {name:"AVGO",  shares:1754062, pct:2.8, value:0.66,sector:"Semis",      action:"hold"},
      {name:"INTC",  shares:4252690, pct:2.5, value:0.59,sector:"Semis",      action:"bought"},
      {name:"Other", pct:22.0,value:5.29,sector:"Mix",        action:"hold"},
    ],
    sectors:[{name:"Semis/AI",pct:38},{name:"Tech/Internet",pct:28},{name:"China/EM",pct:8},{name:"Industrials",pct:4},{name:"Fintech",pct:3},{name:"Other",pct:19}],
    recentBuys:["Cerebras CBRS (new AI-chip)","Intel (re-entered)","Lam + Applied Materials (added)"],
    recentSells:["GOOGL (trimmed from #1)"],
    radar:[{axis:"Value",score:30},{axis:"Growth",score:90},{axis:"Defensiveness",score:20},{axis:"AI Exposure",score:90},{axis:"International",score:42},{axis:"Income",score:15}],
  },
  {
    id:"appaloosa", name:"Appaloosa Management", manager:"David Tepper",
    aum:"$~20B", style:"Distressed / Deep value", color:"#D97706",
    turnover:"Medium–High", signal:"CHINA + CYCLICALS", signalColor:"#B45309",
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"China recovery + soft landing",
    regimeBetColor:"#D97706",
    regimeBetSignal:"AMZN top; Micron (AI memory) now top-2. Added Korea (EWY). NEW: an AAPL PUT hedge. BABA trimmed further — China conviction cut.",
    thesis:"Q2: Micron (MU) surged to top-2 (14.6%) — a large AI-memory bet — behind AMZN. Semis/AI sleeve deep (MU, TSM, NVDA, Lam, AMD, ASML, Broadcom, Qualcomm). Notable NEW hedge: an AAPL PUT (~3.1%). Added Korea (EWY to 6.3%); new Boeing, CoreWeave, ASML. BABA trimmed further to ~2.5% — the China bet is being cut, not held. Power-demand play (Vistra + NRG) held. Positions as of Jun 30.",
    holdings:[
      {name:"AMZN",     shares:5000000, pct:15.4,value:1.19,sector:"Tech",        action:"hold"},
      {name:"MU",       shares:975000, pct:14.6,value:1.13,sector:"Semis/AI",    action:"added"},
      {name:"TSM",      shares:1650000, pct:10.2,value:0.79,sector:"Semis/AI",    action:"hold"},
      {name:"GOOG",     shares:1850000, pct:8.5, value:0.65,sector:"Tech",        action:"hold"},
      {name:"UBER",     shares:7694071, pct:7.2, value:0.56,sector:"Consumer",    action:"hold"},
      {name:"EWY",      shares:2425000, pct:6.3, value:0.49,sector:"EM/Korea",    action:"added"},
      {name:"META",     shares:675000, pct:4.9, value:0.38,sector:"Tech",        action:"hold"},
      {name:"VST",      shares:2215272, pct:4.5, value:0.35,sector:"Energy",      action:"hold"},
      {name:"NVDA",     shares:1525000, pct:3.9, value:0.31,sector:"Semis/AI",    action:"hold"},
      {name:"NRG",      shares:1760000, pct:3.3, value:0.26,sector:"Energy",      action:"hold"},
      {name:"AAPL put", pct:3.1, value:0.24,sector:"Hedge",       action:"bought"},
      {name:"BABA",     shares:2000000, pct:2.5, value:0.19,sector:"China/EM",    action:"trim"},
      {name:"BA",       shares:800000, pct:2.2, value:0.17,sector:"Industrials", action:"bought"},
      {name:"LRCX",     shares:382500, pct:2.1, value:0.17,sector:"Semis/AI",    action:"hold"},
      {name:"Other",    pct:11.3,value:0.85,sector:"Mix (BIDU, AAL, AMD, CoreWeave, ASML, QCOM)", action:"mixed"},
    ],
    sectors:[{name:"Semis/AI",pct:35},{name:"Tech/Internet",pct:29},{name:"EM/Korea",pct:6},{name:"Energy/Power",pct:8},{name:"China",pct:4},{name:"Consumer",pct:7},{name:"Hedge (AAPL put)",pct:3},{name:"Other",pct:8}],
    recentBuys:["Micron MU (AI memory — now top-2)","EWY Korea (added)","Boeing, CoreWeave, ASML (new)"],
    recentSells:["AAPL put initiated (hedge)","BABA (trimmed further — China cut)"],
    radar:[{axis:"Value",score:70},{axis:"Growth",score:62},{axis:"Defensiveness",score:35},{axis:"AI Exposure",score:72},{axis:"International",score:52},{axis:"Income",score:28}],
  },
  {
    id:"fairfax", name:"Fairfax Financial Holdings", manager:"Prem Watsa",
    aum:"~$75B (insurance + investment portfolio)", style:"Value / Insurance Float", color:"#A16207",
    turnover:"Low (buy & hold)", signal:"MACRO HEDGE + INDIA", signalColor:"#B45309",
    lastUpdated:"⚠ Annual Report 2025 · not a US 13F filer — H1 2026 interim not fetched this run",
    regimeBet:"INFLATION + DEFLATION HEDGE",
    regimeBetColor:"#B45309",
    regimeBetSignal:"⚠ Not on EDGAR (Canadian, files on SEDAR+). Not refreshed this cycle — pull Fairfax's H1 2026 interim report + hedge disclosures manually. Long India/EM structural bet. CPI-linked hedges + tail protection.",
    thesis:"The 'Canadian Berkshire.' Watsa runs a massive insurance float like Buffett — but with a harder macro edge. Known for prescient macro calls: shorted the US housing market pre-2008, held CPI-linked derivatives for years anticipating inflation. Currently positioned with significant equity exposure in India and emerging markets, commodity-linked names, and tail hedges. Watsa has been consistently bullish on India as a decade-long structural bet. Canadian-listed (TSX: FFH). Holdings from annual report — not a US 13F filer.",
    holdings:[
      {name:"EUROB.AT",pct:22,value:6.6,sector:"Financials",  action:"hold"},
      {name:"FFXDF",   pct:15,value:4.5,sector:"India/EM",    action:"added"},
      {name:"KW",      pct:11,value:3.3,sector:"Real Estate", action:"hold"},
      {name:"BB",      pct:9, value:2.7,sector:"Tech",        action:"hold"},
      {name:"CIBEY",   pct:9, value:2.7,sector:"Financials",  action:"hold"},
      {name:"ORLA",    pct:8, value:2.4,sector:"Commodities", action:"added"},
      {name:"FRFHF",   pct:8, value:2.4,sector:"Insurance",   action:"hold"},
      {name:"DXT.TO",  pct:6, value:1.8,sector:"Services",    action:"hold"},
      {name:"Other",   pct:12,value:3.6,sector:"Mix",         action:"hold"},
    ],
    sectors:[{name:"Financials/Insurance",pct:35},{name:"India/EM",pct:25},{name:"Commodities",pct:15},{name:"Other/Hedges",pct:25}],
    recentBuys:["FFXDF (Fairfax India — structural add)","ORLA (gold / commodity exposure)","EUROB.AT (Eurobank — core financials)"],
    recentSells:["Trimmed US equity beta","Reduced long-duration bond exposure"],
    radar:[{axis:"Value",score:90},{axis:"Growth",score:30},{axis:"Defensiveness",score:70},{axis:"AI Exposure",score:20},{axis:"International",score:80},{axis:"Income",score:50}],
  },
];

// The 13F vintage every equity row shares until the next EDGAR refresh. A 13F describes holdings
// AS OF quarter-end and lands up to 45 days later — so it is ~6 weeks stale the day it arrives, and
// says nothing about what changed since. Both dates travel with the data so no row reads as current.
// Q2 2026 vintage. All 6 US 13F filers are in (Berkshire, Pershing, Bridgewater, Duquesne, Tiger,
// Appaloosa, all as of Jun 30, filed by the Aug 14 deadline). Pershing's Q2 book is now filed via its
// public parent Pershing Square Inc. (CIK 0002026053) — Capital Management filed a 13F-NT notice.
// Fairfax is not a US 13F filer. No 13F-HR/A amendments have been filed since the Aug 15 Pass-1 pull.
const MATRIX_13F = { positionsAsOf: "2026-06-30", filed: "Aug 2026 (by Aug 14 deadline)", label: "Q2 2026" };
// Per-row provenance. `source` is the ACTUAL disclosure the row is built from — not everything here
// is 13F. 13F covers LONG US-LISTED EQUITY only; cash, bonds, shorts, options and foreign listings
// are invisible to it, so those rows are tagged to their real source (10-Q / manager disclosure)
// and carry their own as-of, independent of the 13F cycle.
// Columns: [Berkshire, Pershing(Q2), Bridgewater, Duquesne, Tiger, Appaloosa, Fairfax(non-13F)].
const CONSENSUS_ROWS = [
  {theme:"AI Chips / Semis",            source:"13F",  vals:["◯","◯","●","●","●","●","◯"],note:"4/7 heavily long — crowding INTENSIFIED in Q2: Micron top-2 at Appaloosa, NEW Cerebras + Intel re-entry at Tiger, Lam/AMAT added at Tiger+Bridgewater. Berkshire/Pershing hold NO chips (Alphabet is a hyperscaler, not a chip)."},
  {theme:"Hyperscalers (AMZN/GOOG/MSFT)",source:"13F", vals:["●","●","●","◐","●","●","◯"],note:"Berkshire built Alphabet to ~12.6% (GOOGL added + new GOOG Class C, top-4); Druckenmiller RE-ENTERED AMZN+GOOGL after exiting in Q1"},
  {theme:"Legacy SaaS",                 source:"13F",  vals:["◯","◯","◐","◯","◯","◯","◯"],note:"Bridgewater holds ORCL in the tail; no one adding aggressively"},
  {theme:"China / EM",                  source:"13F",  vals:["◯","◯","◐","●","◐","●","●"],note:"Druckenmiller heavy Brazil/Argentina/Mexico; Tepper CUT BABA to ~2.5% (China conviction reduced) while adding Korea (EWY); Fairfax India off-13F"},
  {theme:"Gold / Commodities",          source:"13F+mgr", vals:["◐","◯","◐","●","◯","◐","◐"],note:"Druckenmiller ~25–30% gold off-13F; Bridgewater Newmont+Barrick; Appaloosa power/energy (Vistra/NRG/pipelines); Fairfax commodity-linked"},
  {theme:"Energy / Airlines",           source:"13F",  vals:["●","◯","◯","◐","◯","●","◯"],note:"Berkshire CVX+OXY+DAL; Appaloosa Vistra+NRG+AAL+pipelines (power-demand); Druckenmiller YPF+United"},
  {theme:"Biotech / Healthcare",        source:"13F",  vals:["◐","◯","◯","●","◯","◯","◯"],note:"Druckenmiller deep (Natera #1, Insmed, Revolution, NewAmsterdam); Berkshire holds DaVita"},
  {theme:"Financials / Insurance",      source:"13F+mgr", vals:["●","●","◯","◯","◐","◯","●"],note:"Ackman NEW Visa+Mastercard+S&P Global on top of Brookfield (Q2 — a financial-infrastructure tilt); Tiger Corpay+Apollo+Visa; Berkshire + Fairfax core insurance float is operating, off-13F"},
  {theme:"Cash / T-Bills",             source:"10-Q", asOf:"2026-06-30", vals:["●●","◯","◯","◯","◯","◯","◐"],note:"Berkshire $365.5B (Q2 10-Q, filed Aug 8 — not 13F), DOWN from $397B: first quarterly decline in ~4yr as Berkshire turned net buyer. Fairfax float in T-bills/bonds (annual report)"},
  {theme:"Macro Hedges / Tail Risk",    source:"Manager disclosure", asOf:"ongoing / 2025 AR", vals:["◯","◐","●","◐","◯","◐","●"],note:"Fairfax deflation/CPI hedges; Bridgewater risk-parity; Appaloosa initiated an AAPL PUT (new tail hedge); Druckenmiller heavy call usage"},
];
// How each source tag renders: label + colour. 13F is the default equity vintage; the others are
// deliberately a different hue so a non-13F row can't be mistaken for one that moved on the 13F date.
const SOURCE_TAGS = {
  "13F":     { label: "13F",              col: "#1E40AF" },
  "13F+mgr": { label: "13F + disclosure", col: "#6D28D9" },
  "10-Q":    { label: "10-Q",             col: "#0F766E" },
  "Manager disclosure": { label: "Mgr disclosure", col: "#B45309" },
};

// ── Improvement #2 — 13F COVERAGE per fund. A 13F only shows long US-listed equity; cash, bonds,
// shorts, most options, foreign listings and private books are invisible. This states, per manager,
// how much of the real book the filing actually captures — so the long-only limit is structural, not
// a footnote. Each note cites the disclosed figures the ratio is built from (no invented precision).
const FUND_COVERAGE = {
  berkshire:   { band: "Partial", note: "Shows the ~$324B equity book; the $365.5B cash (Q2 10-Q, Aug 8) is off-13F — the filing is ~47% of the equity+cash balance sheet, and misses the Q2 net-buying + the $10B Alphabet private placement." },
  pershing:    { band: "Most",    note: "Concentrated long US equity — the 13F (filed via the public parent) captures nearly the whole book." },
  bridgewater: { band: "Partial", note: "$24.4B 13F of ~$92B total AUM (~27%); futures, FX and global-macro overlays are off-13F." },
  duquesne:    { band: "Partial", note: "$5.2B 13F, but ~25–30% gold and heavy index/single-name CALL leverage are off-13F — the filing understates both size and leverage." },
  tiger:       { band: "Most",    note: "The US-listed equity core is captured; a large private/VC book (and any pre-listing stakes) sits off-13F." },
  appaloosa:   { band: "Most",    note: "Long US equity captured, and the AAPL PUT shows on-13F; any shorts or non-equity hedges would not." },
  fairfax:     { band: "None",    note: "Not a US 13F filer — files on SEDAR+. Holdings shown are from the 2025 annual report, not a 13F." },
};
const COVERAGE_BAND = {
  Most:    { col: "#166534", bg: "#F0FDF4", bdr: "#86EFAC" },
  Partial: { col: "#B45309", bg: "#FFF7ED", bdr: "#FED7AA" },
  Low:     { col: "#B45309", bg: "#FFF7ED", bdr: "#FED7AA" },
  None:    { col: "#991B1B", bg: "#FEF2F2", bdr: "#FECACA" },
};

// ── B4 — HEDGES per manager. The disclosed downside/tail protection (mostly off-13F), tracked so Q3
// can be diffed for whether hedging SPREADS across the group. `flag:true` = an explicit equity hedge.
const FUND_HEDGES = {
  berkshire:   { text: "None — net long; the (now shrinking) $365.5B cash pile is the de-facto hedge." },
  pershing:    { text: "None disclosed — long-only quality compounders." },
  bridgewater: { text: "Risk-parity overlay + a gold sleeve (Newmont, Barrick) as the portfolio hedge; no single-name equity hedge on the 13F." },
  duquesne:    { text: "Heavy index/single-name CALL usage (RSP/IWM/SPY/EWZ/INSM/TSLA) for leverage — not downside; ~25–30% gold off-13F is the macro hedge." },
  tiger:       { text: "None — an unhedged growth/AI long (style: 90 growth, 20 defensiveness)." },
  appaloosa:   { flag: true, text: "NEW AAPL PUT (~3.1%) — the ONLY explicit equity hedge in the set, run alongside its Micron top-2 long: long the thesis, hedged the multiple." },
  fairfax:     { text: "CPI-linked derivatives + deflation / tail hedges (manager disclosure, off-13F) — the group's most hedge-forward book." },
};

// ── Improvement #3b — NOTABLE ABSENCES. Trades worth checking for; presence/absence is COMPUTED from
// the actual holdings below, so it self-updates (if a manager buys TLT next quarter, it drops off).
// The `why` is the one-line read on what the absence implies.
const ABSENCE_WATCH = [
  { label: "Long-duration Treasuries (TLT / ZROZ / IEF)", tickers: ["TLT", "ZROZ", "IEF"], why: "no one is positioned for a deflationary rate-collapse",
    note: "But the absence is a SUPPLY story, not a 'deflation is impossible' one: the 30Y hit a 19-year high in August and the Treasury DOUBLED its long-end buyback to $4bn/operation (Aug 19) — the long end is selling on issuance + term premium. Meanwhile the labour base has broken down (July payrolls −23k vs +83k expected; 12-mo avg +26k stall speed; May/June revised −103k; emp-pop 58.9%, 2nd decline). If the QCEW benchmark restates the base lower AND the issuer keeps supporting the long end, both objections to owning duration disappear at once — watch Q3 filings." },
  { label: "Index shorts / broad puts (SH / SQQQ / SPXU)", tickers: ["SH", "SQQQ", "SPXU", "PSQ"], why: "no outright bearish index bet — Appaloosa's AAPL put is the lone equity hedge" },
  { label: "Utilities / defensive REITs (XLU / VNQ)", tickers: ["XLU", "VNQ", "XLRE"], why: "no rate-sensitive defensive tilt" },
];

// ── Improvement #1 — mark-to-market since the 13F as-of date. A 13F reports position VALUE ($, at
// quarter-end) and SHARE COUNT, so the implied filing price is value/shares; the live price vs that
// is how the disclosed position has moved since Jun 30. Only computed where BOTH shares (from the
// filing) and a live price exist — never estimated. `h.value` is in $B, `h.shares` a raw share count.
function sinceFiling(h, prices) {
  const p = prices?.[h?.name];
  if (!h?.shares || !(h.shares > 0) || !(p?.price > 0) || !(h.value > 0)) return null;
  const refPrice = (h.value * 1e9) / h.shares;
  if (!(refPrice > 0)) return null;
  return { refPrice: +refPrice.toFixed(2), live: p.price, pct: +((p.price / refPrice - 1) * 100).toFixed(1) };
}
// Value-weighted move of the disclosed (priced) book since the filing date, plus how much of the
// book that covers — so a partial price set never reads as the whole book.
function bookSinceFiling(fund, prices) {
  let movedVal = 0, pricedVal = 0, totalVal = 0;
  for (const h of fund.holdings || []) {
    if (h.name === "Other" || !(h.value > 0)) continue;
    totalVal += h.value;
    const s = sinceFiling(h, prices);
    if (s) { pricedVal += h.value; movedVal += h.value * (s.pct / 100); }
  }
  if (pricedVal <= 0) return null;
  return { pct: +(movedVal / pricedVal * 100).toFixed(1), coveredPct: Math.round(pricedVal / totalVal * 100) };
}

// The four regimes are an IDENTITY palette, not a status palette. They are mutually exclusive
// scenarios and none is "worse" than another — Deflationary Recession is the most damaging
// outcome yet renders calm blue, which is correct, because the colour says WHICH scenario, not
// HOW BAD. That distinction is why these must never be expressed as STATUS tokens: doing so
// would paint 55% Stagflation amber and 20% Deflationary Recession blue, implying stagflation
// is the more severe read. The hues sit deliberately clear of lib/status.js so the two
// vocabularies cannot collide again (check-status-tokens.mjs exempts category palettes by
// design — see its scope note).
const REGIME_PALETTE = Object.freeze({
  stag: { color: "#B45309", bg: "#FEFCE8", bdr: "#FDE68A" },  // amber
  ref:  { color: "#15803D", bg: "#ECFDF5", bdr: "#6EE7B7" },  // green
  def:  { color: "#1E40AF", bg: "#EFF6FF", bdr: "#BFDBFE" },  // blue
  inf:  { color: "#7C3AED", bg: "#F5F3FF", bdr: "#C4B5FD" },  // purple
});

const REGIMES = [
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

// P0.2 — Regime-SHIFT scenarios. The recession-consensus engine produces four states
// (stag/ref/def/inf) and cannot derive these two: Debasement is a currency-devaluation regime and
// Hawkish Rates Repricing is a long-end break — neither is a consensus recession outcome. They are
// resolutions the Insurance tab already carries; the decision they change lives on the Macro tab
// (the parking bucket). So they are presented here as SELECTABLE scenario states you check
// positioning against, explicitly NOT consensus probabilities. Boom ≠ Debasement — kept distinct.
const REGIME_SHIFTS = [
  {
    id:"debase", label:"Debasement", color:"#7C3AED", bg:"#F5F3FF", bdr:"#C4B5FD",
    tag:"currency devaluation · weak growth · suppressed yields",
    desc:"Currency loses purchasing power while real growth stays weak and yields are administratively suppressed below inflation. NOT Inflationary Boom (that is strong growth + inflation).",
    discriminator:"gold up + breakevens UP = confirming · gold up + breakevens FLAT = ambiguous · gold up + breakevens DOWN = a real-yield trade, not debasement",
    best:["Gold / physical (GLD, 2840.HK)","Hard assets / real assets","Bitcoin (as debasement hedge)","TIPS / inflation-linked","Foreign hard-currency assets"],
    worst:["Short-duration T-bills — cash loses purchasing power (the parking bucket is the losing trade here)","Nominal long bonds","Cash (USD)"],
    decision:"⚠ Parking-bucket flip: the USFR/T-bill parking thesis assumes STAGFLATION, where short bills are a best asset. In DEBASEMENT the same bills are the WRONG asset — real value erodes. If the discriminator confirms debasement, the cash bucket must rotate into real assets.",
  },
  {
    id:"hawkish", label:"Hawkish Rates Repricing", color:"#B91C1C", bg:"#FEF2F2", bdr:"#FCA5A5",
    tag:"long-end breaks higher · term premium repricing",
    desc:"The long end reprices higher — 30Y breaks above ~5.35% and rate-sensitives sell together. A duration event, distinct from a growth-driven selloff.",
    discriminator:"30Y > 5.35% AND gold, TLT, XLU, XLP, IWM selling together (a broad rate-sensitive de-rate, not a single-name move)",
    best:["Cash / ultra-short (BIL, SGOV)","Floating-rate (USFR)","Energy / commodities (real-rate resilient)","Value over growth"],
    worst:["Long-duration bonds (TLT, ZROZ)","Rate-sensitive equities (REITs, utilities)","Gold (loses to rising real yields)","High-multiple / unprofitable tech"],
    decision:"Short-duration parking is CORRECT here (cash earns the higher front-end), but any long-duration hedge (TLT) is the wrong side — a hawkish break is exactly when the duration leg breaks.",
  },
  {
    // Aug-24 — financial repression is NOT a Debasement variant: the mechanism is similar but the
    // horizon is DECADES, and it is the tool used to AVOID a crash, not a crash resolution. So it is
    // a structural background STATE, gated on a sustained-negative 10Y real yield (DFII10), and it is
    // deliberately kept off the Insurance tab (which only asks how a crash resolves).
    id:"repress", label:"Financial Repression", color:"#0F766E", bg:"#F0FDFA", bdr:"#5EEAD1",
    tag:"structural · multi-year",
    desc:"Retiring the debt in real terms by holding nominal yields below inflation for years — Dalio's \"artificially low interest rate… the way Japan has done it.\" NOT a crash resolution: repression is the mechanism used to AVOID a crash. Japan ran suppressed JGB yields ~1990–2024 with no crash — the Nikkei peaked in 1989 and did not recover until 2024. Cash bleeds ~1–2%/yr: slow and survivable, not the fast erosion of Debasement.",
    discriminator:"10Y real yield (DFII10) sustained NEGATIVE → repression active · positive → not repression. This IS the definition — the bondholder must receive less than inflation.",
    realYieldGated:true,
    best:["Real assets held for YEARS — physical gold (GLD, 2840.HK), NCREIF-type farmland","Equities with pricing power","TIPS · commodities · foreign hard-currency assets (✅ second tier)"],
    caution:["Cash — loses ~1–2%/yr; survivable, but a slow real bleed. Distinct from Debasement's ⚠️, where cash is wrong QUICKLY."],
    worst:["Nominal long bonds — the asset being repressed","ALL decay instruments (puts · VIX calls · SQQQ) — explicitly excluded: the multi-year horizon guarantees they expire worthless long before the thesis pays"],
    decision:"⚠ Parking-bucket, slow version: in Debasement cash is wrong QUICKLY; in repression cash is wrong SLOWLY — ~1–2% of purchasing power a year. Survivable, and it leaves time to react. Different urgency, same direction: rotate toward real assets, but you are not forced out overnight.",
    counter:"Counter-case (both sides): Japan's repression worked because domestic savers held JGBs and had nowhere else to go. Roughly a third of US Treasuries are held by foreigners who CAN leave — if they do, the outcome is a currency crisis, not orderly repression (a worse outcome that fits no column here). And today's committee points the other way: Warsh is a hawk who stripped forward guidance, three regional presidents dissented FOR a hike in July, and the July minutes recorded 'many participants' saw tightening as likely necessary. Not a repression-friendly Fed. Dalio is describing a PATH, not today's condition.",
  },
];

// CPI tracker series colours — ONE definition shared by the headline tiles, the chart lines
// and the legend, so a tile can never drift out of sync with the line it labels.
const CPI_SERIES = { headline: "#ef4444", core: "#f97316", pce: "#8b5cf6" };

// ─── LIVE CASH YIELD ──────────────────────────────────────────────────────────
// Single source of truth for "what does cash earn right now". Short-Treasury vehicles
// (USFR / SGOV / BIL) and the CPI chart's reference line all resolve through this, so a
// rate move updates every mention at once instead of leaving hardcoded figures behind —
// the previous hardcoded set had drifted ~1.7pp and disagreed with each other (5.3% in two
// posture notes, 4.4% in the ETF list, while Fed funds was 3.63%).
// USFR holds floating-rate Treasuries that reset off T-bill auctions, so the 6M bill is the
// closest keyless proxy; Fed funds is the fallback. Returns null when neither is available —
// callers must then omit the figure rather than print a stale one.
function liveCashYield(liveInd) {
  if (liveInd?.tbill6m != null) return { value: liveInd.tbill6m, src: "6M T-bill", asOf: liveInd?.asOf?.tbill6m ?? null };
  if (liveInd?.currentFedFunds != null) return { value: liveInd.currentFedFunds, src: "Fed funds", asOf: liveInd?.asOf?.currentFedFunds ?? null };
  return null;
}
// Substitute {{CASH}} in authored prose with the live rate. With no live rate the sentence
// degrades to a rate-free phrasing instead of emitting a stale number.
function fillLiveRates(text, cy) {
  if (typeof text !== "string") return text;
  return text.replace(/\{\{CASH\}\}/g, cy ? `~${cy.value.toFixed(2)}% (live, ${cy.src})` : "the prevailing T-bill rate");
}

// ─── FED PATH — market-implied (P6.2) ─────────────────────────────────────────
// The Fed Language card is the QUALITATIVE read; this is the quantitative one beside it.
// There is no free feed for 30-day fed funds futures (ZQ): IBKR has no stateless auth and its
// futures data is ~20-min delayed, so this is a daily hand entry — same pattern as KOFIA.
// ZQ is quoted as 100 − the implied average fed funds rate for the contract month.
// F3 — coordinated FX intervention flag.
//
// Manual on purpose. No keyless feed reports intervention while it is happening; MOF/BOK
// confirmations arrive days later. Inferring it from a wide daily move would manufacture
// exactly the certainty this flag exists to withhold — so it is the operator's call, and the
// annotation says so.
//
// Reads and writes the live store rather than the deployed bundle, so the flag takes effect
// on save instead of waiting for a redeploy. That matters for a switch whose whole purpose is
// to annotate a move that is happening right now.
function InterventionToggle({ jpyChangePct, dxyChangePct, onChange }) {
  const [iv, setIv] = useState(null);
  const [since, setSince] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    fetch("/api/manual-entry").then(r => r.json()).then(j => {
      setIv(j.intervention || null);
      if (j.intervention?.since) setSince(j.intervention.since);
      if (j.intervention?.note) setNote(j.intervention.note);
      onChange?.(j.intervention || null);
    }).catch(() => {});
  }, []);

  const active = !!iv?.active;
  // Preview the annotation the dashboard will show, computed from the same function the
  // server uses — so what you see before saving is what gets rendered after.
  const preview = interventionAnnotation({
    active: true, since: since || new Date().toISOString().slice(0, 10), note: note || null,
    jpyChangePct, dxyChangePct,
  });

  async function toggle(next) {
    setSaving(true); setMsg(null);
    try {
      const body = next
        ? { intervention: { active: true, since: since || new Date().toISOString().slice(0, 10), note: note || null } }
        : { intervention: { active: false } };
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        const fresh = await fetch("/api/manual-entry").then(x => x.json()).catch(() => null);
        setIv(fresh?.intervention || null);
        onChange?.(fresh?.intervention || null);
        setMsg({ ok: true, text: next ? "Intervention flag ON — FX row annotated" : "Flag cleared" });
      } else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }

  const tok = active ? STATUS.WATCH : null;
  return (
    <Card style={active ? { background: tok.bg, border: "1.5px solid " + tok.bdr } : undefined}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>⚑ FX intervention flag</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>manual · no feed reports this live</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6, flexWrap: "wrap" }}>
        <button
          onClick={() => toggle(!active)} disabled={saving}
          style={{
            background: active ? tok.color : "#fff", color: active ? "#fff" : C.mid,
            border: "1.5px solid " + (active ? tok.color : C.bdrMd), borderRadius: 8,
            padding: "6px 14px", fontSize: 12.5, fontWeight: 800,
            cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1,
          }}>
          {saving ? "Saving…" : active ? "● ACTIVE — click to clear" : "○ Off — click to activate"}
        </button>
        {active && iv?.since && (
          <span style={{ fontSize: 11.5, color: tok.color, fontWeight: 700 }}>since {iv.since}</span>
        )}
      </div>

      {/* C5 — prompt when USD/JPY moves >2% in a session: the condition that would have caught the
          Jul 30–31 joint US–Japan intervention. Manual by design — this nudges, it does not auto-set. */}
      {!active && jpyChangePct != null && Math.abs(jpyChangePct) > 2 && (
        <div style={{ marginTop: 8, padding: "8px 11px", background: STATUS.WATCH.bg, border: "1.5px solid " + STATUS.WATCH.bdr, borderRadius: 8, fontSize: 12, color: STATUS.WATCH.color, fontWeight: 700, lineHeight: 1.5 }}>
          ⚑ USD/JPY moved {jpyChangePct >= 0 ? "+" : ""}{jpyChangePct.toFixed(2)}% this session (&gt;2%) — check for intervention before trusting the yen leg. The Jul 30–31 joint US–Japan action (~¥8.45tn day one, the largest single-day intervention on record) is exactly the kind of move this flag exists to catch.
        </div>
      )}

      {!active && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <input value={since} onChange={e => setSince(e.target.value)} placeholder="since (YYYY-MM-DD)"
            style={{ flex: "1 1 130px", minWidth: 0, padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6 }} />
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="note (optional)"
            style={{ flex: "2 1 180px", minWidth: 0, padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6 }} />
        </div>
      )}

      {/* The arithmetic, shown whether the flag is on or off — it is what the operator is
          judging against, and it is useful before deciding to set the flag. */}
      {preview.attribution && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.55 }}>
          {preview.attribution.sameDirection
            ? `Today: ${preview.attribution.note}.`
            : `Today: ${preview.attribution.note}.`}
        </div>
      )}
      {active && (
        <div style={{ fontSize: 11.5, color: tok.color, fontWeight: 600, marginTop: 6, lineHeight: 1.55 }}>
          {iv.note ? `Note: ${iv.note}` : "Annotating the FX row on Global Playbook."}
        </div>
      )}
      {!active && iv?.clearedAt && (
        <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 6 }}>
          Last window cleared {String(iv.clearedAt).slice(0, 10)}{iv.previousSince ? ` (ran from ${iv.previousSince})` : ""}
        </div>
      )}
      {msg && (
        <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 6, color: msg.ok ? C.green : C.red }}>{msg.text}</div>
      )}
    </Card>
  );
}

// C2 — business days (Mon–Fri) elapsed since an ISO date. A hand-entered ZQ settle goes stale fast:
// past 3 business days the derived hike/cut count must not read as current, so it is suppressed.
function bizDaysSince(isoDate, now = new Date()) {
  const start = new Date(isoDate + "T00:00:00Z");
  if (isNaN(start.getTime())) return 0;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let d = new Date(start), n = 0;
  while (d < end) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
  return n;
}
function FedPathCard({ effr }) {
  const [data, setData] = useState(null);
  const [price, setPrice] = useState("");
  const [contract, setContract] = useState("Dec-2026");
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { fetch("/api/manual-entry").then(r => r.json()).then(j => setData(j.fedPath || null)).catch(() => {}); }, []);

  const px = Number(String(price).replace(/,/g, ""));
  const preview = Number.isFinite(px) && px > 90 && px < 101 ? +(100 - px).toFixed(4) : null;
  const previewMoves = (preview != null && effr != null) ? +((preview - effr) / 0.25).toFixed(2) : null;

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ fedPath: { price: px, contract, effr: effr ?? null, date: new Date().toISOString().slice(0, 10) } }),
      });
      const j = await r.json();
      if (r.ok) { setData(d => ({ ...(d || {}), latest: j.fedPath })); setPrice(""); setMsg({ ok: true, text: `Saved — implied ${j.fedPath?.impliedRate}%` }); }
      else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }

  const L = data?.latest;
  // C2 — suppress the derived hike/cut count once the manual entry is >3 business days old.
  const staleBiz = L?.date ? bizDaysSince(L.date) : 0;
  const suppressDerived = staleBiz > 3;
  // The divergence between this and the qualitative Fed read IS the story when they disagree.
  const diverges = !suppressDerived && L?.movesPriced != null && Math.abs(L.movesPriced) >= 1;
  return (
    <Card>{/* I.2 — informational: no status badge, so no accent bar. */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>📈 Market-implied Fed path</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>ZQ 30-day fed funds futures · manual entry (no free feed)</span>
      </div>
      {L ? (
        <>
          <div style={{ fontSize: 20, fontWeight: 900, color: C.text }}>
            {L.impliedRate}% <span style={{ fontSize: 12, fontWeight: 700, color: C.muted }}>implied · {L.contract || "—"}</span>
          </div>
          <div style={{ fontSize: 12.5, color: suppressDerived ? C.amber : diverges ? C.amber : C.mid, fontWeight: (suppressDerived || diverges) ? 800 : 600, marginTop: 2 }}>
            {suppressDerived
              ? `derived hike/cut count suppressed — entry ${staleBiz} business days old, re-enter today's ZQ settle`
              : L.movesPriced == null ? "no EFFR to compare against"
              : `${Math.abs(L.movesPriced).toFixed(1)} × 25bp ${L.movesPriced >= 0 ? "HIKES" : "CUTS"} priced vs EFFR ${L.effr}%`}
          </div>
          <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 2 }}>
            ZQ {L.price} (100 − price = implied rate) · entered {L.date}
            {kofiaStale(L.date) ? <span style={{ color: C.amber, fontWeight: 700 }}> · ⚠ stale, re-enter</span> : null}
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12.5, color: C.muted }}>No entry yet — add today's ZQ settle below.</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end", marginTop: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>ZQ price</div>
          <input value={price} onChange={e => setPrice(e.target.value)} placeholder="96.160"
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 110 }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Contract</div>
          <input value={contract} onChange={e => setContract(e.target.value)} placeholder="Dec-2026"
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 110 }} />
        </div>
        {preview != null && (
          <div style={{ fontSize: 12, color: C.mid, fontWeight: 700, paddingBottom: 6 }}>
            → {preview}%{previewMoves != null ? ` · ${Math.abs(previewMoves).toFixed(1)}×25bp ${previewMoves >= 0 ? "hikes" : "cuts"}` : ""}
          </div>
        )}
        <Btn onClick={save} disabled={saving || preview == null} color={C.blue} bgColor={C.blBg} label={saving ? "⏳ Saving…" : "💾 Save"} />
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
    </Card>
  );
}

// Aug-22 Part B — cash-yield vs a bank term deposit on a LIKE-FOR-LIKE basis. Three adjustments make
// the comparison valid: compounding (SEC 30-day is annualised-simple → an APY column), withholding
// (0% VERIFIED on USFR per the Jul 30 2026 distribution; SGOV UNVERIFIED until one is observed), and
// liquidity (a locked deposit defeats a bucket held for deployment). Bank rate + WHT + size are manual.
function CashComparisonCard({ liveInd }) {
  const [cfg, setCfg] = useState(() => cacheLoad("cash_compare_v1", { bankRate: "3.65", conv: "apy", term: "6mo", usfrWht: "0", sgovWht: "0", posUsd: "53418" }));
  const set = (k, v) => setCfg(prev => { const next = { ...prev, [k]: v }; cacheSave("cash_compare_v1", next); return next; });
  const usfrSec = SEC_YIELDS.USFR.value, sgovSec = SEC_YIELDS.SGOV.value;
  const bill = liveCashYield(liveInd);
  const posUsd = Math.max(0, Math.round(Number(String(cfg.posUsd).replace(/,/g, "")) || 0));
  const bankRateNum = cfg.bankRate === "" ? null : Number(cfg.bankRate);
  const isApy = cfg.conv === "apy";
  const bankApy = bankRateNum == null ? null : (isApy ? bankRateNum : apyFromSec(bankRateNum));
  const cmp = compareCash({ usfrSec, sgovSec, usfrWht: Number(cfg.usfrWht) || 0, sgovWht: Number(cfg.sgovWht) || 0, bankRate: bankRateNum, bankConvention: cfg.conv, positionUsd: posUsd });
  const pc = v => v == null ? "—" : `${v.toFixed(2)}%`;
  const rows = [
    { k: "USFR", sec: usfrSec, apy: apyFromSec(usfrSec), aw: cmp.rows.USFR.afterWht, liq: "T+1", credit: "US Govt", wht: `${Number(cfg.usfrWht) || 0}%`, whtTag: "✓ VERIFIED · Jul 30 2026 distribution", whtOk: true },
    { k: "SGOV", sec: sgovSec, apy: apyFromSec(sgovSec), aw: cmp.rows.SGOV.afterWht, liq: "T+1", credit: "US Govt", wht: `${Number(cfg.sgovWht) || 0}%`, whtTag: "⚠ UNVERIFIED · no SGOV distribution observed", whtOk: false, star: true },
    bill && { k: bill.src, sec: bill.value, apy: bill.value, aw: bill.value, liq: "to maturity", credit: "US Govt", wht: "0%", whtTag: null },
    { k: "Bank deposit", sec: null, apy: bankApy, aw: bankApy, liq: "LOCKED", credit: "Bank", bank: true },
  ].filter(Boolean);
  const cols = ["", "SEC 30d", "APY", "After WHT", "Liquidity", "Credit"];
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>💵 Cash yield comparison</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>vs a bank term deposit · manual: bank rate, WHT, size</span>
      </div>
      <div style={{ overflowX: "auto", marginTop: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 460, fontSize: 12.5 }}>
          <thead>
            <tr>{cols.map((c, i) => (
              <th key={i} style={{ textAlign: i === 0 ? "left" : "right", padding: "5px 8px", borderBottom: "1.5px solid " + C.bdr, color: C.mid, fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" }}>{c}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.k} style={{ background: i % 2 ? C.bg : "transparent" }}>
                <td style={{ padding: "5px 8px", fontWeight: 700, color: r.bank ? C.muted : C.text, borderBottom: "1px solid " + C.bdr }}>{r.k}</td>
                <td style={{ padding: "5px 8px", textAlign: "right", color: C.mid, borderBottom: "1px solid " + C.bdr }}>{pc(r.sec)}</td>
                <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: 800, color: C.text, borderBottom: "1px solid " + C.bdr }}>{pc(r.apy)}</td>
                <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: 700, color: C.mid, borderBottom: "1px solid " + C.bdr }}>{pc(r.aw)}{r.star ? "*" : ""}</td>
                <td style={{ padding: "5px 8px", textAlign: "right", fontWeight: r.liq === "LOCKED" ? 800 : 600, color: r.liq === "LOCKED" ? C.amber : C.muted, borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap" }}>{r.liq}</td>
                <td style={{ padding: "5px 8px", textAlign: "right", color: C.muted, borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap" }}>{r.credit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end", marginTop: 10 }}>
        <label style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Bank rate
          <input value={cfg.bankRate} onChange={e => set("bankRate", e.target.value)} placeholder="3.65"
            style={{ display: "block", marginTop: 2, fontSize: 13, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 80 }} /></label>
        <div style={{ display: "flex", borderRadius: 6, overflow: "hidden", border: "1.5px solid " + C.bdr }}>
          {["simple", "apy"].map(cv => (
            <button key={cv} onClick={() => set("conv", cv)} style={{ cursor: "pointer", border: "none", padding: "6px 10px", fontSize: 11.5, fontWeight: 800,
              background: cfg.conv === cv ? C.blue : C.surf, color: cfg.conv === cv ? "#fff" : C.mid }}>{cv === "apy" ? "APY" : "simple"}</button>
          ))}
        </div>
        <label style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Term
          <input value={cfg.term} onChange={e => set("term", e.target.value)} placeholder="6mo"
            style={{ display: "block", marginTop: 2, fontSize: 13, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 64 }} /></label>
        <label style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Position $
          <input value={cfg.posUsd} onChange={e => set("posUsd", e.target.value)} placeholder="53418"
            style={{ display: "block", marginTop: 2, fontSize: 13, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 90 }} /></label>
        <label style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>USFR WHT %
          <input value={cfg.usfrWht} onChange={e => set("usfrWht", e.target.value)} placeholder="0"
            style={{ display: "block", marginTop: 2, fontSize: 13, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 60 }} /></label>
        <label style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>SGOV WHT %
          <input value={cfg.sgovWht} onChange={e => set("sgovWht", e.target.value)} placeholder="0"
            style={{ display: "block", marginTop: 2, fontSize: 13, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 60 }} /></label>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 8 }}>
        {rows.filter(r => r.whtTag).map(r => (
          <div key={r.k} style={{ fontSize: 11, color: r.whtOk ? C.green : C.amber, fontWeight: 700 }}>{r.k} withholding {r.wht} — {r.whtTag}</div>
        ))}
      </div>
      {cmp.edgeVsBankBp != null && (
        <div style={{ marginTop: 10, padding: "9px 12px", background: cmp.edgeVsBankBp >= 0 ? C.gBg : C.aBg, border: "1.5px solid " + (cmp.edgeVsBankBp >= 0 ? C.gBdr : C.aBdr), borderRadius: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 900, color: cmp.edgeVsBankBp >= 0 ? C.green : C.amber }}>
            Verdict: {cmp.edgeVsBankBp >= 0 ? cmp.best : "Bank deposit"} by {Math.abs(cmp.edgeVsBankBp)}bp on {isApy ? "an APY" : "a simple"} basis
          </div>
          <div style={{ fontSize: 12, color: C.mid, marginTop: 2, lineHeight: 1.5 }}>
            On ${posUsd.toLocaleString("en-US")} that is ~${Math.abs(cmp.dollarVsBank ?? 0).toLocaleString("en-US")}/yr vs the deposit{cmp.dollarFundGap != null ? `, ~$${Math.abs(cmp.dollarFundGap).toLocaleString("en-US")}/yr vs SGOV` : ""}. At this size the gap is small — let liquidity and simplicity carry more weight than yield.
          </div>
        </div>
      )}
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, fontSize: 11.5, color: C.mid, lineHeight: 1.55 }}>
        <div>🔒 <b>Liquidity isn't free.</b> A term-deposit yield is only comparable if the money would not need to move before maturity — and this bucket is explicitly held for deployment (bills now → duration at the pivot → equities 30–60d after the first cut).</div>
        <div>〰️ <b>SGOV sawtooth.</b> Its price climbs ~30c through the month as interest accrues, then drops on ex-dividend; the quote in isolation looks like the position is bleeding. Total return = NAV change + distributions.</div>
        <div>📉 <b>Unrealised P&amp;L is not a gain.</b> On USFR/SGOV the price accrues through the month and drops on ex-dividend — the unrealised figure is interest not yet distributed, not profit.</div>
        <div style={{ color: C.amber, fontWeight: 700 }}>⚠️ <b>USFR carries a 100% margin requirement — no buying power.</b> Parking cash here reduces available margin by the full amount, the same as moving it out of the account. Verify SGOV's requirement separately; do not assume it matches.</div>
        <div style={{ color: C.lbl, fontSize: 10.5 }}>* SGOV after-WHT assumes 0% by analogy to USFR — an assumption, not a measurement, until a SGOV distribution is observed.</div>
      </div>
    </Card>
  );
}

// The 2x2 verdict for a live indicators payload — shared so the Sahm annotation and the
// labour panel can never disagree about whether the print is AMBER.
function laborVerdictFor(liveInd) {
  // Uses the July overlay and the payroll count so this shared verdict matches the panel's —
  // R2's negative-payroll override must be reflected everywhere the verdict is read.
  const { labor } = overlayJulyLabor(liveInd?.labor);
  const u3 = labor?.u3, ep = labor?.empPop, pr = labor?.payrolls;
  if (!u3?.ok || !ep?.ok) return null;
  return laborVerdict(u3.delta, ep.delta, pr?.ok ? pr.delta : null).verdict;
}

// C4 — the next BLS Employment Situation release, DERIVED from the cadence (first Friday of the
// month) instead of a hardcoded date that goes wrong the moment the print lands. If this month's
// first Friday has already passed, roll to next month's.
function nextEmploymentPrint(now = new Date()) {
  const firstFriday = (y, m) => {
    const d = new Date(Date.UTC(y, m, 1));
    const off = (5 - d.getUTCDay() + 7) % 7; // 5 = Friday
    return new Date(Date.UTC(y, m, 1 + off));
  };
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let y = now.getUTCFullYear(), m = now.getUTCMonth();
  let ff = firstFriday(y, m);
  if (ff < today) { m += 1; if (m > 11) { m = 0; y += 1; } ff = firstFriday(y, m); }
  return ff;
}
const fmtPrintDate = d => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Credit thresholds — one definition for both the reference lines and the legend.
const CREDIT_MARKS = [
  { val: 3.0, label: "Mild stress",       color: "#D97706", dash: "4 2" },
  { val: 4.5, label: "Alert threshold",   color: "#F97316", dash: "5 3" },
  { val: 6.0, label: "Recession likely",  color: "#DC2626", dash: "4 2" },
];

// ─── CREDIT BLOCK (P2 / F.2) ──────────────────────────────────────────────────
// The master credit gauge: the published OAS with its real observation date, beside a live
// HYG proxy that is explicitly NOT the spread. Defined ONCE and rendered once. It used to sit
// nested inside the Global Playbook cross-asset card; F.2 puts it near the top of the Macro
// tab. Keeping a second copy on Playbook would reintroduce exactly the drift section C removed
// for the labour module, so this MOVED rather than being duplicated.
function CreditBlock({ credit, oas, hyg, reconSummary, history, depth = "full" }) {
  if (!hyg) return null;
  // I.1/I.2 — the master gauge carries a status badge, so it carries a matching accent bar.
  const cst = creditStatus(oas?.value) ?? "BENIGN";
  const ctok = STATUS[cst];

  // ── M.2 — glance depth for the Indicators tab ──
  // Rendered from the SAME component rather than reimplemented, so the age chip and the HYG
  // proxy exist on both tabs by construction. Depth changes the density, never the numbers.
  if (depth === "glance") {
    const obs = oas?.date ? observationAge(oas.date) : null;
    const chipCol = obs?.chip === "red" ? C.red : obs?.chip === "amber" ? C.amber : C.muted;
    const dv = hyg.divergence;
    return (
      <Card style={{ borderLeft: "4px solid " + ctok.color }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <SLabel>HY Credit Spread — master gauge</SLabel>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 28, fontWeight: 900, letterSpacing: -1, color: ctok.color }}>
                {obs?.awaiting ? "—" : (oas?.value ?? "—")}
              </span>
              <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.5, color: ctok.color, background: ctok.bg, border: "1px solid " + ctok.bdr, borderRadius: 5, padding: "2px 8px" }}>{cst}</span>
              {obs && <span style={{ fontSize: 12, fontWeight: 800, color: chipCol }}>{obs.awaiting ? "AWAITING PUBLICATION" : obs.label}</span>}
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
              ICE BofA HY OAS · publishes with a ~2-day variable lag
            </div>
          </div>
          {/* The live proxy belongs anywhere credit appears — it is the only same-day read. */}
          <div style={{ background: dv?.alert ? C.aBg : C.bg, border: "1px solid " + (dv?.alert ? C.aBdr : C.bdr), borderRadius: 8, padding: "8px 12px", maxWidth: 330 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.blue, textTransform: "uppercase", letterSpacing: 0.5 }}>HYG intraday · PROXY — not OAS</div>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: hyg.stressing ? C.red : C.mid, marginTop: 2 }}>{hyg.note}</div>
            {dv && (
              <div style={{ fontSize: 11.5, fontWeight: dv.alert ? 800 : 400, color: dv.alert ? C.amber : C.muted, marginTop: 3, lineHeight: 1.5 }}>
                {dv.alert ? "⚠ " : ""}{dv.note}
              </div>
            )}
          </div>
        </div>
        {/* The old standalone credit indicator carried the threshold chart; it is folded in
            here so ONE component covers the topic (M.1) without losing what it showed. */}
        {history && history.length >= 2 && (
          <>
            <ResponsiveContainer width="100%" height={148}>
              <AreaChart data={history} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="oasFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ctok.color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={ctok.color} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="d" tick={{ fontSize: 9, fill: C.lbl }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis domain={[1.5, 7.0]} tick={{ fontSize: 9, fill: C.lbl }} width={34} tickFormatter={v => v.toFixed(2) + "%"} />
                <Tooltip formatter={v => [`${Number(v).toFixed(2)}%`, "HY OAS"]} />
                {CREDIT_MARKS.map(t => (
                  <ReferenceLine key={t.val} y={t.val} stroke={t.color} strokeDasharray={t.dash} strokeWidth={1.5} />
                ))}
                <Area type="monotone" dataKey="v" stroke={ctok.color} strokeWidth={2} fill="url(#oasFill)" />
              </AreaChart>
            </ResponsiveContainer>
            {/* Threshold legend, matching the yield-curve card's shape. */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 4 }}>
              {CREDIT_MARKS.map(t => (
                <span key={t.val} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                  <span style={{ width: 14, borderTop: `2px ${t.dash ? "dashed" : "solid"} ${t.color}`, display: "inline-block" }} />
                  <span style={{ color: C.mid }}>{t.label}</span>
                  <b style={{ color: t.color }}>{t.val.toFixed(2)}%</b>
                </span>
              ))}
            </div>
          </>
        )}
        <div style={{ fontSize: 11, color: C.lbl, marginTop: 6, lineHeight: 1.5 }}>
          Level bands: &lt;3.0 benign · 3.0–4.5 watchful · 4.5–8.0 stressed · &gt;8.0 recessionary.
          Trend and the 3Y-window caveat on the Macro tab.
        </div>
      </Card>
    );
  }

  return (
    <Card style={{ borderLeft: "4px solid " + ctok.color }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
        <SLabel>💳 Credit — master gauge</SLabel>
        <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.5, color: ctok.color, background: ctok.bg, border: "1px solid " + ctok.bdr, borderRadius: 5, padding: "2px 8px" }}>{cst}</span>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>published spread + live proxy</span>
      </div>
                <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8 }}>
                  {/* P2.1 — the observation date comes from FRED and is rendered adjacent to
                      the value at the same weight, never in a tooltip and never computed as
                      today−n. The lag is TWO days and variable (it stretches across weekends
                      and holidays), so an assumed lag would misdate the print. Past 4 calendar
                      days we stop showing a number at all rather than style a stale one as
                      current. P2.2 — trend, not level, is the signal at these tights. */}
                  {(() => {
                    const cr = credit;
                    // M.3 — the age is RECOMPUTED here at render, not read from the payload.
                    // creditState() computes it server-side at fetch time, and the client
                    // renders from a localStorage cache on load — so a payload cached
                    // yesterday would display yesterday's age against today's date. The
                    // observation DATE is stable data; the age is a function of (date, now),
                    // so it must be derived where "now" is actually current.
                    const obs = cr?.obs?.obsDate
                      ? observationAge(cr.obs.obsDate)
                      : (oas?.date ? observationAge(oas.date) : cr?.obs);
                    const chipCol = obs?.chip === "red" ? C.red : obs?.chip === "amber" ? C.amber : C.muted;
                    return (
                      <div style={{ padding: "8px 11px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 6 }}>
                        <div style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>
                          HY OAS · official {cr?.level ? `· ${cr.level}` : ""}
                        </div>
                        {obs?.awaiting ? (
                          <div style={{ fontSize: 14, fontWeight: 900, color: C.red }}>
                            AWAITING PUBLICATION
                            <span style={{ fontSize: 10.5, fontWeight: 700, color: C.muted, marginLeft: 6 }}>
                              last obs {obs.obsDate} · {obs.calendarDays}d
                            </span>
                          </div>
                        ) : (
                          <div style={{ fontSize: 16, fontWeight: 900, color: C.text }}>
                            {oas?.value ?? "—"}
                            <span style={{ fontSize: 13, fontWeight: 900, color: chipCol, marginLeft: 8 }}>
                              {obs?.label ?? `obs ${oas?.date ?? "—"}`}
                            </span>
                          </div>
                        )}
                        {cr?.trend && (
                          <div style={{ fontSize: 11.5, color: C.mid, marginTop: 3 }}>
                            {["d5", "d20", "d60"].map((k, i) => {
                              const v = cr.trend[k];
                              return (
                                <span key={k}>
                                  {i ? " · " : ""}
                                  <span style={{ color: C.lbl }}>{k.slice(1)}d </span>
                                  {v == null ? <span style={{ color: C.lbl }}>n/a</span>
                                    : <span style={{ fontWeight: 800, color: v > 0 ? C.red : v < 0 ? C.green : C.muted }}>{v >= 0 ? "+" : ""}{v}bp</span>}
                                </span>
                              );
                            })}
                            <span style={{ color: C.lbl }}> — at these tights the trend is the signal, not the level</span>
                          </div>
                        )}
                        <div style={{ fontSize: 10, color: C.lbl, marginTop: 3 }}>
                          3Y rolling window (FRED restricts ICE BofA series). Reference constants: {cr?.historical?.recordTight?.value ?? 2.41} ({cr?.historical?.recordTight?.when ?? "Jun 2007"}) · {cr?.historical?.gfcPeak?.value ?? 21.82} ({cr?.historical?.gfcPeak?.when ?? "Dec 2008"}) — static, not series data.
                        </div>
                      </div>
                    );
                  })()}
                  <div style={{ padding: "8px 11px", background: hyg.divergence?.alert ? C.aBg : C.bg,
                    border: "1px solid " + (hyg.divergence?.alert ? C.aBdr : C.bdr), borderRadius: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: C.blue, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      HYG intraday · PROXY — not OAS
                    </div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: !hyg.available ? C.amber : hyg.stressing ? C.red : C.mid, marginTop: 2 }}>
                      {hyg.note}
                    </div>
                    {hyg.divergence && (
                      <div style={{ fontSize: 11.5, fontWeight: hyg.divergence.alert ? 800 : 400,
                        color: hyg.divergence.alert ? C.amber : C.muted, marginTop: 3, lineHeight: 1.5 }}>
                        {hyg.divergence.alert ? "⚠ " : ""}{hyg.divergence.note}
                      </div>
                    )}
                    {/* P2.4 caveat — the proxy is an ETF, not the spread. */}
                    <div style={{ fontSize: 10, color: C.lbl, marginTop: 4, lineHeight: 1.5 }}>
                      HYG is an ETF with its own flow, liquidity and NAV-premium dynamics.
                      Directionally useful same-day; not a substitute for the published spread.
                    </div>
                    {/* P2.5 — has the proxy actually been right? Shown ON the card, because a
                        card that cannot show its own hit rate gets trusted by habit. */}
                    {reconSummary && (
                      <div style={{ fontSize: 10.5, marginTop: 4, fontWeight: reconSummary.belowChance ? 800 : 600,
                        color: reconSummary.belowChance ? C.red : reconSummary.sufficient ? C.green : C.lbl }}>
                        Track record: {reconSummary.verdict}
                      </div>
                    )}
                  </div>
                </div>
    </Card>
  );
}

// ─── LABOUR MODULE (P1 / J / K / M.1) ─────────────────────────────────────────
// ONE component, rendered on both tabs with a `depth` prop — `full` on Macro (the
// interpretation lives there) and `glance` on Indicators (which conforms to that tab's card
// pattern: big number · badge · as-of · chart · right panel). Two implementations drift, and
// already had: this replaces both.
//
// The scoring rule is unchanged and lives in lib/labor.js: U3 is never scored alone, because
// the rate can FALL on labour-force exit. Emp-pop is the control — employed ÷ working-age
// population — and it cannot be gamed that way. That is why it is the hero metric.
function LaborPanel({ labor, depth = "full", extras = null, announced = false }) {
  if (!labor) return null;
  const g = k => labor[k] && labor[k].ok ? labor[k] : null;
  const s = {
    u3: g("u3"), participation: g("participation"), primeAge: g("primeAge"), empPop: g("empPop"),
    u6: g("u6"), longTerm: g("longTerm"), payrolls: g("payrolls"), household: g("household"),
    quits: g("quits"),
  };
  if (!s.u3 || !s.empPop) return null;

  const state = {
    u3: { value: s.u3.value, delta: s.u3.delta },
    empPop: { value: s.empPop.value, delta: s.empPop.delta },
    household: { changeK: s.household?.delta ?? null },
    // R2 — the payroll count threads into the verdict so a negative print forces RED.
    payrolls: { changeK: s.payrolls?.delta ?? null },
  };
  const sum = laborSummary(state);
  const trig = laborDeteriorationTrigger(state);
  // R5 — Sahm annotation now returns { prominent, title, text }; prominent when payrolls negative.
  const sahmNote = sahmAnnotation(sum.verdict.verdict, s.payrolls?.delta ?? null);
  // R3 / R4 / R6 — tracked metrics from the announced-print extras (revisions/12-mo/YTD have no
  // single live FRED series). 12-mo average falls back to the live PAYEMS history when present.
  const twelveMoAvgK = extras?.twelveMoAvgK
    ?? ((s.payrolls?.history?.length >= 13)
      ? Math.round((s.payrolls.history.at(-1).value - s.payrolls.history.at(-13).value) / 12)
      : null);
  const revisionRead = extras?.revisions ? revisionTrackerRead(extras.revisions) : null;
  const twelveMoRead = twelveMonthAvgRead(twelveMoAvgK);
  const ytdRead = extras?.ytd ? ytdDivergenceRead(extras.ytd) : null;
  // I.1 — the verdict maps onto the four status states; no ad-hoc vocabulary.
  const st = sum.verdict.verdict === "RED" ? "ELEVATED"
    : sum.verdict.verdict === "AMBER" ? "WATCH"
    : sum.verdict.verdict === "GREEN" ? "BENIGN" : "WATCH";
  const tok = STATUS[st];

  // F1 — quits vs emp-pop. The conflict is promoted to a primary line because a genuine
  // disagreement between the two surveys outranks any individual reading from either.
  const quits = s.quits ? quitsRead(s.quits, { delta: s.empPop.delta }) : null;
  const primaryLines = [
    s.primeAge && primeAgeRead(s.primeAge.value, s.primeAge.delta, s.participation?.delta),
    (s.payrolls && s.household) && surveyDivergenceRead(s.payrolls.delta, s.household.delta),
    quits?.conflict && { text: quits.conflictNote, tone: "amber" },
  ].filter(x => x && x.text);
  const detailLines = [
    s.longTerm && longTermRead(s.longTerm.value, s.longTerm.delta,
      (g("longTermCount")?.value != null && g("longTermCount")?.yearAgo != null)
        ? Math.round(g("longTermCount").value - g("longTermCount").yearAgo) : null),
    (s.u6 && s.u3) && u6SpreadRead(s.u6.value, s.u3.value, (s.u6.prev != null && s.u3.prev != null) ? +(s.u6.prev - s.u3.prev).toFixed(1) : null),
    s.payrolls && payrollsRead(s.payrolls.delta, null),
    quits?.available && !quits.conflict && { text: quits.note },
  ].filter(x => x && x.text);
  const unverified = Object.entries(labor).filter(([, v]) => v && v.ok && v.verified === false);

  const pp = d => d == null ? "" : `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}pp`;
  const badge = (
    <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.5, color: tok.color, background: tok.bg, border: "1px solid " + tok.bdr, borderRadius: 5, padding: "2px 8px" }}>
      {sum.verdict.verdict} / {st}
    </span>
  );
  // J.2 / K.2 — one line naming what would change the verdict. Not a paragraph.
  const watchLine = `Watch: emp-pop ratio. A second consecutive monthly decline confirms exit-driven deterioration. Next print ${fmtPrintDate(nextEmploymentPrint())} (BLS Employment Situation, first Friday).`;

  const tile = (key, lab, unit = "%") => {
    const row = g(key); if (!row) return null;
    return (
      <MetricCard key={key} label={lab}
        title={`${row.id} · ${row.title || ""} · asOf ${row.date}`}
        value={unit === "k" ? withCommas(Math.round(row.value)) : row.value?.toFixed(1) + "%"}
        sub={row.delta == null ? null : (
          <span style={{ fontSize: 12, fontWeight: 800, color: C.mid }}>
            {row.delta >= 0 ? "+" : "−"}{Math.abs(row.delta).toFixed(unit === "k" ? 0 : 1)}{unit === "k" ? "k" : "pp"}
          </span>
        )} />
    );
  };

  // ── K — glance depth: conform to the Indicators card pattern element for element ──
  if (depth === "glance") {
    // The emp-pop / U3 divergence IS the story, so it must be visible without reading.
    const eh = (s.empPop.history || []).map(r => ({ date: r.date, empPop: r.value }));
    const uh = new Map((s.u3.history || []).map(r => [r.date, r.value]));
    const chart = eh.map(r => ({ ...r, u3: uh.get(r.date) ?? null }));
    return (
      <Card style={{ borderLeft: "4px solid " + tok.color }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
          <div>
            <SLabel>Labour Market</SLabel>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <span style={{ fontSize: 28, fontWeight: 900, letterSpacing: -1, color: tok.color }}>{s.empPop.value.toFixed(1)}%</span>
              {badge}
              <span style={{ fontSize: 11, color: C.lbl, fontWeight: 700 }}>as of {s.empPop.date}</span>
            </div>
            <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>Employment–population ratio · {pp(s.empPop.delta)}</div>
          </div>
          {/* Right panel — thresholds then short prose, matching the credit/yield cards. */}
          <div style={{ background: tok.bg, border: "1px solid " + tok.bdr, borderRadius: 8, padding: "8px 12px", maxWidth: 340 }}>
            <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: C.mid, lineHeight: 1.7 }}>
              <div>Healthy trend:&nbsp;&nbsp;&nbsp;&nbsp;rising</div>
              <div>Watch:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;1 monthly decline</div>
              <div>Deterioration:&nbsp;&nbsp;&nbsp;2+ consecutive declines</div>
              <div>Sahm equivalent: −0.5pp from 12m high</div>
            </div>
            <div style={{ fontSize: 12, color: tok.color, lineHeight: 1.6, marginTop: 6 }}>
              U3 fell to {s.u3.value.toFixed(1)}% while emp-pop also fell to {s.empPop.value.toFixed(1)}%. That combination means the decline was
              exit-driven, not hiring-driven. Sahm is understated for the same reason and cannot see it.
            </div>
          </div>
        </div>
        {chart.length >= 2 && (
          <ResponsiveContainer width="100%" height={148}>
            <LineChart data={chart} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: C.lbl }} axisLine={false} tickLine={false} interval="preserveStartEnd"
                tickFormatter={d => { const [y, m] = String(d).split("-"); return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][+m - 1]} ${String(y).slice(2)}`; }} />
              <YAxis yAxisId="ep" domain={["auto", "auto"]} tick={{ fontSize: 9, fill: C.lbl }} width={34} tickFormatter={v => v.toFixed(1)} />
              <YAxis yAxisId="u3" orientation="right" domain={["auto", "auto"]} tick={{ fontSize: 9, fill: C.lbl }} width={30} tickFormatter={v => v.toFixed(1)} />
              <Tooltip formatter={(v, n) => [`${Number(v).toFixed(1)}%`, n === "empPop" ? "Emp–pop" : "U3"]} />
              {(() => {
                const hi = Math.max(...chart.map(r => r.empPop).filter(v => v != null));
                return [
                  { y: hi, c: "#166534", d: "4 2" },
                  { y: hi - 0.25, c: "#D97706", d: "5 3" },
                  { y: hi - 0.5, c: "#DC2626", d: "4 2" },
                ].map(t => <ReferenceLine key={t.y} yAxisId="ep" y={t.y} stroke={t.c} strokeDasharray={t.d} strokeWidth={1.5} />);
              })()}
              <Line yAxisId="ep" type="monotone" dataKey="empPop" name="empPop" stroke={tok.color} strokeWidth={2.5} dot={false} connectNulls />
              <Line yAxisId="u3" type="monotone" dataKey="u3" name="u3" stroke={C.muted} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
        {/* Threshold legend, matching the yield-curve and credit cards. Computed from the
            trailing-12m high rather than hardcoded, so the benchmarks move with the data:
            Sahm's equivalent for emp-pop is −0.5pp off that high. */}
        {chart.length >= 2 && (() => {
          const hi = Math.max(...chart.map(r => r.empPop).filter(v => v != null));
          const marks = [
            { val: +hi.toFixed(2), label: "12m high", color: "#166534", dash: "4 2" },
            { val: +(hi - 0.25).toFixed(2), label: "Watch −0.25pp", color: "#D97706", dash: "5 3" },
            { val: +(hi - 0.5).toFixed(2), label: "Sahm equiv −0.5pp", color: "#DC2626", dash: "4 2" },
          ];
          return (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 4 }}>
              {marks.map(t => (
                <span key={t.label} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                  <span style={{ width: 14, borderTop: `2px dashed ${t.color}`, display: "inline-block" }} />
                  <span style={{ color: C.mid }}>{t.label}</span>
                  <b style={{ color: t.color }}>{t.val.toFixed(2)}%</b>
                </span>
              ))}
            </div>
          );
        })()}
        {/* K.3 — Indicators is the glance tab; the full interpretation lives on Macro. */}
        <div style={{ fontSize: 11, color: C.lbl, marginTop: 6, lineHeight: 1.5 }}>
          Emp–pop (solid, left axis) vs U3 (dashed, right). {watchLine} Full interpretation on the Macro tab.
        </div>
      </Card>
    );
  }

  // ── J — full depth: hero metric, watch line, then the supporting rows ──
  return (
    <Card style={{ borderLeft: "4px solid " + tok.color }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>👷 Labour market</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>U3 scored against emp-pop, not alone</span>
      </div>

      <div style={{ marginTop: 6, padding: "8px 11px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 6, fontSize: 12, color: C.mid, lineHeight: 1.6 }}>
        <b style={{ color: C.muted }}>What this answers: </b>
        is the labour market deteriorating enough to push the Fed toward cutting, and to tip the regime toward deflationary recession?
      </div>

      {/* J.1 — emp-pop is the HERO: ~2x the other tiles, first, badge attached to it. */}
      <div style={{ marginTop: 10, padding: "12px 14px", background: tok.bg, border: "1.5px solid " + tok.bdr, borderRadius: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 40, fontWeight: 900, letterSpacing: -1.5, color: tok.color, lineHeight: 1 }}>{s.empPop.value.toFixed(1)}%</span>
          <span style={{ fontSize: 15, fontWeight: 800, color: tok.color }}>{pp(s.empPop.delta)}</span>
          {badge}
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.mid, marginTop: 3 }}>Employment–population ratio · as of {s.empPop.date}</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3, lineHeight: 1.55 }}>
          Emp-pop cannot be gamed by labour-force exit — it is employed ÷ working-age population.
        </div>
        {/* J.2 — the single watch line. */}
        <div style={{ fontSize: 12, fontWeight: 700, color: tok.color, marginTop: 6 }}>↪ {watchLine}</div>
      </div>

      <div style={{ fontSize: 12, color: tok.color, fontWeight: 700, marginTop: 8 }}>
        U3 {sum.verdict.u3} · emp-pop {sum.verdict.empPop} → {sum.verdict.read}
      </div>
      {sum.body && <div style={{ fontSize: 12.5, color: C.mid, marginTop: 4, lineHeight: 1.6 }}>{sum.body}</div>}

      {/* J.3 — secondary row, visibly smaller than the hero. */}
      <div style={{ marginTop: 10 }}>
        <MetricGrid min={155}>
          {tile("u3", "U3 rate")}
          {tile("primeAge", "Prime-age (25–54)")}
          {tile("payrolls", "Payrolls", "k")}
          {/* F1 — sits in the primary row, not the detail drawer: it is the only worker-side
              confidence read here, and it is the one that can contradict the others. */}
          {tile("quits", "Quits rate")}
        </MetricGrid>
      </div>

      {/* R4 / R3 / R6 (Amendment 3) — the payroll-count metrics the U3/emp-pop pair cannot show:
          the 12-month trend, the revision direction, and the household/establishment YTD gap. */}
      {(twelveMoRead || revisionRead || ytdRead) && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          {twelveMoRead && (() => {
            const bt = twelveMoRead.flag === "RED" ? STATUS.ELEVATED : twelveMoRead.flag === "AMBER" ? STATUS.WATCH : STATUS.BENIGN;
            return (
              <div style={{ padding: "10px 13px", background: bt.bg, border: "1.5px solid " + bt.bdr, borderRadius: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 26, fontWeight: 900, letterSpacing: -1, color: bt.color }}>{twelveMoRead.avgK >= 0 ? "+" : "−"}{Math.abs(twelveMoRead.avgK)}k</span>
                  <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.5, color: bt.color, textTransform: "uppercase" }}>{twelveMoRead.band}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.mid }}>12-month average payrolls</span>
                </div>
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 3, lineHeight: 1.5 }}>{twelveMoRead.text}</div>
              </div>
            );
          })()}
          {revisionRead && (
            <div style={{ padding: "9px 12px", background: revisionRead.flag ? C.aBg : C.bg, border: "1px solid " + (revisionRead.flag ? C.aBdr : C.bdr), borderRadius: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>Revision trend</span>
                <span style={{ fontSize: 15, fontWeight: 900, color: revisionRead.combinedK < 0 ? C.red : C.green }}>{revisionRead.combinedK >= 0 ? "+" : "−"}{Math.abs(revisionRead.combinedK)}k combined</span>
                {revisionRead.twoConsecutiveDown && <span style={{ fontSize: 10, fontWeight: 900, color: C.amber, background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 4, padding: "1px 6px" }}>2 CONSECUTIVE DOWN</span>}
                {revisionRead.rows.map(r => <span key={r.month} style={{ fontSize: 11.5, color: C.mid }}>{r.month} <b style={{ color: r.k < 0 ? C.red : C.green }}>{r.k >= 0 ? "+" : "−"}{Math.abs(r.k)}k</b></span>)}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>{revisionRead.text}</div>
            </div>
          )}
          {ytdRead && (
            <div style={{ padding: "9px 12px", background: ytdRead.flag ? C.aBg : C.bg, border: "1px solid " + (ytdRead.flag ? C.aBdr : C.bdr), borderRadius: 8 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: C.muted }}>Survey divergence (YTD)</span>
                <span style={{ fontSize: 12.5, color: C.mid }}>Household <b style={{ color: ytdRead.householdK < 0 ? C.red : C.green }}>{ytdRead.householdK >= 0 ? "+" : "−"}{Math.abs(ytdRead.householdK)}k</b></span>
                <span style={{ fontSize: 12.5, color: C.mid }}>Establishment <b style={{ color: ytdRead.payrollK < 0 ? C.red : C.green }}>{ytdRead.payrollK >= 0 ? "+" : "−"}{Math.abs(ytdRead.payrollK)}k</b></span>
                {ytdRead.flag && <span style={{ fontSize: 10, fontWeight: 900, color: C.amber, background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 4, padding: "1px 6px" }}>OPPOSITE-SIGNED · {ytdRead.gapK.toLocaleString("en-US")}k GAP</span>}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>{ytdRead.text}</div>
            </div>
          )}
        </div>
      )}

      {primaryLines.length > 0 && (
        <div style={{ marginTop: 10 }}>
          {primaryLines.map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: C.mid, lineHeight: 1.6, marginTop: 5, paddingLeft: 10, borderLeft: "2px solid " + (l.flag === "AMBER" ? C.aBdr : C.bdr) }}>
              {l.flag === "AMBER" && <span style={{ color: C.amber, fontWeight: 800 }}>⚠ </span>}{l.text}
            </div>
          ))}
        </div>
      )}

      {/* R5 — when payrolls are negative the Sahm annotation renders at full weight, same size
          as the Sahm value itself, because the rule moved FURTHER from firing in a month of job
          losses and reading it as reassurance is the exact error it must not invite. */}
      {sahmNote && (
        <div style={{ marginTop: 8, padding: sahmNote.prominent ? "11px 13px" : "7px 10px", background: C.aBg, border: (sahmNote.prominent ? "1.5px solid " : "1px solid ") + C.aBdr, borderRadius: 8, color: C.amber }}>
          <div style={{ fontSize: sahmNote.prominent ? 13.5 : 12, fontWeight: sahmNote.prominent ? 900 : 800, marginBottom: sahmNote.prominent ? 3 : 0 }}>
            {sahmNote.prominent ? "⚠ " : ""}{sahmNote.title}
          </div>
          <div style={{ fontSize: sahmNote.prominent ? 12.5 : 11.5, lineHeight: 1.55, fontWeight: sahmNote.prominent ? 600 : 400 }}>{sahmNote.text}</div>
        </div>
      )}

      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 11.5, color: C.blue, fontWeight: 700, cursor: "pointer" }}>Detail — participation, U-6, long-term unemployed, household survey</summary>
        <div style={{ marginTop: 8 }}>
          <MetricGrid min={160}>
            {tile("participation", "Participation")}
            {tile("u6", "U-6")}
            {tile("longTerm", "LT unemployed share")}
            {tile("longTermCount", "LT unemployed (27wk+)", "k")}
            {tile("household", "Household emp", "k")}
          </MetricGrid>
          {detailLines.map((l, i) => (
            <div key={i} style={{ fontSize: 12, color: C.mid, lineHeight: 1.6, marginTop: 5, paddingLeft: 10, borderLeft: "2px solid " + (l.flag === "AMBER" ? C.aBdr : C.bdr) }}>
              {l.flag === "AMBER" && <span style={{ color: C.amber, fontWeight: 800 }}>⚠ </span>}{l.text}
            </div>
          ))}
        </div>
      </details>

      <div style={{ marginTop: 10, padding: "7px 10px", background: trig.fired ? C.aBg : C.bg, border: "1px solid " + (trig.fired ? C.aBdr : C.bdr), borderRadius: 6, fontSize: 11.5, fontWeight: 700, color: trig.fired ? C.amber : C.muted }}>
        {trig.note}
      </div>

      {/* R7 (Amendment 3) — QCEW benchmark countdown. Auto-retires after the revision publishes. */}
      {(() => {
        const today = new Date().toISOString().slice(0, 10);
        if (today > "2026-08-28") return null;
        return (
          <div style={{ marginTop: 8, padding: "9px 12px", background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, fontSize: 11.5, lineHeight: 1.55, color: C.mid }}>
            <b style={{ color: C.blue }}>Aug 28, 10:00 ET — QCEW benchmark revision.</b> BLS restates the payroll base every recession model is built on, derived from state UI tax records. With May and June revised down {revisionRead ? `${Math.abs(revisionRead.combinedK)}k combined` : "103k combined"} and the 12-month average at {twelveMoRead ? `${twelveMoRead.avgK >= 0 ? "+" : "−"}${Math.abs(twelveMoRead.avgK)}k` : "~34k"}, a material downward benchmark would further degrade the establishment survey's picture. Recent years have revised down substantially.
          </div>
        );
      })()}

      {unverified.length > 0 && (
        <div style={{ marginTop: 8, padding: "7px 10px", background: C.rBg, border: "1px solid " + C.rBdr, borderRadius: 6, fontSize: 11.5, fontWeight: 700, color: C.red }}>
          ⚠ Series identity check FAILED: {unverified.map(([k, v]) => `${k} (${v.id}) — ${v.mismatch}`).join(" · ")}
        </div>
      )}
    </Card>
  );
}

// ─── ANNOUNCED PRINTS (published, but not yet in FRED) ────────────────────────
// BEA/BLS release ahead of FRED's ingest, so on release day the live series still shows the
// PRIOR period. Rather than hardcode a number over a live field (which would fabricate a
// "FRED" value) or show a stale figure as current (which would misread the trend), announced
// prints live here with their source and release date, render as an explicitly-labelled
// overlay, and AUTO-RETIRE the moment FRED's own asOf reaches the same period.
const ANNOUNCED_PRINTS = {
  pceCore: {
    period: "2026-06-01", label: "June core PCE", value: 3.3, mom: 0.1,
    headline: 3.7, headlineMom: -0.1, prev: 3.4,
    source: "BEA", released: "2026-07-30",
    note: "cooled from May's 3.4% (~3-year high)",
  },
  gdpGrowth: {
    period: "2026-04-01", label: "Q2 2026 advance GDP", value: 1.5, prev: 2.1,
    source: "BEA advance estimate", released: "2026-07-30",
    note: "decelerating from Q1's +2.1%, below consensus — drag from government spending and inventories; consumer spending accelerated",
  },
};
// Return the announced print only while it is NEWER than what the live series carries.
function announced(key, fredAsOf) {
  const a = ANNOUNCED_PRINTS[key];
  if (!a) return null;
  if (fredAsOf && String(fredAsOf) >= a.period) return null;   // FRED caught up → retire
  return a;
}

// ─── ANNOUNCED LABOUR PRINT (Amendment 3 — July Employment Situation) ──────────
// The July 2026 Employment Situation released 08:30 ET on 2026-08-07, ahead of FRED's ingest,
// so the live labour series still carry June until FRED updates. Rather than hardcode over the
// live fields, the released figures are overlaid here and AUTO-RETIRE the moment FRED's own
// emp-pop asOf reaches July. Values are the published figures; per-series deltas are computed
// against the live prior at overlay time so the month-over-month move is real, not asserted.
// emp-pop is not published as a headline — it is the identity participation × (1 − U3).
const LABOR_ANNOUNCED = {
  period: "2026-07-01", released: "2026-08-07", source: "BLS Employment Situation",
  u3: 4.1, participation: 61.4,
  empPop: +(61.4 * (1 - 4.1 / 100)).toFixed(1),   // 58.9 — identity, not a fabricated print
  payrollsDeltaK: -23,                             // the monthly change itself
  // Extras with no single live FRED series — the fixture the amendment supplies.
  revisions: [{ month: "May", k: -66 }, { month: "June", k: -37 }],
  twelveMoAvgK: 34,
  ytd: { householdK: -833, payrollK: 392, laborForceK: -1100 },
  ahe: { mom: 0.3, yoy: 3.5 },
};
// Returns { labor, applied, extras } — labor merged with the July overlay when FRED is behind.
function overlayJulyLabor(labor) {
  if (!labor) return { labor, applied: false, extras: null };
  const live = labor.empPop;
  if (live?.date && String(live.date) >= LABOR_ANNOUNCED.period) return { labor, applied: false, extras: null };
  const A = LABOR_ANNOUNCED;
  const d = (v, key) => labor[key]?.value != null ? +(v - labor[key].value).toFixed(1) : null;
  const set = (key, value, delta) => labor[key]
    ? { ...labor[key], value, delta, prev: labor[key].value ?? null, date: A.period, announced: true }
    : labor[key];
  const merged = {
    ...labor,
    u3: set("u3", A.u3, d(A.u3, "u3")),
    participation: set("participation", A.participation, d(A.participation, "participation")),
    empPop: set("empPop", A.empPop, d(A.empPop, "empPop")),
    payrolls: labor.payrolls
      ? { ...labor.payrolls, delta: A.payrollsDeltaK, date: A.period, announced: true }
      : labor.payrolls,
  };
  return { labor: merged, applied: true, extras: A };
}

// ─── FED LANGUAGE STATUS ──────────────────────────────────────────────────────
// Manually-updated status card (no live fetch). Update the STATUS fields below
// after each FOMC meeting / significant Fed communication. The five STATES
// definitions are stable and only change on explicit request.
const FED_LANGUAGE_STATUS = {
  status: "hawkish_hold", // current state — update manually
  lastUpdated: "2026-08-19",
  lastEvent: "July FOMC minutes (released Aug 19) — hawkish upgrade",
  decision: "HELD at 3.50–3.75% — fifth consecutive hold",
  vote: "9–3",
  dissents: "Hammack (Cleveland), Kashkari (Minneapolis), Logan (Dallas) — all three dissented FOR a 25bp HIKE",
  dissentNote: "Aug 19 minutes show 'many participants' saw further tightening as likely necessary — so the three dissents UNDERSTATE the committee's hawkishness",
  guidance: "NONE — Warsh continues removing forward guidance (\"family fight\", data-dependent). No new dot plot; next SEP is September. Warsh floated cutting FOMC meetings from 8 to 6 a year (no decision; 2026 schedule unaffected) — structurally significant: fewer meetings means larger moves per meeting.",
  summary: "Hawkish hold, upgraded by the Aug 19 minutes: 'many participants' assessed further tightening would likely be necessary — a material step up from June's 'only a few', so the three hike dissents understate committee hawkishness. Warsh framed inflation as \"a choice\", reaffirmed the 2% target and rejected any \"soft or implicit\" target, and flagged labour-market downside as the two-sided risk. The Board also discussed an intermeeting incident that disrupted transaction settlements. September is live in both directions.",
  bias: "Hold, hawkish bias, data-dependent — September live",
  nextEvent: "Jackson Hole Aug 27–29 (Warsh Fri Aug 28) · FOMC Sept 15–16 (decision Sept 16)",
};
// C3 — market-implied odds of a HIKE at the September FOMC. The single cleanest forward Fed metric.
// Sourced from CME FedWatch / the Kalshi Fed contracts (manual — no keyless feed). Moved from ~57%
// on the July decision day to ~34% after the August −23k payroll print.
const SEP_HIKE_ODDS = { value: 31, prior: 57, asOf: "2026-08-24", source: "CME FedWatch / Kalshi Fed contracts", note: "≈57% on the July decision day → ≈31% after three soft prints in a week (jobs, CPI, PPI); the consensus has moved from two 2026 hikes to one. Odds of NO change are the complement; a cut is not being priced." };
const FED_LANGUAGE_STATES = {
  hawkish_hold: {
    label: "🔴 Hawkish Hold",
    color: "#ef4444",
    bg: "#fef2f2",
    description: "Higher for longer dominant. No acknowledgment of downside risks. Rate cuts not on the table.",
    sgov_usfr: "Optimal hold. Yield stays elevated. No action needed.",
    ief_tlt: "Avoid. Duration risk with no catalyst for rate decline.",
    equities: "Hold existing positions. No new deployment. Stage 1-2 only.",
    watchFor: "Watch for: first mention of 'data dependent' flexibility, any acknowledgment of labor market softening, or dissenting dovish votes at FOMC.",
  },
  hawkish_tilt: {
    label: "🟠 Hawkish Tilt",
    color: "#f97316",
    bg: "#fff7ed",
    description: "Still holding but beginning to acknowledge growth risks or disinflation progress. 'Data dependent' language increasing.",
    sgov_usfr: "Still optimal. Yield may begin modest compression. No action yet.",
    ief_tlt: "Begin watching IEF. Do not buy yet — wait for neutral or better.",
    equities: "No deployment yet. Prepare Stage 4 checklist mentally.",
    watchFor: "Watch for: 'appropriate to begin discussing' rate adjustments, explicit acknowledgment of disinflation progress, two consecutive dovish dissenting votes.",
  },
  neutral: {
    label: "🟡 Neutral / Watching",
    color: "#eab308",
    bg: "#fefce8",
    description: "Balanced language. Internal debate visible. Historical pivot precursor — typically 1-2 meetings before first cut.",
    sgov_usfr: "Begin preparing rotation. Futures should be pricing 25-50bps cuts by now.",
    ief_tlt: "Buy IEF in partial size — first tranche only. Do not go full duration yet.",
    equities: "Stage 4 imminent. Finalize deployment target list. Confirm VIX trajectory.",
    watchFor: "Watch for: explicit 'easing may be appropriate' language, removal of 'higher for longer' phrasing, Fed Chair press conference tone shift.",
  },
  dovish_tilt: {
    label: "🟢 Dovish Tilt",
    color: "#22c55e",
    bg: "#f0fdf4",
    description: "Explicit acknowledgment that policy needs to ease. First cut likely within 1-2 meetings.",
    sgov_usfr: "Rotate now. Sell USFR → Buy IEF same day. Yield compression imminent.",
    ief_tlt: "Full IEF position. Consider partial TLT if deflation scenario confirmed.",
    equities: "Stage 4 active. Begin software sleeve deployment within 30 days of first cut.",
    watchFor: "Watch for: first actual cut, pace of subsequent cuts, terminal rate language.",
  },
  active_easing: {
    label: "🟢🟢 Active Easing",
    color: "#16a34a",
    bg: "#dcfce7",
    description: "Cutting cycle underway. Focus shifts to pace and terminal rate.",
    sgov_usfr: "Exit entirely. Yield collapsing. Hold only IBKR sweep for trading float.",
    ief_tlt: "IEF appreciating. Begin rolling proceeds into equities as positions fill.",
    equities: "Full Stage 4-5 deployment. Software first, hardware fills, ARM adds. Drift to 50/50 by mid-2027.",
    watchFor: "Watch for: pause signals, re-acceleration of inflation, terminal rate guidance.",
  },
};

// Section A — the consensus inputs are a VINTAGE, not a live feed. The refresh is deliberately
// deferred (Aug 7 jobs, Aug 28 BLS benchmark), but the engine keeps producing live-looking
// output in the meantime, so the vintage is stamped on the regime block itself rather than
// only in the table below it.
const CONSENSUS_VINTAGE = {
  asOf: "2026-06-30", label: "as of Jun 2026", staleNote: "2 months stale",
  deferredUntil: "Aug 7 (July Employment Situation) and Aug 28 (BLS benchmark revision)",
};

// ─── WALL STREET RECESSION PROBABILITY ────────────────────────────────────────
// Manually-updated source table. Last refreshed June 29, 2026 (post Iran peace
// deal + June FOMC). `color` drives the probability cell colour; `year` and
// `name` are used by the regime-probability derivation.
const RECESSION_SOURCES = [
  { name: "Goldman Sachs",             probability: "15%",    timeframe: "12-month", year: 2026, notes: "The current published figure and post-peace-deal: 25% (pre-Iran war) → 30% (March peak Hormuz) → 15% (June 26, post peace deal). No newer figure has been published since — the row is the latest print, not an overdue one. Cites lower oil, higher real income, AI wealth effect, solid capex; GDP H2 2026 +2.0%. Flags Fed rate-hike risk as the new variable.", asOf: "2026-06-26", color: "green" },
  { name: "NY Fed Yield Curve Model",  probability: "~15%",   timeframe: "12-month", year: 2026, notes: "May 2026 data. Based on 3M/10Y spread. Below historical alarm threshold of 30%. Yield curve now upward sloping: 10Y at 4.37%, 3M at 3.75%, spread +62bps. Structural improvement from prior inversion.", asOf: "2026-05-01", color: "green" },
  { name: "NY Fed DSGE Model",         probability: "35.8%",  timeframe: "12-month", year: 2026, notes: "March 2026. Recession = 4Q output growth below -1%. Down from 37.5% in December. Card said next update expected Q3 2026 — check for a Q3 print; if none, it stays archived.", asOf: "2026-03-01", color: "amber", archived: true, archiveReason: "March vintage. Conditional on the sustained oil shock that has since resolved — no post-deal revision published." },
  { name: "JPMorgan",                  probability: "35%",    timeframe: "12-month", year: 2026, notes: "March 2026. Warned markets complacent over a sustained oil shock. That shock resolved (Brent ~$91.57 vs the $105–115 the peak estimates assumed) and no post-deal figure was published.", asOf: "2026-03-01", color: "amber", archived: true, archiveReason: "March vintage. Explicitly conditional on a sustained oil shock that has since resolved — no post-deal revision published." },
  { name: "EY-Parthenon (Daco)",       probability: "40%",    timeframe: "12-month", year: 2026, notes: "March 2026. Risks framed as rising IF geopolitical tensions persist — they did not. No post-peace-deal revision published.", asOf: "2026-03-01", color: "amber", archived: true, archiveReason: "March vintage. Conditional on persisting geopolitical/oil tensions that have since resolved — no post-deal revision published." },
  { name: "Moody's Analytics (Zandi)", probability: "~49%",   timeframe: "12-month", year: 2026, notes: "March 2026 peak — 'on the precipice.' Zandi's own condition: 'if oil prices remain elevated for much longer — weeks not months.' They did not. No post-peace-deal figure published.", asOf: "2026-03-01", color: "red", archived: true, archiveReason: "March vintage. Zandi's estimate was explicitly conditional on oil staying elevated — it did not; the condition was not met and no revision was published." },
  { name: "Kalshi prediction market",  probability: "22%",    timeframe: "End-2026", year: 2026, notes: "June 2026. Up from 17.5% last month. Real-money market. CFTC-regulated. Slight uptick despite Iran peace deal — reflects lingering growth concerns.", asOf: "2026-06-01", color: "green" },
  { name: "Kalshi prediction market",  probability: "41%",    timeframe: "End-2027", year: 2027, notes: "Investors pricing delayed reckoning — debt refinancing at 5-7% vs near-zero rates, $1.3T consumer revolving credit, corporate capex compression. More concerning than 2026 figure.", asOf: "2026-06-01", color: "amber" },
  { name: "Polymarket",                probability: "~12.5%", timeframe: "End-2026", year: 2026, notes: "June 2026. Market-implied. 87.5% probability on No recession. Sahm Rule at 0.10 — well below 0.50 threshold. Lowest of all sources.", color: "green" },
  { name: "BNP Paribas",               probability: "Low",    timeframe: "12-month", year: 2026, notes: "Qualitative only — excluded from weighted average. 'Well-positioned to absorb shock.' US net energy exporter status cited. No numeric update available.", color: "green" },
  { name: "July FOMC Minutes", probability: "Elevated", timeframe: "qualitative", year: 2026, notes: "Released Aug 19, 2026. 'Many participants' assessed further policy tightening would likely be necessary — a material upgrade from June's 'only a few', so the three hike dissents UNDERSTATE the committee's hawkishness. Warsh floated cutting FOMC meetings from 8 to 6 a year (no decision; 2026 schedule unaffected). Board discussed an intermeeting incident disrupting transaction settlements.", asOf: "2026-08-19", color: "amber" },
];

// Weighted-average weights per source. Sum is 1.10 (intentional — the average
// divides by the realized total weight, so it need not sum to 1.0). Sources not
// listed here (e.g. BNP "Low") are excluded automatically.
const RECESSION_SOURCE_WEIGHTS = {
  "NY Fed DSGE Model": 0.18,
  "NY Fed Yield Curve Model": 0.20,
  "Goldman Sachs": 0.20,
  "JPMorgan": 0.15,
  "EY-Parthenon (Daco)": 0.07,
  "Moody's Analytics (Zandi)": 0.10,
  "Kalshi prediction market": 0.10, // 2026 row only; 2027 row handled separately
  "Polymarket": 0.10,
};

// Published revision history per source — the same trajectories already narrated in each row's
// `notes`, structured so they can be scored instead of just read. Dates are the publication dates
// where known; sourceScore() grades on the SEQUENCE (reversals, move sizes), so an approximate
// date does not corrupt the grade — only the "days since" readout depends on the last one.
// Nothing here is a new figure: every value appears in the row notes above.
const RECESSION_REVISIONS = {
  "Goldman Sachs": [
    { asOf: "2026-02-15", prob: 25, note: "pre-Iran war" },
    { asOf: "2026-03-25", prob: 30, note: "March peak — Hormuz oil shock" },
    { asOf: "2026-06-26", prob: 15, note: "post peace deal — oil lower, capex solid" },
  ],
  "Kalshi prediction market": [
    { asOf: "2026-05-01", prob: 17.5, note: "prior month" },
    { asOf: "2026-06-01", prob: 22, note: "uptick despite the peace deal — lingering growth concern" },
  ],
  "NY Fed DSGE Model": [
    { asOf: "2025-12-01", prob: 37.5, note: "December vintage" },
    { asOf: "2026-03-01", prob: 35.8, note: "March vintage — since archived" },
  ],
};

// Expected publication cadence per source, in days — how often THIS source actually publishes a
// recession probability. The as-of chip used to flag every row past a flat 45 days as "stale",
// which conflated two different things: a number that is simply the source's LATEST print (a
// research house publishes episodically — Goldman's 60-day-old 15% is its current view, not an
// overdue fetch) and a number that is genuinely PAST DUE (the NY Fed DSGE model publishes monthly;
// at 177 days something is actually wrong). Flagging both identically trained the eye to ignore the
// flag and sent the reader hunting for updates that do not exist. Within cadence → neutral "latest";
// past cadence → amber "overdue", which now means something. This is presentation only: the
// weighted average is unaffected — recencyFactor() above still decays every source linearly to
// zero at 180 days regardless of cadence, which is the correct treatment for the MATH.
const RECESSION_SOURCE_CADENCE = {
  "NY Fed DSGE Model": 30,              // quarterly-ish model run, published monthly
  "NY Fed Yield Curve Model": 30,       // monthly update (auto-fed daily here)
  "Kalshi prediction market": 1,        // live market — any gap is a feed failure
  "Kalshi prediction market 2027": 1,
  "Polymarket": 1,
  "Goldman Sachs": 120,                 // episodic research note, event-driven
  "JPMorgan": 120,
  "Moody's Analytics (Zandi)": 120,
  "EY-Parthenon (Daco)": 120,
  "BNP Paribas": 120,
  "July FOMC Minutes": 45,              // tied to the FOMC calendar (8 meetings/yr)
};
const RECESSION_DEFAULT_CADENCE = 90;

// Age + whether the source is genuinely OVERDUE for its own cadence.
function recessionAsOfState(name, asOf) {
  if (!asOf) return null;
  const days = Math.round((Date.now() - new Date(asOf + "T00:00:00Z")) / 864e5);
  const cadence = RECESSION_SOURCE_CADENCE[name] ?? RECESSION_DEFAULT_CADENCE;
  return { days, cadence, overdue: days > cadence };
}

// Parse a probability string ("~15%", "35.8%", "Low") to a number, or null.
const parseProbability = (probStr) => {
  if (!probStr || probStr === "Low" || probStr === "High") return null;
  const cleaned = probStr.replace("~", "").replace("%", "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
};

// A source's weight decays LINEARLY to zero by this age. A March-2026 crisis-peak estimate
// (≈160 days old on 2026-08-07) was carrying full weight in the average that feeds the regime
// engine — a defect. Decay (rather than a hard 45-day cliff) fades old vintages without a jump,
// and fully drops anything ≥180 days. Sources with no asOf are treated as current.
const RECESSION_STALE_ZERO_DAYS = 180;
function recencyFactor(asOf, nowIso) {
  if (!asOf || !nowIso) return 1;
  const age = Math.round((Date.parse(nowIso) - Date.parse(asOf)) / 86400000);
  if (!Number.isFinite(age) || age <= 0) return 1;
  if (age >= RECESSION_STALE_ZERO_DAYS) return 0;
  return +(1 - age / RECESSION_STALE_ZERO_DAYS).toFixed(3);
}

// Weighted average of the 2026 recession-probability sources, recency-decayed. The Kalshi 2027
// row is pulled out separately as the delayed-reckoning modifier input. `nowIso` (YYYY-MM-DD)
// drives the decay; pass null to disable it (full weight, the old behaviour).
const computeWeightedRecessionProb = (sources, nowIso = null) => {
  let weightedSum = 0, totalWeight = 0, kalshi2027 = null;
  const decayed = [];
  sources.forEach(source => {
    if (source.name === "Kalshi prediction market" && source.year === 2027) {
      kalshi2027 = parseProbability(source.probability);
      return;
    }
    // A1 — archived vintages (condition invalidated) are excluded outright, not decayed. Decay
    // handles aging; it does not handle a forecast whose stated precondition no longer holds.
    if (source.archived) return;
    const weight = RECESSION_SOURCE_WEIGHTS[source.name];
    const prob = parseProbability(source.probability);
    if (!weight || prob === null) return;
    const factor = recencyFactor(source.asOf, nowIso);
    if (factor < 0.999) decayed.push({ name: source.name, asOf: source.asOf, factor });
    const eff = weight * factor;
    if (eff > 0) { weightedSum += prob * eff; totalWeight += eff; }
  });
  const weightedAvg = totalWeight > 0 ? weightedSum / totalWeight : null;

  // ── Horizon-split consensus (lib/recession.js) ──
  // `weightedAvg` above is the LEGACY all-horizons blend, kept only so the change is auditable.
  // It mixed rolling-12m forecasts with calendar-year contracts whose window shrinks toward
  // Dec 31, which dragged the number down for calendar reasons alone. The regime engine now
  // consumes `rolling` — the horizon it actually asks about ("recession within 12 months").
  const rows = sources
    .filter(s => !(s.name === "Kalshi prediction market" && s.year === 2027))
    .map(s => ({
      name: s.name, prob: parseProbability(s.probability),
      weight: RECESSION_SOURCE_WEIGHTS[s.name] || 0,
      recency: recencyFactor(s.asOf, nowIso),
      asOf: s.asOf, year: s.year, timeframe: s.timeframe, archived: s.archived,
    }));
  const rolling  = consensusFor(rows, HORIZON.ROLLING);
  const calendar = consensusFor(rows, HORIZON.CALENDAR);
  const calWindow = calendarWindow(nowIso || new Date().toISOString().slice(0, 10), 2026);

  return {
    weightedAvg,          // legacy blend — displayed for comparison, no longer drives the engine
    regimeInput: rolling.value ?? weightedAvg,   // what the regime engine consumes
    rolling, calendar, calWindow,
    kalshi2027, decayed,
  };
};

// Two Kalshi rows share the name "Kalshi prediction market" (2026 vs 2027), so a bare name is
// not a unique key for feed/override addressing. This composite key disambiguates them and is
// used identically on the server (api/indicators recessionFeeds keys) and in the manual store.
const recessionSrcKey = (r) =>
  (r.name === "Kalshi prediction market" && r.year === 2027) ? "Kalshi prediction market 2027" : r.name;

// Merge live auto-feeds (Task 1a) and manual overrides (Task 1b) over the static rows.
// Precedence per row: manual override > auto-feed > static default. Only probability/asOf/notes
// are touched; weight and timeframe always come from the static definition. `source` records the
// provenance so the table can badge each row (📡 live / ✍️ manual / static).
function mergeRecessionSources(statics, feeds = {}, manual = {}) {
  const fmtPct = (v) => (/%/.test(String(v)) ? String(v) : `${v}%`);
  return statics.map((r) => {
    const key = recessionSrcKey(r);
    const man = manual[key];
    if (man && man.probability != null && man.probability !== "") {
      return { ...r, probability: fmtPct(man.probability), asOf: man.asOf || r.asOf,
        notes: man.notes || r.notes, source: "manual", sourceAt: man.enteredAt || null };
    }
    const auto = feeds[key];
    if (auto && auto.probability != null) {
      // Live rows carry their OWN note ("Live real-money market…", "Model-derived…") so the row's
      // static prose — written for the old hand-entered value — can't contradict the fresh number.
      return { ...r, probability: fmtPct(auto.probability), asOf: auto.asOf || r.asOf, notes: auto.note || r.notes, source: "auto" };
    }
    return { ...r, source: "static" };
  });
}

// Task 1b — manual-entry panel for the recession sources, on the same POST-to-/api/manual-entry
// pattern as the KOFIA / fed-path / intervention panels. Source dropdown → probability → as-of →
// notes → save; a save writes an override keyed by recessionSrcKey that outranks the live feed and
// the static default, and Clear removes it. Always rendered; an unauthenticated save 401s and the
// error is shown inline (no client-side gate — the cookie check lives on the server).
function RecessionEntryPanel({ overrides, onSaved }) {
  const options = RECESSION_SOURCES.map((r) => ({
    key: recessionSrcKey(r),
    label: r.name + (r.year === 2027 ? " · End-2027" : ""),
  }));
  const [sel, setSel] = useState(options[0].key);
  const [prob, setProb] = useState("");
  const [asOf, setAsOf] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  const current = overrides?.[sel] || null;
  // Prefill from the existing override when the operator switches source, so an edit starts from
  // what is stored rather than blank. Deliberately keyed on `sel` only — retyping should not be
  // clobbered by a background refresh of `overrides`.
  useEffect(() => {
    setProb(current?.probability != null ? String(current.probability) : "");
    setAsOf(current?.asOf || "");
    setNotes(current?.notes || "");
    setMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);

  async function save(clear = false) {
    if (!clear && !/\d/.test(prob)) { setMsg({ ok: false, text: "enter a probability (a number, e.g. 22 or ~18%)" }); return; }
    if (!clear && asOf.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(asOf.trim())) { setMsg({ ok: false, text: "as-of must be YYYY-MM-DD" }); return; }
    setSaving(true); setMsg(null);
    try {
      const body = clear
        ? { recession: { name: sel, clear: true } }
        : { recession: { name: sel, probability: prob.trim(), asOf: asOf.trim() || null, notes: notes.trim() || null } };
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" },
        credentials: "include", body: JSON.stringify(body),
      });
      const j = await r.json();
      if (r.ok) {
        const fresh = await fetch("/api/manual-entry").then((x) => x.json()).catch(() => null);
        onSaved?.(fresh?.recession || {});
        setMsg({ ok: true, text: clear ? "Override cleared — feed/static value restored" : `Saved — ${sel} now ${/%/.test(prob) ? prob : prob + "%"}` });
        if (clear) { setProb(""); setAsOf(""); setNotes(""); }
      } else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }

  const inp = { padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6, background: "#fff", color: C.text };
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <SLabel>✍️ Manual recession-source entry</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>overrides the feed &amp; static value · commits to the store</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={sel} onChange={(e) => setSel(e.target.value)} style={{ ...inp, flex: "1 1 210px", minWidth: 0 }}>
          {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <input value={prob} onChange={(e) => setProb(e.target.value)} placeholder="probability (e.g. 22 or ~18%)"
          style={{ ...inp, flex: "1 1 150px", minWidth: 0 }} />
        <input value={asOf} onChange={(e) => setAsOf(e.target.value)} placeholder="as-of (YYYY-MM-DD)"
          style={{ ...inp, flex: "1 1 130px", minWidth: 0 }} />
      </div>
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="notes (optional)"
        style={{ ...inp, width: "100%", marginTop: 8, boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={() => save(false)} disabled={saving}
          style={{ background: C.blue, color: "#fff", border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12.5, fontWeight: 800, cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save override"}
        </button>
        {current && (
          <button onClick={() => save(true)} disabled={saving}
            style={{ background: "#fff", color: C.mid, border: "1.5px solid " + C.bdrMd, borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: saving ? "wait" : "pointer" }}>
            Clear override
          </button>
        )}
        {current && (
          <span style={{ fontSize: 11, color: C.blue, fontWeight: 700 }}>
            active: {current.probability}{current.asOf ? ` · ${current.asOf}` : ""}
          </span>
        )}
      </div>
      {msg && <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 8, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
    </Card>
  );
}

// Map weighted recession prob (+ live CPI + Kalshi 2027) to regime probabilities.
// (regime probability mapping + contested guard now live in lib/regimeProb.js — see there
//  for why the reflationary share must be EARNED rather than granted.)

// ─── DATA SOURCE CONFIG ───────────────────────────────────────────────────────
//
//  HOW TO CONFIGURE LIVE DATA FOR DEPLOYMENT
//  ─────────────────────────────────────────
//  This app supports three data source modes. Set DATA_SOURCE below:
//
//  "claude"   — Works only inside Claude.ai artifact sandbox (current default).
//               No API key needed there, but won't work when self-hosted.
//
//  "polygon"  — Uses Massive.com free tier (5 req/min, delayed 15min on free plan).
//               (Massive = formerly Polygon.io, rebranded Oct 2025. Same API, same keys.)
//               Sign up free at https://massive.com → copy your API key below.
//               (formerly Polygon.io — rebranded Oct 2025, same API, same keys)
//               Free tier covers all tickers in this dashboard.
//
//  "proxy"    — You run a small backend endpoint at /api/prices and /api/indicators.
//               Most secure: API key never touches the browser.
//               See DEPLOYMENT.md (generated alongside this file) for exact code.
//
const DATA_SOURCE = "proxy"; // change to "polygon" or "proxy" when deploying
const MASSIVE_API_KEY = "YOUR_MASSIVE_API_KEY_HERE"; // only needed for "polygon" mode
const PROXY_BASE_URL = "/api"; // only needed for "proxy" mode — adjust if different

// ─── PRICE FETCHER ────────────────────────────────────────────────────────────
// Fetches { price, changePercent } for a batch of tickers using the active source.
async function fetchTickerPrices(tickers) {
  if (!tickers || !tickers.length) return {};

  // ── Option A (REMOVED): an LLM call is not a price feed ──
  // A prior version asked a model to "return today's price" for each ticker. With no market-data
  // tool wired in, the model answers from training data — a plausible number rendered as a live
  // quote. That is fabricated data presented as a feed, and it is never acceptable (enforced by
  // scripts/check-no-llm-feeds.mjs). Prices come only from the /api/prices proxy below.
  if (DATA_SOURCE === "claude") {
    throw new Error("DATA_SOURCE 'claude' is disabled — an LLM cannot stand in for a price feed. Use 'proxy'.");
  }

  // ── Option B: Massive.com (client-side, free tier) ──
  // Free tier: 15-min delayed quotes. Upgrade to Starter ($29/mo) for real-time.
  // Rate limit: 5 calls/minute on free tier — we batch into one call per ticker
  // then merge results. For >5 tickers, calls are staggered 200ms apart.
  if (DATA_SOURCE === "polygon") {
    const results = {};
    for (let i = 0; i < tickers.length; i++) {
      const ticker = tickers[i];
      // Stagger requests to avoid rate limit
      if (i > 0) await new Promise(r => setTimeout(r, 250));
      try {
        const res = await fetch(
          `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${MASSIVE_API_KEY}`
        );
        const data = await res.json();
        const snap = data?.ticker;
        if (snap) {
          results[ticker] = {
            price: snap.day?.c ?? snap.prevDay?.c ?? 0,
            changePercent: snap.todaysChangePerc ?? 0,
          };
        }
      } catch (e) {
        console.warn("Massive fetch failed for", ticker, e);
      }
    }
    return results;
  }

  // ── Option C: Backend proxy (most secure, recommended for production) ──
  // Your serverless function at /api/prices receives tickers and returns the
  // same { TICK: { price, changePercent } } shape. API key stays server-side.
  if (DATA_SOURCE === "proxy") {
    const res = await fetch(`${PROXY_BASE_URL}/prices?tickers=${tickers.join(",")}&t=${Date.now()}`, {
      credentials: "include",
    });    if (!res.ok) throw new Error("Proxy error " + res.status);
    return await res.json();
  }

  return {};
}

// ─── INDICATOR FETCHER ────────────────────────────────────────────────────────
// Returns { yieldSpread, tenY, twoY, unemployment, creditSpread }
async function fetchMacroIndicators() {
  // Removed: the same LLM-as-feed anti-pattern for macro values. Indicators come only from the
  // /api/indicators proxy (FRED / Treasury / Yahoo, server-side keys). See check-no-llm-feeds.mjs.
  if (DATA_SOURCE === "claude") {
    throw new Error("DATA_SOURCE 'claude' is disabled — an LLM cannot stand in for a data feed. Use 'proxy'.");
  }

  if (DATA_SOURCE === "polygon") {
    // Massive (formerly Polygon) doesn't cover macro indicators on free tier —
    // the US Treasury's public JSON API (free, no key required).
    // HY spreads require a paid data provider; we return null for that field.
    try {
      const res = await fetch("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=" + new Date().toISOString().slice(0,7).replace("-",""));
      // Treasury returns XML; parsing is complex — recommend proxy mode for indicators
      console.info("Treasury XML parsing not implemented client-side. Use proxy mode for live indicators.");
      return null;
    } catch (e) {
      return null;
    }
  }

  if (DATA_SOURCE === "proxy") {
    const res = await fetch(`${PROXY_BASE_URL}/indicators?t=${Date.now()}`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    return await res.json();
  }

  return null;
}

// Tickers fetched by the header "Refresh All" button and the on-mount auto-fetch.
const HEADER_TICKERS = ["AAPL","AXP","KO","BAC","CVX","OXY","GOOGL","DAL","BN","AMZN","UBER","MSFT","SPY","NVDA","AVGO","MU","TSM","NTRA","EWZ","ARGT","BABA","META","CRWD","GDX","XLP","TLT","EPD","O","JEPI","BIL","IBIT","FBTC","BTC-USD"];

// ─── SHARED HOOKS ─────────────────────────────────────────────────────────────
// localStorage cache so the last successful fetch survives a page reload, instead
// of resetting to the hardcoded static fallbacks (oil 88, spread 2.75, prices "—").
function cacheLoad(key, fallback) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : fallback; }
  catch (_) { return fallback; }
}
function cacheSave(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}
function cacheLoadDate(key) {
  try { const s = localStorage.getItem(key); return s ? new Date(s) : null; }
  catch (_) { return null; }
}

function useLivePrices() {
  const [prices, setPrices] = useState(() => cacheLoad("cache_prices_v1", {}));
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(() => cacheLoadDate("cache_prices_updated_v1"));

  const fetchPrices = useCallback(async function(tickers) {
    if (!tickers || !tickers.length) return;
    setLoading(true);
    try {
      const result = await fetchTickerPrices(tickers);
      if (result && Object.keys(result).length) {
        setPrices(prev => {
          const merged = { ...prev, ...result };
          cacheSave("cache_prices_v1", merged);
          return merged;
        });
        const now = new Date();
        setUpdated(now);
        try { localStorage.setItem("cache_prices_updated_v1", now.toISOString()); } catch (_) {}
      }
    } catch (e) { console.error("Price fetch error:", e); }
    setLoading(false);
  }, []);

  return { prices, loading, updated, fetchPrices };
}

function useLiveIndicators() {
  const [live, setLive] = useState(() => cacheLoad("cache_indicators_v1", null));
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(() => cacheLoadDate("cache_indicators_updated_v1"));
  const [error, setError] = useState(null);

  const fetchIndicators = useCallback(async function() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMacroIndicators();
      // Validate: reject if all key values are zero or missing (failed API call)
      const isValid = result &&
        (result.tenY > 0 || result.unemployment > 0 || result.creditSpread > 0);
      if (isValid) {
        setLive(result);
        const now = new Date();
        setUpdated(now);
        setError(null);
        cacheSave("cache_indicators_v1", result);
        try { localStorage.setItem("cache_indicators_updated_v1", now.toISOString()); } catch (_) {}
      } else if (result) {
        // Got a response but values are all zero — API key likely not configured
        setError("API returned zero values — check FRED_API_KEY is set in Vercel environment variables.");
      } else {
        setError("Could not reach indicators API. Check FRED_API_KEY in Vercel settings.");
      }
    } catch (e) {
      console.error("Indicator fetch error:", e);
      setError("Fetch error: " + e.message);
    }
    setLoading(false);
  }, []);

  return { live, loading, updated, error, fetchIndicators };
}

// ─── PLAYBOOK FETCHER (Global Playbook tab) ──────────────────────────────────
// Hits the /api/playbook proxy (structured spine + regime, no model). Cached per
// region in localStorage so switching tabs/regions shows the last value instantly.
async function fetchPlaybook(region) {
  const res = await fetch(`${PROXY_BASE_URL}/playbook?region=${region}&t=${Date.now()}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error("Playbook error " + res.status);
  return await res.json();
}

function useLivePlaybook() {
  // Cache key is VERSIONED: the playbook payload shape changes as the spine grows (v2 added
  // regime.aiAxis + per-name session). Bumping the key retires payloads of an older shape
  // instead of rehydrating them into a renderer that expects the new fields.
  const [byRegion, setByRegion] = useState(() => cacheLoad("cache_playbook_v2", {}));
  const [loading, setLoading]   = useState(false);
  const [updated, setUpdated]   = useState(() => cacheLoadDate("cache_playbook_updated_v1"));
  const [error, setError]       = useState(null);

  const fetchRegion = useCallback(async function(region) {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPlaybook(region);
      if (data && data.region) {
        setByRegion(prev => {
          const merged = { ...prev, [region]: data };
          cacheSave("cache_playbook_v2", merged);
          return merged;
        });
        const now = new Date();
        setUpdated(now);
        try { localStorage.setItem("cache_playbook_updated_v1", now.toISOString()); } catch (_) {}
      } else {
        setError("Playbook returned no data.");
      }
    } catch (e) {
      console.error("Playbook fetch error:", e);
      setError("Fetch error: " + e.message);
    }
    setLoading(false);
  }, []);

  return { byRegion, loading, updated, error, fetchRegion };
}

async function loadFunds() {
  try {
    const r = await window.storage.get("funds_v4");
    if (r && r.value) {
      const p = JSON.parse(r.value);
      if (Array.isArray(p) && p.length) return p;
    }
  } catch (_) {}
  return null;
}

async function persistFunds(funds) {
  try { await window.storage.set("funds_v4", JSON.stringify(funds)); } catch (_) {}
}

// ─── TICKER → COMPANY NAME MAP ───────────────────────────────────────────────
const COMPANY_NAMES = {
  AAPL:"Apple", AXP:"American Express", KO:"Coca-Cola", BAC:"Bank of America",
  CVX:"Chevron", OXY:"Occidental Petroleum", GOOGL:"Alphabet (Google)",
  CB:"Chubb", MCO:"Moody's", DAL:"Delta Air Lines", BN:"Brookfield Asset Mgmt",
  AMZN:"Amazon", UBER:"Uber", MSFT:"Microsoft", QSR:"Restaurant Brands",
  HHH:"Howard Hughes", FNMA:"Fannie Mae", SPY:"S&P 500 ETF", IVV:"iShares S&P 500",
  NVDA:"Nvidia", AVGO:"Broadcom", MU:"Micron Technology", ORCL:"Oracle",
  TSM:"Taiwan Semiconductor", NTRA:"Natera", ETHB:"Ethereum ETF",
  INSM:"Insmed", EWZ:"Brazil ETF", ARGT:"Argentina ETF", SNDK:"SanDisk",
  HUM:"Humana", "JD.com":"JD.com", INTC:"Intel", HOOD:"Robinhood",
  BABA:"Alibaba", META:"Meta Platforms", CRWD:"CrowdStrike", W:"Wayfair",
  GDX:"Gold Miners ETF", GDXJ:"Junior Gold Miners ETF", RING:"Global Gold Miners ETF",
  AEM:"Agnico Eagle", NEM:"Newmont", ABX:"Barrick Mining", WPM:"Wheaton Precious Metals",
  XLP:"Consumer Staples ETF", PG:"Procter & Gamble", PEP:"PepsiCo",
  WMT:"Walmart", COST:"Costco", MDLZ:"Mondelez",
  TLT:"20+ Year Treasury ETF", IEF:"7-10 Year Treasury ETF",
  ZROZ:"25+ Zero Coupon ETF", BIL:"1-3 Month T-Bill ETF",
  LAND:"Gladstone Land", FPI:"Farmland Partners",
  EPD:"Enterprise Products", ET:"Energy Transfer", MPLX:"MPLX LP",
  KMI:"Kinder Morgan", AMLP:"Alerian MLP ETF",
  O:"Realty Income", NNN:"NNN REIT", WPC:"W.P. Carey", STAG:"STAG Industrial",
  JNJ:"Johnson & Johnson", SCHD:"Schwab Dividend ETF", VIG:"Vanguard Div. Appreciation",
  JEPI:"JPMorgan Equity Premium", JEPQ:"JPMorgan Nasdaq Premium",
  XYLD:"Global X S&P 500 Covered Call", PFF:"iShares Preferred Securities",
  PFFD:"Global X Preferred ETF", SGOV:"0-3 Month T-Bill ETF",
  USFR:"WisdomTree Floating Rate Treasury", ARM:"ARM Holdings",
  SE:"Sea Ltd", GEV:"GE Vernova", LRCX:"Lam Research", SPOT:"Spotify",
  CPNG:"Coupang", AMAT:"Applied Materials", CPAY:"Corpay", GOOG:"Alphabet (Google)",
  VST:"Vistra", EWY:"South Korea ETF", NRG:"NRG Energy", GLW:"Corning", WHR:"Whirlpool",
  CRM:"Salesforce", ADBE:"Adobe", BKNG:"Booking Holdings", AMD:"Adv. Micro Devices",
  RSP:"S&P 500 Equal-Weight ETF", YPF:"YPF SA", WWD:"Woodward", TEVA:"Teva Pharma",
  CAI:"Caris Life Sciences", STX:"Seagate Technology",
  "EUROB.AT":"Eurobank Ergasias (Greece)", FFXDF:"Fairfax India Holdings",
  KW:"Kennedy-Wilson", BB:"BlackBerry", ORLA:"Orla Mining",
  FRFHF:"Fairfax Financial (buybacks)", CIBEY:"Commercial Int'l Bank (Egypt)",
  "DXT.TO":"Dexterra Group",
  Other:"Various",
};
function Pill({ label, color, bg, bdr }) {
  return (
    <span style={{ background: bg || color + "18", color, border: "1.5px solid " + (bdr || color + "44"), borderRadius: 6, padding: "3px 9px", fontSize: 12, fontWeight: 800 }}>
      {label}
    </span>
  );
}
function SLabel({ children, color }) {
  return <div style={{ fontSize: 12, letterSpacing: 2.5, color: color || C.lbl, textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>{children}</div>;
}
function Card({ children, style, onClick }) {
  return <div onClick={onClick} style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 5px rgba(0,0,0,.05)", ...style }}>{children}</div>;
}
function Btn({ onClick, disabled, color, bgColor, label }) {
  return (
    <button onClick={onClick} disabled={!!disabled} style={{ background: bgColor || color, color: bgColor ? color : "#fff", border: bgColor ? "1.5px solid " + color + "60" : "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: disabled ? 0.6 : 1, whiteSpace: "nowrap" }}>
      {label}
    </button>
  );
}
function ActionBadge({ action }) {
  const M = { bought:["#166534","#F0FDF4","NEW BUY"], added:["#166534","#F0FDF4","ADDED"], hold:["#6B7280","#F9FAFB","HOLD"], trim:["#B45309","#FFFBEB","TRIM"], exit:["#991B1B","#FEF2F2","EXIT"], "+50%":["#166534","#F0FDF4","+50%"], mixed:["#6B7280","#F9FAFB","MIX"] };
  const [fg, bg, lbl] = M[action] || ["#6B7280", "#F9FAFB", action];
  return <span style={{ background: bg, color: fg, border: "1px solid " + fg + "33", borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>{lbl}</span>;
}
// Exchange deep-links for foreign names Yahoo doesn't cover (manual price entry).
const EXCHANGE_LINKS = {
  "DEWA.AE":     "https://www.dfm.ae/the-exchange/market-information/company/DEWA/trading",
  "ADNOCGAS.AE": "https://www.adx.ae/English/Pages/SecurityDetails.aspx?Symbol=ADNOCGAS",
  "EMAAR.AE":    "https://www.dfm.ae/the-exchange/market-information/company/EMAAR/trading",
  "FAB.AE":      "https://www.adx.ae/English/Pages/SecurityDetails.aspx?Symbol=FAB",
};
const CA_TICKERS = new Set(["ENB", "FTS", "CNR"]); // Canadian names listed in USD on NYSE
function ccyPrefix(ticker) {
  if (typeof ticker !== "string") return "$";
  if (ticker.endsWith(".TO")) return "C$";
  if (ticker.endsWith(".HK")) return "HK$";
  if (ticker.endsWith(".AE")) return "AED ";
  return "$";
}
function regionOf(ticker) {
  if (typeof ticker !== "string") return null;
  if (ticker.endsWith(".AE")) return { flag: "🇦🇪", title: "UAE — ADX/DFM" };
  if (ticker.endsWith(".HK")) return { flag: "🇭🇰", title: "Hong Kong — HKEX" };
  if (ticker.endsWith(".TO") || CA_TICKERS.has(ticker)) return { flag: "🇨🇦", title: "Canada — TSX/NYSE" };
  return null;
}
function RegionBadge({ ticker }) {
  const r = regionOf(ticker);
  if (!r) return null;
  return (
    <span style={{ fontSize: 14, lineHeight: 1, marginRight: 4 }} title={r.title}>
      {r.flag}
    </span>
  );
}
function readManual(ticker) {
  try { return { price: localStorage.getItem("manual_price_" + ticker), date: localStorage.getItem("manual_price_date_" + ticker) }; }
  catch (_) { return { price: null, date: null }; }
}
// Format a stored ISO date as e.g. "Jun 25, 2026" (tolerant of "YYYY-MM-DD" too).
function fmtManualDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
// Manual price entry for tickers with no live feed (ADX/DFM names). Mirrors the
// recession-table manual-update pattern: saved price shown live-style with a ✏️ to
// edit, "Updated: <date>" beneath, exchange deep-link always visible.
function ManualPrice({ ticker }) {
  const stored = readManual(ticker);
  const [editing, setEditing] = useState(false);
  const [val, setVal]   = useState(stored.price || "");
  const [date, setDate] = useState(stored.date || "");
  const [draft, setDraft] = useState(stored.price || "");
  const link = EXCHANGE_LINKS[ticker];
  function commit() {
    setEditing(false);
    const clean = String(draft).replace(/[^0-9.]/g, "");
    if (!clean) return;
    const isoNow = new Date().toISOString();
    try {
      localStorage.setItem("manual_price_" + ticker, clean);
      localStorage.setItem("manual_price_date_" + ticker, isoNow);
    } catch (_) {}
    setVal(clean); setDate(isoNow);
  }
  const linkIcon = link && (
    <a href={link} target="_blank" rel="noopener noreferrer" title="Open exchange page" style={{ fontSize: 12, textDecoration: "none" }}>🔗</a>
  );
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      {editing ? (
        <input
          autoFocus value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          type="number" step="0.01" placeholder="price"
          style={{ width: 70, fontSize: 13, padding: "2px 5px", border: "1.5px solid " + C.blBdr, borderRadius: 5, color: C.text }}
        />
      ) : val ? (
        <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.25 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{ccyPrefix(ticker)}{val}</span>
            <span onClick={() => { setDraft(val); setEditing(true); }} title="Edit price" style={{ cursor: "pointer", fontSize: 11 }}>✏️</span>
          </span>
          {date && <span style={{ color: C.lbl, fontSize: 10 }}>Updated: {fmtManualDate(date)}</span>}
        </span>
      ) : (
        <span onClick={() => { setDraft(""); setEditing(true); }} title="Tap to enter price" style={{ cursor: "pointer", color: C.lbl, fontSize: 12, fontStyle: "italic" }}>
          Tap to enter price
        </span>
      )}
      {linkIcon}
    </span>
  );
}
function PriceBadge({ ticker, prices }) {
  const p = prices[ticker];
  const isAE = typeof ticker === "string" && ticker.endsWith(".AE");
  // No live price → manual entry for unsupported feeds (.AE) or any ticker the
  // user has already saved a manual price for; otherwise the usual placeholder.
  if (!p) {
    if (isAE || readManual(ticker).price) return <ManualPrice ticker={ticker} />;
    return <span style={{ color: C.lbl, fontSize: 12 }}>—</span>;
  }
  const up = (p.changePercent || 0) >= 0;
  const col = up ? C.green : C.red;
  const link = EXCHANGE_LINKS[ticker];
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{ccyPrefix(ticker)}{(p.price || 0).toFixed(2)}</span>
      <span style={{ color: col, fontWeight: 700, fontSize: 13 }}>
        {up ? "↑" : "↓"}{Math.abs(p.changePercent || 0).toFixed(2)}%
      </span>
      {link && <a href={link} target="_blank" rel="noopener noreferrer" title="Open exchange page" style={{ fontSize: 12, textDecoration: "none" }}>🔗</a>}
    </span>
  );
}
function ChartTip({ active, payload, label, fmt }) {
  if (!active || !payload || !payload.length) return null;
  return <div style={{ background: "#fff", border: "1px solid " + C.bdr, borderRadius: 8, padding: "8px 12px", boxShadow: "0 2px 8px rgba(0,0,0,.1)" }}>
    <div style={{ color: C.muted, fontSize: 12, marginBottom: 2 }}>{label}</div>
    <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>{fmt ? fmt(payload[0].value) : payload[0].value}</div>
  </div>;
}

// Format a source date. Monthly series → "Jun'26"; daily → the full ISO date.
function fmtAsOf(dateStr, monthly) {
  if (!dateStr) return null;
  const dt = new Date(dateStr + "T00:00:00");
  if (isNaN(dt)) return dateStr;
  return monthly
    ? dt.toLocaleString("en-US", { month: "short" }) + "'" + String(dt.getFullYear()).slice(2)
    : dateStr;
}

// ─── INDICATOR CHART ─────────────────────────────────────────────────────────
function IndicatorChart({ ind, live }) {
  const current = ind.id === "yield" && live ? (live.yieldSpread >= 0 ? "+" : "") + live.yieldSpread.toFixed(2) + "%" :
                  ind.id === "unemp" && live ? live.unemployment.toFixed(1) + "%" :
                  ind.id === "credit" && live ? live.creditSpread.toFixed(2) + "%" :
                  ind.current;
  const statusColor = ind.status === "GREEN" ? C.green : ind.status === "RED" ? C.red : C.amber;
  const statusBg    = ind.status === "GREEN" ? C.gBg   : ind.status === "RED" ? C.rBg  : C.aBg;
  const statusBdr   = ind.status === "GREEN" ? C.gBdr  : ind.status === "RED" ? C.rBdr : C.aBdr;

  // Source date (asOf) for this metric — monthly for unemployment, daily otherwise.
  const asOfKey = ind.id === "unemp" ? "unemployment" : ind.id === "yield" ? "yieldSpread" : ind.id === "credit" ? "creditSpread" : null;
  const asOfLbl = (live && live.asOf && asOfKey) ? fmtAsOf(live.asOf[asOfKey], ind.id === "unemp") : null;

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <SLabel>{ind.name}</SLabel>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 28, fontWeight: 900, letterSpacing: -1, color: ind.color }}>{current}</span>
            <Pill label={ind.label} color={statusColor} bg={statusBg} bdr={statusBdr} />
            {asOfLbl ? <span style={{ fontSize: 11, color: C.lbl, fontWeight: 700 }}>as of {asOfLbl}</span> : null}
          </div>
        </div>
        {(() => {
          const liveVal = ind.id === "yield"  && live ? live.yieldSpread
                        : ind.id === "unemp"  && live ? live.unemployment
                        : ind.id === "credit" && live ? live.creditSpread
                        : null;
          // The un-inversion window is date arithmetic over the SAME series the chart draws,
          // so the signal reads it rather than being told a level in isolation.
          const sigHist = (live && live[ind.dataKey]) || ind.data || [];
          const sigRaw = ind.signal(liveVal, sigHist);
          // I.5 — status colours come from the token set, never from a hardcoded hex.
          const sig = sigRaw.state && STATUS[sigRaw.state]
            ? { ...sigRaw, color: STATUS[sigRaw.state].color, bg: STATUS[sigRaw.state].bg, bdr: STATUS[sigRaw.state].bdr }
            : sigRaw;
          return (
            <div style={{ background: sig.bg, border: "1px solid " + sig.bdr, borderRadius: 8, padding: "8px 12px", maxWidth: 260 }}>
              <div style={{ color: sig.color, fontSize: 11, letterSpacing: 1.5, fontWeight: 700, textTransform: "uppercase", marginBottom: 3 }}>Signal: {sig.label}</div>
              <div style={{ color: sig.color, fontSize: 13, lineHeight: 1.6 }}>{sig.text}</div>
            </div>
          );
        })()}
      </div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 280px", minWidth: 240 }}>
          <ResponsiveContainer width="100%" height={148}>
            <AreaChart data={(live && ind.dataKey && live[ind.dataKey] && live[ind.dataKey].length > 0) ? live[ind.dataKey] : ind.data} margin={{ top: 6, right: 6, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id={"g" + ind.id} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={ind.areaColor} stopOpacity={0.15} />
                  <stop offset="95%" stopColor={ind.areaColor} stopOpacity={0.01} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={C.bdr} vertical={false} />
              <XAxis dataKey="d" tick={{ fill: C.lbl, fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={26} />
              <YAxis domain={ind.yDomain} tick={{ fill: C.lbl, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={ind.yFmt} width={52} />
              <Tooltip content={<ChartTip fmt={ind.yFmt} />} />
              {ind.thresholds.map((th, i) => (
                <ReferenceLine key={i} y={th.val} stroke={th.color} strokeDasharray={th.dash} strokeWidth={1.5}
                  label={{ value: th.label, fill: th.color, fontSize: 8, position: "right" }} />
              ))}
              <Area type="monotone" dataKey="v" stroke={ind.areaColor} strokeWidth={2.5} fill={"url(#g" + ind.id + ")"} dot={false} activeDot={{ r: 4, fill: ind.areaColor }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div style={{ flex: "1 1 220px", display: "flex", flexDirection: "column", gap: 10 }}>
          <p style={{ color: C.mid, fontSize: 14, lineHeight: 1.75, margin: 0 }}>
                {typeof ind.detail === "function"
                  ? ind.detail(ind.id === "yield"  && live ? live.yieldSpread
                              : ind.id === "unemp"  && live ? live.unemployment
                              : ind.id === "credit" && live ? live.creditSpread
                              : (ind.id === "yield" ? 0.38 : ind.id === "unemp" ? 4.4 : 2.75),
                              (live && live[ind.dataKey]) || ind.data || [])
                  : ind.detail}
              </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {ind.thresholds.map((th, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ width: 14, height: 2, background: th.color, borderRadius: 1, flexShrink: 0 }} />
                <span style={{ color: C.mid, fontSize: 13 }}>{th.label}: <b style={{ color: th.color }}>{ind.yFmt(th.val)}</b></span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── ASSET DETAIL ─────────────────────────────────────────────────────────────
function AssetDetail({ asset, prices, onFetchPrices, pricesLoading, pricesUpdated, phase }) {
  const radarData = [
    { axis: "Crisis",     val: asset.crisisScore },
    { axis: "Inflation",  val: asset.inflationScore },
    { axis: "Deflation",  val: asset.deflationScore },
    { axis: "Liquidity",  val: asset.liquidityScore },
    { axis: "Stagflation",val: asset.stagScore },
  ];
  const fmtTime = d => d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const tickers = asset.tickers.map(t => t.t);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card style={{ borderTop: "4px solid " + asset.color }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 26 }}>{asset.icon}</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 19, fontWeight: 900, color: asset.color }}>{asset.name}</div>
            <div style={{ color: C.muted, fontSize: 14, marginTop: 2 }}>Volatility: {asset.volatility} · Stagflation rank: #{asset.stagRank}</div>
          </div>
        </div>
        <p style={{ color: C.mid, fontSize: 15, lineHeight: 1.75, margin: "0 0 10px" }}>{asset.verdict}</p>
        {(() => {
          const pn = PHASE_NOTES[asset.id] && PHASE_NOTES[asset.id][phase];
          if (!pn) return null;
          // Colour from the first character of the note: ✅ green, ❌ red, else amber.
          const ch = pn.charAt(0);
          const col = ch === "✅" ? C.green : ch === "❌" ? C.red : C.amber;
          const bg  = ch === "✅" ? C.gBg   : ch === "❌" ? C.rBg : C.aBg;
          const bd  = ch === "✅" ? C.gBdr  : ch === "❌" ? C.rBdr : C.aBdr;
          return (
            <div style={{ background: bg, border: "1.5px solid " + bd, borderRadius: 8, padding: "10px 13px", marginBottom: 10, color: col, fontSize: 14, lineHeight: 1.65, fontWeight: 600 }}>
              {pn}
            </div>
          );
        })()}
        <div style={{ background: asset.bg, border: "1px solid " + asset.bdr, borderRadius: 8, padding: "10px 13px" }}>
          <span style={{ color: asset.color, fontWeight: 700, fontSize: 13 }}>📊 Stagflation: </span>
          <span style={{ color: asset.color, fontSize: 14 }}>{asset.stagNote}</span>
        </div>
        {asset.uaeBenefit && (
          <div style={{ background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, padding: "10px 13px", marginTop: 10 }}>
            <span style={{ color: C.blue, fontWeight: 700, fontSize: 13 }}>🇦🇪 UAE: </span>
            <span style={{ color: C.mid, fontSize: 14 }}>{asset.uaeBenefit}</span>
          </div>
        )}
        {asset.regionalNote && (
          <div style={{ background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, padding: "10px 13px", marginTop: 10 }}>
            <span style={{ color: C.blue, fontWeight: 700, fontSize: 13 }}>🌍 Regional: </span>
            <span style={{ color: C.mid, fontSize: 14 }}>{asset.regionalNote}</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
          <div style={{ flex: "0 0 175px" }}>
            <ResponsiveContainer width="100%" height={185}>
              <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="62%">
                <PolarGrid stroke={C.bdr} />
                <PolarAngleAxis dataKey="axis" tick={{ fill: C.mid, fontSize: 12, fontWeight: 600 }} />
                <Radar dataKey="val" stroke={asset.color} fill={asset.color} fillOpacity={0.12} strokeWidth={2.5} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, justifyContent: "center" }}>
            {radarData.map(s => (
              <div key={s.axis}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                  <span style={{ color: C.mid, fontSize: 13 }}>{s.axis}</span>
                  <span style={{ color: asset.color, fontSize: 13, fontWeight: 700 }}>{s.val}/100</span>
                </div>
                <div style={{ height: 6, background: C.bg, borderRadius: 3, border: "1px solid " + C.bdr, overflow: "hidden" }}>
                  <div style={{ width: s.val + "%", height: "100%", background: "linear-gradient(90deg," + asset.color + "66," + asset.color + ")", borderRadius: 3 }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
          <SLabel>Tickers + Live Prices</SLabel>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {pricesUpdated && <span style={{ color: C.lbl, fontSize: 12 }}>Updated {fmtTime(pricesUpdated)}</span>}
            <Btn onClick={() => onFetchPrices(tickers)} disabled={pricesLoading} color="#fff" bgColor={C.green} label={pricesLoading ? "Loading…" : "🔄 Prices"} />
          </div>
        </div>
        {asset.tickers.map((tk, i) => (
          <div key={tk.t} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: i < asset.tickers.length - 1 ? "1px solid " + C.bdr : "none", alignItems: "flex-start" }}>
            <div style={{ flexShrink: 0, width: 70 }}>
              <span title={tk.t} style={{ background: asset.bg, color: asset.color, border: "1.5px solid " + asset.bdr, borderRadius: 6, padding: "3px 5px", fontSize: tk.t.length > 8 ? 9 : tk.t.length > 5 ? 11 : 13, fontWeight: 800, display: "block", textAlign: "center", whiteSpace: "nowrap", maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis" }}>{tk.t}</span>
              <span style={{ color: C.lbl, fontSize: 11, display: "block", textAlign: "center", marginTop: 2 }}>{tk.type}</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                <span style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>
                  <RegionBadge ticker={tk.t} />
                  {tk.name}
                  {tk.link && !String(tk.t).endsWith(".AE") && <a href={tk.link} target="_blank" rel="noopener noreferrer" title="Exchange" style={{ marginLeft: 5, fontSize: 12, textDecoration: "none" }}>🔗</a>}
                </span>
                <PriceBadge ticker={tk.t} prices={prices} />
              </div>
              <div style={{ color: C.muted, fontSize: 14, marginTop: 3, lineHeight: 1.6 }}>{tk.note}</div>
              {(TICKER_TRIGGERS[tk.t] || BUCKET_TRIGGERS[asset.id]) && (
                <div style={{ color: C.lbl, fontSize: 12, marginTop: 4, lineHeight: 1.5 }}>
                  <b style={{ color: asset.color }}>Trigger:</b> {TICKER_TRIGGERS[tk.t] || BUCKET_TRIGGERS[asset.id]}
                </div>
              )}
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─── FUND DETAIL ──────────────────────────────────────────────────────────────
function FundDetail({ fund, prices, onFetchPrices, pricesLoading, pricesUpdated }) {
  const fmtTime = d => d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const pieData = fund.sectors.map(s => ({ name: s.name, value: s.pct }));
  const tickers = fund.holdings.filter(h => h.name !== "Other").map(h => h.name);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card style={{ borderTop: "4px solid " + fund.color }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 900, color: fund.color }}>{fund.name}</div>
            <div style={{ color: C.muted, fontSize: 13, marginTop: 2 }}>{fund.manager} · {fund.style} · {fund.aum}</div>
            {fund.lastUpdated && <div style={{ color: C.lbl, fontSize: 12, marginTop: 3 }}>{fund.lastUpdated}</div>}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <Pill label={fund.signal} color={fund.signalColor} />
            {(() => {
              const cov = FUND_COVERAGE[fund.id]; if (!cov) return null;
              const st = COVERAGE_BAND[cov.band] || COVERAGE_BAND.Partial;
              return <span title={cov.note} style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.2, color: st.col, background: st.bg, border: "1.5px solid " + st.bdr, borderRadius: 6, padding: "2px 8px", cursor: "help" }}>13F coverage: {cov.band}</span>;
            })()}
          </div>
        </div>
        <p style={{ color: C.mid, fontSize: 15, lineHeight: 1.75, margin: 0 }}>{fund.thesis}</p>
        {FUND_COVERAGE[fund.id] && (
          <div style={{ marginTop: 8, fontSize: 12, color: C.muted, lineHeight: 1.55, borderTop: "1px solid " + C.bdr, paddingTop: 8 }}>
            <b style={{ color: C.mid }}>What the 13F can't see: </b>{FUND_COVERAGE[fund.id].note}
          </div>
        )}
        {FUND_HEDGES[fund.id] && (
          <div style={{ marginTop: 6, fontSize: 12, color: FUND_HEDGES[fund.id].flag ? C.amber : C.muted, lineHeight: 1.55 }}>
            <b style={{ color: FUND_HEDGES[fund.id].flag ? C.amber : C.mid }}>{FUND_HEDGES[fund.id].flag ? "🛡️ Hedges: " : "Hedges: "}</b>{FUND_HEDGES[fund.id].text}
          </div>
        )}
      </Card>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 185px" }}>
          <SLabel>Sector Allocation</SLabel>
          <ResponsiveContainer width="100%" height={175}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={38} outerRadius={64} dataKey="value" stroke="#fff" strokeWidth={2}>
                {pieData.map((_, i) => <Cell key={i} fill={SC[i % SC.length]} />)}
              </Pie>
              <Tooltip content={function({ active, payload }) {
                if (!active || !payload || !payload.length) return null;
                return <div style={{ background: "#fff", border: "1px solid " + C.bdr, borderRadius: 8, padding: "8px 12px" }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{payload[0].name}</div>
                  <div style={{ color: C.muted, fontSize: 13 }}>{payload[0].value}%</div>
                </div>;
              }} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px" }}>
            {pieData.map((d, i) => (
              <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.muted }}>
                <div style={{ width: 7, height: 7, borderRadius: 2, background: SC[i % SC.length], flexShrink: 0 }} />
                {d.name.split("(")[0].trim()} {d.value}%
              </div>
            ))}
          </div>
        </Card>
        <Card style={{ flex: "1 1 185px" }}>
          <SLabel>Style Profile</SLabel>
          <ResponsiveContainer width="100%" height={200}>
            <RadarChart data={fund.radar} cx="50%" cy="50%" outerRadius="62%">
              <PolarGrid stroke={C.bdr} />
              <PolarAngleAxis dataKey="axis" tick={{ fill: C.mid, fontSize: 12, fontWeight: 600 }} />
              <Radar dataKey="score" stroke={fund.color} fill={fund.color} fillOpacity={0.12} strokeWidth={2.5} />
            </RadarChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <SLabel>Top Holdings — {fund.id === "fairfax" ? "Annual Report 2025" : "Q2 2026 · as of Jun 30"}</SLabel>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {/* #1 — value-weighted move of the disclosed book since the filing date. */}
            {(() => {
              const b = bookSinceFiling(fund, prices); if (!b) return null;
              const up = b.pct >= 0;
              return <span title={`Value-weighted price move of the priced portion of the disclosed book since ${MATRIX_13F.positionsAsOf}. Covers ${b.coveredPct}% of the book by weight; the rest has no live price.`}
                style={{ fontSize: 11.5, fontWeight: 800, color: up ? C.green : C.red, background: up ? C.gBg : C.rBg, border: "1.5px solid " + (up ? C.gBdr : C.rBdr), borderRadius: 6, padding: "2px 8px" }}>
                book {up ? "+" : ""}{b.pct}% since filing <span style={{ color: C.muted, fontWeight: 600 }}>· {b.coveredPct}% priced</span>
              </span>;
            })()}
            {pricesUpdated && <span style={{ color: C.lbl, fontSize: 12 }}>{fmtTime(pricesUpdated)}</span>}
            <Btn onClick={() => onFetchPrices(tickers)} disabled={pricesLoading} color="#fff" bgColor={C.green} label={pricesLoading ? "Loading…" : "🔄 Prices"} />
          </div>
        </div>
        <ResponsiveContainer width="100%" height={Math.max(200, fund.holdings.length * 28)}>
          <BarChart data={fund.holdings} layout="vertical" margin={{ left: 4, right: 44, top: 0, bottom: 0 }}>
            <XAxis type="number" domain={[0, dataMax => Math.ceil(dataMax * 1.08)]} tick={{ fill: C.lbl, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v + "%"} />
            <YAxis type="category" dataKey="name" interval={0} tick={{ fill: C.mid, fontSize: 11, fontWeight: 600 }} axisLine={false} tickLine={false} width={64} />
            <Tooltip formatter={v => [v + "%", "% of Portfolio"]} contentStyle={{ background: "#fff", border: "1px solid " + C.bdr, borderRadius: 8, fontSize: 13 }} />
            <Bar dataKey="pct" radius={[0, 5, 5, 0]}>
              {fund.holdings.map((h, i) => (
                <Cell key={i} fill={h.action === "bought" ? "#166534" : h.action === "added" ? "#22C55E" : h.action === "trim" ? "#D97706" : h.action === "exit" ? "#DC2626" : fund.color} opacity={0.85} />
              ))}
              <LabelList dataKey="pct" position="right" formatter={v => v + "%"} style={{ fill: C.mid, fontSize: 11, fontWeight: 700 }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <div>
          {fund.holdings.filter(h => h.name !== "Other").map((h, i, arr) => (
            <div key={h.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: i < arr.length - 1 ? "1px solid " + C.bdr : "none", flexWrap: "wrap", gap: 6 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                <span style={{ color: C.text, fontWeight: 800, fontSize: 15, minWidth: 52 }}>{h.name}</span>
                <div>
                  <div style={{ color: C.mid, fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>{COMPANY_NAMES[h.name] || h.name}</div>
                  <div style={{ color: C.lbl, fontSize: 11 }}>{h.sector}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ color: fund.color, fontWeight: 800, fontSize: 14 }}>{h.pct}%</span>
                <span style={{ color: C.muted, fontSize: 13 }}>${h.value}B</span>
                <ActionBadge action={h.action} />
                <PriceBadge ticker={h.name} prices={prices} />
                {(() => {
                  const s = sinceFiling(h, prices); if (!s) return null;
                  const up = s.pct >= 0;
                  return <span title={`Filing price ~$${s.refPrice} (value ÷ shares, as of ${MATRIX_13F.positionsAsOf}) vs live $${s.live}`}
                    style={{ fontSize: 11, fontWeight: 800, color: up ? C.green : C.red, background: up ? C.gBg : C.rBg, border: "1px solid " + (up ? C.gBdr : C.rBdr), borderRadius: 5, padding: "1px 5px" }}>
                    {up ? "+" : ""}{s.pct}% since filing
                  </span>;
                })()}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 160, background: C.gBg, border: "1.5px solid " + C.gBdr, borderRadius: 10, padding: "12px 14px" }}>
          <SLabel color={C.green}>Q1 Key Buys</SLabel>
          {fund.recentBuys.map((b, i) => (
            <div key={i} style={{ color: C.green, fontSize: 14, padding: "4px 0", borderBottom: i < fund.recentBuys.length - 1 ? "1px solid " + C.gBdr : "none" }}>↑ {b}</div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 160, background: "#FFF3E0", border: "1.5px solid #FFCC80", borderRadius: 10, padding: "12px 14px" }}>
          <SLabel color={C.amber}>Q1 Key Sells</SLabel>
          {fund.recentSells.map((s, i) => (
            <div key={i} style={{ color: C.amber, fontSize: 14, padding: "4px 0", borderBottom: i < fund.recentSells.length - 1 ? "1px solid #FFE0B2" : "none" }}>↓ {s}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── GLOBAL PLAYBOOK TAB ──────────────────────────────────────────────────────
// Live macro/semi spine + deterministic regime per region, from /api/playbook (no
// model). Asia additionally renders the Korea-local stress gate.
const PB_REGIONS = [
  { id: "asia", label: "🌏 Asia" },
  { id: "eu",   label: "🇪🇺 Europe" },
  { id: "us",   label: "🇺🇸 US" },
];
const pbFmtPct     = p => (p == null ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`);
const pbFmtNum     = n => (n == null ? "—" : Number(n).toLocaleString("en-US"));
const pbPctColor   = p => (p == null ? C.muted : p > 0.15 ? C.green : p < -0.15 ? C.red : C.muted);
// Gate colours. Level names come from lib/gates.js (2-D gates), so accept both the
// upper-case band labels and the lower-cased effective state.
const pbCreditColor = s => ({ calm: C.green, watch: C.amber, defending: C.amber, stress: C.red }[String(s).toLowerCase()] || C.muted);
const pbClusterColor = c => ({ exhausting: C.green, active: C.red, mixed: C.amber, unknown: C.muted }[c] || C.muted);
const pbBandColor  = b => ({ normal: C.green, elevated: C.amber, high: C.red, extreme: C.red }[String(b).toLowerCase()] || C.muted);

// Market-state-aware freshness chip for names/indices — mirrors the Pre-Read: shows
// "~Nm delayed" / "prior close" / "holiday" / "no print" instead of a blanket "stale"
// badge that fires on live-but-delayed feeds. Returns null when live (no chip). The
// backend (playbook spine) computes `freshness` via lib/sessions.js.
// Error boundary — a render error in ONE tab must not tear down the whole dashboard.
// Without this, a single bad property access blanks the entire page (header + nav included),
// which is exactly what a shape-mismatched cached payload once did. Offers a cache-clear
// escape hatch, since a stale localStorage payload is the most likely cause.
class TabErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error("Render error in " + (this.props.name || "tab") + ":", err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <Card style={{ background: C.rBg, border: "1.5px solid " + C.rBdr }}>
        <div style={{ color: C.red, fontWeight: 800, fontSize: 14, marginBottom: 6 }}>
          ⚠ {this.props.name || "This view"} failed to render
        </div>
        <div style={{ color: C.mid, fontSize: 12.5, marginBottom: 10, fontFamily: "ui-monospace, monospace" }}>
          {String(this.state.err?.message || this.state.err)}
        </div>
        <div style={{ color: C.muted, fontSize: 12, marginBottom: 10 }}>
          The rest of the dashboard still works. This is usually a cached payload from an older
          data shape — clearing the cache and refetching normally fixes it.
        </div>
        <Btn onClick={() => {
          try { Object.keys(localStorage).filter(k => k.startsWith("cache_")).forEach(k => localStorage.removeItem(k)); } catch (_) {}
          window.location.reload();
        }} color={C.red} bgColor={C.rBg} label="🧹 Clear cache & reload" />
      </Card>
    );
  }
}

function pbFresh(fr) {
  const txt = freshnessText(fr);           // shared vocab: "" (live) / prior close / stale · Nh ago / ⚠ date
  if (!txt) return null;
  const color = (fr.state === "no-print" || fr.state === "future") ? C.red
              : fr.state === "stale" ? C.amber : C.muted;
  return { txt, color };
}

// Prior-close coherence guard, recomputed AT RENDER from price/prevClose. Deliberately does
// not just trust the payload's pctSuspect flag: a payload cached from an older build has no
// such flag, and that is exactly how a contradiction (value below prior close showing a
// POSITIVE %) reached the screen. Returns { ok, pct, note } — on failure the % is suppressed
// and the caller shows the note instead of a number that cannot be true.
function pbPctGuard(row) {
  const { price, prevClose, changePct } = row || {};
  if (row?.pctSuspect) return { ok: false, pct: null, note: "⚠ prior-close mismatch" };
  if (price == null || prevClose == null || changePct == null) return { ok: true, pct: changePct, note: null };
  const diff = price - prevClose;
  if (Math.abs(diff) > 1e-9 && Math.abs(changePct) > 0.005 && Math.sign(diff) !== Math.sign(changePct)) {
    return { ok: false, pct: null, note: "⚠ prior-close mismatch" };
  }
  return { ok: true, pct: changePct, note: null };
}

// Explicit session-state badge for a name/index. Combines the market-state freshness with
// the exchange PHASE so a print is never shown as clean-live when its market is shut or its
// feed has gone stale mid-session. `bad:true` → the value itself renders struck/amber (the
// "never green while stale/prior-close during an OPEN market" rule). Always returns a badge.
function pbSession(fr, phase) {
  const st = fr?.state;
  if (st === "no-print")   return { label: "NO PRINT",         color: C.red,   bad: true };
  if (st === "future")     return { label: "⚠ DATE",           color: C.red,   bad: true };
  if (st === "stale")      return { label: "STALE · MKT OPEN", color: C.amber, bad: true };
  if (st === "live")       return { label: "LIVE",             color: C.green, bad: false };
  if (st === "lunch")      return { label: "LUNCH HALT",       color: C.amber, bad: false };
  if (st === "holiday")    return { label: "HOLIDAY",          color: C.muted, bad: false };
  // prior-close → disambiguate pre-open vs post-close using the exchange phase
  if (phase === "pre")     return { label: "PRE-OPEN",         color: C.muted, bad: false };
  if (phase === "post")    return { label: "POST-CLOSE",       color: C.muted, bad: false };
  return { label: "PRIOR CLOSE", color: C.muted, bad: false };
}

// Render the delta that justifies a direction word, e.g. "+0.02 1d". Never emitted without
// a trend object — a word with no shown delta is exactly what Stage 1A forbids.
function fmtDelta(t, digits = 2) {
  if (!t) return "";
  return `${t.delta >= 0 ? "+" : "−"}${Math.abs(t.delta).toFixed(digits)} ${t.basis}`;
}

// Region-block session pill (phase of the region's primary index) + live local clock.
const PB_SESSION_LABEL = { live: "OPEN", lunch: "LUNCH", pre: "PRE-OPEN", post: "CLOSED", holiday: "HOLIDAY", weekend: "CLOSED", closed: "CLOSED" };
function pbSessionColor(phase) { return phase === "live" ? C.green : (phase === "lunch" || phase === "pre") ? C.amber : C.muted; }
// Region-block pill: session state (of the region's primary index) + a LIVE local clock
// (computed client-side from the region tz, so it ticks between refreshes).
function RegionSessionBadge({ session, tz }) {
  const label = PB_SESSION_LABEL[session] || "CLOSED";
  const color = pbSessionColor(session);
  let clock = "";
  try { clock = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()); } catch { /* bad tz */ }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color, background: color + "18", border: "1px solid " + color + "55", borderRadius: 5, padding: "2px 7px" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
      {label}{clock ? " · " + clock + " local" : ""}
    </span>
  );
}
// ── Unified metric card ──────────────────────────────────────────────────────
// ONE shell for every metric group (Macro, Cross-Asset, Indices, Names, Korea gate) so
// styling cannot drift between sections and nothing renders as a floating label-value pair.
// Purely presentational: callers pass already-formatted values, so no formatting logic
// lives here and no displayed number can change by routing through it.
function MetricGrid({ children, min = 200 }) {
  return <div className="mwd-metric-grid" style={{ "--mwd-min": min + "px" }}>{children}</div>;
}
function MetricCard({ label, labelRight, value, valueColor, strike, sub, badge, accent, title, children }) {
  return (
    <div className="mwd-metric-card" style={accent ? { borderColor: accent } : undefined} title={title}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
        <span style={{ fontSize: 12, color: C.muted, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {labelRight ? <span style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0 }}>{labelRight}</span> : null}
      </div>
      {badge ? <div style={{ marginTop: 3 }}>{badge}</div> : null}
      {value !== undefined ? (
        <div className="mwd-mc-value" style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
          <span style={{ fontSize: 18, fontWeight: 900, color: valueColor || C.text, textDecoration: strike ? "line-through" : "none" }}>{value}</span>
          {sub}
        </div>
      ) : null}
      {children}
    </div>
  );
}
// Small reusable session/state chip used inside metric cards.
function StateChip({ label, color, filled }) {
  return (
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color,
      background: filled ? C.aBg : "transparent", border: "1px solid " + color + "55", borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

// One cross-asset row: value + 1D delta + direction. A row with no prior close shows NO
// direction and says why (Stage 1A) rather than implying a trend from a single print.
function CrossRow({ r }) {
  const dcol = r.dir === "rising" ? C.green : r.dir === "falling" ? C.red : C.muted;
  const arrow = r.dir === "rising" ? "▲" : r.dir === "falling" ? "▼" : r.dir === "flat" ? "■" : "";
  // Q4 / P6.1 — age computed HERE, at render, not captured at fetch. Without this a fast
  // series shows a stale number with nothing to say so: VIX printed 15.86 while it traded
  // 16.24 intraday, and the card gave no indication the two could differ.
  const age = (() => {
    if (!r.ts) return null;
    const min = Math.floor((Date.now() - r.ts * 1000) / 60000);
    if (min < 0) return null;                       // clock skew — say nothing rather than lie
    if (min <= 20) return null;                     // live enough for a 1D card
    return { text: humanizeAge(min), stale: min > 90 };   // humanizeAge already yields "9h ago" — no second " ago"
  })();
  return (
    <MetricCard
      label={r.name}
      title={r.note || (r.sym + " · 1D vs prior close" + (age ? ` · last tick ${age.text}` : ""))}
      value={r.price != null ? withCommas(+(+r.price).toFixed(2)) : "—"}
      labelRight={age ? <StateChip label={age.text} color={age.stale ? C.amber : C.lbl} /> : null}
    >
      {r.dir ? (
        <div style={{ fontSize: 11, fontWeight: 700, color: dcol, marginTop: 2 }}>
          {/* Format defensively: never render a raw provider float, whatever the source did */}
          {arrow} {r.changePct != null
            ? `${r.changePct >= 0 ? "+" : ""}${(+r.changePct).toFixed(2)}%`
            : `${r.delta >= 0 ? "+" : "−"}${Math.abs(+r.delta).toFixed(r.unit === "bps" ? 0 : 2)}${r.unit || ""}`}
          <span style={{ color: C.lbl }}> {r.basis || "1D"}</span>
        </div>
      ) : (
        <div style={{ fontSize: 10, color: C.amber, fontWeight: 700, marginTop: 2 }}>no direction</div>
      )}
      {r.benchmark && <div style={{ marginTop: 1 }}><BenchChip b={r.benchmark} /></div>}
    </MetricCard>
  );
}

// "Gauges leaning" — how many independent tripwires point the same way. Unavailable gauges
// are shown as such, never counted as calm (which would understate the lean).
function GaugesLeaning({ leaning, prominent }) {
  if (!leaning || !leaning.items?.length) return null;
  const hot = leaning.usable > 0 && leaning.tripped / leaning.usable >= 0.6;
  const col = leaning.allLeaning ? C.red : hot ? C.amber : C.muted;
  // `prominent` = the top-of-page placement: bigger count, own card, no top margin.
  const wrap = prominent
    ? { padding: "14px 18px", background: leaning.allLeaning ? C.rBg : C.surf,
        border: "1.5px solid " + (leaning.allLeaning ? C.rBdr : C.bdr), borderRadius: 14,
        boxShadow: "0 1px 5px rgba(0,0,0,.05)" }   // I.2 — a count is not a status badge: no accent bar
    : { marginTop: 12, padding: "10px 12px", background: leaning.allLeaning ? C.rBg : C.bg,
        border: "1.5px solid " + (leaning.allLeaning ? C.rBdr : C.bdrMd), borderRadius: 8 };
  return (
    <div style={wrap}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: prominent ? 12 : 11, color: C.muted, fontWeight: 800, textTransform: "uppercase", letterSpacing: prominent ? 2 : 0.5 }}>Gauges leaning</span>
        <span style={{ fontSize: prominent ? 28 : 14, fontWeight: 900, color: col, lineHeight: 1.1 }}>{leaning.tripped}/{leaning.usable}</span>
        {prominent && <span style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>tripwires leaning de-risking</span>}
        {leaning.allLeaning && <span style={{ fontSize: prominent ? 12 : 10, fontWeight: 800, color: C.red }}>ALL TURNED TOGETHER</span>}
        {prominent && <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase" }}>today</span>}
      </div>
      {/* B3 — the count is directional: which SCENARIO the fired gauges point at, not an
          undifferentiated N/5. "2 at Korea mechanical, 1 at Hawkish" is what's actionable. */}
      {leaning.byScenario?.length > 0 && (
        <div style={{ marginTop: 5, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {leaning.byScenario.map(s => (
            <span key={s.scenario} style={{ fontSize: prominent ? 11.5 : 10.5, fontWeight: 800, color: C.red,
              border: "1px solid " + C.rBdr, background: C.rBg, borderRadius: 5, padding: "1px 7px" }}>
              {s.count} → {s.scenario}
            </span>
          ))}
        </div>
      )}
      {/* Q2 — a count is not actionable. Name the gauges that actually fired and show each
          one's reading, inline. This was previously only in a `title` tooltip, which is
          invisible in a screenshot, on touch, and to anyone reading quickly. */}
      {leaning.items.some(i => i.tripped) && (
        <div style={{ marginTop: 6, fontSize: prominent ? 12 : 11, color: C.red, fontWeight: 600, lineHeight: 1.5 }}>
          Fired: {leaning.items.filter(i => i.tripped).map(i => `${i.name} (${i.detail})`).join(" · ")}
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
        {leaning.items.map(i => {
          const c = i.tripped === null ? C.lbl : i.tripped ? C.red : C.green;
          return (
            <span key={i.name} title={i.detail}
              style={{ fontSize: 10.5, fontWeight: 700, color: c, border: "1px solid " + c + "55", background: c + "12", borderRadius: 5, padding: "2px 6px" }}>
              {i.tripped === null ? "· " : i.tripped ? "▲ " : "▼ "}{i.name}
              {i.tripped === null ? <span style={{ color: C.lbl }}> n/a</span> : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// CSOP 7709 deleveraging tripwire — a SINGLE, position-specific signal, kept out of the
// gauges-leaning cluster on purpose (see lib/gates.js). China-tech units outstanding: a >3%
// one-day drop or two consecutive down days = holders exiting the leveraged trade, which leads
// the name. Withheld (not shown quiet) when the manual unit print is stale.
function Csop7709Tripwire({ t }) {
  if (!t) return null;
  const fired = t.tripped === true;
  const col = fired ? C.red : t.available ? C.green : C.lbl;
  return (
    <div style={{ marginTop: 12, padding: "10px 12px", background: fired ? C.rBg : C.bg,
      border: "1.5px solid " + (fired ? C.rBdr : C.bdrMd), borderRadius: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: C.muted, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5 }}>CSOP 7709 tripwire</span>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>China-tech units outstanding · deleveraging tell</span>
        <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase" }}>today</span>
        <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 900, color: col }}>
          {fired ? "▲ FIRED" : t.available ? "▼ quiet" : "· withheld"}
        </span>
      </div>
      <div style={{ marginTop: 5, fontSize: 12, color: fired ? C.red : C.mid, fontWeight: fired ? 700 : 600, lineHeight: 1.5 }}>
        {t.available
          ? <>{t.detail}{fired ? <> — <b>{t.reason}</b></> : " — no deleveraging trigger"}{t.asOf ? <span style={{ color: C.lbl, fontWeight: 500 }}> · {t.asOf}</span> : null}</>
          : <span style={{ color: C.amber, fontWeight: 700 }}>{t.note}</span>}
      </div>
    </div>
  );
}

// A1 — headline POSTURE card. The one card that says what to DO, resolving several
// simultaneously-confirmed scenarios into a single risk stance + a short action list.
function PostureCard({ p }) {
  if (!p) return null;
  const col = p.tone === "red" ? C.red : p.tone === "green" ? C.green : p.tone === "amber" ? C.amber : C.muted;
  const bg  = p.tone === "red" ? C.rBg : p.tone === "green" ? C.gBg : p.tone === "amber" ? C.aBg : C.surf;
  const bdr = p.tone === "red" ? C.rBdr : p.tone === "green" ? C.gBdr : p.tone === "amber" ? C.aBdr : C.bdr;
  const Row = ({ label, children, color }) => (
    <div style={{ display: "flex", gap: 10, marginTop: 5, alignItems: "baseline" }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 66, flexShrink: 0 }}>{label}</span>
      <div style={{ fontSize: 12, color: color || C.mid, fontWeight: 600, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
  return (
    <Card style={{ background: bg, border: "1.5px solid " + bdr, borderTop: "5px solid " + col }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 2 }} title="The tape's what-to-do right now. Portfolio allocation lives on the Posture tab.">Tape stance</span>
        <span style={{ fontSize: 22, fontWeight: 900, color: col, lineHeight: 1.05 }}>{p.posture}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase" }}>weeks</span>
        {p.tripwires && <span style={{ fontSize: 13, fontWeight: 800, color: C.muted }}>{p.tripwires} tripwires</span>}
      </div>
      {p.working?.length > 0 && <Row label="Working" color={C.green}>{p.working.join(" · ")}</Row>}
      {p.not?.length > 0 && <Row label="Not" color={C.red}>{p.not.join(" · ")}</Row>}
      {p.do?.length > 0 && (
        <Row label="Do">
          {p.do.map((d, i) => <div key={i} style={{ marginTop: i ? 2 : 0 }}>→ {d}</div>)}
        </Row>
      )}
      {p.watch && <Row label="Watch" color={C.amber}>{p.watch}</Row>}
      {p.next?.length > 0 && (
        <Row label="Next">{p.next.map(n => `${n.label} ${n.date.slice(5)} (${n.daysTo}d)`).join(" · ")}</Row>
      )}
    </Card>
  );
}

// Part C — scenario board. Answers "which scenario am I in" at the top of the page, so the user
// doesn't reassemble it from five category-bucketed sections. Each row: name, X/N met, and its
// conditions with threshold + live value. Sorted server-side by consequence weight, then proximity.
function ScenarioBoard({ scenarios }) {
  // A6 — mark scenarios whose confirmed-count moved since the last DIFFERENT render (stored in
  // localStorage). KM going 2/3 → 3/3 overnight is the most actionable fact on the page.
  const [changed, setChanged] = useState({});
  useEffect(() => {
    if (!scenarios?.length) return;
    const KEY = "dvcap_scenario_counts";
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* ignore */ }
    const cur = {}, ch = {};
    let anyDiff = false;
    for (const s of scenarios) {
      const cnt = s.total > 0 ? `${s.met}/${s.total}` : "n/a";
      cur[s.id] = cnt;
      if (stored[s.id] && stored[s.id] !== cnt) { ch[s.id] = stored[s.id]; anyDiff = true; }
    }
    if (anyDiff || Object.keys(stored).length === 0) {
      if (anyDiff) setChanged(ch);
      try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* ignore */ }
    }
  }, [scenarios]);
  if (!scenarios?.length) return null;
  const TONE = { red: C.red, amber: C.amber, green: C.green, muted: C.muted };
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <SLabel>🧭 Scenario board</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>which scenario am I in · sorted by consequence weight</span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase" }}>weeks</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {scenarios.map(s => {
          // Color by the scenario's OWN tone, not a blanket red: "A · Plan works" confirming is a
          // GOOD state (green), only "D · Disorderly" confirming is red. Confirmed just fills the
          // tone-appropriate background + shows ✓; a near-miss (one short) reads amber.
          const toneCol = TONE[s.tone] || C.muted;
          const TBG  = { red: C.rBg, amber: C.aBg, green: C.gBg };
          const TBDR = { red: C.rBdr, amber: C.aBdr, green: C.gBdr };
          const bg  = s.confirmed ? (TBG[s.tone] || C.bg) : C.bg;
          const bdr = s.confirmed ? (TBDR[s.tone] || C.bdrMd) : C.bdrMd;
          const countCol = s.confirmed ? toneCol : (s.total > 0 && s.met === s.total - 1 ? C.amber : C.muted);
          return (
            <div key={s.id} style={{ padding: "8px 10px", borderRadius: 8, background: bg,
              border: "1px solid " + bdr }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, fontWeight: 900, color: toneCol }}>{s.id} · {s.name}</span>
                {changed[s.id] && (
                  <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, color: "#fff", background: toneCol, borderRadius: 4, padding: "1px 5px" }}
                    title={`moved ${changed[s.id]} → ${s.met}/${s.total} since the last change`}>
                    ▲ CHANGED {changed[s.id]} → {s.met}/{s.total}
                  </span>
                )}
                <span style={{ fontSize: 10.5, color: C.muted, fontWeight: 600, fontStyle: "italic" }}>{s.gloss}</span>
                <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 900, color: countCol }}>
                  {s.total > 0 ? `${s.met}/${s.total}` : "n/a"} {s.confirmed ? "✓" : "✗"}
                  {s.unavailable > 0 && <span style={{ color: C.lbl, fontWeight: 600, fontSize: 10 }}> · {s.unavailable} n/a</span>}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 14px", marginTop: 4 }}>
                {s.conditions.map((c, i) => {
                  const cc = c.met === null ? C.lbl : c.met ? toneCol : C.muted;
                  return (
                    <span key={i} style={{ fontSize: 11, fontWeight: 600, color: cc, fontVariantNumeric: "tabular-nums" }}>
                      {c.met === null ? "·" : c.met ? "✓" : "✗"} {c.label}
                      <span style={{ color: C.lbl, fontWeight: 700 }}> {c.display}</span>
                    </span>
                  );
                })}
              </div>
              {/* A2 — the consequence: what to DO, not just what's true. Emphasised when confirmed. */}
              {s.consequence && (
                <div style={{ marginTop: 4, fontSize: 11, fontWeight: s.confirmed ? 800 : 600, color: s.confirmed ? toneCol : C.muted, lineHeight: 1.45 }}>
                  → {s.consequence}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// D2 — event positioning. Before a catalyst, the question is what is already PAID FOR. Shows the
// run-up into each upcoming event and how stretched above the 50d line — the "priced for
// perfection" read (AMD: record double-beat, −9%).
function EventPositioning({ e }) {
  if (!e || !e.available) return null;
  const pct = (v, s = "%") => v == null ? "—" : `${v >= 0 ? "+" : ""}${v}${s}`;
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>📅 Event positioning</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>what's already priced in · run-up into the catalyst</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        {e.events.map(ev => {
          const col = ev.tone === "amber" ? C.amber : ev.tone === "green" ? C.green : C.muted;
          return (
            <div key={ev.sym + ev.date} style={{ padding: "7px 10px", borderRadius: 8, background: C.bg, border: "1px solid " + C.bdrMd }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12.5, fontWeight: 900, color: C.text }}>{ev.name}</span>
                {ev.status === "PARTIAL" && (
                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.4, color: C.amber, border: "1px solid " + C.aBdr, background: C.aBg, borderRadius: 4, padding: "1px 5px" }}>PARTIAL</span>
                )}
                <span style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>{ev.label} · {ev.date} · <b style={{ color: col }}>{ev.daysTo}d out</b></span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, color: C.mid }}>
                  5d {pct(ev.chg5d)} · 20d {pct(ev.chg20d)} · vs50d {pct(ev.vs50dPct)}
                </span>
              </div>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: col, marginTop: 3, lineHeight: 1.45 }}>
                {ev.status === "PARTIAL" ? "No verdict — " : ""}{ev.reading}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: C.lbl, marginTop: 5 }}>IV percentile (the cleanest leg) needs an options feed — not shown; run-up + stretch are the proxies.</div>
    </Card>
  );
}

// C1 — VIX term-structure regime. The curve SHAPE (front vs back), not the spot level, governs
// options posture. Contango = calm slope; backwardation = stress; flat = transition. The
// event-pricing overlay separates a dated-catalyst front bid from a real regime change.
function VolRegime({ v }) {
  if (!v) return null;
  const TONE = { red: [C.red, C.rBg, C.rBdr], amber: [C.amber, C.aBg, C.aBdr], green: [C.green, C.gBg, C.gBdr] };
  if (!v.available) {
    return (
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <SLabel>🌀 Vol regime</SLabel>
          <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>VIX term structure · VIX9D → VIX → VIX3M</span>
        </div>
        <div style={{ marginTop: 4, fontSize: 12, color: C.amber, fontWeight: 700 }}>{v.note}</div>
      </Card>
    );
  }
  const [col, bg, bdr] = TONE[v.tone] || TONE.amber;
  const pt = (x, suffix = "") => x == null ? "—" : `${x >= 0 ? "+" : ""}${x}${suffix}`;
  return (
    <Card style={{ borderTop: "4px solid " + col }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>🌀 Vol regime</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>VIX term structure · governs options posture</span>
        <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase" }}>days</span>
        <span style={{ marginLeft: "auto", fontSize: 16, fontWeight: 900, color: col }}>{v.regime}</span>
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 800, color: C.mid, marginTop: 3 }}>{v.meaning}</div>
      {/* The three curve points, front → back, with each leg's 1d move. */}
      <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap" }}>
        {[["VIX9D", v.vix9d, v.frontChg], ["VIX", v.vix, null], ["VIX3M", v.vix3m, v.backChg]].map(([lbl, px, chg]) => (
          <div key={lbl} style={{ minWidth: 70 }}>
            <div style={{ fontSize: 10, color: C.muted, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4 }}>{lbl}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{px != null ? px.toFixed(2) : "—"}</div>
            {chg != null && <div style={{ fontSize: 10.5, fontWeight: 700, color: chg > 0 ? C.red : chg < 0 ? C.green : C.muted }}>{pt(chg, "% 1d")}</div>}
          </div>
        ))}
        <div style={{ minWidth: 90 }}>
          <div style={{ fontSize: 10, color: C.muted, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4 }}>front − back</div>
          <div style={{ fontSize: 15, fontWeight: 800, color: col }}>{pt(v.spreadPts)}pt</div>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: C.muted }}>{pt(v.spreadPct, "%")}</div>
        </div>
      </div>
      {/* Event-pricing overlay — front bid against a flat back is a dated catalyst, not stress. */}
      {v.eventPricing && (
        <div style={{ marginTop: 8, padding: "7px 10px", borderRadius: 6, background: bg, border: "1px solid " + bdr,
          fontSize: 11.5, lineHeight: 1.5, color: C.amber, fontWeight: 700 }}>
          ⚠ {v.note}
        </div>
      )}
    </Card>
  );
}

// C3 / P1.1 — cross-market handoff, FORWARD. The US just closed; Asia opens in ~3h and hasn't
// seen it. The card leads with what the US close implies for the Asia OPEN (gap-up / gap-down
// risk by convergence), and keeps the backward "did Asia predict the US" read as a validation line.
function CrossMarketHandoff({ h }) {
  if (!h || !h.available) return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>🔀 US → Asia handoff</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>what the US close implies for the Asia open</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: C.muted, fontWeight: 600 }}>{h?.note || "unavailable"}</div>
    </Card>
  );
  const TONE = { amber: C.amber, green: C.green, red: C.red, muted: C.muted };
  const fwd = h.forward, bwd = h.backward;
  const col = fwd?.available ? (TONE[fwd.tone] || C.muted) : C.muted;
  const chgCol = v => v == null ? C.muted : v > 0 ? C.green : v < 0 ? C.red : C.muted;
  return (
    <Card style={{ borderTop: "4px solid " + col }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>🔀 US → Asia handoff</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>what the US close implies for the Asia open{fwd?.nextOpenH ? ` · next open ~${fwd.nextOpenH}h` : ""}</span>
        {fwd?.available && <span style={{ marginLeft: "auto", fontSize: 16, fontWeight: 900, color: col }}>{fwd.verdict}</span>}
      </div>
      {fwd?.available ? (
        <>
          {/* Two aligned rows: what the US did, and where Asia last closed. */}
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 11.5 }}>
            <span style={{ fontWeight: 800, color: C.muted, minWidth: 118 }}>US session drivers</span>
            {h.drivers.map(d => (
              <span key={d.name} style={{ fontWeight: 700, color: C.mid }}>{d.name} <b style={{ color: chgCol(d.riskSign) }}>{d.detail}</b></span>
            ))}
          </div>
          <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 11.5 }}>
            <span style={{ fontWeight: 800, color: C.muted, minWidth: 118 }}>Asia's last close</span>
            {(h.asiaCloses || []).map(a => (
              <span key={a.name} style={{ fontWeight: 700, color: C.mid }}>{a.name} <b style={{ color: chgCol(a.chg) }}>{a.chg >= 0 ? "+" : ""}{a.chg}%</b></span>
            ))}
          </div>
          <div style={{ fontSize: 12, color: col === C.muted ? C.mid : col, fontWeight: 700, marginTop: 7, lineHeight: 1.5 }}>Implied: {fwd.note}</div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: C.muted, fontWeight: 600, marginTop: 4 }}>{fwd?.note}</div>
      )}
      {/* Backward read — model validation, subordinate. */}
      {bwd?.note && (
        <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 7, paddingTop: 6, borderTop: "1px solid " + C.bdr }}>
          <b style={{ color: C.muted }}>{bwd.verdict}</b> · {bwd.note}
        </div>
      )}
    </Card>
  );
}

// Part B — the bidirectional handoff CHAIN. Three legs stacked in trading order (Asia → Europe →
// US → Asia); each shows whether the "from" market LED / FOLLOWED / DIVERGED its upstream, the next
// open of the "to" market with a countdown, and highlights the leg live for the user's HKT clock.
function HandoffChain({ chain }) {
  if (!chain || !chain.available) return null;
  const STATE_STYLE = {
    LED:       { color: C.green, bg: C.gBg, bdr: C.gBdr },
    DIVERGED:  { color: C.amber, bg: C.aBg, bdr: C.aBdr },
    FOLLOWED:  { color: C.muted, bg: C.bg,  bdr: C.bdr  },
    QUIET:     { color: C.lbl,   bg: C.bg,  bdr: C.bdr  },
    "NO DATA": { color: C.lbl,   bg: C.bg,  bdr: C.bdr  },
  };
  // HKT clock → next-open countdowns + which leg is live. Asia 08:00 · Europe 15:00 · US 21:30 HKT.
  const hkNow = new Date().toLocaleString("en-US", { timeZone: "Asia/Hong_Kong", hour12: false, hour: "2-digit", minute: "2-digit" });
  const [hh, mm] = hkNow.split(":").map(Number);
  const nowH = (Number.isFinite(hh) ? hh : 0) + (Number.isFinite(mm) ? mm : 0) / 60;
  const OPENS = { EUROPE: 15, US: 21.5, ASIA: 8 };
  const toOpen = t => { let d = t - nowH; if (d <= 0) d += 24; return d; };
  const fmtCd = d => `${Math.floor(d)}h ${String(Math.round((d % 1) * 60)).padStart(2, "0")}m`;
  const activeIdx = (nowH >= 8 && nowH < 15) ? 0 : (nowH >= 15 && nowH < 21.5) ? 1 : 2;
  const pct = v => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const chgCol = v => v == null ? C.muted : v > 0 ? C.green : v < 0 ? C.red : C.muted;
  const active = chain.legs[activeIdx];
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>🔗 Handoff chain</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>Asia → Europe → US → Asia · LED = local info the next open hasn't priced</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
        {chain.legs.map((l, i) => {
          const st = STATE_STYLE[l.state] || STATE_STYLE["NO DATA"];
          const isActive = i === activeIdx;
          return (
            <div key={i} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 11px", borderRadius: 8,
              background: isActive ? st.bg : C.surf, border: "1px solid " + (isActive ? st.bdr : C.bdr), borderLeft: "4px solid " + (isActive ? st.color : C.bdr) }}>
              <span style={{ fontWeight: 900, fontSize: 12.5, color: C.text, minWidth: 116 }}>{l.from} → {l.to}</span>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: chgCol(l.fromPct) }}>{pct(l.fromPct)}</span>
              <span style={{ fontSize: 9.5, color: C.lbl }}>vs {l.refName} {pct(l.refPct)}</span>
              <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.3, color: st.color, background: st.bg, border: "1px solid " + st.bdr, borderRadius: 5, padding: "1px 7px" }}>{l.state}</span>
              <span style={{ marginLeft: "auto", fontSize: 9.5, color: isActive ? st.color : C.lbl, fontWeight: 700 }}>{isActive ? "● live · " : ""}{l.to} opens in {fmtCd(toOpen(OPENS[l.to]))}</span>
            </div>
          );
        })}
      </div>
      {active && (
        <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 7, lineHeight: 1.5 }}>
          <b style={{ color: (STATE_STYLE[active.state] || {}).color || C.muted }}>{active.from} → {active.to}: {active.state}</b> — {active.note}
        </div>
      )}
    </Card>
  );
}

// D5 — FX overlay on P&L. The book's base is USD; KRW/HKD positions are quoted local. Shows each
// non-USD position's local move vs its USD-translated move so the FX leg is explicit.
function FxOverlay({ f }) {
  if (!f || !f.available) return null;
  const rows = f.rows.filter(r => r.ccy !== "USD" && r.usd != null)
    .sort((a, b) => Math.abs(b.local) - Math.abs(a.local)).slice(0, 12);
  if (!rows.length) return null;
  const pct = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v}%`;
  const col = (v) => v == null ? C.muted : v > 0 ? C.green : v < 0 ? C.red : C.muted;
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>💱 FX overlay on P&L</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>local move vs USD-translated · base = USD</span>
      </div>
      <div style={{ fontSize: 11.5, color: C.mid, fontWeight: 600, marginTop: 3, lineHeight: 1.5 }}>{f.note}</div>
      <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: "3px 14px", fontSize: 11.5, alignItems: "baseline" }}>
        <span style={{ fontSize: 9.5, color: C.muted, fontWeight: 800, textTransform: "uppercase" }}>Position</span>
        <span style={{ fontSize: 9.5, color: C.muted, fontWeight: 800, textTransform: "uppercase", textAlign: "right" }}>Local</span>
        <span style={{ fontSize: 9.5, color: C.muted, fontWeight: 800, textTransform: "uppercase", textAlign: "right" }}>FX</span>
        <span style={{ fontSize: 9.5, color: C.muted, fontWeight: 800, textTransform: "uppercase", textAlign: "right" }}>USD</span>
        {rows.map(r => (
          <Fragment key={r.sym}>
            <span style={{ fontWeight: 700, color: C.text }}>{r.name} <span style={{ color: C.lbl, fontWeight: 500 }}>{r.ccy}</span></span>
            <span style={{ textAlign: "right", fontWeight: 700, color: col(r.local) }}>{pct(r.local)}</span>
            <span style={{ textAlign: "right", fontWeight: 600, color: col(r.fx) }}>{pct(r.fx)}</span>
            <span style={{ textAlign: "right", fontWeight: 800, color: col(r.usd) }}>{pct(r.usd)}</span>
          </Fragment>
        ))}
      </div>
      <div style={{ fontSize: 10, color: C.lbl, marginTop: 6 }}>FX column = the currency contribution to the USD move (HKD pegged ≈ 0).</div>
    </Card>
  );
}

// D4 — correlation collapse. Three Layer-3 names (SMIC / SK Hynix / Samsung) look diversified;
// when their rolling correlation is high they are one position at ~half the book.
function CorrelationCollapse({ c }) {
  if (!c || !c.available) return null;
  const col = c.tone === "red" ? C.red : c.tone === "amber" ? C.amber : C.green;
  return (
    <Card style={{ borderTop: "4px solid " + col }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>🔗 Correlation collapse</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>{c.legs.join(" · ")} · {c.window}d rolling</span>
        {/* P2.1 — effective positions leads: the aggregate ρ understates a hot pair. */}
        {c.effectivePositions != null && (
          <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 900, color: c.effectivePositions < c.legs.length ? C.red : C.green }}>
            Effective positions: {c.effectivePositions}<span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}> / {c.legs.length} names</span>
          </span>
        )}
      </div>
      {/* Hot pairs (ρ ≥ 0.85) surfaced ABOVE the aggregate — they ARE one position. */}
      {c.hotPairs?.length > 0 && (
        <div style={{ marginTop: 5, padding: "6px 10px", borderRadius: 6, background: C.rBg, border: "1px solid " + C.rBdr, fontSize: 12, fontWeight: 800, color: C.red }}>
          ⚠ {c.hotPairs.map(p => `${p.a}–${p.b} ρ ${p.corr}`).join(" · ")} — one position, not {c.hotPairs.length + 1}. {c.blocks?.length ? `Blocks: ${c.blocks.join(" | ")}.` : ""}
        </div>
      )}
      <div style={{ fontSize: 12.5, fontWeight: 800, color: col === C.green ? C.mid : col, marginTop: 5, lineHeight: 1.5 }}>
        aggregate ρ {c.avg} — {c.reading}
      </div>
      {/* Plain-English translation. The panel previously spoke only in ρ and "effective positions",
          which assumes the reader knows Pearson correlation — the number alone doesn't say what to
          DO. This states the concentration in portfolio terms. */}
      <div style={{ marginTop: 6, padding: "8px 11px", borderRadius: 8, background: C.bg, border: "1px solid " + C.bdr, fontSize: 12, color: C.mid, lineHeight: 1.6 }}>
        <b style={{ color: C.text }}>In plain English:</b> ρ (rho) measures how tightly two names move together over the last {c.window} trading days —
        <b> 1.0</b> = identical moves, <b>0</b> = unrelated, <b>−1</b> = opposite. Above ~<b>0.85</b> two names are effectively the same bet.
        {c.effectivePositions != null && (
          <> You hold <b style={{ color: C.text }}>{c.legs.length} names but {c.effectivePositions} real position{c.effectivePositions === 1 ? "" : "s"}</b>
            {c.effectivePositions < c.legs.length
              ? <> — {c.blocks?.length ? `${c.blocks.join(" and ")} ` : ""}move as one, so the money you think is spread across {c.legs.length} bets is concentrated in {c.effectivePositions}. Sizing each as an independent position <b style={{ color: C.red }}>understates your true risk</b>.</>
              : <> — each name is still pulling its own way, so the diversification is real.</>}
          </>
        )}
        {" "}“Aggregate ρ {c.avg}” is just the average across every pair — a single hot pair can hide inside a calm-looking average, which is why the effective-position count leads.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
        {c.pairs.map(p => (
          <span key={p.a + p.b} style={{ fontSize: 11, fontWeight: 700, color: p.corr >= 0.7 ? C.red : p.corr >= 0.4 ? C.amber : C.green,
            border: "1px solid " + C.bdr, borderRadius: 5, padding: "2px 7px" }}>
            {p.a}–{p.b} <b>{p.corr}</b>
          </span>
        ))}
      </div>
    </Card>
  );
}

// P0.2 — Regime-shift scenarios (Macro tab). Selectable Debasement / Hawkish states the recession
// engine can't derive, surfaced so the parking-bucket decision has somewhere to live.
function RegimeShiftScenarios({ realYield = null, realYieldAsOf = null }) {
  const [sel, setSel] = useState(REGIME_SHIFTS[0].id);
  const s = REGIME_SHIFTS.find(x => x.id === sel) || REGIME_SHIFTS[0];
  // Live gate for the real-yield-defined states (financial repression). A sustained-negative 10Y
  // real yield (DFII10) is the definition; a positive one means the state is NOT active today.
  const gate = s.realYieldGated
    ? (realYield == null
        ? { text: "AWAITING DFII10", col: C.muted, bg: C.bg, bdr: C.bdr }
        : realYield < 0
          ? { text: `ACTIVE · DFII10 ${realYield.toFixed(2)}% (negative)`, col: C.red, bg: C.rBg, bdr: C.rBdr }
          : { text: `NOT ACTIVE · DFII10 +${realYield.toFixed(2)}% (positive)${realYieldAsOf ? ` · ${realYieldAsOf}` : ""}`, col: C.green, bg: C.gBg, bdr: C.gBdr })
    : null;
  return (
    <Card style={{ borderTop: "4px solid " + s.color }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>🔀 Regime-shift scenarios</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>selectable · check positioning — NOT consensus probabilities</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        {REGIME_SHIFTS.map(x => {
          const on = x.id === sel;
          return (
            <button key={x.id} onClick={() => setSel(x.id)} style={{
              background: on ? x.color : C.surf, color: on ? "#fff" : C.mid,
              border: "1.5px solid " + (on ? x.color : C.bdr), borderRadius: 8,
              padding: "6px 12px", fontSize: 12.5, fontWeight: 800, cursor: "pointer", opacity: on ? 1 : 0.75,
            }}>{on ? "● " : ""}{x.label}</button>
          );
        })}
      </div>
      <div style={{ marginTop: 10, padding: "12px 14px", background: s.bg, border: "1.5px solid " + s.bdr, borderRadius: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 16, fontWeight: 900, color: s.color }}>{s.label}</div>
          {gate && <span style={{ fontSize: 11, fontWeight: 900, letterSpacing: 0.3, color: gate.col, background: gate.bg, border: "1.5px solid " + gate.bdr, borderRadius: 6, padding: "2px 8px" }}>{gate.text}</span>}
        </div>
        <div style={{ fontSize: 11, fontWeight: 800, color: s.color, letterSpacing: 0.3, marginTop: 1 }}>{s.tag}</div>
        <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.55, marginTop: 6 }}>{s.desc}</div>
        <div style={{ fontSize: 11.5, color: C.muted, fontWeight: 700, marginTop: 6, lineHeight: 1.5 }}>
          <b style={{ color: C.mid }}>Discriminator:</b> {s.discriminator}
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
          <div style={{ flex: "1 1 200px", minWidth: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: C.green, textTransform: "uppercase", letterSpacing: 0.4 }}>Best</div>
            {s.best.map((a, i) => <div key={i} style={{ fontSize: 12, color: C.mid, marginTop: 2, lineHeight: 1.45 }}>✓ {a}</div>)}
          </div>
          {s.caution && (
            <div style={{ flex: "1 1 200px", minWidth: 0 }}>
              <div style={{ fontSize: 10.5, fontWeight: 800, color: C.amber, textTransform: "uppercase", letterSpacing: 0.4 }}>Caution</div>
              {s.caution.map((a, i) => <div key={i} style={{ fontSize: 12, color: C.mid, marginTop: 2, lineHeight: 1.45 }}>⚠️ {a}</div>)}
            </div>
          )}
          <div style={{ flex: "1 1 200px", minWidth: 0 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: C.red, textTransform: "uppercase", letterSpacing: 0.4 }}>Worst</div>
            {s.worst.map((a, i) => <div key={i} style={{ fontSize: 12, color: C.mid, marginTop: 2, lineHeight: 1.45 }}>✗ {a}</div>)}
          </div>
        </div>
        <div style={{ marginTop: 10, padding: "8px 11px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8, fontSize: 12, fontWeight: 700, color: C.amber, lineHeight: 1.55 }}>
          {s.decision}
        </div>
        {s.counter && (
          <div style={{ marginTop: 8, padding: "8px 11px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, fontSize: 11.5, color: C.mid, lineHeight: 1.55 }}>
            <b style={{ color: C.muted }}>⚖ </b>{s.counter}
          </div>
        )}
      </div>
    </Card>
  );
}

// Constituent baskets under the AI-levered axis — same auditable pattern as the other cards.
function AxisBaskets({ ai, non }) {
  const line = (lbl, arr) => (
    <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 2, lineHeight: 1.5 }}>
      <span style={{ fontWeight: 800, color: C.muted }}>{lbl}: </span>
      {arr && arr.length
        ? arr.map((x, i) => (
            <span key={x.name}>{i ? " · " : ""}<span style={{ color: C.mid, fontWeight: 700 }}>{x.name}</span> <span style={{ color: pbPctColor(x.chg) }}>{pbFmtPct(x.chg)}</span></span>
          ))
        : <span>—</span>}
    </div>
  );
  return <div style={{ marginTop: 4 }}>{line("AI", ai)}{line("non-AI", non)}</div>;
}

function MacroStat({ label, value, sub }) {
  return (
    <div style={{ minWidth: 90 }}>
      <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 900, color: C.text }}>{value}</div>
      {sub ? <div style={{ fontSize: 11, color: C.lbl }}>{sub}</div> : null}
    </div>
  );
}

// Business days between a YYYY-MM-DD and today (UTC). For the daily-cadence stale check.
function bizDaysAgo(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00Z");
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let n = 0;
  while (d < end) { d.setUTCDate(d.getUTCDate() + 1); const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) n++; }
  return n;
}
// Cadence-based freshness for a macro field → { stale, text }. daily > 2 biz days;
// intraday > 30m. Also flags a future-dated asOf.
function macroFresh(field) {
  if (!field) return { stale: false, text: "" };
  if (field.date) {
    if (new Date(field.date + "T00:00:00Z") > new Date()) return { stale: true, text: "⚠ date — verify" };
    // A DAILY series only prints on trading days, so a Sat/Sun asOf is impossible — flag it
    // rather than presenting a weekend date as a real print. (Monthly series are exempt: their
    // date is a PERIOD label, e.g. CPI stamped the 1st, which legitimately lands on a weekend.)
    const wd = new Date(field.date + "T00:00:00Z").getUTCDay();
    if (field.cadence === "daily" && (wd === 0 || wd === 6)) {
      return { stale: true, text: `⚠ ${field.date} is a non-trading day` };
    }
    const bd = bizDaysAgo(field.date);
    const stale = bd != null && bd > 2;
    // Daily fields are last-hard-print series: label them as such so the date reads as
    // "when it last printed", not "as of now".
    const base = field.cadence === "daily" ? `last print ${field.date}` : field.date;
    return { stale, text: base + (stale ? ` · stale · ${bd}d` : "") };
  }
  if (field.ts) {
    const ageMin = Math.max(0, Math.round(Date.now() / 1000 / 60 - field.ts / 60));
    return ageMin > 30 ? { stale: true, text: `stale · ${humanizeAge(ageMin)}` } : { stale: false, text: "" };
  }
  return { stale: false, text: "" };
}
// P1.2 — percentile + band chip. "12th pct (3Y) · CALM". Percentile = is this unusual; band =
// does it matter. Band coloured by severity so a benign level and an extreme one read apart.
function BenchChip({ b }) {
  if (!b || (b.pct == null && !b.band)) return null;
  const bandCol = /EXTREME|RECESSIONARY|HIGH/i.test(b.band || "") ? C.red
    : /ELEVATED|STRESSED|WATCHFUL/i.test(b.band || "") ? C.amber : C.muted;
  return (
    <span style={{ fontSize: 10, color: C.lbl, fontWeight: 700 }}>
      {b.pct != null ? `${b.pct}th pct${b.window ? ` (${b.window})` : ""}` : ""}
      {b.band ? <> · <span style={{ color: bandCol, fontWeight: 800 }}>{b.band}</span></> : null}
    </span>
  );
}

// One macro cell: value + direction arrow (delta) + asOf/stale + source on hover.
function MacroCell({ field, value, delta, deltaSuffix }) {
  const mf = macroFresh(field);
  const suspect = !!field?.suspect;   // failed a sanity/relationship check → don't show clean
  const arrow = delta == null ? "" : delta > 0 ? "▲" : delta < 0 ? "▼" : "■";
  // A2 — never render a confident green/red direction arrow off a STALE print. When the field
  // is stale the delta is a prior-print move, not today's, so the arrow is neutralized to muted
  // (the amber "last print · stale · Nd" text alongside marks WHY). A live field keeps its color.
  const dcol = mf.stale ? C.muted
             : delta == null ? C.muted : delta > 0 ? C.green : delta < 0 ? C.red : C.muted;
  return (
    <MetricCard
      label={field?.name}
      title={(field?.src ? "source: " + field.src : "") + (suspect ? " · ⚠ failed sanity check — value suspect" : "")}
      value={<>{suspect ? "⚠ " : ""}{value}</>}
      valueColor={suspect ? C.amber : C.text}
      strike={suspect}
    >
      <div style={{ fontSize: 11, display: "flex", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
        {suspect && <span style={{ color: C.amber, fontWeight: 700 }}>suspect ({field.src})</span>}
        {!suspect && delta != null && <span style={{ color: dcol, fontWeight: 700 }}>{arrow} {Math.abs(delta)}{deltaSuffix}</span>}
        {mf.text && <span style={{ color: mf.stale ? C.amber : C.lbl }}>{mf.text}</span>}
        <BenchChip b={field?.benchmark} />
      </div>
    </MetricCard>
  );
}

function KoreaStressPanel({ korea }) {
  const { won, vol, cluster, note } = korea;
  const cCol = pbClusterColor(cluster);
  // USD/KRW: a rising won (weakening) is bad → red; falling (stabilizing) → green.
  const wonCol = won.dir === "rising" ? C.red : won.dir === "falling" ? C.green : C.amber;
  const vCol = pbBandColor(vol.band);
  const box = { background: C.bg, border: "1.5px solid " + C.bdr, borderRadius: 10, padding: "12px 14px" };
  return (
    <Card style={{ borderTop: "4px solid " + cCol }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        <SLabel>🇰🇷 Korea Stress — local gate</SLabel>
        <Pill label={cluster.toUpperCase()} color={cCol} />
      </div>
      <div style={{ color: cCol, fontSize: 13, fontWeight: 700, marginBottom: 14 }}>{note}</div>
      <MetricGrid min={220}>
        {/* USD/KRW — level vs the 1,491 flip × direction vs prior close */}
        <MetricCard
          label="USD/KRW"
          value={won.level ?? "—"}
          sub={won.delta != null && (
            <span style={{ fontSize: 12, fontWeight: 800, color: wonCol }}>
              {won.delta >= 0 ? "+" : "−"}{Math.abs(won.delta)} <span style={{ color: C.lbl }}>1D</span>
            </span>
          )}
        >
          {/* The flip threshold is the interpretation, so state where we sit relative to it */}
          {won.flip != null && (
            <div style={{ fontSize: 10.5, fontWeight: 700, color: won.aboveFlip ? C.red : C.green, marginTop: 2 }}>
              {won.aboveFlip ? "▲ above" : "▼ below"} {won.flip} · {won.aboveFlip ? "flight zone" : "mechanical zone"}
            </div>
          )}
          <div style={{ fontSize: 11.5, fontWeight: 700, color: wonCol, marginTop: 2 }}>{won.flag}</div>
        </MetricCard>
        {/* VKOSPI — scale calibrated to this instrument (markers at 25/35/50, 0–60 range) */}
        <MetricCard
          label="VKOSPI fut"
          value={vol.level ?? "—"}
          valueColor={vCol}
          sub={<>
            <span style={{ fontSize: 12, fontWeight: 800, color: vCol }}>{vol.band !== "n/a" ? vol.band : ""}</span>
            {vol.changePct != null && (
              <span style={{ fontSize: 11, fontWeight: 800, color: vol.changePct > 0 ? C.red : C.green }}>
                {vol.changePct >= 0 ? "+" : ""}{vol.changePct}% <span style={{ color: C.lbl }}>1D</span>
              </span>
            )}
          </>}
        >
          <div style={{ position: "relative", height: 6, background: C.bdr, borderRadius: 3, margin: "7px 0 5px" }}
            title="calibrated to VKOSPI's own 2017–2025 range (~15–25): 25 elevated · 35 high · 50 extreme">
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: Math.max(0, Math.min(100, (vol.level || 0) / 60 * 100)) + "%", background: vCol, borderRadius: 3 }} />
            {[25, 35, 50].map(m => <div key={m} style={{ position: "absolute", left: (m / 60 * 100) + "%", top: -2, bottom: -2, width: 1, background: C.muted }} />)}
          </div>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: vCol }}>{vol.flag}</div>
        </MetricCard>
      </MetricGrid>
      {/* Halt severity — sidecar and circuit-breaker are DIFFERENT mechanisms; show which fired */}
      {korea.halt && (korea.halt.fired?.length > 0) && (
        <div style={{ marginTop: 10, padding: "7px 10px", background: C.rBg, border: "1.5px solid " + C.rBdr, borderRadius: 6 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: C.red, textTransform: "uppercase", letterSpacing: 0.5 }}>Halt · </span>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.red }}>{korea.halt.fired.join(" · ")}</span>
          {korea.halt.note && <div style={{ fontSize: 10.5, color: C.amber, fontWeight: 700, marginTop: 2 }}>{korea.halt.note}</div>}
        </div>
      )}
    </Card>
  );
}

// Southbound / China-policy-trade panel — the mainland-sentiment read on SMIC (≈ a third of NLV,
// trades as a China-policy bet). Two layers: (1) SMIC's A/H premium (688981.SS vs 0981.HK) — an
// AUTOMATIC, market-priced sentiment gauge from /api/indicators, the primary signal; (2) aggregate
// Southbound net — a manual daily hand entry for the broad mainland-appetite backdrop. Trends are
// 5d/20d since single days are noise. Self-fetches both; a save 401s if unauthenticated.
function SouthboundPanel() {
  const [series, setSeries] = useState([]);
  const [smicAH, setSmicAH] = useState(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [agg, setAgg] = useState("");
  const [smic, setSmic] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    fetch("/api/manual-entry").then(r => r.json()).then(j => setSeries(j.southbound?.series || [])).catch(() => {});
    fetch("/api/indicators").then(r => r.json()).then(j => setSmicAH(j.smicAH || null)).catch(() => {});
  }, []);

  const ahOk = smicAH?.premium != null;           // auto feed live?
  const ah = southboundLevelTrend(smicAH?.series || [], "premium");
  const ahRead = ahPremiumRead(smicAH?.premium ?? null, ah.d5, ah.d20, smicAH);
  const tSmic = southboundLevelTrend(series, "smicHolding");  // manual CCASS-holding fallback
  const tAgg = southboundTrend(series, "aggregateNet");
  const read = southboundRead(tAgg);
  const latest = tAgg.latest;
  const stale = latest ? sbStale(latest.date) : true;
  const aggTone = read.tone === "green" ? C.green : read.tone === "amber" ? C.amber : C.muted;
  const ahTone = ahRead.tone === "green" ? C.green : ahRead.tone === "amber" ? C.amber : C.muted;

  async function save() {
    if (!agg.trim() && !smic.trim() && !notes.trim()) { setMsg({ ok: false, text: "enter a number (or a note)" }); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) { setMsg({ ok: false, text: "date must be YYYY-MM-DD" }); return; }
    setSaving(true); setMsg(null);
    try {
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ southbound: { date: date.trim(), aggregateNet: agg.trim() || null, smicHolding: smic.trim() || null, notes: notes.trim() || null } }),
      });
      const j = await r.json();
      if (r.ok) {
        const fresh = await fetch("/api/manual-entry").then(x => x.json()).catch(() => null);
        setSeries(fresh?.southbound?.series || []);
        setAgg(""); setSmic(""); setNotes(""); setMsg({ ok: true, text: `Saved ${date}` });
      } else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }

  const inp = { padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6, background: "#fff", color: C.text };
  const win = (w) => `${w.sum > 0 ? "+" : ""}${w.sum} (${w.days}d, ${w.dir})`;
  const dlt = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}pp`;
  const CCASS = "https://www3.hkexnews.hk/sdw/search/searchsdw.aspx";
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <SLabel><span style={{ display: "inline-block", background: "#B91C1C", color: "#fff", fontSize: 9, fontWeight: 800, padding: "1px 4px", borderRadius: 3, marginRight: 5 }}>HK</span>China-policy trade — SMIC A/H premium + Southbound flow</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>{ahOk ? "A/H premium 📡 auto" : "A/H feed down — SMIC holding ✍️ manual"} · aggregate net ✍️ manual</span>
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 8 }}>
        {/* PRIMARY — SMIC A/H premium: automatic, market-priced mainland-sentiment gauge. */}
        <div style={{ flex: "1 1 240px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, padding: "9px 12px" }}>
          <div style={{ fontSize: 11, color: C.mid, fontWeight: 700 }}>SMIC A/H premium — 688981.SS vs 0981.HK <span style={{ color: C.green, fontWeight: 800 }}>· 📡 auto</span></div>
          {smicAH?.premium != null ? (
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 1.6 }}>
              {smicAH.asOf || "latest"}: <b style={{ color: C.text, fontSize: 14 }}>{smicAH.premium}%</b> <span style={{ color: C.lbl }}>(A ¥{smicAH.aPrice} · H HK${smicAH.hPrice} · CNY→HKD {smicAH.cnyHkd})</span><br />
              Δ 5-day <b style={{ color: (ah.d5 ?? 0) > 0 ? C.green : (ah.d5 ?? 0) < 0 ? C.red : C.muted }}>{dlt(ah.d5)}</b> · Δ 20-day <b style={{ color: (ah.d20 ?? 0) > 0 ? C.green : (ah.d20 ?? 0) < 0 ? C.red : C.muted }}>{dlt(ah.d20)}</b>
            </div>
          ) : tSmic.level != null ? (
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 1.6 }}>
              <span style={{ color: C.amber, fontWeight: 700 }} title={smicAH?.reason || undefined}>A/H feed down{smicAH?.failed?.length ? ` (${smicAH.failed.join(", ")})` : ""}</span> — manual Connect holding:<br />
              {tSmic.latest?.date}: <b style={{ color: C.text, fontSize: 14 }}>{tSmic.level}%</b> held via Southbound<br />
              Δ 5-day <b style={{ color: (tSmic.d5 ?? 0) > 0 ? C.green : (tSmic.d5 ?? 0) < 0 ? C.red : C.muted }}>{dlt(tSmic.d5)}</b> · Δ 20-day <b style={{ color: (tSmic.d20 ?? 0) > 0 ? C.green : (tSmic.d20 ?? 0) < 0 ? C.red : C.muted }}>{dlt(tSmic.d20)}</b>
            </div>
          ) : (
            <div style={{ fontSize: 11.5, color: C.amber, marginTop: 3, lineHeight: 1.55 }}>
              <span title={smicAH?.reason || undefined}>A/H feed down{smicAH?.failed?.length ? ` (${smicAH.failed.join(", ")})` : ""}.</span> Enter SMIC's Southbound holding % from <a href={CCASS} target="_blank" rel="noopener noreferrer" style={{ color: C.blue, fontWeight: 700 }}>HKEX CCASS ↗</a>: stock code <b>0981</b> → pick the date → read the <i>Shanghai/Shenzhen Stock Connect</i> row's % of issued, and type it in the <b>SMIC holding %</b> box below.
            </div>
          )}
        </div>

        {/* SECONDARY — aggregate Southbound net: manual broad mainland-appetite backdrop. */}
        <div style={{ flex: "1 1 200px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, padding: "9px 12px" }}>
          <div style={{ fontSize: 11, color: C.mid, fontWeight: 700 }}>Aggregate Southbound net (HKD bn) <span style={{ color: C.muted, fontWeight: 700 }}>· ✍️ manual</span></div>
          {latest ? (
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 1.6 }}>
              {latest.date}: <b style={{ color: latest.aggregateNet > 0 ? C.green : latest.aggregateNet < 0 ? C.red : C.muted }}>{latest.aggregateNet != null ? (latest.aggregateNet > 0 ? "+" : "") + latest.aggregateNet : "—"}</b>{stale && <span style={{ color: C.amber, fontWeight: 700 }}> · ⚠ stale</span>}<br />
              5-day <b style={{ color: C.text }}>{win(tAgg.w5)}</b> · 20-day <b style={{ color: C.text }}>{win(tAgg.w20)}</b>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: C.lbl, marginTop: 3, lineHeight: 1.5 }}>Optional — hand-enter the day's total Southbound net buy below (HKEX daily Stock Connect stats).</div>
          )}
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: ahTone, fontWeight: 600, lineHeight: 1.55, marginBottom: latest ? 4 : 10 }}>{ahRead.text}</div>
      {latest && <div style={{ fontSize: 12, color: aggTone, lineHeight: 1.5, marginBottom: 10 }}>{read.text}</div>}

      {/* The A/H premium above is automatic. Aggregate net is an optional manual backdrop; the SMIC
          holding % input only appears when the auto A/H feed is down (its fallback). */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input value={date} onChange={e => setDate(e.target.value)} placeholder="date YYYY-MM-DD" style={{ ...inp, flex: "1 1 120px", minWidth: 0 }} />
        <input value={agg} onChange={e => setAgg(e.target.value)} placeholder="aggregate Southbound net (HKD bn)" style={{ ...inp, flex: "1 1 200px", minWidth: 0 }} />
        {!ahOk && <input value={smic} onChange={e => setSmic(e.target.value)} placeholder="SMIC holding % (CCASS, fallback)" style={{ ...inp, flex: "1 1 180px", minWidth: 0 }} />}
      </div>
      <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="notes (optional)" style={{ ...inp, width: "100%", marginTop: 8, boxSizing: "border-box" }} />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button onClick={save} disabled={saving} style={{ background: C.blue, color: "#fff", border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12.5, fontWeight: 800, cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save day"}</button>
        <span style={{ fontSize: 11, color: C.lbl }}>{tAgg.nObs} day{tAgg.nObs === 1 ? "" : "s"} stored</span>
        {msg && <span style={{ fontSize: 11.5, fontWeight: 700, color: msg.ok ? C.green : C.red }}>{msg.text}</span>}
      </div>
    </Card>
  );
}

// Korea manual-entry: paste the KOFIA panel → preview (with the recompute-pct guard) →
// Save (commits data/korea_kofia.json via /api/korea-save so Pre-Reads pick it up too).
function KoreaManualEntry({ kofia, onSaved }) {
  const [blob, setBlob] = useState("");
  const [u7709, setU7709] = useState("");
  const [u7709date, setU7709date] = useState(kofia?.latest?.units7709?.asOf || "");
  const [fNet, setFNet] = useState("");
  const [fDate, setFDate] = useState(kofia?.latest?.foreignNet?.asOf || "");
  const [iNet, setINet] = useState("");
  const [iDate, setIDate] = useState(kofia?.latest?.instNet?.asOf || "");
  const [rNet, setRNet] = useState("");
  const [rDate, setRDate] = useState(kofia?.latest?.retailNet?.asOf || "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [savedLatest, setSavedLatest] = useState(null);  // optimistic: show saved values instantly

  const parsed = blob.trim() ? parseKofia(blob) : { list: [], anyMismatch: false };
  const latest = savedLatest || kofia?.latest || {};
  const hist = kofia?.history || [];
  const uvNum = Number(String(u7709).replace(/,/g, ""));
  const fv = Number(String(fNet).replace(/,/g, ""));
  const iv = Number(String(iNet).replace(/,/g, ""));
  const rv = Number(String(rNet).replace(/,/g, ""));
  const hasFlow = (fNet.trim() !== "" && Number.isFinite(fv)) || (iNet.trim() !== "" && Number.isFinite(iv))
                  || (rNet.trim() !== "" && Number.isFinite(rv));
  const canSave = (parsed.list.length > 0 && !parsed.anyMismatch) || (Number.isFinite(uvNum) && uvNum > 0) || hasFlow;

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const body = {};
      if (blob.trim()) body.blob = blob.trim();
      if (Number.isFinite(uvNum) && uvNum > 0) body.units7709 = { value: uvNum, asOf: u7709date || undefined };
      if (fNet.trim() !== "" && Number.isFinite(fv)) body.foreignNet = { value: fv, asOf: fDate || undefined };
      if (iNet.trim() !== "" && Number.isFinite(iv)) body.instNet = { value: iv, asOf: iDate || undefined };
      if (rNet.trim() !== "" && Number.isFinite(rv)) body.retailNet = { value: rv, asOf: rDate || undefined };
      const r = await fetch("/api/korea-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "include" });
      const j = await r.json();
      if (!r.ok) setMsg({ ok: false, text: j.error || ("Save failed " + r.status) });
      else {
        if (j.latest) setSavedLatest(j.latest);   // show the saved values immediately — no refresh
        setMsg({ ok: true, text: `Saved ${j.saved.join(", ")}${j.missing?.length ? " · kept prior: " + j.missing.join(", ") : ""}. Values updated below; committing in the background so the Pre-Reads pick it up too.` });
        setBlob(""); setU7709(""); setFNet(""); setINet(""); setRNet("");
      }
    } catch (e) { setMsg({ ok: false, text: "Save error: " + e.message }); }
    setSaving(false);
  }

  // Margin-loan history from the DATED series (one row per observation date, ordered), not
  // the savedAt-keyed snapshots — three saves of the 07-21 print used to plot as three points
  // at the same x, which is what drew the flat line across duplicate dates. Each row converts
  // with its OWN stored unit; a row whose unit we can't map is dropped rather than guessed.
  const mlSeries = (kofia?.series?.marginLoans || []).map(r => {
    const t = toWonTrillions(r.value, r.unit || "백만원");
    return t == null ? null : { d: r.date.slice(5), date: r.date, v: +t.toFixed(2) };
  }).filter(Boolean);
  // Legacy fallback for a cached payload that predates `series`: dedupe by asOf, then sort.
  const mlHist = mlSeries.length ? mlSeries : (() => {
    const byDate = new Map();
    for (const h of hist) {
      const c = h.marginLoans;
      if (!c || c.value == null || !c.asOf) continue;
      const t = toWonTrillions(c.value, c.unit || "백만원");
      if (t != null) byDate.set(c.asOf, { d: c.asOf.slice(5), date: c.asOf, v: +t.toFixed(2) });
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  })();

  return (
    <Card>
      <SLabel><span style={{ display: "inline-block", background: "#0F4C9B", color: "#fff", fontSize: 9, fontWeight: 800, padding: "1px 4px", borderRadius: 3, marginRight: 5, letterSpacing: 0 }}>KR</span>Korea Manual Entry — KOFIA paste + 7709 units + KRX flows</SLabel>
      <div style={{ fontSize: 11, margin: "3px 0 8px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ color: C.muted, fontWeight: 700 }}>Sources:</span>
        <a href="https://freesis.kofia.or.kr/" target="_blank" rel="noopener noreferrer" style={{ color: C.blue, textDecoration: "none", fontWeight: 700 }}>KOFIA freesis ↗</a>
        <a href="https://data.krx.co.kr/" target="_blank" rel="noopener noreferrer" style={{ color: C.blue, textDecoration: "none", fontWeight: 700 }}>KRX 투자자별 매매동향 ↗</a>
        <a href="https://www.csopasset.com/en/products/hk-skhy-2l" target="_blank" rel="noopener noreferrer" style={{ color: C.blue, textDecoration: "none", fontWeight: 700 }}>CSOP 7709 ↗</a>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, margin: "8px 0 10px" }}>
        {["marginLoans", "deposits", "cma", "kr3yGovt", "kr3yCorp", "units7709", "foreignNet", "instNet", "retailNet"].map(k => {
          const e = latest[k];
          const line = kofiaStoredLine(k, e);
          // Colour by direction: currency rows by their %, flows by net sign (green up/buy, red down/sell).
          const isCur = KOFIA_CURRENCY.includes(k), isFlow = KOFIA_FLOWS.includes(k);
          const sig = !e ? null : isCur ? e.pct : isFlow ? e.value : null;
          const col = sig == null ? C.text : sig > 0 ? C.green : sig < 0 ? C.red : C.muted;
          const nObs = (kofia?.series?.[k] || []).length;
          // Detected unit is surfaced on hover for audit — sources genuinely differ
          // (KOFIA panel 백만원 vs KRX flow table 십억원) and a silent mismatch is 1,000× wrong.
          const tip = e ? `detected unit: ${e.unit || "—"}${e.asOf ? ` · as-of ${e.asOf}` : ""} · ${nObs} dated obs` : "not set";
          return (
            <div key={k} style={{ minWidth: 140 }} title={tip}>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>{KOFIA_NAME_BY_KEY[k] || k}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: line ? ((isCur || isFlow) ? col : C.text) : C.lbl }}>{line || "— not set"}</div>
              {e?.unit && <div style={{ fontSize: 9.5, color: C.lbl }}>unit {e.unit}{nObs ? ` · ${nObs} obs` : ""}</div>}
            </div>
          );
        })}
      </div>
      {koreaFlowRead(latest) && (
        <div style={{ margin: "0 0 12px", padding: "8px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8 }}>
          <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.55 }}>
            <b style={{ color: C.muted, fontWeight: 800 }}>READ · </b>{koreaFlowRead(latest)}
          </div>
          {koreaFlowImplication(latest) && (
            <div style={{ fontSize: 12.5, color: C.text, lineHeight: 1.55, marginTop: 5, paddingTop: 5, borderTop: "1px dashed " + C.bdr }}>
              <b style={{ color: C.blue, fontWeight: 800 }}>IMPLICATION · </b>{koreaFlowImplication(latest)}
            </div>
          )}
        </div>
      )}
      {mlHist.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, marginBottom: 2 }}>
            Margin Loans (₩T) — history
            <span style={{ color: C.lbl, fontWeight: 400 }}> · {mlHist.length} dated observation{mlHist.length === 1 ? "" : "s"}</span>
          </div>
          {mlHist.length === 1 ? (
            // One real print: show the point and say so. A 2-point line drawn from a single
            // observation duplicated across dates is a fabricated trend — never render that.
            <div style={{ fontSize: 12, color: C.mid }}>
              <b>₩{mlHist[0].v.toFixed(2)}T</b> <span style={{ color: C.lbl }}>({mlHist[0].date})</span>
              <span style={{ color: C.amber, fontWeight: 700, marginLeft: 8 }}>insufficient history</span>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={60}>
              <LineChart data={mlHist} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
                <Line type="monotone" dataKey="v" stroke={C.blue} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                <XAxis dataKey="d" tick={{ fill: C.lbl, fontSize: 9 }} axisLine={false} tickLine={false} />
                <YAxis domain={["auto", "auto"]} hide />
                <Tooltip formatter={v => "₩" + v + "T"} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
      <textarea value={blob} onChange={e => setBlob(e.target.value)}
        placeholder="Paste the KOFIA summary panel here (신용융자 / 투자자예탁금 / CMA잔고 / KOSPI지수 / 국고채 3년 / 회사채 3년)…"
        style={{ width: "100%", minHeight: 90, fontFamily: "monospace", fontSize: 12, padding: 10, border: "1.5px solid " + C.bdr, borderRadius: 8, resize: "vertical", boxSizing: "border-box" }} />
      {parsed.list.length > 0 && (
        <div style={{ margin: "10px 0", padding: "10px 12px", background: C.bg, border: "1.5px solid " + (parsed.anyMismatch ? C.rBdr : C.bdr), borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 800, textTransform: "uppercase", marginBottom: 6 }}>Preview — {parsed.list.length} fields (nothing saves until you click Save)</div>
          {parsed.list.map(f => (
            <div key={f.key} style={{ fontSize: 12.5, color: f.mismatch ? C.red : C.text, marginBottom: 3 }}>
              {f.mismatch ? "⚠ " : "• "}<b>{f.display}</b> · {kofiaDisplay(f)} · as of {f.asOf || "??"}{f.mismatch ? `  — mismatch (recomputed ${f.recomputedPct}%)` : ""}
            </div>
          ))}
          {parsed.anyMismatch && <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginTop: 4 }}>⚠ Recompute mismatch — fix the paste; save is blocked.</div>}
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 8 }}>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>7709 Outstanding Units</div>
          <input value={u7709} onChange={e => setU7709(e.target.value)} placeholder="e.g. 887,500,000"
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 150 }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>as of (last-known, not today)</div>
          <input type="date" value={u7709date} onChange={e => setU7709date(e.target.value)}
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6 }} />
        </div>
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Foreign Net (₩bn)</div>
          <input value={fNet} onChange={e => setFNet(e.target.value)} placeholder="e.g. -1,234"
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 110 }} />
        </div>
        <input type="date" value={fDate} onChange={e => setFDate(e.target.value)} title="Foreign-net date"
          style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6 }} />
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Institutional Net (₩bn)</div>
          <input value={iNet} onChange={e => setINet(e.target.value)} placeholder="e.g. +567"
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 110 }} />
        </div>
        <input type="date" value={iDate} onChange={e => setIDate(e.target.value)} title="Institutional-net date"
          style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6 }} />
        <div>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }} title="개인 — the absorption counterparty for foreign selling">Retail Net (₩bn)</div>
          <input value={rNet} onChange={e => setRNet(e.target.value)} placeholder="e.g. +2,614"
            style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6, width: 110 }} />
        </div>
        <input type="date" value={rDate} onChange={e => setRDate(e.target.value)} title="Retail-net date"
          style={{ fontSize: 13, padding: "6px 8px", border: "1.5px solid " + C.bdr, borderRadius: 6 }} />
        <Btn onClick={save} disabled={saving || !canSave} color={C.blue} bgColor={C.blBg} label={saving ? "⏳ Saving…" : "💾 Save"} />
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
    </Card>
  );
}

// Category (role) sort order — the thesis reads cross-region, so foundry sits with
// foundry, memory with memory, regardless of listing venue.
const PB_CAT_ORDER = ["gpu", "memory", "litho", "equip", "foundry-leading", "foundry-mature", "analog", "megacap", "index"];
const pbCatRank = c => { const i = PB_CAT_ORDER.indexOf(c); return i < 0 ? 99 : i; };
// Compact role labels for the name-card tag (roles are now node/segment-specific).
const PB_ROLE_LABEL = {
  "foundry-leading": "lead fdry", "foundry-mature": "mat fdry", "analog": "analog/auto",
  "memory": "memory", "litho": "litho", "equip": "equip", "gpu": "gpu", "megacap": "megacap", "index": "index",
};
const PB_REGION_RANK = { asia: 0, eu: 1, us: 2 };
// Per-name geo badge from the Yahoo symbol suffix (finer than the asia/eu/us data region).
function pbGeo(sym) {
  if (!sym) return "US";
  if (sym.endsWith(".HK")) return "HK";
  if (sym.endsWith(".KS") || sym.endsWith(".KQ")) return "KR";
  if (sym.endsWith(".TW")) return "TW";
  if (sym.endsWith(".T")) return "JP";
  if (/\.(AS|PA|DE|L)$/.test(sym)) return "EU";
  return "US";
}

function GlobalPlaybook({ byRegion, regions, toggleRegion, loading, error, updated, onRefresh, fmtTime, reconSummary, liveIntervention }) {
  // Both All and single-region are filtered views of ONE spine. `active` = loaded data for
  // the selected region(s); `data` (= first active) backs the global macro strip + calendar.
  const active = regions.map(r => byRegion[r]).filter(Boolean);
  const data = active[0];
  const multi = regions.length > 1;

  // Combined, sorted names across active regions. Sort: category → (region, ALL only) →
  // abs(%chg); ★ leaders pinned to the top of their category group.
  const allNames = active.flatMap(d => d.names.map(n => ({ ...n, _region: d.region })));
  allNames.sort((a, b) =>
    pbCatRank(a.role) - pbCatRank(b.role)
    || (b.leader ? 1 : 0) - (a.leader ? 1 : 0)
    || (multi ? (PB_REGION_RANK[a._region] ?? 9) - (PB_REGION_RANK[b._region] ?? 9) : 0)
    || Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0)
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Region multi-select (default All) + refresh */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: C.muted, fontWeight: 700, marginRight: 2 }}>{regions.length === 3 ? "All" : "Regions"}:</span>
          {PB_REGIONS.map(r => {
            const on = regions.includes(r.id);
            return (
              <button key={r.id} onClick={() => toggleRegion(r.id)} style={{
                background: on ? C.blue : C.surf, color: on ? "#fff" : C.mid,
                border: "1.5px solid " + (on ? C.blue : C.bdr), borderRadius: 8,
                padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: on ? 1 : 0.6,
              }}>{on ? "✓ " : ""}{r.label}</button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {(() => {
            // The "Updated" stamp is rehydrated from localStorage, so it can be DAYS old while
            // still rendering as a bare HH:MM that reads as current. Show the date whenever it
            // is not today, and flag stale cache outright — a global stamp must never imply a
            // freshness the per-field stamps contradict.
            const u = updated ? new Date(updated) : null;
            const today = u && u.toDateString() === new Date().toDateString();
            const ageH = u ? (Date.now() - u.getTime()) / 3.6e6 : null;
            const old = ageH != null && ageH > 12;
            return (
              <span style={{ fontSize: 12, color: old ? C.amber : C.muted, fontWeight: old ? 700 : 400 }}
                title={u ? u.toString() : "never fetched"}>
                {old ? "⚠ cached " : "Updated "}
                {u ? (today ? fmtTime(u) : u.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + fmtTime(u)) : "—"}
              </span>
            );
          })()}
          <Btn onClick={onRefresh} disabled={loading} color={C.blue} bgColor={C.blBg} label={loading ? "⏳ …" : "🔄 Refresh"} />
        </div>
      </div>

      {error && <Card style={{ background: C.rBg, border: "1.5px solid " + C.rBdr }}><span style={{ color: C.red, fontSize: 13 }}>{error}</span></Card>}

      {!data ? (
        <Card><div style={{ color: C.muted, fontSize: 14 }}>{loading ? "Loading…" : "No data yet — hit Refresh."}</div></Card>
      ) : (
        <>
          {/* ── TOP OF PAGE: the two highest-signal elements ──────────────────────────
              Ordered by signal value, not by data-flow order. The tripwire count is the
              at-a-glance "are the gauges aligning" read, and the composed READ is the
              synthesized conclusion — both were previously buried mid-page. */}
          {/* ── LAYOUT (Part C) — the question order: Scenario → Tripwires → READ → Credit →
              Rates → everything else. The synthesis cluster leads; raw data and the book-specific
              tell cards (handoff / correlation / FX / events) drop to "everything else" below. */}
          {/* A1 — POSTURE headline: the single "what to do" card, above everything. */}
          {data.posture && <PostureCard p={data.posture} />}
          {/* 1 — Scenario board (synthesis). */}
          {data.scenarios && <ScenarioBoard scenarios={data.scenarios} />}
          {/* 2 — Tripwires: vol regime + gauges + 7709, tagged by scenario. */}
          {data.volTerm && <VolRegime v={data.volTerm} />}
          <GaugesLeaning leaning={data.leaning} prominent />
          {/* CSOP 7709 deleveraging tripwire — standalone, NOT part of the gauges count. */}
          {data.csop7709 && <Csop7709Tripwire t={data.csop7709} />}

          {/* 3 — Composed READ (A4) — leads with the qualification, then structured claim rows.
              Deterministic, from the gate state; observational only. */}
          {data.read?.structured?.rows?.length > 0 && (() => {
            const st = data.read.structured;
            const rowTone = t => t === "red" ? C.red : t === "amber" ? C.amber : C.mid;
            return (
            <Card>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <SLabel>📝 Read</SLabel>
                <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>deterministic, no model</span>
                <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, textTransform: "uppercase",
                  color: st.confidence === "clean" ? C.green : st.confidence === "qualified" ? C.amber : C.red,
                  border: "1px solid currentColor", borderRadius: 4, padding: "1px 5px" }}>
                  {st.confidence}
                </span>
              </div>
              {/* Lead qualification — the single most important line, at the top. */}
              {st.lead && (
                <div style={{ fontSize: 12.5, fontWeight: 700, color: C.amber, background: C.aBg,
                  border: "1px solid " + C.aBdr, borderRadius: 6, padding: "7px 10px", marginTop: 6, lineHeight: 1.5 }}>
                  ⚠ {st.lead}
                </div>
              )}
              {/* Labelled claim rows. */}
              <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "auto auto 1fr", gap: "3px 12px", alignItems: "baseline" }}>
                {st.rows.map((r, i) => (
                  <Fragment key={i}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>{r.label}</span>
                    <span style={{ fontSize: 12, fontWeight: 800, color: rowTone(r.tone) }}>{r.state}</span>
                    <span style={{ fontSize: 12, color: C.muted, fontWeight: 500, lineHeight: 1.45 }}>{r.detail}</span>
                  </Fragment>
                ))}
              </div>
              {st.flipsIf && (
                <div style={{ marginTop: 8, display: "flex", gap: 12, alignItems: "baseline" }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 66 }}>Flips if</span>
                  <span style={{ fontSize: 12, color: C.blue, fontWeight: 700 }}>{st.flipsIf.replace(/^Flips if /i, "")}</span>
                </div>
              )}
              {st.caveats?.length > 0 && (
                <div style={{ marginTop: 4, display: "flex", gap: 12, alignItems: "baseline" }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 66 }}>Caveats</span>
                  <span style={{ fontSize: 11, color: C.lbl, lineHeight: 1.45 }}>{st.caveats.join(" · ")}</span>
                </div>
              )}
            </Card>
            );
          })()}

          {/* 4 — Credit (master gauge) lives inside the regime block below; it follows READ. */}
          {/* Regime summary — one card per active region (stacked in All view) */}
          {active.map(d => (
          <Card key={d.region}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <SLabel>🧭 Regime — {d.label}</SLabel>
              <RegionSessionBadge session={d.session} tz={d.tz} />
            </div>
            {d.regime?.staleWhileOpen && (
              <div style={{ marginBottom: 10, padding: "6px 10px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 6, fontSize: 11.5, fontWeight: 700, color: C.amber }}>
                ⚠ Equity axes stale — {d.label} market open but prints are prior-close. Labels suppressed until live data.
              </div>
            )}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <div style={{ minWidth: 210 }}>
                <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>Memory vs Foundry</div>
                {d.regime?.split?.stale
                  ? <div style={{ fontSize: 13, fontWeight: 700, color: C.amber }}>stale — market open, awaiting live data</div>
                  : <>
                      <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{d.regime?.split?.label ?? "—"}</div>
                      <div style={{ fontSize: 12, color: C.muted }}>foundry {pbFmtPct(d.regime?.split?.fnd)} · memory {pbFmtPct(d.regime?.split?.mem)}</div>
                    </>}
              </div>
              {/* AI axis renders only once the payload carries it (older cached shapes omit it) */}
              {d.regime?.aiAxis && (
                <div style={{ minWidth: 240 }}>
                  <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>AI-levered vs non-AI</div>
                  {d.regime.aiAxis.stale
                    ? <div style={{ fontSize: 13, fontWeight: 700, color: C.amber }}>stale — market open, awaiting live data</div>
                    : <>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{d.regime.aiAxis.label ?? "—"}</div>
                        <div style={{ fontSize: 12, color: C.muted }}>AI {pbFmtPct(d.regime.aiAxis.ai)} · non-AI {pbFmtPct(d.regime.aiAxis.non)}</div>
                        <AxisBaskets ai={d.regime.aiAxis.aiBasket} non={d.regime.aiAxis.nonBasket} />
                      </>}
                </div>
              )}
              <div style={{ minWidth: 210 }}>
                <div style={{ fontSize: 12, color: C.muted, fontWeight: 700, marginBottom: 4 }}>Credit — global/OAS gate</div>
                <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                  <Pill label={(d.regime?.credit?.state ?? "unknown").toUpperCase()} color={pbCreditColor(d.regime?.credit?.state)} />
                  {d.regime?.credit?.word && (
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, color: d.regime.credit.dir === "rising" ? C.red : d.regime.credit.dir === "falling" ? C.green : C.muted }}>
                      · {d.regime.credit.word}
                    </span>
                  )}
                  {d.regime?.credit?.escalated && (
                    <span style={{ fontSize: 9, fontWeight: 800, color: C.amber, background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 4, padding: "1px 4px" }}>
                      ↑{d.regime.credit.runs} SESSIONS
                    </span>
                  )}
                </div>
                {/* The deltas that JUSTIFY the direction word (Stage 1A rule) */}
                <div style={{ fontSize: 11, color: C.mid, marginTop: 3 }}>
                  {d.regime?.credit?.d1
                    ? <>{fmtDelta(d.regime.credit.d1)} · {d.regime.credit.d5 ? fmtDelta(d.regime.credit.d5) : "5d n/a"}</>
                    : <span style={{ color: C.amber }}>no prior print — direction unavailable</span>}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{d.regime?.credit?.note ?? ""}</div>
              </div>
              <div style={{ minWidth: 170 }}>
                <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>Oil</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{d.regime?.oil?.label ?? "—"}</div>
              </div>
            </div>
            {/* Korea-local stress gate (Asia only) */}
            {d.regime?.korea && <div style={{ marginTop: 12 }}><KoreaStressPanel korea={d.regime.korea} /></div>}
          </Card>
          ))}

          {/* 5 — Rates: the Macro card (rates + regime inputs), directly under Credit. */}
          <Card>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <SLabel>🛢️ Macro</SLabel>
              <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>Global · US rates (same on every region)</span>
            </div>
            <MetricGrid min={180}>
              {/* P3.2 — oil carries an explicit TICK TIMESTAMP. Futures run the globex week
                  (Sun 18:00 → Fri 17:00 ET), so freshness is now scored against that, not NYSE
                  hours: a Friday settle served after Sunday's reopen reads STALE rather than
                  passing as a live tick. WTI and Brent both shown — the spread is itself a
                  read on waterborne supply stress. */}
              <MacroCell field={data.macro.wti}   value={data.macro.wti?.value != null ? "$" + data.macro.wti.value : "—"}     delta={data.macro.wti?.delta} deltaSuffix="" />
              <MacroCell field={data.macro.brent} value={data.macro.brent?.value != null ? "$" + data.macro.brent.value : "—"} delta={data.macro.brent?.delta} deltaSuffix="" />
              {(data.macro.wti?.value != null && data.macro.brent?.value != null) && (
                <MetricCard label="Brent − WTI"
                  title="waterborne vs landlocked crude — widens on shipping/supply stress"
                  value={"$" + (data.macro.brent.value - data.macro.wti.value).toFixed(2)}
                  sub={<span style={{ fontSize: 10.5, color: C.lbl, fontWeight: 700 }}>spread</span>} />
              )}
              <MacroCell field={data.macro.us2y}  value={data.macro.us2y?.value != null ? data.macro.us2y.value + "%" : "—"}   delta={data.macro.us2y?.deltaBps} deltaSuffix="bps" />
              <MacroCell field={data.macro.us10y} value={data.macro.us10y?.value != null ? data.macro.us10y.value + "%" : "—"} delta={data.macro.us10y?.deltaBps} deltaSuffix="bps" />
              <MacroCell field={data.macro.us30y} value={data.macro.us30y?.value != null ? data.macro.us30y.value + "%" : "—"} delta={data.macro.us30y?.deltaBps} deltaSuffix="bps" />
              {/* Section E — replaces the deleted auction card. The 30Y's 20d move is the
                  transmission channel that actually matters for duration, and it updates
                  daily rather than monthly. Highlighted beyond ±20bp. */}
              {(() => {
                const s30 = data.macro.us30y?.series;
                const t20 = s30 ? trendBps(s30, 20) : null;
                if (t20 == null) return null;
                const hot = Math.abs(t20) > 20;
                return (
                  <MetricCard label="30Y · 20d change"
                    title="long-end move over 20 sessions — the duration transmission channel"
                    value={`${t20 >= 0 ? "+" : "−"}${Math.abs(t20)}bp`}
                    valueColor={hot ? C.amber : C.text}
                    accent={hot ? C.aBdr : undefined}
                    sub={hot ? <span style={{ fontSize: 10.5, fontWeight: 800, color: C.amber }}>&gt;±20bp</span> : null} />
                );
              })()}
              {data.macro.fives30s != null && (
                <MetricCard label="5s30s slope"
                  title="long-end steepening is the funding-stress shape — distinct from a parallel hawkish shift"
                  value={`${data.macro.fives30s >= 0 ? "+" : ""}${data.macro.fives30s}bp`}
                  sub={data.macro.fives30sDeltaBps != null && (
                    <span style={{ fontSize: 11.5, fontWeight: 800, color: data.macro.fives30sDeltaBps > 0 ? C.amber : C.muted }}>
                      {data.macro.fives30sDeltaBps >= 0 ? "+" : "−"}{Math.abs(data.macro.fives30sDeltaBps)}bp 1D
                    </span>
                  )} />
              )}
              <MacroCell field={{ name: "2s10s", src: "DGS10−DGS2", date: data.macro.us10y?.date, cadence: "daily" }} value={data.macro.twos10s != null ? (data.macro.twos10s >= 0 ? "+" : "") + data.macro.twos10s + "bps" : "—"} delta={data.macro.twos10sDeltaBps} deltaSuffix="bps" />
              {/* DXY dedup'd — owned by the FX legs group in the Cross-asset card (a blend read
                  next to its EUR/JPY legs), so it is not repeated here. */}
              <MacroCell field={data.macro.oas}   value={data.macro.oas?.value ?? "—"} delta={data.macro.oas?.deltaBps} deltaSuffix="bps" />
            </MetricGrid>
            {data.macro.sanity && data.macro.sanity.length > 0 && (
              <div style={{ marginTop: 10, padding: "8px 12px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8, fontSize: 12, color: C.amber, fontWeight: 700 }}>
                ⚠ Sanity: {data.macro.sanity.join(" · ")}
              </div>
            )}
            {/* Regime inputs — gold/BTC co-movement + real yield/breakeven, drives the read below */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed " + C.bdr }}>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 800, textTransform: "uppercase", marginBottom: 8 }}>Regime Inputs</div>
              <MetricGrid min={180}>
                <MacroCell field={data.macro.gold} value={data.macro.gold?.value != null ? "$" + withCommas(data.macro.gold.value) : "—"} delta={data.macro.gold?.delta} deltaSuffix="" />
                <MacroCell field={data.macro.btc} value={data.macro.btc?.value != null ? "$" + Math.round(data.macro.btc.value).toLocaleString("en-US") : "—"} delta={data.macro.btc?.delta != null ? Math.round(data.macro.btc.delta) : null} deltaSuffix="" />
                <MacroCell field={data.macro.realYield} value={data.macro.realYield?.value != null ? data.macro.realYield.value + "%" : "—"} delta={data.macro.realYield?.deltaBps} deltaSuffix="bps" />
                <MacroCell field={data.macro.breakeven} value={data.macro.breakeven?.value != null ? data.macro.breakeven.value + "%" : "—"} delta={data.macro.breakeven?.deltaBps} deltaSuffix="bps" />
                {/* 5y5y fwd BE relocated here from the dropped cross-asset regime group — this is
                    its only home. Sits with the other breakeven/inflation inputs. MOVE/OVX are
                    dedup'd out (owned by the Vol/credit group in the Cross-asset card). */}
                <MacroCell field={data.macro.fwdBreakeven} value={data.macro.fwdBreakeven?.value != null ? data.macro.fwdBreakeven.value + "%" : "—"} delta={data.macro.fwdBreakeven?.deltaBps} deltaSuffix="bps" />
              </MetricGrid>
              {data.macro.regimeSignal && (() => {
                const rs = data.macro.regimeSignal;
                const w = rs.windows || {};
                const arr = d => d === "up" ? "▲" : d === "down" ? "▼" : d === "flat" ? "→" : "·";
                const col = d => d === "up" ? C.green : d === "down" ? C.red : C.muted;
                const maCol = m => m === "below both" ? C.red : m === "above both" ? C.green : C.amber;
                const win = o => !o ? "—" : (
                  <>
                    1d <span style={{ color: col(o.d1), fontWeight: 800 }}>{arr(o.d1)}</span> · 5d <span style={{ color: col(o.d5), fontWeight: 800 }}>{arr(o.d5)}</span> · 20d <span style={{ color: col(o.d20), fontWeight: 800 }}>{arr(o.d20)}</span>
                    {o.ma ? <span style={{ color: maCol(o.ma), fontWeight: 700 }}> · {o.ma}</span> : null}
                    {o.offHi != null ? <span style={{ color: C.muted }}> · {o.offHi > 0 ? "+" : ""}{o.offHi}% off hi</span> : null}
                  </>
                );
                const unconfirmed = /UNCONFIRMED|AMBIGUOUS|not debasement/i.test(rs.label || "");
                const mismatch = rs.mismatch;
                return (
                  <div style={{ marginTop: 10, padding: "10px 12px", background: C.bg, border: "1.5px solid " + (mismatch ? C.rBdr : unconfirmed ? C.aBdr : C.bdrMd), borderRadius: 8 }}>
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Debasement / stagflation read (gold+BTC)</div>
                    {/* P0.1 — scope label. */}
                    <div style={{ fontSize: 11, fontWeight: 800, color: C.blue, letterSpacing: 0.3, marginTop: 1 }}>cross-asset · 5d smoothed</div>
                    {/* A label that contradicts the deltas shown beneath it is suppressed — the
                        mismatch is reported instead, never a confident-but-inconsistent read. */}
                    {mismatch ? (
                      <>
                        <div style={{ fontSize: 12.5, fontWeight: 800, color: C.red, marginTop: 2 }}>{mismatch}</div>
                        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>suppressed label: <s>{rs.label}</s></div>
                      </>
                    ) : (
                      <div style={{ fontSize: 15, fontWeight: 900, color: unconfirmed ? C.amber : C.text }}>{rs.label}</div>
                    )}
                    {!mismatch && rs.windowSplit && (
                      <div style={{ fontSize: 10.5, color: C.amber, fontWeight: 700, marginTop: 2 }}>⚖ {rs.windowSplit}</div>
                    )}
                    <div style={{ fontSize: 11, color: C.mid, marginTop: 4 }}>gold — {win(w.gold)}</div>
                    <div style={{ fontSize: 11, color: C.mid, marginTop: 2 }}>btc &nbsp;— {win(w.btc)}</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                      DXY {rs.inputs?.dxy ?? "—"} · real-yield {rs.inputs?.realYield ?? "—"} · OAS {rs.inputs?.oas ?? "—"}
                    </div>
                  </div>
                );
              })()}
            </div>
          </Card>

          {/* Korea manual entry (KOFIA paste + 7709 units) — shown when Asia is active */}
          {regions.includes("asia") && byRegion.asia?.kofia &&
            <KoreaManualEntry kofia={byRegion.asia.kofia} onSaved={onRefresh} />}

          {/* Southbound Stock Connect (SMIC mainland flow) — same class as the Korea flow panel,
              shown alongside it when Asia is active. Self-fetches its own manual store. */}
          {regions.includes("asia") && <SouthboundPanel />}

          {/* Tape regime + breadth ladder (everything-else): today's cross-asset price action. */}
          {data.marketRegime && data.marketRegime.state !== "INSUFFICIENT_DATA" && (
            <Card>{/* I.2 — regime state is not a status token; no badge, no bar. */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <SLabel>🎛️ Tape regime</SLabel>
                <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>cross-asset, today's price action</span>
              </div>
              <div style={{ fontSize: 17, fontWeight: 900, color: data.marketRegime.color }}>{data.marketRegime.label}</div>
              {/* P0.1 — scope label: this and the structural Stagflation read measure different things. */}
              <div style={{ fontSize: 11, fontWeight: 800, color: C.blue, letterSpacing: 0.3, marginTop: 1 }}>today's tape · one session</div>
              <div style={{ fontSize: 12, fontWeight: 800, color: C.mid, marginTop: 2 }}>{data.marketRegime.discriminator}</div>
              {data.marketRegime.reasons?.map((s, i) => (
                <div key={i} style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.5 }}>· {s}</div>
              ))}
              {data.marketRegime.corroboration && !data.marketRegime.corroboration.available && (
                <div style={{ fontSize: 11, color: C.amber, fontWeight: 700, marginTop: 4 }}>{data.marketRegime.corroboration.note}</div>
              )}
              {/* F2 — the gold pair, stated explicitly. Gold alone is ambiguous and has been
                  read both ways in a week; the breakeven leg is what disambiguates it. */}
              {data.marketRegime.goldPair && (
                <div style={{ marginTop: 6, padding: "7px 10px", borderRadius: 6,
                  background: data.marketRegime.goldPair.available ? C.bg : C.aBg,
                  border: "1px solid " + (data.marketRegime.goldPair.available ? C.bdr : C.aBdr),
                  fontSize: 11.5, lineHeight: 1.55,
                  color: data.marketRegime.goldPair.available ? C.muted : C.amber,
                  fontWeight: data.marketRegime.goldPair.available ? 400 : 700 }}>
                  <b>Gold pair · {data.marketRegime.goldPair.reading.replace(/_/g, " ")}</b> — {data.marketRegime.goldPair.note}
                </div>
              )}
            </Card>
          )}

          {/* Concentration ladder (P5) — fixed order, widest beta to narrowest. */}
          {data.ladder && data.ladder.spread != null && (
            <Card>{/* I.2 — alert flag is not a status badge; no bar. */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <SLabel>🪜 Breadth ladder</SLabel>
                <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>SMH → QQQ → SPY → IWM → HYG</span>
                <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 900, color: data.ladder.alert ? C.amber : C.mid }}>
                  spread {data.ladder.spread}pp
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 4 }}>
                {data.ladder.rungs.map(r => (
                  <span key={r.sym} style={{ fontSize: 12.5, fontWeight: 700 }}>
                    <span style={{ color: C.muted }}>{r.sym}</span>{" "}
                    <span style={{ color: r.pct == null ? C.lbl : pbPctColor(r.pct) }}>
                      {r.pct == null ? "—" : `${r.pct >= 0 ? "+" : ""}${r.pct}%`}
                    </span>
                  </span>
                ))}
              </div>
              <div style={{ fontSize: 11.5, color: data.ladder.alert ? C.amber : C.muted, fontWeight: data.ladder.alert ? 700 : 400, marginTop: 4 }}>
                {data.ladder.alert ? "⚠ " : ""}{data.ladder.note}
              </div>
              {/* D3 — SMH − SOXX: which KIND of semi leadership (mega-cap-only vs broadening). */}
              {data.smhSoxx?.available && (() => {
                const t = data.smhSoxx;
                const col = t.tone === "amber" ? C.amber : t.tone === "green" ? C.green : C.muted;
                return (
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid " + C.bdr }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>SMH − SOXX</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: C.mid }}>
                        SMH {t.smhPct >= 0 ? "+" : ""}{t.smhPct}% · SOXX {t.soxxPct >= 0 ? "+" : ""}{t.soxxPct}%
                      </span>
                      <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 900, color: col }}>
                        {t.spread >= 0 ? "+" : ""}{t.spread}pp · {t.reading}
                      </span>
                    </div>
                    <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 3, lineHeight: 1.45 }}>⚠ {t.note}</div>
                  </div>
                );
              })()}
            </Card>
          )}

          {/* Book-specific tell cards (everything-else): event positioning + the Asia-only
              handoff / correlation / FX overlay. Moved out of the top synthesis cluster. */}
          {data.events && <EventPositioning e={data.events} />}
          {/* Part B — the three-leg handoff chain, computed client-side from all fetched regions'
              index aggregates (Asia/Europe/US each have their own indices in the payload). Sits above
              the detailed US → Asia gap card, which stays for the drivers/gap read on the active leg. */}
          {(() => {
            const aggOf = (region, exclude = []) => {
              const idx = byRegion?.[region]?.indices || [];
              const vals = idx.filter(q => !exclude.includes(q.sym) && Number.isFinite(q.changePct)).map(q => q.changePct);
              return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
            };
            const chain = handoffChain({ asiaPct: aggOf("asia"), europePct: aggOf("eu"), usPct: aggOf("us", ["^VIX"]) });
            return chain.available ? <HandoffChain chain={chain} /> : null;
          })()}
          {data.handoff && <CrossMarketHandoff h={data.handoff} />}
          {data.correlation && <CorrelationCollapse c={data.correlation} />}
          {data.fxPnl && <FxOverlay f={data.fxPnl} />}

          {/* Names grid — one flat grid across active regions; sorted category → region →
              %chg with ★ leaders pinned per category. Geo badge shown in All view. */}
          <Card>
            <SLabel>Names {multi ? "· all regions, grouped by category" : ""}</SLabel>
            <MetricGrid min={196}>
              {allNames.map(n => {
                const s = pbSession(n.freshness, n.session);
                return (
                <MetricCard
                  key={n._region + "|" + n.sym}
                  accent={s.bad ? C.aBdr : n.leader ? C.blBdr : undefined}
                  title={n.freshness ? freshnessText(n.freshness) || "live" : ""}
                  label={<span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{n.leader ? "★ " : ""}{n.name}</span>}
                  labelRight={<>
                    {multi ? <span style={{ fontSize: 9, fontWeight: 800, color: C.blue, background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 4, padding: "1px 4px" }}>{pbGeo(n.sym)}</span> : null}
                    <span style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: "uppercase" }}>{PB_ROLE_LABEL[n.role] || n.role}</span>
                  </>}
                  badge={<StateChip label={s.label} color={s.color} filled={s.bad} />}
                  value={n.price != null ? withCommas(n.price) : "—"}
                  valueColor={s.bad ? C.amber : C.text}
                  strike={s.bad}
                  sub={(() => { const g = pbPctGuard(n); return g.ok
                    ? <span style={{ fontSize: 13, fontWeight: 800, color: s.bad ? C.muted : pbPctColor(g.pct) }}>
                        {pbFmtPct(g.pct)}<span style={{ fontSize: 9, color: C.lbl, fontWeight: 700 }} title="daily change vs the prior session close"> 1D</span>
                      </span>
                    : <span style={{ fontSize: 10.5, fontWeight: 800, color: C.red }} title={"last " + n.price + " vs prior close " + n.prevClose + " — sign disagrees with the reported %"}>{g.note}</span>; })()}
                >
                  <div style={{ fontSize: 11, color: C.muted }}>{n.structure || ""}</div>
                  {n.ext && n.ext.price != null && (
                    <div style={{ fontSize: 11.5, fontWeight: 800, marginTop: 2, color: pbPctColor(n.ext.changePct) }}
                      title={"extended-hours (" + (n.ext.session === "pre" ? "pre-market" : "after-hours") + ") vs regular close"}>
                      {n.ext.session === "pre" ? "PM" : "AH"} {withCommas(n.ext.price)} {pbFmtPct(n.ext.changePct)}
                    </div>
                  )}
                </MetricCard>
                );
              })}
            </MetricGrid>
          </Card>

          {/* Indices — grouped by region */}
          <Card>
            <SLabel>Indices</SLabel>
            {active.map(d => (
            <div key={d.region} style={{ marginBottom: multi ? 14 : 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                {multi ? <span style={{ fontSize: 11, color: C.muted, fontWeight: 800, textTransform: "uppercase" }}>{d.label}</span> : null}
                <RegionSessionBadge session={d.session} tz={d.tz} />
              </div>
              <MetricGrid min={190}>
              {d.indices.map(ix => {
                const s = pbSession(ix.freshness, ix.session);
                return (
                <MetricCard
                  key={ix.sym}
                  label={ix.name}
                  accent={s.bad ? C.aBdr : undefined}
                  title={ix.freshness ? freshnessText(ix.freshness) || "live" : ""}
                  value={ix.price != null ? withCommas(ix.price) : "—"}
                  valueColor={s.bad ? C.amber : C.text}
                  strike={s.bad}
                  sub={(() => { const g = pbPctGuard(ix); return g.ok
                    ? <span style={{ fontSize: 13, fontWeight: 800, color: s.bad ? C.muted : pbPctColor(g.pct) }}>
                        {pbFmtPct(g.pct)}<span style={{ fontSize: 9, color: C.lbl, fontWeight: 700 }} title="daily change vs the prior session close"> 1D</span>
                      </span>
                    : <span style={{ fontSize: 10.5, fontWeight: 800, color: C.red }} title={"last " + ix.price + " vs prior close " + ix.prevClose + " — sign disagrees with the reported %"}>{g.note}</span>; })()}
                >
                  <div style={{ marginTop: 3 }}><StateChip label={s.label} color={s.color} filled={s.bad} /></div>
                </MetricCard>
                );
              })}
              </MetricGrid>
            </div>
            ))}
          </Card>

          {/* Cross-asset coverage — the daily set, grouped by what each group answers.
              Every row: value + 1D delta + direction (no direction without a prior close). */}
          {data.cross && (
            <Card>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <SLabel>🧮 Cross-asset</SLabel>
                <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>value · 1D delta · direction</span>
              </div>
              {/* P4 — DXY reliability. Surfaced above the legs because the index is only
                  trustworthy when EUR and JPY point the same way. */}
              {data.fx?.available && (
                <div style={{ marginBottom: 8, padding: "7px 10px", background: data.fx.diverging ? C.aBg : C.bg,
                  border: "1px solid " + (data.fx.diverging ? C.aBdr : C.bdr), borderRadius: 6,
                  fontSize: 11.5, fontWeight: data.fx.diverging ? 700 : 400, color: data.fx.diverging ? C.amber : C.muted, lineHeight: 1.55 }}>
                  {data.fx.note}
                </div>
              )}
              {/* F3 — intervention artefact. Manual flag: no keyless feed reports intervention
                  in real time, so an inferred flag would be manufacturing certainty. */}
              {/* The just-saved flag wins over the deployed bundle: assemble.js reads the
                  store at build time, so without this the annotation would not appear until
                  the commit-back triggers a redeploy. */}
              {(liveIntervention ? liveIntervention.active : data.intervention?.active) && (
                <div style={{ marginBottom: 8, padding: "7px 10px", background: C.aBg,
                  border: "1px solid " + C.aBdr, borderRadius: 6,
                  fontSize: 11.5, fontWeight: 700, color: C.amber, lineHeight: 1.55 }}>
                  {(liveIntervention?.active
                    ? interventionAnnotation({
                        ...liveIntervention,
                        jpyChangePct: data.cross?.fx?.rows?.find(r => r.sym === 'JPY=X')?.changePct ?? null,
                        dxyChangePct: data.cross?.fx?.rows?.find(r => r.sym === 'DX-Y.NYB')?.changePct ?? null,
                      }).annotation
                    : data.intervention?.annotation)}
                </div>
              )}
              {/* F4 — USD/KRW attribution. Gate 2's reading depends on WHY the won moved, and
                  the dollar/yen legs are what separate a macro move from a Korea-specific one. */}
              {data.won?.note && (
                <div style={{ marginBottom: 8, padding: "7px 10px",
                  background: data.won.gate2 === "suspect" ? C.aBg : C.bg,
                  border: "1px solid " + (data.won.gate2 === "suspect" ? C.aBdr : C.bdr), borderRadius: 6,
                  fontSize: 11.5, fontWeight: data.won.gate2 === "suspect" ? 700 : 400,
                  color: data.won.gate2 === "suspect" ? C.amber : C.muted, lineHeight: 1.55 }}>
                  <b>Gate 2 · {String(data.won.gate2).toUpperCase()}</b> — {data.won.note}
                </div>
              )}
              {/* Dedup (Part C): the 'regime' group is dropped here — every metric it carried
                  (gold, BTC, 10Y BE, 10Y real, 2s10s, DXY) is rendered once in its owning
                  section (Regime Inputs / Macro rates / FX legs). Its 5y5y fwd BE — the only
                  metric with no other home — moved into Regime Inputs. cross.regime still backs
                  the composed READ; only the duplicate tiles are gone. */}
              {["rates", "cyclical", "volCredit", "fx"].map(g => {
                const grp = data.cross[g];
                if (!grp?.rows?.length) return null;
                return (
                  <div key={g} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10.5, color: C.muted, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>{grp.label}</div>
                    <MetricGrid min={175}>
                      {grp.rows.map(r => <CrossRow key={r.sym} r={r} />)}
                    </MetricGrid>
                  </div>
                );
              })}
              {/* P2 — the master credit gauge (OAS) publishes with a one-day lag, so it is
                  shown WITH its as-of date beside a live proxy that is explicitly not OAS.
                  The HYG-minus-QQQ spread is the actionable part: credit refusing to confirm
                  an equity move is the case a single HYG print cannot surface. */}
            </Card>
          )}

          {/* Macro (rates + regime inputs) relocated up to #5, directly under Credit. */}

          {/* This week's flagged events */}
          {data.calendar && data.calendar.length > 0 && (
            <Card>
              <SLabel>📅 Calendar — Current / Upcoming</SLabel>
              {data.calendar.map((e, i) => {
                // C6 — countdown chip so imminence is legible, and adjacent same-window catalysts read
                // as the collision they are (e.g. NVDA Aug 26 → Jackson Hole Aug 27–29).
                const days = Math.round((new Date(e.date + "T00:00:00Z") - new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z")) / 864e5);
                const cd = e.reported ? null : days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`;
                const soon = !e.reported && days >= 0 && days <= 2;
                return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: 13, color: e.reported ? C.lbl : C.mid, opacity: e.reported ? 0.72 : 1, borderBottom: i < data.calendar.length - 1 ? "1px solid " + C.bdr : "none" }}>
                  <span style={{ color: C.muted, minWidth: 92 }}>{e.date}</span>
                  <span style={{ fontWeight: 600, textDecoration: e.reported ? "line-through" : "none" }}>{e.title}</span>
                  {e.reported && <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: C.lbl, border: "1px solid " + C.bdr, borderRadius: 4, padding: "1px 4px" }}>reported</span>}
                  {cd && <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: soon ? C.amber : C.lbl, background: soon ? C.aBg : "transparent", border: "1px solid " + (soon ? C.aBdr : C.bdr), borderRadius: 4, padding: "1px 5px" }}>{cd}</span>}
                  <span style={{ color: C.lbl, marginLeft: "auto" }}>{e.region}</span>
                </div>
                );
              })}
            </Card>
          )}

          <div style={{ fontSize: 11, color: C.lbl, textAlign: "center" }}>
            Same data spine as the Discord pre-reads · {regions.length === 3 ? "All regions" : regions.map(r => r.toUpperCase()).join(" · ")}
          </div>
        </>
      )}
    </div>
  );
}

// ─── ANALYST VIEW BOARD ──────────────────────────────────────────────────────
// Replaces the weighted-average headline. The section's job is to say what the professionals
// think — about a recession AND about the upcoming regime — and whether the live signals still
// agree with them. A scalar consensus could answer none of that, so each house is rendered as a
// thesis with its stated conditions checked against live data (lib/analystViews.js). The numeric
// consensus survives underneath as a labelled byproduct, because the regime engine needs a number.
function AnalystViewBoard({ live, probFor, engineRegime, consensus }) {
  const evaluated = useMemo(() => evaluateViews(buildViews(live)), [live]);
  const liveViews = evaluated.filter(v => !v.archived);
  const brokenViews = evaluated.filter(v => v.archived);
  const cluster = useMemo(() => regimeCluster(evaluated), [evaluated]);
  const regimeLabel = (id) => REGIMES.find(r => r.id === id)?.label || id;
  const regimeColor = (id) => REGIMES.find(r => r.id === id)?.color || C.mid;

  const divergence = divergenceRead({
    cluster, engineRegime,
    marketProb: consensus?.calendar?.value ?? null,
    analystProb: consensus?.rolling?.value ?? null,
  });

  const toneCol = (t) => t === "green" ? C.green : t === "amber" ? C.amber : t === "red" ? C.red : C.muted;
  const toneBg  = (t) => t === "green" ? C.gBg : t === "amber" ? C.aBg : t === "red" ? C.rBg : C.bg;
  const toneBdr = (t) => t === "green" ? C.gBdr : t === "amber" ? C.aBdr : t === "red" ? C.rBdr : C.bdr;

  const ViewCard = ({ v, dim }) => {
    const prob = probFor(v.key);
    return (
      <div style={{ flex: "1 1 320px", background: dim ? C.bg : C.surf, border: "1.5px solid " + toneBdr(v.tone), borderLeft: "4px solid " + toneCol(v.tone), borderRadius: 10, padding: "11px 13px", opacity: dim ? 0.72 : 1 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <b style={{ fontSize: 14, color: C.text }}>{v.house}</b>
          {prob != null && <span style={{ fontSize: 15, fontWeight: 900, color: C.text }}>{prob}%</span>}
          <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, color: toneCol(v.tone), background: toneBg(v.tone), border: "1px solid " + toneBdr(v.tone), borderRadius: 5, padding: "1px 7px" }}>
            {v.verdict} {v.total ? `${v.met}/${v.total}` : ""}
          </span>
        </div>
        <div style={{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: C.lbl, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3 }}>implies</span>
          <span style={{ fontSize: 11.5, fontWeight: 800, color: regimeColor(v.impliedRegime) }}>{regimeLabel(v.impliedRegime)}</span>
          <span style={{ fontSize: 10, color: C.lbl }}>· {v.kind}</span>
        </div>
        <div style={{ marginTop: 5, fontSize: 12.5, color: C.mid, fontStyle: "italic", lineHeight: 1.5 }}>“{v.call}”</div>
        <div style={{ marginTop: 7, display: "flex", flexDirection: "column", gap: 3 }}>
          {v.conditions.map((c, i) => (
            <div key={i} style={{ fontSize: 12, color: C.mid, lineHeight: 1.5, display: "flex", gap: 6 }} title={c.why || undefined}>
              <span style={{ color: c.met === null ? C.muted : c.met ? C.green : C.red, fontWeight: 800, flexShrink: 0 }}>
                {c.met === null ? "?" : c.met ? "✓" : "✗"}
              </span>
              <span>
                {c.label}
                {c.critical && <span style={{ color: C.amber, fontWeight: 800 }} title="the house's own flagged invalidator"> ⚑</span>}
                <span style={{ color: C.lbl }}> — {c.display}</span>
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 7, paddingTop: 6, borderTop: "1px solid " + C.bdr, fontSize: 11.5, color: toneCol(v.tone), fontWeight: 600, lineHeight: 1.5 }}>
          → {v.note}
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginBottom: 14 }}>
      {/* The read — where the professionals cluster, and where they disagree with the engine. */}
      <div style={{ background: C.blBg, border: "1.5px solid " + C.blBdr, borderRadius: 10, padding: "11px 14px", marginBottom: 10 }}>
        <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: C.blue, marginBottom: 5 }}>
          What the professionals think
        </div>
        <div style={{ display: "flex", gap: "5px 14px", flexWrap: "wrap", alignItems: "baseline", fontSize: 13 }}>
          <span style={{ color: C.lbl, fontWeight: 700 }}>Live theses cluster on</span>
          <b style={{ color: cluster.top ? regimeColor(cluster.top) : C.muted, fontSize: 14 }}>
            {cluster.top ? regimeLabel(cluster.top) : "—"}
          </b>
          {cluster.ranked.length > 1 && (
            <span style={{ color: C.muted, fontSize: 12 }}>
              ({cluster.ranked.map(([r, n]) => `${regimeLabel(r)} ${n}`).join(" · ")})
            </span>
          )}
          <span style={{ color: C.bdr }}>·</span>
          <span style={{ color: C.lbl, fontWeight: 700 }}>your engine</span>
          <b style={{ color: regimeColor(engineRegime) }}>{regimeLabel(engineRegime)}</b>
        </div>
        {divergence && (
          <div style={{ marginTop: 7, fontSize: 12.5, color: C.mid, lineHeight: 1.6 }}>{divergence}</div>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {liveViews.map(v => <ViewCard key={v.key} v={v} />)}
      </div>

      {brokenViews.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 700, color: C.muted, padding: "6px 0" }}>
            🪦 {brokenViews.length} thesis{brokenViews.length === 1 ? "" : "es"} that broke — and the signal that broke {brokenViews.length === 1 ? "it" : "them"}
          </summary>
          <div style={{ fontSize: 11.5, color: C.lbl, lineHeight: 1.6, margin: "4px 0 8px" }}>
            These are excluded from every consensus. Each was explicitly conditional, and the condition is now testably false —
            which is why they are retired on <i>evidence</i> rather than merely aged out.
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {brokenViews.map(v => <ViewCard key={v.key} v={v} dim />)}
          </div>
        </details>
      )}
    </div>
  );
}

// ─── TRADE CONSOLE (Tier 3) ─────────────────────────────────────────────────
// The regime-aware trade console: a watchlist of the instruments YOU trade, each with your
// levels, auto R:R and regime-scaled sizing, tagged with how it sits vs the live regime and the
// insurance book, plus a journal that stamps the regime at entry. No execution, no fabricated
// data — prices come from /api/prices, levels are hand-entered, sizing is arithmetic (lib/console.js).

// Insurance-book tickers, for the "insurance overlap" tag (ASSETS is the insurance universe).
const INSURANCE_TICKERS = (() => {
  const m = {};
  for (const a of ASSETS) for (const t of (a.tickers || [])) if (t?.t) m[t.t.toUpperCase()] = a.name;
  return m;
})();
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// How a symbol sits vs the live regime: its tickers appear in the regime's best/worst asset lists.
function regimeFitFor(sym, regime) {
  if (!sym || !regime) return { fit: "neutral", where: null };
  const re = new RegExp(`\\b${reEsc(sym.toUpperCase())}\\b`, "i");
  const hitBest = (regime.best || []).find(x => re.test(x));
  if (hitBest) return { fit: "tailwind", where: hitBest };
  const hitWorst = (regime.worst || []).find(x => re.test(x));
  if (hitWorst) return { fit: "headwind", where: hitWorst };
  return { fit: "neutral", where: null };
}

function TradeConsole({ liveRegime, regimeProbFor, liveInd, creditDanger, contested, regimeDiverged, prices, fetchPrices, pricesLoading }) {
  const LS = "dvcap_console_v1";
  const [wl, setWl]             = useState([]);
  const [journal, setJournal]   = useState([]);
  const [settings, setSettings] = useState({ equity: null, baseRiskPct: DEFAULT_BASE_RISK_PCT, alertsEnabled: false, sizing: {} });
  const [loaded, setLoaded]     = useState(false);
  const [dirty, setDirty]       = useState(false);
  const [saving, setSaving]     = useState(false);
  const [saveMsg, setSaveMsg]   = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [addSym, setAddSym]     = useState("");
  const [jForm, setJForm]       = useState(null);   // open journal form (prefilled from a row or blank)
  const notifiedRef = useMemo(() => ({ current: new Set() }), []);   // dedupe browser notifications

  // Load: localStorage for instant paint, then the server store (authoritative if present).
  useEffect(() => {
    try {
      const c = JSON.parse(localStorage.getItem(LS) || "null");
      if (c) { setWl(c.watchlist || []); setJournal(c.journal || []); setSettings(s => ({ ...s, ...(c.settings || {}) })); }
    } catch { /* no cache */ }
    fetch("/api/manual-entry").then(r => r.json()).then(j => {
      const c = j?.console;
      if (c && typeof c === "object") {
        if (Array.isArray(c.watchlist)) setWl(c.watchlist);
        if (Array.isArray(c.journal))   setJournal(c.journal);
        if (c.settings) setSettings(s => ({ ...s, ...c.settings }));
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  // Mirror every change to localStorage (per-device durability, instant).
  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(LS, JSON.stringify({ watchlist: wl, journal, settings })); } catch { /* quota */ }
  }, [wl, journal, settings, loaded]);

  // Live quotes for the watchlist symbols.
  const wlSymbols = useMemo(() => [...new Set(wl.map(w => w.symbol).filter(Boolean))], [wl]);
  const wlSymKey = wlSymbols.join(",");
  useEffect(() => { if (wlSymbols.length) fetchPrices(wlSymbols); }, [wlSymKey]);   // eslint-disable-line

  // Sizing table = defaults overlaid with the user's per-regime multiplier overrides.
  const mergedSizing = useMemo(() => {
    const out = {};
    for (const k of Object.keys(REGIME_SIZING)) {
      const ov = settings?.sizing?.[k];
      out[k] = ov != null ? { ...REGIME_SIZING[k], mult: +ov } : REGIME_SIZING[k];
    }
    return out;
  }, [settings?.sizing]);
  const regimeCtx = { regimeId: liveRegime?.id, creditDanger, contested, pinnedDiverged: regimeDiverged, sizing: mergedSizing };
  const rm = regimeMultiplier(regimeCtx);
  // Inputs are kept as raw strings while typing (so decimals aren't mangled by number coercion);
  // coerce to numbers only where the math needs them.
  const numOrNull = (v) => (v == null || v === "" || !Number.isFinite(+v)) ? null : +v;
  const equityNum = numOrNull(settings.equity);
  const baseRiskNum = numOrNull(settings.baseRiskPct) ?? DEFAULT_BASE_RISK_PCT;

  // Mutations (each marks dirty so the cloud-save button lights up).
  const touch = () => setDirty(true);
  const addSymbol = () => {
    const sym = addSym.trim().toUpperCase();
    if (!sym) return;
    const id = `${sym}-${Math.random().toString(36).slice(2, 8)}`;
    setWl(prev => [...prev, { id, symbol: sym, side: null, entry: null, stop: null, targets: [], riskPct: null, status: "idea", note: "", addedAt: new Date().toISOString() }]);
    setAddSym(""); setExpanded(id); touch();
  };
  const updateItem = (id, patch) => { setWl(prev => prev.map(w => w.id === id ? { ...w, ...patch } : w)); touch(); };
  const removeItem = (id) => { setWl(prev => prev.filter(w => w.id !== id)); touch(); };

  const saveCloud = async () => {
    setSaving(true); setSaveMsg(null);
    try {
      const r = await fetch("/api/manual-entry", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ console: { watchlist: wl, journal, settings } }),
      });
      if (r.ok) { setDirty(false); setSaveMsg("Saved to cloud ✓"); }
      else if (r.status === 401) setSaveMsg("Log in to the dashboard to sync to cloud (saved locally).");
      else setSaveMsg(`Cloud save failed (${r.status}) — kept locally.`);
    } catch (e) { setSaveMsg("Cloud save failed — kept locally."); }
    setSaving(false);
    setTimeout(() => setSaveMsg(null), 6000);
  };

  // Journal helpers.
  const openJournalFor = (w) => setJForm({
    id: null, symbol: w?.symbol || "", side: w?.side || (w?.entry != null && w?.stop != null ? tradeSide(w.entry, w.stop) : null),
    thesis: w?.note || "", entryPrice: w?.entry ?? "", exitPrice: "", stop: w?.stop ?? "", shares: "", dateIn: new Date().toISOString().slice(0, 10), dateOut: "", notes: "",
  });
  const saveJournal = () => {
    const f = jForm; if (!f || !f.symbol) return;
    const e = +f.entryPrice, x = +f.exitPrice, s = +f.stop;
    const side = f.side || tradeSide(e, s);
    let realizedR = null;
    if (Number.isFinite(e) && Number.isFinite(x) && Number.isFinite(s) && Math.abs(e - s) > 0) {
      realizedR = +(((side === "short" ? (e - x) : (x - e)) / Math.abs(e - s))).toFixed(2);
    }
    const row = {
      id: `${f.symbol.toUpperCase()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: f.symbol.toUpperCase(), side: side || null, thesis: f.thesis || null,
      entryPrice: Number.isFinite(e) ? e : null, exitPrice: Number.isFinite(x) ? x : null,
      shares: Number.isFinite(+f.shares) ? +f.shares : null, realizedR,
      regimeAtEntry: liveRegime ? `${liveRegime.label} ${regimeProbFor(liveRegime.id)}%` : null,
      dateIn: f.dateIn || null, dateOut: f.dateOut || null, notes: f.notes || null,
    };
    setJournal(prev => [row, ...prev]); setJForm(null); touch();
  };
  const removeJournal = (id) => { setJournal(prev => prev.filter(j => j.id !== id)); touch(); };

  // Poll-cadence level alerts: which rows have hit a level at the current price.
  const triggered = useMemo(() => {
    const out = [];
    for (const w of wl) {
      const p = prices?.[w.symbol]?.price;
      if (p == null) continue;
      const hits = triggeredLevels({ price: p, entry: w.entry, stop: w.stop, targets: w.targets });
      if (hits.length) out.push({ w, price: p, hits });
    }
    return out;
  }, [wl, prices]);

  // Optional browser notification for newly-triggered levels (permission-gated, de-duped).
  useEffect(() => {
    if (!settings.alertsEnabled || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const t of triggered) for (const h of t.hits) {
      const key = `${t.w.id}:${h.level}:${h.price}`;
      if (notifiedRef.current.has(key)) continue;
      notifiedRef.current.add(key);
      try { new Notification(`${t.w.symbol} hit ${h.kind}`, { body: `${h.kind} @ ${h.price} · live ${t.price}` }); } catch { /* ignore */ }
    }
  }, [triggered, settings.alertsEnabled]);

  const enableAlerts = async () => {
    if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
      try { await Notification.requestPermission(); } catch { /* ignore */ }
    }
    setSettings(s => ({ ...s, alertsEnabled: !s.alertsEnabled })); touch();
  };

  // ── small presentational helpers ──
  const chip = (txt, col, bg, bd) => (
    <span style={{ background: bg, color: col, border: "1px solid " + bd, borderRadius: 6, padding: "1px 7px", fontSize: 11, fontWeight: 800, whiteSpace: "nowrap" }}>{txt}</span>
  );
  const fitChip = (fit) => fit === "tailwind" ? chip("regime tailwind", C.green, "#F0FDF4", "#BBF7D0")
    : fit === "headwind" ? chip("fights regime", C.red, "#FEF2F2", "#FECACA")
    : chip("regime-neutral", C.muted, C.bg, C.bdr);
  const numInput = (val, onChange, ph, w = 92) => (
    <input value={val ?? ""} onChange={e => onChange(e.target.value)} placeholder={ph} inputMode="decimal"
      style={{ width: w, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* purpose + regime context */}
      <div style={{ background: liveRegime?.bg || C.surf, border: "1.5px solid " + (liveRegime?.bdr || C.bdr), borderTop: "4px solid " + (liveRegime?.color || C.blue), borderRadius: 12, padding: "12px 16px" }}>
        <div style={{ fontSize: 13.5, color: C.mid, lineHeight: 1.5 }}>
          <b style={{ color: C.text }}>Your trade console.</b> A watchlist with your levels, regime-scaled sizing and a journal — read against the live regime.
          <span style={{ color: C.muted }}> Prices are from the same feed as the rest of the dashboard (poll-cadence, not streaming); nothing here places orders.</span>
        </div>
        <div style={{ marginTop: 8, display: "flex", gap: "6px 14px", flexWrap: "wrap", alignItems: "baseline", fontSize: 13 }}>
          <span style={{ color: C.lbl, fontWeight: 700 }}>Live regime:</span>
          <b style={{ color: liveRegime?.color }}>{liveRegime?.label} {regimeProbFor(liveRegime?.id)}%</b>
          <span style={{ color: C.bdr }}>·</span>
          <span style={{ color: C.lbl, fontWeight: 700 }}>size ×</span>
          <b style={{ color: C.text }}>{rm.mult.toFixed(2)}</b>
          <span style={{ color: C.muted, fontSize: 12 }}>({rm.reasons.length > 1 ? rm.reasons.slice(1).join("; ") : (mergedSizing[liveRegime?.id]?.note || liveRegime?.label || "base")})</span>
          {contested && chip("⚖ CONTESTED", C.amber, C.aBg || "#FFFBEB", C.aBdr || "#FDE68A")}
          {regimeDiverged && chip("📌 PINNED≠LIVE", C.amber, C.aBg || "#FFFBEB", C.aBdr || "#FDE68A")}
        </div>
      </div>

      {/* triggered-levels strip */}
      {triggered.length > 0 && (
        <div style={{ background: "#FFF7ED", border: "1.5px solid #FED7AA", borderRadius: 12, padding: "10px 14px" }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "#B45309", marginBottom: 6 }}>⚡ Levels hit (at last poll)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {triggered.map(t => t.hits.map(h => (
              <span key={t.w.id + h.level} style={{ background: C.surf, border: "1.5px solid #FED7AA", borderRadius: 8, padding: "3px 9px", fontSize: 12.5, fontWeight: 700, color: C.text }}>
                <b>{t.w.symbol}</b> {h.kind === "stop" ? "🛑 stop" : h.kind === "target" ? "🎯 " + h.level : "⊙ entry"} @ {h.price} · live {t.price}
              </span>
            )))}
          </div>
        </div>
      )}

      {/* settings */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          <SLabel>Console settings</SLabel>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {saveMsg && <span style={{ fontSize: 12, color: C.mid }}>{saveMsg}</span>}
            <Btn onClick={() => fetchPrices(wlSymbols)} disabled={pricesLoading || !wlSymbols.length} color={C.mid} bgColor={C.bg} label={pricesLoading ? "…" : "🔄 Prices"} />
            <Btn onClick={saveCloud} disabled={saving} color="#fff" bgColor={dirty ? C.blue : C.bdrMd} label={saving ? "Saving…" : dirty ? "☁ Save to cloud" : "☁ Synced"} />
          </div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end" }}>
          <label style={{ fontSize: 12, color: C.lbl, fontWeight: 700 }}>Account equity ($)<br />{numInput(settings.equity, v => { setSettings(s => ({ ...s, equity: v === "" ? null : v })); touch(); }, "e.g. 100000", 120)}</label>
          <label style={{ fontSize: 12, color: C.lbl, fontWeight: 700 }}>Base risk / trade (%)<br />{numInput(settings.baseRiskPct, v => { setSettings(s => ({ ...s, baseRiskPct: v === "" ? null : v })); touch(); }, "1.0", 80)}</label>
          <button onClick={enableAlerts} style={{ cursor: "pointer", background: settings.alertsEnabled ? C.green : C.surf, color: settings.alertsEnabled ? "#fff" : C.mid, border: "1.5px solid " + (settings.alertsEnabled ? C.green : C.bdr), borderRadius: 8, padding: "7px 12px", fontSize: 12.5, fontWeight: 800 }}>
            {settings.alertsEnabled ? "🔔 Alerts on" : "🔕 Alerts off"}
          </button>
        </div>
        {/* editable regime multipliers */}
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Regime sizing multipliers (× on base risk)</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {Object.keys(REGIME_SIZING).map(k => {
              const cur = settings?.sizing?.[k] ?? REGIME_SIZING[k].mult;
              const isLive = liveRegime?.id === k;
              return (
                <label key={k} style={{ fontSize: 12, color: isLive ? C.text : C.lbl, fontWeight: isLive ? 800 : 600, border: "1.5px solid " + (isLive ? (liveRegime?.color || C.blue) : C.bdr), borderRadius: 8, padding: "5px 9px", background: isLive ? (liveRegime?.bg || C.surf) : C.surf }}>
                  {REGIME_SIZING[k].label}{isLive ? " ● live" : ""}<br />
                  {numInput(cur, v => { setSettings(s => ({ ...s, sizing: { ...(s.sizing || {}), [k]: v === "" ? null : v } })); touch(); }, String(REGIME_SIZING[k].mult), 64)}
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>Credit-DANGER caps the multiplier at {CREDIT_DANGER_CAP_LABEL}; a contested or pinned≠live regime applies an extra ×0.7 haircut. Suggestions only — you size the trade.</div>
        </div>
      </Card>

      {/* add symbol */}
      <Card>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <SLabel>Watchlist</SLabel>
          <span style={{ color: C.muted, fontSize: 12 }}>{wl.length} instrument{wl.length === 1 ? "" : "s"}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <input value={addSym} onChange={e => setAddSym(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addSymbol(); }} placeholder="Add ticker (e.g. NVDA)"
              style={{ width: 170, padding: "6px 10px", border: "1.5px solid " + C.bdr, borderRadius: 8, fontSize: 13, background: C.surf, color: C.text, textTransform: "uppercase" }} />
            <Btn onClick={addSymbol} color="#fff" bgColor={C.blue} label="+ Add" />
          </div>
        </div>

        {wl.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 13, marginTop: 12, fontStyle: "italic" }}>No instruments yet. Add the tickers you actually trade — each row gets levels, R:R, regime-scaled sizing and a regime-fit read.</div>
        ) : (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {wl.map(w => {
              const q = prices?.[w.symbol];
              const price = q?.price ?? null;
              const chg = q?.changePercent ?? null;
              const fit = regimeFitFor(w.symbol, liveRegime);
              const ins = INSURANCE_TICKERS[w.symbol];
              const rr = rMultiple({ entry: w.entry, stop: w.stop, target: w.targets?.[0] });
              const dist = price != null ? distanceToLevels({ price, entry: w.entry, stop: w.stop, targets: w.targets }) : null;
              const open = expanded === w.id;
              const sug = suggestedSize({ equity: equityNum, baseRiskPct: baseRiskNum, regime: regimeCtx, entry: w.entry, stop: w.stop, sizing: mergedSizing });
              const own = w.riskPct != null && w.riskPct !== "" ? positionSize({ equity: equityNum, riskPct: w.riskPct, entry: w.entry, stop: w.stop }) : null;
              return (
                <div key={w.id} style={{ border: "1.5px solid " + C.bdr, borderRadius: 10, overflow: "hidden" }}>
                  {/* row header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", flexWrap: "wrap", background: open ? C.bg : C.surf, cursor: "pointer" }} onClick={() => setExpanded(open ? null : w.id)}>
                    <b style={{ fontSize: 15, color: C.text, minWidth: 62 }}>{w.symbol}</b>
                    <span style={{ fontSize: 14, color: C.text, fontWeight: 700, minWidth: 66 }}>{price != null ? price.toFixed(2) : "—"}</span>
                    <span style={{ fontSize: 12.5, fontWeight: 800, color: chg == null ? C.muted : chg >= 0 ? C.green : C.red, minWidth: 56 }}>{chg == null ? "" : (chg >= 0 ? "+" : "") + chg.toFixed(2) + "%"}</span>
                    {fitChip(fit.fit)}
                    {ins && chip("🛡 insurance: " + ins, "#B45309", "#FFFBEB", "#FDE68A")}
                    {rr.rr != null && chip(`R:R ${rr.rr}`, rr.rr >= 2 ? C.green : rr.rr >= 1 ? C.amber : C.red, C.bg, C.bdr)}
                    {chip(w.status, C.mid, C.bg, C.bdr)}
                    <span style={{ marginLeft: "auto", color: C.lbl, fontSize: 12 }}>{open ? "▲" : "▼ setup"}</span>
                  </div>

                  {/* expanded setup */}
                  {open && (
                    <div style={{ padding: "12px", borderTop: "1px solid " + C.bdr, background: C.surf }} onClick={e => e.stopPropagation()}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end" }}>
                        <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Entry<br />{numInput(w.entry, v => updateItem(w.id, { entry: v === "" ? null : v }), "")}</label>
                        <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Stop<br />{numInput(w.stop, v => updateItem(w.id, { stop: v === "" ? null : v }), "")}</label>
                        <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Targets (comma)<br />
                          <input defaultValue={(w.targets || []).join(", ")} onBlur={e => updateItem(w.id, { targets: e.target.value.split(",").map(x => +x.trim()).filter(x => Number.isFinite(x)).slice(0, 4) })} placeholder="e.g. 200, 220"
                            style={{ width: 130, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} />
                        </label>
                        <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Your risk %<br />{numInput(w.riskPct, v => updateItem(w.id, { riskPct: v === "" ? null : v }), String(baseRiskNum), 70)}</label>
                        <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Status<br />
                          <select value={w.status} onChange={e => updateItem(w.id, { status: e.target.value })} style={{ padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }}>
                            {["idea", "armed", "in-trade", "closed"].map(s => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </label>
                      </div>

                      {/* computed R:R + sizing */}
                      <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 10 }}>
                        <div style={{ flex: "1 1 240px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 9, padding: "10px 12px" }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Risk / reward</div>
                          {rr.side ? (
                            <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.7 }}>
                              Side <b style={{ color: C.text }}>{rr.side}</b> · R <b style={{ color: C.text }}>{rr.riskPerShare ?? "—"}</b>/sh · reward <b style={{ color: C.text }}>{rr.rewardPerShare ?? "—"}</b>/sh · <b style={{ color: rr.rr >= 2 ? C.green : rr.rr >= 1 ? C.amber : C.red }}>{rr.rr ?? "—"}R</b>
                              {dist && <div style={{ color: C.muted, marginTop: 3 }}>to stop {dist.stop.pct ?? "—"}% · to T1 {dist.targets?.[0]?.pct ?? "—"}%</div>}
                            </div>
                          ) : <div style={{ fontSize: 12.5, color: C.muted, fontStyle: "italic" }}>Enter entry + stop to compute R:R.</div>}
                        </div>
                        <div style={{ flex: "1 1 240px", background: liveRegime?.bg || C.bg, border: "1px solid " + (liveRegime?.bdr || C.bdr), borderRadius: 9, padding: "10px 12px" }}>
                          <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Regime-scaled size</div>
                          {sug?.size ? (
                            <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.7 }}>
                              Suggested <b style={{ color: C.text }}>{sug.size.shares}</b> sh (${sug.size.notional.toLocaleString()} · {sug.size.notionalPct}% of book) at <b style={{ color: liveRegime?.color }}>{sug.effRiskPct}%</b> risk (base {baseRiskNum}% × {sug.mult})
                              {own && <div style={{ color: C.muted, marginTop: 3 }}>your {w.riskPct}% → {own.shares} sh (${own.notional.toLocaleString()})</div>}
                            </div>
                          ) : <div style={{ fontSize: 12.5, color: C.muted, fontStyle: "italic" }}>Set account equity + entry + stop for a size.</div>}
                        </div>
                      </div>

                      {fit.where && <div style={{ marginTop: 8, fontSize: 12, color: C.mid }}><b style={{ color: fit.fit === "tailwind" ? C.green : C.red }}>{fit.fit === "tailwind" ? "Regime tailwind" : "Fights the regime"}:</b> {liveRegime?.label} {fit.fit === "tailwind" ? "favours" : "disfavours"} “{fit.where}”.</div>}

                      <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <input value={w.note ?? ""} onChange={e => updateItem(w.id, { note: e.target.value })} placeholder="thesis / note"
                          style={{ flex: "1 1 260px", padding: "6px 10px", border: "1.5px solid " + C.bdr, borderRadius: 8, fontSize: 12.5, background: C.surf, color: C.text }} />
                        <Btn onClick={() => openJournalFor(w)} color="#fff" bgColor={C.green} label="📓 Log trade" />
                        <Btn onClick={() => removeItem(w.id)} color={C.red} bgColor={C.surf} label="✕ Remove" />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* journal form */}
      {jForm && (
        <Card>
          <SLabel>Log a trade — {jForm.symbol || "?"}</SLabel>
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" }}>
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Symbol<br />
              <input value={jForm.symbol} onChange={e => setJForm(f => ({ ...f, symbol: e.target.value.toUpperCase() }))} style={{ width: 90, padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} /></label>
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Side<br />
              <select value={jForm.side || ""} onChange={e => setJForm(f => ({ ...f, side: e.target.value || null }))} style={{ padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }}>
                <option value="">—</option><option value="long">long</option><option value="short">short</option>
              </select></label>
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Entry<br />{numInput(jForm.entryPrice, v => setJForm(f => ({ ...f, entryPrice: v })), "", 80)}</label>
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Stop<br />{numInput(jForm.stop, v => setJForm(f => ({ ...f, stop: v })), "", 80)}</label>
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Exit<br />{numInput(jForm.exitPrice, v => setJForm(f => ({ ...f, exitPrice: v })), "", 80)}</label>
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Shares<br />{numInput(jForm.shares, v => setJForm(f => ({ ...f, shares: v })), "", 80)}</label>
            <label style={{ fontSize: 11.5, color: C.lbl, fontWeight: 700 }}>Date out<br />
              <input type="date" value={jForm.dateOut} onChange={e => setJForm(f => ({ ...f, dateOut: e.target.value }))} style={{ padding: "5px 8px", border: "1.5px solid " + C.bdr, borderRadius: 7, fontSize: 12.5, background: C.surf, color: C.text }} /></label>
          </div>
          <input value={jForm.notes} onChange={e => setJForm(f => ({ ...f, notes: e.target.value }))} placeholder="notes / what happened"
            style={{ marginTop: 10, width: "100%", boxSizing: "border-box", padding: "6px 10px", border: "1.5px solid " + C.bdr, borderRadius: 8, fontSize: 12.5, background: C.surf, color: C.text }} />
          <div style={{ marginTop: 6, fontSize: 11.5, color: C.muted }}>Regime at entry auto-stamps: <b style={{ color: liveRegime?.color }}>{liveRegime ? `${liveRegime.label} ${regimeProbFor(liveRegime.id)}%` : "—"}</b>. Realized R computes from entry/stop/exit.</div>
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <Btn onClick={saveJournal} color="#fff" bgColor={C.green} label="Save to journal" />
            <Btn onClick={() => setJForm(null)} color={C.mid} bgColor={C.bg} label="Cancel" />
          </div>
        </Card>
      )}

      {/* journal list */}
      <Card>
        <SLabel>Journal</SLabel>
        {journal.length === 0 ? (
          <div style={{ color: C.muted, fontSize: 13, marginTop: 10, fontStyle: "italic" }}>No trades logged. Use “Log trade” on a watchlist row — each entry stamps the regime you were in, so you can later see how you do by regime.</div>
        ) : (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {journal.map(j => (
              <div key={j.id} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", padding: "8px 10px", border: "1px solid " + C.bdr, borderRadius: 8, background: C.surf }}>
                <b style={{ color: C.text, minWidth: 56 }}>{j.symbol}</b>
                {j.side && chip(j.side, C.mid, C.bg, C.bdr)}
                {j.realizedR != null && chip(`${j.realizedR >= 0 ? "+" : ""}${j.realizedR}R`, j.realizedR >= 0 ? C.green : C.red, C.bg, C.bdr)}
                <span style={{ fontSize: 12, color: C.muted }}>{j.dateIn || "?"}{j.dateOut ? " → " + j.dateOut : ""}</span>
                {j.regimeAtEntry && <span style={{ fontSize: 11.5, color: C.lbl }}>· regime: {j.regimeAtEntry}</span>}
                {j.thesis && <span style={{ fontSize: 12, color: C.mid, flex: "1 1 180px" }}>{j.thesis}</span>}
                <Btn onClick={() => removeJournal(j.id)} color={C.red} bgColor={C.surf} label="✕" />
              </div>
            ))}
          </div>
        )}
      </Card>

      <div style={{ color: C.lbl, fontSize: 11.5, textAlign: "center", lineHeight: 1.5 }}>
        Prices: /api/prices (Yahoo, poll-cadence) · sizing + R:R are arithmetic over your inputs (lib/console.js) · state syncs to your private store on “Save to cloud”, and mirrors to this browser automatically. Not investment advice; no orders are placed.
      </div>
    </div>
  );
}

// Label for the credit cap, shown in the console settings note.
const CREDIT_DANGER_CAP_LABEL = "×0.40";

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]           = useState("macro");
  const [pbRegions, setPbRegions] = useState(["asia", "eu", "us"]); // Global Playbook — multi-select, default All
  const toggleRegion = (r) => setPbRegions(prev => {
    const next = prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r];
    if (next.length === 0) return prev;                              // keep at least one region on
    return PB_REGIONS.map(x => x.id).filter(id => next.includes(id)); // canonical asia→eu→us order
  });
  const [activeAsset, setActiveAsset]   = useState(ASSETS[0]);
  const [activeIncome, setActiveIncome] = useState(INCOME_PLAYS[0]);
  const [activeRegime, setActiveRegime] = useState(REGIMES[0]);
  // Pin survives reloads — an override you forgot about is exactly what the banner exists to
  // make visible, so it must not silently reset.
  const [regimePin, setRegimePin] = useState(() => cacheLoad("regime_pin_v1", { pinned: false, note: "", setAt: null }));
  const savePin = (p) => { setRegimePin(p); cacheSave("regime_pin_v1", p); };
  const [insurancePhase, setInsurancePhase] = useState("preCrash"); // Insurance tab — "preCrash" | "liquidity" | "recovery" | "def" | "inf" | "stag" | "hawkish"
  const [insurancePinned, setInsurancePinned] = useState(false);    // A3 — true once the user manually sets a phase; suppresses the vol-regime auto-suggest
  // A3 — manual override: clicking any phase pins it (same pattern as the regime pin). Auto-suggest
  // still computes and, when it diverges from the pin, surfaces a banner with a follow-signal action.
  const pickInsurancePhase = (k) => { setInsurancePhase(k); setInsurancePinned(true); };
  const followInsuranceSignal = () => { setInsurancePinned(false); };
  const [stage4, setStage4] = useState(false); // Posture deploy stage 4 — manual, persisted
  const [stage5, setStage5] = useState(false); // Posture deploy stage 5 — manual, persisted
  const [portfolioValue, setPortfolioValue] = useState(""); // Posture portfolio total (digits only), persisted
  const [funds, setFunds]       = useState(DEFAULT_FUNDS);
  const [selectedFund, setSelectedFund] = useState(DEFAULT_FUNDS[0]);
  // Task 1b — manual recession-source overrides, keyed by recessionSrcKey. Loaded once from the
  // manual store; refreshed after a save by the RecessionEntryPanel via onSaved.
  const [recessionOverrides, setRecessionOverrides] = useState({});
  useEffect(() => {
    fetch("/api/manual-entry").then(r => r.json()).then(j => setRecessionOverrides(j.recession || {})).catch(() => {});
  }, []);

  const { prices, loading: pricesLoading, updated: pricesUpdated, fetchPrices } = useLivePrices();
  const { live: liveInd, loading: indLoading, updated: indUpdated, error: indError, fetchIndicators } = useLiveIndicators();
  const { byRegion: pbData, loading: pbLoading, updated: pbUpdated, error: pbError, fetchRegion: fetchPlaybookRegion } = useLivePlaybook();
  // A3 — vol-regime → Insurance-phase suggestion (declared after pbData to stay out of its TDZ).
  const insuranceSuggest = suggestInsurancePhase(pbData?.us?.volTerm, pbData?.us?.macro?.oas?.series);
  useEffect(() => {
    if (!insurancePinned && insuranceSuggest?.phase && insuranceSuggest.phase !== insurancePhase) setInsurancePhase(insuranceSuggest.phase);
  }, [insuranceSuggest?.phase, insurancePinned]);
  // Task 1a+1b — the recession table the whole app reads: manual override > auto-feed > static.
  const effectiveRecessionSources = useMemo(
    () => mergeRecessionSources(RECESSION_SOURCES, liveInd?.recessionFeeds || {}, recessionOverrides),
    [liveInd, recessionOverrides]
  );

  // Regime probabilities derived from the recession table + live CPI. Falls back
  // to the prior static split when no weighted average is available.
  const fallbackRegimes = { stagflation: 48, reflationary: 17, deflationary: 30, inflationary: 5 };
  const recConsensus = computeWeightedRecessionProb(effectiveRecessionSources, new Date().toISOString().slice(0, 10));
  // The regime engine consumes the ROLLING-12M consensus — the horizon it actually asks about.
  // recLegacyBlend is the old all-horizons average, kept visible so the difference is auditable.
  const { regimeInput: recWeightedAvg, weightedAvg: recLegacyBlend, kalshi2027: recKalshi2027, decayed: recDecayed } = recConsensus;
  const cpiForRegime = liveInd?.cpiHeadlineCurrent ?? liveInd?.cpi ?? null;
  // Section A — the growth/inflation context that decides whether a falling recession
  // probability is a GROWTH story or a STAGFLATION story. Both legs are live.
  const coreHist = liveInd?.pceCoreHistory || [];
  // Amendment 3 — overlay the announced July labour print over the live (FRED-lagged) series so
  // every downstream read (verdict, Sahm, regime signal) sees July, not June. Auto-retires when
  // FRED catches up. One computation, reused by both LaborPanel renders and the regime context.
  const { labor: laborView, applied: laborAnnounced, extras: laborExtras } = overlayJulyLabor(liveInd?.labor);
  // R4/R8.1 — the 12-month average: the fixture when announced, else derived from PAYEMS history.
  const laborTwelveMoK = laborExtras?.twelveMoAvgK
    ?? ((laborView?.payrolls?.history?.length >= 13)
      ? Math.round((laborView.payrolls.history.at(-1).value - laborView.payrolls.history.at(-13).value) / 12)
      : null);
  // R8.1 — the labour deterioration signal fed to deriveRegimeProbabilities.
  const laborRegimeSignal = {
    payrollsK: laborView?.payrolls?.delta ?? null,
    empPopDelta: laborView?.empPop?.delta ?? null,
    twelveMoAvgK: laborTwelveMoK,
  };
  const regimeCtx = {
    gdpGrowth: (announced("gdpGrowth", liveInd?.asOf?.gdpGrowth)?.value) ?? liveInd?.gdpGrowth ?? null,
    gdpGrowthPrev: (announced("gdpGrowth", liveInd?.asOf?.gdpGrowth)?.prev) ?? liveInd?.gdpGrowthPrev ?? null,
    coreInflation: (announced("pceCore", liveInd?.asOf?.pceCoreCurrent)?.value) ?? liveInd?.pceCoreCurrent ?? null,
    coreCooling: coreHist.length >= 2 ? coreHist[coreHist.length - 1].value < coreHist[coreHist.length - 2].value : null,
    labor: laborRegimeSignal,
  };
  const derivedRegimes = deriveRegimeProbabilities(recWeightedAvg, cpiForRegime, recKalshi2027, regimeCtx);
  // Section D — one labour-stress read, replacing every unemployment-RATE tripwire.
  const labStress = laborStress({
    empPop: { delta: laborView?.empPop?.delta ?? null },
    household: { changeK: laborView?.household?.delta ?? null },
    payrolls: { changeK: laborView?.payrolls?.delta ?? null },
  });
  const regimeProbFor = (id) => (derivedRegimes || fallbackRegimes)[
    { stag: "stagflation", ref: "reflationary", def: "deflationary", inf: "inflationary" }[id]
  ];

  // The four regime cards + the colour bar, ordered by probability (desc) so the most-likely
  // state reads first. Probabilities are clamped to finite integers HERE, once — a bad/missing
  // input can then never produce an "undefined%"/"NaN%" width that would collapse the colour bar
  // to nothing. Stable secondary sort keeps equal-probability states in canonical order.
  const regimeSorted = useMemo(() => {
    const src = derivedRegimes || fallbackRegimes;
    const key = { stag: "stagflation", ref: "reflationary", def: "deflationary", inf: "inflationary" };
    return REGIMES
      .map((r, i) => ({ r, prob: Math.max(0, Math.min(100, Math.round(Number(src?.[key[r.id]]) || 0))), i }))
      .sort((a, b) => (b.prob - a.prob) || (a.i - b.i));
  }, [derivedRegimes]);

  // ── P0.2 — computed regime vs displayed regime, deliberately separate ────────
  // liveRegime is ALWAYS what the engine computes; it is never user-editable. viewRegime is
  // what the page renders (best/worst assets, roadmap, sorting) and IS user-selectable.
  // Full auto-switch would change the page underneath you with no record; full manual drifts
  // and goes stale silently. Keeping both, and showing the gap, is the point.
  const liveRegimeId = (() => {
    const src = derivedRegimes || fallbackRegimes;
    const byId = { stag: src.stagflation, ref: src.reflationary, def: src.deflationary, inf: src.inflationary };
    return Object.entries(byId).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  })();
  const liveRegime = REGIMES.find(r => r.id === liveRegimeId) || REGIMES[0];
  // The pin carries WHY and WHEN, so a stale override is self-explaining rather than a mystery.
  const regimeDiverged = regimePin.pinned && activeRegime.id !== liveRegime.id;
  const switchToLive = () => { setActiveRegime(liveRegime); savePin({ pinned: false, note: "", setAt: null }); };
  const keepPinned = (note) => savePin({ pinned: true, note: note ?? regimePin.note ?? "", setAt: regimePin.setAt || new Date().toISOString().slice(0, 10) });

  // Follow the engine unless the user has explicitly pinned a view.
  useEffect(() => {
    if (!regimePin.pinned && liveRegime && activeRegime.id !== liveRegime.id) setActiveRegime(liveRegime);
  }, [liveRegime?.id, regimePin.pinned]);

  // ── P0.3 — append one row per day, with the RAW INPUTS so logic changes stay backtestable.
  // Guarded by a local marker so a day's worth of refreshes produces one write, not hundreds.
  // F3 — the live flag. assemble.js reads the store from the deployed bundle, so the
  // server-side copy only refreshes on redeploy; this holds the just-saved value so the
  // annotation appears the moment it is set.
  const [liveIntervention, setLiveIntervention] = useState(null);
  const [regimeHistory, setRegimeHistory] = useState([]);
  useEffect(() => { fetch("/api/regime-log?limit=90").then(r => r.json()).then(j => setRegimeHistory(j.rows || [])).catch(() => {}); }, []);
  // Only rows carrying a reading can be plotted. Counting rows the chart cannot draw is how
  // an empty chart came to announce "3 days logged" — the label must describe the picture.
  const plottableHistory = useMemo(
    () => (regimeHistory || []).filter(r => r && r.stagflation_p != null),
    [regimeHistory],
  );
  useEffect(() => {
    if (!derivedRegimes || !liveRegime) return;
    const today = new Date().toISOString().slice(0, 10);
    if (cacheLoad("regime_log_last_v1", null) === today) return;   // already logged today
    const body = {
      date: today,
      stagflation_p: derivedRegimes.stagflation, reflationary_p: derivedRegimes.reflationary,
      deflationary_p: derivedRegimes.deflationary, inflationary_p: derivedRegimes.inflationary,
      hawkish_repricing: pbData?.us?.marketRegime?.state ?? null,
      live_regime: liveRegime.id, view_regime: activeRegime.id, pinned: !!regimePin.pinned,
      // Same-day HYG reading — the thing the delayed OAS print will later be scored against.
      hyg_chg: pbData?.us?.hyg?.changePct ?? null,
      hyg_qqq_divergence: pbData?.us?.hyg?.divergence?.spread ?? null,
      inputs: {
        weightedRecessionProb: recWeightedAvg, cpi: cpiForRegime, kalshi2027: recKalshi2027,
        tape: pbData?.us?.marketRegime?.inputs ?? null,
        ladderSpread: pbData?.us?.ladder?.spread ?? null,
        u3: liveInd?.labor?.u3?.value ?? null, empPop: liveInd?.labor?.empPop?.value ?? null,
        oas: liveInd?.creditSpread ?? null, tenY: liveInd?.tenY ?? null, twoY: liveInd?.twoY ?? null,
      },
    };
    fetch("/api/regime-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "include" })
      .then(r => r.ok ? cacheSave("regime_log_last_v1", today) : null)
      .catch(() => {});
  }, [derivedRegimes?.stagflation, liveRegime?.id, activeRegime.id]);

  // ── P2.5 — OAS/HYG reconciliation, run on the same daily hook ───────────────
  // Necessarily retrospective: HY OAS for date D publishes ~2 business days later, so each
  // day we look BACK for logged days whose observation has since landed and score them.
  // Scoring only happens when BOTH sides exist — never on an assumed or interpolated print.
  const [oasRecon, setOasRecon] = useState([]);
  useEffect(() => { fetch("/api/manual-entry").then(r => r.json()).then(j => setOasRecon(j.oasRecon || [])).catch(() => {}); }, []);
  useEffect(() => {
    const oasSeries = pbData?.us?.macro?.oas?.series;
    if (!oasSeries?.length || !regimeHistory.length) return;
    const pending = pendingReconciliations(regimeHistory, oasSeries, oasRecon);
    if (!pending.length) return;
    fetch("/api/manual-entry", {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify({ oasRecon: pending }),
    })
      .then(r => r.ok ? fetch("/api/manual-entry").then(x => x.json()).then(j => setOasRecon(j.oasRecon || [])) : null)
      .catch(() => {});
  }, [regimeHistory.length, pbData?.us?.macro?.oas?.date, oasRecon.length]);
  const reconSummary = reconStats(oasRecon);

  useEffect(function() {
    loadFunds().then(function(saved) {
      if (saved) { setFunds(saved); setSelectedFund(saved[0]); }
    });
  }, []);

  // Auto-refresh live data on load. Cached values (from localStorage) render
  // immediately, so there's no static-fallback flash while this fetch runs.
  useEffect(function() {
    fetchIndicators();
    fetchPrices(HEADER_TICKERS);
  }, [fetchIndicators, fetchPrices]);

  // Fetch the Global Playbook when its tab is open or the region changes.
  useEffect(function() {
    if (tab === "global") pbRegions.forEach(r => fetchPlaybookRegion(r));
  }, [tab, pbRegions, fetchPlaybookRegion]);

  // Load manual deploy-stage toggles + portfolio value from localStorage
  useEffect(function() {
    try {
      setStage4(localStorage.getItem("posture_stage4_active") === "true");
      setStage5(localStorage.getItem("posture_stage5_active") === "true");
      const pv = localStorage.getItem("portfolio_total_value");
      if (pv) setPortfolioValue(pv.replace(/[^0-9]/g, ""));
    } catch (_) {}
  }, []);
  function updatePortfolioValue(raw) {
    const digits = String(raw).replace(/[^0-9]/g, "");
    setPortfolioValue(digits);
    try { localStorage.setItem("portfolio_total_value", digits); } catch (_) {}
  }
  function toggleStage4() {
    setStage4(function(v) { const n = !v; try { localStorage.setItem("posture_stage4_active", String(n)); } catch (_) {} return n; });
  }
  function toggleStage5() {
    setStage5(function(v) { const n = !v; try { localStorage.setItem("posture_stage5_active", String(n)); } catch (_) {} return n; });
  }

  const fmtTime = d => d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

  const TABS = [
    { id: "console",    label: "🎚️ Console"      },
    { id: "macro",      label: "🌐 Macro"        },
    { id: "global",     label: "🌏 Global Playbook" },
    { id: "smartmoney", label: "🏦 Smart Money"  },
    { id: "indicators", label: "📡 Indicators"  },
    { id: "posture",    label: "🎯 Posture"      },
    { id: "insurance",  label: "🛡️ Insurance"   },
    { id: "income",     label: "💰 Income"       },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", width: "100%", color: C.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* ── HEADER ── */}
      <div className="mwd-sticky-header" style={{ background: C.surf, borderBottom: "2px solid " + C.bdr, padding: "14px 16px 0", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div>
              <h1 style={{ margin: 0, fontSize: 19, fontWeight: 900, letterSpacing: -0.5 }}>
                📊 Market Watch Dashboard
              </h1>
              <p style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                Recession indicators · Crash insurance · Income · Smart money · Macro regime
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* Unified refresh — fires both prices and indicators */}
              <button
                onClick={() => {
                  fetchPrices(HEADER_TICKERS);
                  fetchIndicators();
                }}
                disabled={pricesLoading || indLoading}
                style={{ background: C.bg, color: C.mid, border: "1.5px solid " + C.bdr, borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: (pricesLoading || indLoading) ? 0.5 : 1, whiteSpace: "nowrap" }}
              >
                {(pricesLoading || indLoading) ? "⏳ Refreshing…" : "🔄 Refresh All"}
              </button>
              {(() => {
                // M.4 — the header is a STATED FUNCTION of named inputs, not a separate
                // judgement. It previously ran `cs > 6.0 || labStress.severe`, so a severe
                // labour print alone printed DANGER / "threshold breached" while HY OAS sat at
                // 2.84 with no threshold breached at all — section H in miniature, and the
                // reason the header disagreed with the action card directly beneath it.
                // headerSignal() applies credit's veto FIRST, then takes the more severe of
                // (regime, credit).
                const cs = liveInd ? liveInd.creditSpread : 2.75;
                const regimeStatus = derivedRegimes?.contested ? "WATCH"
                  : (liveRegime?.id === "def" ? "ELEVATED" : liveRegime?.id === "stag" ? "WATCH" : "BENIGN");
                const hs = headerSignal({ oas: cs, regimeStatus });
                const tokH = STATUS[hs.signal] || STATUS.WATCH;
                const lbl = hs.signal || "WATCH";
                const col = tokH.color, bg = tokH.bg, bdr = tokH.bdr;
                // The subtitle names the binding input rather than asserting a breach.
                const sub = hs.credit === "BENIGN"
                  ? `credit benign · ${liveRegime?.label ?? "regime"}`
                  : `OAS ${cs} · ${liveRegime?.label ?? "regime"}`;
                return (
                  <div style={{ background: bg, border: "1.5px solid " + bdr, borderRadius: 10, padding: "6px 14px", textAlign: "center", minWidth: 90 }}>
                    <div style={{ color: C.lbl, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700 }}>Signal</div>
                    <div style={{ color: col, fontSize: 17, fontWeight: 900, lineHeight: 1 }}>{lbl}</div>
                    <div style={{ color: col, fontSize: 10, marginTop: 2, opacity: 0.75, lineHeight: 1.2 }}>{sub}</div>
                  </div>
                );
              })()}
            </div>
          </div>
          {/* Tab bar — scrolls horizontally on mobile */}
          <div style={{ display: "flex", gap: 0, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
            {TABS.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} style={{
                background: "none", border: "none",
                borderBottom: "3px solid " + (tab === t.id ? C.blue : "transparent"),
                color: tab === t.id ? C.blue : C.muted,
                padding: "8px 14px", fontSize: 14, fontWeight: 700,
                cursor: "pointer", whiteSpace: "nowrap", marginBottom: -2, flexShrink: 0,
              }}>
                {t.label}
              </button>
            ))}
          </div>
          {/* T1a — always-on regime strip: the market regime at a glance, on every tab, sticky.
              Reuses the values the engine already computes; no new data. */}
          {(() => {
            const r = liveRegime || REGIMES[0];
            const prob = regimeProbFor(r.id);
            const cs = liveInd ? liveInd.creditSpread : null;
            const cKey = cs != null ? creditStatus(cs) : "BENIGN";
            const cTok = STATUS[cKey] || STATUS.BENIGN;
            const cLbl = cKey === "BENIGN" ? "CALM" : cKey === "WATCH" ? "WATCHFUL" : cKey === "ELEVATED" ? "WIDENING" : "STRESSED";
            const fedState = FED_LANGUAGE_STATES[FED_LANGUAGE_STATUS.status] || {};
            const fedLbl = (fedState.label || "").replace(/^\S+\s/, "");
            const chip = (k, v, col) => (
              <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap" }}>
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: C.lbl }}>{k}</span>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: col }}>{v}</span>
              </span>
            );
            const flag = (txt) => <span style={{ fontSize: 10, fontWeight: 800, color: C.amber, background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap" }}>{txt}</span>;
            return (
              <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "nowrap", overflowX: "auto", scrollbarWidth: "none", padding: "7px 2px 3px", borderTop: "1px solid " + C.bdr, marginTop: 4 }}>
                {chip("Regime", `${r.label} ${prob}%`, r.color)}
                <span style={{ color: C.bdr }}>·</span>
                {chip("Credit", `${cLbl}${cs != null ? ` · OAS ${cs}` : ""}`, cTok.color)}
                <span style={{ color: C.bdr }}>·</span>
                {chip("Fed", fedLbl || "—", fedState.color || C.mid)}
                {derivedRegimes?.contested && flag("⚖ CONTESTED")}
                {regimeDiverged && flag("📌 PINNED ≠ LIVE")}
              </div>
            );
          })()}
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div className="mwd-content-pad" style={{ maxWidth: 1080, margin: "0 auto", padding: "16px" }}>

        {/* Every tab is fail-soft: a render error shows a scoped error card instead of blanking
            the whole dashboard. key={tab} remounts the boundary on tab change, so an error on
            one tab clears when you navigate away rather than sticking. The footer stays
            OUTSIDE, so it renders even if the active tab dies. */}
        {/* P0.2 — divergence banner. Persistent and on EVERY tab, because a pinned view that
            no longer matches the engine is exactly the thing you stop noticing. Carries the
            note and the date it was set, so a stale override explains itself. */}
        {regimeDiverged && (
          <div style={{ marginBottom: 14, padding: "10px 14px", background: C.aBg, border: "1.5px solid " + C.aBdr, borderRadius: 10,
            display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
            <span style={{ fontSize: 13, color: C.amber, fontWeight: 700, lineHeight: 1.5 }}>
              📌 Viewing <b>{activeRegime.label}</b> (pinned{regimePin.setAt ? ` ${regimePin.setAt}` : ""}).
              Live engine reads <b>{liveRegime.label}</b> ({regimeProbFor(liveRegime.id)}%).
              {regimePin.note ? <span style={{ fontStyle: "italic", color: C.mid }}> — “{regimePin.note}”</span> : null}
            </span>
            <span style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <Btn onClick={switchToLive} color="#fff" bgColor={C.blue} label="Switch to live" />
              <Btn onClick={() => {
                const n = window.prompt("Why keep this pinned? (shown in the banner)", regimePin.note || "");
                if (n !== null) keepPinned(n);
              }} color={C.amber} bgColor={C.aBg} label="Keep pinned…" />
            </span>
          </div>
        )}

        <TabErrorBoundary key={tab} name={(TABS.find(t => t.id === tab)?.label || "This tab").replace(/^\S+\s/, "")}>

        {/* ── TRADE CONSOLE (Tier 3) ── */}
        {tab === "console" && (
          <TradeConsole
            liveRegime={liveRegime}
            regimeProbFor={regimeProbFor}
            liveInd={liveInd}
            creditDanger={creditStatus(liveInd?.creditSpread) === "DANGER"}
            contested={!!derivedRegimes?.contested}
            regimeDiverged={regimeDiverged}
            prices={prices}
            fetchPrices={fetchPrices}
            pricesLoading={pricesLoading}
          />
        )}

        {/* ── INDICATORS ── */}
        {tab === "indicators" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>


            {/* ACTION CARD — top, high-emphasis, colorizes with signal */}
            {(() => {
              const cs = liveInd ? liveInd.creditSpread : 2.75;
              // ── Sections H + L — derived, with CREDIT'S VETO applied ──
              // Previously: isDanger = cs > 6.0 || labStress.severe, which let a severe labour
              // print alone print "Stage 3 — Full Insurance Active" while the master gauge
              // directly beneath read BENIGN at 2.84. Those describe different worlds: Stage 3
              // means insurance is already ON, benign credit means nothing has happened yet.
              // HY OAS is the master gauge, so it now vetoes a full-defensive call.
              const act = deriveAction({
                oas: cs,
                regimeLabel: liveRegime?.label, regimePct: regimeProbFor(liveRegime?.id),
                regimeContested: !!derivedRegimes?.contested,
                labourVerdict: laborVerdictFor(liveInd), labourSevere: labStress.severe,
                ratesNote: liveInd?.yieldSpread != null ? `curve ${liveInd.yieldSpread >= 0 ? "+" : ""}${liveInd.yieldSpread.toFixed(2)}%` : null,
                vintages: {
                  regime: `${CONSENSUS_VINTAGE.label}, ${CONSENSUS_VINTAGE.staleNote}`,
                  credit: liveInd?.asOf?.creditSpread ? `obs ${liveInd.asOf.creditSpread}` : null,
                  labour: liveInd?.labor?.empPop?.date ? `obs ${liveInd.labor.empPop.date}` : null,
                },
              });
              const isDanger  = act.status === "DANGER";
              const isAlert   = act.status === "ELEVATED";
              const isNeutral = act.stage === 1 && activeRegime.id === "ref";
              const sigLabel  = act.status === "ELEVATED" ? "ALERT" : act.status === "BENIGN" && isNeutral ? "NEUTRAL" : act.status === "BENIGN" ? "WATCH" : act.status;
              // Colour tracks STATUS; the instruction tracks STAGE. Keeping both on one
              // status-keyed map is what put "Stage 1 active — Surveillance. No insurance
              // purchases yet." underneath a "Stage 2 — Accumulate insurance" headline:
              // deriveAction compresses stage 2 to WATCH and stage 3 to ELEVATED, so a map
              // that assumed WATCH=1 / ALERT=2 / DANGER=3 was one stage behind at every level
              // above 1. The card contradicted itself, and the bullets were the wrong advice.
              const GRADIENTS = {
                DANGER:  { g1: "#991B1B", g2: "#B91C1C", shadow: "rgba(153,27,27,0.35)" },
                ALERT:   { g1: "#92400E", g2: "#B45309", shadow: "rgba(146,64,14,0.35)" },
                WATCH:   { g1: "#334155", g2: "#1E293B", shadow: "rgba(30,41,59,0.35)" },
                NEUTRAL: { g1: "#166534", g2: "#15803D", shadow: "rgba(22,101,52,0.30)" },
              };
              const STAGE_BULLETS = {
                1: ["🔍 Stage 1 — Surveillance. No insurance purchases yet.",
                    "📉 VIX below 20 means insurance is cheap — this is the preparation window, not the activation window.",
                    "💵 Berkshire's playbook: T-bills at ~4.2% while waiting. Optionality > yield."],
                2: ["🛡️ Stage 2 — Accumulate insurance. Build the position while it is cheap.",
                    "🎯 SPY puts at 90% strike, 90-day expiry, ~1.5% of portfolio in premium. Scale in; do not size it all at once.",
                    "📉 Reduce leveraged positions. This is a preparation stance, not a defensive one — equity exposure stays on."],
                3: ["🚨 Stage 3 — Full insurance active. No new equity.",
                    "⏳ Do not deploy cash yet — Path 2 corrections average 18 months.",
                    "📈 Wait for a VIX peak before Stage 4."],
                4: ["🚀 Stage 4 — Deploy. Rotate from insurance into risk.",
                    "📊 Harvest puts into the peak; recycle premium into equities in tranches.",
                    "🔄 Re-establish the long-term book before the recovery is obvious."],
              };
              const NEUTRAL_BULLETS = [
                "🌱 Reflationary recovery underway. AI infrastructure, broad equities, and REITs leading.",
                "📈 Reduce insurance overweight — defensive positioning gives way to growth assets.",
                "🔄 Watch for credit spread re-widening as the signal to rotate back defensive.",
              ];
              const cfg = {
                ...(GRADIENTS[sigLabel] || GRADIENTS.WATCH),
                action: act.label,
                bullets: sigLabel === "NEUTRAL" ? NEUTRAL_BULLETS : (STAGE_BULLETS[act.stage] || STAGE_BULLETS[1]),
              };
              // ── Section A — contested guard ──
              // A 1pp separation between the top two states is a tie. A tie cannot support a
              // capital-deployment instruction, so the directional recommendation is
              // SUPPRESSED entirely — no "Risk-On", no "Deploy", no defensive equivalent.
              const contested = !!derivedRegimes?.contested;
              const gapPP = derivedRegimes?.topTwoGap;
              const topTwoLabels = (derivedRegimes?.topTwo || [])
                .map(id => REGIMES.find(r => r.id === id)?.label).filter(Boolean);
              return (
                <>
                  <div style={{ background: contested ? "linear-gradient(135deg, #4B5068, #2F3444)" : `linear-gradient(135deg, ${cfg.g1}, ${cfg.g2})`, borderRadius: 14, padding: "18px 22px", color: "#fff", boxShadow: `0 4px 24px ${contested ? "rgba(75,80,104,0.35)" : cfg.shadow}`, transition: "background 0.4s" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", opacity: 0.7, fontWeight: 700, marginBottom: 5 }}>
                          {contested ? "No directional signal" : "Recommended Action"} · consensus inputs {CONSENSUS_VINTAGE.label}
                        </div>
                        <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.5, lineHeight: 1.2 }}>
                          {contested ? `REGIME CONTESTED — no clear signal. Top two states within ${gapPP}pp.` : act.label}
                        </div>
                        {/* L.3 — the stage definition, so "Stage 3" is never unexplained. */}
                        {!contested && <div style={{ fontSize: 12, opacity: 0.82, marginTop: 3, lineHeight: 1.5 }}>{act.desc}</div>}
                      </div>
                      <div style={{ background: "rgba(255,255,255,0.18)", borderRadius: 10, padding: "8px 16px", textAlign: "center", backdropFilter: "blur(4px)", minWidth: 90 }}>
                        <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", opacity: 0.8, marginBottom: 2 }}>Signal</div>
                        <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", lineHeight: 1 }}>{contested ? "—" : sigLabel}</div>
                        <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{contested ? topTwoLabels.join(" / ") : activeRegime.label}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                      {(contested
                        ? [`⚖️ ${topTwoLabels.join(" and ")} are separated by ${gapPP}pp — that is a tie, not a winner.`,
                           "🚫 Directional recommendation suppressed. A 1-in-2 call cannot support a deployment instruction.",
                           `🗓️ Consensus inputs are ${CONSENSUS_VINTAGE.label} (${CONSENSUS_VINTAGE.staleNote}); refresh is deferred to after Aug 7 and Aug 28.`]
                        : cfg.bullets).map((t, i) => (
                        <div key={i} style={{ flex: "1 1 200px" }}>
                          <span style={{ color: "#fff", fontSize: 14, lineHeight: 1.7, opacity: 0.92 }}>{t}</span>
                        </div>
                      ))}
                    </div>
                    {/* L.2 — when credit vetoes, say so on the card. A capped recommendation
                        with no explanation is the same opacity L.1 exists to remove. */}
                    {act.vetoed && !contested && (
                      <div style={{ marginTop: 10, padding: "8px 11px", background: "rgba(255,255,255,0.16)", borderRadius: 8, fontSize: 12.5, lineHeight: 1.55 }}>
                        🛑 <b>Credit veto:</b> {act.vetoNote}
                      </div>
                    )}
                    {/* L.1 — the derivation, with each input's vintage inline. */}
                    {act.inputs.length > 0 && (
                      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.22)", fontSize: 11.5, lineHeight: 1.6, opacity: 0.9 }}>
                        <b style={{ opacity: 0.75 }}>Derived from: </b>
                        {/* Drivers first, then context. Listing a non-input in the same run as the
                            gauges that actually set the stage implies a weight it does not have. */}
                        {act.inputs.filter(x => x.weight !== "context").map((inp, i) => (
                          <span key={inp.name}>
                            {i ? " · " : ""}{inp.name} ({inp.value}
                            {inp.vintage ? <span style={{ opacity: 0.7 }}> — {inp.vintage}</span> : null})
                          </span>
                        ))}
                        {act.inputs.some(x => x.weight === "context") && (
                          <span style={{ opacity: 0.62 }}>
                            {" · context (not weighted): "}
                            {act.inputs.filter(x => x.weight === "context").map(x => x.name + " " + x.value).join(", ")}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {/* Separator */}
                  <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "4px 0" }}>
                    <div style={{ flex: 1, height: 1, background: C.bdr }} />
                    <span style={{ color: C.lbl, fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>Market Indicators</span>
                    <div style={{ flex: 1, height: 1, background: C.bdr }} />
                  </div>
                </>
              );
            })()}

            {/* OVERALL READ — context above charts */}
            <Card style={{ background: C.aBg, border: "1.5px solid " + C.aBdr }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                {/* M.2 — vintage removed: this composite reads LIVE data. Stale stamps go on
                    the individual stale inputs (regime consensus), never on the composite. */}
                <SLabel>Overall Read</SLabel>
                <Btn onClick={fetchIndicators} disabled={indLoading} color="#fff" bgColor={C.blue} label={indLoading ? "Fetching…" : "🔄 Refresh Live Data"} />
              </div>
              {liveInd && (
                <div style={{ marginBottom: 10, padding: "8px 12px", background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, fontSize: 13, color: C.blue, fontWeight: 700 }}>
                  Live: 10Y {liveInd.tenY?.toFixed(2)}% · 2Y {liveInd.twoY?.toFixed(2)}% · Spread {liveInd.yieldSpread >= 0 ? "+" : ""}{liveInd.yieldSpread?.toFixed(2)}% · UE {liveInd.unemployment?.toFixed(1)}% · HY OAS {liveInd.creditSpread?.toFixed(2)}%
                  <span style={{ color: C.lbl, fontWeight: 400, marginLeft: 8 }}>Updated {fmtTime(indUpdated)}</span>
                </div>
              )}
              {indError && (
                <div style={{ marginBottom: 10, padding: "10px 13px", background: C.rBg, border: "1px solid " + C.rBdr, borderRadius: 8, fontSize: 13, color: C.red }}>
                  ⚠️ {indError}
                </div>
              )}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
                {[
                  { icon: liveInd && liveInd.creditSpread >= 4.5 ? "🚨" : liveInd && liveInd.creditSpread >= 3.5 ? "⚠️" : "✅", text: `Credit spreads at ${liveInd ? liveInd.creditSpread.toFixed(2) : "2.75"}%. ${liveInd && liveInd.creditSpread >= 4.5 ? "ALERT THRESHOLD BREACHED — rotate defensive now." : liveInd && liveInd.creditSpread >= 3.5 ? "Widening toward alert zone. Build insurance." : "Markets not pricing stress. Trip wire: 4.5%."}` },
                  // The un-inversion window is elapsed time since a dated event, so this bullet
                  // reads the same computation as the card rather than restating a level test.
                  (() => {
                    const yph = unInversionPhase(liveInd?.yieldHistory || []);
                    const lvl = liveInd ? (liveInd.yieldSpread >= 0 ? "+" : "") + liveInd.yieldSpread.toFixed(2) + "%" : "+0.38%";
                    const tail = liveInd && liveInd.yieldSpread < 0
                      ? "still inverted, pricing recession ahead."
                      : yph.phase === "IN_WINDOW" ? `inside the historical 4–11 month post-un-inversion window (${yph.monthsSince} months in).`
                      : yph.phase === "ELAPSED"   ? `${yph.monthsSince} months past un-inversion — the historical 4–11 month window has closed.`
                      : yph.phase === "PRE_WINDOW" ? `un-inverted ${yph.monthsSince} month${yph.monthsSince === 1 ? "" : "s"} ago; the historical window has not opened yet.`
                      : "un-inversion date not locatable from the loaded history.";
                    return { icon: yph.phase === "IN_WINDOW" ? "⚠️" : "•", text: `Yield curve at ${lvl} — ${tail}` };
                  })(),
                  // Section D + C.5 — the icon is keyed on the EMPLOYMENT measures, not the
                  // unemployment rate, and the Sahm reference carries its understatement
                  // caveat: a rate that fell on labour-force exit suppresses the rule.
                  { icon: labStress.severe ? "🚨" : "⚠️",
                    text: `Unemployment at ${laborView?.u3?.value != null ? laborView.u3.value.toFixed(1) : (liveInd ? liveInd.unemployment.toFixed(1) : "4.4")}%`
                      + `${laborView?.empPop?.value != null ? `, emp-pop ${laborView.empPop.value.toFixed(1)}% (${laborView.empPop.delta >= 0 ? "+" : "−"}${Math.abs(laborView.empPop.delta ?? 0).toFixed(1)}pp)` : ""}. `
                      + `${labStress.known ? labStress.note[0].toUpperCase() + labStress.note.slice(1) + "." : "Employment print unavailable."}`
                      + `${(() => { const sn = sahmAnnotation(laborVerdictFor(liveInd), laborView?.payrolls?.delta ?? null); return sn ? ` ${sn.title} ${sn.text}` : ""; })()}` },
                ].map((r, i) => (
                  <div key={i} style={{ flex: "1 1 200px", display: "flex", gap: 10 }}>
                    <span style={{ fontSize: 17, flexShrink: 0 }}>{r.icon}</span>
                    <span style={{ color: C.amber, fontSize: 14, lineHeight: 1.65 }}>{r.text}</span>
                  </div>
                ))}
              </div>
            </Card>

            {/* C.1 — "unemp" is deliberately excluded: the labour module above is the single
                definition for that topic. Three renderings of one subject is what this removes. */}
            {INDICATORS.filter(ind => ind.id !== "unemp" && ind.id !== "credit").map(ind => <IndicatorChart key={ind.id} ind={ind} live={liveInd} />)}

            {/* M.2 — credit renders on BOTH tabs from the same component, so the age chip and
                the HYG proxy exist here by construction rather than by duplication. */}
            <CreditBlock
              depth="glance"
              history={liveInd?.creditHistory}
              credit={pbData?.us?.regime?.credit}
              oas={pbData?.us?.macro?.oas}
              hyg={pbData?.us?.hyg}
              reconSummary={reconSummary}
            />

            {/* G.2 — labour renders BELOW credit spreads and the yield curve. G.3 — this is
                the SHARED definition (LaborPanel), not a reimplementation; two copies drift. */}
            <LaborPanel labor={laborView} depth="glance" announced={laborAnnounced} />
          </div>
        )}

        {/* ── POSTURE ── */}
        {tab === "posture" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {(() => {
              const cs = liveInd ? liveInd.creditSpread : 2.75;
              // Same derivation as the Indicators action card — ONE rule, so the two surfaces
              // cannot disagree about the stage. Credit's veto (L.2) applies here identically:
              // a severe labour print alone cannot put the book at Stage 3 while the master
              // gauge reads benign.
              const pAct = deriveAction({
                oas: cs,
                regimeLabel: liveRegime?.label, regimePct: regimeProbFor(liveRegime?.id),
                regimeContested: !!derivedRegimes?.contested,
                labourVerdict: laborVerdictFor(liveInd), labourSevere: labStress.severe,
              });
              const signalStage = pAct.stage;
              const sigLabel = pAct.status === "ELEVATED" ? "ALERT" : pAct.status;
              const sigColor = STATUS[pAct.status]?.color ?? C.amber;
              // Manual stages 4–5 override the auto signal stage as the cycle marker.
              const activeStage = stage5 ? 5 : stage4 ? 4 : signalStage;
              // Allocations: regime-driven fund-manager framework.
              const alloc = POSTURE_ALLOCATIONS[activeRegime.id] || POSTURE_ALLOCATIONS.baseline;
              // Donut: range mid-points; emphasise the largest bucket with full
              // activeRegime.color, fade the rest by relative size.
              const mids = POSTURE_BUCKET_META.map(m => postureMid(alloc[m.key].range));
              const maxMid = Math.max(...mids, 1);
              const segColor = mid => {
                const a = Math.max(0.30, Math.min(1, (mid || 0) / maxMid));
                return activeRegime.color + Math.round(a * 255).toString(16).padStart(2, "0");
              };
              const chartData = POSTURE_BUCKET_META.map((m, i) => ({ name: m.name, value: mids[i] || 0.5, range: alloc[m.key].range, fill: segColor(mids[i]) }));
              // Fix F — portfolio value → dollar extrapolation.
              const pv = parseFloat(portfolioValue) || 0;
              const fmtUSD = n => "$" + Math.round(n).toLocaleString("en-US");
              const fmtCompact = n => n >= 1e9 ? "$" + (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "") + "B"
                : n >= 1e6 ? "$" + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M"
                : n >= 1e3 ? "$" + Math.round(n / 1e3) + "K"
                : "$" + Math.round(n);
              const dollarRange = range => {
                const nums = String(range).replace(/%/g, "").split("–").map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
                if (pv <= 0 || nums.length < 2) return null;
                return fmtUSD(pv * nums[0] / 100) + " – " + fmtUSD(pv * nums[1] / 100);
              };
              // Fix A — top regime-ranked insurance instruments feed the stage tracker
              // (same rankKey + sort as the Insurance tab; best-ranked first).
              const insRankKey = { stag: "stagRank", def: "defRank", ref: "refRank", inf: "infRank" }[activeRegime.id] || "stagRank";
              const rankedIns = [...ASSETS].sort((a, b) => (a[insRankKey] || 9) - (b[insRankKey] || 9));
              const top2Ins = rankedIns.slice(0, 2).map(a => a.name).join(", ");
              const top3Ins = rankedIns.slice(0, 3).map(a => a.name).join(", ");
              const stageNote = s => s.n === 2
                ? `Activate first insurance tranche — current regime favours: ${top2Ins}. For put spreads: 90% strike, 90-day expiry, ~1.5% of portfolio in premium. Reduce leveraged positions.`
                : s.n === 3
                ? `Full insurance active — deploy ${top3Ins}. No new equity. Let positions work. Path 2 corrections average 18 months — do not deploy cash yet. USFR and SGOV stay put — they continue earning yield while insurance works. Do not sell cash instruments to fund insurance purchases — insurance should be sized from existing liquid positions, not by reducing cash.`
                : s.note;
              return (
                <>
                  {/* Pinned cash-floor banner — always visible regardless of regime */}
                  <div style={{ background: C.aBg, border: "1.5px solid " + C.aBdr, borderRadius: 12, padding: "11px 15px", color: C.amber, fontSize: 14, lineHeight: 1.6, fontWeight: 600 }}>
                    ⚠️ Cash floor: never below 25% of portfolio. No employment income requires maintained liquidity runway at all times. This floor does not change with regime.
                  </div>

                  {/* Portfolio value input (Fix F) */}
                  <Card>
                    <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                      <label htmlFor="pv-input" style={{ fontSize: 13, fontWeight: 700, color: C.mid, whiteSpace: "nowrap" }}>Total Portfolio Value</label>
                      <div style={{ display: "flex", alignItems: "center", border: "1.5px solid " + C.bdr, borderRadius: 8, padding: "6px 10px", background: C.bg, flex: "1 1 200px", maxWidth: 280 }}>
                        <span style={{ color: C.muted, fontSize: 15, fontWeight: 700, marginRight: 4 }}>$</span>
                        <input
                          id="pv-input" inputMode="numeric" placeholder="e.g. 500,000"
                          value={pv > 0 ? pv.toLocaleString("en-US") : ""}
                          onChange={e => updatePortfolioValue(e.target.value)}
                          style={{ border: "none", outline: "none", background: "transparent", fontSize: 15, fontWeight: 700, color: C.text, width: "100%" }}
                        />
                        <span style={{ color: C.lbl, fontSize: 12, fontWeight: 700, marginLeft: 4 }}>USD</span>
                      </div>
                      {pv > 0 && <Btn onClick={() => updatePortfolioValue("")} color={C.muted} bgColor={C.bg} label="Clear" />}
                    </div>
                    <div style={{ color: C.lbl, fontSize: 11, marginTop: 6 }}>Stored locally in your browser. Never transmitted.</div>
                  </Card>

                  {/* Header banner */}
                  <div style={{ background: activeRegime.bg, border: "1.5px solid " + activeRegime.bdr, borderRadius: 14, padding: "14px 18px", borderTop: "4px solid " + activeRegime.color }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: 2.5, textTransform: "uppercase", color: activeRegime.color, fontWeight: 700, marginBottom: 3 }}>Portfolio Posture · {activeRegime.label}</div>
                        <div style={{ fontSize: 16, fontWeight: 900, color: activeRegime.color }}>Allocation by bucket — driven by the active regime</div>
                      </div>
                      <div style={{ background: "#fff", border: "1.5px solid " + sigColor + "55", borderRadius: 10, padding: "6px 14px", textAlign: "center", minWidth: 90 }}>
                        <div style={{ color: C.lbl, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700 }}>Live Signal</div>
                        <div style={{ color: sigColor, fontSize: 17, fontWeight: 900, lineHeight: 1 }}>{sigLabel}</div>
                        <div style={{ color: sigColor, fontSize: 10, marginTop: 2, opacity: 0.8 }}>Stage {activeStage} active</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button onClick={() => setTab("indicators")} style={{ background: "#fff", color: activeRegime.color, border: "1.5px solid " + activeRegime.bdr, borderRadius: 8, padding: "5px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>📡 See Indicators tab for signals →</button>
                      <button onClick={() => setTab("insurance")} style={{ background: "#fff", color: activeRegime.color, border: "1.5px solid " + activeRegime.bdr, borderRadius: 8, padding: "5px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>🛡️ See Insurance tab for instruments →</button>
                      <button onClick={() => setTab("income")} style={{ background: "#fff", color: activeRegime.color, border: "1.5px solid " + activeRegime.bdr, borderRadius: 8, padding: "5px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>💰 See Income tab for yield ranking →</button>
                    </div>
                  </div>

                  {/* Allocation donut for the active regime */}
                  <Card>
                    <SLabel>Target Allocation · {activeRegime.label}</SLabel>
                    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                      <div style={{ flex: "0 0 200px", minWidth: 180, position: "relative" }}>
                        {pv > 0 && (
                          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                            <span style={{ color: C.lbl, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", fontWeight: 700 }}>Total</span>
                            <span style={{ color: C.text, fontSize: 18, fontWeight: 900, letterSpacing: -0.5 }}>{fmtCompact(pv)}</span>
                          </div>
                        )}
                        <ResponsiveContainer width="100%" height={200}>
                          <PieChart>
                            <Pie data={chartData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} dataKey="value" stroke="#fff" strokeWidth={2} paddingAngle={2}>
                              {chartData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                            </Pie>
                            <Tooltip content={function({ active, payload }) {
                              if (!active || !payload || !payload.length) return null;
                              const p = payload[0].payload;
                              return <div style={{ background: "#fff", border: "1px solid " + C.bdr, borderRadius: 8, padding: "8px 12px" }}>
                                <div style={{ fontWeight: 700, fontSize: 14 }}>{p.name}</div>
                                <div style={{ color: C.muted, fontSize: 13 }}>{p.range}</div>
                              </div>;
                            }} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 7 }}>
                        {chartData.map((d, i) => (
                          <div key={d.name} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                            <div style={{ width: 12, height: 12, borderRadius: 3, background: d.fill, flexShrink: 0 }} />
                            <span style={{ color: C.text, fontWeight: 600, flex: 1 }}>{d.name}</span>
                            <span style={{ color: C.muted, fontWeight: 700 }}>{d.range}</span>
                          </div>
                        ))}
                        <div style={{ color: C.lbl, fontSize: 11, marginTop: 2, lineHeight: 1.5 }}>Donut sizes by range mid-point; deepest shade = largest bucket. Ranges overlap by design — guard-rails, not a fixed sum.</div>
                      </div>
                    </div>
                    <div style={{ marginTop: 10, padding: "9px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, color: C.mid, fontSize: 13, lineHeight: 1.6 }}>
                      <b style={{ color: activeRegime.color }}>Long-term holds focus: </b>{alloc.categoryNote}
                    </div>
                  </Card>

                  {/* Bucket cards — single row on desktop, wrap below 900px (Fix B) */}
                  <div className="mwd-posture-row">
                    {POSTURE_BUCKET_META.map(m => {
                      const a = alloc[m.key];
                      const sc = POSTURE_STATUS[a.status] || POSTURE_STATUS.HOLD;
                      return (
                        <Card key={m.key} onClick={m.link ? () => setTab(m.link) : undefined} style={{ borderTop: "4px solid " + sc.color, cursor: m.link ? "pointer" : "default", minWidth: 0 }}>
                          {/* Header: title + subtitle take the full card width on their own lines; the status badge sits on its own line below — so the title never truncates or breaks beside the badge. */}
                          <div style={{ marginBottom: 8 }}>
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
                              <span style={{ fontSize: 20, flexShrink: 0, lineHeight: 1.2 }}>{m.icon}</span>
                              <strong style={{ fontSize: 15, fontWeight: 900, color: C.text, lineHeight: 1.2, minWidth: 0, overflowWrap: "break-word" }} title={m.name}>{m.name}</strong>
                            </div>
                            <div style={{ fontSize: 11, color: C.lbl, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={m.sub}>{m.sub}</div>
                            <span style={{ display: "inline-block", marginTop: 6, fontSize: 10, fontWeight: 800, letterSpacing: 0.3, padding: "2px 8px", borderRadius: 99, border: "1px solid " + sc.bdr, background: sc.bg, color: sc.color, whiteSpace: "nowrap" }}>{a.status}</span>
                          </div>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: dollarRange(a.range) ? 2 : 6, flexWrap: "wrap" }}>
                            <span style={{ fontSize: "clamp(18px, 2.2vw, 28px)", fontWeight: 900, letterSpacing: -1, color: sc.color, whiteSpace: "nowrap" }}>{a.range}</span>
                            <span style={{ color: C.lbl, fontSize: 12 }}>target allocation</span>
                          </div>
                          {dollarRange(a.range) && (
                            <div style={{ color: C.mid, fontSize: 13, fontWeight: 800, marginBottom: 6, whiteSpace: "nowrap" }}>{dollarRange(a.range)}</div>
                          )}
                          {/* Rate figures in authored prose resolve through the live cash yield
                              ({{CASH}}), so they can't go stale independently of the feed. */}
                          <div style={{ color: C.mid, fontSize: 12, lineHeight: 1.55 }}>{fillLiveRates(a.note, liveCashYield(liveInd))}</div>
                        </Card>
                      );
                    })}
                  </div>

                  {/* Deployment stage tracker */}
                  <Card>
                    <SLabel>Deployment Stage Tracker</SLabel>
                    <div style={{ color: C.muted, fontSize: 12, marginBottom: 8, lineHeight: 1.6 }}>
                      Stages 1–3 auto-trigger from the live signal (same thresholds as the Indicators action card). Stages 4–5 are manual judgment calls — toggle them as you act. Saved to this browser.
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {DEPLOY_STAGES.map(s => {
                        const isActive = s.n === activeStage;
                        const toggled = s.n === 4 ? stage4 : s.n === 5 ? stage5 : false;
                        return (
                          <div key={s.n} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, background: isActive ? activeRegime.bg : C.bg, border: "1.5px solid " + (isActive ? activeRegime.color : C.bdr) }}>
                            <div style={{ flexShrink: 0, width: 30, height: 30, borderRadius: "50%", background: isActive ? activeRegime.color : C.bdrMd, color: "#fff", fontWeight: 900, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" }}>{s.n}</div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
                                <span style={{ fontWeight: 800, fontSize: 14, color: isActive ? activeRegime.color : C.text }}>Stage {s.n}: {s.label}</span>
                                <span style={{ fontSize: 11, color: isActive ? activeRegime.color : C.lbl, fontWeight: 700 }}>{s.auto ? "Auto" : "Manual"} · {s.trigger}</span>
                              </div>
                              <div style={{ color: C.mid, fontSize: 13, lineHeight: 1.6, marginTop: 3 }}>{stageNote(s)}</div>
                              {s.n === 4 && (
                                <div style={{ marginTop: 6, padding: "7px 10px", background: C.surf, border: "1px solid " + C.bdr, borderRadius: 8, color: C.muted, fontSize: 12, lineHeight: 1.55 }}>
                                  <b style={{ color: C.mid }}>Trigger checklist before activating Stage 4:</b> (1) Fed has made first cut OR signalled cuts explicitly. (2) VIX has peaked and begun sustained decline from above 30. (3) HY credit spreads contracting from peak. (4) IEF purchased as rate duration bridge. All four should be present before deploying into equities.
                                </div>
                              )}
                              {isActive && <div style={{ marginTop: 4, color: activeRegime.color, fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase" }}>● Active now</div>}
                            </div>
                            {!s.auto && (
                              <button
                                onClick={() => (s.n === 4 ? toggleStage4() : toggleStage5())}
                                style={{
                                  flexShrink: 0, alignSelf: "center",
                                  background: toggled ? C.green : C.surf,
                                  color: toggled ? "#fff" : C.muted,
                                  border: "1.5px solid " + (toggled ? C.green : C.bdrMd),
                                  borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
                                }}
                              >
                                {toggled ? "✓ Active" : "Activate"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 10, color: C.lbl, fontSize: 12, lineHeight: 1.6 }}>
                      Stage 4 (Deploy) and Stage 5 (Full deployment) require judgment — confirm a VIX peak and a Fed pivot before activating. Toggles persist across sessions.
                    </div>
                  </Card>
                </>
              );
            })()}
          </div>
        )}

        {/* ── INSURANCE ── */}
        {tab === "insurance" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Item 4 — purpose line: the two tabs answer different questions. This one is about
                crash OUTCOMES, not the current regime. Item 5 — explicit macro→column link. */}
            {(() => {
              // Macro regimes that map to a crash-resolution column. inf (Inflationary Boom) and
              // ref (Reflationary Growth) are GROWTH regimes, not crashes — deliberately no map.
              const macroToCol = { stag: "stag", def: "def" };
              const mappedCol = macroToCol[liveRegime?.id] || null;
              const mappedPhase = mappedCol ? INSURANCE_PHASES.find(p => p.k === mappedCol) : null;
              const tapeHawkish = pbData?.us?.marketRegime?.state === "HAWKISH_RATES_REPRICING";
              // T2b — reactive best→worst insurance ranking for the LIVE regime, so opening the tab
              // immediately answers "given the regime, what's my best insurance and what to avoid."
              // Same rankKey the best→worst bars use elsewhere; growth regimes (inf/ref) still have a
              // real-asset ordering even though they aren't crash scenarios.
              const insRankKey = { stag: "stagRank", def: "defRank", ref: "refRank", inf: "infRank" }[liveRegime?.id] || "stagRank";
              const insRanked = [...ASSETS].sort((a, b) => (a[insRankKey] ?? 99) - (b[insRankKey] ?? 99));
              const insBest = insRanked.slice(0, 2);
              const insWorst = insRanked[insRanked.length - 1];
              return (
                <div style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 12, padding: "12px 16px" }}>
                  <div style={{ fontSize: 13.5, color: C.mid, lineHeight: 1.55 }}>
                    <b style={{ color: C.text }}>If a crash happens from here, how does it resolve — and what works in each case?</b>
                    <span style={{ color: C.muted }}> These columns are crash <i>outcomes</i>, not current-state regimes. (The Macro tab answers “what regime are we in right now?”)</span>
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
                    <span style={{ color: C.lbl, fontWeight: 700 }}>Live macro regime:</span>
                    <span style={{ color: liveRegime?.color, fontWeight: 800 }}>{liveRegime?.label} {regimeProbFor(liveRegime?.id)}%</span>
                    {mappedPhase ? (
                      <>
                        <span style={{ color: C.lbl }}>→</span>
                        <button onClick={() => pickInsurancePhase(mappedCol)} style={{ cursor: "pointer", background: mappedPhase.bg, color: mappedPhase.color, border: "1.5px solid " + mappedPhase.bdr, borderRadius: 6, padding: "3px 9px", fontWeight: 800, fontSize: 12 }}>
                          see {mappedPhase.label}
                        </button>
                      </>
                    ) : (
                      <span style={{ color: C.muted, fontStyle: "italic" }}>— a growth regime, not a crash scenario; the columns below are crash outcomes.</span>
                    )}
                    {tapeHawkish && (
                      <>
                        <span style={{ color: C.lbl }}>·</span>
                        <span style={{ color: C.lbl, fontWeight: 700 }}>today’s tape:</span>
                        <button onClick={() => pickInsurancePhase("hawkish")} style={{ cursor: "pointer", background: "#FFF7ED", color: "#B45309", border: "1.5px solid #FED7AA", borderRadius: 6, padding: "3px 9px", fontWeight: 800, fontSize: 12 }}>
                          Hawkish Rates Repricing → see column
                        </button>
                      </>
                    )}
                  </div>
                  {/* T2b — best→worst insurance for the live regime, so the tab opens on the answer. */}
                  <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid " + C.bdr, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 12.5 }}>
                    <span style={{ color: C.lbl, fontWeight: 700 }}>In this regime →</span>
                    <span style={{ color: C.muted, fontWeight: 700 }}>best:</span>
                    {insBest.map(a => (
                      <span key={a.id} style={{ background: C.surf2 || C.surf, border: "1.5px solid " + C.bdr, borderRadius: 6, padding: "2px 8px", fontWeight: 800, color: C.text }}>
                        {a.icon} {a.name}
                      </span>
                    ))}
                    <span style={{ color: C.lbl }}>·</span>
                    <span style={{ color: C.muted, fontWeight: 700 }}>avoid:</span>
                    <span style={{ background: "#FEF2F2", border: "1.5px solid #FECACA", borderRadius: 6, padding: "2px 8px", fontWeight: 800, color: "#B91C1C" }}>
                      {insWorst.icon} {insWorst.name}
                    </span>
                    <span style={{ color: C.muted, fontStyle: "italic", fontSize: 11.5 }}>ranked for {liveRegime?.label} — full order in the best→worst bar below</span>
                  </div>
                </div>
              );
            })()}
            {/* Crash Scenario Guide — TOP of page. Static ratings (regime-independent);
                the column headers ARE the scenario selector. Picking a column
                drives the phase-note callouts in the instrument detail below. */}
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                <SLabel>Crash Scenario Guide</SLabel>
                <span style={{ color: C.lbl, fontSize: 12 }}>Pick the PHASE, then the column ↓</span>
              </div>
              {/* P1.3 — phase-dimension selector: pick the phase first, resolution expands to four. */}
              <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>Phase</span>
                {["preCrash", "liquidity", "recovery", "resolution"].map(dim => {
                  const on = insDimOf(insurancePhase) === dim;
                  return (
                    <button key={dim} onClick={() => pickInsurancePhase(INS_PHASE_DIMS[dim][0])} style={{
                      background: on ? C.blue : C.surf, color: on ? "#fff" : C.mid,
                      border: "1.5px solid " + (on ? C.blue : C.bdr), borderRadius: 8,
                      padding: "6px 14px", fontSize: 12.5, fontWeight: 800, cursor: "pointer", opacity: on ? 1 : 0.7,
                    }}>{on ? "● " : ""}{INS_DIM_LABELS[dim]}{dim === "resolution" ? " ▾" : ""}</button>
                  );
                })}
                {insDimOf(insurancePhase) === "resolution" && (
                  <span style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>→ Deflationary · Debasement · Stagflation · Hawkish</span>
                )}
              </div>
              {/* A3 — vol-regime auto-suggest. Unpinned: the phase follows the VIX term structure (+ OAS
                  trend). Pinned: show a divergence banner when the signal disagrees, with a follow-signal
                  action — same pattern as the regime pin. */}
              {insuranceSuggest && (() => {
                const sp = INSURANCE_PHASES.find(p => p.k === insuranceSuggest.phase);
                const diverged = insurancePinned && insuranceSuggest.phase !== insurancePhase;
                if (!sp) return null;
                return (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10, padding: "7px 11px", borderRadius: 8,
                    background: diverged ? C.aBg : C.surf, border: "1px solid " + (diverged ? C.aBdr : C.bdr) }}>
                    <span style={{ fontSize: 11.5, color: C.muted, fontWeight: 700 }}>{diverged ? "⚠️ Vol regime suggests" : "📡 Vol regime →"}</span>
                    <button onClick={() => pickInsurancePhase(sp.k)} style={{ cursor: "pointer", background: sp.bg, color: sp.color, border: "1.5px solid " + sp.bdr, borderRadius: 6, padding: "2px 8px", fontWeight: 800, fontSize: 11.5 }}>{sp.short}</button>
                    <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>{insuranceSuggest.why}</span>
                    {!insurancePinned && <span style={{ fontSize: 10.5, color: C.green, fontWeight: 800 }}>· auto (following signal)</span>}
                    {diverged && <button onClick={followInsuranceSignal} style={{ cursor: "pointer", background: C.green, color: "#fff", border: "none", borderRadius: 6, padding: "2px 9px", fontWeight: 800, fontSize: 11 }}>Follow signal</button>}
                    {insurancePinned && !diverged && <span style={{ fontSize: 10.5, color: C.muted, fontWeight: 700 }}>· pinned (matches)</span>}
                  </div>
                );
              })()}
              {(() => { const shownPhases = INSURANCE_PHASES.filter(p => INS_PHASE_DIMS[insDimOf(insurancePhase)].includes(p.k)); return (
              <div style={{ overflowX: "auto", width: "100%" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: shownPhases.length > 1 ? 780 : 420, fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", color: C.mid, padding: "6px 10px", borderBottom: "1.5px solid " + C.bdr, fontWeight: 700, width: 168, minWidth: 168 }}>Instrument</th>
                      {shownPhases.map(p => {
                        const on = insurancePhase === p.k;
                        return (
                          <th key={p.k} style={{ padding: 0, minWidth: 150, borderBottom: "1.5px solid " + (on ? p.color : C.bdr) }}>
                            <button onClick={() => pickInsurancePhase(p.k)} title={p.desc} style={{
                              width: "100%", cursor: "pointer", border: "none", whiteSpace: "nowrap",
                              background: on ? p.color : "transparent",
                              color: on ? "#fff" : p.color,
                              fontWeight: 800, fontSize: 12, padding: "8px 10px", lineHeight: 1.25,
                              borderTopLeftRadius: 6, borderTopRightRadius: 6,
                            }}>
                              {on ? "● " : ""}{p.short}
                            </button>
                            {p.size && (
                              <div style={{ textAlign: "center", padding: "2px 6px 4px", background: on ? p.bg : "transparent" }} title={"Insurance sizing this phase: " + p.size.note}>
                                <span style={{ fontSize: 11, fontWeight: 800, color: p.color, letterSpacing: 0.2 }}>🎯 {p.size.band}</span>
                              </div>
                            )}
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {SCENARIO_MATRIX.flatMap((r, ri) => {
                      const showGroup = ri === 0 || SCENARIO_MATRIX[ri - 1].group !== r.group;
                      const rows = [];
                      if (showGroup) rows.push(
                        <tr key={"grp-" + r.group}>
                          <td colSpan={1 + shownPhases.length} style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#999", textTransform: "uppercase", padding: "10px 12px 4px", backgroundColor: "transparent", borderBottom: "none" }}>
                            {r.group}
                          </td>
                        </tr>
                      );
                      rows.push(
                        <tr key={r.row} style={{ background: ri % 2 === 0 ? C.surf : C.bg }}>
                          <td style={{ padding: "6px 10px", color: C.text, fontWeight: 600, borderBottom: "1px solid " + C.bdr, width: 168, minWidth: 168 }}>
                            {r.row}
                            {r.benchmark && <span style={{ display: "inline-block", marginLeft: 5, fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: "#1D4ED8", background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 4, padding: "1px 4px", verticalAlign: "middle" }} title="Benchmark — not investable in this account">Benchmark · not investable</span>}
                            {r.note && <div style={{ fontSize: 11, color: C.lbl, fontWeight: 400, lineHeight: 1.45, marginTop: 3 }} title={r.note}>{r.note.length > 90 ? r.note.slice(0, 88) + "…" : r.note}</div>}
                          </td>
                          {shownPhases.map(p => {
                            const on = insurancePhase === p.k;
                            const act = cellAction(r[p.col], p.col, r.row);
                            const st = actStyle(act);
                            const cc = (r.carryBy && r.carryBy[p.col]) || r.carry;
                            const hl = HOLD_LOGIC[r.cat];
                            return (
                              <td key={p.k} style={{ textAlign: "center", padding: "8px 10px", minWidth: 150, borderBottom: "1px solid " + C.bdr, background: on ? p.bg : "transparent" }}>
                                <div style={{ fontSize: 14, fontWeight: on ? 800 : 400 }}>{r[p.col]}</div>
                                {act && <div style={{ marginTop: 4, display: "inline-block", fontSize: 10, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: st.color, background: st.bg, border: "1px solid " + st.bdr, borderRadius: 4, padding: "1px 5px", lineHeight: 1.35 }}>{act}</div>}
                                {on && hl && (
                                  <div style={{ marginTop: 5, fontSize: 10.5, color: C.lbl, fontWeight: 600, lineHeight: 1.45, whiteSpace: "normal", maxWidth: 150, margin: "4px auto 0" }} title={"Hold: " + hl.horizon + " · Exit: " + hl.exit}>⏳ {hl.horizonShort} · exit: {hl.exitShort}</div>
                                )}
                                {on && cc && (
                                  <div style={{ marginTop: 4, fontSize: 10.5, color: C.muted, fontWeight: 400, lineHeight: 1.45, whiteSpace: "normal", maxWidth: 150, margin: "3px auto 0" }} title={"Carry: " + cc}>{cc}</div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                      return rows;
                    })}
                  </tbody>
                </table>
              </div>
              ); })()}
              <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>Rating</span>
                {[["✅✅", "Primary instrument"], ["✅", "Works well"], ["⚠️", "Caution / timing-dependent"], ["❌", "Avoid (don't buy)"], ["🔻", "Sell / unwind — a held hedge that's now a drag"]].map(([sym, lbl]) => (
                  <div key={lbl} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12, color: C.muted }}>
                    <span style={{ fontSize: 13 }}>{sym}</span>{lbl}
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>Action</span>
                {[["INITIATE", "open now"], ["BUY", "off the trough"], ["STAGE / ON PIVOT / DEPLOY", "on the trigger"], ["HOLD", "keep, don't chase"], ["WAIT / CONDITIONAL / TRIM", "not yet"], ["SELL", "unwind now"], ["AVOID", "stay out"]].map(([a, lbl]) => {
                  const st = actStyle(a.split(" / ")[0]);
                  return (
                    <div key={a} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 11.5, color: C.muted }}>
                      <span style={{ fontSize: 8.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: st.color, background: st.bg, border: "1px solid " + st.bdr, borderRadius: 4, padding: "1px 5px" }}>{a}</span>{lbl}
                    </div>
                  );
                })}
              </div>
              <div style={{ marginTop: 6, fontSize: 11, color: C.muted, fontStyle: "italic" }}>
                Selected column also shows each row's <b style={{ fontStyle: "normal", color: C.lbl }}>⏳ hold horizon · exit trigger</b> and <b style={{ fontStyle: "normal", color: C.lbl }}>carry</b> (cost to hold). Most insurance P&L is lost holding the right hedge past its window — the exit rule matters as much as the rating.
              </div>
              {/* D4 — farmland caveat: the investable REIT is not the land. NCREIF (the unleveraged
                  index) is dropped from the matrix because it isn't investable in this account. */}
              <div style={{ marginTop: 8, padding: "8px 11px", background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, fontSize: 11.5, color: C.mid, lineHeight: 1.55 }}>
                🌾 <b>Farmland — the REIT is not the land:</b> LAND / FPI are equities that <i>own</i> farmland. In 2022 the unleveraged NCREIF index returned <b>+9.64%</b> while FPI <b>fell &gt;14%</b> — the wrapper adds leverage, small-cap beta, an unrelated NAV-discount driver, and US-situs estate exposure. (Direct NCREIF access needs US accreditation + a ~10yr horizon — not investable here, so it's left off the matrix.)
              </div>
              {/* Active scenario summary + live-signal lean (informational; your call) */}
              {(() => {
                const active = INSURANCE_PHASES.find(p => p.k === insurancePhase) || INSURANCE_PHASES[0];
                const read = getCrashSignalRead(liveInd || {}, activeRegime);
                return (
                  <div style={{ marginTop: 12, padding: "10px 13px", background: active.bg, border: "1.5px solid " + active.bdr, borderRadius: 8 }}>
                    <div style={{ color: active.color, fontWeight: 800, fontSize: 13, marginBottom: 3 }}>Planning for: {active.label}</div>
                    <div style={{ color: C.mid, fontSize: 13, lineHeight: 1.6 }}>{active.desc}</div>
                    {active.size && (
                      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 7 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: active.color, textTransform: "uppercase", letterSpacing: 0.4 }}>🎯 Insurance sizing</span>
                        <span style={{ fontSize: 13, fontWeight: 900, color: C.text }}>{active.size.band}</span>
                        <span style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.55 }}>— {active.size.note}</span>
                      </div>
                    )}
                    <div style={{ color: C.muted, fontSize: 12, fontStyle: "italic", marginTop: 6, lineHeight: 1.55 }}>
                      Live signals lean toward: <b style={{ fontStyle: "normal", color: C.text }}>{read.lean}</b> — {read.reason}. Your call — set the column you believe.
                    </div>
                  </div>
                );
              })()}
              {/* C3 — "already in it" logic: if you didn't buy protection before the liquidity phase,
                  buying it now is expensive and late. Raise cash and prepare the recovery buy instead. */}
              {insurancePhase === "liquidity" && (
                <div style={{ marginTop: 10, padding: "10px 13px", background: C.aBg, border: "1.5px solid " + C.aBdr, borderRadius: 8 }}>
                  <div style={{ color: C.amber, fontWeight: 800, fontSize: 12.5, marginBottom: 3 }}>⚠️ Already in the drawdown, no protection on?</div>
                  <div style={{ color: C.mid, fontSize: 12.5, lineHeight: 1.6 }}>
                    Buying protection now is <b>expensive and late</b> — IV has already repriced, so puts and VIX calls are a poor purchase here. Don't chase the hedge. <b>Raise cash and prepare the recovery buy</b> (miners · BTC · equities) for the moment the VIX term structure flips back to contango.
                  </div>
                </div>
              )}
              {/* B5 — the conversion map. The point of insurance is not to profit on the hedge; it is to
                  FUND the recovery buy. Rendered as its own panel on the Recovery phase. */}
              {insurancePhase === "recovery" && (
                <div style={{ marginTop: 10, padding: "12px 14px", background: "#ECFDF5", border: "1.5px solid #A7F3D0", borderRadius: 10, borderTop: "4px solid #047857" }}>
                  <div style={{ color: "#047857", fontWeight: 900, fontSize: 13.5, letterSpacing: 0.3, marginBottom: 2 }}>AT THE VIX PEAK — sell these, buy those</div>
                  <div style={{ color: C.muted, fontSize: 11.5, fontStyle: "italic", marginBottom: 10 }}>Trigger: VIX term structure flips backwardation → contango. The hedge doesn't need to profit — it needs to fund the buy.</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                    {[
                      { head: "🔻 SELL", tint: "#BE123C", bg: "#FFF1F2", bd: "#FECDD3", items: "VIX calls · SPY/QQQ puts · HYG puts · SQQQ", sub: "vol collapse + IV crush — the most expensive things to hold here" },
                      { head: "✅ BUY", tint: "#047857", bg: "#ECFDF5", bd: "#A7F3D0", items: "Gold miners · BTC · equities", sub: "highest beta to returning liquidity — miners lead off the trough" },
                      { head: "🔷 DEPLOY", tint: "#1D4ED8", bg: "#EFF6FF", bd: "#BFDBFE", items: "Cash → the above", sub: "the sale proceeds and dry powder fund the recovery buy" },
                    ].map(c => (
                      <div key={c.head} style={{ background: c.bg, border: "1.5px solid " + c.bd, borderRadius: 8, padding: "9px 11px" }}>
                        <div style={{ color: c.tint, fontWeight: 900, fontSize: 12.5, marginBottom: 3 }}>{c.head}</div>
                        <div style={{ color: C.text, fontWeight: 700, fontSize: 12.5, lineHeight: 1.45 }}>{c.items}</div>
                        <div style={{ color: C.muted, fontSize: 10.5, marginTop: 3, lineHeight: 1.4 }}>{c.sub}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Regime-aware context banner — best→worst ranking for the active macro regime */}
            {(() => {
              const rankKey = { stag: "stagRank", def: "defRank", ref: "refRank", inf: "infRank" }[activeRegime.id] || "stagRank";
              const sorted = [...ASSETS].sort((a, b) => (a[rankKey] || 9) - (b[rankKey] || 9));
              return (
                <div style={{ background: activeRegime.bg, border: "1.5px solid " + activeRegime.bdr, borderRadius: 14, padding: "14px 18px", borderTop: "4px solid " + activeRegime.color }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: 2.5, textTransform: "uppercase", color: activeRegime.color, fontWeight: 700, marginBottom: 3 }}>Active Regime · context</div>
                      <div style={{ fontSize: 17, fontWeight: 900, color: activeRegime.color }}>{activeRegime.label} — Best → Worst Insurance</div>
                    </div>
                    <Pill label={"Switch regime on Macro tab"} color={activeRegime.color} />
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {sorted.map((a, i) => (
                      <button key={a.id} onClick={() => setActiveAsset(a)} style={{
                        background: a.bg, color: a.color, border: "1.5px solid " + a.bdr,
                        borderRadius: 8, padding: "6px 12px", fontWeight: 800, fontSize: 14, cursor: "pointer",
                      }}>
                        #{i + 1} {a.icon} {a.name}
                      </button>
                    ))}
                  </div>
                  {activeRegime.id === "stag" && (
                    <div style={{ marginTop: 10, color: activeRegime.color, fontSize: 14, lineHeight: 1.6 }}>
                      ⚠️ TLT dropped 30%+ in 2022 stagflation. Long bonds are the worst insurance when inflation is embedded. Physical gold and staples lead; the gold-linked miners follow (a cautioned, leveraged expression, not a hedge).
                    </div>
                  )}
                  {activeRegime.id === "def" && (
                    <div style={{ marginTop: 10, color: activeRegime.color, fontSize: 14, lineHeight: 1.6 }}>
                      📉 Deflation/recession: TLT is #1 insurance. Demand collapses, rates fall hard, gold acts as safe haven. Miners underperform until Fed pivots.
                    </div>
                  )}
                  {activeRegime.id === "ref" && (
                    <div style={{ marginTop: 10, color: activeRegime.color, fontSize: 14, lineHeight: 1.6 }}>
                      🌱 Reflationary growth: Staples and farmland outperform. Miners lag as gold safe-haven bid fades. TLT vulnerable to rising rates.
                    </div>
                  )}
                  {activeRegime.id === "inf" && (
                    <div style={{ marginTop: 10, color: activeRegime.color, fontSize: 14, lineHeight: 1.6 }}>
                      🔥 Inflationary boom: Physical gold is the best insurance; BTC and the gold-linked miners follow. Bonds are toxic. Real assets dominate — the leveraged farmland REIT lags the metals (2022: GDX −9% vs FPI −14%).
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Asset selector — sorted by active regime rank */}
            {(() => {
              const rankKey = { stag: "stagRank", def: "defRank", ref: "refRank", inf: "infRank" }[activeRegime.id] || "stagRank";
              const sorted = [...ASSETS].sort((a, b) => (a[rankKey] || 9) - (b[rankKey] || 9));
              return (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", width: "100%" }}>
                    {sorted.map((a, i) => (
                      <button key={a.id} onClick={() => setActiveAsset(a)} style={{
                        // All-longhand borders — a `border` shorthand toggling on selection was
                        // dropping the constant 4px `borderLeft` accent on click. See fund selector.
                        background: activeAsset.id === a.id ? a.bg : C.surf,
                        borderStyle: "solid",
                        borderTopWidth: 1.5, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderLeftWidth: 4,
                        borderTopColor: activeAsset.id === a.id ? a.color : C.bdr,
                        borderRightColor: activeAsset.id === a.id ? a.color : C.bdr,
                        borderBottomColor: activeAsset.id === a.id ? a.color : C.bdr,
                        borderLeftColor: a.color,
                        borderRadius: 10, padding: "10px 12px", cursor: "pointer", textAlign: "left",
                        flex: "1 1 130px",
                        boxShadow: activeAsset.id === a.id ? "0 2px 10px " + a.color + "20" : "none",
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                          <span style={{ fontSize: 19 }}>{a.icon}</span>
                          <span style={{ background: activeRegime.bg, color: activeRegime.color, border: "1px solid " + activeRegime.bdr, borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 800 }}>#{i + 1}</span>
                        </div>
                        <div style={{ color: a.color, fontWeight: 800, fontSize: 13 }}>{a.name}</div>
                        <div style={{ color: C.lbl, fontSize: 11, marginTop: 3 }}>{activeRegime.label}</div>
                      </button>
                    ))}
                  </div>
                  <div style={{ width: "100%" }}>
                    <AssetDetail asset={activeAsset} prices={prices} onFetchPrices={fetchPrices} pricesLoading={pricesLoading} pricesUpdated={pricesUpdated} phase={insurancePhase} />
                  </div>
                </div>
              );
            })()}

          </div>
        )}

        {/* ── INCOME ── */}
        {tab === "income" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Regime-aware banner */}
            {(() => {
              const rankKey = { stag: "rank", def: "defRank", ref: "refRank", inf: "infRank" }[activeRegime.id] || "rank";
              const sorted = [...INCOME_PLAYS].sort((a, b) => (a[rankKey] || 9) - (b[rankKey] || 9));
              const proofLabel = { stag: "stagflation-proof", def: "deflation-resilient", ref: "growth-aligned", inf: "inflation-proof" }[activeRegime.id] || "resilient";
              return (
                <div style={{ background: activeRegime.bg, border: "1.5px solid " + activeRegime.bdr, borderRadius: 14, padding: "14px 18px", borderTop: "4px solid " + activeRegime.color }}>
                  <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: 2.5, textTransform: "uppercase", color: activeRegime.color, fontWeight: 700, marginBottom: 3 }}>Active Regime · {activeRegime.label}</div>
                      <div style={{ fontSize: 15, fontWeight: 900, color: activeRegime.color }}>Income ranked best → worst for this regime</div>
                    </div>
                    <Pill label={"Change regime on Macro tab"} color={activeRegime.color} />
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {sorted.map((p, i) => {
                      const rankVal = p[rankKey] || i + 1;
                      const isTop = rankVal <= 2;
                      const isBottom = rankVal >= 5;
                      const dotColor = isTop ? C.green : isBottom ? C.red : C.amber;
                      return (
                        <button key={p.category} onClick={() => setActiveIncome(p)} style={{
                          background: "#fff", color: dotColor, border: "1.5px solid " + dotColor + "50",
                          borderRadius: 8, padding: "4px 10px", fontWeight: 700, fontSize: 13, cursor: "pointer",
                          display: "flex", alignItems: "center", gap: 5,
                        }}>
                          <span style={{ fontSize: 15 }}>{isTop ? "✅" : isBottom ? "⚠️" : "◐"}</span>
                          #{rankVal} {p.icon} {p.category.split(" / ")[0]}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 10, color: activeRegime.color, fontSize: 13, lineHeight: 1.6 }}>
                    {{
                      stag: "Stagflation: pipelines + T-bills + REITs dominate. Avoid covered calls (capped upside in volatile regime). MLPs pass inflation through contracts.",
                      def:  "Deflation/recession: Cash (#1) is king — 4%+ risk-free while everything else reprices. Aristocrats (#2) hold dividends. Avoid pipelines (oil demand collapse) and covered calls.",
                      ref:  "Reflationary growth: REITs rally on rate cuts (#1). Aristocrats grow dividends with the economy (#2). Covered calls work in low-vol environment (#3).",
                      inf:  "Inflationary boom: pipelines pass through inflation via contract escalators (#1). Covered calls generate income in volatile market (#2). Cash erodes in real terms — avoid.",
                    }[activeRegime.id]}
                  </div>
                </div>
              );
            })()}

            {/* Category selector + detail — sorted by active regime */}
            {(() => {
              const rankKey = { stag: "rank", def: "defRank", ref: "refRank", inf: "infRank" }[activeRegime.id] || "rank";
              const sorted = [...INCOME_PLAYS].sort((a, b) => (a[rankKey] || 9) - (b[rankKey] || 9));
              return (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", width: "100%" }}>
                    {sorted.map((p, i) => {
                      const rankVal = p[rankKey] || i + 1;
                      return (
                        <button key={p.category} onClick={() => setActiveIncome(p)} style={{
                          // All-longhand borders — see fund/asset selectors; the shorthand+longhand
                          // mix dropped the 4px left accent on click.
                          background: activeIncome.category === p.category ? p.bg : C.surf,
                          borderStyle: "solid",
                          borderTopWidth: 1.5, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderLeftWidth: 4,
                          borderTopColor: activeIncome.category === p.category ? p.color + "60" : C.bdr,
                          borderRightColor: activeIncome.category === p.category ? p.color + "60" : C.bdr,
                          borderBottomColor: activeIncome.category === p.category ? p.color + "60" : C.bdr,
                          borderLeftColor: p.color,
                          borderRadius: 10, padding: "10px 12px", cursor: "pointer", textAlign: "left", flex: "1 1 120px",
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                            <span style={{ fontSize: 17 }}>{p.icon}</span>
                            <span style={{ background: activeRegime.bg, color: activeRegime.color, border: "1px solid " + activeRegime.bdr, borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 800 }}>#{rankVal}</span>
                          </div>
                          <div style={{ color: p.color, fontWeight: 700, fontSize: 12, lineHeight: 1.3 }}>{p.category}</div>
                          <div style={{ color: C.lbl, fontSize: 11, marginTop: 3 }}>{p.yieldRange}</div>
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
                    <Card style={{ borderTop: "4px solid " + activeIncome.color }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 24 }}>{activeIncome.icon}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 19, fontWeight: 900, color: activeIncome.color }}>{activeIncome.category}</div>
                          <div style={{ color: C.muted, fontSize: 14 }}>Yield range: {activeIncome.yieldRange}</div>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {(() => {
                            const rankKey = { stag: "rank", def: "defRank", ref: "refRank", inf: "infRank" }[activeRegime.id] || "rank";
                            const rv = activeIncome[rankKey] || "?";
                            const isTop = rv <= 2; const isBot = rv >= 5;
                            const col = isTop ? C.green : isBot ? C.red : C.amber;
                            const bg  = isTop ? C.gBg  : isBot ? C.rBg  : C.aBg;
                            const bd  = isTop ? C.gBdr : isBot ? C.rBdr : C.aBdr;
                            return <Pill label={"#" + rv + " in " + activeRegime.label} color={col} bg={bg} bdr={bd} />;
                          })()}
                          {activeIncome.stagProof
                            ? <Pill label="✅ Stagflation-proof" color={C.green} bg={C.gBg} bdr={C.gBdr} />
                            : <Pill label="⚠️ Conditional" color={C.amber} bg={C.aBg} bdr={C.aBdr} />
                          }
                        </div>
                      </div>
                      <p style={{ color: C.mid, fontSize: 15, lineHeight: 1.75, margin: "0 0 12px" }}>{activeIncome.why}</p>
                      <div style={{ background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, padding: "10px 13px", marginBottom: 10 }}>
                        <span style={{ color: C.blue, fontWeight: 700, fontSize: 13 }}>🌍 Global family: </span>
                        <span style={{ color: C.mid, fontSize: 14 }}>{activeIncome.globalNote}</span>
                      </div>
                      <div style={{ background: C.rBg, border: "1px solid " + C.rBdr, borderRadius: 8, padding: "10px 13px" }}>
                        <span style={{ color: C.red, fontWeight: 700, fontSize: 13 }}>⚠️ Risks: </span>
                        <span style={{ color: C.mid, fontSize: 14 }}>{activeIncome.risks}</span>
                      </div>
                    </Card>

                    <Card>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                        <SLabel>Tickers + Live Yields</SLabel>
                        <Btn onClick={() => fetchPrices(activeIncome.tickers.map(t => t.t))} disabled={pricesLoading} color="#fff" bgColor={C.green} label={pricesLoading ? "Loading…" : "🔄 Prices"} />
                      </div>
                      {activeIncome.tickers.map((tk, i) => (
                        <div key={tk.t} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: i < activeIncome.tickers.length - 1 ? "1px solid " + C.bdr : "none", alignItems: "flex-start" }}>
                          <div style={{ flexShrink: 0, width: 70 }}>
                            <span title={tk.t} style={{ background: activeIncome.bg, color: activeIncome.color, border: "1.5px solid " + activeIncome.color + "40", borderRadius: 6, padding: "3px 5px", fontSize: tk.t.length > 8 ? 9 : tk.t.length > 5 ? 11 : 13, fontWeight: 800, display: "block", textAlign: "center", whiteSpace: "nowrap", maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis" }}>{tk.t}</span>
                            {/* Rate-linked cash vehicles (BIL/SGOV/USFR) resolve their yield from
                                the live short rate rather than a hardcoded string — they all track
                                the same T-bill curve, so one live number keeps them consistent.
                                Equity/MLP yields below stay authored: they aren't rate-driven. */}
                            {(() => {
                              const cy = tk.rateLinked ? liveCashYield(liveInd) : null;
                              const txt = tk.rateLinked ? (cy ? `~${cy.value.toFixed(2)}%` : "—") : tk.yield;
                              if (!txt) return null;
                              return (
                                <span title={tk.rateLinked ? (cy ? `live ${cy.src}${cy.asOf ? " · " + cy.asOf : ""} — tracks the T-bill curve` : "no live short rate available") : "authored estimate"}
                                  style={{ background: C.gBg, color: C.green, border: "1px solid " + C.gBdr, borderRadius: 4, padding: "1px 5px", fontSize: 11, fontWeight: 700, display: "block", textAlign: "center", marginTop: 3 }}>
                                  {txt}{tk.rateLinked && cy ? "*" : ""}
                                </span>
                              );
                            })()}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                              <span style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>
                                <RegionBadge ticker={tk.t} />
                                {tk.name}
                                {tk.link && !String(tk.t).endsWith(".AE") && <a href={tk.link} target="_blank" rel="noopener noreferrer" title="Exchange" style={{ marginLeft: 5, fontSize: 12, textDecoration: "none" }}>🔗</a>}
                              </span>
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                                <PriceBadge ticker={tk.t} prices={prices} />
                                {prices[tk.t]?.dividendYield > 0 && (
                                  <span title="Trailing 12-month dividend yield" style={{ fontSize: 11, color: "#22c55e", fontWeight: 600 }}>
                                    {(prices[tk.t].dividendYield * 100).toFixed(1)}% yield
                                  </span>
                                )}
                              </div>
                            </div>
                            <div style={{ color: C.muted, fontSize: 14, marginTop: 3, lineHeight: 1.6 }}>{fillLiveRates(tk.note, liveCashYield(liveInd))}</div>
                          </div>
                        </div>
                      ))}
                    </Card>
                  </div>
                </div>
              );
            })()}

            {/* Broad-market UAE access note */}
            <div style={{ background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 10, padding: "11px 14px", color: C.mid, fontSize: 13, lineHeight: 1.6 }}>
              <span style={{ color: C.blue, fontWeight: 700 }}>🇦🇪 Broad UAE access — iShares MSCI UAE ETF (ticker: UAE): </span>
              US-listed ETF covering ADX + DFM blue chips. Use for single-ticket UAE market access via IBKR. Accessible via the Yahoo Finance price feed.
            </div>

          </div>
        )}

        {/* ── SMART MONEY ── */}
        {tab === "smartmoney" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* 13F limitation header — states plainly what this data is and is NOT, so an absent
                cell isn't read as "no position" and a non-13F row isn't read as 13F. */}
            <div style={{ background: C.aBg, border: "1.5px solid " + C.aBdr, borderRadius: 12, padding: "11px 15px", color: C.amber, fontSize: 13.5, lineHeight: 1.6 }}>
              <div style={{ fontWeight: 800, marginBottom: 3 }}>⚠️ This is {MATRIX_13F.label} data — positions as of {MATRIX_13F.positionsAsOf}, filed {MATRIX_13F.filed}. Label it as of quarter-end, not current.</div>
              <div style={{ fontWeight: 500 }}>
                13F shows <b>long US-listed equity positions as of quarter-end</b> and arrives up to 45 days later (~6 weeks stale on arrival — the July memory crash, Iran de-escalation and yen intervention are all invisible here). Shorts, cash, bonds, options and foreign-listed securities are <b>not disclosed</b>; absence from a row may mean a position isn't reportable, not that it doesn't exist. The <b>Cash / T-Bills</b> and <b>Macro Hedges</b> rows come from 10-Q / manager disclosure, not 13F, and carry their own as-of. All 6 US 13F filers are in for Q2; <b>Pershing Square now files via its public parent Pershing Square Inc.</b> (Capital Management filed a 13F-NT notice) and <b>Fairfax</b> is not a US 13F filer — both flagged on their cards.
              </div>
            </div>
            {/* B5 — Fed context the snapshot lacks. The book was set on Jun 30; the Fed path has moved
                since, and the positioning reads differently against it. */}
            <div style={{ padding: "8px 11px", background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, fontSize: 11.5, color: C.mid, lineHeight: 1.6 }}>
              <b style={{ color: C.blue }}>Fed context since Jun 30: </b>
              September hike odds <b>≈31%</b> (from ≈57% on the July decision day) after three soft prints in a week (jobs, CPI, PPI); consensus moved from two 2026 hikes to one. July FOMC was a <b>9–3 hold</b> with three regional presidents dissenting <i>for</i> a hike, and the Aug 19 minutes recorded "many participants" saw tightening as likely necessary — <b>more hawkish than the three dissents implied</b>. The book below was set before all of this.
            </div>
            {/* Cross-Fund Positioning Matrix — rendered above the fund selector (Fix 3) */}
            <Card>
              <SLabel>Cross-Fund Positioning Matrix</SLabel>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 500 }}>
                  <thead>
                    <tr style={{ background: C.bg }}>
                      <th style={{ textAlign: "left", color: C.mid, padding: "9px 12px", borderBottom: "2px solid " + C.bdr, fontSize: 13, fontWeight: 700 }}>Theme</th>
                      {funds.map(f => (
                        <th key={f.id} style={{ textAlign: "center", color: f.color, padding: "9px 8px", borderBottom: "2px solid " + C.bdr, fontSize: 12, fontWeight: 800 }}>{f.name.split(" ")[0]}</th>
                      ))}
                      <th style={{ textAlign: "left", color: C.lbl, padding: "9px 8px", borderBottom: "2px solid " + C.bdr, fontSize: 11 }}>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {CONSENSUS_ROWS.map((row, ri) => {
                      const tag = SOURCE_TAGS[row.source] || SOURCE_TAGS["13F"];
                      const is13F = row.source === "13F" || row.source === "13F+mgr";
                      // 13F rows show BOTH dates (positions-as-of + filed); non-13F rows show their own.
                      const dateLine = is13F
                        ? `pos ${MATRIX_13F.positionsAsOf} · filed ${MATRIX_13F.filed}`
                        : (row.asOf || "");
                      return (
                      <tr key={row.theme} style={{ background: ri % 2 === 0 ? C.surf : C.bg }}>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid " + C.bdr }}>
                          <div style={{ color: C.text, fontSize: 14, fontWeight: 600 }}>{row.theme}</div>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 9.5, fontWeight: 800, color: "#fff", background: tag.col, borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>{tag.label}</span>
                            <span style={{ fontSize: 10.5, color: C.lbl, whiteSpace: "nowrap" }}>{dateLine}</span>
                          </div>
                        </td>
                        {row.vals.slice(0, funds.length).map((v, i) => {
                          // ▨ = Withheld (manager filed for confidential treatment — a position exists
                          // but is delayed), deliberately distinct from ◯ Absent (no reportable position).
                          const col = v === "●" || v === "●●" ? "#166534" : v === "◐" ? "#D97706" : v === "✕" ? "#991B1B" : v === "▨" ? "#475569" : C.bdrMd;
                          return <td key={i} style={{ textAlign: "center", padding: "9px 8px", color: col, fontSize: 17, borderBottom: "1px solid " + C.bdr }}>{v}</td>;
                        })}
                        <td style={{ padding: "9px 8px", color: C.muted, fontSize: 12, borderBottom: "1px solid " + C.bdr }}>{row.note}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                {[["#166534","● Active"],["#D97706","◐ Partial"],["#991B1B","✕ Short/exit"],[C.bdrMd,"◯ Absent"],["#475569","▨ Withheld"]].map(([col, lbl]) => (
                  <div key={lbl} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 13, color: C.muted }}>
                    <span style={{ color: col, fontSize: 15 }}>{lbl.charAt(0)}</span>{lbl.slice(2)}
                  </div>
                ))}
              </div>
            </Card>

            {/* Improvement #3 — consensus / crowding / absences, computed from the matrix + holdings. */}
            {(() => {
              const isLong = v => v === "●" || v === "●●";
              const rows = CONSENSUS_ROWS.map(r => ({ theme: r.theme, long: r.vals.filter(isLong).length, partial: r.vals.filter(v => v === "◐").length }));
              const crowded = rows.filter(r => r.long >= 4).sort((a, b) => b.long - a.long);
              const lonely = rows.filter(r => r.long === 1).sort((a, b) => b.partial - a.partial);
              const absences = ABSENCE_WATCH.filter(w => !funds.some(f => (f.holdings || []).some(h => w.tickers.includes(h.name))));
              const colHead = (txt, col) => <div style={{ fontSize: 10.5, fontWeight: 800, color: col, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>{txt}</div>;
              return (
                <Card>
                  <SLabel>Consensus · crowding · absences</SLabel>
                  <div style={{ fontSize: 11, color: C.lbl, margin: "2px 0 10px", lineHeight: 1.5 }}>Computed from the matrix + holdings above. Crowded ≠ safe — a lone conviction or a total absence is often the higher-information signal.</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14 }}>
                    <div>
                      {colHead("Most crowded", C.amber)}
                      {crowded.length ? crowded.map(r => (
                        <div key={r.theme} style={{ fontSize: 12, color: C.mid, marginTop: 3, lineHeight: 1.4 }}>
                          <b style={{ color: C.text }}>{r.long}/7</b> {r.theme}
                        </div>
                      )) : <div style={{ fontSize: 12, color: C.lbl }}>—</div>}
                      <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 5, fontStyle: "italic" }}>Crowding is a fragility, not a green light — a consensus long unwinds fastest.</div>
                    </div>
                    <div>
                      {colHead("Lone conviction", C.blue)}
                      {lonely.length ? lonely.map(r => (
                        <div key={r.theme} style={{ fontSize: 12, color: C.mid, marginTop: 3, lineHeight: 1.4 }}>
                          <b style={{ color: C.text }}>1 fund</b> {r.theme}
                        </div>
                      )) : <div style={{ fontSize: 12, color: C.lbl }}>—</div>}
                      <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 5, fontStyle: "italic" }}>One manager alone — differentiated, not consensus.</div>
                    </div>
                    <div>
                      {colHead("Notable absences", C.red)}
                      {absences.length ? absences.map(w => (
                        <div key={w.label} style={{ fontSize: 12, color: C.mid, marginTop: 3, lineHeight: 1.4 }}>
                          <b style={{ color: C.text }}>None hold</b> {w.label} — <span style={{ color: C.muted }}>{w.why}</span>
                          {w.note && <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 2, lineHeight: 1.45, paddingLeft: 8, borderLeft: "2px solid " + C.bdr }}>{w.note}</div>}
                        </div>
                      )) : <div style={{ fontSize: 12, color: C.lbl }}>—</div>}
                    </div>
                  </div>
                  {/* A2 + B2 — the crowded AI long: thesis STRENGTHENING while price DE-RATES. That
                      divergence is the signal — a crowded long meeting an ordinary quarter, not a
                      fundamentals problem. All figures post-date the Jun-30 snapshot. */}
                  <div style={{ marginTop: 12, padding: "10px 13px", background: C.aBg, border: "1.5px solid " + C.aBdr, borderRadius: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 900, color: C.amber, marginBottom: 3 }}>⚠️ The consensus long (AI infra): thesis strengthening, price de-rating</div>
                    <div style={{ fontSize: 11.5, color: C.mid, lineHeight: 1.6 }}>
                      <b style={{ color: C.green }}>Fundamentals up post-filing:</b> Amazon 2026 capex raised to $220B (Jul 30 call), Alphabet to $205B, Meta twice; big-four 2026 ~$725B (+77% YoY), 2027 consensus $934.5B (JPM/Goldman &gt;$1T); Google Cloud backlog $460B (~2×).
                      <br /><b style={{ color: C.red }}>Price down anyway:</b> AMD (Aug 4) record double-beat but −9% on in-line guidance; MU (Aug 18) −7%; SK Hynix / Samsung (Aug 19) −9.4% / −7.7%; SMH 546.03, −5.4% since Aug 19.
                      <br /><span style={{ color: C.muted }}>That gap — improving fundamentals into a de-rating price — is a positioning problem, not a fundamentals one. It is precisely what a crowded long looks like meeting an ordinary quarter.</span>
                    </div>
                  </div>
                </Card>
              );
            })()}

            {/* Smart Money Implied Regime Bets — moved here from the Macro tab */}
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                <SLabel>Smart Money Implied Regime Bets</SLabel>
                <span style={{ color: C.lbl, fontSize: 12 }}>
                  ✏️ Edit funds on the Smart Money tab to update this table live
                </span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 460 }}>
                  <thead>
                    <tr style={{ background: C.bg }}>
                      {["Fund", "Manager", "Implied Bet", "Key Signal"].map(h => (
                        <th key={h} style={{ textAlign: "left", color: C.mid, padding: "9px 12px", borderBottom: "2px solid " + C.bdr, fontSize: 13, fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {funds.map((f, i) => (
                      <tr
                        key={f.id}
                        style={{ background: i % 2 === 0 ? C.surf : C.bg, cursor: "pointer" }}
                        onClick={() => { setTab("smartmoney"); setSelectedFund(f); }}
                        title="Click to view on Smart Money tab"
                      >
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid " + C.bdr }}>
                          <span style={{ color: f.color, fontWeight: 800, fontSize: 14 }}>{f.name}</span>
                        </td>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid " + C.bdr, color: C.muted, fontSize: 13 }}>
                          {f.manager}
                        </td>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid " + C.bdr, minWidth: 140 }}>
                          {f.regimeBet
                            ? <span style={{ background: (f.regimeBetColor || f.color) + "15", color: f.regimeBetColor || f.color, border: "1.5px solid " + (f.regimeBetColor || f.color) + "40", borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 800, lineHeight: 1.5, display: "inline-block" }}>{f.regimeBet}</span>
                            : <span style={{ color: C.lbl, fontSize: 12 }}>Not set</span>
                          }
                        </td>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid " + C.bdr, color: C.muted, fontSize: 13 }}>
                          {f.regimeBetSignal || f.thesis?.slice(0, 100) + "…"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 12, padding: "12px 14px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8 }}>
                <span style={{ color: C.amber, fontWeight: 700, fontSize: 13 }}>⚠️ The Q2 signal (as of Jun 30): </span>
                <span style={{ color: C.amber, fontSize: 14 }}>The AI-chip long got MORE crowded, not less — Micron became Appaloosa's #2, Tiger added a new Cerebras stake and re-entered Intel, and semis moved to the top of Tiger's book. But hedges are appearing at the edges: Tepper initiated an AAPL put and cut BABA. Berkshire built Alphabet to a top-4 position (its most AI-adjacent bet) while holding ~$397B cash. Druckenmiller re-entered the mega-caps he'd exited. Ackman (now filing via the public parent Pershing Square Inc.) added Visa, Mastercard, S&P Global and Netflix — a shift toward quality compounders. Positions as of Jun 30 — not current.</span>
              </div>
            </Card>

            {/* Fund selector — single row, flex-fit with horizontal-scroll fallback (Fix 1) */}
            <div className="mwd-smartmoney-row">
              {/* Per-side longhand borders ONLY — the `border` shorthand + `borderLeft` longhand
                  mix dropped the 4px colour accent on click (React clobbers the longhand when it
                  updates the shorthand). All-longhand can't be clobbered. */}
              {funds.map(f => (
                <button key={f.id} onClick={() => setSelectedFund(f)} style={{
                  background: selectedFund.id === f.id ? f.color + "12" : C.surf,
                  borderStyle: "solid",
                  borderTopWidth: 1.5, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderLeftWidth: 4,
                  borderTopColor: selectedFund.id === f.id ? f.color : C.bdr,
                  borderRightColor: selectedFund.id === f.id ? f.color : C.bdr,
                  borderBottomColor: selectedFund.id === f.id ? f.color : C.bdr,
                  borderLeftColor: f.color,
                  borderRadius: 10, padding: "12px 13px", textAlign: "left", cursor: "pointer",
                }}>
                  <div style={{ color: f.color, fontWeight: 800, fontSize: 13, lineHeight: 1.3, marginBottom: 3, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{f.name}</div>
                  <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.3, marginBottom: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.manager}</div>
                  <div style={{ background: f.signalColor + "15", color: f.signalColor, border: "1.5px solid " + f.signalColor + "40", borderRadius: 6, padding: "3px 7px", fontSize: 11, fontWeight: 800, lineHeight: 1.4, display: "inline-block", maxWidth: "100%", wordBreak: "break-word" }}>{f.signal}</div>
                  {f.lastUpdated && <div style={{ color: C.lbl, fontSize: 10, marginTop: 6 }}>{f.lastUpdated}</div>}
                </button>
              ))}
            </div>

            <FundDetail
              fund={selectedFund}
              prices={prices}
              onFetchPrices={fetchPrices}
              pricesLoading={pricesLoading}
              pricesUpdated={pricesUpdated}
            />
          </div>
        )}

        {/* ── MACRO ── */}
        {tab === "global" && (
          <GlobalPlaybook
            liveIntervention={liveIntervention}
            reconSummary={reconSummary}
            byRegion={pbData}
            regions={pbRegions}
            toggleRegion={toggleRegion}
            loading={pbLoading}
            error={pbError}
            updated={pbUpdated}
            onRefresh={() => pbRegions.forEach(r => fetchPlaybookRegion(r))}
            fmtTime={fmtTime}
          />
        )}

        {tab === "macro" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* T1c — Macro synthesis strip: the one-line answer at the top, so the read lands without
                scrolling the cards below. Complements the always-on header strip with recession + cash + do. */}
            {(() => {
              const r = liveRegime || REGIMES[0];
              const prob = regimeProbFor(r.id);
              const rec = derivedRegimes?.weightedAvg ?? null;
              const headline = liveInd?.cpiHeadlineCurrent ?? null;
              const realCash = headline != null ? +(SEC_YIELDS.USFR.value - headline).toFixed(2) : null;
              const best = activeRegime?.best || [], worst = activeRegime?.worst || [];
              const item = (k, v, col) => (<span style={{ display: "inline-flex", gap: 6, alignItems: "baseline" }}><span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: C.lbl }}>{k}</span><b style={{ color: col || C.text, fontWeight: 800 }}>{v}</b></span>);
              return (
                <div style={{ background: r.bg, border: "1.5px solid " + r.bdr, borderTop: "4px solid " + r.color, borderRadius: 12, padding: "11px 16px" }}>
                  <div style={{ display: "flex", gap: "4px 18px", flexWrap: "wrap", alignItems: "baseline", fontSize: 14 }}>
                    {item("Regime", `${r.label} ${prob}%`, r.color)}
                    <span style={{ color: C.bdr }}>·</span>
                    {item("Recession consensus", rec != null ? `${rec}%` : "—", C.mid)}
                    <span style={{ color: C.bdr }}>·</span>
                    {item("Real cash yield", realCash != null ? `${realCash >= 0 ? "+" : ""}${realCash}pp` : "—", realCash != null ? (realCash > 0 ? C.green : C.red) : C.muted)}
                  </div>
                  {(best.length || worst.length) ? (
                    <div style={{ marginTop: 6, fontSize: 13, color: C.mid, lineHeight: 1.5 }}>
                      <b style={{ color: r.color }}>Do:</b> hold {best.slice(0, 2).join(", ")}{worst.length ? <> · <span style={{ color: C.muted }}>avoid {worst.slice(0, 2).join(", ")}</span></> : null}
                    </div>
                  ) : null}
                </div>
              );
            })()}
            {/* Item 4 — purpose line. This tab is about the CURRENT regime; the Insurance tab is
                about how a crash would RESOLVE. Different taxonomies, stated so they don't blur. */}
            <div style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 12, padding: "10px 16px", fontSize: 13.5, color: C.mid, lineHeight: 1.5 }}>
              <b style={{ color: C.text }}>What regime are we in right now?</b>
              <span style={{ color: C.muted }}> The Insurance tab answers a different question — if a crash happens from here, how does it resolve.</span>
            </div>
            {/* T2a — jump-nav. The Macro tab is long; this lets the reader land on any section
                without scrolling. Anchors are the `id="macro-*"` markers before each block. */}
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: "2px 2px" }}>
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: C.lbl, marginRight: 2 }}>Jump to</span>
              {[
                ["Regime", "macro-regime"], ["Credit", "macro-credit"], ["Fed", "macro-fed"],
                ["Inflation", "macro-inflation"], ["Labor", "macro-labor"], ["Recession", "macro-recession"],
                ["Transitions", "macro-transitions"],
              ].map(([lbl, id]) => (
                <button key={id} onClick={() => { const el = typeof document !== "undefined" && document.getElementById(id); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                  style={{ cursor: "pointer", background: C.surf, color: C.mid, border: "1.5px solid " + C.bdr, borderRadius: 999, padding: "4px 11px", fontSize: 11.5, fontWeight: 700 }}>
                  {lbl}
                </button>
              ))}
            </div>
            {/* Section E — the 10Y auction-health card is DELETED (the P7 spec is void).
                10Y auctions are roughly monthly while this page is read daily, so a card whose
                value is 3-25 days old, styled like the live ones, invites a stale impression to
                form. Fixing the metrics does not fix that — the update frequency was the defect.
                Transmission to duration shows up in the 30Y and 5s30s rows below, which move
                daily and are early enough for the positions actually held. */}

            {/* ── F.1 — REGIME first. Ordered by decision relevance, fast-moving above
                slow-moving: regime + contested guard, then rates, then CPI, then the
                labour module, then the consensus block (slowest). Credit stays on the
                Global Playbook tab where it already lives. ── */}
            <div id="macro-regime" style={{ scrollMarginTop: 96 }} />
            <Card>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <SLabel>Regime Probability — Derived from Recession Consensus + Live CPI</SLabel>
                {/* Section A — vintage stamped ON the regime block, because the engine keeps
                    producing live-looking output from inputs that are months old. */}
                <span style={{ marginLeft: "auto", fontSize: 10.5, fontWeight: 800, color: C.amber, background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 5, padding: "2px 7px" }}>
                  Consensus inputs {CONSENSUS_VINTAGE.label} — {CONSENSUS_VINTAGE.staleNote}
                </span>
              </div>
              {derivedRegimes?.contested && (
                <div style={{ marginBottom: 10, padding: "8px 11px", background: C.bg, border: "1.5px solid " + C.bdrMd, borderRadius: 8, fontSize: 12.5, fontWeight: 700, color: C.mid, lineHeight: 1.55 }}>
                  ⚖️ <b>CONTESTED</b> — top two states within {derivedRegimes.topTwoGap}pp. Neither is highlighted as a winner and the directional recommendation is suppressed.
                </div>
              )}
              {derivedRegimes?.mapping?.known && !derivedRegimes.mapping.earned && (
                <div style={{ marginBottom: 10, padding: "8px 11px", background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, fontSize: 11.5, color: C.mid, lineHeight: 1.55 }}>
                  <b style={{ color: C.blue }}>Mapping: </b>{derivedRegimes.mapping.reason} — {derivedRegimes.mapping.redirected}pp moved from growth to stagflation.
                </div>
              )}
              {/* R8.1 — the labour override made visible: a live payroll/emp-pop deterioration
                  moves weight into deflationary recession ahead of the (lagging) analyst consensus. */}
              {derivedRegimes?.labor?.shift > 0 && (
                <div style={{ marginBottom: 10, padding: "8px 11px", background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 8, fontSize: 11.5, color: C.mid, lineHeight: 1.55 }}>
                  <b style={{ color: C.blue }}>Labour: </b>{derivedRegimes.labor.shift}pp moved into <b>deflationary recession</b> on live labour weakness ({derivedRegimes.labor.reasons.join(", ")}). The recession-consensus input lags today's print — this moves the engine on it.
                </div>
              )}
              <div className="mwd-regime-grid" style={{ marginBottom: 14 }}>
                {regimeSorted.map(({ r, prob }) => {
                  // When contested, the top TWO share the highlight — no single winner.
                  const inTopTwo = (derivedRegimes?.topTwo || []).includes(r.id);
                  const highlighted = derivedRegimes?.contested ? inTopTwo : activeRegime.id === r.id;
                  // Per-side longhand borders ONLY — never the `border`/`borderTop` shorthand mix.
                  // React updating the `border` shorthand on click was dropping the `borderTop`
                  // longhand, so the 4px top colour bar vanished from any card whose highlight
                  // changed. All-longhand (no shorthand for a changing value) can't be clobbered.
                  return (
                  <button key={r.id} onClick={() => { setActiveRegime(r); keepPinned(); }} style={{ background: highlighted ? r.bg : C.surf, borderStyle: "solid", borderTopWidth: 4, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderLeftWidth: 1.5, borderTopColor: r.color, borderRightColor: highlighted ? r.color : C.bdr, borderBottomColor: highlighted ? r.color : C.bdr, borderLeftColor: highlighted ? r.color : C.bdr, borderRadius: 10, padding: "12px 14px", cursor: "pointer", textAlign: "left", width: "100%" }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: r.color }}>{prob}%</div>
                    <div style={{ color: r.color, fontWeight: 700, fontSize: 13, marginTop: 3, lineHeight: 1.3 }}>{r.label}</div>
                    {derivedRegimes?.contested && inTopTwo && (
                      <div style={{ fontSize: 9.5, fontWeight: 800, color: C.muted, marginTop: 2 }}>TIED</div>
                    )}
                  </button>
                  );
                })}
              </div>
              {/* Colour bar — same probability order as the cards. Widths come from the clamped
                  integers in regimeSorted, so a segment can never render an invalid width and the
                  bar cannot collapse; a non-zero share keeps a 2px floor so even 5% stays visible. */}
              <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", border: "1px solid " + C.bdr }}>
                {regimeSorted.map(({ r, prob }) => (
                  <div key={r.id} style={{ width: prob + "%", minWidth: prob > 0 ? 2 : 0, background: r.color, fontSize: 10, color: "#fff", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }} title={r.label}>{prob}%</div>
                ))}
              </div>
              {derivedRegimes ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ color: C.lbl, fontSize: 11, lineHeight: 1.5 }}>Weighted Wall Street recession probability: <b style={{ color: C.muted }}>{derivedRegimes.weightedAvg}%</b> | Derived from analyst consensus + live CPI</div>
                  <div style={{ color: C.lbl, fontSize: 11, lineHeight: 1.5, marginTop: 2 }}>{derivedRegimes.derivedFrom}</div>
                  {recDecayed && recDecayed.length > 0 && (
                    <div style={{ color: C.amber, fontSize: 11, lineHeight: 1.5, marginTop: 2 }}>
                      ⏳ Recency-decayed (linear to zero at {RECESSION_STALE_ZERO_DAYS}d): {recDecayed.map(d => `${d.name.split(" (")[0]} ${Math.round(d.factor * 100)}%`).join(" · ")} — stale vintages no longer carry full weight.
                    </div>
                  )}
                  <div style={{ color: C.lbl, fontSize: 11, lineHeight: 1.5, marginTop: 2, fontStyle: "italic" }}>Updates automatically when recession table is refreshed or CPI changes.</div>
                  {/* P0.3 — trailing history. The engine is unfalsifiable without it: this is
                      how you answer "has the classifier actually been right". Raw inputs are
                      stored server-side alongside these probabilities so a change to the
                      discriminator can be re-run against days already recorded. */}
                  {plottableHistory.length >= 2 ? (
                    <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px dashed " + C.bdr }}>
                      <div style={{ fontSize: 10.5, color: C.muted, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
                        Regime history · {plottableHistory.length} days logged
                      </div>
                      <ResponsiveContainer width="100%" height={70}>
                        <LineChart data={plottableHistory} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                          <XAxis dataKey="date" tick={{ fontSize: 9, fill: C.lbl }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                          <YAxis domain={[0, 100]} hide />
                          <Tooltip formatter={(v, n) => [`${v}%`, n]} />
                          <Line type="monotone" dataKey="stagflation_p"  name="Stagflation"  stroke={REGIME_PALETTE.stag.color} strokeWidth={1.5} dot={false} connectNulls />
                          <Line type="monotone" dataKey="reflationary_p" name="Reflationary" stroke={REGIME_PALETTE.ref.color} strokeWidth={1.5} dot={false} connectNulls />
                          <Line type="monotone" dataKey="deflationary_p" name="Deflationary" stroke={REGIME_PALETTE.def.color} strokeWidth={1.5} dot={false} connectNulls />
                          <Line type="monotone" dataKey="inflationary_p" name="Inflationary" stroke={REGIME_PALETTE.inf.color} strokeWidth={1.5} dot={false} connectNulls />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 8, fontStyle: "italic" }}>
                      Regime history: {plottableHistory.length} day{plottableHistory.length === 1 ? "" : "s"} logged — insufficient for a trend. One row is appended per day.
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ color: C.lbl, fontSize: 11, marginTop: 10, fontStyle: "italic" }}>Using fallback regime probabilities — live recession data unavailable.</div>
              )}
            </Card>

            {/* P0.2 — regime-shift scenarios the consensus engine can't derive (Debasement / Hawkish). */}
            <RegimeShiftScenarios realYield={pbData?.us?.macro?.realYield?.value ?? null} realYieldAsOf={pbData?.us?.macro?.realYield?.date ?? null} />

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <Card style={{ flex: "1 1 240px", background: activeRegime.bg, border: "1.5px solid " + activeRegime.bdr, borderTop: "4px solid " + activeRegime.color }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: activeRegime.color, marginBottom: 1 }}>{activeRegime.label}</div>
                {/* P0.1 — scope label: this is the STRUCTURAL regime, distinct from the Global
                    Playbook tape read (one session) and the debasement cross-asset read (5d). */}
                <div style={{ fontSize: 11, fontWeight: 800, color: C.blue, letterSpacing: 0.3, marginBottom: 4 }}>structural · consensus-derived · months</div>
                <div style={{ color: C.muted, fontSize: 13, fontStyle: "italic", lineHeight: 1.6, marginBottom: 10 }}>
                  {{
                    stag: "Prioritise insurance (miners, staples). Hold cash. Avoid new software/growth entries. TLT is a trap here.",
                    def:  "TLT and cash are primary hedges. Reduce equity exposure. Watch for Fed pivot signal before deploying.",
                    ref:  "Gradual equity deployment appropriate. REITs and growth names benefit. Begin filling long-term positions in tranches.",
                    inf:  "Real assets and pipelines outperform. Equities with pricing power hold. Avoid long-duration bonds.",
                  }[activeRegime.id]}
                </div>
                <p style={{ color: C.mid, fontSize: 15, lineHeight: 1.75, margin: "0 0 12px" }}>{activeRegime.desc}</p>
                <div style={{ padding: "10px 13px", background: "#fff", border: "1px solid " + activeRegime.bdr, borderRadius: 8 }}>
                  <div style={{ color: activeRegime.color, fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Transition trigger</div>
                  <div style={{ color: C.mid, fontSize: 14 }}>{activeRegime.trigger}</div>
                </div>
              </Card>
              <div style={{ flex: "1 1 240px", display: "flex", flexDirection: "column", gap: 12 }}>
                <Card>
                  {/* I.3 — no fill, no accent: this is a CATEGORY panel, not a status one. */}
                  <SLabel>✓ Best Assets</SLabel>
                  {activeRegime.best.map((a, i) => (
                    <div key={i} style={{ color: C.mid, fontSize: 14, padding: "4px 0", borderBottom: i < activeRegime.best.length - 1 ? "1px solid " + C.gBdr : "none" }}>✅ {a}</div>
                  ))}
                </Card>
                <Card>
                  <SLabel>✗ Worst Assets</SLabel>
                  {activeRegime.worst.map((a, i) => (
                    <div key={i} style={{ color: C.mid, fontSize: 14, padding: "4px 0", borderBottom: i < activeRegime.worst.length - 1 ? "1px solid " + C.rBdr : "none" }}>❌ {a}</div>
                  ))}
                </Card>
              </div>
            </div>

            {/* P1/P2 — gold-miners resolution. Miners left the Stagflation "Best" list (they're
                cautioned, matching the Insurance tab), and the F2 gold pair says which of the two
                miner regimes is live right now. Only shown under Stagflation — the regime where the
                two tabs used to disagree. */}
            {activeRegime.id === "stag" && (() => {
              const gp = pbData?.us?.marketRegime?.goldPair;
              const mp = gp?.available ? minersPairImplication(gp.reading) : null;
              return (
                <div style={{ padding: "11px 14px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 10, fontSize: 13, lineHeight: 1.6 }}>
                  <span style={{ color: C.amber, fontWeight: 800 }}>⚠️ Gold miners are not on the Best list as a hedge. </span>
                  <span style={{ color: C.amber }}>{GOLD_MINERS_WHY} Same ⚠️ rating as the Insurance tab's GDX/GDXJ under stagflation — one definition, both tabs.</span>
                  {mp && (
                    <div style={{ marginTop: 7, color: mp.ok ? C.green : C.red, fontWeight: 700 }}>
                      Gold pair live read — <b>{mp.live}</b>: {mp.text}
                    </div>
                  )}
                  {gp && !gp.available && (
                    <div style={{ marginTop: 7, color: C.lbl, fontSize: 12 }}>Gold pair unreadable right now: {gp.note}</div>
                  )}
                </div>
              );
            })()}

            {/* F.2 — credit is the master gauge and sits directly under regime. Reads the
                Playbook payload (pbData.us) because OAS/HYG come from /api/playbook, not
                /api/indicators which feeds the rest of this tab. */}
            <div id="macro-credit" style={{ scrollMarginTop: 96 }} />
            <CreditBlock
              credit={pbData?.us?.regime?.credit}
              oas={pbData?.us?.macro?.oas}
              hyg={pbData?.us?.hyg}
              reconSummary={reconSummary}
            />

            {/* T1b — Fed pricing: one card that answers "what's priced for the Fed", cross-checking the
                6-month bill-implied path against the September-meeting odds. Folds the former standalone
                6-month-cuts and September-odds cards; the ZQ futures path + qualitative language follow below. */}
            <div id="macro-fed" style={{ scrollMarginTop: 96 }} />
            {(() => {
              const bps = liveInd?.impliedCutsBps ?? null;
              const cf = liveInd?.currentFedFunds ?? null, tb = liveInd?.tbill6m ?? null;
              const sept = SEP_HIKE_ODDS.value;
              const sixDir = bps == null ? null : bps > 10 ? "dovish" : bps < 0 ? "hawkish" : "neutral";
              const sixLean = bps == null ? null : bps > 10 ? 1 : bps < 0 ? -1 : 0;
              const septDir = sept <= 30 ? "dovish" : sept >= 45 ? "hawkish" : "neutral";
              const septLean = sept <= 30 ? 1 : sept >= 45 ? -1 : 0;
              let xread, xcol;
              if (sixLean == null) { xread = "6-month path unavailable — showing the September read only."; xcol = C.muted; }
              else if (sixLean !== 0 && septLean !== 0 && sixLean === septLean) { xread = `Aligned — both lean ${sixDir}. The near-term path and the September meeting point the same way.`; xcol = C.green; }
              else if (sixLean !== 0 && septLean !== 0 && sixLean !== septLean) { xread = `Diverge — the 6-month path leans ${sixDir} but September-meeting odds lean ${septDir}. Trust the meeting read for September, the path for the trajectory.`; xcol = C.amber; }
              else { xread = "Mixed / neutral — nothing decisively priced either way."; xcol = C.muted; }
              const dirCol = d => d === "dovish" ? C.green : d === "hawkish" ? C.red : C.muted;
              const row = (label, big, sub, col) => (
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", padding: "6px 0", borderBottom: "1px solid " + C.bdr }}>
                  <span style={{ minWidth: 150, fontSize: 12.5, fontWeight: 700, color: C.mid }}>{label}</span>
                  <span style={{ fontSize: 17, fontWeight: 900, color: col }}>{big}</span>
                  <span style={{ fontSize: 12, color: C.muted }}>{sub}</span>
                </div>
              );
              return (
                <Card>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <SLabel>Fed pricing — what's priced for the Fed</SLabel>
                    <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>two market reads, cross-checked · ZQ futures path below</span>
                  </div>
                  <div style={{ marginTop: 6 }}>
                    {row("6-month path", bps != null ? `${bps} bps` : "—", bps != null ? `${bps > 0 ? "cuts" : bps < 0 ? "hikes" : "flat"} priced · 6M bill ${tb != null ? tb.toFixed(2) : "—"}% vs funds ${cf != null ? cf.toFixed(2) : "—"}%` : "Fed funds / T-bill not loaded", bps != null ? dirCol(sixDir) : C.muted)}
                    {row("September meeting", `${sept}%`, `implied hike odds · ${SEP_HIKE_ODDS.value < SEP_HIKE_ODDS.prior ? "↓" : "↑"} from ${SEP_HIKE_ODDS.prior}%`, dirCol(septDir))}
                  </div>
                  <div style={{ marginTop: 8, padding: "8px 11px", background: xcol === C.amber ? C.aBg : xcol === C.green ? C.gBg : C.bg, border: "1px solid " + (xcol === C.amber ? C.aBdr : xcol === C.green ? C.gBdr : C.bdr), borderRadius: 8, fontSize: 12.5, fontWeight: 700, color: xcol, lineHeight: 1.5 }}>
                    Cross-check: {xread}
                  </div>
                  <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 6, lineHeight: 1.5 }}>{SEP_HIKE_ODDS.note} <span style={{ color: C.muted }}>· Sept odds as of {SEP_HIKE_ODDS.asOf}, {SEP_HIKE_ODDS.source}.</span></div>
                </Card>
              );
            })()}

            {/* Fed Language Status — manually updated after each FOMC (Update 2) */}
            {(() => {
              const currentState = FED_LANGUAGE_STATES[FED_LANGUAGE_STATUS.status] || FED_LANGUAGE_STATES.hawkish_hold;
              const cell = (label, text, italic) => (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                  <div style={{ fontSize: 12, marginTop: 2, color: italic ? "#555" : C.mid, fontStyle: italic ? "italic" : "normal", lineHeight: 1.5 }}>{text}</div>
                </div>
              );
              return (
                <Card style={{ borderLeft: "3px solid " + currentState.color }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                    <div>
                      <SLabel>Fed Language Status</SLabel>
                      <div style={{ color: currentState.color, fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>{currentState.label}</div>
                      <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>{FED_LANGUAGE_STATUS.lastEvent} · Updated {FED_LANGUAGE_STATUS.lastUpdated}</div>
                    </div>
                    <div style={{ fontSize: 11, color: "#888", textAlign: "right" }}>Next: {FED_LANGUAGE_STATUS.nextEvent}</div>
                  </div>
                  {/* Decision + vote + dissent + guidance — the meeting's actual character,
                      not just the state label. Dissent direction is the hawkish/dovish tell. */}
                  {FED_LANGUAGE_STATUS.decision && (
                    <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <span style={{ fontSize: 12, fontWeight: 800, color: C.text, background: C.bg, border: "1.5px solid " + C.bdr, borderRadius: 6, padding: "4px 9px" }}>
                        {FED_LANGUAGE_STATUS.decision}
                      </span>
                      {FED_LANGUAGE_STATUS.vote && (
                        <span style={{ fontSize: 12, fontWeight: 800, color: currentState.color, background: currentState.bg, border: "1.5px solid " + currentState.color + "55", borderRadius: 6, padding: "4px 9px" }}>
                          Vote {FED_LANGUAGE_STATUS.vote} · 3 dissents to HIKE
                        </span>
                      )}
                      {FED_LANGUAGE_STATUS.bias && (
                        <span style={{ fontSize: 12, fontWeight: 800, color: C.blue, background: C.blBg, border: "1.5px solid " + C.blBdr, borderRadius: 6, padding: "4px 9px" }}>
                          {FED_LANGUAGE_STATUS.bias}
                        </span>
                      )}
                    </div>
                  )}
                  {FED_LANGUAGE_STATUS.dissents && (
                    <div style={{ fontSize: 12, color: C.mid, marginTop: 8, lineHeight: 1.5 }}>
                      <b style={{ color: C.muted }}>Dissents: </b>{FED_LANGUAGE_STATUS.dissents}
                      {FED_LANGUAGE_STATUS.dissentNote && <span style={{ color: C.amber, fontWeight: 700 }}> — {FED_LANGUAGE_STATUS.dissentNote}</span>}
                    </div>
                  )}
                  {FED_LANGUAGE_STATUS.guidance && (
                    <div style={{ fontSize: 12, color: C.mid, marginTop: 5, lineHeight: 1.5 }}>
                      <b style={{ color: C.muted }}>Guidance: </b>{FED_LANGUAGE_STATUS.guidance}
                    </div>
                  )}
                  <p style={{ fontSize: 13, marginTop: 10, color: C.mid, lineHeight: 1.6 }}>{FED_LANGUAGE_STATUS.summary}</p>
                  <div className="mwd-grid-2" style={{ gap: 12, marginTop: 12, background: currentState.bg, borderRadius: 8, padding: 12 }}>
                    {cell("SGOV / USFR", currentState.sgov_usfr)}
                    {cell("IEF / TLT", currentState.ief_tlt)}
                    {cell("Equities / Deployment", currentState.equities)}
                    {cell("Watch For", currentState.watchFor, true)}
                  </div>
                  <div style={{ fontSize: 11, color: C.lbl, marginTop: 10 }}>Updated manually after each FOMC meeting or significant Fed communication.</div>
                </Card>
              );
            })()}

            <FedPathCard effr={liveInd?.currentFedFunds ?? null} />
            <InterventionToggle
              jpyChangePct={pbData?.us?.cross?.fx?.rows?.find(r => r.sym === "JPY=X")?.changePct ?? null}
              dxyChangePct={pbData?.us?.cross?.fx?.rows?.find(r => r.sym === "DX-Y.NYB")?.changePct ?? null}
              onChange={setLiveIntervention}
            />

            <div id="macro-inflation" style={{ scrollMarginTop: 96 }} />
            {/* CPI Inflation Tracker — Headline/Core CPI + Core PCE YoY, real-yield-on-cash */}
            {(() => {
              // (level→colour lookup now lives in bandOf() below — the tile numbers carry their
              // SERIES colour, and the level read moved to the band chip.)
              const headline = liveInd ? liveInd.cpiHeadlineCurrent : null;
              const core     = liveInd ? liveInd.cpiCoreCurrent : null;
              const pce      = liveInd ? liveInd.pceCoreCurrent : null;
              const hHist = liveInd && Array.isArray(liveInd.cpiHeadlineHistory) ? liveInd.cpiHeadlineHistory : [];
              const cHist = liveInd && Array.isArray(liveInd.cpiCoreHistory)     ? liveInd.cpiCoreHistory     : [];
              const pHist = liveInd && Array.isArray(liveInd.pceCoreHistory)     ? liveInd.pceCoreHistory     : [];
              const hasChartData = [hHist, cHist, pHist].some(a => a.length >= 2);
              // Merge the three monthly series onto ONE date axis, union of dates, sorted.
              // They are published on separate schedules and do NOT always cover the same
              // months (PCE carried 2025-10-01 while the CPI series did not). Giving each
              // <Line> its own `data` prop makes Recharts build categories from the first
              // series and APPEND any unmatched date to the end of the axis — which is what
              // rendered a stray Oct-2025 point after Mar-2026. One dataset makes that
              // structurally impossible: every row is a date, every series a column.
              const chartData = (() => {
                const byDate = new Map();
                const put = (rows, key) => (rows || []).forEach(r => {
                  if (!r?.date || r.value == null || !Number.isFinite(+r.value)) return;
                  if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date });
                  byDate.get(r.date)[key] = +Number(r.value).toFixed(2);
                });
                put(hHist, "headline"); put(cHist, "core"); put(pHist, "pce");
                return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
              })();
              // (realYield is computed below, AFTER the cash marks — it must use the same cash
              // basis the chart band draws, or the card contradicts its own chart.)
              // Direction from the stored history (prior print), never asserted from one value.
              const trendOf = h => {
                if (!Array.isArray(h) || h.length < 2) return null;
                const last = h[h.length - 1], prev = h[h.length - 2];
                const d = +(last.value - prev.value).toFixed(2);
                return { d, dir: d < 0 ? "cooling" : d > 0 ? "rising" : "flat", from: prev.value, fromDate: prev.date, toDate: last.date };
              };
              const pceAnn = announced("pceCore", liveInd?.asOf?.pceCoreCurrent);
              // Same single source the posture notes and cash-ETF rows resolve through.
              const cashYield = liveCashYield(liveInd);
              // Cash-yield markers drawn on the chart: the two funds actually held plus the
              // spot bill rate. Each is only included when its live value exists — a missing
              // one is dropped, never defaulted.
              // Aug-22 — use the 30-DAY SEC YIELD (forward, comparable), not TTM distribution yield
              // (backward-looking, overstates, frozen between monthly ex-divs). Published figures are
              // dated manual issuer-page values; the live DTB3 proxy reconciles them daily.
              const dtb3 = liveInd?.tbill3m ?? null;
              const secDiv = proxyDivergence(dtb3);
              const cashMarks = [
                { key: "USFR", label: "USFR", value: SEC_YIELDS.USFR.value, color: "#0EA5E9",
                  detail: `SEC 30-day yield ${SEC_YIELDS.USFR.value}% — as of ${SEC_YIELDS.USFR.asOf} · ${SEC_YIELDS.USFR.src}` },
                { key: "SGOV", label: "SGOV", value: SEC_YIELDS.SGOV.value, color: "#6366F1",
                  detail: `SEC 30-day yield ${SEC_YIELDS.SGOV.value}% — as of ${SEC_YIELDS.SGOV.asOf} · expense ${SEC_YIELDS.SGOV.expense}% · ${SEC_YIELDS.SGOV.src}` },
                cashYield && { key: "bill", label: cashYield.src, value: cashYield.value, color: "#3b82f6",
                  detail: `spot policy-linked rate${cashYield.asOf ? `, as of ${cashYield.asOf}` : ""}` },
              ].filter(Boolean);
              // These three sit within a few bps of each other, so drawing three separate
              // labelled lines would overprint into an unreadable smear. Draw the range as a
              // band, and give each its exact value in the legend row beneath the chart.
              const cashLo = cashMarks.length ? Math.min(...cashMarks.map(m => m.value)) : null;
              const cashHi = cashMarks.length ? Math.max(...cashMarks.map(m => m.value)) : null;

              // A4 — real yield is now computed PER INSTRUMENT off each SEC yield (below), not as a
              // single Fed-funds-vs-headline figure. The per-instrument block replaces the old band.
              const trendChip = t => t && (
                <span style={{ fontSize: 10.5, fontWeight: 800, color: t.dir === "cooling" ? C.green : t.dir === "rising" ? C.red : C.muted }}>
                  {t.dir === "cooling" ? "▼" : t.dir === "rising" ? "▲" : "■"} {t.d >= 0 ? "+" : "−"}{Math.abs(t.d)}pp vs prior
                </span>
              );
              // Each headline number carries its SERIES colour, matching the chart line and the
              // legend below, so the eye maps tile → line without a lookup. The level read
              // (how far above target) hasn't been lost — it moves to a small band chip.
              const bandOf = v => v == null ? null
                : v >= 4.0 ? { t: "well above target", c: "#ef4444" }
                : v >= 3.0 ? { t: "elevated",          c: "#f97316" }
                : v >= 2.5 ? { t: "above target",      c: "#eab308" }
                : v >= 1.5 ? { t: "near target",       c: "#22c55e" }
                :            { t: "below target",      c: "#3b82f6" };
              const reading = (label, val, sub, trend, seriesColor) => {
                const band = bandOf(val);
                return (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: seriesColor }}>{val != null ? val.toFixed(1) + "%" : "—"}</div>
                    <div style={{ fontSize: 11, color: "#888" }}>{sub}</div>
                    {trendChip(trend)}
                    {band && <div style={{ fontSize: 10, fontWeight: 700, color: band.c, marginTop: 1 }}>● {band.t}</div>}
                  </div>
                );
              };
              return (
                <Card>
                  <SLabel>CPI Inflation Tracker</SLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 4, marginBottom: 10 }}>
                    {reading("Headline CPI", headline, "YoY · BLS", trendOf(hHist), CPI_SERIES.headline)}
                    {reading("Core CPI", core, "Ex food & energy · BLS", trendOf(cHist), CPI_SERIES.core)}
                    {reading("Core PCE", pce, "Fed's preferred · BEA", trendOf(pHist), CPI_SERIES.pce)}
                  </div>
                  {/* Announced-but-not-yet-in-FRED print, explicitly labelled with its source.
                      Auto-retires once FRED's own asOf reaches the same period. */}
                  {pceAnn && (
                    <div style={{ marginBottom: 12, padding: "8px 11px", background: C.blBg, border: "1.5px solid " + C.blBdr, borderRadius: 8 }}>
                      <div style={{ fontSize: 11, fontWeight: 800, color: C.blue, textTransform: "uppercase", letterSpacing: 0.5 }}>
                        Announced {pceAnn.released} · not yet in FRED
                      </div>
                      <div style={{ fontSize: 13, color: C.mid, marginTop: 3, lineHeight: 1.5 }}>
                        <b>{pceAnn.label} {pceAnn.value}% YoY</b> ({pceAnn.mom >= 0 ? "+" : ""}{pceAnn.mom}% MoM) — {pceAnn.note}.
                        Headline PCE {pceAnn.headline}% YoY ({pceAnn.headlineMom >= 0 ? "+" : ""}{pceAnn.headlineMom}% MoM).
                        <span style={{ color: C.lbl }}> Source: {pceAnn.source}. The tile above still shows FRED's last ingested print ({liveInd?.asOf?.pceCoreCurrent ?? "—"}).</span>
                      </div>
                    </div>
                  )}
                  {/* A3 — DTB3 proxy reconciliation. Published SEC yields are dated manual issuer-page
                      figures; the live 3-month bill drives a daily estimate, and a >10bp gap means the
                      discount margin shifted → re-fetch the issuer page. */}
                  {dtb3 != null && secDiv && (
                    <div style={{ marginBottom: 12, padding: "8px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, fontSize: 11.5 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                        <span style={{ fontWeight: 800, color: C.mid }}>3M T-bill (DTB3) <b style={{ color: C.text }}>{dtb3.toFixed(2)}%</b> <span style={{ color: C.lbl, fontWeight: 600 }}>live · daily{liveInd?.asOf?.tbill3m ? ` · ${liveInd.asOf.tbill3m}` : ""}</span></span>
                        <span style={{ color: C.lbl, fontStyle: "italic" }}>SGOV & USFR are pass-throughs of the bill</span>
                      </div>
                      {[["SGOV", PROXY.SGOV.formula], ["USFR", PROXY.USFR.formula]].map(([k, f]) => {
                        const d = secDiv[k];
                        return (
                          <div key={k} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", marginTop: 3 }}>
                            <span style={{ minWidth: 48, fontWeight: 700, color: C.mid }}>{k} est</span>
                            <span style={{ fontWeight: 800, color: C.text }}>{d.est.toFixed(2)}%</span>
                            <span style={{ color: C.lbl }}>{f}</span>
                            <span style={{ color: C.muted }}>· actual <b style={{ color: C.mid }}>{d.published.toFixed(2)}%</b> ({SEC_YIELDS[k].asOf})</span>
                            <span style={{ fontWeight: 800, color: d.diverged ? C.amber : C.green }}>{d.diverged ? `⚠ ${d.bp >= 0 ? "+" : ""}${d.bp}bp — discount margin shifted, re-fetch` : "✓ reconciles"}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* A4 — real yield PER INSTRUMENT off its SEC yield (funds) or spot (the bill). Each
                      shows its cushion vs headline CPI and the CPI level that flips it negative. */}
                  {headline != null && (
                    <div style={{ marginBottom: 12, padding: "8px 12px", background: C.surf, border: "1px solid " + C.bdr, borderRadius: 8 }}>
                      <div style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 5 }}>Real yield on cash vs headline CPI {headline.toFixed(2)}%</div>
                      {cashMarks.map(m => {
                        const ry = m.value - headline;
                        return (
                          <div key={m.key} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", padding: "2px 0" }}>
                            <span style={{ minWidth: 96, fontWeight: 700, color: C.mid }}>{m.label}</span>
                            <span style={{ fontWeight: 800, color: C.text }}>{m.value.toFixed(2)}%</span>
                            <span style={{ fontWeight: 800, color: ry > 0 ? C.green : C.red }}>{ry >= 0 ? "+" : ""}{ry.toFixed(2)}% real</span>
                            <span style={{ color: C.lbl }}>flips at CPI ≥ <b style={{ color: C.mid }}>{m.value.toFixed(2)}%</b></span>
                          </div>
                        );
                      })}
                      <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 5, lineHeight: 1.5 }}>
                        SEC 30-day yields (forward) — narrower than the backward-looking TTM figures the card used to show; the SGOV cushion roughly halves. Headline is the thinnest, most energy-sensitive measure{liveInd?.oil != null ? ` (WTI ${liveInd.oil})` : ""}. USFR leads SGOV by {Math.round((SEC_YIELDS.USFR.value - SEC_YIELDS.SGOV.value) * 100)}bp on SEC yields, not the ~4bp a TTM figure showed.
                      </div>
                    </div>
                  )}
                  {hasChartData ? (
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart data={chartData} margin={{ top: 8, right: 46, bottom: 4, left: 0 }}>
                        <XAxis
                          dataKey="date"
                          type="category"
                          tick={{ fontSize: 10 }}
                          tickFormatter={(d) => {
                            // Format from the STRING parts. new Date("2024-06-01") is parsed as
                            // UTC midnight, so toLocaleDateString in a negative-offset timezone
                            // rolls it back a day and mislabels the month (Jun 24 → May 24).
                            const [y, m] = String(d).split("-");
                            const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                            return `${MON[+m - 1] ?? "?"} ${String(y).slice(2)}`;
                          }}
                          interval={3}
                        />
                        <YAxis tick={{ fontSize: 10 }} width={32} tickFormatter={(v) => `${v}%`} domain={["auto", "auto"]} />
                        <Tooltip
                          formatter={(value, name) => [`${Number(value).toFixed(2)}%`, name]}
                          labelFormatter={(d) => {
                            const [y, m] = String(d).split("-");
                            const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                            return `${MON[+m - 1] ?? "?"} ${y}`;
                          }}
                        />
                        <Legend iconType="line" iconSize={10} wrapperStyle={{ fontSize: "11px" }} />
                        {/* NO in-chart text labels. Both previous attempts failed: position
                            "right" clipped at the container edge, "insideRight" overprinted the
                            data lines. Every reference is identified in the legend row beneath
                            the chart instead, which has room for the exact value and method. */}
                        <ReferenceLine y={2} stroke="#22c55e" strokeDasharray="4 3" ifOverflow="extendDomain" />
                        {/* Cash band: the funds and the bill rate sit within a few bps, so the
                            range is shaded once rather than drawn as three overlapping lines. */}
                        {cashLo != null && (
                          <ReferenceArea y1={cashLo} y2={cashHi} ifOverflow="extendDomain"
                            fill="#3b82f6" fillOpacity={0.10} stroke="#3b82f6" strokeOpacity={0.35} strokeDasharray="4 3" />
                        )}
                        {/* connectNulls: a series missing a single month is a publication gap
                            (BLS/BEA schedules), not a break in the underlying series. */}
                        <Line type="monotone" dataKey="headline" name="Headline CPI" stroke={CPI_SERIES.headline} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
                        <Line type="monotone" dataKey="core" name="Core CPI" stroke={CPI_SERIES.core} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls />
                        <Line type="monotone" dataKey="pce" name="Core PCE" stroke={CPI_SERIES.pce} strokeWidth={2} strokeDasharray="5 3" dot={false} activeDot={{ r: 4 }} connectNulls />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div style={{ color: C.muted, fontSize: 13, fontStyle: "italic", marginTop: 8 }}>Awaiting data</div>
                  )}
                  {/* Reference legend — carries the labels that used to sit (illegibly) on the
                      plot. Each entry names the instrument, its exact live yield, and how that
                      yield was derived, on hover. */}
                  {hasChartData && (
                    <div style={{ marginTop: 8, borderTop: "1px solid " + C.bdr, paddingTop: 8 }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5 }} title="The Fed's stated inflation goal">
                          <span style={{ width: 14, height: 0, borderTop: "2px dashed #22c55e", display: "inline-block" }} />
                          <b style={{ color: "#22c55e" }}>2%</b><span style={{ color: C.muted }}>Fed target</span>
                        </span>
                        {cashLo != null && (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5 }}
                            title="Shaded band spans the cash yields below — they sit within a few bps of each other">
                            <span style={{ width: 14, height: 9, background: "#3b82f6", opacity: 0.18, border: "1px dashed #3b82f6", display: "inline-block", borderRadius: 2 }} />
                            <span style={{ color: C.muted }}>cash band {cashLo.toFixed(2)}–{cashHi.toFixed(2)}%</span>
                          </span>
                        )}
                        {cashMarks.map(m => (
                          <span key={m.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5 }} title={m.detail}>
                            <span style={{ width: 8, height: 8, borderRadius: "50%", background: m.color, display: "inline-block" }} />
                            <b style={{ color: m.color }}>{m.label}</b>
                            <span style={{ color: C.text, fontWeight: 700 }}>{m.value.toFixed(2)}%</span>
                          </span>
                        ))}
                      </div>
                      <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 5, lineHeight: 1.55 }}>
                        Fund yields are the <b>30-day SEC yield</b> (USFR as of {SEC_YIELDS.USFR.asOf}, SGOV {SEC_YIELDS.SGOV.asOf}) — forward and comparable, not the backward-looking TTM distribution figure;
                        the {cashYield?.src ?? "bill"} figure is the spot rate. Where a CPI line sits <i>above</i> the band, cash is losing to inflation.
                        {" · "}{chartData.length} monthly observations, {chartData[0]?.date} → {chartData[chartData.length - 1]?.date}.
                      </div>
                    </div>
                  )}
                </Card>
              );
            })()}

            {/* Aug-22 Part B — cash-yield comparison card, adjacent to the CPI tracker's cash read. */}
            <CashComparisonCard liveInd={liveInd} />

            {/* F.5 — the labour module is a paragraph of interpretation, so it sits where the
                user is already reading rather than glancing. Same shared definition as the
                Indicators tab (G.3) — one module, rendered once per tab. */}
            <div id="macro-labor" style={{ scrollMarginTop: 96 }} />
            <LaborPanel labor={laborView} extras={laborExtras} announced={laborAnnounced} />

            <div id="macro-recession" style={{ scrollMarginTop: 96 }} />
            <Card>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <SLabel>Wall Street Recession Probability</SLabel>
                {/* F.6 — the slowest input on the page, marked as such. */}
                <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>slowest input · {CONSENSUS_VINTAGE.label}, {CONSENSUS_VINTAGE.staleNote}</span>
              </div>
              {(() => {
                const lastUpdate = new Date("2026-06-29");
                const daysStale = Math.floor((Date.now() - lastUpdate.getTime()) / 86400000);
                const isStale = daysStale > 90;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10, fontSize: 12 }}>
                    <span style={{ color: C.lbl }}>Last updated: <b style={{ color: C.muted }}>June 29, 2026</b> · Updated post Iran peace deal + June FOMC</span>
                    {isStale && (
                      <span style={{ background: C.aBg, color: C.amber, border: "1px solid " + C.aBdr, borderRadius: 6, padding: "2px 8px", fontWeight: 700 }}>
                        ⚠️ {daysStale} days stale — refresh due (&gt;90-day cadence)
                      </span>
                    )}
                    <span style={{ color: C.lbl, fontStyle: "italic" }}>Updating this table recalculates regime probabilities automatically.</span>
                  </div>
                );
              })()}
              {/* ── ANALYST VIEW BOARD — the headline ──
                  What the professionals think, which regime each view implies, and whether the
                  live signals still agree with them. This is the section's actual purpose; the
                  numeric consensus below is a byproduct the regime engine consumes. */}
              <AnalystViewBoard
                live={{
                  oil: liveInd?.oil ?? null,
                  gdpGrowth: liveInd?.gdpGrowth ?? null,
                  yieldSpread: liveInd?.yieldSpread ?? null,
                  septHikeOdds: SEP_HIKE_ODDS?.value ?? null,
                  fedHawkish: /hawkish/i.test(FED_LANGUAGE_STATUS?.status || ""),
                  capexRising: true,   // big-four 2026 ~$725B (+77% YoY) — Smart Money tab, sourced
                }}
                probFor={(key) => {
                  const row = effectiveRecessionSources.find(r => r.name === key);
                  return row ? parseProbability(row.probability) : null;
                }}
                engineRegime={liveRegime?.id}
                consensus={recConsensus}
              />

              {/* ── TWO-HORIZON CONSENSUS — the byproduct ──
                  These are two different questions and are never blended: a
                  calendar-year contract resolves inside a window that shrinks toward Dec 31, so
                  averaging it with rolling-12m forecasts pushed the consensus down for calendar
                  reasons alone — and that number drives the regime engine and position sizing. */}
              {(() => {
                const { rolling: roll, calendar: cal, calWindow: cw, weightedAvg: legacy } = recConsensus;
                const disp = dispersionRead(roll);
                const box = (title, c, opts = {}) => (
                  <div style={{ flex: "1 1 260px", background: opts.primary ? C.blBg : C.bg, border: "1.5px solid " + (opts.primary ? C.blBdr : C.bdr), borderRadius: 10, padding: "11px 13px" }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: opts.primary ? C.blue : C.muted }}>{title}</span>
                      {opts.primary && <span style={{ fontSize: 9.5, fontWeight: 800, color: "#fff", background: C.blue, borderRadius: 4, padding: "1px 6px" }}>DRIVES REGIME</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
                      <b style={{ fontSize: 24, color: c.value == null ? C.muted : C.text, lineHeight: 1.1 }}>{c.value == null ? "—" : c.value + "%"}</b>
                      {c.spread != null && c.nSources > 1 && (
                        <span style={{ fontSize: 12, color: C.lbl }}>range {c.lo}–{c.hi}%</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
                      {c.nSources} row{c.nSources === 1 ? "" : "s"} → <b style={{ color: c.thin ? C.amber : C.mid }}>{c.nEffective} independent view{c.nEffective === 1 ? "" : "s"}</b>
                      {c.views?.some(v => v.isBlock) && <span> · correlated sources counted once</span>}
                      {opts.note}
                    </div>
                    {c.thin && (
                      <div style={{ marginTop: 6, fontSize: 11, color: C.amber, fontWeight: 700 }}>
                        ⚠ Thin — resting on a single independent view. Treat as indicative.
                      </div>
                    )}
                  </div>
                );
                return (
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: C.muted, marginBottom: 6 }}>
                      Numeric consensus <span style={{ fontWeight: 600, textTransform: "none", letterSpacing: 0, color: C.lbl }}>— the scalar the regime engine needs. The board above is the read; this is the byproduct.</span>
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      {box(HORIZON_LABEL[HORIZON.ROLLING], roll, { primary: true })}
                      {box(HORIZON_LABEL[HORIZON.CALENDAR], cal, {
                        note: cw ? <span> · <b style={{ color: cw.shrinking ? C.amber : C.mid }}>{cw.monthsLeft} months</b> of window left</span> : null,
                      })}
                    </div>
                    {cw?.shrinking && (
                      <div style={{ marginTop: 8, padding: "9px 12px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8, fontSize: 12, color: C.amber, lineHeight: 1.6 }}>
                        ⏳ <b>Calendar effect:</b> the by-year-end contracts have only <b>{cw.monthsLeft} months</b> left to resolve in (they had 7.0 in June).
                        Their price must fall toward zero as Dec 31 approaches <i>even if nothing changes in the economy</i> — so a decline here is not
                        automatically falling recession risk. This is why they no longer feed the regime engine.
                      </div>
                    )}
                    {disp?.wide && (
                      <div style={{ marginTop: 8, padding: "9px 12px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8, fontSize: 12, color: C.amber, lineHeight: 1.6 }}>
                        ⚖ <b>Wide dispersion:</b> {disp.text}.
                      </div>
                    )}
                    <div style={{ marginTop: 7, fontSize: 11, color: C.lbl, lineHeight: 1.6 }}>
                      {NO_CONVERSION_NOTE}
                      {legacy != null && roll.value != null && Math.abs(legacy - roll.value) >= 0.1 && (
                        <> <span style={{ color: C.muted }}>The former all-horizons blend read <b>{legacy.toFixed(1)}%</b>; the regime engine now uses <b>{roll.value}%</b>.</span></>
                      )}
                    </div>
                  </div>
                );
              })()}
              {/* Provenance: these are hand-maintained. There is no keyless feed for broker
                  recession odds, so they are NOT auto-refreshed — each row carries its own as-of
                  and is flagged OVERDUE against that source's own publication cadence (not a flat
                  threshold) rather than being silently updated. */}
              <div style={{ marginBottom: 10, padding: "8px 11px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, fontSize: 12, color: C.mid, lineHeight: 1.55 }}>
                <b style={{ color: C.muted }}>Provenance: </b>
                three rows carry a live feed — <b>📡 Kalshi</b> and <b>Polymarket</b> (real-money markets) and the
                <b> NY&nbsp;Fed Yield&nbsp;Curve</b> (Estrella–Mishkin probit computed from the current 10Y-3M spread).
                The broker/analyst rows have no keyless feed, so they are <b>not</b> auto-refreshed — each shows its own
                as-of, judged against <i>that source's</i> publication cadence: <b>latest</b> (its current view — research houses
                publish episodically) or <b>⚠ overdue</b> (past due for a source that should have printed by now).
                Age still decays a row's weight in the average either way. Any row can be overridden by hand below (<b>✍️ manual</b>),
                which takes precedence over both the feed and the static value.
                <span style={{ color: C.amber, fontWeight: 700 }}> Q2 GDP at +1.5% (vs Q1 +2.1%) is the input most likely to push these up — expect revisions at the next publication, not before.</span>
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 400 }}>
                  <thead>
                    <tr style={{ background: C.bg }}>
                      {["Source", "Probability", "Revisions", "As of", "Timeframe", "Notes"].map(h => (
                        <th key={h} style={{ textAlign: "left", color: C.mid, padding: "8px 12px", borderBottom: "2px solid " + C.bdr, fontSize: 13, fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {effectiveRecessionSources.filter(r => !r.archived).map((r, i) => {
                      const pCol = r.color === "red" ? C.red : r.color === "amber" ? C.amber : C.green;
                      // Provenance badge: 📡 live = refreshed by an auto-feed this load; ✍️ manual =
                      // a hand-entered override in the manual store; static rows show nothing.
                      const prov = r.source === "auto"
                        ? { label: "📡 live", col: C.green, bg: C.gBg, bdr: C.gBdr }
                        : r.source === "manual"
                        ? { label: "✍️ manual", col: C.blue, bg: C.bg, bdr: C.bdr }
                        : null;
                      return (
                      <tr key={i} style={{ background: i % 2 === 0 ? C.surf : C.bg }}>
                        <td style={{ padding: "8px 12px", color: C.text, fontSize: 14, fontWeight: 600, borderBottom: "1px solid " + C.bdr }}>
                          {r.name}
                          {prov && (
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: prov.col, background: prov.bg, border: "1px solid " + prov.bdr, borderRadius: 5, padding: "1px 5px", whiteSpace: "nowrap" }}>{prov.label}</span>
                          )}
                        </td>
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid " + C.bdr }}>
                          <span style={{ color: pCol, fontWeight: 800, fontSize: 15 }}>{r.probability}</span>
                        </td>
                        {/* Revisions — direction of travel + a DESCRIPTIVE behaviour grade. A level
                            alone hides whether a source is being revised up or down, and whether it
                            round-trips (revising up then straight back = following the news, not
                            leading it). Accuracy is deliberately NOT scored: recessions are rare and
                            NBER declares them 6–18 months late, so an accuracy score would take
                            years to say anything. See lib/recession.js. */}
                        <td style={{ padding: "8px 12px", fontSize: 12, borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap" }}>
                          {(() => {
                            const hist = RECESSION_REVISIONS[r.name];
                            if (!hist || hist.length < 2) return <span style={{ color: C.lbl }}>—</span>;
                            const sc = sourceScore(hist, new Date().toISOString().slice(0, 10));
                            const lr = sc.last;
                            const gCol = sc.grade === "reactive" ? C.amber : sc.grade === "steady" ? C.green : C.mid;
                            return (
                              <span title={`${hist.map(h => h.prob + "%").join(" → ")}  ·  ${sc.note}`}>
                                <b style={{ color: lr.dir === "up" ? C.red : lr.dir === "down" ? C.green : C.muted }}>
                                  {lr.dir === "up" ? "▲" : lr.dir === "down" ? "▼" : "—"} {lr.delta > 0 ? "+" : ""}{lr.delta}pp
                                </b>
                                <span style={{ color: C.lbl }}> from {lr.from}%</span>
                                <div style={{ fontSize: 10, fontWeight: 800, color: gCol, textTransform: "uppercase", letterSpacing: 0.3, marginTop: 2 }}>
                                  {sc.grade}{sc.trips > 0 ? ` · ${sc.trips} reversal${sc.trips > 1 ? "s" : ""}` : ""}
                                </div>
                              </span>
                            );
                          })()}
                        </td>
                        {/* As-of + freshness, judged against the SOURCE'S OWN cadence. An old
                            figure must never read as a current post-FOMC one — but neither should
                            a research house's latest print read as a failed fetch. */}
                        <td style={{ padding: "8px 12px", fontSize: 12, borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap" }}>
                          {(() => {
                            const st = recessionAsOfState(r.name, r.asOf);
                            if (!st) return <span style={{ color: C.lbl }}>—</span>;
                            return (
                              <span
                                style={{ color: st.overdue ? C.amber : C.muted, fontWeight: st.overdue ? 700 : 400 }}
                                title={st.overdue
                                  ? `${r.name} publishes roughly every ${st.cadence}d; this print is ${st.days}d old — past due, worth checking for a newer one.`
                                  : `${st.days}d old, within ${r.name}'s ~${st.cadence}d publication cadence — this is its latest print, not an overdue one. Weight still decays with age in the average.`}
                              >
                                {r.asOf}
                                {st.overdue
                                  ? ` · ⚠ ${st.days}d overdue`
                                  : <span style={{ color: C.lbl }}> · latest · {st.days}d</span>}
                              </span>
                            );
                          })()}
                        </td>
                        <td style={{ padding: "8px 12px", color: C.muted, fontSize: 13, borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap" }}>{r.timeframe}</td>
                        <td style={{ padding: "8px 12px", color: C.muted, fontSize: 13, borderBottom: "1px solid " + C.bdr }}>{r.notes}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* A1 — archived March vintages: condition invalidated, excluded from the weighted average.
                  Collapsed by default; the reason (not just the date) is rendered. */}
              {(() => {
                const arch = effectiveRecessionSources.filter(r => r.archived);
                if (!arch.length) return null;
                return (
                  <details style={{ marginTop: 10, background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, padding: "6px 11px" }}>
                    <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 800, color: C.muted, letterSpacing: 0.3 }}>
                      🗄️ Historical vintage — condition invalidated ({arch.length}) · excluded from the weighted average
                    </summary>
                    <div style={{ fontSize: 11.5, color: C.lbl, margin: "6px 0 8px", lineHeight: 1.5 }}>
                      All four were March-2026 estimates explicitly conditional on a sustained oil shock (Brent forecast $105–115). That condition resolved — Brent ~$91.57 — and none received a published post-deal revision. Goldman's own round-trip (15% → 30% → 15%) is the control. Decayed weight would still let them leak in; archiving removes them.
                    </div>
                    {arch.map((r, i) => (
                      <div key={i} style={{ padding: "6px 0", borderTop: i ? "1px solid " + C.bdr : "none", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.muted, textDecoration: "line-through" }}>{r.name}</span>
                        <span style={{ fontSize: 12.5, fontWeight: 800, color: C.lbl }}>{r.probability}</span>
                        <span style={{ fontSize: 10.5, color: C.muted }}>({r.asOf})</span>
                        <span style={{ fontSize: 11, color: C.lbl, fontStyle: "italic", flexBasis: "100%" }}>{r.archiveReason}</span>
                      </div>
                    ))}
                  </details>
                );
              })()}
              {/* A4 — leading-indicator context feeds. Not weighted into the consensus average (they
                  are indicators/nowcasts, not 12-month recession probabilities), but they carry the
                  live signal the archived analyst vintages no longer can. */}
              <div style={{ marginTop: 10, padding: "8px 11px", background: C.surf, border: "1px solid " + C.bdr, borderRadius: 8 }}>
                <div style={{ fontSize: 10.5, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Leading indicators · context, not weighted</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 8 }}>
                  {[
                    { n: "Sahm Rule", src: "FRED SAHMREALTIME", read: laborView?.sahm?.value != null ? `${laborView.sahm.value.toFixed(2)} — reads away from the 0.50 trigger` : "reads away from the 0.50 trigger (see Labour module)", tone: "green" },
                    { n: "Cleveland Fed yield-curve", src: "distinct probit from the NY Fed model", read: "add via manual entry — no keyless feed", tone: "muted" },
                    { n: "Conference Board LEI", src: "6-month annualised rate", read: "add via manual entry — no keyless feed", tone: "muted" },
                    { n: "Atlanta Fed GDPNow", src: "highest-frequency growth nowcast", read: "add via manual entry — no keyless feed", tone: "muted" },
                  ].map(x => (
                    <div key={x.n} style={{ fontSize: 11.5, lineHeight: 1.45 }}>
                      <div style={{ fontWeight: 800, color: C.text }}>{x.n}</div>
                      <div style={{ color: x.tone === "green" ? C.green : C.muted, fontWeight: 600 }}>{x.read}</div>
                      <div style={{ color: C.lbl, fontSize: 10 }}>{x.src}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 12, padding: "12px 14px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8 }}>
                <span style={{ color: C.amber, fontWeight: 700, fontSize: 13 }}>⚠️ The signal that matters: </span>
                <span style={{ color: C.amber, fontSize: 14, lineHeight: 1.65 }}>Goldman's dramatic round-trip — 15% (pre-war) → 30% (March peak) → 15% (June post-deal) — shows how oil-driven the near-term risk was. Post peace deal, 2026 recession odds have broadly normalized. The more important signal is 2027: Kalshi at {recKalshi2027 != null ? recKalshi2027 : 41}% (the live market) suggests markets expect delayed reckoning from debt refinancing at 5-7%, $1.3T consumer revolving credit balances, and corporate capex compression — still the higher of the two horizons. New risk to monitor: the July FOMC minutes (released Aug 19) show 'many participants' saw further tightening as likely necessary — an upgrade from June's 'only a few', so the three hike dissents understate the committee's hawkishness. If hikes materialize, recession risk reprices sharply higher.</span>
              </div>
            </Card>

            <RecessionEntryPanel overrides={recessionOverrides} onSaved={setRecessionOverrides} />

            <div id="macro-transitions" style={{ scrollMarginTop: 96 }} />
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                <SLabel>Transition Roadmap</SLabel>
                <Btn onClick={fetchIndicators} disabled={indLoading} color="#fff" bgColor={C.blue} label={indLoading ? "Fetching…" : "🔄 Refresh signals"} />
              </div>
              {(() => {
                // Live values with static fallbacks
                const hy  = liveInd ? liveInd.creditSpread  : 2.75;
                const ue  = laborView?.u3?.value ?? (liveInd ? liveInd.unemployment : 4.4);
                const yc  = liveInd ? liveInd.yieldSpread   : 0.38;
                const cpi = liveInd ? liveInd.cpi            : null;
                const gdp = liveInd ? liveInd.gdp            : null;
                const oil = liveInd?.oil ?? 88;
                const oilPrev = liveInd?.oilPrev ?? null;

                // CPI/GDP formatted for display
                // FRED CPIAUCSL is an index level (~315), not a % — compute YoY% from context note
                // GDP is quarterly real GDP in billions
                const cpiNote = cpi && cpi > 100
                  ? `CPI index at ${cpi.toFixed(1)} (latest BLS release via FRED — reflects most recently published monthly figure)`
                  : "CPI: fetching from FRED…";
                // GROWTH, not just the level — a level cannot answer "is growth decelerating".
                // Prefers the announced advance estimate while FRED still lags it, labelled as such.
                const gAnn = announced("gdpGrowth", liveInd?.asOf?.gdpGrowth);
                const gNow = gAnn ? gAnn.value : liveInd?.gdpGrowth;
                const gPrev = gAnn ? gAnn.prev : liveInd?.gdpGrowthPrev;
                const gdpNote = (() => {
                  if (gNow == null) return gdp && gdp > 0
                    ? `Real GDP: $${(gdp/1000).toFixed(1)}T (level only — growth rate not yet available)`
                    : "GDP: fetching from FRED…";
                  const dir = (gPrev != null) ? (gNow < gPrev ? "decelerating" : gNow > gPrev ? "accelerating" : "flat") : null;
                  const src = gAnn ? `${gAnn.source}, announced ${gAnn.released} — not yet in FRED` : "BEA via FRED";
                  return `Real GDP growth: ${gNow > 0 ? "+" : ""}${gNow}% annualised`
                    + (dir && gPrev != null ? `, ${dir} from ${gPrev > 0 ? "+" : ""}${gPrev}%` : "")
                    + ` (${src})`
                    + (gdp && gdp > 0 ? ` · level $${(gdp/1000).toFixed(1)}T` : "");
                })();

                // SignalBar — with analyst context sentence below the bar
                function SignalBar({ label, value, unit, threshold, thresholdLabel, good, fmtVal, context }) {
                  const pct = Math.min(100, Math.max(0, (value / (threshold * 1.5)) * 100));
                  const breached = good === "below" ? value >= threshold : value <= threshold;
                  const barColor = breached ? C.red : C.green;
                  const statusLabel = breached ? "⚠️ BREACHED" : "✅ OK";
                  const statusColor = breached ? C.red : C.green;
                  return (
                    <div style={{ background: C.bg, borderRadius: 8, padding: "10px 12px", border: "1px solid " + C.bdr, flex: "1 1 150px", minWidth: 140 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                        <span style={{ color: C.mid, fontSize: 11, fontWeight: 700 }}>{label}</span>
                        <span style={{ color: statusColor, fontSize: 10, fontWeight: 800 }}>{statusLabel}</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 6 }}>
                        <span style={{ fontSize: 19, fontWeight: 900, color: C.text, lineHeight: 1 }}>{fmtVal ? fmtVal(value) : value}{unit}</span>
                        <span style={{ fontSize: 11, color: C.lbl }}>vs {thresholdLabel}</span>
                      </div>
                      <div style={{ height: 5, background: C.bdr, borderRadius: 3, overflow: "hidden", marginBottom: 6 }}>
                        <div style={{ width: pct + "%", height: "100%", background: barColor, borderRadius: 3, transition: "width 0.4s" }} />
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: context ? 7 : 0 }}>
                        <span style={{ fontSize: 10, color: C.lbl }}>0</span>
                        <span style={{ fontSize: 10, color: breached ? C.red : C.lbl, fontWeight: breached ? 700 : 400 }}>threshold {threshold}{unit}</span>
                      </div>
                      {context && (
                        <div style={{ fontSize: 11, color: breached ? C.red : C.green, lineHeight: 1.5, borderTop: "1px solid " + C.bdr, paddingTop: 6 }}>
                          {context(value, breached)}
                        </div>
                      )}
                    </div>
                  );
                }

                const ROADMAP = [
                  {
                    label: "Stagflation → Deflationary Recession",
                    regimeKey: "def", character: "Painful", tiebreak: 2, color: C.blue,
                    path: "High oil + tight Fed choke off demand. Businesses stop hiring, consumers stop spending. Credit markets crack first — then unemployment surges. Treasuries and cash win. Everything else falls.",
                    signals: [
                      {
                        label: "HY Credit Spread", value: hy, unit: "%", threshold: 4.5,
                        thresholdLabel: "alert >4.5%", good: "below", fmtVal: v => v.toFixed(2),
                        context: (v, breached) => breached
                          ? `At ${v.toFixed(2)}%, credit markets are pricing stress. Companies are struggling to refinance debt — this is the classic deflationary warning. Act now.`
                          : `At ${v.toFixed(2)}%, credit markets are calm — investors aren't panicking yet. This scenario needs spreads to widen to 4.5%+ before it becomes probable. Watch weekly.`,
                      },
                      // P1.4 — the trigger is the EMPLOYMENT–POPULATION RATIO, not U3.
                      // U3 can FALL during exactly the deterioration this scenario exists to
                      // catch, because people leaving the labour force shrink the numerator
                      // without anyone being hired (June 2026: U3 4.3→4.2 while emp-pop fell
                      // 0.2pp). Emp-pop cannot be gamed that way. U3 is still displayed — in
                      // the labour panel above and in the stagflation scenario — it just no
                      // longer decides whether this transition has fired.
                      (() => {
                        const ep = laborView?.empPop;
                        if (ep?.ok && ep.value != null && ep.prev != null) {
                          return {
                            label: "Emp–pop ratio", value: ep.value, unit: "%",
                            // "Breached" = below the prior print, i.e. FALLING.
                            threshold: ep.prev, thresholdLabel: `falling vs prior ${ep.prev.toFixed(1)}%`,
                            good: "above", fmtVal: v => v.toFixed(1),
                            context: (v, breached) => breached
                              ? `Emp-pop at ${v.toFixed(1)}%, down from ${ep.prev.toFixed(1)}% — a smaller share of the working-age population is employed. This is the trigger, not the unemployment rate: U3 can fall while this falls, and in June it did exactly that.`
                              : `Emp-pop at ${v.toFixed(1)}%, holding at or above the prior ${ep.prev.toFixed(1)}%. The employed share of the population is not shrinking, so the transition has not fired regardless of what the headline rate does.`,
                          };
                        }
                        // No emp-pop print → show U3 but say plainly it is not the trigger.
                        return {
                          label: "Unemployment (not the trigger)", value: ue, unit: "%", threshold: 5.0,
                          thresholdLabel: "emp-pop unavailable", good: "below", fmtVal: v => v.toFixed(1),
                          context: v => `Emp-pop ratio unavailable, so the transition trigger cannot be evaluated. U3 ${v.toFixed(1)}% is shown for reference only — it is deliberately not the trigger, because it can fall on labour-force exit.`,
                        };
                      })(),
                    ],
                    tip: liveInd
                      ? (hy > 4.5 ? "⚠️ Credit spreads have breached the alert level. Deflationary recession risk is now elevated — consider rotating toward Treasuries and cash."
                        : hy > 3.5 ? "📡 Spreads are widening toward the alert zone. Start building insurance positions — don't wait for 4.5% to confirm."
                        : `✅ Both indicators are well within safe territory today. This scenario requires credit spreads to more than double from here (${hy.toFixed(2)}% → 4.5%+). Low near-term risk.`)
                      : "Hit Refresh signals to get live readings for this scenario.",
                  },
                  {
                    label: "Stagflation → Reflationary Recovery",
                    regimeKey: "ref", character: "Best case", tiebreak: 3, color: C.green,
                    path: "A Gulf peace deal or OPEC production increase brings oil below $80. Inflation cools, the Fed resumes cutting, and growth bounces back. This is the best-case exit from stagflation — and what equity markets would celebrate most.",
                    signals: [
                      {
                        label: "Yield Spread", value: Math.abs(yc), unit: "%", threshold: 0.5,
                        thresholdLabel: "normal >0.5%", good: "above", fmtVal: v => (yc >= 0 ? "+" : "-") + v.toFixed(2),
                        context: (v, breached) => breached
                          ? `Spread is below 0.5% — curve hasn't fully normalized yet. Recovery hasn't been confirmed by the bond market.`
                          : `At ${(yc >= 0 ? "+" : "") + yc.toFixed(2)}%, the yield curve has re-normalized. Historically this means the bond market is no longer pricing a recession — a good early sign for recovery.`,
                      },
                      {
                        label: "WTI Crude Oil", value: oil, unit: "$", threshold: 80,
                        thresholdLabel: "target <$80", good: "below", fmtVal: v => "$" + v,
                        context: (v, breached) => breached
                          ? `WTI crude at $${v.toFixed(1)} is the primary blockage. Until oil falls below $80, inflation stays too sticky for the Fed to cut. ${oilPrev ? (v > oilPrev ? "Price is rising — moving in the wrong direction." : "Price is falling — trending toward the trigger.") : ""}`
                          : `✅ WTI crude at $${v.toFixed(1)} — below the $80 reflationary trigger. Oil is no longer the inflation blockage. The Fed now has room to cut if labour market data warrants it.`,
                      },
                    ],
                    tip: (() => {
                      const oilDir = oilPrev && oil ? (oil > oilPrev ? "↑ rising" : "↓ falling") : "";
                      const oilNote = oil < 80
                        ? `WTI at $${oil.toFixed(1)} is technically below the $80 trigger — but July 7–8 Hormuz attacks reversed the disinflationary impulse. The Fed needs sustained sub-$80 oil for multiple months, not a brief dip.`
                        : `WTI at $${oil.toFixed(1)} ${oilDir} — above the $80 threshold. Until sustained below $80, inflation stays too sticky for the Fed to cut.`;
                      return `⚠️ June FOMC minutes (Jul 8): "only a few" members saw a case to hike — less hawkish than the dot plot implied, but Warsh gave no forward guidance and is firmly on hold. ${oilNote} Next live catalysts: June CPI (mid-July) and June PCE (late July).`;
                    })(),
                  },
                  {
                    label: "Persistent Stagflation — no transition, regime persists",
                    regimeKey: "stag", character: "1970s path", tiebreak: 1, color: C.amber,
                    path: "The Iran conflict drags on for years. Oil stays elevated. The Fed is paralysed — it can't raise rates without crushing growth, and can't cut without reigniting inflation. Gold and real assets become the only reliable stores of value.",
                    signals: [
                      {
                        label: "Unemployment", value: ue, unit: "%", threshold: 4.5,
                        thresholdLabel: "elevated >4.5%", good: "below", fmtVal: v => v.toFixed(1),
                        context: (v, breached) => breached
                          ? `Unemployment above 4.5% while inflation stays high is the textbook stagflation combination — the same dynamic the US faced in 1974–1982.`
                          : `At ${v.toFixed(1)}%, unemployment is approaching the zone where the Fed's dual mandate becomes impossible to satisfy simultaneously.`,
                      },
                      {
                        label: "Yield Spread", value: Math.abs(yc), unit: "%", threshold: 1.0,
                        thresholdLabel: "normal >1%", good: "above", fmtVal: v => (yc >= 0 ? "+" : "-") + v.toFixed(2),
                        context: (v, breached) => breached
                          ? `Spread hasn't reached 1%+ — the curve isn't pricing a sustained growth recovery yet. Consistent with a prolonged stagnation environment.`
                          : `Spread above 1% suggests the bond market expects growth to recover — which would make persistent stagflation less likely.`,
                      },
                    ],
                    tip: (() => {
                      const cpiLine = cpi ? `Latest CPI index: ${cpi.toFixed(1)} (FRED, most recent monthly release).` : "CPI: fetching…";
                      const gdpLine = gdp ? `Real GDP: $${(gdp/1000).toFixed(1)}T (FRED, most recent quarterly release).` : "GDP: fetching…";
                      return `📊 ${cpiLine} ${gdpLine} The 1970s confirmation signal is CPI staying above 3.5% for 6+ consecutive months while GDP growth stays below 2%. Both are published monthly/quarterly by the BLS and BEA — FRED pulls the latest figure automatically when you hit Refresh.`;
                    })(),
                  },
                  {
                    label: "Any regime → Inflationary Boom",
                    regimeKey: "inf", character: "Dalio scenario", tiebreak: 4, color: "#7C3AED",
                    path: "The US government keeps spending regardless of the Fed. The dollar structurally weakens. AI generates a genuine productivity surprise. The result: persistent inflation above 4%, but with real growth — a 1990s-style boom with a debasement twist. Gold miners, commodities, and Bitcoin are the standout winners.",
                    signals: [
                      {
                        label: "Yield Spread", value: Math.abs(yc), unit: "%", threshold: 1.5,
                        thresholdLabel: "boom >1.5%", good: "above", fmtVal: v => (yc >= 0 ? "+" : "-") + v.toFixed(2),
                        context: (v, breached) => breached
                          ? `Spread above 1.5% would suggest the bond market is pricing strong sustained growth — a precondition for this scenario.`
                          : `At ${(yc >= 0 ? "+" : "") + yc.toFixed(2)}%, the spread is well below the 1.5% level associated with inflationary boom conditions. This scenario remains a tail risk.`,
                      },
                      {
                        label: "US Dollar Index", value: liveInd?.dxy ?? 105, unit: "", threshold: 95,
                        thresholdLabel: "weak <95", good: "below", fmtVal: v => v.toFixed(1),
                        context: (v, breached) => breached
                          ? `Dollar index at ${v.toFixed(1)} — weakening meaningfully. A sustained break below 95 would signal dollar structural decline, which is a key precondition for the inflationary boom scenario.`
                          : `Dollar index at ${v.toFixed(1)} — still relatively strong. A structural dollar decline (sustained below 95) would be required to validate this scenario. Watch for sustained trend lower.`,
                      },
                      {
                        label: "M2 Money Supply", value: liveInd?.m2 ? liveInd.m2 / 1000 : 21.5, unit: "T", threshold: 22,
                        thresholdLabel: "re-accel >$22T", good: "above", fmtVal: v => "$" + v.toFixed(1),
                        context: (v, breached) => {
                          const dir = liveInd?.m2Rising ? "↑ rising" : "↓ falling";
                          return breached
                            ? `M2 at $${v.toFixed(1)}T and ${dir} — money supply re-accelerating is the Fed losing control of the inflation narrative. Combined with a weak dollar, this is the Dalio scenario in motion.`
                            : `M2 at $${v.toFixed(1)}T, ${dir}. Re-acceleration above $22T would suggest fiscal dominance — the government printing faster than the Fed can tighten.`;
                        },
                      },
                    ],
                    tip: (() => {
                      const dxyVal = liveInd?.dxy;
                      const m2Val  = liveInd?.m2;
                      const m2Dir  = liveInd?.m2Rising;
                      if (!dxyVal && !m2Val) return "Hit Refresh signals to get live DXY and M2 readings for this scenario.";
                      const dxyNote = dxyVal
                        ? (dxyVal < 95 ? `⚠️ Dollar index at ${dxyVal.toFixed(1)} — below the 95 warning level. Dollar weakening is a live signal.`
                          : `Dollar index at ${dxyVal.toFixed(1)} — no structural decline yet. Needs to break below 95 to validate.`)
                        : "";
                      const m2Note = m2Val
                        ? (m2Dir ? `⚠️ M2 is re-accelerating ($${(m2Val/1000).toFixed(1)}T, rising) — money supply expanding again.`
                          : `M2 at $${(m2Val/1000).toFixed(1)}T and falling — not yet signalling fiscal dominance.`)
                        : "";
                      return `${dxyNote} ${m2Note} Both signals need to confirm simultaneously for this scenario to become probable. Currently a tail risk — but hold gold miners as insurance regardless.`.trim();
                    })(),
                  },
                ];

                // Item 2 — rank is DERIVED from live probability, not baked into a string. Sort
                // descending by probability; ties broken by a stable secondary key (`tiebreak`)
                // so the order never jitters on refresh. The rank badge comes from the sorted
                // index; the character tag ("Painful", "1970s path", …) stays per-scenario.
                const RANK_BADGES = ["Most likely", "2nd most likely", "3rd", "4th"];
                const rankSorted = [...ROADMAP].sort((a, b) =>
                  (regimeProbFor(b.regimeKey) - regimeProbFor(a.regimeKey)) || (a.tiebreak - b.tiebreak));
                return rankSorted.map((r, i) => (
                  <div key={r.regimeKey} style={{ padding: "16px 0", borderBottom: i < rankSorted.length - 1 ? "1px solid " + C.bdr : "none" }}>
                    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                      <div style={{ flexShrink: 0, width: 120, paddingTop: 2 }}>
                        <div style={{ background: r.color + "15", color: r.color, border: "1.5px solid " + r.color + "40", borderRadius: 8, padding: "6px 8px", textAlign: "center", lineHeight: 1.25 }}>
                          <div style={{ fontSize: 19, fontWeight: 900 }}>{regimeProbFor(r.regimeKey)}%</div>
                          <div style={{ fontSize: 10, fontWeight: 800, marginTop: 3 }}>{RANK_BADGES[i] || `${i + 1}th`}</div>
                          <div style={{ fontSize: 9.5, fontWeight: 700, marginTop: 2, opacity: 0.85 }}>{r.character}</div>
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 5 }}>{r.label}</div>
                        <div style={{ color: C.mid, fontSize: 13, lineHeight: 1.7, marginBottom: 10 }}>{r.path}</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
                          {r.signals.map((s, si) => (
                            <SignalBar key={si} {...s} />
                          ))}
                        </div>
                        <div style={{ background: r.color + "0D", border: "1px solid " + r.color + "30", borderRadius: 8, padding: "9px 12px", color: r.color, fontSize: 12, lineHeight: 1.65, fontWeight: 500 }}>
                          📡 {r.tip}
                        </div>
                      </div>
                    </div>
                  </div>
                ));
              })()}
            </Card>
          </div>
        )}

        </TabErrorBoundary>

        {/* FOOTER */}
        <div style={{ color: C.lbl, fontSize: 12, textAlign: "center", marginTop: 20, paddingTop: 14, borderTop: "1px solid " + C.bdr }}>
          Data: SEC 13F (Q2 2026 · positions as of Jun 30, filed by Aug 14 · via FMP/sec_13f; Pershing pulled direct from EDGAR) — Pershing now files via public parent Pershing Square Inc., Fairfax non-13F · FRED / ICE BofA / US Treasury · Berkshire cash $397B is the Q1 10-Q (Q2 pending).<br />
          Editable fund data auto-saves to browser storage · Global family portfolio (UAE/HK/Canada) — consult local tax advisors for withholding treatment · Not investment advice.
        </div>
      </div>
    </div>
  );
}