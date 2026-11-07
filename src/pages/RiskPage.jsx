// src/pages/RiskPage.jsx — Risk & Plan › Hedges and Income: the crash-outcome matrix, the hedge
// phase and its ranked instruments, and the regime-ranked income list, each with its asset detail.
// Plan itself is src/PlanView.jsx. Moved out of App.jsx unchanged (7 Nov 2026, step 3 part 3).
import { C, P, alpha } from "../theme.js";
import { SLabel, Card, Btn, Pill } from "../ui.jsx";
import { ASSETS } from "../../lib/assets.js";
import { REGIMES } from "../../lib/regimes.js";
import { RadarChart, PolarGrid, PolarAngleAxis, Radar, ResponsiveContainer } from "recharts";
import { STATUS } from "../../lib/status.js";
import { expectedRank } from "../../lib/plan.js";
import { dubaiEt } from "../../lib/timeFmt.js";
import { liveCashYield, fillLiveRates } from "./cash.js";
import { INS_RANK_KEY, rankKeyFor, byRank } from "./ranking.js";
import { PriceBadge } from "./PriceBadge.jsx";

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
  { k:"recovery",  col:"recovery",  label:"Recovery / Post-Trough",    short:"Recovery",          color:P.emerald700, bg:P.emerald50, bdr:P.emerald200, desc:"VIX has peaked and is rolling over, credit has stopped widening, forced selling is exhausted — resolution not yet determined. This is THE BUY: gold miners, BTC and equities lead off the trough (the NYSE Arca Gold Miners Index ran +100% Oct'07→Mar'09 while the S&P fell 57%, +40% in Apr'20, +27% in a single day Nov'08 — all of it here, none in the collapse column). Sell the decay hedges into the vol collapse: holding the right hedge past its window is where most insurance P&L is given back. Miners here are a post-trough TRADE with a trigger, never a hedge and never a hold.", size:{ band:"insurance → ~0%", note:"unwind the decay hedges into the vol collapse and rotate the proceeds + dry powder into the recovery buy (miners / BTC / equities)." } },
  { k:"def",       col:"def",       label:"Deflationary Recession",    short:"Defl. Recession",   color:C.blue, bg:C.blBg, bdr:C.blBdr, desc:"Crash resolves through debt deflation — falling prices, Japan-style. TLT wins. Gold moderate. BTC loses. Same term as the regime on State: a deflationary recession, whether you're reading it (State) or hedging its arrival (here).", size:{ band:"10–18%", note:"the highest insurance allocation — TLT and SPY puts dominate; add IEF as a lower-vol duration alternative." } },
  { k:"inf",       col:"inf",       label:"Resolution: Debasement",    short:"Res: Debasement",   color:P.violet600, bg:P.violet50, bdr:P.violet300, desc:"Crash resolves through DEBASEMENT — Fed prints, dollar credibility erodes, currency stress, loss of monetary confidence. Gold and BTC win; TLT is a trap. This is a CRISIS — the OPPOSITE of Macro's 'Inflationary Boom' (a good, growth-strong outcome you'd want to be long). Read at speed, the shared word invites exactly the wrong action; hence 'Resolution: Debasement'. Its slow-motion, multi-year cousin — Financial Repression (negative real yields held for years, Japan-style) — is a Macro-tab regime STATE, not a crash resolution; see the Regime-shift scenarios there, not a column here.", size:{ band:"5–10%", note:"gold and BTC as MONETARY insurance (not crash insurance) — TLT is a trap here." } },
  { k:"stag",      col:"stag",      label:"Resolution: Stagflation",   short:"Res: Stagflation",  color:P.teal700, bg:P.teal50, bdr:P.teal300, desc:"Persistent stagflation — slow grind, not a sharp crash. Favour passive real-asset hedges (GLD, XLP, farmland, HYG puts) over active short instruments. Avoid VIX calls (contango) and SQQQ (daily decay). Size conservatively; favour longer-dated instruments to reduce theta bleed.", size:{ band:"8–15%", note:"gold / staples / HYG puts; size conservatively and favour longer-dated to cut theta bleed over a slow grind." } },
  { k:"hawkish",   col:"hawkish",   label:"Hawkish Rates Repricing",   short:"Hawkish Repricing", color:P.amber700, bg:C.oBg, bdr:P.orange200, desc:"Not a crash — a rates repricing (occurred 2026-07-31: gold −2.07%, TLT −0.87%, XLU −0.37%, XLP −0.80%, IWM −0.70%, BTC −1.8%, SPY roughly flat). Nothing hedges this except the front end. Duration is the risk, and every asset that competes with cash for yield gets sold simultaneously — including the defensives (GLD, TLT, staples) that work in every other scenario.", size:{ band:"front-end only", note:"nothing hedges a rates repricing except the front end (bills / USFR) — duration IS the risk." } },
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
  "INITIATE":    { color:P.emerald700, bg:P.emerald50, bdr:P.emerald200 },
  "BUY":         { color:P.emerald700, bg:P.emerald50, bdr:P.emerald200 },
  "STAGE":       { color:P.blue700, bg:C.blBg, bdr:C.blBdr },
  "ON PIVOT":    { color:P.blue700, bg:C.blBg, bdr:C.blBdr },
  "DEPLOY":      { color:P.blue700, bg:C.blBg, bdr:C.blBdr },
  "HOLD":        { color:P.gray500, bg:C.inset, bdr:P.gray200 },
  "HOLD LIGHT":  { color:P.gray500, bg:C.inset, bdr:P.gray200 },
  "WAIT":        { color:P.amber700, bg:C.oBg, bdr:P.orange200 },
  "CONDITIONAL": { color:P.amber700, bg:C.oBg, bdr:P.orange200 },
  "TRIM→cash":   { color:P.amber700, bg:C.oBg, bdr:P.orange200 },
  "AVOID":       { color:P.red700, bg:C.rBg, bdr:P.red200 },
  "SELL":        { color:P.rose700, bg:P.rose50, bdr:P.rose200 },
};

const actStyle = a => ACT_STYLE[a] || ACT_STYLE.HOLD;

// Part B — holding period + exit trigger by category. Three (plus tactical) different exit rules:
// most insurance losses come not from buying the wrong hedge but from holding the right hedge past
// its window. Rendered per cell (in the selected column) so the exit rule travels with the rating.
const HOLD_LOGIC = {
  decay:    { horizon:"days–weeks",           horizonShort:"days–wks",   exit:"VIX term structure flips back to contango",              exitShort:"vol → contango",       note:"Sold, not held — bleeds continuously (theta / contango roll / daily decay). Holding through the peak gives back the entire gain." },
  tactical: { horizon:"weeks — post-trough window", horizonShort:"wks",   exit:"the recovery rally matures / the resolution confirms",    exitShort:"rally matures",        note:"A VIX-peak TRADE, not a hedge and not a hold. Take the off-the-trough move; don't carry it into the resolution." },
  regime:   { horizon:"months — until the regime changes", horizonShort:"months", exit:"the measured regime on State changes",          exitShort:"regime flips",         note:"Exit on a regime change, NOT on a liquidity-phase drawdown — that drawdown is how liquid, profitable positions get sold to meet margin (gold −12% over 8 sessions Mar 2020, then all-time highs by August)." },
  cash:     { horizon:"until the deployment trigger", horizonShort:"to trigger", exit:"bills → duration at the pivot → equities 30–60d after the first cut", exitShort:"deployment sequence", note:"The only asset whose worst outcome is being right and doing nothing. Flips ✅✅→❌ on a REGIME change (Debasement — loses purchasing power), not on a phase change." },
};

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

const CA_TICKERS = new Set(["ENB", "FTS", "CNR"]); // Canadian names listed in USD on NYSE

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

// ─── ASSET DETAIL ─────────────────────────────────────────────────────────────
function AssetDetail({ asset, prices, onFetchPrices, pricesLoading, pricesUpdated, phase }) {
  const radarData = [
    { axis: "Crisis",     val: asset.crisisScore },
    { axis: "Inflation",  val: asset.inflationScore },
    { axis: "Deflation",  val: asset.deflationScore },
    { axis: "Liquidity",  val: asset.liquidityScore },
    { axis: "Stagflation",val: asset.stagScore },
  ];
  const fmtTime = d => (d ? dubaiEt(d) : "");
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
            <Btn onClick={() => onFetchPrices(tickers)} disabled={pricesLoading} color={C.onFill} bgColor={C.green} label={pricesLoading ? "Loading…" : "🔄 Prices"} />
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

// ── HEDGES ──
export function HedgesView({ insurancePhase, insuranceSuggest, planRegime, mstate, regimeProbFor, pbData, pickInsurancePhase, insurancePinned, followInsuranceSignal, liveInd, hedgeSorted, activeAsset, setActiveAsset, prices, fetchPrices, pricesLoading, pricesUpdated }) {
  return (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Item 4 — purpose line: the two tabs answer different questions. This one is about
                crash OUTCOMES, not the current regime. Item 5 — explicit macro→column link. */}
            {(() => {
              // Macro regimes that map to a crash-resolution column. inf (Inflationary Boom) and
              // ref (Reflationary Growth) are GROWTH regimes, not crashes — deliberately no map.
              const macroToCol = { stag: "stag", def: "def" };
              // The MEASURED regime (its leading quadrant; the whole mix ranks the assets), with the
              // consensus regime only while the axes have not loaded.
              const hr = planRegime;
              const hrPct = mstate.regime.available ? mstate.regime.probs[hr.id] : regimeProbFor(hr.id);
              const mappedCol = macroToCol[hr?.id] || null;
              const mappedPhase = mappedCol ? INSURANCE_PHASES.find(p => p.k === mappedCol) : null;
              const tapeHawkish = pbData?.us?.marketRegime?.state === "HAWKISH_RATES_REPRICING";
              // T2b — reactive best→worst insurance ranking for the LIVE regime, so opening the tab
              // immediately answers "given the regime, what's my best insurance and what to avoid."
              // Same rankKey the best→worst bars use elsewhere; growth regimes (inf/ref) still have a
              // real-asset ordering even though they aren't crash scenarios.
              const insRanked = mstate.regime.available
                ? expectedRank(ASSETS, mstate.regime.probs, INS_RANK_KEY)
                : [...ASSETS].sort(byRank(rankKeyFor(INS_RANK_KEY, hr?.id)));
              const insBest = insRanked.slice(0, 2);
              const insWorst = insRanked[insRanked.length - 1];
              return (
                <div style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 12, padding: "12px 16px" }}>
                  <div style={{ fontSize: 13.5, color: C.mid, lineHeight: 1.55 }}>
                    <b style={{ color: C.text }}>If a crash happens from here, how does it resolve — and what works in each case?</b>
                    <span style={{ color: C.muted }}> These columns are crash <i>outcomes</i>, not current-state regimes. (Markets › State answers “what regime are we in right now?”)</span>
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 13 }}>
                    <span style={{ color: C.lbl, fontWeight: 700 }}>{mstate.regime.available ? "Measured regime:" : "Consensus regime:"}</span>
                    <span style={{ color: hr?.color, fontWeight: 800 }}>{hr?.label} {hrPct}%{mstate.regime.available && mstate.regime.contested ? " (between regimes)" : ""}</span>
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
                        <button onClick={() => pickInsurancePhase("hawkish")} style={{ cursor: "pointer", background: C.oBg, color: P.amber700, border: "1.5px solid " + P.orange200, borderRadius: 6, padding: "3px 9px", fontWeight: 800, fontSize: 12 }}>
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
                    <span style={{ background: C.rBg, border: "1.5px solid " + P.red200, borderRadius: 6, padding: "2px 8px", fontWeight: 800, color: P.red700 }}>
                      {insWorst.icon} {insWorst.name}
                    </span>
                    <span style={{ color: C.muted, fontStyle: "italic", fontSize: 11.5 }}>{mstate.regime.available ? "ranked over the measured regime mix" : `ranked for ${hr?.label}`} — full order in the best→worst bar below</span>
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
                      background: on ? C.blue : C.surf, color: on ? C.onFill : C.mid,
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
                    <span style={{ fontSize: 11.5, color: C.muted, fontWeight: 700 }}>{diverged ? "⚠️ Conditions suggest" : "📡 Conditions →"}</span>
                    <button onClick={() => pickInsurancePhase(sp.k)} style={{ cursor: "pointer", background: sp.bg, color: sp.color, border: "1.5px solid " + sp.bdr, borderRadius: 6, padding: "2px 8px", fontWeight: 800, fontSize: 11.5 }}>{sp.short}</button>
                    <span style={{ fontSize: 11, color: C.muted, fontStyle: "italic" }}>{insuranceSuggest.why}</span>
                    {!insurancePinned && <span style={{ fontSize: 10.5, color: C.green, fontWeight: 800 }}>· auto (following signal)</span>}
                    {diverged && <button onClick={followInsuranceSignal} style={{ cursor: "pointer", background: C.green, color: C.onFill, border: "none", borderRadius: 6, padding: "2px 9px", fontWeight: 800, fontSize: 11 }}>Follow signal</button>}
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
                              color: on ? C.onFill : p.color,
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
                          <td colSpan={1 + shownPhases.length} style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: P.grey999, textTransform: "uppercase", padding: "10px 12px 4px", backgroundColor: "transparent", borderBottom: "none" }}>
                            {r.group}
                          </td>
                        </tr>
                      );
                      rows.push(
                        <tr key={r.row} style={{ background: ri % 2 === 0 ? C.surf : C.bg }}>
                          <td style={{ padding: "6px 10px", color: C.text, fontWeight: 600, borderBottom: "1px solid " + C.bdr, width: 168, minWidth: 168 }}>
                            {r.row}
                            {r.benchmark && <span style={{ display: "inline-block", marginLeft: 5, fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: P.blue700, background: C.blBg, border: "1px solid " + C.blBdr, borderRadius: 4, padding: "1px 4px", verticalAlign: "middle" }} title="Benchmark — not investable in this account">Benchmark · not investable</span>}
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
                const read = getCrashSignalRead(liveInd || {}, planRegime);
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
                <div style={{ marginTop: 10, padding: "12px 14px", background: P.emerald50, border: "1.5px solid " + P.emerald200, borderRadius: 10, borderTop: "4px solid " + P.emerald700 }}>
                  <div style={{ color: P.emerald700, fontWeight: 900, fontSize: 13.5, letterSpacing: 0.3, marginBottom: 2 }}>AT THE VIX PEAK — sell these, buy those</div>
                  <div style={{ color: C.muted, fontSize: 11.5, fontStyle: "italic", marginBottom: 10 }}>Trigger: VIX term structure flips backwardation → contango. The hedge doesn't need to profit — it needs to fund the buy.</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                    {[
                      { head: "🔻 SELL", tint: P.rose700, bg: P.rose50, bd: P.rose200, items: "VIX calls · SPY/QQQ puts · HYG puts · SQQQ", sub: "vol collapse + IV crush — the most expensive things to hold here" },
                      { head: "✅ BUY", tint: P.emerald700, bg: P.emerald50, bd: P.emerald200, items: "Gold miners · BTC · equities", sub: "highest beta to returning liquidity — miners lead off the trough" },
                      { head: "🔷 DEPLOY", tint: P.blue700, bg: C.blBg, bd: C.blBdr, items: "Cash → the above", sub: "the sale proceeds and dry powder fund the recovery buy" },
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
              const sorted = hedgeSorted;
              return (
                <div style={{ background: planRegime.bg, border: "1.5px solid " + planRegime.bdr, borderRadius: 14, padding: "14px 18px", borderTop: "4px solid " + planRegime.color }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: 2.5, textTransform: "uppercase", color: planRegime.color, fontWeight: 700, marginBottom: 3 }}>{mstate.regime.available ? "Measured regime mix · context" : "Consensus regime · context"}</div>
                      <div style={{ fontSize: 17, fontWeight: 900, color: planRegime.color }}>{mstate.regime.available && mstate.regime.contested ? "Between regimes" : planRegime.label} — Best → Worst Insurance</div>
                    </div>
                    <Pill label={mstate.regime.available ? "expected rank over the four regimes" : "measured state not loaded"} color={planRegime.color} />
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
                  {planRegime.id === "stag" && (
                    <div style={{ marginTop: 10, color: planRegime.color, fontSize: 14, lineHeight: 1.6 }}>
                      ⚠️ TLT dropped 30%+ in 2022 stagflation. Long bonds are the worst insurance when inflation is embedded. Physical gold and staples lead; the gold-linked miners follow (a cautioned, leveraged expression, not a hedge).
                    </div>
                  )}
                  {planRegime.id === "def" && (
                    <div style={{ marginTop: 10, color: planRegime.color, fontSize: 14, lineHeight: 1.6 }}>
                      📉 Deflation/recession: TLT is #1 insurance. Demand collapses, rates fall hard, gold acts as safe haven. Miners underperform until Fed pivots.
                    </div>
                  )}
                  {planRegime.id === "ref" && (
                    <div style={{ marginTop: 10, color: planRegime.color, fontSize: 14, lineHeight: 1.6 }}>
                      🌱 Reflationary growth: Staples and farmland outperform. Miners lag as gold safe-haven bid fades. TLT vulnerable to rising rates.
                    </div>
                  )}
                  {planRegime.id === "inf" && (
                    <div style={{ marginTop: 10, color: planRegime.color, fontSize: 14, lineHeight: 1.6 }}>
                      🔥 Inflationary boom: Physical gold is the best insurance; BTC and the gold-linked miners follow. Bonds are toxic. Real assets dominate — the leveraged farmland REIT lags the metals (2022: GDX −9% vs FPI −14%).
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Asset selector — sorted by active regime rank */}
            {(() => {
              const sorted = hedgeSorted;
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
                        boxShadow: activeAsset.id === a.id ? "0 2px 10px " + alpha(a.color, 0x20) : "none",
                      }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}>
                          <span style={{ fontSize: 19 }}>{a.icon}</span>
                          <span style={{ background: planRegime.bg, color: planRegime.color, border: "1px solid " + planRegime.bdr, borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 800 }}>#{i + 1}</span>
                        </div>
                        <div style={{ color: a.color, fontWeight: 800, fontSize: 13 }}>{a.name}</div>
                        <div style={{ color: C.lbl, fontSize: 11, marginTop: 3 }}>{planRegime.label}</div>
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
  );
}

// ── INCOME ──
export function IncomeView({ incomeSorted, planRegime, mstate, activeIncome, setActiveIncome, prices, fetchPrices, pricesLoading, liveInd }) {
  return (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* Regime-aware banner */}
            {(() => {
              const sorted = incomeSorted;
              const ir = planRegime;
              const measured = mstate.regime.available;
              return (
                <div style={{ background: ir.bg, border: "1.5px solid " + ir.bdr, borderRadius: 14, padding: "14px 18px", borderTop: "4px solid " + ir.color }}>
                  <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 11, letterSpacing: 2.5, textTransform: "uppercase", color: ir.color, fontWeight: 700, marginBottom: 3 }}>
                        {measured ? `Measured regime mix · ${["ref", "inf", "stag", "def"].map(id => `${(REGIMES.find(r => r.id === id)?.label || id).split(" ")[0]} ${mstate.regime.probs[id]}%`).join(" · ")}` : `Consensus regime · ${ir.label}`}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 900, color: ir.color }}>Income ranked best → worst {measured ? "across the regime mix" : "for this regime"}</div>
                    </div>
                    <Pill label={measured ? "expected rank over the four regimes" : "measured state not loaded"} color={ir.color} />
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {sorted.map((p, i) => {
                      const rankVal = i + 1;
                      const isTop = rankVal <= 2;
                      const isBottom = rankVal >= 5;
                      const dotColor = isTop ? C.green : isBottom ? C.red : C.amber;
                      return (
                        <button key={p.category} onClick={() => setActiveIncome(p)} style={{
                          background: C.surf, color: dotColor, border: "1.5px solid " + alpha(dotColor, 0x50),
                          borderRadius: 8, padding: "4px 10px", fontWeight: 700, fontSize: 13, cursor: "pointer",
                          display: "flex", alignItems: "center", gap: 5,
                        }}>
                          <span style={{ fontSize: 15 }}>{isTop ? "✅" : isBottom ? "⚠️" : "◐"}</span>
                          #{rankVal} {p.icon} {p.category.split(" / ")[0]}{p.expRank != null ? <span style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}> ({p.expRank})</span> : null}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ marginTop: 10, color: planRegime.color, fontSize: 13, lineHeight: 1.6 }}>
                    {{
                      stag: "Stagflation: pipelines + T-bills + REITs dominate. Avoid covered calls (capped upside in volatile regime). MLPs pass inflation through contracts.",
                      def:  "Deflation/recession: Cash (#1) is king — 4%+ risk-free while everything else reprices. Aristocrats (#2) hold dividends. Avoid pipelines (oil demand collapse) and covered calls.",
                      ref:  "Reflationary growth: REITs rally on rate cuts (#1). Aristocrats grow dividends with the economy (#2). Covered calls work in low-vol environment (#3).",
                      inf:  "Inflationary boom: pipelines pass through inflation via contract escalators (#1). Covered calls generate income in volatile market (#2). Cash erodes in real terms — avoid.",
                    }[ir.id]}{measured && mstate.regime.contested ? " Between regimes, the order above weighs all four columns by probability — the lead regime's note is shown." : ""}
                  </div>
                </div>
              );
            })()}

            {/* Category selector + detail — sorted by active regime */}
            {(() => {
              const sorted = incomeSorted;
              return (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", width: "100%" }}>
                    {sorted.map((p, i) => {
                      const rankVal = i + 1;
                      return (
                        <button key={p.category} onClick={() => setActiveIncome(p)} style={{
                          // All-longhand borders — see fund/asset selectors; the shorthand+longhand
                          // mix dropped the 4px left accent on click.
                          background: activeIncome.category === p.category ? p.bg : C.surf,
                          borderStyle: "solid",
                          borderTopWidth: 1.5, borderRightWidth: 1.5, borderBottomWidth: 1.5, borderLeftWidth: 4,
                          borderTopColor: activeIncome.category === p.category ? alpha(p.color, 0x60) : C.bdr,
                          borderRightColor: activeIncome.category === p.category ? alpha(p.color, 0x60) : C.bdr,
                          borderBottomColor: activeIncome.category === p.category ? alpha(p.color, 0x60) : C.bdr,
                          borderLeftColor: p.color,
                          borderRadius: 10, padding: "10px 12px", cursor: "pointer", textAlign: "left", flex: "1 1 120px",
                        }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                            <span style={{ fontSize: 17 }}>{p.icon}</span>
                            <span style={{ background: planRegime.bg, color: planRegime.color, border: "1px solid " + planRegime.bdr, borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 800 }}>#{rankVal}</span>
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
                            const at = incomeSorted.findIndex(p => p.category === activeIncome.category);
                            const rv = at >= 0 ? at + 1 : "?";
                            const isTop = rv <= 2; const isBot = rv >= 5;
                            const col = isTop ? C.green : isBot ? C.red : C.amber;
                            const bg  = isTop ? C.gBg  : isBot ? C.rBg  : C.aBg;
                            const bd  = isTop ? C.gBdr : isBot ? C.rBdr : C.aBdr;
                            return <Pill label={"#" + rv + (mstate.regime.available ? " across the regime mix" : " in " + planRegime.label)} color={col} bg={bg} bdr={bd} />;
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
                        <Btn onClick={() => fetchPrices(activeIncome.tickers.map(t => t.t))} disabled={pricesLoading} color={C.onFill} bgColor={C.green} label={pricesLoading ? "Loading…" : "🔄 Prices"} />
                      </div>
                      {activeIncome.tickers.map((tk, i) => (
                        <div key={tk.t} style={{ display: "flex", gap: 12, padding: "10px 0", borderBottom: i < activeIncome.tickers.length - 1 ? "1px solid " + C.bdr : "none", alignItems: "flex-start" }}>
                          <div style={{ flexShrink: 0, width: 70 }}>
                            <span title={tk.t} style={{ background: activeIncome.bg, color: activeIncome.color, border: "1.5px solid " + alpha(activeIncome.color, 0x40), borderRadius: 6, padding: "3px 5px", fontSize: tk.t.length > 8 ? 9 : tk.t.length > 5 ? 11 : 13, fontWeight: 800, display: "block", textAlign: "center", whiteSpace: "nowrap", maxWidth: 72, overflow: "hidden", textOverflow: "ellipsis" }}>{tk.t}</span>
                            {/* Rate-linked cash vehicles (BIL/SGOV/USFR) resolve their yield from
                                the live short rate rather than a hardcoded string — they all track
                                the same T-bill curve, so one live number keeps them consistent.
                                Equity/MLP yields below stay authored: they aren't rate-driven. */}
                            {(() => {
                              const cy = tk.rateLinked ? liveCashYield(liveInd) : null;
                              // The trailing dividend yield from the quote feed when it has one; the
                              // authored figure (marked as such) when it does not.
                              const dy = !tk.rateLinked && prices[tk.t]?.dividendYield > 0 ? prices[tk.t].dividendYield * 100 : null;
                              const txt = tk.rateLinked ? (cy ? `~${cy.value.toFixed(2)}%` : "—") : dy != null ? `${dy.toFixed(1)}%` : tk.yield ? `${tk.yield}†` : null;
                              if (!txt) return null;
                              return (
                                <span title={tk.rateLinked ? (cy ? `live ${cy.src}${cy.asOf ? " · " + cy.asOf : ""} — tracks the T-bill curve` : "no live short rate available") : dy != null ? "trailing 12-month dividend yield, live quote" : "† authored estimate — no live dividend yield for this listing"}
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
                                  <span title="Trailing 12-month dividend yield" style={{ fontSize: 11, color: P.green500, fontWeight: 600 }}>
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
  );
}
