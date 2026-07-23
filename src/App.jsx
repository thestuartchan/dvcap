import { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, RadarChart, PolarGrid,
  PolarAngleAxis, Radar, PieChart, Pie, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, LabelList,
} from "recharts";
import { parseKofia, kofiaDisplay, kofiaStoredLine, KOFIA_NAME_BY_KEY, KOFIA_CURRENCY, toWonTrillions, koreaFlowRead } from "../lib/kofia.js";
import { freshnessText, humanizeAge } from "../lib/sessions.js";

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
    detail: (v) => `Currently ${v >= 0 ? "+" : ""}${v.toFixed(2)}% after the longest inversion (Oct 2022–Dec 2024) in modern history. Recessions historically arrive 4–11 months AFTER the curve un-inverts — the re-steepening phase is the danger window. A fully normal curve is above +1.0%.`,
    thresholds:[
      {val:-0.5, label:"Deep inversion", color:"#DC2626", dash:"4 2"},
      {val:0,    label:"Inversion line",  color:"#D97706", dash:"5 3"},
      {val:1.0,  label:"Normal",          color:"#16A34A", dash:"4 2"},
    ],
    // Returns independent assessment based on this indicator's own live value
    signal(liveVal) {
      const v = liveVal ?? 0.38;
      if (v < -0.5)  return { label:"Deep Inversion", text:"Severe inversion — historically the strongest recession predictor. Average lead time: 12–18 months.",       color:"#991B1B", bg:"#FEF2F2", bdr:"#FCA5A5" };
      if (v < 0)     return { label:"Inverted",        text:"Curve still inverted — markets pricing Fed cuts ahead of deteriorating growth.",                            color:"#DC2626", bg:"#FEF2F2", bdr:"#FCA5A5" };
      if (v < 0.5)   return { label:"Danger Window",   text:"Just re-normalized. Recessions historically strike 4–11 months after un-inversion. This is the risk zone.", color:"#92400E", bg:"#FFFBEB", bdr:"#FCD34D" };
      if (v < 1.0)   return { label:"Steepening",      text:"Curve steepening — consistent with either reflationary recovery or stagflation. Watch credit spreads to differentiate.", color:"#D97706", bg:"#FFFBEB", bdr:"#FCD34D" };
      return           { label:"Normal",               text:"Curve fully normalized. Historical recession risk low based on this indicator alone.",                       color:"#166534", bg:"#F0FDF4", bdr:"#86EFAC" };
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
      if (v >= 5.5)  return { label:"Recession Confirmed",  text:"Unemployment above 5.5% — recession is underway by historical standards. Capital preservation is the priority.", color:"#991B1B", bg:"#FEF2F2", bdr:"#FCA5A5" };
      if (v >= 5.0)  return { label:"Recession Zone",       text:"Crossed 5.0% — recession historically confirmed at this level. Defensive positioning warranted.",              color:"#DC2626", bg:"#FEF2F2", bdr:"#FCA5A5" };
      if (v >= 4.5)  return { label:"Sahm Rule Triggered",  text:"At or above the Sahm Rule threshold. Labour market deteriorating — leading indicator for recession.",           color:"#92400E", bg:"#FFFBEB", bdr:"#FCD34D" };
      if (v >= 4.0)  return { label:"Elevated vs '23 low",  text:"Above the 4.0% historical average and well up from the 3.4% '23 trough — but that's the trend-since-low read; check the last-vs-prior print for near-term direction.", color:"#D97706", bg:"#FFFBEB", bdr:"#FCD34D" };
      return           { label:"Healthy",                   text:"Below historical average. Labour market resilient — low near-term recession risk from this indicator.",         color:"#166534", bg:"#F0FDF4", bdr:"#86EFAC" };
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
      if (v >= 6.0)  return { label:"Recession Imminent",  text:"Spreads above 6% — markets pricing systemic stress. This is the deflationary trip wire. Rotate to Treasuries and cash immediately.", color:"#991B1B", bg:"#FEF2F2", bdr:"#FCA5A5" };
      if (v >= 4.5)  return { label:"Alert — Act Now",     text:"Breached the 4.5% alert threshold. Insurance accumulation phase is over — full defensive rotation warranted.",                      color:"#DC2626", bg:"#FEF2F2", bdr:"#FCA5A5" };
      if (v >= 3.5)  return { label:"Widening — Watch",    text:"Spreads widening toward the alert zone. Begin building insurance positions. Don't wait for 4.5% to confirm.",                       color:"#92400E", bg:"#FFFBEB", bdr:"#FCD34D" };
      if (v >= 3.0)  return { label:"Mild Stress",         text:"Mild stress appearing. Markets slightly nervous but not panicking. Monitor weekly.",                                                  color:"#D97706", bg:"#FFFBEB", bdr:"#FCD34D" };
      return           { label:"Benign — No Stress",       text:"Markets are calm. No credit stress priced. This is the window to accumulate insurance cheaply before spreads move.",                 color:"#166534", bg:"#F0FDF4", bdr:"#86EFAC" };
    },
  },
];

// ─── INSURANCE ASSETS ─────────────────────────────────────────────────────────
const ASSETS = [
  {
    id:"miners", name:"Gold Miners", icon:"⛏️", color:"#92400E", bg:"#FFFBEB", bdr:"#FCD34D",
    stagRank:1, defRank:4, refRank:3, infRank:1, volatility:"HIGH",
    stagNote:"Best stagflation asset. Gold benefits from both inflation AND growth fear. Miners are 2–3× levered to gold price.",
    crisisScore:85, inflationScore:90, deflationScore:30, liquidityScore:75, stagScore:95,
    verdict:"Best for debasement + stagflation. Miners move 2–3× for every 1× gold move. Crash first in liquidity crises, then rip.",
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
    id:"farmland", name:"Farmland", icon:"🌾", color:"#166534", bg:"#F0FDF4", bdr:"#86EFAC",
    stagRank:3, defRank:3, refRank:2, infRank:2, volatility:"LOW",
    stagNote:"Good inflation hedge — food prices sticky in all environments. Illiquid. Multi-year hold.",
    crisisScore:60, inflationScore:85, deflationScore:50, liquidityScore:20, stagScore:75,
    verdict:"Excellent long-run inflation hedge. Thinly traded — use limit orders.",
    tickers:[
      {t:"LAND", name:"Gladstone Land",    type:"REIT", note:"Berry & vegetable farms. ~$350M cap. Thinly traded."},
      {t:"FPI",  name:"Farmland Partners", type:"REIT", note:"Row-crop (corn, soy, wheat). Geographic diversity."},
    ],
  },
  {
    id:"tbonds", name:"Treasury Bonds", icon:"🏛️", color:"#1E40AF", bg:"#EFF6FF", bdr:"#BFDBFE",
    stagRank:4, defRank:1, refRank:4, infRank:4, volatility:"MED",
    stagNote:"WORST stagflation asset. Inflation erodes real value; rate hikes crush price. TLT lost 30%+ in 2022.",
    crisisScore:75, inflationScore:20, deflationScore:95, liquidityScore:95, stagScore:10,
    verdict:"Works in deflation/growth-scare recessions (2008, 2020). Fails in stagflation. Know your recession type first.",
    tickers:[
      {t:"TLT",  name:"iShares 20+ Year Treasury", type:"ETF", note:"Max duration. ~16% price sensitivity per 1% rate move."},
      {t:"IEF",  name:"iShares 7-10 Year Treasury",type:"ETF", note:"Lower duration alternative to TLT. Use if uncertain about crash depth or speed of recovery. 100bps cut ≈ 7-8% NAV appreciation vs TLT's 15-18%. Less reward, less risk."},
      {t:"ZROZ", name:"PIMCO 25+ Zero Coupon",     type:"ETF", note:"Maximum duration. High conviction rate cut only."},
      {t:"BIL",  name:"SPDR 1-3 Month T-Bill",     type:"ETF", note:"Essentially cash. ~4.2% yield."},
    ],
  },
  {
    id:"staples", name:"Consumer Staples", icon:"🛒", color:"#5B21B6", bg:"#F5F3FF", bdr:"#C4B5FD",
    stagRank:2, defRank:2, refRank:1, infRank:3, volatility:"LOW",
    stagNote:"Strong stagflation performer. Brand pricing power passes through inflation; non-discretionary demand holds in recession.",
    crisisScore:75, inflationScore:65, deflationScore:70, liquidityScore:90, stagScore:80,
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
    stagRank:3, defRank:6, refRank:2, infRank:1, volatility:"VERY HIGH",
    stagNote:"Mixed in stagflation — debasement tailwind, but risk-off selloffs hit it hard. Shines only once panic clears and the dollar-credibility narrative takes over.",
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

// ─── INSURANCE PHASE NOTES ────────────────────────────────────────────────────
// Three-state crash-scenario overrides (onset / deflationary / inflationary) for
// the phase-sensitive buckets. The first character of each note drives colour:
// ⚠️ = amber, ✅ = green, ❌ = red (see AssetDetail phase-note render).
const PHASE_NOTES = {
  miners: {
    onset:        "GLD is more stable than miners in the initial panic — hold GLD first, add miners after panic clears. ⚠️ ONSET: Miners sell off with equities in the initial panic. Hold light. GLD is better crash-phase protection until panic clears.",
    deflationary: "GLD outperforms miners in deflation — prefer GLD over GDX here. ⚠️ DEFLATIONARY: Gold moderate in deflation, miners underperform gold. Only add after Fed pivot signal confirmed.",
    inflationary: "Both GLD and GDX/GDXJ win here — miners provide 2-3× leverage to gold price. ✅✅ INFLATIONARY/DEBASEMENT: This is where miners shine. Gold up 20% = miners up 40–60%. Add aggressively after VIX peak.",
    stagflation:  "GLD grinds higher steadily. Miners amplify but with more volatility. ⚠️ STAGFLATION: Gold grinds higher but without the explosive move of a debasement crash. Miners move with gold but underperform in a slow-grind regime. Hold a moderate position — don't over-allocate waiting for a spike that may take years.",
  },
  btc: {
    onset:        "❌ ONSET: BTC dropped 50% in 48 hours in March 2020. Do not use as crash onset protection. Wait for panic to clear.",
    deflationary: "❌ DEFLATIONARY: BTC performs poorly in deflationary crashes — no yield, high beta, sells with risk assets. Avoid.",
    inflationary: "✅✅ INFLATIONARY/DEBASEMENT: Post-panic BTC is the highest-conviction debasement play. Fixed supply vs exploding Fed balance sheet. Enter after VIX peaks.",
    stagflation:  "⚠️ STAGFLATION: No clear catalyst for BTC in persistent stagflation. Inflation present but not acute enough to drive debasement narrative. Equity correlation remains. Hold existing position, do not add aggressively.",
  },
  tbonds: {
    onset:        "⚠️ ONSET: Only works if the crash is confirmed deflationary — falling CPI, growth scare, 10Y yield falling. In stagflation, TLT is still a trap even at onset. Do not buy until deflation is confirmed.",
    deflationary: "✅✅ DEFLATIONARY: TLT is your best instrument here. Rates fall, bonds rally hard. This is the one scenario where TLT belongs at the top of the stack. Also consider IEF (7-10 year) as a lower-volatility alternative — less upside but less drawdown risk if recovery is faster than expected.",
    inflationary: "❌ INFLATIONARY/DEBASEMENT: TLT gets crushed. Sticky inflation + Fed balance sheet expansion = bond bear market. Avoid entirely. 2022 repeat risk.",
    stagflation:  "❌ STAGFLATION: Avoid. Inflation stays sticky — rates cannot fall meaningfully. TLT grinds lower as real yields stay elevated. Worst regime for long-duration bonds.",
  },
};

// ─── INSURANCE CRASH-SCENARIO PHASES ──────────────────────────────────────────
// Four-state toggle for the Insurance tab. The user reads the scenario matrix +
// live-signal lean, then sets this manually. It does NOT auto-drive the toggle.
// `col` maps each phase to its SCENARIO_MATRIX field; colour set is reused by the
// interactive guide (active column) and the phase-note callouts.
const INSURANCE_PHASES = [
  { k:"onset",        col:"onset", label:"Crash Onset",               short:"Crash Onset",  color:"#92400E", bg:"#FFFBEB", bdr:"#FCD34D", desc:"Signals deteriorating. Buy protection before confirmation. Puts, spreads, GLD." },
  { k:"deflationary", col:"def",   label:"Deflationary Resolution",   short:"Deflationary", color:"#1E40AF", bg:"#EFF6FF", bdr:"#BFDBFE", desc:"Debt deflation, falling prices, Japan-style. TLT wins. Gold moderate. BTC loses." },
  { k:"inflationary", col:"inf",   label:"Inflationary / Debasement", short:"Inflationary", color:"#7C3AED", bg:"#F5F3FF", bdr:"#C4B5FD", desc:"Fed prints to reflate. Dollar credibility erodes. Gold and BTC win. TLT is a trap." },
  { k:"stagflation",  col:"stag",  label:"Persistent Stagflation",    short:"Stagflation",  color:"#0F766E", bg:"#F0FDFA", bdr:"#5EEAD1", desc:"Persistent Stagflation — slow grind, not a sharp crash. Favour passive real-asset hedges (GLD, XLP, farmland, HYG puts) over active short instruments. Avoid VIX calls (contango) and SQQQ (daily decay). Puts are expensive to roll monthly over 18-24 months — size conservatively and favour longer-dated instruments to reduce theta bleed." },
];

// Permanent, non-interactive reference. Four columns = four scenarios, grouped by
// hedge family (group header rows rendered in the table).
// ✅✅ = primary · ✅ = works well · ⚠️ = caution/timing · ❌ = avoid.
// NOTE: GLD/Physical Gold and GDX/GDXJ are intentionally separate rows — GLD held
// value in March 2020 while GDX dropped ~40% before recovering. The distinction matters.
const SCENARIO_MATRIX = [
  { group:"Gold & Precious Metals", row:"GLD / Physical Gold", onset:"✅", def:"✅",  inf:"✅✅", stag:"✅" },
  { group:"Gold & Precious Metals", row:"GDX / GDXJ",          onset:"⚠️", def:"⚠️", inf:"✅✅", stag:"⚠️" },
  { group:"Macro / Rate Hedges",    row:"TLT / IEF",           onset:"⚠️", def:"✅✅", inf:"❌",  stag:"❌" },
  { group:"Macro / Rate Hedges",    row:"HYG / JNK Puts",      onset:"✅", def:"✅",  inf:"✅",  stag:"✅" },
  { group:"Macro / Rate Hedges",    row:"VIX Calls / VXX",     onset:"✅", def:"✅",  inf:"✅",  stag:"❌" },
  { group:"Equity Shorts",          row:"SPY / QQQ Puts",      onset:"✅", def:"✅",  inf:"✅",  stag:"⚠️" },
  { group:"Equity Shorts",          row:"SQQQ / 7568.HK",      onset:"✅", def:"✅",  inf:"✅",  stag:"⚠️" },
  { group:"Defensive Income",       row:"XLP / Staples",       onset:"✅", def:"✅",  inf:"⚠️", stag:"✅✅" },
  { group:"Commodities / Energy",   row:"CNOOC / Energy",      onset:"⚠️", def:"❌",  inf:"✅✅", stag:"✅" },
  { group:"Debasement / Monetary",  row:"BTC",                 onset:"❌", def:"❌",  inf:"✅✅", stag:"⚠️" },
];

// Live-signal anchor — auto-computed lean from liveInd. Informational only;
// the user still sets the toggle. Safe to call with {} when liveInd is null.
// Uses cpiYoY (year-over-year %) — NOT the raw CPIAUCSL index level, which is
// ~315 and would always read as inflationary.
function getCrashSignalRead(liveInd, activeRegime) {
  // Stagflation: the dashboard's active regime is already stagflationary. This
  // connects the regime engine directly to the Insurance tab's signal anchor.
  if (activeRegime?.id === "stag") return {
    lean: "Persistent Stagflation",
    reason: "active regime is stagflationary — inflation sticky, growth slowing. Favour staples, GLD, HYG puts over short-dated puts and VIX calls",
  };
  const inflationary = liveInd.cpiYoY > 4.0 && liveInd.m2Rising;
  const deflationary = liveInd.yieldSpread < -0.5 && liveInd.creditSpread > 4.5;
  if (inflationary) return {
    lean: "Inflationary / Debasement",
    reason: `CPI ${liveInd.cpiYoY?.toFixed(1)}% YoY, M2 rising, sticky inflation environment`,
  };
  if (deflationary) return {
    lean: "Deflationary",
    reason: `Yield curve ${liveInd.yieldSpread?.toFixed(2)}%, credit spreads ${liveInd.creditSpread?.toFixed(1)}%`,
  };
  return {
    lean: "Onset / Unclear",
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
    cash:            { range: "55–65%", status: "HOLD",       note: "Core liquidity. Floor: never below 25%. Current optimal hold: USFR (WisdomTree Floating Rate Treasury ETF) for bulk — yield resets weekly, tracks Fed funds rate, currently ~5.3% annualized. SGOV for trading-ready portion — marginally lower yield but identical liquidity. IBKR cash sweep (~4.83%) for active trading float — automatic, zero friction. UAE bank account for AED living expenses only. Do not hold investment capital in bank accounts earning 2-3%." },
    insurance:       { range: "0–3%",   status: "PREPARE",    note: "Insurance is cheap now (VIX <20). Begin sizing positions. Don't activate yet." },
    income:          { range: "8–12%",  status: "HOLD",       note: "Regime-agnostic yield plays. Pipelines, utilities, dividend aristocrats." },
    longTermHolds:   { range: "15–20%", status: "HOLD",       note: "AI infrastructure hardware. Quality compounders. Hold through volatility." },
    deploymentReady: { range: "5–10%",  status: "WATCH",      note: "Stage-gated. Do not deploy until Stage 4 triggered." },
    categoryNote:    "AI infrastructure hardware (semiconductors, compute) and highest-quality compounders with pricing power.",
  },
  stag: {
    cash:            { range: "50–60%", status: "HOLD",       note: "Preserve optionality. Real yield eroding in real terms but cash dominates over equity drawdowns. Hold USFR — floating rate means yield stays elevated as long as rates hold. Warsh holding at 4.2% CPI means USFR continues earning ~5.3%. Do not rotate out of USFR until Fed pivot is confirmed. Bank AED expenses only." },
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
  WATCH:      { color:"#92400E", bg:"#FFFBEB", bdr:"#FCD34D" },
  ACTIVATE:   { color:"#166534", bg:"#F0FDF4", bdr:"#86EFAC" },
  ACCUMULATE: { color:"#166534", bg:"#F0FDF4", bdr:"#86EFAC" },
  DEPLOY:     { color:"#166534", bg:"#F0FDF4", bdr:"#86EFAC" },
  SELECTIVE:  { color:"#92400E", bg:"#FFFBEB", bdr:"#FCD34D" },
  REDUCE:     { color:"#B45309", bg:"#FFF7ED", bdr:"#FED7AA" },
  PAUSE:      { color:"#991B1B", bg:"#FEF2F2", bdr:"#FCA5A5" },
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
      {t:"BIL",  name:"SPDR 1-3 Month T-Bill ETF",          yield:"4.2%", note:"Safest USD yield. Essentially cash with income."},
      {t:"SGOV", name:"iShares 0-3 Month T-Bill",           yield:"4.3%", note:"Minimal duration risk."},
      {t:"USFR", name:"WisdomTree Floating Rate Treasury",  yield:"4.4%", note:"Adjusts with Fed. Rate rise protection."},
    ],
  },
];

// ─── FUND DEFAULTS ────────────────────────────────────────────────────────────
const DEFAULT_FUNDS = [
  {
    id:"berkshire", name:"Berkshire Hathaway", manager:"Greg Abel (Buffett chairman)",
    aum:"$263B equity · $397B cash", style:"Quality compounder / Value", color:"#1E40AF",
    turnover:"Low–Medium", signal:"DEFENSIVE", signalColor:"#991B1B",
    lastUpdated:"Q1 2026 · May 15",
    regimeBet:"Waiting — agnostic",
    regimeBetColor:"#1E40AF",
    regimeBetSignal:"$397B cash. Waiting for better prices. No macro regime bet.",
    holdings:[
      {name:"AAPL", pct:22.0,value:57.8,sector:"Tech",      action:"hold"},
      {name:"AXP",  pct:17.4,value:45.9,sector:"Financials",action:"hold"},
      {name:"KO",   pct:11.6,value:30.4,sector:"Consumer",  action:"hold"},
      {name:"BAC",  pct:9.5, value:25.0,sector:"Financials",action:"trim"},
      {name:"CVX",  pct:6.6, value:17.5,sector:"Energy",    action:"trim"},
      {name:"OXY",  pct:6.6, value:17.2,sector:"Energy",    action:"hold"},
      {name:"GOOGL",pct:5.9, value:16.6,sector:"Tech",      action:"bought"},
      {name:"CB",   pct:4.2, value:11.2,sector:"Insurance", action:"hold"},
      {name:"MCO",  pct:4.1, value:10.8,sector:"Financials",action:"hold"},
      {name:"DAL",  pct:1.0, value:2.65,sector:"Airlines",  action:"bought"},
      {name:"Other",pct:11.1,value:29.0,sector:"Mix",       action:"hold"},
    ],
    sectors:[{name:"Tech",pct:28},{name:"Financials",pct:31},{name:"Consumer",pct:12},{name:"Energy",pct:13},{name:"Insurance",pct:4},{name:"Airlines",pct:1},{name:"Cash/TBills",pct:11}],
    recentBuys:["GOOGL (+224% → $16.6B)","DAL new $2.65B","LEN (Lennar added)","NYT (3× position)","M (Macy's — 9× P/E)"],
    recentSells:["AMZN (exit)","V (exit)","MA (exit)","UNH (exit)","DPZ (exit)","CVX (-35%)","BAC (trim)"],
    radar:[{axis:"Value",score:90},{axis:"Growth",score:30},{axis:"Defensiveness",score:85},{axis:"AI Exposure",score:40},{axis:"International",score:10},{axis:"Income",score:70}],
  },
  {
    id:"pershing", name:"Pershing Square", manager:"Bill Ackman",
    aum:"$13.7B", style:"Concentrated activist", color:"#6D28D9",
    turnover:"Low–Med (18%)", signal:"TECH COMPOUNDERS", signalColor:"#1E40AF",
    lastUpdated:"Q1 2026 · May 15",
    regimeBet:"AI-driven compounding",
    regimeBetColor:"#6D28D9",
    regimeBetSignal:"MSFT, AMZN, UBER — quality compounders, not crisis positioning.",
    thesis:"Ultra-concentrated: 11 holdings, top 4 = 65% of book. Rotated out of GOOGL (-95%) into MSFT ($2.1B new position) after Feb selloff — bought at 21× fwd earnings arguing Azure + M365 AI optionality was underpriced. Brookfield #1 — bet on global real assets and alts AUM growth.",
    holdings:[
      {name:"BN",   pct:17.6,value:2.41,sector:"Alts/RE",      action:"trim"},
      {name:"AMZN", pct:17.4,value:2.38,sector:"Tech",          action:"added"},
      {name:"UBER", pct:15.7,value:2.15,sector:"Transport",     action:"trim"},
      {name:"MSFT", pct:15.3,value:2.10,sector:"Tech",          action:"bought"},
      {name:"QSR",  pct:12.2,value:1.67,sector:"Consumer",      action:"hold"},
      {name:"HHH",  pct:6.5, value:0.89,sector:"Real Estate",   action:"hold"},
      {name:"FNMA", pct:4.1, value:0.56,sector:"Govt/GSE",      action:"hold"},
      {name:"Other",pct:11.2,value:1.54,sector:"Mix",           action:"hold"},
    ],
    sectors:[{name:"Tech",pct:48},{name:"Consumer",pct:12},{name:"Alts/RE",pct:24},{name:"Govt/GSE",pct:4},{name:"Transport",pct:12}],
    recentBuys:["MSFT ($2.1B new)","AMZN (added)"],
    recentSells:["HLT (exit)","GOOGL (-95%)"],
    radar:[{axis:"Value",score:60},{axis:"Growth",score:75},{axis:"Defensiveness",score:40},{axis:"AI Exposure",score:70},{axis:"International",score:20},{axis:"Income",score:30}],
  },
  {
    id:"bridgewater", name:"Bridgewater Associates", manager:"Karniol-Tambour / Prince / Jensen",
    aum:"$22.4B (13F) · $92B total", style:"Global macro / Risk parity", color:"#166534",
    turnover:"High (~40%)", signal:"AI CHIPS + GOLD", signalColor:"#92400E",
    lastUpdated:"Q1 2026 · May 15",
    regimeBet:"Stagflation + normalization",
    regimeBetColor:"#92400E",
    regimeBetSignal:"Adding GLD + AI chips simultaneously. Hedging both stagflation and recovery.",
    thesis:"~1,000 holdings — a systematic risk-parity book, not stock-picking. Core is two S&P 500 ETFs (SPY + IVV ≈ 22%), then a long diversified tail: AI/semis (NVDA, LRCX, AVGO, AMD) and mega-cap tech (GOOGL, MSFT, CRM, ADBE, ORCL), with a small gold (NEM) and Korea (EWY) macro tilt. Dual bet: broad equity beta tilted to AI infrastructure, hedged with gold and international.",
    holdings:[
      {name:"SPY",  pct:11.1,value:2.49,sector:"Passive",     action:"trim"},
      {name:"IVV",  pct:10.5,value:2.35,sector:"Passive",     action:"trim"},
      {name:"NVDA", pct:2.6, value:0.58,sector:"Semis",       action:"added"},
      {name:"LRCX", pct:1.9, value:0.43,sector:"Semis",       action:"added"},
      {name:"CRM",  pct:1.9, value:0.43,sector:"Tech",        action:"hold"},
      {name:"GOOGL",pct:1.8, value:0.40,sector:"Tech",        action:"added"},
      {name:"MSFT", pct:1.7, value:0.38,sector:"Tech",        action:"hold"},
      {name:"AMZN", pct:1.6, value:0.36,sector:"Consumer",    action:"added"},
      {name:"ADBE", pct:1.6, value:0.36,sector:"Tech",        action:"hold"},
      {name:"GEV",  pct:1.6, value:0.36,sector:"Industrials", action:"bought"},
      {name:"BKNG", pct:1.6, value:0.36,sector:"Consumer",    action:"hold"},
      {name:"AVGO", pct:1.5, value:0.34,sector:"Semis",       action:"added"},
      {name:"ORCL", pct:1.3, value:0.29,sector:"Tech",        action:"added"},
      {name:"AMD",  pct:1.3, value:0.29,sector:"Semis",       action:"bought"},
      {name:"NEM",  pct:0.8, value:0.18,sector:"Gold",        action:"bought"},
      {name:"EWY",  pct:0.7, value:0.16,sector:"EM/Korea",    action:"hold"},
      {name:"Other",pct:56.0,value:12.54,sector:"Mix",        action:"hold"},
    ],
    sectors:[{name:"Passive ETFs",pct:21},{name:"Tech/Cloud",pct:15},{name:"Semis/AI",pct:10},{name:"EM/Intl",pct:12},{name:"Gold/Commodities",pct:8},{name:"Consumer",pct:10},{name:"Healthcare",pct:8},{name:"Other",pct:16}],
    recentBuys:["NVDA (added)","GE Vernova (new)","AMD (added)","Newmont (gold)"],
    recentSells:["SPY (trim)","IVV (trim)"],
    radar:[{axis:"Value",score:50},{axis:"Growth",score:60},{axis:"Defensiveness",score:65},{axis:"AI Exposure",score:75},{axis:"International",score:80},{axis:"Income",score:45}],
  },
  {
    id:"duquesne", name:"Duquesne Family Office", manager:"Stanley Druckenmiller",
    aum:"$3.4B", style:"Global macro / Top-down rotator", color:"#B45309",
    turnover:"Very High (38–43%)", signal:"EM + COMMODITIES", signalColor:"#6D28D9",
    lastUpdated:"Q1 2026 · May 15",
    regimeBet:"Stagflation / supercycle",
    regimeBetColor:"#B45309",
    regimeBetSignal:"25–30% gold. EM hard assets. Exited US mega-cap tech. Most bearish on US macro.",
    thesis:"25–30% in gold off-13F. 20–25% energy commodities. On equities: Brazil EWZ, Argentina ARGT, biotech (NTRA 18.1%), semis (AVGO, TSM, SNDK). Fully exited GOOGL, META, ARM. Quote: 'All the factors that created the 1982 bull market have not only stopped — they have reversed.'",
    holdings:[
      {name:"NTRA", pct:18.1,value:0.62,sector:"Biotech",      action:"hold"},
      {name:"EWZ",  pct:8.7, value:0.30,sector:"EM/Brazil",    action:"hold"},
      {name:"INSM", pct:5.6, value:0.19,sector:"Biotech",      action:"hold"},
      {name:"TSM",  pct:5.0, value:0.17,sector:"Semis",        action:"hold"},
      {name:"RSP",  pct:4.7, value:0.16,sector:"ETF",          action:"bought"},
      {name:"YPF",  pct:4.4, value:0.15,sector:"EM/Argentina", action:"bought"},
      {name:"WWD",  pct:2.2, value:0.08,sector:"Industrials",  action:"bought"},
      {name:"TEVA", pct:2.1, value:0.07,sector:"Pharma",       action:"bought"},
      {name:"AVGO", pct:1.8, value:0.06,sector:"Semis",        action:"hold"},
      {name:"MU",   pct:1.5, value:0.05,sector:"Semis",        action:"bought"},
      {name:"CPNG", pct:1.5, value:0.05,sector:"Consumer",     action:"bought"},
      {name:"CAI",  pct:1.4, value:0.05,sector:"Biotech",      action:"bought"},
      {name:"STX",  pct:1.3, value:0.04,sector:"Semis",        action:"bought"},
      {name:"ARGT", pct:1.3, value:0.04,sector:"EM/Argentina", action:"hold"},
      {name:"SNDK", pct:1.2, value:0.04,sector:"Semis",        action:"hold"},
      {name:"Other",pct:39.2,value:1.34,sector:"Mix",          action:"mixed"},
    ],
    sectors:[{name:"Biotech/Health",pct:28},{name:"EM / Macro ETFs",pct:16},{name:"Semis/AI",pct:11},{name:"Consumer",pct:9},{name:"Gold/Commodities",pct:25},{name:"Other",pct:11}],
    recentBuys:["YPF (Argentina energy)","Woodward (new)","Teva (new)","Caris Life (new)"],
    recentSells:["ETHB (exit)","Humana (exit)"],
    radar:[{axis:"Value",score:40},{axis:"Growth",score:55},{axis:"Defensiveness",score:30},{axis:"AI Exposure",score:50},{axis:"International",score:85},{axis:"Income",score:20}],
  },
  {
    id:"tiger", name:"Tiger Global", manager:"Chase Coleman",
    aum:"$26B", style:"Global tech / Growth", color:"#BE185D",
    turnover:"High", signal:"TECH BULL", signalColor:"#166534",
    lastUpdated:"Q1 2026 · May 15",
    regimeBet:"Reflationary recovery",
    regimeBetColor:"#166534",
    regimeBetSignal:"All-in AI hyperscalers. Betting supply shocks resolve and growth recovers.",
    thesis:"Near-destroyed in 2022 (-55%). Rebirth is more disciplined: fewer names, higher quality. AI consensus at the core — GOOGL #1, then NVDA, AMZN and TSM. Sea Ltd (SE) is the SE-Asia growth play; GE Vernova and Corpay are newer non-tech adds.",
    holdings:[
      {name:"GOOGL", pct:13.4,value:3.48,sector:"Tech",       action:"hold"},
      {name:"NVDA",  pct:9.2, value:2.39,sector:"Semis",      action:"added"},
      {name:"AMZN",  pct:9.1, value:2.37,sector:"Tech",       action:"hold"},
      {name:"TSM",   pct:8.2, value:2.13,sector:"Semis",      action:"added"},
      {name:"META",  pct:7.7, value:2.00,sector:"Tech",       action:"hold"},
      {name:"SE",    pct:5.6, value:1.46,sector:"China/EM",   action:"hold"},
      {name:"AVGO",  pct:4.9, value:1.27,sector:"Semis",      action:"added"},
      {name:"MSFT",  pct:4.0, value:1.04,sector:"Tech",       action:"trim"},
      {name:"GEV",   pct:3.7, value:0.96,sector:"Industrials",action:"bought"},
      {name:"LRCX",  pct:3.6, value:0.94,sector:"Semis",      action:"bought"},
      {name:"SPOT",  pct:3.4, value:0.88,sector:"Consumer",   action:"hold"},
      {name:"CPNG",  pct:2.9, value:0.75,sector:"Consumer",   action:"hold"},
      {name:"AMAT",  pct:2.5, value:0.65,sector:"Semis",      action:"hold"},
      {name:"CPAY",  pct:2.2, value:0.57,sector:"Fintech",    action:"bought"},
      {name:"Other", pct:19.6,value:5.10,sector:"Mix",        action:"hold"},
    ],
    sectors:[{name:"Tech/Internet",pct:40},{name:"Semis/AI",pct:28},{name:"China/EM",pct:6},{name:"Consumer",pct:8},{name:"Industrials",pct:4},{name:"Fintech",pct:3},{name:"Other",pct:11}],
    recentBuys:["GE Vernova (new)","Lam Research (added)","Corpay (new)"],
    recentSells:["INTC (exit)","HOOD (exit)"],
    radar:[{axis:"Value",score:30},{axis:"Growth",score:90},{axis:"Defensiveness",score:20},{axis:"AI Exposure",score:85},{axis:"International",score:40},{axis:"Income",score:15}],
  },
  {
    id:"appaloosa", name:"Appaloosa Management", manager:"David Tepper",
    aum:"$~20B", style:"Distressed / Deep value", color:"#D97706",
    turnover:"Medium–High", signal:"CHINA + CYCLICALS", signalColor:"#B45309",
    lastUpdated:"Q1 2026 · May 15",
    regimeBet:"China recovery + soft landing",
    regimeBetColor:"#D97706",
    regimeBetSignal:"AMZN top holding; BABA trimmed to core. Power/AI cyclicals (VST, NRG). Tepper right on China timing.",
    thesis:"Buy when sentiment is maximally washed out. Amazon is now the top position; BABA trimmed to ~7% but still a core China bet. Big semis/AI sleeve (MU, TSM, NVDA, SanDisk) plus a new power-demand play via Vistra + NRG. Tepper historically right on China timing when everyone else gives up.",
    holdings:[
      {name:"AMZN", pct:15.2,value:3.04,sector:"Tech",        action:"hold"},
      {name:"MU",   pct:9.5, value:1.90,sector:"Semis/AI",    action:"added"},
      {name:"GOOG", pct:8.4, value:1.68,sector:"Tech",        action:"hold"},
      {name:"UBER", pct:7.7, value:1.54,sector:"Consumer",    action:"hold"},
      {name:"TSM",  pct:7.6, value:1.52,sector:"Semis/AI",    action:"added"},
      {name:"BABA", pct:7.3, value:1.46,sector:"China/EM",    action:"trim"},
      {name:"VST",  pct:5.1, value:1.02,sector:"Energy",      action:"bought"},
      {name:"EWY",  pct:5.0, value:1.00,sector:"EM/Korea",    action:"hold"},
      {name:"NVDA", pct:4.3, value:0.86,sector:"Semis/AI",    action:"added"},
      {name:"NRG",  pct:4.3, value:0.86,sector:"Energy",      action:"bought"},
      {name:"META", pct:4.2, value:0.84,sector:"Tech",        action:"hold"},
      {name:"SNDK", pct:3.0, value:0.60,sector:"Semis/AI",    action:"added"},
      {name:"GLW",  pct:2.6, value:0.52,sector:"Tech",        action:"bought"},
      {name:"WHR",  pct:1.8, value:0.36,sector:"Consumer",    action:"hold"},
      {name:"Other",pct:14.0,value:2.80,sector:"Mix",         action:"mixed"},
    ],
    sectors:[{name:"Tech/Internet",pct:32},{name:"Semis/AI",pct:22},{name:"China/EM",pct:12},{name:"Energy/Power",pct:9},{name:"Consumer/Cyclicals",pct:12},{name:"Other",pct:13}],
    recentBuys:["Vistra + NRG (power/AI demand)","Micron (AI memory)","Corning (added)"],
    recentSells:["BABA (trimmed)","Wayfair (exit)"],
    radar:[{axis:"Value",score:75},{axis:"Growth",score:60},{axis:"Defensiveness",score:35},{axis:"AI Exposure",score:65},{axis:"International",score:55},{axis:"Income",score:30}],
  },
  {
    id:"fairfax", name:"Fairfax Financial Holdings", manager:"Prem Watsa",
    aum:"~$75B (insurance + investment portfolio)", style:"Value / Insurance Float", color:"#A16207",
    turnover:"Low (buy & hold)", signal:"MACRO HEDGE + INDIA", signalColor:"#B45309",
    lastUpdated:"Annual Report 2025 · Mar 2026",
    regimeBet:"INFLATION + DEFLATION HEDGE",
    regimeBetColor:"#B45309",
    regimeBetSignal:"Long India/EM structural bet. CPI-linked hedges + tail protection. Positioned for both inflation and deflation shocks.",
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

const CONSENSUS_ROWS = [
  {theme:"AI Chips / Semis",            vals:["◐","◯","●","●","●","●","◯"],note:"5/7 bullish — most crowded consensus long; Fairfax absent"},
  {theme:"Hyperscalers (AMZN/GOOG/MSFT)",vals:["●","●","●","◯","●","●","◯"],note:"Berkshire now large GOOGL holder; Ackman owns AMZN+MSFT"},
  {theme:"Legacy SaaS",                 vals:["◯","◯","◐","◯","◯","◯","◯"],note:"Bridgewater holds CRM/ADBE/ORCL; no one adding aggressively"},
  {theme:"China / EM",                  vals:["◯","◯","●","●","◐","●","●"],note:"Druckenmiller Brazil/Argentina, Tepper BABA, Fairfax India"},
  {theme:"Gold / Commodities",          vals:["◐","◯","◐","●","◯","◯","◐"],note:"Druckenmiller 25–30% (off-13F), Bridgewater light (NEM), Fairfax commodity-linked"},
  {theme:"Energy / Airlines",           vals:["●","◯","◯","◐","◯","◐","◯"],note:"Berkshire CVX+OXY+DAL; Appaloosa Vistra+NRG power"},
  {theme:"Biotech / Healthcare",        vals:["◯","◯","◯","●","◯","◯","◯"],note:"Druckenmiller NTRA/INSM/Caris/Teva"},
  {theme:"Financials / Insurance",      vals:["●","◐","◯","◯","◐","◯","●"],note:"Berkshire + Fairfax core insurance/float; Ackman GSEs, Tiger Corpay"},
  {theme:"Cash / T-Bills",             vals:["●●","◯","◯","◯","◯","◯","◐"],note:"Berkshire $397B dry powder; Fairfax float in T-bills/bonds"},
  {theme:"Macro Hedges / Tail Risk",    vals:["◯","◐","●","◐","◯","◯","●"],note:"Fairfax deflation/CPI hedges; Bridgewater risk-parity; Ackman episodic"},
];

const REGIMES = [
  {
    id:"stag",label:"Stagflation",prob:45,color:"#B45309",bg:"#FFFBEB",bdr:"#FCD34D",
    desc:"High inflation + slowing growth. Iran war oil shock, tariffs embedding in CPI, Fed trapped.",
    best:["Gold Miners (GDX, AEM)","Consumer Staples (XLP, PG, KO)","Energy Pipelines (EPD, ET)","Farmland","Short-duration T-bills"],
    worst:["Long-Duration Bonds (TLT)","Growth / high-multiple tech","Unprofitable tech"],
    trigger:"Supply shock resolves → reflationary growth  OR  demand destruction → deflationary recession",
  },
  {
    id:"ref",label:"Reflationary Growth",prob:30,color:"#166534",bg:"#F0FDF4",bdr:"#86EFAC",
    desc:"Gulf peace deal → oil falls. Fed resumes cutting. AI capex starts generating productivity gains.",
    best:["Broad equities (SPY, QQQ)","AI infrastructure (NVDA, AVGO)","REITs","Emerging markets"],
    worst:["Gold (risk-on removes safe haven bid)","Short-duration T-bills (yield falls)","Defensive staples"],
    trigger:"Weak productivity + fiscal deterioration → back to stagflation  OR  credit excess → inflationary boom",
  },
  {
    id:"def",label:"Deflationary Recession",prob:20,color:"#1E40AF",bg:"#EFF6FF",bdr:"#BFDBFE",
    desc:"Demand destruction wins. HY credit spreads blow out >6%. Unemployment surges >5.5%.",
    best:["Long Treasuries (TLT, ZROZ)","Cash (BIL, SGOV)","Gold (safe haven)","Consumer Staples"],
    worst:["Commodities (demand collapses)","Energy","Emerging markets","High-yield credit"],
    trigger:"Massive fiscal stimulus + QE → reflationary recovery (standard post-recession)",
  },
  {
    id:"inf",label:"Inflationary Boom",prob:5,color:"#7C3AED",bg:"#F5F3FF",bdr:"#C4B5FD",
    desc:"Dalio scenario: AI productivity surprise + fiscal dominance + dollar structural decline → persistent inflation >4%.",
    best:["Commodities","Energy stocks","Gold Miners","Bitcoin","EM commodity exporters"],
    worst:["Long bonds","Cash (real yields negative)","Defensive staples"],
    trigger:"Debt unsustainability → fiscal crisis → hyperinflation or forced deflation",
  },
];

// ─── FED LANGUAGE STATUS ──────────────────────────────────────────────────────
// Manually-updated status card (no live fetch). Update the STATUS fields below
// after each FOMC meeting / significant Fed communication. The five STATES
// definitions are stable and only change on explicit request.
const FED_LANGUAGE_STATUS = {
  status: "hawkish_hold", // current state — update manually
  lastUpdated: "2026-06-29",
  lastEvent: "FOMC June 2026",
  summary: "Warsh maintaining higher for longer stance. No acknowledgment of downside risks. Rate cuts explicitly off the table until CPI shows sustained progress toward 2%.",
  nextEvent: "FOMC July 30, 2026",
};
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

// ─── WALL STREET RECESSION PROBABILITY ────────────────────────────────────────
// Manually-updated source table. Last refreshed June 29, 2026 (post Iran peace
// deal + June FOMC). `color` drives the probability cell colour; `year` and
// `name` are used by the regime-probability derivation.
const RECESSION_SOURCES = [
  { name: "Goldman Sachs",             probability: "15%",    timeframe: "12-month", year: 2026, notes: "Cut from 25% (pre-Iran war) → 30% (March peak Hormuz) → 15% (June 26, post peace deal). Cites lower oil, higher real income, AI wealth effect, solid capex. GDP forecast H2 2026: 2.0%. Flags Fed rate hike risk as new variable — half of FOMC penciled in at least one hike.", color: "green" },
  { name: "NY Fed Yield Curve Model",  probability: "~15%",   timeframe: "12-month", year: 2026, notes: "May 2026 data. Based on 3M/10Y spread. Below historical alarm threshold of 30%. Yield curve now upward sloping: 10Y at 4.37%, 3M at 3.75%, spread +62bps. Structural improvement from prior inversion.", color: "green" },
  { name: "NY Fed DSGE Model",         probability: "35.8%",  timeframe: "12-month", year: 2026, notes: "March 2026, latest published. Recession = 4Q output growth below -1%. Down from 37.5% in December. Next update expected Q3 2026.", color: "amber" },
  { name: "JPMorgan",                  probability: "35%",    timeframe: "12-month", year: 2026, notes: "March 2026. Warned markets complacent over sustained oil shock. No updated June figure available — figure may have declined post peace deal. Watch for mid-year update.", color: "amber" },
  { name: "EY-Parthenon (Daco)",       probability: "40%",    timeframe: "12-month", year: 2026, notes: "March 2026. Risks rising if geopolitical tensions persist. New source added June 2026.", color: "amber" },
  { name: "Moody's Analytics (Zandi)", probability: "~49%",   timeframe: "12-month", year: 2026, notes: "March 2026 peak — 'on the precipice.' Driven by weak labor data and soft economic indicators since late 2025. Most bearish major forecaster. No updated post-peace-deal figure available.", color: "red" },
  { name: "Kalshi prediction market",  probability: "22%",    timeframe: "End-2026", year: 2026, notes: "June 2026. Up from 17.5% last month. Real-money market. CFTC-regulated. Slight uptick despite Iran peace deal — reflects lingering growth concerns.", color: "green" },
  { name: "Kalshi prediction market",  probability: "41%",    timeframe: "End-2027", year: 2027, notes: "Investors pricing delayed reckoning — debt refinancing at 5-7% vs near-zero rates, $1.3T consumer revolving credit, corporate capex compression. More concerning than 2026 figure.", color: "amber" },
  { name: "Polymarket",                probability: "~12.5%", timeframe: "End-2026", year: 2026, notes: "June 2026. Market-implied. 87.5% probability on No recession. Sahm Rule at 0.10 — well below 0.50 threshold. Lowest of all sources.", color: "green" },
  { name: "BNP Paribas",               probability: "Low",    timeframe: "12-month", year: 2026, notes: "Qualitative only — excluded from weighted average. 'Well-positioned to absorb shock.' US net energy exporter status cited. No numeric update available.", color: "green" },
  { name: "June FOMC Minutes", probability: "Elevated", timeframe: "qualitative", year: 2026, notes: "July 8, 2026. 'Only a few' members saw a case to hike — mildly dovish vs. the June dot plot (9/18 penciled a hike). Warsh withheld his own dot. PCE revised to 3.6%. Minutes predate July 7–8 Hormuz attacks entirely — the hawkish oil impulse is not yet in any official Fed communication.", color: "amber" },
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

// Parse a probability string ("~15%", "35.8%", "Low") to a number, or null.
const parseProbability = (probStr) => {
  if (!probStr || probStr === "Low" || probStr === "High") return null;
  const cleaned = probStr.replace("~", "").replace("%", "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
};

// Weighted average of the 2026 recession-probability sources. The Kalshi 2027
// row is pulled out separately as the delayed-reckoning modifier input.
const computeWeightedRecessionProb = (sources) => {
  let weightedSum = 0, totalWeight = 0, kalshi2027 = null;
  sources.forEach(source => {
    if (source.name === "Kalshi prediction market" && source.year === 2027) {
      kalshi2027 = parseProbability(source.probability);
      return;
    }
    const weight = RECESSION_SOURCE_WEIGHTS[source.name];
    const prob = parseProbability(source.probability);
    if (weight && prob !== null) { weightedSum += prob * weight; totalWeight += weight; }
  });
  const weightedAvg = totalWeight > 0 ? weightedSum / totalWeight : null;
  return { weightedAvg, kalshi2027 };
};

// Map weighted recession prob (+ live CPI + Kalshi 2027) to regime probabilities.
const deriveRegimeProbabilities = (weightedAvg, cpi, kalshi2027) => {
  if (weightedAvg === null) return null;

  let base;
  if (weightedAvg < 15)      base = { reflationary: 60, stagflation: 25, deflationary: 10, inflationary: 5 };
  else if (weightedAvg < 30) base = { reflationary: 40, stagflation: 35, deflationary: 20, inflationary: 5 };
  else if (weightedAvg < 45) base = { reflationary: 25, stagflation: 45, deflationary: 25, inflationary: 5 };
  else                       base = { reflationary: 15, stagflation: 40, deflationary: 35, inflationary: 10 };

  // CPI modifier — shift points from deflationary to stagflation when CPI > 3.5%
  if (cpi && cpi > 3.5) {
    const inflationShift = Math.min(10, Math.round((cpi - 3.5) * 4));
    base.deflationary = Math.max(5, base.deflationary - inflationShift);
    base.stagflation = base.stagflation + inflationShift;
  }

  // 2027 delayed-reckoning modifier — threshold raised to <30 (from <25) so it
  // engages while the realized weighted average sits in the mid-20s.
  if (kalshi2027 && kalshi2027 > 35 && weightedAvg < 30) {
    const delayedShift = Math.min(8, Math.round((kalshi2027 - 35) / 3));
    base.reflationary = Math.max(10, base.reflationary - delayedShift);
    base.stagflation = base.stagflation + delayedShift;
  }

  // Normalize to exactly 100%
  const total = base.reflationary + base.stagflation + base.deflationary + base.inflationary;
  const scale = 100 / total;
  return {
    reflationary: Math.round(base.reflationary * scale),
    stagflation: Math.round(base.stagflation * scale),
    deflationary: Math.round(base.deflationary * scale),
    inflationary: Math.round(base.inflationary * scale),
    weightedAvg: Math.round(weightedAvg),
    kalshi2027,
    derivedFrom: `Weighted recession prob: ${Math.round(weightedAvg)}% | CPI: ${cpi?.toFixed(1) ?? "N/A"}% | Kalshi 2027: ${kalshi2027 ?? "N/A"}%`,
  };
};

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

  // ── Option A: Claude.ai sandbox (works only in Claude artifact environment) ──
  if (DATA_SOURCE === "claude") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: "Get today's stock price and daily percentage change for: " + tickers.join(", ") +
            ". Return ONLY valid JSON: {\"TICK\":{\"price\":number,\"changePercent\":number}}. No other text.",
        }],
      }),
    });
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
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
  if (DATA_SOURCE === "claude") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: "Find the most current values for: (1) US 10-year Treasury yield and 2-year Treasury yield — compute spread (10Y minus 2Y), (2) US unemployment rate (latest BLS), (3) ICE BofA US High Yield Index OAS. Return ONLY JSON: {\"yieldSpread\":number,\"tenY\":number,\"twoY\":number,\"unemployment\":number,\"creditSpread\":number}. No other text.",
        }],
      }),
    });
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const match = text.match(/\{[\s\S]*?\}/);
    return match ? JSON.parse(match[0]) : null;
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
  const [byRegion, setByRegion] = useState(() => cacheLoad("cache_playbook_v1", {}));
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
          cacheSave("cache_playbook_v1", merged);
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
          const sig = ind.signal(liveVal);
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
              <XAxis dataKey="d" tick={{ fill: C.lbl, fontSize: 10 }} axisLine={false} tickLine={false} interval={2} />
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
                              : (ind.id === "yield" ? 0.38 : ind.id === "unemp" ? 4.4 : 2.75))
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
          </div>
        </div>
        <p style={{ color: C.mid, fontSize: 15, lineHeight: 1.75, margin: 0 }}>{fund.thesis}</p>
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
          <SLabel>Top Holdings (Q1 2026)</SLabel>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
const pbCreditColor = s => ({ calm: C.green, watch: C.blue, defending: C.amber, stress: C.red }[s] || C.muted);
const pbClusterColor = c => ({ exhausting: C.green, active: C.red, mixed: C.amber }[c] || C.muted);
const pbBandColor  = b => ({ calm: C.green, normal: C.blue, elevated: C.amber, high: C.red, severe: C.red, panic: C.red }[b] || C.muted);

// Market-state-aware freshness chip for names/indices — mirrors the Pre-Read: shows
// "~Nm delayed" / "prior close" / "holiday" / "no print" instead of a blanket "stale"
// badge that fires on live-but-delayed feeds. Returns null when live (no chip). The
// backend (playbook spine) computes `freshness` via lib/sessions.js.
function pbFresh(fr) {
  const txt = freshnessText(fr);           // shared vocab: "" (live) / prior close / stale · Nh ago / ⚠ date
  if (!txt) return null;
  const color = (fr.state === "no-print" || fr.state === "future") ? C.red
              : fr.state === "stale" ? C.amber : C.muted;
  return { txt, color };
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
    const bd = bizDaysAgo(field.date);
    const stale = bd != null && bd > 2;
    return { stale, text: field.date + (stale ? ` · stale · ${bd}d` : "") };
  }
  if (field.ts) {
    const ageMin = Math.max(0, Math.round(Date.now() / 1000 / 60 - field.ts / 60));
    return ageMin > 30 ? { stale: true, text: `stale · ${humanizeAge(ageMin)}` } : { stale: false, text: "" };
  }
  return { stale: false, text: "" };
}
// One macro cell: value + direction arrow (delta) + asOf/stale + source on hover.
function MacroCell({ field, value, delta, deltaSuffix }) {
  const mf = macroFresh(field);
  const arrow = delta == null ? "" : delta > 0 ? "▲" : delta < 0 ? "▼" : "■";
  const dcol = delta == null ? C.muted : delta > 0 ? C.green : delta < 0 ? C.red : C.muted;
  return (
    <div style={{ minWidth: 92 }} title={field?.src ? "source: " + field.src : ""}>
      <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>{field?.name}</div>
      <div style={{ fontSize: 18, fontWeight: 900, color: C.text }}>{value}</div>
      <div style={{ fontSize: 11, display: "flex", gap: 6, flexWrap: "wrap" }}>
        {delta != null && <span style={{ color: dcol, fontWeight: 700 }}>{arrow} {Math.abs(delta)}{deltaSuffix}</span>}
        {mf.text && <span style={{ color: mf.stale ? C.amber : C.lbl }}>{mf.text}</span>}
      </div>
    </div>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        {/* USD/KRW */}
        <div style={box}>
          <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>USD/KRW</div>
          <div style={{ fontSize: 24, fontWeight: 900, color: C.text }}>{won.level ?? "—"}</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: wonCol }}>
            {won.dir && won.dir !== "n/a" ? `${won.dir} · ` : ""}{won.flag}
          </div>
        </div>
        {/* VKOSPI with a 0–100 level bar (markers at 20/45/80) */}
        <div style={box}>
          <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>VKOSPI fut</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <span style={{ fontSize: 24, fontWeight: 900, color: vCol }}>{vol.level ?? "—"}</span>
            <span style={{ fontSize: 12, fontWeight: 800, color: vCol }}>{vol.band !== "n/a" ? vol.band : ""}</span>
          </div>
          <div style={{ position: "relative", height: 6, background: C.bdr, borderRadius: 3, margin: "7px 0 5px" }}>
            <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: Math.max(0, Math.min(100, vol.level || 0)) + "%", background: vCol, borderRadius: 3 }} />
            {[20, 45, 80].map(m => <div key={m} style={{ position: "absolute", left: m + "%", top: -2, bottom: -2, width: 1, background: C.muted }} />)}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700, color: vCol }}>{vol.flag}</div>
        </div>
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
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [savedLatest, setSavedLatest] = useState(null);  // optimistic: show saved values instantly

  const parsed = blob.trim() ? parseKofia(blob) : { list: [], anyMismatch: false };
  const latest = savedLatest || kofia?.latest || {};
  const hist = kofia?.history || [];
  const uvNum = Number(String(u7709).replace(/,/g, ""));
  const fv = Number(String(fNet).replace(/,/g, ""));
  const iv = Number(String(iNet).replace(/,/g, ""));
  const hasFlow = (fNet.trim() !== "" && Number.isFinite(fv)) || (iNet.trim() !== "" && Number.isFinite(iv));
  const canSave = (parsed.list.length > 0 && !parsed.anyMismatch) || (Number.isFinite(uvNum) && uvNum > 0) || hasFlow;

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const body = {};
      if (blob.trim()) body.blob = blob.trim();
      if (Number.isFinite(uvNum) && uvNum > 0) body.units7709 = { value: uvNum, asOf: u7709date || undefined };
      if (fNet.trim() !== "" && Number.isFinite(fv)) body.foreignNet = { value: fv, asOf: fDate || undefined };
      if (iNet.trim() !== "" && Number.isFinite(iv)) body.instNet = { value: iv, asOf: iDate || undefined };
      const r = await fetch("/api/korea-save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "include" });
      const j = await r.json();
      if (!r.ok) setMsg({ ok: false, text: j.error || ("Save failed " + r.status) });
      else {
        if (j.latest) setSavedLatest(j.latest);   // show the saved values immediately — no refresh
        setMsg({ ok: true, text: `Saved ${j.saved.join(", ")}${j.missing?.length ? " · kept prior: " + j.missing.join(", ") : ""}. Values updated below; committing in the background so the Pre-Reads pick it up too.` });
        setBlob(""); setU7709(""); setFNet(""); setINet("");
      }
    } catch (e) { setMsg({ ok: false, text: "Save error: " + e.message }); }
    setSaving(false);
  }

  const mlHist = hist.map(h => ({ d: h.marginLoans?.asOf?.slice(5), v: h.marginLoans?.value != null ? +toWonTrillions(h.marginLoans.value, "백만원").toFixed(2) : null })).filter(x => x.v != null);

  return (
    <Card>
      <SLabel><span style={{ display: "inline-block", background: "#0F4C9B", color: "#fff", fontSize: 9, fontWeight: 800, padding: "1px 4px", borderRadius: 3, marginRight: 5, letterSpacing: 0 }}>KR</span>Korea Manual Entry — KOFIA paste + 7709 units + KRX flows</SLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, margin: "8px 0 10px" }}>
        {["marginLoans", "deposits", "cma", "kr3yGovt", "kr3yCorp", "units7709", "foreignNet", "instNet"].map(k => {
          const e = latest[k];
          const line = kofiaStoredLine(k, e);
          // Colour by direction: currency rows by their %, flows by net sign (green up/buy, red down/sell).
          const isCur = KOFIA_CURRENCY.includes(k), isFlow = k === "foreignNet" || k === "instNet";
          const sig = !e ? null : isCur ? e.pct : isFlow ? e.value : null;
          const col = sig == null ? C.text : sig > 0 ? C.green : sig < 0 ? C.red : C.muted;
          return (
            <div key={k} style={{ minWidth: 140 }}>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>{KOFIA_NAME_BY_KEY[k] || k}</div>
              <div style={{ fontSize: 13, fontWeight: 800, color: line ? ((isCur || isFlow) ? col : C.text) : C.lbl }}>{line || "— not set"}</div>
            </div>
          );
        })}
      </div>
      {koreaFlowRead(latest) && (
        <div style={{ fontSize: 12.5, color: C.mid, margin: "0 0 12px", lineHeight: 1.55, padding: "8px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8 }}>
          <b style={{ color: C.muted, fontWeight: 800 }}>READ · </b>{koreaFlowRead(latest)}
        </div>
      )}
      {mlHist.length >= 2 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: C.muted, fontWeight: 700, marginBottom: 2 }}>Margin Loans (₩T) — history</div>
          <ResponsiveContainer width="100%" height={60}>
            <LineChart data={mlHist} margin={{ top: 4, right: 6, bottom: 0, left: 0 }}>
              <Line type="monotone" dataKey="v" stroke={C.blue} strokeWidth={2} dot={false} isAnimationActive={false} />
              <XAxis dataKey="d" tick={{ fill: C.lbl, fontSize: 9 }} axisLine={false} tickLine={false} />
              <Tooltip />
            </LineChart>
          </ResponsiveContainer>
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
        <Btn onClick={save} disabled={saving || !canSave} color={C.blue} bgColor={C.blBg} label={saving ? "⏳ Saving…" : "💾 Save"} />
      </div>
      {msg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: msg.ok ? C.green : C.red }}>{msg.text}</div>}
    </Card>
  );
}

// Category (role) sort order — the thesis reads cross-region, so foundry sits with
// foundry, memory with memory, regardless of listing venue.
const PB_CAT_ORDER = ["foundry", "memory", "litho", "equip", "gpu", "megacap", "index"];
const pbCatRank = c => { const i = PB_CAT_ORDER.indexOf(c); return i < 0 ? 99 : i; };
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

function GlobalPlaybook({ byRegion, regions, toggleRegion, loading, error, updated, onRefresh, fmtTime }) {
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
          <span style={{ fontSize: 12, color: C.muted }}>Updated {fmtTime(updated)}</span>
          <Btn onClick={onRefresh} disabled={loading} color={C.blue} bgColor={C.blBg} label={loading ? "⏳ …" : "🔄 Refresh"} />
        </div>
      </div>

      {error && <Card style={{ background: C.rBg, border: "1.5px solid " + C.rBdr }}><span style={{ color: C.red, fontSize: 13 }}>{error}</span></Card>}

      {!data ? (
        <Card><div style={{ color: C.muted, fontSize: 14 }}>{loading ? "Loading…" : "No data yet — hit Refresh."}</div></Card>
      ) : (
        <>
          {/* Regime summary — one card per active region (stacked in All view) */}
          {active.map(d => (
          <Card key={d.region}>
            <SLabel>🧭 Regime — {d.label}</SLabel>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
              <div style={{ minWidth: 210 }}>
                <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>Memory vs Foundry</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: C.text }}>{d.regime.split.label}</div>
                <div style={{ fontSize: 12, color: C.muted }}>foundry {pbFmtPct(d.regime.split.fnd)} · memory {pbFmtPct(d.regime.split.mem)}</div>
              </div>
              <div style={{ minWidth: 170 }}>
                <div style={{ fontSize: 12, color: C.muted, fontWeight: 700, marginBottom: 4 }}>Credit — global/OAS gate</div>
                <Pill label={d.regime.credit.state.toUpperCase()} color={pbCreditColor(d.regime.credit.state)} />
                <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{d.regime.credit.note}</div>
              </div>
              <div style={{ minWidth: 170 }}>
                <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>Oil</div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{d.regime.oil.label}</div>
              </div>
            </div>
            {/* Korea-local stress gate (Asia only) */}
            {d.regime.korea && <div style={{ marginTop: 12 }}><KoreaStressPanel korea={d.regime.korea} /></div>}
          </Card>
          ))}

          {/* Korea manual entry (KOFIA paste + 7709 units) — shown when Asia is active */}
          {regions.includes("asia") && byRegion.asia?.kofia &&
            <KoreaManualEntry kofia={byRegion.asia.kofia} onSaved={onRefresh} />}

          {/* Names grid — one flat grid across active regions; sorted category → region →
              %chg with ★ leaders pinned per category. Geo badge shown in All view. */}
          <Card>
            <SLabel>Names {multi ? "· all regions, grouped by category" : ""}</SLabel>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
              {allNames.map(n => {
                const f = pbFresh(n.freshness);
                return (
                <div key={n._region + "|" + n.sym} style={{ background: C.bg, border: "1.5px solid " + (n.leader ? C.blBdr : C.bdr), borderRadius: 10, padding: "10px 12px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{n.leader ? "★ " : ""}{n.name}</span>
                    <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      {multi ? <span style={{ fontSize: 9, fontWeight: 800, color: C.blue, background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 4, padding: "1px 4px" }}>{pbGeo(n.sym)}</span> : null}
                      <span style={{ fontSize: 10, color: C.muted, fontWeight: 700, textTransform: "uppercase" }}>{n.role}</span>
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
                    <span style={{ fontSize: 16, fontWeight: 900, color: C.text }}>{n.price ?? "—"}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: pbPctColor(n.changePct) }}>{pbFmtPct(n.changePct)}</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.muted }}>
                    {n.structure || ""}{f ? <span style={{ color: f.color }}>{n.structure ? " · " : ""}{f.txt}</span> : ""}
                  </div>
                </div>
                );
              })}
            </div>
          </Card>

          {/* Indices — grouped by region */}
          <Card>
            <SLabel>Indices</SLabel>
            {active.map(d => (
            <div key={d.region} style={{ marginBottom: multi ? 12 : 0 }}>
              {multi ? <div style={{ fontSize: 11, color: C.muted, fontWeight: 800, textTransform: "uppercase", marginBottom: 5 }}>{d.label}</div> : null}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
              {d.indices.map(ix => {
                const f = pbFresh(ix.freshness);
                return (
                <div key={ix.sym} style={{ minWidth: 120 }}>
                  <div style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>{ix.name}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ fontSize: 18, fontWeight: 900, color: C.text }}>{ix.price ?? "—"}</span>
                    <span style={{ fontSize: 13, fontWeight: 800, color: pbPctColor(ix.changePct) }}>{pbFmtPct(ix.changePct)}</span>
                  </div>
                  {f ? <div style={{ fontSize: 10, color: f.color }}>{f.txt}</div> : null}
                </div>
                );
              })}
              </div>
            </div>
            ))}
          </Card>

          {/* Macro — identical on every tab (see caption); global/US rates */}
          <Card>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <SLabel>🛢️ Macro</SLabel>
              <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>Global · US rates (same on every region)</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
              <MacroCell field={data.macro.wti}   value={data.macro.wti?.value != null ? "$" + data.macro.wti.value : "—"}     delta={data.macro.wti?.delta} deltaSuffix="" />
              <MacroCell field={data.macro.brent} value={data.macro.brent?.value != null ? "$" + data.macro.brent.value : "—"} delta={data.macro.brent?.delta} deltaSuffix="" />
              <MacroCell field={data.macro.us2y}  value={data.macro.us2y?.value != null ? data.macro.us2y.value + "%" : "—"}   delta={data.macro.us2y?.deltaBps} deltaSuffix="bps" />
              <MacroCell field={data.macro.us10y} value={data.macro.us10y?.value != null ? data.macro.us10y.value + "%" : "—"} delta={data.macro.us10y?.deltaBps} deltaSuffix="bps" />
              <MacroCell field={data.macro.us30y} value={data.macro.us30y?.value != null ? data.macro.us30y.value + "%" : "—"} delta={data.macro.us30y?.deltaBps} deltaSuffix="bps" />
              <MacroCell field={{ name: "2s10s", src: "DGS10−DGS2", date: data.macro.us10y?.date, cadence: "daily" }} value={data.macro.twos10s != null ? (data.macro.twos10s >= 0 ? "+" : "") + data.macro.twos10s + "bps" : "—"} delta={data.macro.twos10sDeltaBps} deltaSuffix="bps" />
              <MacroCell field={data.macro.dxy}   value={data.macro.dxy?.value != null ? data.macro.dxy.value.toFixed(2) : "—"} delta={data.macro.dxy?.delta} deltaSuffix="" />
              <MacroCell field={data.macro.oas}   value={data.macro.oas?.value ?? "—"} delta={data.macro.oas?.deltaBps} deltaSuffix="bps" />
            </div>
            {data.macro.sanity && data.macro.sanity.length > 0 && (
              <div style={{ marginTop: 10, padding: "8px 12px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8, fontSize: 12, color: C.amber, fontWeight: 700 }}>
                ⚠ Sanity: {data.macro.sanity.join(" · ")}
              </div>
            )}
            {/* Regime inputs — gold/BTC co-movement + real yield/breakeven, drives the read below */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed " + C.bdr }}>
              <div style={{ fontSize: 11, color: C.muted, fontWeight: 800, textTransform: "uppercase", marginBottom: 8 }}>Regime Inputs</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
                <MacroCell field={data.macro.gold} value={data.macro.gold?.value != null ? "$" + data.macro.gold.value : "—"} delta={data.macro.gold?.delta} deltaSuffix="" />
                <MacroCell field={data.macro.btc} value={data.macro.btc?.value != null ? "$" + Math.round(data.macro.btc.value).toLocaleString("en-US") : "—"} delta={data.macro.btc?.delta != null ? Math.round(data.macro.btc.delta) : null} deltaSuffix="" />
                <MacroCell field={data.macro.realYield} value={data.macro.realYield?.value != null ? data.macro.realYield.value + "%" : "—"} delta={data.macro.realYield?.deltaBps} deltaSuffix="bps" />
                <MacroCell field={data.macro.breakeven} value={data.macro.breakeven?.value != null ? data.macro.breakeven.value + "%" : "—"} delta={data.macro.breakeven?.deltaBps} deltaSuffix="bps" />
                <MacroCell field={data.macro.move} value={data.macro.move?.value ?? "—"} delta={data.macro.move?.delta} deltaSuffix="" />
                <MacroCell field={data.macro.ovx} value={data.macro.ovx?.value ?? "—"} delta={data.macro.ovx?.delta} deltaSuffix="" />
              </div>
              {data.macro.regimeSignal && (
                <div style={{ marginTop: 10, padding: "10px 12px", background: C.bg, border: "1.5px solid " + C.bdrMd, borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Debasement / stagflation read (gold+BTC co-movement)</div>
                  <div style={{ fontSize: 15, fontWeight: 900, color: C.text }}>{data.macro.regimeSignal.label}</div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    gold {data.macro.regimeSignal.inputs.gold ?? "—"} · btc {data.macro.regimeSignal.inputs.btc ?? "—"} · DXY {data.macro.regimeSignal.inputs.dxy ?? "—"} · real-yield {data.macro.regimeSignal.inputs.realYield ?? "—"} · OAS {data.macro.regimeSignal.inputs.oas ?? "—"}
                  </div>
                </div>
              )}
            </div>
          </Card>

          {/* This week's flagged events */}
          {data.calendar && data.calendar.length > 0 && (
            <Card>
              <SLabel>📅 This Week</SLabel>
              {data.calendar.map((e, i) => (
                <div key={i} style={{ display: "flex", gap: 10, padding: "4px 0", fontSize: 13, color: C.mid, borderBottom: i < data.calendar.length - 1 ? "1px solid " + C.bdr : "none" }}>
                  <span style={{ color: C.muted, minWidth: 92 }}>{e.date}</span>
                  <span style={{ fontWeight: 600 }}>{e.title}</span>
                  <span style={{ color: C.lbl, marginLeft: "auto" }}>{e.region}</span>
                </div>
              ))}
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
  const [insurancePhase, setInsurancePhase] = useState("onset"); // Insurance tab — "onset" | "deflationary" | "inflationary" | "stagflation"
  const [stage4, setStage4] = useState(false); // Posture deploy stage 4 — manual, persisted
  const [stage5, setStage5] = useState(false); // Posture deploy stage 5 — manual, persisted
  const [portfolioValue, setPortfolioValue] = useState(""); // Posture portfolio total (digits only), persisted
  const [funds, setFunds]       = useState(DEFAULT_FUNDS);
  const [selectedFund, setSelectedFund] = useState(DEFAULT_FUNDS[0]);

  const { prices, loading: pricesLoading, updated: pricesUpdated, fetchPrices } = useLivePrices();
  const { live: liveInd, loading: indLoading, updated: indUpdated, error: indError, fetchIndicators } = useLiveIndicators();
  const { byRegion: pbData, loading: pbLoading, updated: pbUpdated, error: pbError, fetchRegion: fetchPlaybookRegion } = useLivePlaybook();

  // Regime probabilities derived from the recession table + live CPI. Falls back
  // to the prior static split when no weighted average is available.
  const fallbackRegimes = { stagflation: 48, reflationary: 17, deflationary: 30, inflationary: 5 };
  const { weightedAvg: recWeightedAvg, kalshi2027: recKalshi2027 } = computeWeightedRecessionProb(RECESSION_SOURCES);
  const cpiForRegime = liveInd?.cpiHeadlineCurrent ?? liveInd?.cpi ?? null;
  const derivedRegimes = deriveRegimeProbabilities(recWeightedAvg, cpiForRegime, recKalshi2027);
  const regimeProbFor = (id) => (derivedRegimes || fallbackRegimes)[
    { stag: "stagflation", ref: "reflationary", def: "deflationary", inf: "inflationary" }[id]
  ];

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
                const cs = liveInd ? liveInd.creditSpread : 2.75;
                const ue = liveInd ? liveInd.unemployment : 4.4;
                const isDeflationary = cs > 6.0 || ue > 5.5;
                const isDanger       = cs > 4.5 || ue > 5.0;
                const isRef          = activeRegime.id === "ref";
                const lbl  = isDeflationary ? "DANGER" : isDanger ? "ALERT" : isRef ? "NEUTRAL" : "WATCH";
                const col  = isDeflationary ? C.red    : isDanger ? "#D97706" : isRef ? C.green   : C.amber;
                const bg   = isDeflationary ? C.rBg    : isDanger ? C.aBg     : isRef ? C.gBg     : C.aBg;
                const bdr  = isDeflationary ? C.rBdr   : isDanger ? C.aBdr    : isRef ? C.gBdr    : C.aBdr;
                const sub  = isDeflationary ? "threshold breached"
                           : isDanger       ? "approaching alert zone"
                           : isRef          ? "regime: recovery"
                           : "2/3 amber · " + activeRegime.label;
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
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div className="mwd-content-pad" style={{ maxWidth: 1080, margin: "0 auto", padding: "16px" }}>

        {/* ── INDICATORS ── */}
        {tab === "indicators" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

            {/* ACTION CARD — top, high-emphasis, colorizes with signal */}
            {(() => {
              const cs = liveInd ? liveInd.creditSpread : 2.75;
              const ue = liveInd ? liveInd.unemployment : 4.4;
              const isDanger  = cs > 6.0 || ue > 5.5;
              const isAlert   = !isDanger && (cs > 4.5 || ue > 5.0);
              const isNeutral = !isDanger && !isAlert && activeRegime.id === "ref";
              const sigLabel  = isDanger ? "DANGER" : isAlert ? "ALERT" : isNeutral ? "NEUTRAL" : "WATCH";
              const CONFIGS = {
                DANGER:  { g1:"#991B1B", g2:"#B91C1C", shadow:"rgba(153,27,27,0.35)",
                  action:"Stage 3 — Full Insurance Active. Let Puts Work.",
                  bullets:["🚨 Stage 3 triggered — Full insurance active. No new equity.",
                           "⏳ Do not deploy cash yet — Path 2 corrections average 18 months.",
                           "📈 Wait for VIX peak before Stage 4."] },
                ALERT:   { g1:"#92400E", g2:"#B45309", shadow:"rgba(146,64,14,0.35)",
                  action:"Stage 2 — Buy First Insurance Tranche.",
                  bullets:["🛡️ Stage 2 triggered — Buy first insurance tranche.",
                           "🎯 SPY puts at 90% strike, 90-day expiry, 1.5% of portfolio in premium.",
                           "📉 Reduce any leveraged positions now."] },
                WATCH:   { g1:"#334155", g2:"#1E293B", shadow:"rgba(30,41,59,0.35)",
                  action:"Stage 1 — Surveillance. Prepare, Don't Deploy.",
                  bullets:["🔍 Stage 1 active — Surveillance. No insurance purchases yet.",
                           "📉 VIX below 20 means insurance is cheap — this is the preparation window, not the activation window.",
                           "💵 Berkshire's playbook: T-bills at ~4.2% while waiting. Optionality > yield."] },
                NEUTRAL: { g1:"#166534", g2:"#15803D", shadow:"rgba(22,101,52,0.30)",
                  action:"Risk-On. Deploy Capital Selectively.",
                  bullets:["🌱 Reflationary recovery underway. AI infrastructure, broad equities, and REITs leading.",
                           "📈 Reduce insurance overweight — defensive positioning gives way to growth assets.",
                           "🔄 Watch for credit spread re-widening as the signal to rotate back defensive."] },
              };
              const cfg = CONFIGS[sigLabel];
              return (
                <>
                  <div style={{ background: `linear-gradient(135deg, ${cfg.g1}, ${cfg.g2})`, borderRadius: 14, padding: "18px 22px", color: "#fff", boxShadow: `0 4px 24px ${cfg.shadow}`, transition: "background 0.4s" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 11, letterSpacing: 3, textTransform: "uppercase", opacity: 0.7, fontWeight: 700, marginBottom: 5 }}>Recommended Action · Jun 2026</div>
                        <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.5, lineHeight: 1.2 }}>{cfg.action}</div>
                      </div>
                      <div style={{ background: "rgba(255,255,255,0.18)", borderRadius: 10, padding: "8px 16px", textAlign: "center", backdropFilter: "blur(4px)", minWidth: 90 }}>
                        <div style={{ fontSize: 10, letterSpacing: 2, textTransform: "uppercase", opacity: 0.8, marginBottom: 2 }}>Signal</div>
                        <div style={{ fontSize: 22, fontWeight: 900, color: "#fff", lineHeight: 1 }}>{sigLabel}</div>
                        <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2 }}>{activeRegime.label}</div>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                      {cfg.bullets.map((t, i) => (
                        <div key={i} style={{ flex: "1 1 200px" }}>
                          <span style={{ color: "#fff", fontSize: 14, lineHeight: 1.7, opacity: 0.92 }}>{t}</span>
                        </div>
                      ))}
                    </div>
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
                <SLabel>Overall Read · Jun 2026</SLabel>
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
                  { icon: "⚠️", text: `Yield curve at ${liveInd ? (liveInd.yieldSpread >= 0 ? "+" : "") + liveInd.yieldSpread.toFixed(2) + "%" : "+0.38%"} — ${liveInd && liveInd.yieldSpread < 0 ? "still inverted, pricing recession ahead." : liveInd && liveInd.yieldSpread < 0.5 ? "re-normalized but in the danger window (avg 4–11 months to recession after un-inversion)." : "steepening toward normal. Danger window still open until spread exceeds +1.0%."}` },
                  { icon: liveInd && liveInd.unemployment >= 5.0 ? "🚨" : "⚠️", text: `Unemployment at ${liveInd ? liveInd.unemployment.toFixed(1) : "4.4"}% — risen from 3.4% trough${liveInd ? ", a " + (liveInd.unemployment - 3.4).toFixed(1) + "pp rise" : ""}. ${liveInd && liveInd.unemployment >= 5.0 ? "Recession confirmed by this indicator." : liveInd && liveInd.unemployment >= 4.5 ? "Sahm Rule triggered. Defensive positioning warranted." : "Sahm Rule borderline. Direction is the concern."}` },
                ].map((r, i) => (
                  <div key={i} style={{ flex: "1 1 200px", display: "flex", gap: 10 }}>
                    <span style={{ fontSize: 17, flexShrink: 0 }}>{r.icon}</span>
                    <span style={{ color: C.amber, fontSize: 14, lineHeight: 1.65 }}>{r.text}</span>
                  </div>
                ))}
              </div>
            </Card>

            {INDICATORS.map(ind => <IndicatorChart key={ind.id} ind={ind} live={liveInd} />)}
          </div>
        )}

        {/* ── POSTURE ── */}
        {tab === "posture" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {(() => {
              const cs = liveInd ? liveInd.creditSpread : 2.75;
              const ue = liveInd ? liveInd.unemployment : 4.4;
              // Live crash signal — identical thresholds to the Indicators action card.
              // Drives stages 1–3. Allocations are regime-driven (separate axis).
              const sigDanger = cs > 6.0 || ue > 5.5;
              const sigAlert  = !sigDanger && (cs > 4.5 || ue > 5.0);
              const signalStage = sigDanger ? 3 : sigAlert ? 2 : 1;
              const sigLabel = sigDanger ? "DANGER" : sigAlert ? "ALERT" : "WATCH";
              const sigColor = sigDanger ? C.red : sigAlert ? "#D97706" : C.amber;
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
                          <div style={{ color: C.mid, fontSize: 12, lineHeight: 1.55 }}>{a.note}</div>
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
            {/* Crash Scenario Guide — TOP of page. Static ratings (regime-independent);
                the three column headers ARE the scenario selector. Picking a column
                drives the phase-note callouts in the instrument detail below. */}
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                <SLabel>Crash Scenario Guide</SLabel>
                <span style={{ color: C.lbl, fontSize: 12 }}>Tap a column to plan around that scenario ↓</span>
              </div>
              <div style={{ overflowX: "auto", width: "100%" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620, fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", color: C.mid, padding: "6px 10px", borderBottom: "1.5px solid " + C.bdr, fontWeight: 700, width: 140, minWidth: 140 }}>Instrument</th>
                      {INSURANCE_PHASES.map(p => {
                        const on = insurancePhase === p.k;
                        return (
                          <th key={p.k} style={{ padding: 0, minWidth: 120, borderBottom: "1.5px solid " + (on ? p.color : C.bdr) }}>
                            <button onClick={() => setInsurancePhase(p.k)} title={p.desc} style={{
                              width: "100%", cursor: "pointer", border: "none", whiteSpace: "nowrap",
                              background: on ? p.color : "transparent",
                              color: on ? "#fff" : p.color,
                              fontWeight: 800, fontSize: 12, padding: "8px 10px", lineHeight: 1.25,
                              borderTopLeftRadius: 6, borderTopRightRadius: 6,
                            }}>
                              {on ? "● " : ""}{p.short}
                            </button>
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
                          <td colSpan={5} style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "#999", textTransform: "uppercase", padding: "10px 12px 4px", backgroundColor: "transparent", borderBottom: "none" }}>
                            {r.group}
                          </td>
                        </tr>
                      );
                      rows.push(
                        <tr key={r.row} style={{ background: ri % 2 === 0 ? C.surf : C.bg }}>
                          <td style={{ padding: "6px 10px", color: C.text, fontWeight: 600, borderBottom: "1px solid " + C.bdr, width: 140, minWidth: 140 }}>{r.row}</td>
                          {INSURANCE_PHASES.map(p => {
                            const on = insurancePhase === p.k;
                            return (
                              <td key={p.k} style={{ textAlign: "center", padding: "6px 8px", fontSize: 14, minWidth: 120, borderBottom: "1px solid " + C.bdr, background: on ? p.bg : "transparent", fontWeight: on ? 800 : 400 }}>
                                {r[p.col]}
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
              <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
                {[["✅✅", "Primary instrument"], ["✅", "Works well"], ["⚠️", "Caution / timing-dependent"], ["❌", "Avoid"]].map(([sym, lbl]) => (
                  <div key={lbl} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 12, color: C.muted }}>
                    <span style={{ fontSize: 13 }}>{sym}</span>{lbl}
                  </div>
                ))}
              </div>
              {/* Active scenario summary + live-signal lean (informational; your call) */}
              {(() => {
                const active = INSURANCE_PHASES.find(p => p.k === insurancePhase) || INSURANCE_PHASES[0];
                const read = getCrashSignalRead(liveInd || {}, activeRegime);
                return (
                  <div style={{ marginTop: 12, padding: "10px 13px", background: active.bg, border: "1.5px solid " + active.bdr, borderRadius: 8 }}>
                    <div style={{ color: active.color, fontWeight: 800, fontSize: 13, marginBottom: 3 }}>Planning for: {active.label}</div>
                    <div style={{ color: C.mid, fontSize: 13, lineHeight: 1.6 }}>{active.desc}</div>
                    <div style={{ color: C.muted, fontSize: 12, fontStyle: "italic", marginTop: 6, lineHeight: 1.55 }}>
                      Live signals lean toward: <b style={{ fontStyle: "normal", color: C.text }}>{read.lean}</b> — {read.reason}. Your call — set the column you believe.
                    </div>
                  </div>
                );
              })()}
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
                      ⚠️ TLT dropped 30%+ in 2022 stagflation. Long bonds are the worst insurance when inflation is embedded. Gold miners + staples dominate.
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
                      🔥 Inflationary boom: Gold miners are the best insurance. Farmland #2. Bonds are toxic. Real assets dominate.
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
                        background: activeAsset.id === a.id ? a.bg : C.surf,
                        border: "1.5px solid " + (activeAsset.id === a.id ? a.color : C.bdr),
                        borderLeft: "4px solid " + a.color,
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
                          background: activeIncome.category === p.category ? p.bg : C.surf,
                          border: "1.5px solid " + (activeIncome.category === p.category ? p.color + "60" : C.bdr),
                          borderLeft: "4px solid " + p.color,
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
                            {tk.yield && <span style={{ background: C.gBg, color: C.green, border: "1px solid " + C.gBdr, borderRadius: 4, padding: "1px 5px", fontSize: 11, fontWeight: 700, display: "block", textAlign: "center", marginTop: 3 }}>{tk.yield}</span>}
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
                            <div style={{ color: C.muted, fontSize: 14, marginTop: 3, lineHeight: 1.6 }}>{tk.note}</div>
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
            {/* 13F staleness banner */}
            <div style={{ background: C.aBg, border: "1.5px solid " + C.aBdr, borderRadius: 12, padding: "11px 15px", color: C.amber, fontSize: 14, lineHeight: 1.6, fontWeight: 600 }}>
              ⚠️ Q2 2026 13F data available mid-August 2026 — fund positions below reflect Q1 2026 filings. Update manually when available.
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
                    {CONSENSUS_ROWS.map((row, ri) => (
                      <tr key={row.theme} style={{ background: ri % 2 === 0 ? C.surf : C.bg }}>
                        <td style={{ padding: "9px 12px", color: C.text, fontSize: 14, fontWeight: 600, borderBottom: "1px solid " + C.bdr }}>{row.theme}</td>
                        {row.vals.slice(0, funds.length).map((v, i) => {
                          const col = v === "●" || v === "●●" ? "#166534" : v === "◐" ? "#D97706" : v === "✕" ? "#991B1B" : C.bdrMd;
                          return <td key={i} style={{ textAlign: "center", padding: "9px 8px", color: col, fontSize: 17, borderBottom: "1px solid " + C.bdr }}>{v}</td>;
                        })}
                        <td style={{ padding: "9px 8px", color: C.muted, fontSize: 12, borderBottom: "1px solid " + C.bdr }}>{row.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
                {[["#166534","● Active"],["#D97706","◐ Partial"],["#991B1B","✕ Short/exit"],[C.bdrMd,"◯ Absent"]].map(([col, lbl]) => (
                  <div key={lbl} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 13, color: C.muted }}>
                    <span style={{ color: col, fontSize: 15 }}>{lbl.charAt(0)}</span>{lbl.slice(2)}
                  </div>
                ))}
              </div>
            </Card>

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
                <span style={{ color: C.amber, fontWeight: 700, fontSize: 13 }}>⚠️ The live disagreement: </span>
                <span style={{ color: C.amber, fontSize: 14 }}>Druckenmiller + Bridgewater positioned for stagflation/debasement. Tiger + Pershing + Appaloosa positioned for recovery. Berkshire waiting for neither. Add or edit funds on the Smart Money tab — this table updates instantly.</span>
              </div>
            </Card>

            {/* Fund selector — single row, flex-fit with horizontal-scroll fallback (Fix 1) */}
            <div className="mwd-smartmoney-row">
              {funds.map(f => (
                <button key={f.id} onClick={() => setSelectedFund(f)} style={{
                  background: selectedFund.id === f.id ? f.color + "12" : C.surf,
                  border: "1.5px solid " + (selectedFund.id === f.id ? f.color : C.bdr),
                  borderLeft: "4px solid " + f.color,
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
            {/* 10Y Treasury auction health — number + 12-auction trend chart */}
            {(() => {
              const bc = liveInd ? liveInd.auctionBidCover : null;
              const ad = liveInd ? liveInd.auctionDate : null;
              const hist = liveInd && Array.isArray(liveInd.auctionHistory) ? liveInd.auctionHistory : [];
              let col = C.muted, bg = C.bg, bd = C.bdr, msg = "Unavailable — check TreasuryDirect manually";
              if (bc != null) {
                if (bc >= 2.5)      { col = C.green; bg = C.gBg; bd = C.gBdr; msg = "Strong demand. No stress."; }
                else if (bc >= 2.3) { col = C.amber; bg = C.aBg; bd = C.aBdr; msg = "Softening. Monitor closely."; }
                else                { col = C.red;   bg = C.rBg; bd = C.rBdr; msg = "Stress signal. Weak auction demand. Watch for Fed intervention."; }
              }
              const lineColor = bc != null ? (bc >= 2.5 ? "#22c55e" : bc >= 2.3 ? "#f59e0b" : "#ef4444") : "#9ca3af";
              return (
                <Card style={{ background: bg, border: "1.5px solid " + bd }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                    <div>
                      <SLabel>10Y Treasury Auction Health</SLabel>
                      {bc != null ? (
                        <>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 30, fontWeight: 900, letterSpacing: -1, color: col }}>{bc.toFixed(2)}x</span>
                            <span style={{ color: col, fontSize: 14, fontWeight: 700 }}>{msg}</span>
                          </div>
                          <div style={{ color: C.lbl, fontSize: 12, marginTop: 3 }}>Last auction: {ad || "—"}</div>
                        </>
                      ) : (
                        <div style={{ color: C.muted, fontSize: 14 }}>{msg}</div>
                      )}
                    </div>
                    <div style={{ maxWidth: 240, color: C.muted, fontSize: 12, lineHeight: 1.6 }}>
                      Threshold: &lt;2.3x = stress signal. Weak foreign/institutional demand for US debt.
                    </div>
                  </div>
                  {/* Trend chart — last 12 auctions, oldest → newest */}
                  {hist.length >= 2 ? (
                    <div style={{ marginTop: 12 }}>
                      <ResponsiveContainer width="100%" height={120}>
                        <LineChart data={hist} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 10 }}
                            tickFormatter={(d) => {
                              const date = new Date(d);
                              return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
                            }}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            domain={["auto", "auto"]}
                            tick={{ fontSize: 10 }}
                            width={44}
                            tickFormatter={(v) => `${v.toFixed(2)}x`}
                          />
                          <Tooltip
                            formatter={(value) => [`${value}x`, "Bid-to-Cover"]}
                            labelFormatter={(label) => `Auction: ${label}`}
                          />
                          {/* Stress threshold — red dotted */}
                          <ReferenceLine y={2.3} stroke="#ef4444" strokeDasharray="4 3" label={{ value: "2.3x stress", position: "right", fontSize: 9, fill: "#ef4444" }} />
                          {/* Strong demand threshold — green dotted */}
                          <ReferenceLine y={2.5} stroke="#22c55e" strokeDasharray="4 3" label={{ value: "2.5x strong", position: "right", fontSize: 9, fill: "#22c55e" }} />
                          <Line type="monotone" dataKey="value" stroke={lineColor} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <div style={{ marginTop: 12, color: C.muted, fontSize: 13, fontStyle: "italic" }}>
                      Insufficient history — check back after next auction
                    </div>
                  )}
                </Card>
              );
            })()}

            {/* Market-Implied Fed Cuts (6-Month) — Fed funds vs 6m T-bill proxy (Update 1) */}
            {(() => {
              const bps = liveInd ? liveInd.impliedCutsBps : null;
              const cf  = liveInd ? liveInd.currentFedFunds : null;
              const tb  = liveInd ? liveInd.tbill6m : null;
              let fcCol = C.muted, fcMsg = "Unavailable — Fed funds / T-bill data not loaded", fcNote = "";
              if (bps != null) {
                if (bps < 0)        { fcCol = C.red;     fcMsg = "Market pricing rate hike. Hold USFR, avoid duration.";                                   fcNote = "USFR yield likely to rise further. Hold. Avoid all duration."; }
                else if (bps === 0) { fcCol = C.muted;   fcMsg = "No cuts priced in. Market aligned with hawkish hold.";                                    fcNote = "USFR and SGOV remain optimal. No action needed on cash positions."; }
                else if (bps < 25)  { fcCol = C.amber;   fcMsg = `Market pricing ~${bps}bps of cuts. Early expectation forming.`;                          fcNote = "Monitor Fed language for confirmation. No action yet — futures can be wrong."; }
                else if (bps < 50)  { fcCol = "#f97316"; fcMsg = "Market pricing ~1 cut. Watch for Fed language confirmation.";                             fcNote = "Prepare IEF/TLT position. Do not rotate yet — wait for Fed language confirmation (Dovish Tilt or better)."; }
                else                { fcCol = C.green;   fcMsg = "Market pricing 2+ cuts within 6 months. USFR → IEF rotation signal approaching.";        fcNote = "Rotation signal active if Fed language confirms. USFR → IEF on confirmed pivot. Begin Stage 4 checklist."; }
              }
              return (
                <Card style={{ borderLeft: "3px solid " + fcCol }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                    <div>
                      <SLabel>Market-Implied Fed Cuts (6-Month)</SLabel>
                      {bps != null ? (
                        <>
                          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 30, fontWeight: 900, letterSpacing: -1, color: fcCol }}>{bps} bps</span>
                            <span style={{ color: fcCol, fontSize: 14, fontWeight: 700, maxWidth: 380 }}>{fcMsg}</span>
                          </div>
                          <div style={{ color: C.lbl, fontSize: 12, marginTop: 3 }}>Current Fed funds: {cf != null ? cf.toFixed(2) : "—"}% | 6M T-bill: {tb != null ? tb.toFixed(2) : "—"}%</div>
                        </>
                      ) : (
                        <div style={{ color: C.muted, fontSize: 14 }}>{fcMsg}</div>
                      )}
                    </div>
                    <div style={{ maxWidth: 240, color: C.muted, fontSize: 12, lineHeight: 1.6 }}>
                      Proxy: Fed funds rate minus 6-month T-bill. Positive = market pricing cuts.
                    </div>
                  </div>
                  {bps != null && fcNote && (
                    <div style={{ marginTop: 10, padding: "9px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, color: C.mid, fontSize: 13, lineHeight: 1.55 }}>{fcNote}</div>
                  )}
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

            {/* CPI Inflation Tracker — Headline/Core CPI + Core PCE YoY, real-yield-on-cash */}
            {(() => {
              const getCpiColor = (value) => {
                if (!value) return "#888";
                if (value >= 4.0) return "#ef4444";  // red — well above target
                if (value >= 3.0) return "#f97316";  // orange — elevated
                if (value >= 2.5) return "#eab308";  // amber — above target
                if (value >= 1.5) return "#22c55e";  // green — near target
                return "#3b82f6";                    // blue — below target, deflation risk
              };
              const headline = liveInd ? liveInd.cpiHeadlineCurrent : null;
              const core     = liveInd ? liveInd.cpiCoreCurrent : null;
              const pce      = liveInd ? liveInd.pceCoreCurrent : null;
              const hHist = liveInd && Array.isArray(liveInd.cpiHeadlineHistory) ? liveInd.cpiHeadlineHistory : [];
              const cHist = liveInd && Array.isArray(liveInd.cpiCoreHistory)     ? liveInd.cpiCoreHistory     : [];
              const pHist = liveInd && Array.isArray(liveInd.pceCoreHistory)     ? liveInd.pceCoreHistory     : [];
              const hasChartData = [hHist, cHist, pHist].some(a => a.length >= 2);
              const realYield = (liveInd && liveInd.currentFedFunds && headline != null)
                ? (liveInd.currentFedFunds - headline)
                : null;
              const reading = (label, val, sub) => (
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: getCpiColor(val) }}>{val != null ? val.toFixed(1) + "%" : "—"}</div>
                  <div style={{ fontSize: 11, color: "#888" }}>{sub}</div>
                </div>
              );
              return (
                <Card>
                  <SLabel>CPI Inflation Tracker</SLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 4, marginBottom: 16 }}>
                    {reading("Headline CPI", headline, "YoY · BLS")}
                    {reading("Core CPI", core, "Ex food & energy · BLS")}
                    {reading("Core PCE", pce, "Fed's preferred · BEA")}
                  </div>
                  {realYield != null && (
                    <div style={{ padding: "8px 12px", borderRadius: 6, backgroundColor: realYield > 0 ? "#f0fdf4" : "#fef2f2", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: C.mid }}>
                        Real Yield on Cash (Fed Funds − CPI):
                        <span style={{ color: realYield > 0 ? "#22c55e" : "#ef4444", marginLeft: 8, fontWeight: 800 }}>
                          {realYield > 0 ? "+" : ""}{realYield.toFixed(2)}%
                        </span>
                      </span>
                      <span style={{ fontSize: 11, color: "#888", fontStyle: "italic" }}>
                        {realYield > 0 ? "SGOV/USFR earning above inflation. Hold." : "Inflation exceeding cash yield. Real erosion active."}
                      </span>
                    </div>
                  )}
                  {hasChartData ? (
                    <ResponsiveContainer width="100%" height={160}>
                      <LineChart margin={{ top: 4, right: 52, bottom: 4, left: 0 }}>
                        <XAxis
                          dataKey="date"
                          type="category"
                          allowDuplicatedCategory={false}
                          tick={{ fontSize: 10 }}
                          tickFormatter={(d) => {
                            const date = new Date(d);
                            return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
                          }}
                          interval={3}
                        />
                        <YAxis tick={{ fontSize: 10 }} width={32} tickFormatter={(v) => `${v}%`} domain={["auto", "auto"]} />
                        <Tooltip formatter={(value, name) => [`${value.toFixed(2)}%`, name]} labelFormatter={(label) => label} />
                        <Legend iconType="line" iconSize={10} wrapperStyle={{ fontSize: "11px" }} />
                        {/* Fed 2% target line — extendDomain so it stays visible when CPI sits above it */}
                        <ReferenceLine y={2} stroke="#22c55e" strokeDasharray="4 3" ifOverflow="extendDomain" label={{ value: "2% target", position: "right", fontSize: 9, fill: "#22c55e" }} />
                        {/* USFR yield reference — hardcoded; update manually when rates move materially.
                            extendDomain keeps it on-chart; when a CPI line crosses above it, real yield on cash turns negative. */}
                        <ReferenceLine y={5.3} stroke="#3b82f6" strokeDasharray="4 3" ifOverflow="extendDomain" label={{ value: "USFR ~5.3%", position: "right", fontSize: 9, fill: "#3b82f6" }} />
                        <Line data={hHist} type="monotone" dataKey="value" name="Headline CPI" stroke="#ef4444" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                        <Line data={cHist} type="monotone" dataKey="value" name="Core CPI" stroke="#f97316" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
                        <Line data={pHist} type="monotone" dataKey="value" name="Core PCE" stroke="#8b5cf6" strokeWidth={2} strokeDasharray="5 3" dot={false} activeDot={{ r: 4 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div style={{ color: C.muted, fontSize: 13, fontStyle: "italic", marginTop: 8 }}>Awaiting data</div>
                  )}
                </Card>
              );
            })()}

            <Card>
              <SLabel>Wall Street Recession Probability (July 8, 2026)</SLabel>
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
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 400 }}>
                  <thead>
                    <tr style={{ background: C.bg }}>
                      {["Source", "Probability", "Timeframe", "Notes"].map(h => (
                        <th key={h} style={{ textAlign: "left", color: C.mid, padding: "8px 12px", borderBottom: "2px solid " + C.bdr, fontSize: 13, fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {RECESSION_SOURCES.map((r, i) => {
                      const pCol = r.color === "red" ? C.red : r.color === "amber" ? C.amber : C.green;
                      return (
                      <tr key={i} style={{ background: i % 2 === 0 ? C.surf : C.bg }}>
                        <td style={{ padding: "8px 12px", color: C.text, fontSize: 14, fontWeight: 600, borderBottom: "1px solid " + C.bdr }}>{r.name}</td>
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid " + C.bdr }}>
                          <span style={{ color: pCol, fontWeight: 800, fontSize: 15 }}>{r.probability}</span>
                        </td>
                        <td style={{ padding: "8px 12px", color: C.muted, fontSize: 13, borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap" }}>{r.timeframe}</td>
                        <td style={{ padding: "8px 12px", color: C.muted, fontSize: 13, borderBottom: "1px solid " + C.bdr }}>{r.notes}</td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 12, padding: "12px 14px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8 }}>
                <span style={{ color: C.amber, fontWeight: 700, fontSize: 13 }}>⚠️ The signal that matters: </span>
                <span style={{ color: C.amber, fontSize: 14, lineHeight: 1.65 }}>Goldman's dramatic round-trip — 15% (pre-war) → 30% (March peak) → 15% (June post-deal) — shows how oil-driven the near-term risk was. Post peace deal, 2026 recession odds have broadly normalized. The more important signal is 2027: Kalshi at 41% suggests markets expect delayed reckoning from debt refinancing at 5-7%, $1.3T consumer revolving credit balances, and corporate capex compression. New risk to monitor: half of FOMC officials penciled in rate hikes at June meeting — BofA expects 3 hikes, Deutsche Bank expects 2. If hikes materialize, recession risk reprices sharply higher.</span>
              </div>
            </Card>

            <Card>
              <SLabel>Regime Probability — Derived from Recession Consensus + Live CPI</SLabel>
              <div className="mwd-regime-grid" style={{ marginBottom: 14 }}>
                {REGIMES.map(r => (
                  <button key={r.id} onClick={() => setActiveRegime(r)} style={{ background: activeRegime.id === r.id ? r.bg : C.surf, border: "1.5px solid " + (activeRegime.id === r.id ? r.color : C.bdr), borderTop: "4px solid " + r.color, borderRadius: 10, padding: "12px 14px", cursor: "pointer", textAlign: "left", width: "100%" }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: r.color }}>{regimeProbFor(r.id)}%</div>
                    <div style={{ color: r.color, fontWeight: 700, fontSize: 13, marginTop: 3, lineHeight: 1.3 }}>{r.label}</div>
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", border: "1px solid " + C.bdr }}>
                {REGIMES.map(r => (
                  <div key={r.id} style={{ width: regimeProbFor(r.id) + "%", background: r.color, fontSize: 10, color: "#fff", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }} title={r.label}>{regimeProbFor(r.id)}%</div>
                ))}
              </div>
              {derivedRegimes ? (
                <div style={{ marginTop: 10 }}>
                  <div style={{ color: C.lbl, fontSize: 11, lineHeight: 1.5 }}>Weighted Wall Street recession probability: <b style={{ color: C.muted }}>{derivedRegimes.weightedAvg}%</b> | Derived from analyst consensus + live CPI</div>
                  <div style={{ color: C.lbl, fontSize: 11, lineHeight: 1.5, marginTop: 2 }}>{derivedRegimes.derivedFrom}</div>
                  <div style={{ color: C.lbl, fontSize: 11, lineHeight: 1.5, marginTop: 2, fontStyle: "italic" }}>Updates automatically when recession table is refreshed or CPI changes.</div>
                </div>
              ) : (
                <div style={{ color: C.lbl, fontSize: 11, marginTop: 10, fontStyle: "italic" }}>Using fallback regime probabilities — live recession data unavailable.</div>
              )}
            </Card>

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <Card style={{ flex: "1 1 240px", background: activeRegime.bg, border: "1.5px solid " + activeRegime.bdr, borderTop: "4px solid " + activeRegime.color }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: activeRegime.color, marginBottom: 4 }}>{activeRegime.label}</div>
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
                <Card style={{ background: C.gBg, border: "1.5px solid " + C.gBdr }}>
                  <SLabel color={C.green}>Best Assets</SLabel>
                  {activeRegime.best.map((a, i) => (
                    <div key={i} style={{ color: C.green, fontSize: 14, padding: "4px 0", borderBottom: i < activeRegime.best.length - 1 ? "1px solid " + C.gBdr : "none" }}>✅ {a}</div>
                  ))}
                </Card>
                <Card style={{ background: C.rBg, border: "1.5px solid " + C.rBdr }}>
                  <SLabel color={C.red}>Worst Assets</SLabel>
                  {activeRegime.worst.map((a, i) => (
                    <div key={i} style={{ color: C.red, fontSize: 14, padding: "4px 0", borderBottom: i < activeRegime.worst.length - 1 ? "1px solid " + C.rBdr : "none" }}>❌ {a}</div>
                  ))}
                </Card>
              </div>
            </div>

            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                <SLabel>Transition Roadmap</SLabel>
                <Btn onClick={fetchIndicators} disabled={indLoading} color="#fff" bgColor={C.blue} label={indLoading ? "Fetching…" : "🔄 Refresh signals"} />
              </div>
              {(() => {
                // Live values with static fallbacks
                const hy  = liveInd ? liveInd.creditSpread  : 2.75;
                const ue  = liveInd ? liveInd.unemployment  : 4.4;
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
                const gdpNote = gdp && gdp > 0
                  ? `Real GDP: $${(gdp/1000).toFixed(1)}T (latest BEA quarterly release via FRED)`
                  : "GDP: fetching from FRED…";

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
                    prob: `${derivedRegimes?.deflationary ?? 35}% most likely`, color: C.blue,
                    path: "High oil + tight Fed choke off demand. Businesses stop hiring, consumers stop spending. Credit markets crack first — then unemployment surges. Treasuries and cash win. Everything else falls.",
                    signals: [
                      {
                        label: "HY Credit Spread", value: hy, unit: "%", threshold: 4.5,
                        thresholdLabel: "alert >4.5%", good: "below", fmtVal: v => v.toFixed(2),
                        context: (v, breached) => breached
                          ? `At ${v.toFixed(2)}%, credit markets are pricing stress. Companies are struggling to refinance debt — this is the classic deflationary warning. Act now.`
                          : `At ${v.toFixed(2)}%, credit markets are calm — investors aren't panicking yet. This scenario needs spreads to widen to 4.5%+ before it becomes probable. Watch weekly.`,
                      },
                      {
                        label: "Unemployment", value: ue, unit: "%", threshold: 5.0,
                        thresholdLabel: "recession >5%", good: "below", fmtVal: v => v.toFixed(1),
                        context: (v, breached) => breached
                          ? `At ${v.toFixed(1)}%, unemployment has crossed the recession confirmation threshold. Demand destruction is underway.`
                          : `At ${v.toFixed(1)}%, unemployment is elevated but hasn't hit the 5% recession zone yet. Rising trend is the concern — direction matters more than the level.`,
                      },
                    ],
                    tip: liveInd
                      ? (hy > 4.5 ? "⚠️ Credit spreads have breached the alert level. Deflationary recession risk is now elevated — consider rotating toward Treasuries and cash."
                        : hy > 3.5 ? "📡 Spreads are widening toward the alert zone. Start building insurance positions — don't wait for 4.5% to confirm."
                        : `✅ Both indicators are well within safe territory today. This scenario requires credit spreads to more than double from here (${hy.toFixed(2)}% → 4.5%+). Low near-term risk.`)
                      : "Hit Refresh signals to get live readings for this scenario.",
                  },
                  {
                    label: "Stagflation → Reflationary Recovery",
                    prob: `${derivedRegimes?.reflationary ?? 30}% next likely`, color: C.green,
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
                    label: "Persistent Stagflation (1970s path)",
                    prob: `${derivedRegimes?.stagflation ?? 25}% painful`, color: C.amber,
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
                    prob: `${derivedRegimes?.inflationary ?? 5}% — Dalio scenario`, color: "#7C3AED",
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

                return ROADMAP.map((r, i) => (
                  <div key={i} style={{ padding: "16px 0", borderBottom: i < ROADMAP.length - 1 ? "1px solid " + C.bdr : "none" }}>
                    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                      <div style={{ flexShrink: 0, width: 120, paddingTop: 2 }}>
                        <span style={{ background: r.color + "15", color: r.color, border: "1.5px solid " + r.color + "40", borderRadius: 8, padding: "5px 8px", fontSize: 11, fontWeight: 800, display: "block", textAlign: "center", lineHeight: 1.4, wordBreak: "break-word" }}>{r.prob}</span>
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

        {/* FOOTER */}
        <div style={{ color: C.lbl, fontSize: 12, textAlign: "center", marginTop: 20, paddingTop: 14, borderTop: "1px solid " + C.bdr }}>
          Data: SEC 13F (Q1 2026 · filed May 15 2026) · FRED / ICE BofA / US Treasury (Jun 2026) · Berkshire cash $397.4B confirmed Q1 2026.<br />
          Editable fund data auto-saves to browser storage · Global family portfolio (UAE/HK/Canada) — consult local tax advisors for withholding treatment · Not investment advice.
        </div>
      </div>
    </div>
  );
}