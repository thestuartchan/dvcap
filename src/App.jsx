import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import { C, P, alpha, THEMES, DEFAULT_THEME, THEME_KEY } from "./theme.js";
import { SLabel, Card, Btn, Pill, HandKept, TabErrorBoundary } from "./ui.jsx";
import { cacheLoad, cacheSave } from "./cache.js";
import { InterventionToggle, FedPathCard, UsfrSecYieldForm, IsmEntryPanel } from "./pages/editors.jsx";
import { liveCashYield, fillLiveRates } from "./pages/cash.js";
import { INS_RANK_KEY, INCOME_RANK_KEY, rankKeyFor, byRank } from "./pages/ranking.js";
import { PriceBadge } from "./pages/PriceBadge.jsx";
import { GlobalPlaybook, SouthboundPanel, KoreaManualEntry } from "./pages/TodayPage.jsx";
import { PB_REGIONS } from "./pages/regions.js";
import { ASSETS } from "../lib/assets.js";
import { REGIMES, REGIME_PALETTE } from "../lib/regimes.js";
import { GoBar, GoKey } from "./GoBar.jsx";
import { PAGES, VIEWS, pageOf } from "./pages/nav.js";
import { BarChart, Bar, RadarChart, PolarGrid, PolarAngleAxis, Radar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, LabelList } from "recharts";
import { pendingReconciliations, reconStats } from "../lib/recon.js";
import {  } from "../lib/regimeProb.js";

import { STATUS, BAND_STATUS, creditStatus } from "../lib/status.js";
import { HORIZON, HORIZON_LABEL, dispersionRead, NO_CONVERSION_NOTE } from "../lib/recession.js";
import { buildViews, evaluateViews, regimeCluster, divergenceRead } from "../lib/analystViews.js";
import { computeMarketState, stateLogRow } from "../lib/marketState.js";
import { StateView, StreetCompare, Fold } from "./MarketState.jsx";
import { useJobHealth, jobHealthNote } from "./jobHealth.js";
import { expectedRank } from "../lib/plan.js";

import { measuredAxes, axesLogRow } from "../lib/quadrant.js";
import { handKeptLedger } from "../lib/ledger.js";
import { newerKofia } from "../lib/handEntry.js";
import CALENDAR from "../data/calendar.json";
import { FED_LANGUAGE_STATUS } from "../lib/fedLanguage.js";
import { RECESSION_SOURCES, recessionAsOfState, parseProbability, recessionSrcKey, mergeRecessionSources, CONSENSUS_VINTAGE, FALLBACK_REGIMES, regimeSnapshot, regimeLogRow, RECESSION_SOURCE_CADENCE, ANNOUNCED_PRINTS, LABOR_ANNOUNCED } from "../lib/regimeEngine.js";

import { nextMeetingOdds } from "../lib/fedpath.js";
import HOLIDAYS from "../data/holidays.json";
import { SEC_YIELDS } from "../lib/cashyield.js";
import { COMPANY_NAMES } from '../lib/companyNames.js';  // one map, shared with the trade console
import { dubaiEt, dubaiEtStamp } from "../lib/timeFmt.js";

// A page's own panel loads when the page opens, not with the dashboard: Today paints without the
// Console's or Gamma's code. Each is its own chunk; the Suspense fallback sits inside the tab's
// error boundary, so a chunk that fails to load shows that tab's error, not a blank page.
const named = (load, name) => lazy(() => load().then(m => ({ default: m[name] })));
const TradeConsole  = named(() => import("./TradeConsole.jsx"), "TradeConsole");
const GexPanel      = named(() => import("./GexPanel.jsx"), "GexPanel");
const RatiosPanel   = named(() => import("./RatiosPanel.jsx"), "RatiosPanel");
const CalendarPanel = named(() => import("./CalendarPanel.jsx"), "CalendarPanel");
const TickerPanel   = named(() => import("./TickerPanel.jsx"), "TickerPanel");
const MlsPanel      = named(() => import("./MlsPanel.jsx"), "MlsPanel");
const PlanView      = named(() => import("./PlanView.jsx"), "PlanView");
const OpsPage       = named(() => import("./pages/OpsPage.jsx"), "OpsPage");
const DriversPage   = named(() => import("./pages/MarketsPage.jsx"), "DriversPage");
const HedgesView    = named(() => import("./pages/RiskPage.jsx"), "HedgesView");
const IncomeView    = named(() => import("./pages/RiskPage.jsx"), "IncomeView");

// ─── TOKENS ──────────────────────────────────────────────────────────────────
const SC = [C.blue,C.green,P.amber600,P.violet700,P.amber700,P.pink700,P.teal700,P.amber500];












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
    cash:            { range: "50–60%", status: "HOLD",       note: "Preserve optionality. Real yield eroding in real terms but cash dominates over equity drawdowns. Hold USFR — floating rate resets weekly, so it earns {{CASH}} now and more if the Fed keeps tightening. Do not rotate out of USFR until a Fed pivot is confirmed. Bank AED expenses only." },
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
  HOLD:       { color:P.gray500, bg:C.inset, bdr:P.gray200 },
  PREPARE:    { color:C.blue, bg:C.blBg, bdr:C.blBdr },
  WATCH:      { state:"WATCH" },
  ACTIVATE:   { state:"BENIGN" },
  ACCUMULATE: { state:"BENIGN" },
  DEPLOY:     { state:"BENIGN" },
  SELECTIVE:  { state:"WATCH" },
  REDUCE:     { color:P.amber700, bg:C.oBg, bdr:P.orange200 },
  PAUSE:      { state:"DANGER" },
};
// A status resolved to its colours. Half the table names a STATUS token rather than colours, and
// reading `.color` off those gave undefined — the Activate / Accumulate / Pause cards drew no accent.
const postureTone = (s) => { const x = POSTURE_STATUS[s] || POSTURE_STATUS.HOLD; return x.state ? STATUS[x.state] : x; };

// ─── INCOME PLAYS ─────────────────────────────────────────────────────────────
const INCOME_PLAYS = [
  {
    rank:1, defRank:5, refRank:5, infRank:1, category:"Energy Pipelines / MLPs", icon:"🛢️", yieldRange:"5–9%", stagProof:true,
    color:P.amber700, bg:C.aBg,
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
    color:C.blue, bg:C.blBg,
    why:"Tenants pay taxes, insurance, maintenance. Landlord gets pure rental income insulated from rising costs. Long-term leases = predictable cash flows. Monthly payers available.",
    globalNote:"Accessible via IBKR from all your family jurisdictions. 30% US withholding for non-US (15% for Canada under treaty, 30% for HK unless treaty applies).",
    risks:"Rate sensitivity — REIT prices fall when rates rise. Commercial real estate weakens in severe recessions.",
    tickers:[
      {t:"O",    name:"Realty Income",   yield:"5.8%", note:"667 consecutive monthly dividends since 1969. Gold standard."},
      {t:"NNN",  name:"NNN REIT",        yield:"5.7%", note:"35yr dividend increases. 3,500+ retail properties."},
      {t:"WPC",  name:"W.P. Carey",      yield:"5.9%", note:"Industrial + retail + office. International exposure."},
      {t:"STAG", name:"STAG Industrial", yield:"4.3%", note:"Industrial/logistics. Monthly dividend."},
      {t:"EMAAR.AE", name:"Emaar Properties (DFM)", yield:"7.0%", note:"~7% dividend yield. Dominant Dubai developer. Tied to UAE premium property demand. Zero UAE tax. Priced live as EMAAR.AE (Yahoo, DFM).", link:"https://www.dfm.ae"},
    ],
  },
  {
    rank:3, defRank:2, refRank:2, infRank:4, category:"Dividend Aristocrats", icon:"👑", yieldRange:"2.5–5%", stagProof:true,
    color:P.violet800, bg:P.violet50,
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
      {t:"DEWA.AE", name:"DEWA (DFM)",                  yield:"4.5%", note:"Utility · Dubai electricity/water monopoly. ~4-5% yield. Regime-agnostic defensive income. Zero UAE tax. Priced live as DEWA.AE (Yahoo, DFM).", link:"https://www.dfm.ae"},
      {t:"0005.HK", name:"HSBC Holdings (HKEX)",        yield:"6.5%", note:"Financials · ~6-7% yield. Global bank, Asia-focused. Consistent dividends. Zero HK withholding tax.", link:"https://www.hkex.com.hk"},
      {t:"FAB.AE", name:"First Abu Dhabi Bank (ADX)",   yield:"5.5%", note:"Financials · UAE's largest bank. ~5-6% yield. USD-pegged income. Zero UAE tax. Check ADX for price.", link:"https://www.adx.ae"},
      {t:"1299.HK", name:"AIA Group (HKEX)",            yield:"2.0%", note:"Financials · Pan-Asian life insurer. ~2% yield but strong dividend growth. Growing Asian middle class tailwind. Zero HK withholding tax.", link:"https://www.hkex.com.hk"},
      {t:"3070.HK", name:"Hang Seng China High Div ETF", yield:"6.0%", note:"Financials/ETF · Broad HK/China high-dividend exposure. ~5-7% yield. Alternative to individual H-shares. Zero HK withholding tax.", link:"https://www.hkex.com.hk"},
    ],
  },
  {
    rank:4, defRank:6, refRank:3, infRank:2, category:"Covered Call ETFs", icon:"📈", yieldRange:"7–12%", stagProof:false,
    color:C.green, bg:C.gBg,
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
    color:P.teal700, bg:P.teal50,
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
    color:P.gray700, bg:C.inset,
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
    aum:"$323.8B equity (Q2 13F) · $365.5B cash (Q2 10-Q, Aug 8)", style:"Quality compounder / Value", color:C.blue,
    turnover:"Low–Medium", signal:"NET BUYER", signalColor:C.green,
    lastUpdated:"Q2 2026 · as of Jun 30 · cash Q2 10-Q Aug 8",
    regimeBet:"Deploying — net buyer (first cash drawdown in ~4yr)",
    regimeBetColor:C.green,
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
    aum:"$19.5B (Q2 13F, via Pershing Square Inc.)", style:"Concentrated activist", color:P.violet700,
    turnover:"Medium", signal:"QUALITY COMPOUNDERS", signalColor:C.blue,
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"Quality compounding / soft landing",
    regimeBetColor:P.violet700,
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
    aum:"$24.4B (13F) · $92B total", style:"Global macro / Risk parity", color:C.green,
    turnover:"High (~40%)", signal:"AI CHIPS + GOLD", signalColor:C.amber,
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"Stagflation + normalization",
    regimeBetColor:C.amber,
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
    aum:"$5.2B (13F)", style:"Global macro / Top-down rotator", color:P.amber700,
    turnover:"Very High (38–43%)", signal:"EM + COMMODITIES", signalColor:P.violet700,
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"Stagflation / supercycle",
    regimeBetColor:P.amber700,
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
    aum:"$24B", style:"Global tech / Growth", color:P.pink700,
    turnover:"High", signal:"TECH BULL", signalColor:C.green,
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"Reflationary recovery",
    regimeBetColor:C.green,
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
    aum:"$~20B", style:"Distressed / Deep value", color:P.amber600,
    turnover:"Medium–High", signal:"CHINA + CYCLICALS", signalColor:P.amber700,
    lastUpdated:"Q2 2026 · as of Jun 30",
    regimeBet:"China recovery + soft landing",
    regimeBetColor:P.amber600,
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
    aum:"~$75B (insurance + investment portfolio)", style:"Value / Insurance Float", color:P.yellow700,
    turnover:"Low (buy & hold)", signal:"MACRO HEDGE + INDIA", signalColor:P.amber700,
    lastUpdated:"⚠ Annual Report 2025 · not a US 13F filer — H1 2026 interim not fetched this run",
    regimeBet:"INFLATION + DEFLATION HEDGE",
    regimeBetColor:P.amber700,
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
  "13F":     { label: "13F",              col: C.blue },
  "13F+mgr": { label: "13F + disclosure", col: P.violet700 },
  "10-Q":    { label: "10-Q",             col: P.teal700 },
  "Manager disclosure": { label: "Mgr disclosure", col: P.amber700 },
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
  Most:    { col: C.green, bg: C.gBg, bdr: C.gBdr },
  Partial: { col: P.amber700, bg: C.oBg, bdr: P.orange200 },
  Low:     { col: P.amber700, bg: C.oBg, bdr: P.orange200 },
  None:    { col: C.red, bg: C.rBg, bdr: P.red200 },
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






















// ─── ANNOUNCED PRINTS (published, but not yet in FRED) ────────────────────────
// BEA/BLS release ahead of FRED's ingest, so on release day the live series still shows the
// PRIOR period. Rather than hardcode a number over a live field (which would fabricate a
// "FRED" value) or show a stale figure as current (which would misread the trend), announced
// prints live here with their source and release date, render as an explicitly-labelled
// overlay, and AUTO-RETIRE the moment FRED's own asOf reaches the same period.


// Section A — the consensus inputs are a VINTAGE, not a live feed. The refresh was deliberately
// deferred pending two releases, but the engine keeps producing live-looking output in the
// meantime, so the vintage is stamped on the regime block itself rather than only in the table
// below it. The age and the deferral are DERIVED (lib/recession.js::consensusVintage) — both were
// hardcoded prose, so the age could not tick and the deferral could not expire.

// ─── WALL STREET RECESSION PROBABILITY ────────────────────────────────────────
// Manually-updated source table. `color` drives the probability cell colour; `year` and `name` are
// used by the regime-probability derivation.
//
// THESE NUMBERS ARE FALLBACKS, NOT THE DISPLAY. mergeRecessionSources overlays api/indicators'
// recessionFeeds on top of them, so every row with a live feed — both Kalshi contracts, Polymarket,
// and the NY Fed yield-curve model — shows today's value and not what is written here. What is
// written here is what the board falls back to when a feed fails, which is the only reason it has
// to be right.
//
// It had drifted badly. Refreshed 2026-09-07 against the live feed the board itself serves:
// Kalshi 2026 22 -> 5, Kalshi 2027 41 -> 25, Polymarket 12.5 -> 7. A failed feed would have shown
// a 22% recession probability against a market pricing 5%, which is a worse failure than a blank.
//
// The RESEARCH-HOUSE rows below have no feed and are updated by hand. Checked 2026-09-07; what
// changed is recorded in each note. A number goes in here only from a source that was actually
// read — a search-engine summary of a house's view is not one, which is why two rows below say
// "unverified" rather than carrying a plausible figure.

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

  const inp = { padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6, background: C.surf, color: C.text };
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
          style={{ background: C.blue, color: C.onFill, border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12.5, fontWeight: 800, cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1 }}>
          {saving ? "Saving…" : "Save override"}
        </button>
        {current && (
          <button onClick={() => save(true)} disabled={saving}
            style={{ background: C.surf, color: C.mid, border: "1.5px solid " + C.bdrMd, borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: saving ? "wait" : "pointer" }}>
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
// ── THE THEME ────────────────────────────────────────────────────────────────
// Three palettes, one attribute. The choice lives on <html data-theme> (index.html sets it from
// storage before the first paint, so there is no flash) and in localStorage under THEME_KEY;
// this hook is the header toggle's view of both. "soft" is the default and needs no attribute.
// Setting the attribute is the whole mechanism: the tokens in src/index.css resolve differently
// and nothing re-renders for it.
function useTheme() {
  const [theme, setThemeState] = useState(() => {
    try { const t = localStorage.getItem(THEME_KEY); return THEMES.includes(t) ? t : DEFAULT_THEME; }
    catch (_) { return DEFAULT_THEME; }
  });
  useEffect(() => {
    if (theme === DEFAULT_THEME) document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  const setTheme = (t) => {
    if (!THEMES.includes(t)) return;
    setThemeState(t);
    try { localStorage.setItem(THEME_KEY, t); } catch (_) { /* storage refused — the choice holds for this page and resets on reload */ }
  };
  return [theme, setTheme];
}

// Light · Soft · Dark, as one control. The three are a segmented pill rather than a cycling
// button because the reader should be able to see what the other choices ARE — a single button
// that says "Dark" leaves you guessing whether it names the current state or the next one.
function ThemeToggle({ theme, setTheme }) {
  const names = { light: "Light", soft: "Soft", dark: "Dark" };
  return (
    <div role="radiogroup" aria-label="Colour theme" title="Light is the palette the dashboard had before; Soft is the same a notch lower in contrast; Dark is the same on a dark ground."
         style={{ display: "inline-flex", border: "1.5px solid " + C.bdr, borderRadius: 999, padding: 2, background: C.inset, gap: 2 }}>
      {THEMES.map(t => {
        const on = t === theme;
        return (
          <button key={t} role="radio" aria-checked={on} onClick={() => setTheme(t)}
                  style={{ border: "none", borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 700, cursor: on ? "default" : "pointer",
                           background: on ? C.surf : "transparent", color: on ? C.text : C.muted,
                           boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>
            {names[t]}
          </button>
        );
      })}
    </div>
  );
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
        try { localStorage.setItem("cache_prices_updated_v1", now.toISOString()); } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
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
        try { localStorage.setItem("cache_indicators_updated_v1", now.toISOString()); } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
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
  // PER REGION (P8): the three regions are fetched separately, so each keeps its own fetch time
  // and its own error. One shared stamp was whatever region finished last, and one error was
  // whichever failed last — neither said which region it was about.
  const [updatedBy, setUpdatedBy] = useState(() => cacheLoad("cache_playbook_updated_v2", {}));
  const [errorBy, setErrorBy] = useState({});
  const [pending, setPending] = useState(0);

  const fetchRegion = useCallback(async function(region) {
    setPending(n => n + 1);
    setErrorBy(prev => ({ ...prev, [region]: null }));
    try {
      const data = await fetchPlaybook(region);
      if (data && data.region) {
        setByRegion(prev => {
          const merged = { ...prev, [region]: data };
          cacheSave("cache_playbook_v2", merged);
          return merged;
        });
        setUpdatedBy(prev => {
          const next = { ...prev, [region]: new Date().toISOString() };
          cacheSave("cache_playbook_updated_v2", next);
          return next;
        });
      } else {
        setErrorBy(prev => ({ ...prev, [region]: "Playbook returned no data." }));
      }
    } catch (e) {
      console.error("Playbook fetch error:", e);
      setErrorBy(prev => ({ ...prev, [region]: "Fetch error: " + e.message }));
    }
    setPending(n => Math.max(0, n - 1));
  }, []);

  return { byRegion, loading: pending > 0, updatedBy, errorBy, fetchRegion };
}

async function loadFunds() {
  try {
    const r = await window.storage.get("funds_v4");
    if (r && r.value) {
      const p = JSON.parse(r.value);
      if (Array.isArray(p) && p.length) return p;
    }
  } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
  return null;
}

async function persistFunds(funds) {
  try { await window.storage.set("funds_v4", JSON.stringify(funds)); } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
}

function ActionBadge({ action }) {
  const M = { bought:[C.green,C.gBg,"NEW BUY"], added:[C.green,C.gBg,"ADDED"], hold:[P.gray500,C.inset,"HOLD"], trim:[P.amber700,C.aBg,"TRIM"], exit:[C.red,C.rBg,"EXIT"], "+50%":[C.green,C.gBg,"+50%"], mixed:[P.gray500,C.inset,"MIX"] };
  const [fg, bg, lbl] = M[action] || [P.gray500, C.inset, action];
  return <span style={{ background: bg, color: fg, border: "1px solid " + alpha(fg, 0x33), borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>{lbl}</span>;
}




// ─── FUND DETAIL ──────────────────────────────────────────────────────────────
function FundDetail({ fund, prices, onFetchPrices, pricesLoading, pricesUpdated }) {
  const fmtTime = d => (d ? dubaiEt(d) : "");
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
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={38} outerRadius={64} dataKey="value" stroke={C.surf} strokeWidth={2}>
                {pieData.map((_, i) => <Cell key={i} fill={SC[i % SC.length]} />)}
              </Pie>
              <Tooltip content={function({ active, payload }) {
                if (!active || !payload || !payload.length) return null;
                return <div style={{ background: C.surf, border: "1px solid " + C.bdr, borderRadius: 8, padding: "8px 12px" }}>
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
            <Btn onClick={() => onFetchPrices(tickers)} disabled={pricesLoading} color={C.onFill} bgColor={C.green} label={pricesLoading ? "Loading…" : "🔄 Prices"} />
          </div>
        </div>
        <ResponsiveContainer width="100%" height={Math.max(200, fund.holdings.length * 28)}>
          <BarChart data={fund.holdings} layout="vertical" margin={{ left: 4, right: 44, top: 0, bottom: 0 }}>
            <XAxis type="number" domain={[0, dataMax => Math.ceil(dataMax * 1.08)]} tick={{ fill: C.lbl, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={v => v + "%"} />
            <YAxis type="category" dataKey="name" interval={0} tick={{ fill: C.mid, fontSize: 11, fontWeight: 600 }} axisLine={false} tickLine={false} width={64} />
            <Tooltip formatter={v => [v + "%", "% of Portfolio"]} contentStyle={{ background: C.surf, border: "1px solid " + C.bdr, borderRadius: 8, fontSize: 13 }} />
            <Bar dataKey="pct" radius={[0, 5, 5, 0]}>
              {fund.holdings.map((h, i) => (
                <Cell key={i} fill={h.action === "bought" ? C.green : h.action === "added" ? P.green500 : h.action === "trim" ? P.amber600 : h.action === "exit" ? P.red600 : fund.color} opacity={0.85} />
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
          <SLabel color={C.green}>{MATRIX_13F.label} Key Buys</SLabel>
          {fund.recentBuys.map((b, i) => (
            <div key={i} style={{ color: C.green, fontSize: 14, padding: "4px 0", borderBottom: i < fund.recentBuys.length - 1 ? "1px solid " + C.gBdr : "none" }}>↑ {b}</div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 160, background: P.mOrange50, border: "1.5px solid " + P.mOrange200, borderRadius: 10, padding: "12px 14px" }}>
          <SLabel color={C.amber}>{MATRIX_13F.label} Key Sells</SLabel>
          {fund.recentSells.map((s, i) => (
            <div key={i} style={{ color: C.amber, fontSize: 14, padding: "4px 0", borderBottom: i < fund.recentSells.length - 1 ? "1px solid " + P.mOrange100 : "none" }}>↓ {s}</div>
          ))}
        </div>
      </div>
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
        {/* Provenance — every view names where it came from and when, same discipline as the
            numeric rows. A view read off a secondary summary says so. */}
        {v.needsReview && <div style={{ marginTop: 4, fontSize: 11, fontWeight: 700, color: C.amber }}>⚠ {v.needsReview}</div>}
        {v.sourceNote && (
          <div style={{ marginTop: 4, fontSize: 10.5, color: C.lbl, lineHeight: 1.45 }} title={v.sourceNote}>
            {v.published ? <b>{v.published}</b> : null}{v.published ? " · " : ""}
            {v.sourceNote.length > 96 ? v.sourceNote.slice(0, 94) + "…" : v.sourceNote}
          </div>
        )}
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

// HAND-WRITTEN SMART MONEY NOTES carry the date they were written (P14), read from the commit
// that last changed each one. They describe a moment; without a date a note from August reads
// as this morning's. Update the date whenever the note's text is rewritten.
const SM_NOTES_WRITTEN = { fedContext: "2026-09-28", aiInfra: "2026-08-24", q2Signal: "2026-08-24" };
function WrittenOn({ date }) {
  const days = Math.floor((Date.now() - Date.parse(date + "T12:00:00Z")) / 86400000);
  const old = days > 30;
  return (
    <span title="When this note was written by hand. It is not updated automatically." style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", whiteSpace: "nowrap",
      color: old ? C.amber : C.lbl, border: "1px solid " + (old ? C.aBdr : C.bdr), borderRadius: 4, padding: "1px 5px", marginLeft: 6 }}>
      written {new Date(date + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}{days >= 1 ? ` · ${days}d ago` : ""}
    </span>
  );
}


// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  // Lands on the first tab of the first group. Declaring Trade Desk first and then opening in the
  // middle of Market Watch is the kind of small incoherence that makes an ordering feel arbitrary.
  const [tab, setTab]           = useState("global");
  const jobHealth = useJobHealth();     // the scheduler's job states: the Data health tab and the header pill
  // THE GO BAR (src/GoBar.jsx): open state, and the last Gamma symbol it asked for.
  const [goOpen, setGoOpen] = useState(false);
  const [gexRequest, setGexRequest] = useState(null);
  // The ticker page's symbol, kept across visits in this browser (a convenience, nothing private).
  const [tickerSym, setTickerSymRaw] = useState(() => { try { return localStorage.getItem("ticker_last_v1") || "NVDA"; } catch { return "NVDA"; } });
  const setTickerSym = (s) => { setTickerSymRaw(s); try { localStorage.setItem("ticker_last_v1", s); } catch { /* private window: the last symbol is only a convenience */ } };
  // "/" outside a text field, or Ctrl/Cmd+K anywhere, opens it — the keys every palette uses.
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target, typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setGoOpen(true); return; }
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setGoOpen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [theme, setTheme]       = useTheme();
  // THE PINNED NAV'S HEIGHT, as --nav-h on the root. Anything that pins itself below the nav (the
  // Console's book tabs) uses it as its `top`, so the two never overlap however the nav wraps.
  const navRef = useRef(null);
  useEffect(() => {
    const el = navRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => document.documentElement.style.setProperty("--nav-h", `${el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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
  const [portfolioValue, setPortfolioValue] = useState(""); // Plan portfolio total (digits only), this browser only
  const [funds, setFunds]       = useState(DEFAULT_FUNDS);
  const [selectedFund, setSelectedFund] = useState(DEFAULT_FUNDS[0]);
  // Task 1b — manual recession-source overrides, keyed by recessionSrcKey. Loaded once from the
  // manual store; refreshed after a save by the RecessionEntryPanel via onSaved.
  const [recessionOverrides, setRecessionOverrides] = useState({});
  const [ismEntry, setIsmEntry] = useState(null);   // the hand-kept ISM print, shared by the growth card and the log
  const [manualStore, setManualStore] = useState(null);   // the whole manual-entry store, for the hand-kept ledger
  useEffect(() => {
    fetch("/api/manual-entry").then(r => r.json()).then(j => { setRecessionOverrides(j.recession || {}); setIsmEntry(j.ism || null); setManualStore(j); }).catch(() => {});
  }, []);
  // After a save from the hand-entry hub: re-read the store so the ledger's ages update.
  const refreshManual = () => {
    fetch("/api/manual-entry").then(r => r.json()).then(j => { setRecessionOverrides(j.recession || {}); setIsmEntry(j.ism || null); setManualStore(j); }).catch(() => {});
  };

  const { prices, loading: pricesLoading, updated: pricesUpdated, fetchPrices } = useLivePrices();
  const { live: liveInd, loading: indLoading, updated: indUpdated, error: indError, fetchIndicators } = useLiveIndicators();
  const { byRegion: pbData, loading: pbLoading, updatedBy: pbUpdatedBy, errorBy: pbErrorBy, fetchRegion: fetchPlaybookRegion } = useLivePlaybook();
  // Task 1a+1b — the recession table the whole app reads: manual override > auto-feed > static.
  const effectiveRecessionSources = useMemo(
    () => mergeRecessionSources(RECESSION_SOURCES, liveInd?.recessionFeeds || {}, recessionOverrides),
    [liveInd, recessionOverrides]
  );

  // ── THE REGIME, FROM THE SHARED ENGINE ──────────────────────────────────────
  // lib/regimeEngine.js runs the whole pipeline — merged sources, decayed consensus, announced
  // overlays, labour signal, context, probabilities, vintage — on the indicators payload. The
  // pre-read cron calls the same function on the same payload to write the daily log, so the
  // dashboard and the log cannot disagree about what the regime was.
  const fallbackRegimes = FALLBACK_REGIMES;
  const snap = useMemo(() => regimeSnapshot(liveInd, { overrides: recessionOverrides }), [liveInd, recessionOverrides]);
  const { recConsensus, recKalshi2027, laborView, laborAnnounced, laborExtras, derivedRegimes, regimeVintage } = snap;
  // ── THE HAND-KEPT LEDGER ─────────────────────────────────────────────────────
  // Every input a person keeps, with its age and what the system does when it is late. One list,
  // so nothing is overlooked for a while because its badge was on a tab nobody opened.
  // The Southbound feed, for the ledger only (the panel fetches its own) — the same edge-cached
  // ?smic=1 answer, so the ledger can say the flow is automatic rather than "missing".
  const [sbFeedTop, setSbFeedTop] = useState(null);
  useEffect(() => { fetch("/api/indicators?smic=1").then(r => r.json()).then(j => setSbFeedTop(j?.southbound || null)).catch(() => {}); }, []);
  // A Korea save's answer, held until the redeploy carries it into the Asia payload (newerKofia).
  const [kofiaSaved, setKofiaSaved] = useState(null);
  const ledger = useMemo(() => handKeptLedger({
    manual: manualStore || {}, kofia: newerKofia(pbData?.asia?.kofia?.latest || null, kofiaSaved),
    consts: {
      consensusVintage: CONSENSUS_VINTAGE, recessionSources: effectiveRecessionSources, recessionCadence: RECESSION_SOURCE_CADENCE,
      fedLanguage: FED_LANGUAGE_STATUS, secYields: SEC_YIELDS, southboundFeed: sbFeedTop,
      fedPathFeed: liveInd?.fedPathFeed ?? null, ismFeed: liveInd?.ismFeed ?? null,
      analystBoard: { asOf: "2026-06-29", cadence: 90 }, recessionProse: { asOf: "2026-09-30", cadence: 30 },
      announced: {
        pceCore: { ...ANNOUNCED_PRINTS.pceCore, fredAsOf: liveInd?.asOf?.pceCoreCurrent ?? null },
        gdpGrowth: { ...ANNOUNCED_PRINTS.gdpGrowth, fredAsOf: liveInd?.asOf?.gdpGrowth ?? null },
        labor: { label: "July Employment Situation", period: LABOR_ANNOUNCED.period, released: LABOR_ANNOUNCED.released, fredAsOf: liveInd?.labor?.empPop?.date ?? null },
      },
    },
    files: {
      holidaysThrough: Object.entries(HOLIDAYS).filter(([k]) => !k.startsWith("_")).flatMap(([, v]) => [...(v?.closed || []), ...(v?.half || [])]).sort().at(-1) ?? null,
      calendarEvents: Array.isArray(CALENDAR) ? CALENDAR : (CALENDAR?.events || []),
      uae: HOLIDAYS.UAE ? { ...HOLIDAYS.UAE, checkedAt: HOLIDAYS._uae?.checkedAt ?? null, names: HOLIDAYS._uae?.names ?? {}, openClosure: HOLIDAYS._uae?.openClosure ?? null } : null,
    },
  }), [manualStore, pbData, kofiaSaved, liveInd, effectiveRecessionSources, sbFeedTop]);
  const regimeProbFor = (id) => (derivedRegimes || fallbackRegimes)[
    { stag: "stagflation", ref: "reflationary", def: "deflationary", inf: "inflationary" }[id]
  ];


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

  // ── THE MEASURED MARKET STATE (lib/marketState.js) ──
  // The gauges come from /api/indicators?state=1 (half-hour KV cache on the server); the regime is
  // combined here from the main payload's measured axes. Cached locally so the State tab paints the
  // last read at once and replaces it when the fetch lands.
  const [stateFeed, setStateFeed] = useState(() => cacheLoad("cache_marketstate_v1", null));
  const [stateFeedStatus, setStateFeedStatus] = useState({ loading: true, error: null, done: false });
  const loadStateFeed = useCallback(() => {
    return fetch(`${PROXY_BASE_URL}/indicators?state=1`).then(r => r.json()).then(j => {
      if (j?.ok) { setStateFeed(j); cacheSave("cache_marketstate_v1", j); setStateFeedStatus({ loading: false, error: null, done: true }); }
      else setStateFeedStatus({ loading: false, error: j?.error || "no conditions read", done: true });
    }).catch(e => setStateFeedStatus({ loading: false, error: String(e?.message || e), done: true }));
  }, []);
  useEffect(() => { loadStateFeed(); }, [loadStateFeed]);
  // The cross-check sources' statuses, for Data health — fetched when that tab opens.
  const [xcHealth, setXcHealth] = useState(null);
  useEffect(() => {
    if (tab !== "health" || xcHealth) return;
    fetch(`${PROXY_BASE_URL}/indicators?xc=1`).then(r => r.json()).then(setXcHealth).catch(e => setXcHealth({ ok: false, error: String(e?.message || e) }));
  }, [tab, xcHealth]);
  const fetchStateFeed = () => { setStateFeedStatus(s => ({ ...s, loading: true })); loadStateFeed(); };
  const mstate = useMemo(() => computeMarketState({
    axes: liveInd ? measuredAxes(liveInd, { ism: ismEntry }) : null,
    precomputed: stateFeed ? { conditions: stateFeed.conditions, conditionsWeekAgo: stateFeed.conditionsWeekAgo ?? null, liquidity: stateFeed.liquidity } : null,
    stance: FED_LANGUAGE_STATUS.status, stanceAsOf: FED_LANGUAGE_STATUS.lastUpdated,
    next: nextMeetingOdds(liveInd?.fedPathFeed ?? null), asOf: stateFeed?.at ?? null,
  }), [liveInd, ismEntry, stateFeed]);
  // The Hedges tab's phase follows the measured conditions (lib/marketState.js hedgePhase). The old
  // vol-term + OAS suggestion is the fallback while the gauges have not loaded.
  const insuranceSuggest = mstate.hedgePhase
    ? { phase: mstate.hedgePhase.id, why: `conditions: ${mstate.hedgePhase.why}` }
    : suggestInsurancePhase(pbData?.us?.volTerm, pbData?.us?.macro?.oas?.series);
  useEffect(() => {
    if (!insurancePinned && insuranceSuggest?.phase && insuranceSuggest.phase !== insurancePhase) setInsurancePhase(insuranceSuggest.phase);
  }, [insuranceSuggest?.phase, insurancePinned]);
  // Income and hedges are ranked on the measured regime MIX (expected rank over the quadrant probabilities);
  // the consensus regime is the fallback while the axes have not loaded.
  const hedgeSorted = mstate.regime.available
    ? expectedRank(ASSETS, mstate.regime.probs, INS_RANK_KEY)
    : [...ASSETS].sort(byRank(rankKeyFor(INS_RANK_KEY, activeRegime.id)));
  const planRegime = (mstate.regime.available && REGIMES.find(r => r.id === mstate.regime.id)) || activeRegime;
  const incomeSorted = mstate.regime.available
    ? expectedRank(INCOME_PLAYS, mstate.regime.probs, INCOME_RANK_KEY)
    : [...INCOME_PLAYS].sort(byRank(rankKeyFor(INCOME_RANK_KEY, activeRegime.id)));
  const streetView = { id: liveRegime?.id ?? null, vintage: CONSENSUS_VINTAGE.label,
    probs: Object.fromEntries(["ref", "inf", "stag", "def"].map(id => [id, regimeProbFor(id)])) };
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
  useEffect(() => {
    if (!derivedRegimes || !liveRegime) return;
    if (!stateFeedStatus.done) return;                                 // wait for the gauges, so the row carries the measured state
    const today = new Date().toISOString().slice(0, 10);
    if (cacheLoad("regime_log_last_v1", null) === today) return;   // already logged today
    // The same row builder the cron uses, plus what only the client knows: the pinned view, the
    // tape state and the same-day HYG reading the delayed OAS print is later scored against.
    const body = regimeLogRow(snap, {
      date: today, source: 'client',
      extra: {
        hawkish_repricing: pbData?.us?.marketRegime?.state ?? null,
        view_regime: activeRegime.id, pinned: !!regimePin.pinned,
        hyg_chg: pbData?.us?.hyg?.changePct ?? null,
        hyg_qqq_divergence: pbData?.us?.hyg?.divergence?.spread ?? null,
        tape: pbData?.us?.marketRegime?.inputs ?? null,
        ladderSpread: pbData?.us?.ladder?.spread ?? null,
        inputs: { oas: liveInd?.creditSpread ?? null, tenY: liveInd?.tenY ?? null, twoY: liveInd?.twoY ?? null },
        axes: liveInd ? axesLogRow(measuredAxes(liveInd, { ism: ismEntry })) : null,
        state: stateLogRow(mstate),
      },
    });
    fetch("/api/regime-log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "include" })
      .then(r => r.ok ? cacheSave("regime_log_last_v1", today) : null)
      .catch(() => {});
  }, [derivedRegimes?.stagflation, liveRegime?.id, activeRegime.id, stateFeedStatus.done]);

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

  // Income: quote the open category's tickers, so the yields shown are the feed's, not the authored ones.
  useEffect(function() {
    if (tab === "income") fetchPrices(activeIncome.tickers.map(t => t.t));
  }, [tab, activeIncome, fetchPrices]);

  // Fetch the Global Playbook when its tab is open or the region changes.
  useEffect(function() {
    if (tab === "global") pbRegions.forEach(r => fetchPlaybookRegion(r));
    // Credit detail and the yen toggle on Drivers (and the previous Macro layout) read the US payload.
    // Hedges too: its tape chip and fallback phase read pbData.us, which it never fetched itself.
    // Smart Money: the analyst board's FOMC row reads the latest statement from the US payload.
    // Ticker: the next-earnings card reads the calendar rows from the same payload.
    else if (tab === "drivers" || tab === "insurance" || tab === "calendar" || tab === "street" || tab === "ticker") fetchPlaybookRegion("us");
    // Data health: the hand-entry hub's Korea editor and the ledger's KOFIA rows read the Asia payload.
    else if (tab === "health") { fetchPlaybookRegion("asia"); fetchPlaybookRegion("us"); }
  }, [tab, pbRegions, fetchPlaybookRegion]);

  // Load manual deploy-stage toggles + portfolio value from localStorage
  useEffect(function() {
    try {
      const pv = localStorage.getItem("portfolio_total_value");
      if (pv) setPortfolioValue(pv.replace(/[^0-9]/g, ""));
    } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
  }, []);
  function updatePortfolioValue(raw) {
    const digits = String(raw).replace(/[^0-9]/g, "");
    setPortfolioValue(digits);
    try { localStorage.setItem("portfolio_total_value", digits); } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
  }

  // "Updated 14:32" on a payload cached three weeks ago reads exactly like one fetched two
  // minutes ago, because the clock face repeats every day. The last successful indicator fetch is
  // restored from localStorage and re-rendered as "Live:" whether or not today's fetch worked, so
  // the timestamp is the only thing standing between a stale payload and a confident misread of
  // the macro board. Anything not from today therefore carries its DATE and says how old it is.
  // WITH THE ZONES: Dubai first, ET in brackets (lib/timeFmt.js). "Updated 15:53" once sat above
  // region panels reading exchange-local times and could not be reconciled with any of them.
  const fmtTime = d => (d ? dubaiEtStamp(d) : "—");
  // The recession panel and analyst board — the Street's view (Street).
  const renderRecessionPanel = () => (
    <>
              <Card>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                  <SLabel>Recession Probability — tracked panel</SLabel>
                  {/* F.6 — the slowest input on the page, marked as such. */}
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>slowest input · {CONSENSUS_VINTAGE.label}, {CONSENSUS_VINTAGE.staleNote}</span>
                </div>
                {(() => {
                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10, fontSize: 12 }}>
                      <span style={{ color: C.lbl }}>Last updated: <b style={{ color: C.muted }}>June 29, 2026</b> · Updated post Iran peace deal + June FOMC</span>
                      {/* WHAT THIS IS, so the label is not read as a survey. A handful of named houses and
                          models, updated BY HAND four times a year — see docs/recession-board.md. */}
                      <span style={{ color: C.lbl, flexBasis: "100%", fontSize: 11, lineHeight: 1.5 }}>
                        A hand-kept panel of named houses and models — not a survey. Refreshed quarterly, a week or two after each FOMC projection round (late Mar · late Jun · late Sep · mid Dec), which is when the houses revise.
                      </span>
                      <HandKept asOf="2026-06-29" cadenceDays={90} what="quarterly, a week or two after each FOMC projection round" />
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
                    nextHikeOdds: nextMeetingOdds(liveInd?.fedPathFeed ?? null)?.hikePct ?? null,
                    nextMeetingLabel: (() => { const o = nextMeetingOdds(liveInd?.fedPathFeed ?? null); return o ? new Date(o.meeting + "T12:00:00Z").toLocaleString("en-US", { month: "short", timeZone: "UTC" }) : null; })(),
                    fedHawkish: /hawkish|tightening/i.test(FED_LANGUAGE_STATUS?.status || ""),
                    // The decision in force, from the newest FOMC statement (lib/calendarAuto.js).
                    fomcLatest: pbData?.us?.calendarAuto?.fomcLatest ?? null,
                    capexRising: true,   // big-four 2026 ~$725B (+77% YoY) — Smart Money tab, sourced
                    unemployment: laborView?.u3?.value ?? liveInd?.unemployment ?? null,
                    // The employment SHARE, not the headline rate: U3 can fall on labour-force exit
                    // while the employed share shrinks, which is the consumer tell these theses rest on.
                    empPopFalling: laborView?.empPop?.delta == null ? null : laborView.empPop.delta < 0,
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
                  const { rolling: roll, calendar: cal, calWindow: cw } = recConsensus;
                  const disp = dispersionRead(roll);
                  const box = (title, c, opts = {}) => (
                    <div style={{ flex: "1 1 260px", background: opts.primary ? C.blBg : C.bg, border: "1.5px solid " + (opts.primary ? C.blBdr : C.bdr), borderRadius: 10, padding: "11px 13px" }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5, color: opts.primary ? C.blue : C.muted }}>{title}</span>
                        {opts.primary && <span style={{ fontSize: 9.5, fontWeight: 800, color: C.onFill, background: C.blue, borderRadius: 4, padding: "1px 6px" }}>DRIVES REGIME</span>}
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
                        {["Source", "Probability", "As of", "Timeframe", "Notes"].map(h => (
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
                        A view archived here was explicitly conditional on something that did not happen. Its number is kept for the record and excluded from the weighted average; the reason is stated on each row.</div>
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
                {/* AN ESSAY, NOT AN ALARM. This paragraph is written by hand after a data event and
                    was styled as a live warning — amber box, warning glyph — so a three-week-old
                    reading of the July minutes looked like something that had just fired. It keeps
                    its content and loses the alarm: neutral surface, the chip up front, and the
                    one live number in it (Kalshi) labelled as the only live thing here. */}
                <div style={{ marginTop: 12, padding: "12px 14px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8 }}>
                  <div style={{ marginBottom: 6 }}><HandKept asOf="2026-09-30" cadenceDays={30} what="after each data event that changes the recession read" /></div>
                  {/* Rebuilt 2026-09-30 after August core PCE and JOLTS. EVERY NUMBER IS COMPUTED here from
                      the live feeds — payroll changes and quits from the labour block, core CPI / PCE
                      momentum from the index levels (lib/marketState.js inflationMomentum, FRED CPILFESL
                      and PCEPILFE), HY OAS from the state feed, the odds from the recession feeds — so
                      the text cannot drift from the data; only the framing is hand-kept. */}
                  {(() => {
                    const L = liveInd?.labor || {};
                    const mo = (d) => (d ? new Date(d + "T12:00:00Z").toLocaleString("en-US", { month: "short", timeZone: "UTC" }) : "—");
                    const day = (d) => (d ? new Date(d + "T12:00:00Z").toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—");
                    const pay = (L.payrolls?.history || []).slice(-4);
                    const chg = pay.length === 4 ? pay.slice(1).map((p, i) => ({ date: p.date, k: Math.round(p.value - pay[i].value) })) : [];
                    const avg3 = chg.length === 3 ? Math.round(chg.reduce((a, c) => a + c.k, 0) / 3) : null;
                    const q = (L.quits?.history || []).slice(-2);
                    const pce = stateFeed?.inflation?.pceCore ?? null, cpi = stateFeed?.inflation?.cpiCore ?? null;
                    const hy = stateFeed?.stats?.hyOas ?? null, sp = hy?.spark || [];
                    const hy10 = sp.length > 10 ? Math.round((sp[sp.length - 1] - sp[sp.length - 11]) * 100) : null;
                    const rf = liveInd?.recessionFeeds || {};
                    const odd = (k) => rf[k]?.probability != null ? `${rf[k].probability}%` : "—";
                    const nx = nextMeetingOdds(liveInd?.fedPathFeed ?? null);
                    const sgn = (v, u = "") => v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}${u}`;
                    const B = ({ children }) => <b style={{ color: C.text }}>{children}</b>;
                    const row = { display: "grid", gridTemplateColumns: "150px minmax(0, 1fr)", gap: "2px 10px", fontSize: 13, lineHeight: 1.55 };
                    return (
                      <div style={{ display: "grid", gap: 8, color: C.mid, fontSize: 13.5, lineHeight: 1.6 }}>
                        <div>
                          <span style={{ color: C.text, fontWeight: 700 }}>The signal that matters: </span>
                          the hike the July minutes warned of arrived — 25bp on Sep 16, to 3.75–4.00% — and the futures price {nx?.hikePct != null ? <B>{Math.round(nx.hikePct)}%</B> : "—"} odds of another on {nx?.meeting ? day(nx.meeting) : "the next meeting"}. Near-term recession odds are low; the risk is the one tightening builds, and credit is where it would show first.
                        </div>
                        <div style={row}>
                          <b style={{ color: C.text }}>Payrolls</b>
                          <span>
                            {chg.length ? <>{mo(chg[2].date)} <B>{sgn(chg[2].k, "k")}</B> <i style={{ color: C.muted }}>(first release)</i>, {mo(chg[1].date)} {sgn(chg[1].k, "k")}, {mo(chg[0].date)} {sgn(chg[0].k, "k")} — <B>3-month average {sgn(avg3, "k")}</B>.</> : "not loaded."}
                            {" "}Unemployment {L.u3?.value ?? "—"}% ({L.u3?.yearAgo ?? "—"}% a year ago); long-term unemployed {L.longTerm?.value ?? "—"}% of the jobless ({L.longTerm?.prev ?? "—"}% the month before).
                          </span>
                          <b style={{ color: C.text }}>JOLTS quits</b>
                          <span>{q.length === 2 ? <>{mo(q[1].date)} <B>{q[1].value}%</B>, {mo(q[0].date)} {q[0].value}%</> : "not loaded"} — people staying put rather than trading up.</span>
                          <b style={{ color: C.text }}>Core PCE</b>
                          <span>
                            {pce ? <><B>{pce.yoy}% y/y</B> in {mo(pce.date)} · {sgn(pce.mom, "%")} m/m · <B>{pce.ann3m}% 3-mo annualised</B> ({pce.ann3mPrev}% the month before) — {pce.trend3m === "rising" ? "the short-run trend is rising: inflation has stopped improving." : "y/y ticked up on base effects, but the short-run trend is still easing."}</> : "momentum not loaded."}
                            {cpi ? <span style={{ color: C.muted }}> Core CPI {cpi.yoy}% y/y, {sgn(cpi.mom, "%")} m/m, {cpi.ann3m}% 3-mo annualised. Series: FRED {pce?.id ?? "PCEPILFE"} and {cpi.id}, y/y and m/m on the index levels — checked against FRED's published levels; the core-PCE-over-core-CPI gap is in the data.</span> : null}
                          </span>
                          <b style={{ color: C.text }}>HY OAS</b>
                          <span>{hy ? <><B>{hy.value.toFixed(2)}%</B> on {day(hy.date)} · {sgn(hy10, "bp")} over 10 sessions</> : "not loaded"}</span>
                        </div>
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.8, textTransform: "uppercase", color: C.lbl, marginBottom: 3 }}>Recession odds — by horizon, not one row</div>
                          <div style={row}>
                            <span>Calendar 2026 <span style={{ color: C.muted }}>(one quarter left)</span></span>
                            <span>Kalshi <B>{odd("Kalshi prediction market")}</B> · Polymarket <B>{odd("Polymarket")}</B> <span style={{ color: C.muted }}>(“by end of 2026”)</span></span>
                            <span>Next 12 months</span>
                            <span>NY Fed yield-curve model <B>{odd("NY Fed Yield Curve Model")}</B> <span style={{ color: C.muted }}>(probit on the 10Y–3M spread{rf["NY Fed Yield Curve Model"]?.asOf ? `, ${day(rf["NY Fed Yield Curve Model"].asOf)}` : ""})</span></span>
                            <span>Calendar 2027</span>
                            <span>Kalshi <B>{recKalshi2027 != null ? `${recKalshi2027}%` : odd("Kalshi prediction market 2027")}</B> — still the higher horizon</span>
                          </div>
                        </div>
                        <div>
                          <b style={{ color: C.text }}>What would change the read:</b> the payroll <B>3-month average under 50k</B>; quits at <B>1.8% or lower for two consecutive prints</B>; HY OAS through <B>3.50%</B>, or <B>+50bp in 10 sessions</B>.
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </Card>

              <RecessionEntryPanel overrides={recessionOverrides} onSaved={setRecessionOverrides} />
    </>
  );

  // ── ONE ROW OF PAGES (src/pages/nav.js) ──
  // Each page is one job in the order a day runs; a page with several views shows them in a second
  // row, a page with one shows none. The open page is DERIVED from the open view, never stored.
  const page = pageOf(tab);
  // THE INPUTS, AT A GLANCE — what the status dot shows, from what is already loaded (nothing is
  // fetched for it). Red: the conditions read failed. Amber: serving a last good copy, a feed
  // erroring, or a hand-kept input stale or never entered. Green otherwise.
  const health = (() => {
    const jobNote = jobHealthNote(jobHealth);
    const feedErrs = Array.isArray(liveInd?.feedErrors) ? liveInd.feedErrors.length : 0;
    const handOut = (ledger?.counts?.stale || 0) + (ledger?.counts?.missing || 0);
    const notes = [];
    if (stateFeedStatus.error && !stateFeed) notes.push("the conditions read failed");
    if (stateFeed?.source === "stale") notes.push("gauges on their last good copy");
    if (feedErrs) notes.push(`${feedErrs} feed${feedErrs === 1 ? "" : "s"} erroring`);
    if (handOut) notes.push(`${handOut} hand-kept input${handOut === 1 ? "" : "s"} out of date`);
    if (jobNote) notes.push(jobNote);
    const level = (stateFeedStatus.error && !stateFeed) || jobNote ? "red" : notes.length ? "amber" : "green";
    return { level, title: notes.length ? `Data health: ${notes.join(", ")}. Click for detail.` : "Data health: every input current. Click for detail." };
  })();
  // What a Go bar line does once chosen (lib/goCommands.js says what it means).
  const runGo = (r) => {
    if (r.tab) {
      setTab(r.tab);
      if (r.tab === "gex" && r.symbol) setGexRequest({ symbol: r.symbol, n: Date.now() });
      if (r.tab === "ticker" && r.symbol) setTickerSym(r.symbol);
      if (r.anchor) setTimeout(() => document.getElementById(r.anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
    } else if (r.action === "refresh") { fetchPrices(HEADER_TICKERS); fetchIndicators(); }
    else if (String(r.action || "").startsWith("theme:")) setTheme(r.action.slice(6));
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", width: "100%", color: C.text, fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* ── HEADER ── */}
      {/* ── MASTHEAD — scrolls away on purpose ──
          The whole header used to be sticky: title, tagline, refresh, status block, tabs and the
          regime strip, all pinned. On a phone that is most of the screen permanently occupied by a
          name you already know. What has to stay is what you NAVIGATE and MONITOR with; the title
          is not that, so it scrolls and the bar below it pins. */}
      <div className="mwd-masthead" style={{ background: C.surf, padding: "14px 16px 0" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <div>
              <h1 className="mwd-title" style={{ margin: 0, fontSize: 19, fontWeight: 900, letterSpacing: -0.5 }}>
                📊 Market Watch Dashboard
              </h1>
              <p className="mwd-tagline" style={{ margin: 0, color: C.muted, fontSize: 13 }}>
                {PAGES.map(p => p.label).join(" · ")}
              </p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: "100%" }}>
              <ThemeToggle theme={theme} setTheme={setTheme} />
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
                // ── THE HEADER IS THE MEASURED STATE (lib/marketState.js) ──
                // It was the consensus regime with credit's veto (headerSignal) — a lookup on
                // strategists' recession odds. It is now the stage the conditions score implies,
                // coloured by the conditions band, with the score and the size it sets. The tape
                // stance for this session stays on the Daily Overview.
                const c = mstate.conditions, stg = mstate.stage;
                const tok = STATUS[BAND_STATUS[c?.band?.id]] || { color: C.mid, bg: C.inset, bdr: C.bdr };
                return (
                  <div style={{ background: tok.bg, border: "1.5px solid " + tok.bdr, borderRadius: 10, padding: "6px 14px", textAlign: "center", minWidth: 90, cursor: "pointer" }}
                       onClick={() => setTab("state")}
                       title="The measured market state: the stage the conditions score implies, the score and its band, and the size multiplier (regime mix × conditions). Opens Markets › State.">
                    <div style={{ color: C.lbl, fontSize: 10, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700 }}>Market state</div>
                    <div style={{ color: tok.color, fontSize: 17, fontWeight: 900, lineHeight: 1, whiteSpace: "nowrap" }} title={stg ? `Stage ${stg.n} — ${stg.label}: ${stg.plan}` : undefined}>{stg ? `${stg.n} · ${stg.id.toUpperCase()}` : "—"}</div>
                    <div style={{ color: tok.color, fontSize: 10, marginTop: 2, opacity: 0.8, lineHeight: 1.2 }}>
                      {c?.score != null ? `conditions ${c.score} · ${c.band.label.toLowerCase()}${c.trend && c.trend !== "steady" ? `, ${c.trend}` : ""}` : "conditions loading"}
                    </div>
                    <div style={{ color: C.lbl, fontSize: 9, marginTop: 2, letterSpacing: 0.3 }}>{mstate.sizing?.total != null ? `size ×${mstate.sizing.total.toFixed(2)}` : "measured"}</div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* ── STICKY NAV ──
          Pages, views and the regime strip. Roughly a third the height of the old sticky header,
          which is what makes pinning it worth doing rather than something to scroll past. */}
      <div ref={navRef} className="mwd-sticky-nav" style={{ background: C.surf, borderBottom: "2px solid " + C.bdr, padding: "8px 16px 0", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          {/* ── PAGE ROW ──
              Choosing a page opens its FIRST view. Ops carries the data-health dot, so the state of
              the inputs is visible from every page without a separate pill. */}
          <div className="mwd-tabrow mwd-grouprow" style={{ display: "flex", gap: 6, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
            {PAGES.map(pg => {
              const on = pg.id === page.id;
              const dot = pg.dot ? { green: C.green, amber: C.amber, red: C.red }[health.level] : null;
              const title = pg.dot ? health.title : pg.title;
              return (
                <button key={pg.id} className="mwd-group-btn" onClick={() => { if (!on) setTab(pg.tabs[0].id); }} title={title} aria-label={pg.dot ? `${pg.label}. ${health.title}` : pg.label} style={{
                  background: on ? C.blBg : "transparent",
                  border: "1.5px solid " + (on ? C.blue : C.bdr),
                  borderRadius: 999, color: on ? C.blue : C.mid,
                  padding: "5px 12px", fontSize: 13, fontWeight: 800,
                  cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
                  display: "inline-flex", alignItems: "center", gap: 6,
                }}>
                  {dot && <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 99, background: dot, display: "inline-block" }} />}
                  {pg.label}
                </button>
              );
            })}
            <button className="mwd-nav-pill" onClick={() => setGoOpen(true)} title="Go to any view: type a code like ECO or PORT, or a ticker with GEX. Shortcut: / or Ctrl+K" aria-label="Open the Go bar"
              style={{ background: "transparent", border: "1.5px solid " + C.bdr, borderRadius: 999, color: C.mid, padding: "5px 10px", fontSize: 12, fontWeight: 800,
                       cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0, marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <GoKey small /><span className="mwd-data-label" style={{ color: C.muted }}>/</span>
            </button>
          </div>
          {/* ── VIEW ROW — only on a page with more than one view ── */}
          {page.tabs.length > 1 ? (
            <div className="mwd-tabrow" style={{ display: "flex", gap: 0, marginTop: 6, overflowX: "auto", WebkitOverflowScrolling: "touch", scrollbarWidth: "none" }}>
              {page.tabs.map(t => (
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
          ) : <div style={{ height: 8 }} />}
          {/* THE STATE STRIP — on every tab, sticky: the measured regime, conditions and policy
              (lib/marketState.js). The consensus regime and the credit ladder it used to show are
              on Research › Smart Money (folded, under the 13F data) and inside the conditions score. */}
          {(() => {
            const r = mstate.regime, c = mstate.conditions, pol = mstate.policy;
            const chip = (k, v, col, onClick) => (
              <span onClick={onClick} style={{ display: "inline-flex", alignItems: "baseline", gap: 6, whiteSpace: "nowrap", cursor: onClick ? "pointer" : "default" }}>
                <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: C.lbl }}>{k}</span>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: col }}>{v}</span>
              </span>
            );
            const flag = (txt) => <span style={{ fontSize: 10, fontWeight: 800, color: C.amber, background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap" }}>{txt}</span>;
            const pal = r.available ? REGIME_PALETTE[r.id] : null;
            const bandCol = { calm: C.green, caution: C.amber, stress: C.orange, crisis: C.red }[c?.band?.id] || C.mid;
            const regTxt = !r.available ? "no read" : r.contested
              ? `Between · ${["ref", "inf", "stag", "def"].sort((a, b) => r.probs[b] - r.probs[a]).slice(0, 2).map(id => `${{ ref: "Refl", inf: "Infl", stag: "Stag", def: "Defl" }[id]} ${r.probs[id]}%`).join(" / ")}`
              : `${REGIMES.find(x => x.id === r.id)?.label ?? r.label} ${r.probs[r.id]}%`;
            const streetDisagrees = r.available && liveRegime && !r.contested && liveRegime.id !== r.id;
            return (
              // WRAPS, NOT SCROLLS. On a 390px phone the strip ran past the edge with its scrollbar
              // hidden, so "Inflationary Boom 48% → defl" read as cut off and the chips after it
              // were invisible. It now breaks onto a second line.
              <div style={{ display: "flex", columnGap: 14, rowGap: 4, alignItems: "center", flexWrap: "wrap", padding: "7px 2px 3px", borderTop: "1px solid " + C.bdr, marginTop: 4 }}>
                {chip("Regime", `${regTxt}${r.available && r.drifting ? ` → ${{ ref: "refl", inf: "infl", stag: "stag", def: "defl" }[r.drifting]}` : ""}`, pal?.color || C.mid, () => setTab("state"))}
                <span style={{ color: C.bdr }}>·</span>
                {chip("Conditions", c?.score != null ? `${c.score} ${c.band.label}${c.trend === "rising" ? " ↑" : c.trend === "easing" ? " ↓" : ""}` : "—", bandCol, () => setTab("state"))}
                <span style={{ color: C.bdr }}>·</span>
                {chip("Fed", pol?.stance ? `${pol.stance}${pol.next?.hikeOdds != null && pol.next.hikeOdds >= 10 ? ` · hike ${Math.round(pol.next.hikeOdds)}%` : pol.next?.cutOdds != null && pol.next.cutOdds >= 10 ? ` · cut ${Math.round(pol.next.cutOdds)}%` : ""}` : "—",
                  pol?.stance === "tightening" ? C.red : pol?.stance === "easing" ? C.green : C.amber)}
                {mstate.sizing?.total != null && <><span style={{ color: C.bdr }}>·</span>{chip("Size", `×${mstate.sizing.total.toFixed(2)}`, C.text)}</>}
                {streetDisagrees && <span title={`The Street's consensus reads ${liveRegime.label} ${regimeProbFor(liveRegime.id)}% — see Research › Smart Money`}>{flag(`STREET: ${liveRegime.label.toUpperCase()}`)}</span>}
                {(() => { const ia = pbData?.us?.interventionAuto; if (!ia?.active) return null;
                  const g = ia.latest?.confirmation?.status === "confirmed" ? "CONFIRMED" : "SUSPECTED";
                  return <span title={ia.headline}>{flag(`⚑ YEN INTERVENTION ${g}`)}</span>; })()}
                {regimeDiverged && flag("📌 PINNED ≠ LIVE")}
                {(ledger.counts.stale + ledger.counts.missing) > 0 && <span onClick={() => runGo({ tab: "health", anchor: "hand-entry" })} style={{ cursor: "pointer" }} title={`${ledger.counts.stale} stale, ${ledger.counts.missing} never entered — open the hand-entry list`}>{flag(`✍ ${ledger.counts.stale + ledger.counts.missing} HAND-KEPT OUT`)}</span>}
                {stateFeed?.source === "stale" && flag("GAUGES: LAST GOOD COPY")}
              </div>
            );
          })()}
        </div>
      </div>

      {goOpen && <GoBar onClose={() => setGoOpen(false)} onRun={runGo} />}

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
              <Btn onClick={switchToLive} color={C.onFill} bgColor={C.blue} label="Switch to live" />
              <Btn onClick={() => {
                const n = window.prompt("Why keep this pinned? (shown in the banner)", regimePin.note || "");
                if (n !== null) keepPinned(n);
              }} color={C.amber} bgColor={C.aBg} label="Keep pinned…" />
            </span>
          </div>
        )}

        <TabErrorBoundary key={tab} name={(VIEWS.find(t => t.id === tab)?.label || "This tab").replace(/^\S+\s/, "")}>
        <Suspense fallback={<div style={{ padding: 24, color: C.muted, fontSize: 13 }}>Loading…</div>}>

        {/* ── GAMMA EXPOSURE ──
            Self-contained: its own tab, its own endpoints, its own state. Nothing about it lives
            in this file beyond the mount, which is the whole point of building it separately. */}
        {/* A FAILED MACRO REFRESH IS SAID, ON EVERY TAB THAT READS IT. The error was rendered only
            on the retired Indicators tab, so State, Drivers, Plan, Hedges and Income kept drawing
            the last stored copy with nothing to say it was old. */}
        {indError && ["state", "drivers", "plan", "insurance", "income", "global", "street"].includes(tab) && (
          <div style={{ padding: "8px 12px", marginBottom: 10, borderRadius: 8, background: C.aBg, border: "1px solid " + C.aBdr, color: C.amber, fontSize: 12.5, fontWeight: 700 }}>
            ⚠ Macro indicators did not refresh — {indError} Showing the copy from {indUpdated ? dubaiEtStamp(indUpdated) : "an earlier load"}.
          </div>
        )}
        {/* A Go bar request is spent once Gamma has acted on it, so returning to the tab later opens it as usual. */}
        {tab === "gex" && <GexPanel request={gexRequest} onRequestDone={() => setGexRequest(null)} />}
        {/* The Console's rows reach the ticker page from the store this browser already loaded; the
            page shows them and sends them nowhere. */}
        {tab === "ticker" && <TickerPanel key={tickerSym} symbol={tickerSym} onSymbol={setTickerSym}
          consoleRows={Array.isArray(manualStore?.console?.rows) ? manualStore.console.rows : null}
          calendarExtra={[...(pbData?.us?.calendar || []), ...(pbData?.us?.calendarAuto?.events || [])]}
          onOpenGamma={(s) => { setGexRequest({ symbol: s, n: Date.now() }); setTab("gex"); }}
          onOpenConsole={() => setTab("console")} />}
        {tab === "ratios" && <RatiosPanel />}
        {/* The feed's calendar rows add announced Treasury auctions to the hand-kept list. */}
        {tab === "calendar" && <CalendarPanel extra={[...(pbData?.us?.calendar || []), ...(pbData?.us?.calendarAuto?.events || [])]} autoSources={pbData?.us?.calendarAuto?.sources || null} />}

        {/* ── TRADE CONSOLE (Tier 3) ── */}
        {tab === "console" && (
          <TradeConsole
            // THE MEASURED REGIME, as the header shows it. The console was handed the consensus
            // engine's pick (the Street's stagflation) while the strip above it read Reflationary
            // Growth — so the multiplier tile marked Stagflation "live" and each card's regime fit
            // argued from it. The consensus regime stays where it belongs, on the Street chip.
            liveRegime={(mstate.regime.available && REGIMES.find(r => r.id === mstate.regime.id)) || liveRegime}
            liveInd={liveInd}
            creditDanger={creditStatus(liveInd?.creditSpread) === "DANGER"}
            // The consensus engine's own pick and qualifier, for the "consensus engine was ×…"
            // comparison the sizer prints beside the measured multiplier.
            consensusRegime={liveRegime}
            contested={!!derivedRegimes?.contested}
            regimeDiverged={regimeDiverged}
            regimeVintage={regimeVintage}
            marketState={mstate.regime.available && mstate.conditions.band ? { probs: mstate.regime.probs, band: mstate.conditions.band.id } : null}
            prices={prices}
            fetchPrices={fetchPrices}
            pricesLoading={pricesLoading}
          />
        )}

        {/* ── MARKET WATCH: STATE / DRIVERS / DATA HEALTH (src/MarketState.jsx) ── */}
        {tab === "state" && (
          <StateView st={mstate} feed={stateFeed} loading={stateFeedStatus.loading || indLoading} error={stateFeedStatus.error}
            onRefresh={() => { fetchStateFeed(); fetchIndicators(); }}
            streetLabel={liveRegime ? `${liveRegime.label} ${regimeProbFor(liveRegime.id)}%` : null} />
        )}
        {tab === "drivers" && (
          <DriversPage mstate={mstate} stateFeed={stateFeed} liveInd={liveInd} ismEntry={ismEntry} setIsmEntry={setIsmEntry}
            laborView={laborView} laborExtras={laborExtras} laborAnnounced={laborAnnounced} pbData={pbData} reconSummary={reconSummary}
            setLiveIntervention={setLiveIntervention} setTab={setTab} />
        )}
        {tab === "health" && (
          <OpsPage ledger={ledger} stateFeed={stateFeed} liveInd={liveInd} indUpdated={indUpdated} xcHealth={xcHealth} jobHealth={jobHealth}
            onOpenTicker={(sym) => runGo({ tab: "ticker", symbol: sym })}
            renderEditor={(editor) => {
              // The same components, props and save paths as on their own tabs.
              if (editor === "ism") return <IsmEntryPanel entry={ismEntry} feed={liveInd?.ismFeed} onChange={(v) => { setIsmEntry(v); refreshManual(); }} />;
              if (editor === "usfr") return <UsfrSecYieldForm liveInd={liveInd} onSaved={refreshManual} />;
              if (editor === "korea") return pbData?.asia?.kofia
                ? <KoreaManualEntry kofia={pbData.asia.kofia} gate2={pbData.asia.won?.gate2 ?? null} onSaved={(latest) => { if (latest) setKofiaSaved(latest); fetchPlaybookRegion("asia"); }} />
                : <div style={{ fontSize: 12, color: C.muted }}>Loading the Asia payload the Korea entry reads…</div>;
              if (editor === "fedPath") return <FedPathCard effr={liveInd?.fedPathFeed?.effr ?? liveInd?.currentFedFunds ?? null} feed={liveInd?.fedPathFeed ?? null} onSaved={refreshManual} />;
              if (editor === "southbound") return <SouthboundPanel onSaved={refreshManual} />;
              if (editor === "intervention") return <InterventionToggle
                jpyChangePct={pbData?.us?.cross?.fx?.rows?.find(r => r.sym === "JPY=X")?.changePct ?? null}
                dxyChangePct={pbData?.us?.cross?.fx?.rows?.find(r => r.sym === "DX-Y.NYB")?.changePct ?? null}
                onChange={(v) => { setLiveIntervention(v); refreshManual(); }} auto={pbData?.us?.interventionAuto ?? null} />;
              if (editor === "recession") return <RecessionEntryPanel overrides={recessionOverrides} onSaved={(v) => { setRecessionOverrides(v); refreshManual(); }} />;
              return null;
            }} />
        )}

        {/* ── THE PAPER TRIAL (src/MlsPanel.jsx) ── */}
        {tab === "mls" && <MlsPanel />}

        {/* ── PLAN ── */}
        {tab === "plan" && (
          <PlanView st={mstate} allocations={POSTURE_ALLOCATIONS} bucketMeta={POSTURE_BUCKET_META} statusTone={postureTone}
            fillNote={(t) => fillLiveRates(t, liveCashYield(liveInd))} portfolioValue={portfolioValue} onPortfolioValue={updatePortfolioValue} onGo={setTab} />
        )}

        {/* ── INSURANCE ── */}
        {tab === "insurance" && (
          <HedgesView insurancePhase={insurancePhase} insuranceSuggest={insuranceSuggest} planRegime={planRegime} mstate={mstate}
            regimeProbFor={regimeProbFor} pbData={pbData} pickInsurancePhase={pickInsurancePhase} insurancePinned={insurancePinned}
            followInsuranceSignal={followInsuranceSignal} liveInd={liveInd} hedgeSorted={hedgeSorted} activeAsset={activeAsset}
            setActiveAsset={setActiveAsset} prices={prices} fetchPrices={fetchPrices} pricesLoading={pricesLoading} pricesUpdated={pricesUpdated} />
        )}

        {/* ── INCOME ── */}
        {tab === "income" && (
          <IncomeView incomeSorted={incomeSorted} planRegime={planRegime} mstate={mstate} activeIncome={activeIncome}
            setActiveIncome={setActiveIncome} prices={prices} fetchPrices={fetchPrices} pricesLoading={pricesLoading} liveInd={liveInd} />
        )}

        {/* ── SMART MONEY ── */}
        {tab === "street" && (
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
              <b style={{ color: C.blue }}>Fed context since Jun 30</b><WrittenOn date={SM_NOTES_WRITTEN.fedContext} /><b style={{ color: C.blue }}>: </b>
              July was a <b>9–3 hold</b> with three presidents dissenting <i>for</i> a hike, and the Aug 19 minutes said "many participants" saw tightening as likely necessary. On <b>Sep 16 the Fed hiked 25bp to 3.75–4.00%, 12–0</b>, and the September dots added one more hike for 2026 and no cut in 2027. The book below was set before all of this — every position in it was chosen against a Fed that was still holding.
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
                            <span style={{ fontSize: 9.5, fontWeight: 800, color: C.onFill, background: tag.col, borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>{tag.label}</span>
                            <span style={{ fontSize: 10.5, color: C.lbl, whiteSpace: "nowrap" }}>{dateLine}</span>
                          </div>
                        </td>
                        {row.vals.slice(0, funds.length).map((v, i) => {
                          // ▨ = Withheld (manager filed for confidential treatment — a position exists
                          // but is delayed), deliberately distinct from ◯ Absent (no reportable position).
                          const col = v === "●" || v === "●●" ? C.green : v === "◐" ? P.amber600 : v === "✕" ? C.red : v === "▨" ? P.slate600 : C.bdrMd;
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
                {[[C.green,"● Active"],[P.amber600,"◐ Partial"],[C.red,"✕ Short/exit"],[C.bdrMd,"◯ Absent"],[P.slate600,"▨ Withheld"]].map(([col, lbl]) => (
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
                    <div style={{ fontSize: 12, fontWeight: 900, color: C.amber, marginBottom: 3 }}>⚠️ The consensus long (AI infra): thesis strengthening, price de-rating<WrittenOn date={SM_NOTES_WRITTEN.aiInfra} /></div>
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
                        onClick={() => { setTab("street"); setSelectedFund(f); }}
                        title="Click to view on the Smart Money tab"
                      >
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid " + C.bdr }}>
                          <span style={{ color: f.color, fontWeight: 800, fontSize: 14 }}>{f.name}</span>
                        </td>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid " + C.bdr, color: C.muted, fontSize: 13 }}>
                          {f.manager}
                        </td>
                        <td style={{ padding: "9px 12px", borderBottom: "1px solid " + C.bdr, minWidth: 140 }}>
                          {f.regimeBet
                            ? <span style={{ background: alpha(f.regimeBetColor || f.color, 0x15), color: f.regimeBetColor || f.color, border: "1.5px solid " + (f.regimeBetColor || f.color) + "40", borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 800, lineHeight: 1.5, display: "inline-block" }}>{f.regimeBet}</span>
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
                <span style={{ color: C.amber, fontWeight: 700, fontSize: 13 }}>⚠️ The Q2 signal (as of Jun 30)<WrittenOn date={SM_NOTES_WRITTEN.q2Signal} />: </span>
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
                  background: selectedFund.id === f.id ? alpha(f.color, 0x12) : C.surf,
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
                  <div style={{ background: alpha(f.signalColor, 0x15), color: f.signalColor, border: "1.5px solid " + alpha(f.signalColor, 0x40), borderRadius: 6, padding: "3px 7px", fontSize: 11, fontWeight: 800, lineHeight: 1.4, display: "inline-block", maxWidth: "100%", wordBreak: "break-word" }}>{f.signal}</div>
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
        {/* The Street's view, below the positioning: the measured regime beside the houses'
            consensus, then the recession panel and analyst board — a cross-check, folded. */}
        {tab === "street" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
            <Fold title="The Street's view — analyst consensus and recession odds" hint="a cross-check on the measured regime; drives nothing">
              <StreetCompare st={mstate} street={streetView} />
              {renderRecessionPanel()}
            </Fold>
          </div>
        )}

        {/* ── DAILY OVERVIEW ── */}
        {tab === "global" && (
          <GlobalPlaybook
            /* The stance card runs the regime guard client-side. The MEASURED state: the combined
               probability of the two hostile quadrants, and the conditions band (Stress or Crisis
               withholds RISK-ON on its own). The consensus regime only while the axes load. */
            regime={mstate.regime.available
              ? { id: mstate.regime.probs.stag >= mstate.regime.probs.def ? "stag" : "def", label: "Stagflation or deflationary bust (measured)",
                  pct: mstate.regime.probs.stag + mstate.regime.probs.def, band: mstate.conditions.band?.id ?? null, score: mstate.conditions.score }
              : { id: liveRegime?.id, label: liveRegime?.label, pct: regimeProbFor(liveRegime?.id) }}
            /* The two slower layers the stance card names beside today's tape, and the IF/THEN
               transitions whose stage feeds its DO — the same measured state the Market State tab shows. */
            layers={{
              regime: mstate.regime.available ? mstate.regime.headline : null,
              conditions: mstate.conditions.band ? `${mstate.conditions.band.label}${mstate.conditions.score != null ? ` (${mstate.conditions.score})` : ""}` : null,
              transitions: mstate.transitions || [],
            }}
            liveIntervention={liveIntervention}
            reconSummary={reconSummary}
            byRegion={pbData}
            onOpenCalendar={() => setTab("calendar")}
            regions={pbRegions}
            toggleRegion={toggleRegion}
            loading={pbLoading}
            errorBy={pbErrorBy}
            updatedBy={pbUpdatedBy}
            onRefresh={() => pbRegions.forEach(r => fetchPlaybookRegion(r))}
            fmtTime={fmtTime}
          />
        )}


        </Suspense>
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