import { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area, BarChart, Bar, RadarChart, PolarGrid,
  PolarAngleAxis, Radar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";

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
    status:"AMBER", label:"Rising", color:"#92400E", areaColor:"#F59E0B",
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
      if (v >= 4.0)  return { label:"Elevated & Rising",    text:"Above historical average and trending up. Not yet alarming but direction is wrong. Monitor closely.",           color:"#D97706", bg:"#FFFBEB", bdr:"#FCD34D" };
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
    ],
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
      {t:"IEF",  name:"iShares 7-10 Year Treasury",type:"ETF", note:"Less volatile. More balanced duration."},
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
    thesis:"993 holdings. Key Q1 rotation: dumped SaaS (CRM, WDAY, ADBE exits) and loaded AI chips (AVGO +670K, MU +50%, TSM new position). Simultaneously adding GLD as macro/debasement hedge. Dual bet: AI infrastructure micro side, inflation protection macro side.",
    holdings:[
      {name:"SPY",  pct:12.7,value:2.85,sector:"Passive",action:"trim"},
      {name:"IVV",  pct:8.2, value:1.84,sector:"Passive",action:"trim"},
      {name:"AMZN", pct:4.1, value:0.92,sector:"Tech",   action:"added"},
      {name:"NVDA", pct:3.8, value:0.85,sector:"Semis",  action:"added"},
      {name:"GOOGL",pct:3.2, value:0.72,sector:"Tech",   action:"added"},
      {name:"AVGO", pct:2.5, value:0.56,sector:"Semis",  action:"added"},
      {name:"MU",   pct:2.2, value:0.49,sector:"Semis",  action:"+50%"},
      {name:"ORCL", pct:1.8, value:0.40,sector:"Tech",   action:"added"},
      {name:"TSM",  pct:1.6, value:0.36,sector:"Semis",  action:"bought"},
      {name:"Other",pct:59.9,value:13.43,sector:"Mix",   action:"hold"},
    ],
    sectors:[{name:"Passive ETFs",pct:21},{name:"Tech/Cloud",pct:15},{name:"Semis/AI",pct:10},{name:"EM/Intl",pct:12},{name:"Gold/Commodities",pct:8},{name:"Consumer",pct:10},{name:"Healthcare",pct:8},{name:"Other",pct:16}],
    recentBuys:["AVGO (+670K)","MU (+50%)","TSM (new)","GLD (added)","NVDA (added)"],
    recentSells:["CRM (exit)","WDAY (exit)","ADBE (exit)","SPY (trim)"],
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
      {name:"NTRA", pct:18.1,value:0.62,sector:"Biotech",     action:"hold"},
      {name:"ETHB", pct:8.7, value:0.30,sector:"ETF",         action:"hold"},
      {name:"INSM", pct:5.6, value:0.19,sector:"Biotech",     action:"hold"},
      {name:"TSM",  pct:5.0, value:0.17,sector:"Semis",       action:"hold"},
      {name:"EWZ",  pct:4.7, value:0.16,sector:"EM/Brazil",   action:"hold"},
      {name:"AVGO", pct:3.1, value:0.11,sector:"Semis",       action:"bought"},
      {name:"ARGT", pct:2.8, value:0.10,sector:"EM/Argentina",action:"bought"},
      {name:"SNDK", pct:2.5, value:0.09,sector:"Semis",       action:"bought"},
      {name:"HUM",  pct:2.3, value:0.08,sector:"Healthcare",  action:"bought"},
      {name:"Other",pct:47.2,value:1.61,sector:"Mix",         action:"mixed"},
    ],
    sectors:[{name:"Biotech/Health",pct:28},{name:"EM / Macro ETFs",pct:16},{name:"Semis/AI",pct:11},{name:"Consumer",pct:9},{name:"Gold/Commodities",pct:25},{name:"Other",pct:11}],
    recentBuys:["ARGT (new)","AVGO (new)","SNDK (new)","HUM (new)","RVMD (new)"],
    recentSells:["GOOGL (exit)","META (exit)","ARM (exit)","MNGODB (exit)"],
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
    thesis:"Near-destroyed in 2022 (-55%). Rebirth is more disciplined: fewer names, higher quality. Still owns AI consensus (GOOGL #1, AMZN #2). Added INTC and HOOD — contrarian bets on Intel restructuring and Robinhood crypto platform. JD.com is the China value play.",
    holdings:[
      {name:"GOOGL", pct:22.0,value:5.72,sector:"Tech",     action:"added"},
      {name:"AMZN",  pct:18.5,value:4.81,sector:"Tech",     action:"added"},
      {name:"MSFT",  pct:9.0, value:2.34,sector:"Tech",     action:"trim"},
      {name:"META",  pct:8.5, value:2.21,sector:"Tech",     action:"hold"},
      {name:"JD.com",pct:6.5, value:1.69,sector:"China/EM", action:"hold"},
      {name:"INTC",  pct:4.0, value:1.04,sector:"Semis",    action:"bought"},
      {name:"HOOD",  pct:3.5, value:0.91,sector:"Fintech",  action:"bought"},
      {name:"Other", pct:28.0,value:7.28,sector:"Mix",      action:"hold"},
    ],
    sectors:[{name:"Tech/Internet",pct:58},{name:"China/EM",pct:10},{name:"Semis",pct:8},{name:"Fintech",pct:7},{name:"Consumer",pct:8},{name:"Other",pct:9}],
    recentBuys:["GOOGL (+$750M)","INTC (new)","HOOD (new)"],
    recentSells:["MSFT (trim -$1.7B)"],
    radar:[{axis:"Value",score:30},{axis:"Growth",score:90},{axis:"Defensiveness",score:20},{axis:"AI Exposure",score:85},{axis:"International",score:40},{axis:"Income",score:15}],
  },
  {
    id:"appaloosa", name:"Appaloosa Management", manager:"David Tepper",
    aum:"$~20B", style:"Distressed / Deep value", color:"#D97706",
    turnover:"Medium–High", signal:"CHINA + CYCLICALS", signalColor:"#B45309",
    lastUpdated:"Q1 2026 · May 15",
    regimeBet:"China recovery + soft landing",
    regimeBetColor:"#D97706",
    regimeBetSignal:"BABA #1. Cyclical bets. Tepper historically right on China timing.",
    thesis:"Buy when sentiment is maximally washed out. BABA #1 at 15.6% despite trimming — massive China bet. Added SNDK for AI memory. New Wayfair = deep cyclical bet on housing recovery. Tepper historically right on China timing when everyone else gives up.",
    holdings:[
      {name:"BABA", pct:15.6,value:3.12,sector:"China/EM",    action:"trim"},
      {name:"META", pct:10.2,value:2.04,sector:"Tech",         action:"hold"},
      {name:"AMZN", pct:9.8, value:1.96,sector:"Tech",         action:"hold"},
      {name:"NVDA", pct:8.5, value:1.70,sector:"Semis",        action:"added"},
      {name:"GOOGL",pct:7.5, value:1.50,sector:"Tech",         action:"hold"},
      {name:"CRWD", pct:5.2, value:1.04,sector:"Cybersecurity",action:"hold"},
      {name:"SNDK", pct:4.0, value:0.80,sector:"Semis",        action:"added"},
      {name:"W",    pct:3.5, value:0.70,sector:"Consumer",     action:"bought"},
      {name:"Other",pct:35.7,value:7.14,sector:"Mix",          action:"mixed"},
    ],
    sectors:[{name:"Tech/Internet",pct:36},{name:"China/EM",pct:18},{name:"Semis/AI",pct:14},{name:"Cybersecurity",pct:5},{name:"Consumer/Cyclicals",pct:10},{name:"Other",pct:17}],
    recentBuys:["SNDK (AI memory)","W (Wayfair cyclical)","CoreWeave (added)"],
    recentSells:["BABA (-617K, risk mgmt)"],
    radar:[{axis:"Value",score:75},{axis:"Growth",score:60},{axis:"Defensiveness",score:35},{axis:"AI Exposure",score:65},{axis:"International",score:55},{axis:"Income",score:30}],
  },
];

const CONSENSUS_ROWS = [
  {theme:"AI Chips / Semis",            vals:["◐","◯","●","●","●","●"],note:"5/6 bullish — most crowded consensus long"},
  {theme:"Hyperscalers (AMZN/GOOG/MSFT)",vals:["●","●","●","◯","●","●"],note:"Berkshire now large GOOGL holder; Ackman owns AMZN+MSFT"},
  {theme:"Legacy SaaS",                 vals:["◯","◯","✕","◯","◯","◯"],note:"Bridgewater broadly exiting/shorting"},
  {theme:"China / EM",                  vals:["◯","◯","●","●","◐","●"],note:"Druckenmiller Brazil/Argentina, Tepper China"},
  {theme:"Gold / Commodities",          vals:["◐","◯","●","●","◯","◯"],note:"Druckenmiller 25–30%, Bridgewater adding GLD"},
  {theme:"Energy / Airlines",           vals:["●","◯","◯","◐","◯","◯"],note:"Berkshire: CVX+OXY+DAL new"},
  {theme:"Biotech / Healthcare",        vals:["◯","◯","◯","●","◯","●"],note:"Druckenmiller NTRA, Appaloosa selective"},
  {theme:"Cash / T-Bills",             vals:["●●","◯","◯","◯","◯","◯"],note:"Berkshire $397B — no one else close"},
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

// ─── SHARED HOOKS ─────────────────────────────────────────────────────────────
function useLivePrices() {
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(null);

  const fetchPrices = useCallback(async function(tickers) {
    if (!tickers || !tickers.length) return;
    setLoading(true);
    try {
      const result = await fetchTickerPrices(tickers);
      if (result && Object.keys(result).length) {
        setPrices(prev => ({ ...prev, ...result }));
        setUpdated(new Date());
      }
    } catch (e) { console.error("Price fetch error:", e); }
    setLoading(false);
  }, []);

  return { prices, loading, updated, fetchPrices };
}

function useLiveIndicators() {
  const [live, setLive] = useState(null);
  const [loading, setLoading] = useState(false);
  const [updated, setUpdated] = useState(null);
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
        setUpdated(new Date());
        setError(null);
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
function Card({ children, style }) {
  return <div style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 5px rgba(0,0,0,.05)", ...style }}>{children}</div>;
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
function PriceBadge({ ticker, prices }) {
  const p = prices[ticker];
  if (!p) return <span style={{ color: C.lbl, fontSize: 12 }}>—</span>;
  const up = p.changePercent >= 0;
  const col = up ? C.green : C.red;
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>${(p.price || 0).toFixed(2)}</span>
      <span style={{ color: col, fontWeight: 700, fontSize: 13 }}>
        {up ? "↑" : "↓"}{Math.abs(p.changePercent || 0).toFixed(2)}%
      </span>
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

// ─── FUND EDITOR MODAL ────────────────────────────────────────────────────────
function FundEditor({ fund, onSave, onCancel }) {
  const [draft, setDraft] = useState(JSON.stringify(fund, null, 2));
  const [err, setErr] = useState(null);
  function save() {
    try { onSave(JSON.parse(draft)); setErr(null); }
    catch (e) { setErr("Invalid JSON: " + e.message); }
  }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: C.surf, borderRadius: 16, padding: 20, width: "100%", maxWidth: 680, maxHeight: "90vh", overflow: "auto", boxShadow: "0 20px 60px rgba(0,0,0,.3)" }}>
        <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 4 }}>Edit Fund Data</div>
        <div style={{ color: C.muted, fontSize: 14, marginBottom: 12 }}>Edit JSON directly. Change thesis, holdings, sectors, buys/sells, lastUpdated. Auto-saves to your browser.</div>
        <textarea value={draft} onChange={e => setDraft(e.target.value)} style={{ width: "100%", height: 360, fontFamily: "monospace", fontSize: 12, padding: 12, border: "1.5px solid " + (err ? C.rBdr : C.bdr), borderRadius: 8, color: C.text, background: C.bg, resize: "vertical", boxSizing: "border-box" }} />
        {err && <div style={{ color: C.red, fontSize: 13, marginTop: 6 }}>⚠ {err}</div>}
        <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-end" }}>
          <Btn onClick={onCancel} color={C.mid} bgColor={C.bg} label="Cancel" />
          <Btn onClick={save} color="#fff" bgColor={C.blue} label="Save Changes" />
        </div>
      </div>
    </div>
  );
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

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
        <div>
          <SLabel>{ind.name}</SLabel>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontSize: 28, fontWeight: 900, letterSpacing: -1, color: ind.color }}>{current}</span>
            <Pill label={ind.label} color={statusColor} bg={statusBg} bdr={statusBdr} />
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
function AssetDetail({ asset, prices, onFetchPrices, pricesLoading, pricesUpdated }) {
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
        <div style={{ background: asset.bg, border: "1px solid " + asset.bdr, borderRadius: 8, padding: "10px 13px" }}>
          <span style={{ color: asset.color, fontWeight: 700, fontSize: 13 }}>📊 Stagflation: </span>
          <span style={{ color: asset.color, fontSize: 14 }}>{asset.stagNote}</span>
        </div>
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
            <div style={{ flexShrink: 0, width: 58 }}>
              <span style={{ background: asset.bg, color: asset.color, border: "1.5px solid " + asset.bdr, borderRadius: 6, padding: "3px 6px", fontSize: 13, fontWeight: 800, display: "block", textAlign: "center" }}>{tk.t}</span>
              <span style={{ color: C.lbl, fontSize: 11, display: "block", textAlign: "center", marginTop: 2 }}>{tk.type}</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                <span style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>{tk.name}</span>
                <PriceBadge ticker={tk.t} prices={prices} />
              </div>
              <div style={{ color: C.muted, fontSize: 14, marginTop: 3, lineHeight: 1.6 }}>{tk.note}</div>
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ─── FUND DETAIL ──────────────────────────────────────────────────────────────
function FundDetail({ fund, prices, onFetchPrices, pricesLoading, pricesUpdated, editMode, onEdit }) {
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
            {editMode && <Btn onClick={onEdit} color={C.amber} bgColor={C.aBg} label="✏️ Edit" />}
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
        <ResponsiveContainer width="100%" height={155}>
          <BarChart data={fund.holdings} layout="vertical" margin={{ left: 4, right: 16, top: 0, bottom: 0 }}>
            <XAxis type="number" tick={{ fill: C.lbl, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v + "%"} />
            <YAxis type="category" dataKey="name" tick={{ fill: C.mid, fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false} width={50} />
            <Tooltip formatter={v => [v + "%", "% of Portfolio"]} contentStyle={{ background: "#fff", border: "1px solid " + C.bdr, borderRadius: 8, fontSize: 13 }} />
            <Bar dataKey="pct" radius={[0, 5, 5, 0]}>
              {fund.holdings.map((h, i) => (
                <Cell key={i} fill={h.action === "bought" ? "#166534" : h.action === "added" ? "#22C55E" : h.action === "trim" ? "#D97706" : h.action === "exit" ? "#DC2626" : fund.color} opacity={0.85} />
              ))}
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

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]           = useState("macro");
  const [activeAsset, setActiveAsset]   = useState(ASSETS[0]);
  const [activeIncome, setActiveIncome] = useState(INCOME_PLAYS[0]);
  const [activeRegime, setActiveRegime] = useState(REGIMES[0]);
  const [funds, setFunds]       = useState(DEFAULT_FUNDS);
  const [selectedFund, setSelectedFund] = useState(DEFAULT_FUNDS[0]);
  const [editMode, setEditMode] = useState(false);
  const [editingFund, setEditingFund]   = useState(null);
  const [addingFund, setAddingFund]     = useState(false);

  const { prices, loading: pricesLoading, updated: pricesUpdated, fetchPrices } = useLivePrices();
  const { live: liveInd, loading: indLoading, updated: indUpdated, error: indError, fetchIndicators } = useLiveIndicators();

  useEffect(function() {
    loadFunds().then(function(saved) {
      if (saved) { setFunds(saved); setSelectedFund(saved[0]); }
    });
  }, []);

  function updateFunds(newFunds) {
    setFunds(newFunds);
    persistFunds(newFunds);
  }
  function handleSaveFund(updated) {
    const newFunds = addingFund ? [...funds, updated] : funds.map(f => f.id === updated.id ? updated : f);
    updateFunds(newFunds);
    setSelectedFund(updated);
    setEditingFund(null);
    setAddingFund(false);
  }
  function handleDeleteFund(id) {
    if (!confirm("Delete this fund?")) return;
    const newFunds = funds.filter(f => f.id !== id);
    updateFunds(newFunds);
    if (selectedFund.id === id && newFunds.length) setSelectedFund(newFunds[0]);
  }

  const blankFund = { id: "fund_" + Date.now(), name: "New Fund", manager: "Manager Name", aum: "$0B", style: "Strategy", color: "#1E40AF", turnover: "Medium", signal: "NEUTRAL", signalColor: "#6B7280", lastUpdated: "Q? 202?", regimeBet: "Unknown", regimeBetColor: "#6B7280", regimeBetSignal: "Edit this fund to set the implied macro regime bet.", thesis: "Fund thesis here.", holdings: [{ name: "TICK", pct: 100, value: 0, sector: "Sector", action: "hold" }], sectors: [{ name: "Sector", pct: 100 }], recentBuys: [], recentSells: [], radar: [{ axis: "Value", score: 50 }, { axis: "Growth", score: 50 }, { axis: "Defensiveness", score: 50 }, { axis: "AI Exposure", score: 50 }, { axis: "International", score: 50 }, { axis: "Income", score: 50 }] };

  const fmtTime = d => d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";

  const TABS = [
    { id: "macro",      label: "🌐 Macro"        },
    { id: "smartmoney", label: "🏦 Smart Money"  },
    { id: "indicators", label: "📡 Indicators"  },
    { id: "insurance",  label: "🛡️ Insurance"   },
    { id: "income",     label: "💰 Income"       },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", width: "100%", color: C.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {(editingFund || addingFund) && (
        <FundEditor
          fund={addingFund ? blankFund : editingFund}
          onSave={handleSaveFund}
          onCancel={function() { setEditingFund(null); setAddingFund(false); }}
        />
      )}

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
                  const tickers = ["AAPL","AXP","KO","BAC","CVX","OXY","GOOGL","DAL","BN","AMZN","UBER","MSFT","SPY","NVDA","AVGO","MU","TSM","NTRA","EWZ","ARGT","BABA","META","CRWD","GDX","XLP","TLT","EPD","O","JEPI","BIL"];
                  fetchPrices(tickers);
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
                  action:"Raise Cash. Reduce Risk Exposure.",
                  bullets:["🚨 Credit spreads have breached the 4.5% threshold — primary deflationary signal confirmed.",
                           "🏛️ Rotate to long Treasuries (TLT/IEF) and cash (BIL). Capital preservation first.",
                           "⛏️ Hold gold miners — they can still perform in early recession phases."] },
                ALERT:   { g1:"#92400E", g2:"#B45309", shadow:"rgba(146,64,14,0.35)",
                  action:"Position Defensively. Tighten Stops.",
                  bullets:["⚠️ Indicators approaching alert thresholds — credit spreads or unemployment near critical levels.",
                           "🛡️ Increase insurance allocation: gold miners, consumer staples, short-duration T-bills.",
                           "💵 Reduce leverage and extend cash runway. Wait for credit spreads to confirm direction."] },
                WATCH:   { g1:"#334155", g2:"#1E293B", shadow:"rgba(30,41,59,0.35)",
                  action:"Accumulate Insurance. Don't Chase Yield.",
                  bullets:[`📡 Credit spreads at ${liveInd ? liveInd.creditSpread.toFixed(2) : "2.75"}% — ${liveInd && liveInd.creditSpread >= 3.5 ? "widening toward alert zone. Build insurance now." : "benign. Markets not pricing stress yet. This is your trip wire."}`,
                           "🛡️ Gold miners + consumer staples: appropriate to build positions now at current prices.",
                           "💵 Berkshire's playbook: $397B in T-bills at 4.2% while waiting. Optionality > yield."] },
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

        {/* ── INSURANCE ── */}
        {tab === "insurance" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Regime-aware header banner */}
            {(() => {
              const rankKey = { stag: "stagRank", def: "defRank", ref: "refRank", inf: "infRank" }[activeRegime.id] || "stagRank";
              const sorted = [...ASSETS].sort((a, b) => (a[rankKey] || 9) - (b[rankKey] || 9));
              return (
                <div style={{ background: activeRegime.bg, border: "1.5px solid " + activeRegime.bdr, borderRadius: 14, padding: "14px 18px", borderTop: "4px solid " + activeRegime.color }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: 2.5, textTransform: "uppercase", color: activeRegime.color, fontWeight: 700, marginBottom: 3 }}>Active Regime</div>
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
                    <AssetDetail asset={activeAsset} prices={prices} onFetchPrices={fetchPrices} pricesLoading={pricesLoading} pricesUpdated={pricesUpdated} />
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
                          <div style={{ flexShrink: 0, width: 58 }}>
                            <span style={{ background: activeIncome.bg, color: activeIncome.color, border: "1.5px solid " + activeIncome.color + "40", borderRadius: 6, padding: "3px 6px", fontSize: 13, fontWeight: 800, display: "block", textAlign: "center" }}>{tk.t}</span>
                            <span style={{ background: C.gBg, color: C.green, border: "1px solid " + C.gBdr, borderRadius: 4, padding: "1px 5px", fontSize: 11, fontWeight: 700, display: "block", textAlign: "center", marginTop: 3 }}>{tk.yield}</span>
                          </div>
                          <div style={{ flex: 1 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                              <span style={{ color: C.text, fontWeight: 700, fontSize: 15 }}>{tk.name}</span>
                              <PriceBadge ticker={tk.t} prices={prices} />
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
          </div>
        )}

        {/* ── SMART MONEY ── */}
        {tab === "smartmoney" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Toolbar */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn onClick={() => setEditMode(em => !em)} color={editMode ? C.amber : C.muted} bgColor={editMode ? C.aBg : C.bg} label={editMode ? "✏️ Edit Mode ON" : "✏️ Edit Mode OFF"} />
                {editMode && <Btn onClick={() => setAddingFund(true)} color={C.green} bgColor={C.gBg} label="+ Add Fund" />}
                {editMode && <Btn onClick={function() { if (confirm("Reset all funds to defaults?")) { updateFunds(DEFAULT_FUNDS); setSelectedFund(DEFAULT_FUNDS[0]); } }} color={C.red} bgColor={C.rBg} label="↺ Reset" />}
              </div>
              {editMode && <span style={{ color: C.amber, fontSize: 13 }}>Changes auto-saved to browser.</span>}
            </div>

            {/* Fund selector — horizontal scroll */}
            <div style={{ display: "flex", gap: 8, overflowX: "auto", WebkitOverflowScrolling: "touch", paddingBottom: 6, scrollbarWidth: "none" }}>
              {funds.map(f => (
                <div key={f.id} style={{ position: "relative", flexShrink: 0 }}>
                  <button onClick={() => { setSelectedFund(f); if (editMode) setEditingFund(f); }} style={{
                    background: selectedFund.id === f.id ? f.color + "12" : C.surf,
                    border: "1.5px solid " + (selectedFund.id === f.id ? f.color : C.bdr),
                    borderLeft: "4px solid " + f.color,
                    borderRadius: 10, padding: "12px 13px", textAlign: "left", cursor: "pointer",
                    width: 170, flexShrink: 0,
                  }}>
                    <div style={{ color: f.color, fontWeight: 800, fontSize: 13, lineHeight: 1.3, marginBottom: 3 }}>{f.name}</div>
                    <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.3, marginBottom: 8 }}>{f.manager}</div>
                    <div style={{ background: f.signalColor + "15", color: f.signalColor, border: "1.5px solid " + f.signalColor + "40", borderRadius: 6, padding: "3px 7px", fontSize: 11, fontWeight: 800, lineHeight: 1.4, display: "inline-block", maxWidth: "100%", wordBreak: "break-word" }}>{f.signal}</div>
                    {f.lastUpdated && <div style={{ color: C.lbl, fontSize: 10, marginTop: 6 }}>{f.lastUpdated}</div>}
                  </button>
                  {editMode && (
                    <button onClick={e => { e.stopPropagation(); handleDeleteFund(f.id); }} style={{ position: "absolute", top: 5, right: 5, background: C.rBg, color: C.red, border: "none", borderRadius: 4, width: 18, height: 18, fontSize: 12, cursor: "pointer" }}>×</button>
                  )}
                </div>
              ))}
            </div>

            <FundDetail
              fund={selectedFund}
              prices={prices}
              onFetchPrices={fetchPrices}
              pricesLoading={pricesLoading}
              pricesUpdated={pricesUpdated}
              editMode={editMode}
              onEdit={() => setEditingFund(selectedFund)}
            />

            {/* Consensus matrix */}
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
          </div>
        )}

        {/* ── MACRO ── */}
        {tab === "macro" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Card>
              <SLabel>Regime Probability — Analyst Consensus (Mid-2026)</SLabel>
              <div className="mwd-regime-grid" style={{ marginBottom: 14 }}>
                {REGIMES.map(r => (
                  <button key={r.id} onClick={() => setActiveRegime(r)} style={{ background: activeRegime.id === r.id ? r.bg : C.surf, border: "1.5px solid " + (activeRegime.id === r.id ? r.color : C.bdr), borderTop: "4px solid " + r.color, borderRadius: 10, padding: "12px 14px", cursor: "pointer", textAlign: "left", width: "100%" }}>
                    <div style={{ fontSize: 22, fontWeight: 900, color: r.color }}>{r.prob}%</div>
                    <div style={{ color: r.color, fontWeight: 700, fontSize: 13, marginTop: 3, lineHeight: 1.3 }}>{r.label}</div>
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", height: 12, borderRadius: 6, overflow: "hidden", border: "1px solid " + C.bdr }}>
                {REGIMES.map(r => (
                  <div key={r.id} style={{ width: r.prob + "%", background: r.color, fontSize: 10, color: "#fff", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }} title={r.label}>{r.prob}%</div>
                ))}
              </div>
            </Card>

            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              <Card style={{ flex: "1 1 240px", background: activeRegime.bg, border: "1.5px solid " + activeRegime.bdr, borderTop: "4px solid " + activeRegime.color }}>
                <div style={{ fontSize: 18, fontWeight: 900, color: activeRegime.color, marginBottom: 8 }}>{activeRegime.label}</div>
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
                    prob: "35% most likely", color: C.blue,
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
                    prob: "30% next likely", color: C.green,
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
                      return oil < 80
                        ? `✅ WTI crude at $${oil.toFixed(1)} — below the $80 reflationary trigger. Oil has fallen enough for the Fed to consider cutting. Watch for a Fed pivot signal next.`
                        : `⚠️ WTI crude at $${oil.toFixed(1)} ${oilDir} — above the $80 threshold. Until oil falls below $80, inflation stays too sticky for the Fed to cut with confidence. A Gulf peace deal or OPEC production increase is the key trigger.`;
                    })(),
                  },
                  {
                    label: "Persistent Stagflation (1970s path)",
                    prob: "25% painful", color: C.amber,
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
                    prob: "5% — Dalio scenario", color: "#7C3AED",
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

            <Card>
              <SLabel>Wall Street Recession Probability (Mar–Jun 2026)</SLabel>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 400 }}>
                  <thead>
                    <tr style={{ background: C.bg }}>
                      {["Institution", "Probability", "Driver", "Date"].map(h => (
                        <th key={h} style={{ textAlign: "left", color: C.mid, padding: "8px 12px", borderBottom: "2px solid " + C.bdr, fontSize: 13, fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["Moody's Analytics","49%","Oil shock + consumer stress","Mar 25, 2026"],
                      ["EY Parthenon","40%","Stagflation risk, tight policy","Mar 24, 2026"],
                      ["HSBC","35%","Credit spreads, yield curve","Mar 25, 2026"],
                      ["Goldman Sachs","30%","Oil-driven inflation, tariff drag","Mar 25, 2026"],
                      ["RSM US","30%","Eased from 40% — services resilient","Jun 2026"],
                      ["JP Morgan","Elevated","Gulf conflict threatens recovery","Mar 2026"],
                    ].map((r, i) => (
                      <tr key={i} style={{ background: i % 2 === 0 ? C.surf : C.bg }}>
                        <td style={{ padding: "8px 12px", color: C.text, fontSize: 14, fontWeight: 600, borderBottom: "1px solid " + C.bdr }}>{r[0]}</td>
                        <td style={{ padding: "8px 12px", borderBottom: "1px solid " + C.bdr }}>
                          <span style={{ color: parseInt(r[1]) > 40 ? C.red : parseInt(r[1]) > 30 ? C.amber : C.green, fontWeight: 800, fontSize: 15 }}>{r[1]}</span>
                        </td>
                        <td style={{ padding: "8px 12px", color: C.muted, fontSize: 13, borderBottom: "1px solid " + C.bdr }}>{r[2]}</td>
                        <td style={{ padding: "8px 12px", color: C.lbl, fontSize: 12, borderBottom: "1px solid " + C.bdr }}>{r[3]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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