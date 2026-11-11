import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from "react";
import { C, P, THEMES, DEFAULT_THEME, THEME_KEY } from "./theme.js";
import { Btn, TabErrorBoundary } from "./ui.jsx";
import { cacheLoad, cacheSave } from "./cache.js";
import { InterventionToggle, FedPathCard, UsfrSecYieldForm, IsmEntryPanel, RecessionEntryPanel } from "./pages/editors.jsx";
import { liveCashYield, fillLiveRates } from "./pages/cash.js";
import { INS_RANK_KEY, INCOME_RANK_KEY, rankKeyFor, byRank } from "./pages/ranking.js";
import { GlobalPlaybook, SouthboundPanel, KoreaManualEntry } from "./pages/TodayPage.jsx";
import { PB_REGIONS } from "./pages/regions.js";
import { ASSETS } from "../lib/assets.js";
import { REGIMES, REGIME_PALETTE } from "../lib/regimes.js";
import { GoBar, GoKey } from "./GoBar.jsx";
import { PAGES, VIEWS, pageOf } from "./pages/nav.js";
import { pendingReconciliations, reconStats } from "../lib/recon.js";
import {  } from "../lib/regimeProb.js";

import { STATUS, BAND_STATUS, creditStatus } from "../lib/status.js";
import { computeMarketState, stateLogRow } from "../lib/marketState.js";
import { StateView } from "./MarketState.jsx";
import { useJobHealth, jobHealthNote } from "./jobHealth.js";
import { expectedRank } from "../lib/plan.js";

import { measuredAxes, axesLogRow } from "../lib/quadrant.js";
import { handKeptLedger } from "../lib/ledger.js";
import { newerKofia } from "../lib/handEntry.js";
import CALENDAR from "../data/calendar.json";
import { FED_LANGUAGE_STATUS } from "../lib/fedLanguage.js";
import { RECESSION_SOURCES, mergeRecessionSources, CONSENSUS_VINTAGE, FALLBACK_REGIMES, regimeSnapshot, regimeLogRow, RECESSION_SOURCE_CADENCE, ANNOUNCED_PRINTS, LABOR_ANNOUNCED } from "../lib/regimeEngine.js";

import { nextMeetingOdds } from "../lib/fedpath.js";
import HOLIDAYS from "../data/holidays.json";
import { SEC_YIELDS } from "../lib/cashyield.js";
  // one map, shared with the trade console
import { dubaiEtStamp } from "../lib/timeFmt.js";

// A page's own panel loads when the page opens, not with the dashboard: Today paints without the
// Console's or Gamma's code. Each is its own chunk; the Suspense fallback sits inside the tab's
// error boundary, so a chunk that fails to load shows that tab's error, not a blank page.
const named = (load, name) => lazy(() => load().then(m => ({ default: m[name] })));
const TradeConsole  = named(() => import("./TradeConsole.jsx"), "TradeConsole");
const GexPanel      = named(() => import("./GexPanel.jsx"), "GexPanel");
const FlowPanel     = named(() => import("./FlowPanel.jsx"), "FlowPanel");
const RatiosPanel   = named(() => import("./RatiosPanel.jsx"), "RatiosPanel");
const CalendarPanel = named(() => import("./CalendarPanel.jsx"), "CalendarPanel");
const TickerPanel   = named(() => import("./TickerPanel.jsx"), "TickerPanel");
const MlsPanel      = named(() => import("./MlsPanel.jsx"), "MlsPanel");
const PlanView      = named(() => import("./PlanView.jsx"), "PlanView");
const OpsPage       = named(() => import("./pages/OpsPage.jsx"), "OpsPage");
const DriversPage   = named(() => import("./pages/MarketsPage.jsx"), "DriversPage");
const HedgesView    = named(() => import("./pages/RiskPage.jsx"), "HedgesView");
const IncomeView    = named(() => import("./pages/RiskPage.jsx"), "IncomeView");
const ResearchPage  = named(() => import("./pages/ResearchPage.jsx"), "ResearchPage");
const AlertsPage    = named(() => import("./pages/AlertsPage.jsx"), "AlertsPage");













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
      await fetch("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=" + new Date().toISOString().slice(0,7).replace("-",""));
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
      analystBoard: { asOf: "2026-06-29", cadence: 90 }, recessionProse: { asOf: "2026-11-08", cadence: 30 },
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate sync from storage, the network or a prop change; kept as is so behaviour does not change
    if (!insurancePinned && insuranceSuggest?.phase && insuranceSuggest.phase !== insurancePhase) setInsurancePhase(insuranceSuggest.phase);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps deliberately narrowed: the omitted values derive from the listed ones, or adding them would re-fire the effect
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate sync from storage, the network or a prop change; kept as is so behaviour does not change
    if (!regimePin.pinned && liveRegime && activeRegime.id !== liveRegime.id) setActiveRegime(liveRegime);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps deliberately narrowed: the omitted values derive from the listed ones, or adding them would re-fire the effect
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps deliberately narrowed: the omitted values derive from the listed ones, or adding them would re-fire the effect
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps deliberately narrowed: the omitted values derive from the listed ones, or adding them would re-fire the effect
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate sync from storage, the network or a prop change; kept as is so behaviour does not change
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
        {/* Unusual Whales flow under the board (build step 8): hidden unless the session can read it. */}
        {tab === "gex" && <FlowPanel />}
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

        {/* ── RULES & ALERTS (src/pages/AlertsPage.jsx, lib/alerts.js) ── */}
        {tab === "alerts" && <AlertsPage />}

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
          <ResearchPage funds={funds} selectedFund={selectedFund} setSelectedFund={setSelectedFund} prices={prices} fetchPrices={fetchPrices}
            pricesLoading={pricesLoading} pricesUpdated={pricesUpdated} setTab={setTab} mstate={mstate} streetView={streetView}
            recession={{ liveInd, pbData, laborView, liveRegime, recConsensus, effectiveRecessionSources, recessionOverrides, setRecessionOverrides, stateFeed, recKalshi2027 }} />
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