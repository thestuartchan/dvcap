// src/pages/MarketsPage.jsx — Markets › Drivers: every gauge behind the measured state, with the deep
// panels each section opens (growth legs, labour, the classic recession signals, inflation legs, the
// CPI/PCE tracker, Fed pricing, credit detail, the yen flag). State itself is src/MarketState.jsx.
// Moved out of App.jsx unchanged (7 Nov 2026, step 3 part 3).
import { useState, useEffect } from "react";
import { C, P, alpha } from "../theme.js";
import { SLabel, Card, StaleChip, MetricGrid, MetricCard, HandKept } from "../ui.jsx";
import { cacheLoad, cacheSave } from "../cache.js";
import { CorrelationPanel } from "../CorrelationPanel.jsx";
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine, ReferenceArea } from "recharts";
import { withCommas } from "../../lib/kofia.js";
import { unInversionPhase, yieldCurveStatus, NORMAL_SPREAD } from "../../lib/yieldcurve.js";
import { STATUS, creditStatus } from "../../lib/status.js";
import { DriversView } from "../MarketState.jsx";
import { observationAge } from "../../lib/gates.js";
import { growthPulse, marketPulse, monthlyPulse, growthAxis } from "../../lib/growth.js";
import { marketInflation, nowcastInflation, printedInflation, inflationAxis } from "../../lib/inflationAxis.js";
import { FED_LANGUAGE_STATUS } from "../../lib/fedLanguage.js";
import { announced } from "../../lib/regimeEngine.js";
import { sahmAnnotation, laborSummary, laborDeteriorationTrigger, primeAgeRead, longTermRead, u6SpreadRead, payrollsRead, surveyDivergenceRead, quitsRead, revisionTrackerRead, twelveMonthAvgRead, ytdDivergenceRead } from "../../lib/labor.js";
import { coreSpread, monthName } from "../../lib/inflation.js";
import { nextMeetingOdds } from "../../lib/fedpath.js";
import { SEC_YIELDS, PROXY, secYieldProxy, proxyDivergence, proxyError, apyFromSec, billFromDiscount, BILL_DAYS, compareCash } from "../../lib/cashyield.js";
import { mergeIsm } from "../../lib/ismFeed.js";
import { InterventionToggle, FedPathCard, UsfrSecYieldForm, IsmEntryPanel } from "./editors.jsx";
import { liveCashYield } from "./cash.js";

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
    status:"AMBER", label:"Watch", color:C.amber, areaColor:P.amber500,
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
      {val:-0.5, label:"Deep inversion", color:P.red600, dash:"4 2"},
      {val:0,    label:"Inversion line",  color:P.amber600, dash:"5 3"},
      {val:1.0,  label:"Normal",          color:P.green600, dash:"4 2"},
    ],
    // Returns independent assessment based on this indicator's own live value
    signal(liveVal, hist) {
      // A MISSING PRINT IS NOT A READING. This used to substitute a hardcoded level and then
      // classify it, so a dead feed produced a confident status badge off a number nobody had
      // fetched — and the constant drifts: unemployment sat at 4.4 here while the live series
      // printed 4.1. There is no honest default for "what is the level", so say there isn't one.
      if (liveVal == null) return { label: "No print", text: "The live series is unavailable, so this indicator has no current reading. The chart below is history only.", state: "UNKNOWN" };
      const v = liveVal;
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
    id:"unemp", name:"Unemployment Rate", current:"—",
    status:"AMBER", label:"↑ since '23 low", color:C.amber, areaColor:P.amber500,
    dataKey:"unempHistory", data:UNEMP_DATA, refLine:4.0, yDomain:[3.0,5.5],
    yFmt: v=>`${v.toFixed(1)}%`,
    detail: (v) => `Currently ${v.toFixed(1)}% — rose from a 3.4% trough (Jan 2023), a ${(v - 3.4).toFixed(1)}pp rise. Sahm Rule triggers at 0.5pp above the 12-month low. ${v >= 4.5 ? "The Sahm Rule has triggered — recession risk is elevated." : v >= 4.0 ? "We are approaching the Sahm Rule threshold. Direction is the concern." : "Still below the Sahm Rule trigger zone."}`,
    thresholds:[
      {val:3.5, label:"Pre-pandemic low",   color:P.green600, dash:"4 2"},
      {val:4.0, label:"Historical avg",     color:P.amber600, dash:"5 3"},
      {val:4.5, label:"Sahm Rule zone",     color:P.red600, dash:"4 2"},
      {val:5.0, label:"Recession confirmed",color:P.red900, dash:"3 2"},
    ],
    signal(liveVal) {
      if (liveVal == null) return { label: "No print", text: "The live series is unavailable, so this indicator has no current reading. The chart below is history only.", state: "UNKNOWN" };
      const v = liveVal;
      if (v >= 5.5)  return { label:"Recession Confirmed",  text:"Unemployment above 5.5% — recession is underway by historical standards. At this level drawdown, not return, is the variable that decides the year.", state:"DANGER" };
      if (v >= 5.0)  return { label:"Recession Zone",       text:"Crossed 5.0% — recession historically confirmed at this level. Historically this is where defensive books were built, and where building one starts to cost.",              state:"DANGER" };
      if (v >= 4.5)  return { label:"Sahm Rule Triggered",  text:"At or above the Sahm Rule threshold. Labour market deteriorating — leading indicator for recession.",           state:"WATCH" };
      if (v >= 4.0)  return { label:"Elevated vs '23 low",  text:"Above the 4.0% historical average and well up from the 3.4% '23 trough — but that's the trend-since-low read; check the last-vs-prior print for near-term direction.", state:"ELEVATED" };
      return           { label:"Healthy",                   text:"Below historical average. Labour market resilient — low near-term recession risk from this indicator.",         state:"BENIGN" };
    },
  },
  {
    id:"credit", name:"HY Credit Spreads (ICE BofA OAS)", current:"2.75%",
    status:"GREEN", label:"Benign", color:C.green, areaColor:P.green500,
    dataKey:"creditHistory", data:CREDIT_DATA, refLine:4.5, yDomain:[1.5,7.0],
    yFmt: v=>`${v.toFixed(2)}%`,
    detail: (v) => `At ${v.toFixed(2)}%, markets are ${v < 3.0 ? "NOT pricing stress — calm conditions prevail" : v < 4.5 ? "beginning to price some stress — watch closely" : "pricing significant stress — act defensively"}. This is your best leading indicator. GFC peak: 21.8%. COVID peak: 10.9%. ${v >= 4.5 ? "⚠️ Alert threshold breached." : "Alert threshold: 4.5%."}`,
    thresholds:[
      {val:3.0, label:"Mild stress",         color:P.amber600, dash:"4 2"},
      {val:4.5, label:"⚠ Alert threshold",   color:P.orange500, dash:"5 3"},
      {val:6.0, label:"🔴 Recession likely", color:P.red600, dash:"4 2"},
    ],
    signal(liveVal) {
      if (liveVal == null) return { label: "No print", text: "The live series is unavailable, so this indicator has no current reading. The chart below is history only.", state: "UNKNOWN" };
      const v = liveVal;
      if (v >= 6.0)  return { label:"Recession Imminent",  text:"Spreads above 6% — markets pricing systemic stress. This is the deflationary trip wire: the regime in which Treasuries and cash are the assets that hold.", state:"DANGER" };
      if (v >= 4.5)  return { label:"Alert — breached",    text:"Breached the 4.5% alert threshold. Insurance bought from here is bought after the move, at the price the move set.",                      state:"DANGER" };
      if (v >= 3.5)  return { label:"Widening — Watch",    text:"Spreads widening toward the alert zone. Insurance is cheapest before 4.5% confirms it and dearest after.",                       state:"WATCH" };
      if (v >= 3.0)  return { label:"Mild Stress",         text:"Mild stress appearing. Markets slightly nervous but not panicking. Monitor weekly.",                                                  state:"ELEVATED" };
      return           { label:"Benign — No Stress",       text:"Markets are calm. No credit stress priced. Insurance is at its cheapest here, and stays cheap only until spreads move.",                 state:"BENIGN" };
    },
  },
];

// CPI tracker series colours — ONE definition shared by the headline tiles, the chart lines
// and the legend, so a tile can never drift out of sync with the line it labels.
const CPI_SERIES = { headline: P.red500, core: P.orange500, pce: P.violet500 };

function CashComparisonCard({ liveInd }) {
  const [cfg, setCfg] = useState(() => cacheLoad("cash_compare_v1", { bankRate: "3.65", conv: "apy", term: "6mo", usfrWht: "0", sgovWht: "0", posUsd: "53418" }));
  const set = (k, v) => setCfg(prev => { const next = { ...prev, [k]: v }; cacheSave("cash_compare_v1", next); return next; });
  // ── THE LIVE FIGURE WHERE THERE IS ONE ─────────────────────────────────────
  // Both rows used to be constants in the source: USFR at 3.71% as of 2026-08-06, SGOV at 3.57% as
  // of 2026-07-30. Read on 2026-09-10 those were 35 and 42 days old, and refreshing the dashboard
  // did nothing to either — they needed a code change and a deploy. The verdict a reader acts on
  // was computed from a figure five weeks old.
  //
  // iShares publishes SGOV's in the product page's structured data (3.62% as of 2026-09-08, against
  // the stored 3.57%). WisdomTree answers 403 to every route, so USFR keeps its published anchor.
  //
  // THE ASYMMETRY IS THE POINT, not a compromise. SGOV is the only fund of the two whose true value
  // can be observed, so it is the only way to measure what the proxy's error IS on a given day
  // rather than assuming the residual fitted months ago still holds — and that error is the honest
  // tolerance on USFR's estimate, which cannot be checked any other way.
  const liveSgov = liveInd?.fundYields?.SGOV?.value != null ? liveInd.fundYields.SGOV : null;
  // USFR's is hand-entered against the issuer link below — WisdomTree answers 403 to every
  // automated route while loading fine in a browser. A newer hand entry beats the constant in the
  // source; the constant remains the floor so the card never has nothing.
  const [entered, setEntered] = useState(null);
  useEffect(() => {
    fetch("/api/manual-entry").then(r => r.json()).then(j => setEntered(j?.secYields || null)).catch(() => {});
  }, []);
  const usfrEntry = entered?.USFR?.value != null && entered.USFR.asOf > SEC_YIELDS.USFR.asOf ? entered.USFR : null;
  const usfrSec = usfrEntry?.value ?? SEC_YIELDS.USFR.value;
  const usfrAsOf = usfrEntry?.asOf ?? SEC_YIELDS.USFR.asOf;
  const sgovSec = liveSgov?.value ?? SEC_YIELDS.SGOV.value;
  const sgovAsOf = liveSgov?.asOf ?? SEC_YIELDS.SGOV.asOf;
  const sgovIsLive = !!liveSgov;
  // Measured against the bill rate on the SAME date the issuer's figure is dated to, so the number
  // is the model's error and not the bill having moved since.
  const modelErr = liveSgov ? proxyError(liveSgov, liveInd?.tbill3m ?? null) : null;
  const bill = liveCashYield(liveInd);
  const posUsd = Math.max(0, Math.round(Number(String(cfg.posUsd).replace(/,/g, "")) || 0));
  const bankRateNum = cfg.bankRate === "" ? null : Number(cfg.bankRate);
  const isApy = cfg.conv === "apy";
  const bankApy = bankRateNum == null ? null : (isApy ? bankRateNum : apyFromSec(bankRateNum));
  const cmp = compareCash({ usfrSec, sgovSec, usfrWht: Number(cfg.usfrWht) || 0, sgovWht: Number(cfg.sgovWht) || 0, bankRate: bankRateNum, bankConvention: cfg.conv, positionUsd: posUsd });
  const pc = v => v == null ? "—" : `${v.toFixed(2)}%`;
  const rows = [
    { k: "USFR", sec: usfrSec, apy: apyFromSec(usfrSec), aw: cmp.rows.USFR.afterWht, liq: "T+1", credit: "US Govt", wht: `${Number(cfg.usfrWht) || 0}%`, whtTag: "✓ VERIFIED · Jul 30 2026 distribution", whtOk: true,
      asOf: usfrAsOf, live: false, entered: !!usfrEntry },
    { k: "SGOV", sec: sgovSec, apy: apyFromSec(sgovSec), aw: cmp.rows.SGOV.afterWht, liq: "T+1", credit: "US Govt", wht: `${Number(cfg.sgovWht) || 0}%`, whtTag: "⚠ UNVERIFIED · no SGOV distribution observed", whtOk: false, star: true,
      asOf: sgovAsOf, live: sgovIsLive },
    // The 6M bill is FRED DTB6, a DISCOUNT rate — not a fund SEC yield and not an APY. It used to
    // be dropped raw into all three columns, which both mislabelled it and understated it by ~17bp
    // against funds whose figures ARE compounded. It now shows its own quoted discount in the
    // first column and the real conversions beside it.
    bill && (() => {
      const b = billFromDiscount(bill.value, BILL_DAYS["6M"]);
      return b
        ? { k: bill.src, sec: b.discount, secNote: "discount", apy: b.apy, aw: b.apy, ce: b.couponEquiv, liq: "to maturity", credit: "US Govt", wht: "0%", whtTag: null }
        : { k: bill.src, sec: bill.value, secNote: "discount", apy: null, aw: null, liq: "to maturity", credit: "US Govt", wht: "0%", whtTag: null };
    })(),
    { k: "Bank deposit", sec: null, apy: bankApy, aw: bankApy, liq: "LOCKED", credit: "Bank", bank: true },
  ].filter(Boolean);
  const cols = ["", "Quoted", "APY", "After WHT", "Liquidity", "Credit"];
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
                <td style={{ padding: "5px 8px", textAlign: "right", color: C.mid, borderBottom: "1px solid " + C.bdr, whiteSpace: "nowrap" }}>
                  {pc(r.sec)}{r.secNote ? <span style={{ color: C.muted, fontSize: 10, fontWeight: 700 }}> {r.secNote}</span> : null}
                </td>
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
              background: cfg.conv === cv ? C.blue : C.surf, color: cfg.conv === cv ? C.onFill : C.mid }}>{cv === "apy" ? "APY" : "simple"}</button>
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
      {/* ── HOW OLD IS EACH FIGURE, AND HOW FAR OFF IS THE ONE THAT CANNOT BE CHECKED ──
          The table used to present two fund yields as if they were the same kind of thing. One is
          now fetched from the issuer and two days old; the other is a constant in the source and
          five weeks old, because WisdomTree answers 403 to every route. A reader comparing them is
          entitled to know that, and to know how far the estimate for the unfetchable one is likely
          to be out — which SGOV, the fund that CAN be observed, is the only evidence for. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 8 }}>
        {rows.filter(r => r.asOf).map(r => {
          // eslint-disable-next-line react-hooks/purity -- Date.now for an age label; each render refreshes it, which is the intent
          const age = Math.round((Date.now() - Date.parse(r.asOf + "T00:00:00Z")) / 86400000);
          return (
            <div key={`v-${r.k}`} style={{ fontSize: 11, color: r.live ? C.mid : C.amber }}>
              <b>{r.k}</b> {r.sec}% — {r.live
                ? <>live from the issuer, as of {r.asOf} ({age}d)</>
                : <>{r.entered ? "hand-entered" : "a stored figure"} from {r.asOf} ({age}d) — its issuer blocks automated reads, so this one is refreshed by hand</>}
            </div>
          );
        })}
        {/* ── THE HAND ENTRY, WITH THE LINK ──
            The figure cannot be fetched, so the next best thing is making it a ten-second job:
            the exact page, the exact field to copy, and the fund's own as-of date rather than
            today's — stamping a two-day-old figure with the moment it was typed is the defect this
            whole card is being fixed for. */}
        <UsfrSecYieldForm liveInd={liveInd} onSaved={setEntered} />
        {modelErr ? (
          <div style={{ fontSize: 11, color: modelErr.diverged ? C.amber : C.muted }}>
            The bill-based estimate {modelErr.note.replace(/^checked/, "was checked")} — treat USFR&rsquo;s
            estimate, which has no issuer figure to check against, with the same tolerance.
          </div>
        ) : null}
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
  { val: 3.0, label: "Mild stress",       color: P.amber600, dash: "4 2" },
  { val: 4.5, label: "Alert threshold",   color: P.orange500, dash: "5 3" },
  { val: 6.0, label: "Recession likely",  color: P.red600, dash: "4 2" },
];

// ─── CREDIT BLOCK (P2 / F.2) ──────────────────────────────────────────────────
// The master credit gauge: the published OAS with its real observation date, beside a live
// HYG proxy that is explicitly NOT the spread. Defined ONCE and rendered once. It used to sit
// nested inside the Global Playbook cross-asset card; F.2 puts it near the top of the Macro
// tab. Keeping a second copy on Playbook would reintroduce exactly the drift section C removed
// for the labour module, so this MOVED rather than being duplicated.
function CreditBlock({ credit, oas, hyg, reconSummary, history, depth = "full" }) {
  // A missing HYG read used to return nothing, so the master gauge vanished without a word whenever
  // the playbook payload had not loaded. It now says so.
  if (!hyg) {
    return (
      <Card style={{ borderLeft: "4px solid " + C.bdr }}>
        <SLabel>HY Credit Spread — master gauge</SLabel>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55 }}>
          The playbook feed (HYG proxy, OAS series) has not loaded{oas?.value != null ? ` — last HY OAS ${oas.value}%${oas.date ? ` (${oas.date})` : ""}` : ""}.
          The conditions score reads HY and IG OAS directly from FRED; see Markets › State.
        </div>
      </Card>
    );
  }
  // I.1/I.2 — the master gauge carries a status badge, so it carries a matching accent bar.
  // A missing OAS is NO READ, not BENIGN: a blank used to be painted as calm credit.
  const cst = creditStatus(oas?.value) ?? null;
  const ctok = STATUS[cst] ?? { color: C.muted, bg: C.inset, bdr: C.bdr };

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
              <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.5, color: ctok.color, background: ctok.bg, border: "1px solid " + ctok.bdr, borderRadius: 5, padding: "2px 8px" }}>{cst ?? "NO READ"}</span>
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
        </div>
      </Card>
    );
  }

  return (
    <Card style={{ borderLeft: "4px solid " + ctok.color }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
        <SLabel>💳 Credit — master gauge</SLabel>
        <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.5, color: ctok.color, background: ctok.bg, border: "1px solid " + ctok.bdr, borderRadius: 5, padding: "2px 8px" }}>{cst ?? "NO READ"}</span>
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

const AXIS_STATUS = { confirmed: null, "turning-down": "WATCH", "turning-up": "WATCH", split: "WATCH", "market-only": "WATCH", "data-only": "WATCH", insufficient: "WATCH" };

function GrowthLegBlock({ title, p, kind }) {
  const tok = STATUS[p.status] || STATUS.WATCH;
  const fmtLeg = l => l.value == null ? "—"
    : l.unit === "k" ? (l.value >= 1000 ? `${(l.value / 1000).toFixed(2)}M` : `${Math.round(l.value)}k`)
    : l.unit === "x" ? l.value.toFixed(3)
    : l.unit === "idx" ? `${l.value >= 0 ? "+" : "−"}${Math.abs(l.value).toFixed(2)}`
    : l.unit === "h" ? `${l.value.toFixed(1)}h`
    : l.unit === "pmi" ? l.value.toFixed(1)
    : l.unit === "$" ? `$${l.value.toFixed(0)}`
    : kind === "inflation" ? `${l.value.toFixed(2)}%`
    : `${l.value >= 0 ? "" : "−"}${Math.abs(l.value).toFixed(1)}%`;
  const subOf = l => {
    if (!l.available) return <span style={{ fontSize: 11, fontWeight: 700, color: C.amber }}>excluded</span>;
    const t = l.trendBp != null ? `${l.trendBp >= 0 ? "+" : "−"}${Math.abs(l.trendBp)}bp 20s`
      : l.change != null ? (l.unit === "h" ? `${l.change >= 0 ? "+" : "−"}${Math.abs(l.change).toFixed(1)}h 3m`
        : `${l.change >= 0 ? "+" : "−"}${Math.abs(l.change).toFixed(1)}% ${kind === "market" ? "20s" : kind === "monthly" ? "3m" : "q/q"}`)
      : l.unit === "idx" && l.delta != null ? `${l.delta >= 0 ? "+" : "−"}${Math.abs(l.delta).toFixed(2)} m/m`
      : l.unit === "pmi" && l.delta != null ? `${l.delta >= 0 ? "+" : "−"}${Math.abs(l.delta).toFixed(1)} m/m`
      : l.trend != null ? `${l.trend >= 0 ? "+" : "−"}${Math.abs(l.trend).toFixed(1)} 4w`
      : l.delta != null ? `${l.delta >= 0 ? "+" : "−"}${Math.abs(l.delta).toFixed(1)}pp` : null;
    const vote = l.score > 0 ? "▲" : l.score < 0 ? "▼" : "•";
    // Growth up is benign; inflation up is not. The colour follows the axis, the arrow the sign.
    const upCol = kind === "inflation" ? STATUS.ELEVATED.color : STATUS.BENIGN.color;
    const dnCol = kind === "inflation" ? STATUS.BENIGN.color : STATUS.ELEVATED.color;
    return <span style={{ fontSize: 12, fontWeight: 800, color: l.score > 0 ? upCol : l.score < 0 ? dnCol : C.mid }}>{vote}{t ? ` ${t}` : ""}</span>;
  };
  return (
    <div style={{ borderTop: "1px solid " + C.bdr, paddingTop: 10, marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <SLabel>{title}</SLabel>
        <span style={{ fontSize: 15, fontWeight: 900, color: tok.color }}>{p.label}</span>
        <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.5, color: tok.color, background: tok.bg, border: "1px solid " + tok.bdr, borderRadius: 5, padding: "1px 7px" }}>{p.status}</span>
        <span style={{ fontSize: 11, color: C.lbl, fontWeight: 700 }}>{p.usable} of {p.of} · {p.agreement}</span>
      </div>
      <div style={{ fontSize: 12.5, color: C.text, marginTop: 4, lineHeight: 1.5 }}>{p.read}.</div>
      {p.flipsIf && <div style={{ fontSize: 12, color: C.muted, marginTop: 3, lineHeight: 1.5 }}>↪ {p.flipsIf}</div>}
      <div className="mwd-metric-grid" style={{ marginTop: 8 }}>
        {p.legs.map(l => (
          <MetricCard key={l.key} label={l.label}
            labelRight={l.handKept ? <span title="Hand-keyed from the release, not a live feed" style={{ fontSize: 10, color: C.muted }}>✍</span> : null}
            title={l.available ? `${l.read} · obs ${l.date}` : `${l.label}: ${l.reason}`}
            value={fmtLeg(l)} valueColor={l.available ? undefined : C.muted}
            sub={subOf(l)} />
        ))}
      </div>
      {p.excluded.length > 0 && (
        <div style={{ fontSize: 11.5, color: C.amber, marginTop: 8, lineHeight: 1.5 }}>
          Excluded: {p.excluded.map(e => `${e.label} — ${e.reason}`).join(" · ")}
        </div>
      )}
      {p.unverified.length > 0 && (
        <div style={{ fontSize: 11.5, color: C.amber, marginTop: 6, lineHeight: 1.5 }}>
          Series identity unverified: {p.unverified.map(u => `${u.key} (${u.mismatch})`).join(" · ")}
        </div>
      )}
      {p.vintage && (
        <div style={{ fontSize: 11, color: C.lbl, marginTop: 6 }}>
          Oldest usable print {p.vintage.bizDays} business day{p.vintage.bizDays === 1 ? "" : "s"} old
        </div>
      )}
    </div>
  );
}

function GrowthPulsePanel({ growth, market, monthly, ism, ismFeed, onIsmChange }) {
  if (!growth && !market && !monthly) return null;
  const weekly = growthPulse(growth || {});
  const mkt = marketPulse(market || {});
  const mon = monthlyPulse(monthly || {}, { ism: mergeIsm(ismFeed?.ok ? ismFeed : null, ism) });
  const axis = growthAxis({ market: mkt, weekly, monthly: mon });
  // The card's own status: agreement takes the legs' shared status; any disagreement is WATCH,
  // because a turning point is the state that is not actionable alone.
  const st = AXIS_STATUS[axis.state] ?? weekly.status;
  const tok = STATUS[st] || STATUS.WATCH;
  return (
    <Card style={{ borderLeft: "4px solid " + tok.color }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div style={{ minWidth: 260, flex: "1 1 320px" }}>
          <SLabel>Growth axis</SLabel>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.5, color: tok.color, textTransform: "uppercase" }}>{axis.state.replace("-", " ")}</span>
            {axis.state !== "confirmed" && axis.balance && <span style={{ fontSize: 13, fontWeight: 800, color: C.mid }}>leans {axis.balance}</span>}
            <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.5, color: tok.color, background: tok.bg, border: "1px solid " + tok.bdr, borderRadius: 5, padding: "2px 8px" }}>{st}</span>
          </div>
          <div style={{ fontSize: 12.5, color: C.text, marginTop: 4, lineHeight: 1.5 }}>{axis.read}.</div>
        </div>
        <div style={{ background: tok.bg, border: "1px solid " + tok.bdr, borderRadius: 8, padding: "8px 12px", maxWidth: 380 }}>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: C.mid, lineHeight: 1.7 }}>
            <div>Claims:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;4wk avg ±10% vs a quarter ago</div>
            <div>Continuing:&nbsp;&nbsp;4wk avg ±5% vs a quarter ago</div>
            <div>WEI:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;≥1.5 trend · &lt;0 contraction</div>
            <div>GDPNow:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;≥2.0 trend · &lt;1.0 stall-speed</div>
            <div>Ratios:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;±2% over 20 sessions (breadth 1.5, copper/gold 4)</div>
            <div>CFNAI 3m:&nbsp;&nbsp;&nbsp;&nbsp;≥0 trend · ≤−0.70 recession signal</div>
            <div>Temp help:&nbsp;&nbsp;&nbsp;±1.5% over 3 months</div>
            <div>Mfg hours:&nbsp;&nbsp;&nbsp;±0.3h over 3 months</div>
            <div>ISM:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;≥52 momentum · &lt;50 contraction · from ISM's release on PR Newswire, 35d</div>
          </div>
          <div style={{ fontSize: 11.5, color: tok.color, lineHeight: 1.55, marginTop: 6 }}>
            The market leads the weekly data by one to three months; the weekly data leads the monthly leading series by another month; all three lead the payroll headline below. One axis, four vintages.
          </div>
        </div>
      </div>
      <GrowthLegBlock title="Market-implied" p={mkt} kind="market" />
      <GrowthLegBlock title="Weekly data" p={weekly} kind="weekly" />
      <GrowthLegBlock title="Monthly leading" p={mon} kind="monthly" />
      <IsmEntryPanel entry={ism} feed={ismFeed} onChange={onIsmChange} />
    </Card>
  );
}

// ── F.7 — the inflation axis: market, nowcast, printed, read against each other ───────────────
// Breakevens and oil price inflation daily; the Cleveland Fed nowcasts the current month each
// business day; the BLS and BEA print last. Same shape as the growth card, same discipline.
function InflationAxisPanel({ data, liveInd }) {
  if (!data) return null;
  const market = marketInflation(data);
  const nowcast = nowcastInflation(data.cleveland || {});
  const printed = printedInflation({
    coreCpiYoY: liveInd?.cpiCoreCurrent != null ? { value: liveInd.cpiCoreCurrent, date: liveInd?.asOf?.cpiCoreCurrent ?? null } : null,
    corePceYoY: liveInd?.pceCoreCurrent != null ? { value: liveInd.pceCoreCurrent, date: liveInd?.asOf?.pceCoreCurrent ?? null } : null,
    coreCpiIdx: data.coreCpiIdx || null,
  });
  const axis = inflationAxis({ market, nowcast, printed });
  const st = axis.state === "confirmed" ? (nowcast.status !== "WATCH" ? nowcast.status : printed.status) : "WATCH";
  const tok = STATUS[st] || STATUS.WATCH;
  const cl = data.cleveland;
  return (
    <Card style={{ borderLeft: "4px solid " + tok.color }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div style={{ minWidth: 260, flex: "1 1 320px" }}>
          <SLabel>Inflation axis</SLabel>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 22, fontWeight: 900, letterSpacing: -0.5, color: tok.color, textTransform: "uppercase" }}>{axis.state.replace("-", " ")}</span>
            {axis.state !== "confirmed" && axis.balance && <span style={{ fontSize: 13, fontWeight: 800, color: C.mid }}>leans {axis.balance}</span>}
            <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.5, color: tok.color, background: tok.bg, border: "1px solid " + tok.bdr, borderRadius: 5, padding: "2px 8px" }}>{st}</span>
          </div>
          <div style={{ fontSize: 12.5, color: C.text, marginTop: 4, lineHeight: 1.5 }}>{axis.read}.</div>
          {cl?.ok && (
            <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4, lineHeight: 1.5 }}>
              Cleveland Fed nowcast {cl.period}: CPI {cl.cpi?.toFixed(2)}% · core CPI {cl.coreCpi?.toFixed(2)}% · PCE {cl.pce?.toFixed(2)}% · core PCE {cl.corePce?.toFixed(2)}% y/y · as of {cl.asOf}{cl.cache ? " · cached" : ""}
            </div>
          )}
        </div>
        <div style={{ background: tok.bg, border: "1px solid " + tok.bdr, borderRadius: 8, padding: "8px 12px", maxWidth: 380 }}>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: C.mid, lineHeight: 1.7 }}>
            <div>Core y/y:&nbsp;&nbsp;&nbsp;&nbsp;≥3.0 hot · ≤2.5 at target</div>
            <div>5Y/10Y BE:&nbsp;&nbsp;&nbsp;≥2.5 hot · ≤2.0 cool</div>
            <div>Oil:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;±10% over 20 sessions</div>
            <div>Nowcast:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Cleveland Fed, each business day</div>
          </div>
          <div style={{ fontSize: 11.5, color: tok.color, lineHeight: 1.55, marginTop: 6 }}>
            The market leads the nowcast by weeks; the nowcast leads the print by a month. A hot read on the printed legs alone is last month's inflation.
          </div>
        </div>
      </div>
      <GrowthLegBlock title="Market-implied" p={market} kind="inflation" />
      <GrowthLegBlock title="Cleveland Fed nowcast" p={nowcast} kind="inflation" />
      <GrowthLegBlock title="Printed data" p={printed} kind="inflation" />
    </Card>
  );
}

function LaborPanel({ labor, depth = "full", extras = null, announced: _announced = false }) {
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
                  { y: hi, c: C.green, d: "4 2" },
                  { y: hi - 0.25, c: P.amber600, d: "5 3" },
                  { y: hi - 0.5, c: P.red600, d: "4 2" },
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
            { val: +hi.toFixed(2), label: "12m high", color: C.green, dash: "4 2" },
            { val: +(hi - 0.25).toFixed(2), label: "Watch −0.25pp", color: P.amber600, dash: "5 3" },
            { val: +(hi - 0.5).toFixed(2), label: "Sahm equiv −0.5pp", color: P.red600, dash: "4 2" },
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
        <div style={{ fontSize: 11, color: C.lbl, marginTop: 6, lineHeight: 1.5 }}>
          Emp–pop (solid, left axis) vs U3 (dashed, right). {watchLine}
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

// C3 — market-implied odds at the NEXT FOMC. Was a hand-copied FedWatch figure (SEP_HIKE_ODDS,
// last 2026-08-24) that kept rendering for a month after the September meeting it described had
// hiked. Now derived live from the ZQ curve (lib/fedpath.js nextMeetingOdds).
const FED_LANGUAGE_STATES = {
  // Added 2026-09-27 on request: the scale stopped at a hawkish HOLD, so the Sep 16 hike had
  // nowhere to go. The mirror of active_easing at the other end.
  active_tightening: {
    label: "🔴🔴 Active Tightening",
    color: P.red700,
    bg: C.rBg,
    description: "Hiking cycle underway. The question is how many more and how fast, not whether.",
    watchFor: "Watch for: a pause signal, dissents against a hike, the dots' terminal rate moving, a labour-market crack that makes the next hike conditional.",
  },
  hawkish_hold: {
    label: "🔴 Hawkish Hold",
    color: P.red500,
    bg: C.rBg,
    description: "Higher for longer dominant. No acknowledgment of downside risks. Rate cuts not on the table.",
    watchFor: "Watch for: first mention of 'data dependent' flexibility, any acknowledgment of labor market softening, or dissenting dovish votes at FOMC.",
  },
  hawkish_tilt: {
    label: "🟠 Hawkish Tilt",
    color: P.orange500,
    bg: C.oBg,
    description: "Still holding but beginning to acknowledge growth risks or disinflation progress. 'Data dependent' language increasing.",
    watchFor: "Watch for: 'appropriate to begin discussing' rate adjustments, explicit acknowledgment of disinflation progress, two consecutive dovish dissenting votes.",
  },
  neutral: {
    label: "🟡 Neutral / Watching",
    color: P.yellow500,
    bg: P.yellow50,
    description: "Balanced language. Internal debate visible. Historical pivot precursor — typically 1-2 meetings before first cut.",
    watchFor: "Watch for: explicit 'easing may be appropriate' language, removal of 'higher for longer' phrasing, Fed Chair press conference tone shift.",
  },
  dovish_tilt: {
    label: "🟢 Dovish Tilt",
    color: P.green500,
    bg: C.gBg,
    description: "Explicit acknowledgment that policy needs to ease. First cut likely within 1-2 meetings.",
    watchFor: "Watch for: first actual cut, pace of subsequent cuts, terminal rate language.",
  },
  active_easing: {
    label: "🟢🟢 Active Easing",
    color: P.green600,
    bg: P.green100,
    description: "Cutting cycle underway. Focus shifts to pace and terminal rate.",
    watchFor: "Watch for: pause signals, re-acceleration of inflation, terminal rate guidance.",
  },
};

function ChartTip({ active, payload, label, fmt }) {
  if (!active || !payload || !payload.length) return null;
  return <div style={{ background: C.surf, border: "1px solid " + C.bdr, borderRadius: 8, padding: "8px 12px", boxShadow: "0 2px 8px rgba(0,0,0,.1)" }}>
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
                  // No live read: a dash, not the hard-coded figure from when this card was written,
                  // which rendered as if current with no date beside it.
                  "—";

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
            {/* The fixed status pill ("Watch") sat beside the live signal below and could disagree
                with it; the signal box is the status. */}
            {asOfLbl ? <span style={{ fontSize: 11, color: C.lbl, fontWeight: 700 }}>as of {asOfLbl}</span>
              : <span style={{ fontSize: 11, color: C.muted }}>no live read — the indicator feed has not loaded</span>}
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
                {(() => {
                  if (typeof ind.detail !== "function") return ind.detail;
                  const v = ind.id === "yield"  && live ? live.yieldSpread
                          : ind.id === "unemp"  && live ? live.unemployment
                          : ind.id === "credit" && live ? live.creditSpread
                          : null;
                  // Was a hardcoded level here too. detail() writes a full paragraph of analysis
                  // around whatever it is handed, so a stale constant produced a confident,
                  // specific, wrong read whenever the feed was down.
                  if (v == null) return "No live print for this series, so there is no current read. The chart and thresholds below are history.";
                  return ind.detail(v, (live && live[ind.dataKey]) || ind.data || []);
                })()}
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

// Fed pricing, the statement and the ZQ path (Drivers › Policy & rates).
function FedBlock({ liveInd }) {
  return (
    <>
              {(() => {
                const bps = liveInd?.impliedCutsBps ?? null;
                const cf = liveInd?.currentFedFunds ?? null, tb = liveInd?.tbill6m ?? null;
                // Each leg carries its own date, so a monthly fallback or a holiday-old bill shows.
                const cfSrc = /monthly/i.test(liveInd?.currentFedFundsSource || "") ? "funds (monthly avg)" : "EFFR";
                const dShort = (d) => d ? ` (${new Date(d + "T12:00:00Z").toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })})` : "";
                const nx = nextMeetingOdds(liveInd?.fedPathFeed ?? null);
                const mtgLabel = nx ? new Date(nx.meeting + "T12:00:00Z").toLocaleString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : null;
                const sept = nx ? nx.hikePct : null;
                const sixDir = bps == null ? null : bps > 10 ? "dovish" : bps < 0 ? "hawkish" : "neutral";
                const sixLean = bps == null ? null : bps > 10 ? 1 : bps < 0 ? -1 : 0;
                const septDir = !nx ? null : nx.cutPct >= 30 || sept <= 30 ? "dovish" : sept >= 45 ? "hawkish" : "neutral";
                const septLean = !nx ? null : septDir === "dovish" ? 1 : septDir === "hawkish" ? -1 : 0;
                let xread, xcol;
                if (septLean == null) { xread = "Next-meeting odds unavailable — the ZQ curve did not load."; xcol = C.muted; }
                else if (sixLean == null) { xread = `6-month path unavailable — showing the ${mtgLabel} read only.`; xcol = C.muted; }
                else if (sixLean !== 0 && septLean !== 0 && sixLean === septLean) { xread = `Aligned — both lean ${sixDir}. The near-term path and the ${mtgLabel} meeting point the same way.`; xcol = C.green; }
                else if (sixLean !== 0 && septLean !== 0 && sixLean !== septLean) { xread = `Diverge — the 6-month path leans ${sixDir} but ${mtgLabel} meeting odds lean ${septDir}. Trust the meeting read for ${mtgLabel}, the path for the trajectory.`; xcol = C.amber; }
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
                      {/* Both rows are live now: the 6-month path from FRED, the meeting odds from the ZQ
                          curve. The meeting row used to be copied from FedWatch by hand. */}
                      {nx?.asOf && <span style={{ marginLeft: "auto", fontSize: 10.5, color: C.muted }}>ZQ settle {nx.asOf}</span>}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      {row("6-month path", bps != null ? `${bps} bps` : "—", bps != null ? `${bps > 0 ? "cuts" : bps < 0 ? "hikes" : "flat"} priced · 6M bill ${tb != null ? tb.toFixed(2) : "—"}%${dShort(liveInd?.asOf?.tbill6m)} vs ${cfSrc} ${cf != null ? cf.toFixed(2) : "—"}%${dShort(liveInd?.asOf?.currentFedFunds)}` : "Fed funds / T-bill not loaded", bps != null ? dirCol(sixDir) : C.muted)}
                      {nx ? row(`${mtgLabel} meeting`, nx.cutPct > 0 ? `${nx.cutPct}% cut` : `${sept}%`, `${nx.cutPct > 0 ? "implied cut odds" : "implied hike odds"} · ${nx.contract} ZQ ${nx.impliedPost.toFixed(3)}% vs EFFR ${nx.effr.toFixed(2)}%`, dirCol(septDir))
                          : row("Next meeting", "—", "ZQ curve not loaded", C.muted)}
                    </div>
                    <div style={{ marginTop: 8, padding: "8px 11px", background: xcol === C.amber ? C.aBg : xcol === C.green ? C.gBg : C.bg, border: "1px solid " + (xcol === C.amber ? C.aBdr : xcol === C.green ? C.gBdr : C.bdr), borderRadius: 8, fontSize: 12.5, fontWeight: 700, color: xcol, lineHeight: 1.5 }}>
                      Cross-check: {xread}
                    </div>
                    {nx && <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 6, lineHeight: 1.5 }}>Read off {nx.method} ({nx.contract}): the post-meeting rate it implies, less today's EFFR, in quarter points. Risk-neutral, so close to — not exactly — a probability.</div>}
                  </Card>
                );
              })()}

              {/* Fed Language Status — manually updated after each FOMC (Update 2) */}
              {(() => {
                const currentState = FED_LANGUAGE_STATES[FED_LANGUAGE_STATUS.status] || FED_LANGUAGE_STATES.hawkish_hold;
                const cell = (label, text, italic) => (
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: P.grey888, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
                    <div style={{ fontSize: 12, marginTop: 2, color: italic ? P.grey555 : C.mid, fontStyle: italic ? "italic" : "normal", lineHeight: 1.5 }}>{text}</div>
                  </div>
                );
                return (
                  <Card style={{ borderLeft: "3px solid " + currentState.color }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                      <div>
                        <SLabel>Fed Language Status</SLabel>
                        <div style={{ color: currentState.color, fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>{currentState.label}</div>
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 4 }}>
                          <HandKept asOf={FED_LANGUAGE_STATUS.lastUpdated} cadenceDays={49} what="after each FOMC meeting or minutes release" />
                          <span style={{ fontSize: 12, color: C.muted }}>{FED_LANGUAGE_STATUS.lastEvent}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: P.grey888, textAlign: "right" }}>Next: {FED_LANGUAGE_STATUS.nextEvent}</div>
                    </div>
                    {/* Decision + vote + dissent + guidance — the meeting's actual character,
                        not just the state label. Dissent direction is the hawkish/dovish tell. */}
                    {FED_LANGUAGE_STATUS.decision && (
                      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 800, color: C.text, background: C.bg, border: "1.5px solid " + C.bdr, borderRadius: 6, padding: "4px 9px" }}>
                          {FED_LANGUAGE_STATUS.decision}
                        </span>
                        {FED_LANGUAGE_STATUS.vote && (
                          <span style={{ fontSize: 12, fontWeight: 800, color: currentState.color, background: currentState.bg, border: "1.5px solid " + alpha(currentState.color, 0x55), borderRadius: 6, padding: "4px 9px" }}>
                            Vote {FED_LANGUAGE_STATUS.vote}
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
                    {/* WHAT THE STATE IS AND WHAT WOULD MOVE IT — not what to hold in it. The three
                        instrument cells that sat here ("Rotate now. Sell USFR → Buy IEF same day.")
                        were a fifth surface issuing instructions, keyed to a label a person sets by
                        hand after each meeting. Fed context is the meeting's character and the tell
                        for the next one; the stance is the tape's, in one place. */}
                    <div style={{ marginTop: 12, background: currentState.bg, borderRadius: 8, padding: 12 }}>
                      {cell("This state", currentState.description)}
                      <div style={{ marginTop: 8 }}>{cell("Watch for", currentState.watchFor, true)}</div>
                    </div>
                  </Card>
                );
              })()}

              {/* The DAILY EFFR from the feed, not the monthly fed funds average: after the Sep 16 hike the
                  monthly figure still read 3.63 and a hand-entered futures price was measured against it,
                  overstating "moves priced" by a full hike. */}
              <FedPathCard effr={liveInd?.fedPathFeed?.effr ?? liveInd?.currentFedFunds ?? null} feed={liveInd?.fedPathFeed ?? null} />
    </>
  );
}

// The CPI / PCE tracker with the real-yield-on-cash read (Drivers › Inflation).
function InflationBlock({ liveInd }) {
  return (
    <>
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
                  { key: "USFR", label: "USFR", value: SEC_YIELDS.USFR.value, color: P.sky500,
                    detail: `SEC 30-day yield ${SEC_YIELDS.USFR.value}% — as of ${SEC_YIELDS.USFR.asOf} · ${SEC_YIELDS.USFR.src}` },
                  { key: "SGOV", label: "SGOV", value: SEC_YIELDS.SGOV.value, color: P.indigo500,
                    detail: `SEC 30-day yield ${SEC_YIELDS.SGOV.value}% — as of ${SEC_YIELDS.SGOV.asOf} · expense ${SEC_YIELDS.SGOV.expense}% · ${SEC_YIELDS.SGOV.src}` },
                  cashYield && { key: "bill", label: cashYield.src, value: cashYield.value, color: P.blue500,
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
                  : v >= 4.0 ? { t: "well above target", c: P.red500 }
                  : v >= 3.0 ? { t: "elevated",          c: P.orange500 }
                  : v >= 2.5 ? { t: "above target",      c: P.yellow500 }
                  : v >= 1.5 ? { t: "near target",       c: P.green500 }
                  :            { t: "below target",      c: P.blue500 };
                // WHICH MONTH. Three tiles carried a figure, a source and a delta, and never said what
                // period any of them covered — while CPI and PCE publish two and a half weeks apart, so
                // for half of every month they are not the same month. A reader comparing the tiles was
                // not told they might be comparing across a release.
                const reading = (label, val, sub, trend, seriesColor, obsDate) => {
                  const band = bandOf(val);
                  return (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: P.grey888, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 24, fontWeight: 700, color: seriesColor }}>{val != null ? val.toFixed(1) + "%" : "—"}</div>
                      <div style={{ fontSize: 11, color: P.grey888 }}>{sub}{obsDate ? <> · <b style={{ color: C.mid }}>{monthName(obsDate)}</b></> : null}</div>
                      {trendChip(trend)}
                      {band && <div style={{ fontSize: 10, fontWeight: 700, color: band.c, marginTop: 1 }}>● {band.t}</div>}
                    </div>
                  );
                };
                return (
                  <Card>
                    <SLabel>CPI Inflation Tracker</SLabel>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 4, marginBottom: 10 }}>
                      {reading("Headline CPI", headline, "YoY · BLS", trendOf(hHist), CPI_SERIES.headline, liveInd?.dates?.cpiHeadlineCurrent)}
                      {reading("Core CPI", core, "Ex food & energy · BLS", trendOf(cHist), CPI_SERIES.core, liveInd?.dates?.cpiCoreCurrent)}
                      {reading("Core PCE", pce, "Fed's preferred · BEA", trendOf(pHist), CPI_SERIES.pce, liveInd?.dates?.pceCoreCurrent)}
                    </div>
                    {/* ── THE GAP BETWEEN THE TWO CORE SERIES ──
                        Three tiles side by side invite the eye to read the smallest one, and for most
                        of the last year that was core CPI. The two measure the same idea and disagree
                        structurally: core PCE normally sits BELOW core CPI, because shelter is about a
                        third of the CPI basket and a much smaller share of PCE. So the sign of the gap
                        carries information the levels do not, and the card was not saying it.
                        Both figures are the same vintage as the tiles above — a spread built from two
                        release dates is a number about the calendar, not about inflation. */}
                    {(() => {
                      const sp = coreSpread(pce, core, {
                        pceDate: liveInd?.dates?.pceCoreCurrent, cpiDate: liveInd?.dates?.cpiCoreCurrent,
                      });
                      if (!sp) return null;
                      // ACROSS TWO MONTHS IT IS NOT A SPREAD. The comment above claims both figures
                      // share a vintage; nothing enforced it, and CPI publishes around the 11th while
                      // PCE publishes at month end — so for about two weeks of every month core CPI is
                      // a month ahead. The gap would move, the card would explain the move as
                      // inflation, and the cause would be the release calendar.
                      if (sp.sameVintage === false) {
                        return (
                          <div style={{ marginBottom: 12, padding: "8px 12px", background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 8 }}>
                            <div style={{ display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
                              <span style={{ fontSize: 10, fontWeight: 800, color: P.grey888, textTransform: "uppercase", letterSpacing: 0.5 }}>Core PCE − Core CPI</span>
                              <b style={{ fontSize: 15, color: C.amber }}>not comparable this week</b>
                            </div>
                            <div style={{ fontSize: 11.5, color: C.mid, marginTop: 4, lineHeight: 1.5 }}>
                              {sp.vintageNote}. The two tiles above are each correct for their own month;
                              the difference between them is not. It becomes a spread again when PCE catches up.
                            </div>
                          </div>
                        );
                      }
                      const col = sp.tone === "warn" ? C.amber : sp.tone === "watch" ? C.mid : C.green;
                      const bg  = sp.tone === "warn" ? C.aBg : C.bg;
                      const bdr = sp.tone === "warn" ? C.aBdr : C.bdr;
                      return (
                        <div style={{ marginBottom: 12, padding: "8px 12px", background: bg, border: "1px solid " + bdr, borderRadius: 8 }}>
                          <div style={{ display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
                            <span style={{ fontSize: 10, fontWeight: 800, color: P.grey888, textTransform: "uppercase", letterSpacing: 0.5 }}>Core PCE − Core CPI</span>
                            <b style={{ fontSize: 15, color: col }}>{sp.pp >= 0 ? "+" : "−"}{Math.abs(sp.pp).toFixed(2)}pp</b>
                            <span style={{ fontSize: 12, fontWeight: 700, color: col }}>{sp.label}</span>
                          </div>
                          <div style={{ fontSize: 11.5, color: C.mid, marginTop: 4, lineHeight: 1.5 }}>
                            {sp.divergent ? (
                              <>Core CPI at <b>{sp.cpi.toFixed(2)}%</b> reads close to target; core PCE at <b>{sp.pce.toFixed(2)}%</b> does not — and
                              {" "}<b>PCE is the series the Fed targets</b>. An inversion of this sign usually means the disinflation is concentrated
                              in shelter, which CPI weights far more heavily. Read the CPI tile alone and the card reports progress the Fed's own
                              gauge does not show.</>
                            ) : sp.inverted ? (
                              <>PCE above core CPI is the wrong way round, though both series sit near target — the usual shelter-driven discount
                              has not just closed but reversed.</>
                            ) : sp.inLine ? (
                              <>The two are within a tenth of a point, so the usual PCE discount to core CPI has gone. Neither series is currently
                              telling a different story from the other.</>
                            ) : (
                              <>The usual relationship: PCE below core CPI, which is what a much lighter shelter weight and a chained basket imply.
                              Nothing to reconcile between the two.</>
                            )}
                          </div>
                        </div>
                      );
                    })()}
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
                    {/* A3 — DTB3 proxy reconciliation, on ONE basis and at the RIGHT DATE.
                        DTB3 is a discount rate; a fund's SEC yield is bond-equivalent, so the bill is
                        converted before anything is subtracted from it. The residual is fitted against
                        the DTB3 print on the published figure's own date, so the ✓ tests the model
                        rather than how far the bill has drifted since the fund last restated. */}
                    {dtb3 != null && secDiv && (() => {
                      const bey = secYieldProxy(dtb3)?.bey;
                      return (
                      <div style={{ marginBottom: 12, padding: "8px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8, fontSize: 11.5 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                          <span style={{ fontWeight: 800, color: C.mid }}>3M T-bill (DTB3) <b style={{ color: C.text }}>{dtb3.toFixed(2)}%</b> <span style={{ color: C.lbl, fontWeight: 600 }}>discount</span>
                            {bey != null && <> → <b style={{ color: C.text }}>{bey.toFixed(2)}%</b> <span style={{ color: C.lbl, fontWeight: 600 }}>bond-equivalent</span></>}
                            <span style={{ color: C.lbl, fontWeight: 600 }}> · live · daily{liveInd?.asOf?.tbill3m ? ` · ${liveInd.asOf.tbill3m}` : ""}</span></span>
                          <span style={{ color: C.lbl, fontStyle: "italic" }}>SGOV &amp; USFR are pass-throughs of the bill<br />
                            <b>est</b> is a proxy for the published SEC yield — not an APY, which the comparison card computes separately</span>
                        </div>
                        {[["SGOV", PROXY.SGOV.formula], ["USFR", PROXY.USFR.formula]].map(([k, f]) => {
                          const d = secDiv[k];
                          const sign = (n) => (n >= 0 ? "+" : "") + n + "bp";
                          return (
                            <div key={k} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline", marginTop: 4 }}>
                              <span style={{ minWidth: 92, fontWeight: 700, color: C.mid }}>{k} est SEC</span>
                              <span style={{ fontWeight: 800, color: C.text }}>{d.est.toFixed(2)}%</span>
                              <span style={{ color: C.lbl }}>{f}</span>
                              <span style={{ color: C.muted }}>· published <b style={{ color: C.mid }}>{d.published.toFixed(2)}%</b> ({SEC_YIELDS[k].asOf}{d.ageDays != null ? `, ${d.ageDays}d ago` : ""})</span>
                              {/* The gap, ATTRIBUTED. Charging the whole thing to the model made a
                                  working proxy look broken every time the bill moved. */}
                              <span style={{ color: C.muted }}>· gap {sign(d.bp)} = {sign(d.modelBp)} model {sign(d.rateBp)} bill since</span>
                              <span style={{ fontWeight: 800, color: d.diverged ? C.amber : C.green }}>
                                {d.diverged ? `⚠ model off ${sign(d.modelBp)} — re-fit the residual` : "✓ model fits"}</span>
                              {d.stale && <StaleChip>published figure {d.ageDays}d old — refresh from the issuer page</StaleChip>}
                            </div>
                          );
                        })}
                      </div>
                      );
                    })()}
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
                          <ReferenceLine y={2} stroke={P.green500} strokeDasharray="4 3" ifOverflow="extendDomain" />
                          {/* Cash band: the funds and the bill rate sit within a few bps, so the
                              range is shaded once rather than drawn as three overlapping lines. */}
                          {cashLo != null && (
                            <ReferenceArea y1={cashLo} y2={cashHi} ifOverflow="extendDomain"
                              fill={P.blue500} fillOpacity={0.10} stroke={P.blue500} strokeOpacity={0.35} strokeDasharray="4 3" />
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
                            <span style={{ width: 14, height: 0, borderTop: "2px dashed " + P.green500, display: "inline-block" }} />
                            <b style={{ color: P.green500 }}>2%</b><span style={{ color: C.muted }}>Fed target</span>
                          </span>
                          {cashLo != null && (
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5 }}
                              title="Shaded band spans the cash yields below — they sit within a few bps of each other">
                              <span style={{ width: 14, height: 9, background: P.blue500, opacity: 0.18, border: "1px dashed " + P.blue500, display: "inline-block", borderRadius: 2 }} />
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
    </>
  );
}

// The page: src/MarketState.jsx's DriversView with these panels as its deep sections.
export function DriversPage({ mstate, stateFeed, liveInd, ismEntry, setIsmEntry, laborView, laborExtras, laborAnnounced, pbData, reconSummary, setLiveIntervention, setTab }) {
  return (
          <DriversView st={mstate} feed={stateFeed}
            deep={{
              growth: [
                { title: "Growth legs", hint: "market-implied, weekly claims and activity, monthly surveys", render: () => <GrowthPulsePanel growth={liveInd?.growth} market={liveInd?.growthMarket} monthly={liveInd?.growthMonthly} ism={ismEntry} ismFeed={liveInd?.ismFeed} onIsmChange={setIsmEntry} /> },
                { title: "Labour", hint: "payrolls, unemployment, emp-pop, Sahm", render: () => <LaborPanel labor={laborView} extras={laborExtras} announced={laborAnnounced} /> },
                { title: "Classic recession signals", hint: "the yield curve and the long-lead indicators", render: () => INDICATORS.filter(ind => ind.id !== "unemp" && ind.id !== "credit").map(ind => <IndicatorChart key={ind.id} ind={ind} live={liveInd} />) },
              ],
              inflation: [
                { title: "Inflation legs", hint: "market-implied, Cleveland nowcast, prints", render: () => <InflationAxisPanel data={liveInd?.inflationAxis} liveInd={liveInd} /> },
                { title: "CPI & PCE tracker", hint: "headline, core, and the real yield on cash", render: () => <InflationBlock liveInd={liveInd} /> },
                { title: "Cash against inflation", render: () => <CashComparisonCard liveInd={liveInd} /> },
              ],
              rates: [
                { title: "Fed pricing, statement and the futures path", hint: "bill-implied cuts, next-meeting odds, the ZQ strip", render: () => <FedBlock liveInd={liveInd} /> },
              ],
              credit: [
                { title: "Credit detail", hint: "OAS history, HYG proxy, print reconciliation", render: () => (
                  <CreditBlock history={liveInd?.creditHistory} credit={pbData?.us?.regime?.credit} oas={pbData?.us?.macro?.oas} hyg={pbData?.us?.hyg} reconSummary={reconSummary} />
                ) },
              ],
              dollar: [
                { title: "Yen intervention flag", hint: "automatic from USD/JPY and the MoF; set by hand to override", render: () => (
                  <InterventionToggle
                    jpyChangePct={pbData?.us?.cross?.fx?.rows?.find(r => r.sym === "JPY=X")?.changePct ?? null}
                    dxyChangePct={pbData?.us?.cross?.fx?.rows?.find(r => r.sym === "DX-Y.NYB")?.changePct ?? null}
                    onChange={setLiveIntervention}
                    auto={pbData?.us?.interventionAuto ?? null}
                  />
                ) },
              ],
            }}
            extra={{
              vol: (
                <>
                <CorrelationPanel />
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                  Dealer gamma, CTA levels and the vol regime by session are on{" "}
                  <button onClick={() => setTab("global")} style={{ background: "none", border: "none", padding: 0, color: C.blue, fontWeight: 700, cursor: "pointer", fontSize: 12 }}>Daily Overview</button>{" "}and{" "}
                  <button onClick={() => setTab("gex")} style={{ background: "none", border: "none", padding: 0, color: C.blue, fontWeight: 700, cursor: "pointer", fontSize: 12 }}>Gamma</button>.
                </div>
                </>
              ),
            }}
          />
  );
}
