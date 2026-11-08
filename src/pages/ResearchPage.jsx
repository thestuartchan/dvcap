// src/pages/ResearchPage.jsx — Research › Smart Money: the 13F matrix and fund cards, the consensus
// and absence rows, then the Street's view folded below (analyst board, recession panel). Moved out
// of App.jsx unchanged (8 Nov 2026, step 3 part 4).
import { useMemo } from "react";
import { C, P, alpha } from "../theme.js";
import { SLabel, Card, Btn, Pill, HandKept } from "../ui.jsx";
import { RecessionEntryPanel } from "./editors.jsx";
import { PriceBadge } from "./PriceBadge.jsx";
import { REGIMES } from "../../lib/regimes.js";
import { BarChart, Bar, RadarChart, PolarGrid, PolarAngleAxis, Radar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, LabelList } from "recharts";
import { HORIZON, HORIZON_LABEL, dispersionRead, NO_CONVERSION_NOTE } from "../../lib/recession.js";
import { buildViews, evaluateViews, regimeCluster, divergenceRead } from "../../lib/analystViews.js";
import { StreetCompare, Fold } from "../MarketState.jsx";
import { FED_LANGUAGE_STATUS } from "../../lib/fedLanguage.js";
import { recessionAsOfState, parseProbability, CONSENSUS_VINTAGE } from "../../lib/regimeEngine.js";
import { nextMeetingOdds } from "../../lib/fedpath.js";
import { COMPANY_NAMES } from '../../lib/companyNames.js';  // one map, shared with the trade console
import { dubaiEt } from "../../lib/timeFmt.js";

// ─── TOKENS ──────────────────────────────────────────────────────────────────
const SC = [C.blue,C.green,P.amber600,P.violet700,P.amber700,P.pink700,P.teal700,P.amber500];

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

// Bold in the body colour, for the figure in a sentence.
const B = ({ children }) => <b style={{ color: C.text }}>{children}</b>;

// The recession panel and analyst board — the Street's view.
function RecessionPanel({ liveInd, pbData, laborView, liveRegime, recConsensus, effectiveRecessionSources, recessionOverrides, setRecessionOverrides, stateFeed, recKalshi2027 }) {
  return (
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
                  <div style={{ marginBottom: 6 }}><HandKept asOf="2026-11-08" cadenceDays={30} what="after each data event that changes the recession read" /></div>
                  {/* Reframed 2026-11-08 after the Oct 28 FOMC hold and the October jobs report (rebuilt
                      2026-09-30 after August core PCE and JOLTS). EVERY NUMBER IS COMPUTED here from
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
                    const row = { display: "grid", gridTemplateColumns: "150px minmax(0, 1fr)", gap: "2px 10px", fontSize: 13, lineHeight: 1.55 };
                    return (
                      <div style={{ display: "grid", gap: 8, color: C.mid, fontSize: 13.5, lineHeight: 1.6 }}>
                        <div>
                          <span style={{ color: C.text, fontWeight: 700 }}>The signal that matters: </span>
                          the Fed paused on Oct 28 — held at 3.75–4.00% after the Sep 16 hike, 10–2, with Cook and Hammack voting to hike again — and the futures price {nx?.hikePct != null ? <B>{Math.round(nx.hikePct)}%</B> : "—"} odds of a hike on {nx?.meeting ? day(nx.meeting) : "the next meeting"}. Near-term recession odds are low; the risk is the one tightening builds, and credit is where it would show first.
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
                            <span>Calendar 2026 <span style={{ color: C.muted }}>(under two months left)</span></span>
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
}

// The page.
export function ResearchPage({ funds, selectedFund, setSelectedFund, prices, fetchPrices, pricesLoading, pricesUpdated, setTab, mstate, streetView, recession }) {
  return (
    <>
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
        {/* The Street's view, below the positioning: the measured regime beside the houses'
            consensus, then the recession panel and analyst board — a cross-check, folded. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
            <Fold title="The Street's view — analyst consensus and recession odds" hint="a cross-check on the measured regime; drives nothing">
              <StreetCompare st={mstate} street={streetView} />
              <RecessionPanel {...recession} />
            </Fold>
          </div>
    </>
  );
}
