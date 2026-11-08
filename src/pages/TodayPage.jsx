// src/pages/TodayPage.jsx — the Today page: the Daily Overview (GlobalPlaybook) and everything it
// draws — the region strips, posture card, cross-asset rows, Korea and Southbound inputs, the
// rates strip and the scenario board. Moved out of App.jsx whole (7 Nov 2026, step 3 part 2); the
// code is unchanged. App mounts GlobalPlaybook and reuses three of its editors on Ops.
import { useState, useEffect, Fragment } from "react";
import { C, P, alpha } from "../theme.js";
import { SLabel, Card, Btn, StaleChip, Pill, MetricGrid, MetricCard } from "../ui.jsx";
import { CtaPanel } from "../CtaPanel.jsx";
import { ScenarioBoard } from "../ScenarioBoard.jsx";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { kofiaStale, parseKofia, kofiaDisplay, kofiaStoredLine, KOFIA_NAME_BY_KEY, KOFIA_CURRENCY, KOFIA_FLOWS, toWonTrillions, koreaFlowRead, koreaFlowImplication, withCommas } from "../../lib/kofia.js";
import { seoulStamp } from "../../lib/koreaFetch.js";
import { freshnessText, humanizeAge } from "../../lib/sessions.js";
import { interventionAnnotation } from "../../lib/fx.js";
import { applyRegimeGuard } from "../../lib/posture.js";
import { readSnapshot, bookLine, ageText } from "../../lib/bookSnapshot.js";
import { regimeFlipsIf } from "../../lib/regime.js";
import { southboundTrend, southboundLevelTrend, southboundRead, ahPremiumRead, sbStale } from "../../lib/southbound.js";
import { mergeSouthbound } from "../../lib/hkexSouthbound.js";
import { STAGE_LABEL } from "../../lib/marketState.js";
import { trend as trendOf } from "../../lib/series.js";
import { handoffChain } from "../../lib/handoff.js";
import { businessDaysSince } from "../../lib/bondDays.js";
import { leadRegion, regionStamps } from "../../lib/overviewRegions.js";
import { ChinaPanel } from "../ChinaPanel.jsx";
import { cacheLoad, cacheSave } from "../cache.js";
import { InterventionAutoBlock } from "./editors.jsx";
import { PB_REGIONS } from "./regions.js";

// Change over N sessions, in basis points, from a dated FRED series. Returns null rather than
// approximating when the series does not reach back far enough.
function trendBps(series, lookbackDays) {
  const t = trendOf(series, { lookbackDays });
  return t ? Math.round(t.delta * 100) : null;
}


// ─── GLOBAL PLAYBOOK TAB ──────────────────────────────────────────────────────
// Live macro/semi spine + deterministic regime per region, from /api/playbook (no
// model). Asia additionally renders the Korea-local stress gate.
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
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color, background: alpha(color, 0x18), border: "1px solid " + alpha(color, 0x55), borderRadius: 5, padding: "2px 7px" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block" }} />
      {label}{clock ? " · " + clock + " local" : ""}
    </span>
  );
}
// "last print 2026-09-24 · stale · 2d" → "Sep 24 · 2d": the date and the age, which is what a
// stale chip on a macro tile has room for.
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function staleTileText(text) {
  const t = String(text || "").replace(/\s*·\s*stale\s*·\s*/, " · ").replace(/^stale\s*·\s*/, "");
  return t.replace(/^last print\s+/, "").replace(/\b\d{4}-(\d{2})-(\d{2})\b/, (_, m, d) => `${MONTHS_SHORT[+m - 1]} ${+d}`);
}

// Small reusable session/state chip used inside metric cards.
function StateChip({ label, color, filled }) {
  return (
    <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color,
      background: filled ? C.aBg : "transparent", border: "1px solid " + alpha(color, 0x55), borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
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
      title={r.note || [r.sym + " · 1D vs prior close",
                        r.series ? `series: ${r.series}` : null,
                        r.seriesNote || null,
                        age ? `last tick ${age.text}` : null].filter(Boolean).join(" · ")}
      value={r.price != null ? withCommas(+(+r.price).toFixed(2)) : "—"}
      labelRight={age ? <StateChip label={age.text} color={age.stale ? C.amber : C.lbl} /> : null}
    >
      {/* ANY TILE FEEDING A REGIME CLASSIFIER NAMES ITS SERIES. The gold tile read "Gold 4,450.2"
          against OANDA spot at 4,411.755 on 2026-09-09 — a 38-point gap that is basis rather than
          error, but the tile said only "Gold" while the debasement discriminator keys off it. */}
      {r.series && (
        <div style={{ fontSize: 9.5, color: C.lbl, fontWeight: 700, marginTop: 1 }}>{r.series}</div>
      )}
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
      {/* THE SAME MOVE IN THE DOLLAR'S FRAME. EUR/USD rises when the dollar weakens and USD/JPY
          falls when it does, so the row cannot be read left to right on its face — which is what
          the section heading asks the reader to do. The quoted percentage above is untouched;
          this is the second reading, so the cards and the note above them agree. */}
      {(() => {
        const u = r.usdLeg;
        return u ? (
          <div style={{ fontSize: 10, color: C.lbl, marginTop: 1, whiteSpace: "nowrap" }}
            title={u.inverted
              ? `${r.name} is quoted as dollars per ${u.vs}, so it moves opposite to the dollar. Inverted here so every leg reads the same way.`
              : `${r.name} is quoted as ${u.vs} per dollar, so it already moves with the dollar.`}>
            {u.label}
          </div>
        ) : null;
      })()}
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
              style={{ fontSize: 10.5, fontWeight: 700, color: c, border: "1px solid " + alpha(c, 0x55), background: alpha(c, 0x12), borderRadius: 5, padding: "2px 6px" }}>
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
// Defined at module scope, not inside PostureCard: a component created during render is a new
// component type on every render, so React remounts the subtree and any state in it resets.
const PostureRow = ({ label, children, color }) => (
  <div style={{ display: "flex", gap: 10, marginTop: 5, alignItems: "baseline" }}>
    <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5, minWidth: 66, flexShrink: 0 }}>{label}</span>
    <div style={{ fontSize: 12, color: color || C.mid, fontWeight: 600, lineHeight: 1.5 }}>{children}</div>
  </div>
);

// The tie-breaker between the two gold-down/bonds-down states. On any other day it decides nothing,
// and on 2026-10-07 it printed "defensives BID → flight to safety" beside "Reflationary growth".
const DISCRIMINATES = new Set(["HAWKISH_RATES_REPRICING", "DEFLATIONARY_RECESSION"]);
const TAPE_TONE = { "risk-off": C.red, "risk-on": C.green, mixed: C.amber };
function RegionChips({ rt }) {
  const order = ["asia", "eu", "us"].filter(k => rt?.[k]);
  if (!order.length) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
      {order.map(k => {
        const r = rt[k], col = TAPE_TONE[r.direction] || C.muted;
        return (
          <span key={k} title={`${r.line}${r.asOf ? ` · session of ${r.asOf}` : ""}`} style={{ fontSize: 11.5, fontWeight: 700, color: C.mid, background: C.surf,
            border: "1px solid " + (TAPE_TONE[r.direction] ? alpha(col, 0.45) : C.bdr), borderRadius: 999, padding: "2px 10px", maxWidth: "100%" }}>
            <b style={{ color: C.text }}>{r.label}</b> <b style={{ color: col }}>{r.direction}</b>
            {r.direction !== "unavailable" && r.direction !== "quiet" ? <span> · {r.text}</span> : null}
            {r.fx ? <span style={{ color: r.fx.weak ? C.amber : C.muted }}> · {r.fx.text}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

function PostureCard({ p: raw, regime = null, tape = null, layers = null, regionTape = null }) {
  // The regime probability is computed HERE, in the client, off user-set recession weights — so
  // it arrives after composePosture has already run on the server. The guard is therefore applied
  // to the composed object rather than reimplemented: "Stagflation 71%" and "RISK-ON" cannot both
  // be the correct top-line read, and on 2026-09-10 they were rendered on the same header row.
  const p = applyRegimeGuard(raw, regime);
  if (!p) return null;
  const col = p.tone === "red" ? C.red : p.tone === "green" ? C.green : p.tone === "amber" ? C.amber : C.muted;
  const bg  = p.tone === "red" ? C.rBg : p.tone === "green" ? C.gBg : p.tone === "amber" ? C.aBg : C.surf;
  const bdr = p.tone === "red" ? C.rBdr : p.tone === "green" ? C.gBdr : p.tone === "amber" ? C.aBdr : C.bdr;
  return (
    <Card style={{ background: bg, border: "1.5px solid " + bdr, borderTop: "5px solid " + col }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 2 }} title="The tape's what-to-do right now. Portfolio allocation lives on the Plan tab.">Tape stance</span>
        <span style={{ fontSize: 22, fontWeight: 900, color: col, lineHeight: 1.05 }}>{p.posture}</span>
        <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase" }}>weeks</span>
        {p.tripwires && (
          <span style={{ fontSize: 13, fontWeight: 800, color: C.muted }} title={p.tripwiresNote || undefined}>
            {p.tripwires} tripwires
            {/* A denominator that shrinks silently reads as a different state rather than the same
                state with a gauge unlit. */}
            {p.tripwiresDark > 0 && <span style={{ color: C.amber }}> · {p.tripwiresDark} dark</span>}
          </span>
        )}
      </div>
      {/* WHERE THE STRESS SITS — each region's own tape, beside the one board (lib/regionTape.js). */}
      <RegionChips rt={regionTape} />
      {/* THREE LAYERS, EACH WITH ITS CLOCK. On 2026-10-07 a weeks-long regime, a days-long scenario
          and today's tape sat on one card unlabelled, and read as a contradiction. */}
      {(layers?.regime || layers?.conditions || p.tape?.pattern) && (
        <div style={{ display: "flex", gap: "4px 14px", flexWrap: "wrap", marginTop: 8, fontSize: 12, color: C.mid }}>
          {layers?.regime && <span><b style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase" }}>Regime · weeks</b> <b style={{ color: C.text }}>{layers.regime}</b></span>}
          {layers?.conditions && <span><b style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase" }}>Conditions · days</b> <b style={{ color: C.text }}>{layers.conditions}</b></span>}
          {p.tape?.pattern && <span><b style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5, textTransform: "uppercase" }}>Tape · today</b> <b style={{ color: TAPE_TONE[p.tape.direction] || C.text }}>{p.tape.pattern.label}</b></span>}
        </div>
      )}
      {/* THE TAPE, SHOWN AS LEGS. A stance whose inputs are not visible is one nobody can check
          against their own screen — which is how RISK-ON survived a render that contradicted it
          in eleven places. Each leg carries its own daily range, so a tick that was too small to
          vote says so rather than being silently dropped. */}
      {p.tape?.legs?.length > 0 && (
        <PostureRow label="Tape" color={p.tape.direction === "risk-off" ? C.red : p.tape.direction === "risk-on" ? C.green : C.mid}>
          <span style={{ fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.3 }}>{p.tape.direction}</span>
          {p.tape.unconfirmed && <span style={{ color: C.muted, fontWeight: 600 }}> (equities not confirming)</span>}
          {p.tape.legs.map(l => (
            <span key={l.name} title={l.why || undefined} style={{ marginLeft: 8, fontVariantNumeric: "tabular-nums",
              color: l.vote == null ? C.lbl : l.vote < 0 ? C.red : l.vote > 0 ? C.green : C.lbl }}>
              {l.name} {l.value == null ? "n/a" : `${l.value >= 0 ? "+" : ""}${l.value}%`}
              {l.vote === 0 && l.value != null && <span style={{ color: C.lbl, fontWeight: 600 }}> ·</span>}
            </span>
          ))}
        </PostureRow>
      )}
      {/* ── THE TAPE CARD, FOLDED IN ─────────────────────────────────────────
          A standalone "Tape regime" card lower on the page showed this same session's legs a
          second time under its own heading, with the three lines the leg row above lacks: the
          label, what decided it, and the gold-pair read that disambiguates gold. One tape, one
          place — those lines now sit directly under the legs they explain. */}
      {tape && tape.state !== "INSUFFICIENT_DATA" && (
        <PostureRow label="Read" color={tape.color || C.mid}>
          <span style={{ fontWeight: 800 }}>{tape.label}</span>
          <span style={{ color: C.muted, fontWeight: 600 }}> · today's rotation</span>
          {tape.discriminator && DISCRIMINATES.has(tape.state) ? <span style={{ color: C.mid, fontWeight: 600 }}> — {tape.discriminator}</span> : null}
          {tape.reasons?.length > 0 && <div style={{ color: C.muted, fontWeight: 500, marginTop: 2, lineHeight: 1.45 }}>{tape.reasons.join(" · ")}</div>}
          {tape.corroboration && !tape.corroboration.available && (
            <div style={{ color: C.amber, fontWeight: 700, marginTop: 2 }}>{tape.corroboration.note}</div>
          )}
          {tape.goldPair && (
            <div style={{ marginTop: 2, color: tape.goldPair.available ? C.muted : C.amber, fontWeight: tape.goldPair.available ? 500 : 700, lineHeight: 1.45 }}>
              gold pair · {String(tape.goldPair.reading || "").replace(/_/g, " ")} — {tape.goldPair.note}
            </div>
          )}
        </PostureRow>
      )}
      {p.working?.length > 0 && <PostureRow label="Working" color={C.green}>{p.working.join(" · ")}</PostureRow>}
      {p.not?.length > 0 && <PostureRow label="Not" color={C.red}>{p.not.join(" · ")}</PostureRow>}
      {/* WHY NOT RISK-ON. A stance that has been withheld is a different statement from one that
          was never a candidate, and the reasons are the audit trail for the guards above. */}
      {p.blockedBy?.length > 0 && (
        <PostureRow label={p.withheld ? "No " + p.withheld : "Held by"} color={C.amber}>
          {p.blockedBy.map((b, i) => <div key={i} style={{ marginTop: i ? 2 : 0 }}>· {b}</div>)}
        </PostureRow>
      )}
      {/* THE SCORE, ITEMISED — every point and its source, against the thresholds that decide. */}
      {p.scoreText && <PostureRow label="Score">{p.scoreText}</PostureRow>}
      {/* DO, AS INSTRUCTIONS: new risk, the book against the limits, the hedge — then the closest
          IF/THEN playbook's current stage, the live book (this browser), and the scenario context. */}
      {(p.plan || p.do?.length > 0) && (() => {
        const t = (layers?.transitions || []).find(x => x.playbook && x.stage && x.stage !== "watch");
        const snap = readSnapshot();
        const bl = t && snap ? bookLine(t.id === "growthRolls" && !/Stagflation/.test(t.title) ? "growthBust" : t.id, snap) : null;
        return (
          <PostureRow label="Do">
            {p.plan?.newRisk && <div><b style={{ color: C.text }}>New risk:</b> {p.plan.newRisk}</div>}
            {p.plan?.book && <div style={{ marginTop: 2 }}><b style={{ color: C.text }}>Book:</b> {p.plan.book}{snap ? <span style={{ color: C.text }}> Now: gross {snap.gross?.toFixed(2)}× · swing {snap.swingX == null ? "—" : `${snap.swingX.toFixed(2)}×`} <span style={{ color: C.lbl, fontWeight: 500 }}>({ageText(snap)})</span></span> : null}</div>}
            {p.plan?.hedge && <div style={{ marginTop: 2 }}><b style={{ color: C.text }}>Hedge:</b> {p.plan.hedge}{snap?.hedges?.length ? <span style={{ color: C.text }}> Held: {snap.hedges.join(", ")}.</span> : null}</div>}
            {t && (
              <div style={{ marginTop: 4 }}>
                <b style={{ color: C.text }}>{t.title} · {STAGE_LABEL[t.stage]} ({t.proximity >= 100 ? "triggered" : `${t.proximity}%`}):</b> {t.playbook[t.stage]?.[0]}
                {bl ? <span style={{ color: C.text }}> — {bl}</span> : null}
              </div>
            )}
            {p.do?.length > 0 && <div style={{ marginTop: 4, color: C.muted, fontWeight: 500 }}>Context: {p.do.join(" · ")}</div>}
          </PostureRow>
        );
      })()}
      {p.watch && <PostureRow label="Watch" color={C.amber}>{p.watch}</PostureRow>}
      {/* FLIPS IF — the condition, in the stance's own terms, from the same branches that chose
          it. WATCH is what to look at; this is what has to happen. It used to exist only on the
          Read card, and the stance is where a reader needs it most. */}
      {p.flipsIf && <PostureRow label="Flips if" color={C.blue}>{p.flipsIf}</PostureRow>}
      {p.next?.length > 0 && (
        <PostureRow label="Next">{p.next.map(n => `${n.label} ${n.date.slice(5)} (${n.daysTo}d)`).join(" · ")}</PostureRow>
      )}
    </Card>
  );
}



// P7 — THE AUCTION CARD. On 2026-09-10 the 30-year settled at 1pm and nothing on this board
// mentioned it, on the morning the long end was the entire story and scenario C sat three tenths
// of a basis point from its trigger. B's watch list names "30Y auction tail / bid-to-cover" and
// there was nowhere to look.
//
// The tail is deliberately absent: it needs the when-issued yield at the bid deadline and no free
// feed carries it. Bid-to-cover against the trailing run of the SAME tenor is the honest version
// of the same question, and who took the paper is the part a cover can hide.
// Module scope: a component created during render is a new type every pass and remounts its
// subtree. `bn` rides along because both this and AuctionCard format the same offering sizes.
const bn = (v) => v == null ? "—" : "$" + (v / 1e9).toFixed(0) + "bn";
const AuctionResult = ({ x, label }) => (
  <div style={{ padding: "7px 10px", borderRadius: 8, background: C.surf, border: "1px solid " + C.bdr }}>
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</span>
      <span style={{ fontSize: 12.5, fontWeight: 900, color: C.mid }}>{x.label}</span>
      <span style={{ fontSize: 11, color: C.lbl, fontWeight: 700 }}>{x.auctionDate} · {bn(x.offering)}</span>
      <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 900, fontVariantNumeric: "tabular-nums",
                     color: x.read?.best ? C.green : x.read?.worst ? C.red : C.mid }}>
        {x.highYield != null ? x.highYield.toFixed(3) + "%" : "—"}
      </span>
    </div>
    {x.read?.note && <div style={{ fontSize: 11, color: C.mid, fontWeight: 600, marginTop: 3 }}>{x.read.note}</div>}
    {x.read?.dealerNote && (
      <div style={{ fontSize: 11, color: x.read.dealerHeavy ? C.amber : C.lbl, fontWeight: 600, marginTop: 1 }}>
        {x.read.dealerNote}
      </div>
    )}
    {/* The tail is named as absent rather than left off: a reader who knows to look for it needs
        to know it is unavailable, not wonder whether the card forgot. */}
    <div style={{ fontSize: 10, color: C.lbl, marginTop: 2 }} title={x.tailNote || undefined}>
      indirect {x.indirectShare ?? "—"}% · tail not published
    </div>
  </div>
);

function AuctionCard({ a }) {
  if (!a) return null;
  const done = a.today?.filter(x => x.bidToCover != null) || [];
  const last = a.lastLongEnd;
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
        <SLabel>🏛 Treasury supply</SLabel>
        <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>auction calendar · how the last long end went</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {done.map(x => <AuctionResult key={x.cusip + x.auctionDate} x={x} label="today" />)}
        {/* Only when today has none of its own — otherwise the same auction prints twice. */}
        {!done.length && last && <AuctionResult x={last} label="last long end" />}
        {a.next && (
          <div style={{ fontSize: 11.5, color: C.mid, fontWeight: 600 }}>
            <b>Next coupon</b> · {a.next.label} {bn(a.next.offering)} — {a.next.auctionDate}
            {a.next.closesAt ? `, bids close ${a.next.closesAt} ET` : ""}
          </div>
        )}
        {a.nextLongEnd && a.nextLongEnd.cusip !== a.next?.cusip && (
          <div style={{ fontSize: 11.5, color: C.mid, fontWeight: 600 }}>
            <b>Next long end</b> · {a.nextLongEnd.label} {bn(a.nextLongEnd.offering)} — {a.nextLongEnd.auctionDate}
          </div>
        )}
        {a.pendingToday?.length > 0 && (
          <div style={{ fontSize: 11, color: C.amber, fontWeight: 700 }}>
            ⏳ {a.pendingToday.map(x => `${x.label} bids close ${x.closesAt} ET`).join(" · ")} — results not yet published
          </div>
        )}
      </div>
    </Card>
  );
}

// SOFTWARE vs HARDWARE — the AI monetization gate. Renders as a rung inside the breadth-ladder
// card rather than its own box, because it EXTENDS that chain: equipment → semis → software.
//
// The state is never claimed off one session. This pair produces a dramatic-looking number on any
// volatile day, and a board that shouts on one session of rotation is worse than no rung at all —
// so until the spread has held direction for five sessions the label carries its pending flag and
// renders muted.
function MonetizationRung({ m }) {
  if (!m?.available) return null;
  const col = m.tone === "amber" ? C.amber : m.tone === "green" ? C.green : C.muted;
  const pct = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v}%`;
  const pp = (v) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v}pp`;
  const purityCol = m.purity?.state === "CONTAMINATED" ? C.amber
    : m.purity?.state === "OK" ? C.green : C.lbl;
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid " + C.bdr }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
          Software vs hardware
        </span>
        <span style={{ fontSize: 10, color: C.lbl, fontWeight: 700 }}>AI monetization gate</span>
        <span style={{ fontSize: 12, fontWeight: 700, color: C.mid }}>
          {m.softSym} {pct(m.soft)} · {m.hardSym} {pct(m.hard)}
        </span>
        {/* THE SPREAD IN POINTS AND IN ITS OWN VOLATILITY. A 2.5pp gap is meaningless without
            knowing whether that is a normal day for this pair. */}
        <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 900, color: col, fontVariantNumeric: "tabular-nums" }}>
          {pp(m.spread)}{m.atrMult != null ? ` · ${m.atrMult}×ATR` : ""}
        </span>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 3, fontSize: 11.5 }}>
        <span style={{ color: C.mid, fontWeight: 700 }}>{m.pureSym} {pct(m.pure)}</span>
        <span style={{ color: purityCol, fontWeight: 700 }} title={m.purity?.note || undefined}>
          {m.softSym}−{m.pureSym} {pp(m.purity?.gap)} · purity {m.purity?.state ?? "unknown"}
        </span>
        {/* The cumulative series is the actual indicator; the 1d is the tick. */}
        <span style={{ color: C.lbl, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
          20d {pp(m.cum20)} · 60d {pp(m.cum60)}
        </span>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", marginTop: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 900, color: m.confirmed ? col : C.muted }}>{m.state}</span>
        {!m.confirmed && (
          <span style={{ fontSize: 10.5, color: C.amber, fontWeight: 700 }} title={m.pending || undefined}>
            ⚠ {m.run}d only — {m.confirmSessions}d confirmation pending
          </span>
        )}
      </div>
      <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 2, lineHeight: 1.45 }}>{m.why}</div>
      {/* THE RATES CONFOUND, TESTED. Software is the longer-duration leg, so on a hawkish day it
          should underperform; when it outperforms into rising yields the duration explanation is
          ruled out and the read is cleaner. The only place this rung gets MORE confident. */}
      {m.ratesNote && (
        <div style={{ fontSize: 10.5, marginTop: 2, lineHeight: 1.45,
                      color: m.ratesRuledOut ? C.green : C.lbl }}>
          {m.ratesRuledOut ? "✓ " : "· "}{m.ratesNote}
          {m.thirtySource ? <span style={{ color: C.lbl }}> ({m.thirtySource})</span> : null}
        </div>
      )}
    </div>
  );
}


// D2 — event positioning. Before a catalyst, the question is what is already PAID FOR. Shows the
// run-up into each upcoming event and how stretched above the 50d line — the "priced for
// perfection" read (AMD: record double-beat, −9%).
function EventPositioning({ e }) {
  if (!e) return null;
  const pct = (v, s = "%") => v == null ? "—" : `${v >= 0 ? "+" : ""}${v}${s}`;
  // The module went to the trouble of saying WHY it has nothing — that the list has run out, or
  // that the next print is simply further off than the horizon — and the card threw it away by
  // returning null. An empty fortnight and a list nobody has restocked looked identical, which is
  // the exact confusion the reason string exists to prevent.
  if (!e.available) {
    return (
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <SLabel>📅 Event positioning — earnings</SLabel>
          <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>what's already priced in · run-up into the catalyst</span>
        </div>
        <div style={{ fontSize: 11.5, color: e.past === e.configured && e.configured ? C.amber : C.mid, fontWeight: e.past === e.configured && e.configured ? 700 : 500, marginTop: 6 }}>
          {e.reason || "Nothing upcoming."}
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>📅 Event positioning — earnings</SLabel>
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
              {/* Reading positioning into the wrong day is the one way this card misleads without
                  looking wrong, so an unresolved date is stated rather than quietly picked. */}
              {ev.dateNote && (
                <div style={{ fontSize: 10.5, color: C.amber, fontWeight: 700, marginTop: 2 }}>⚠ {ev.dateNote}</div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: C.lbl, marginTop: 5 }}>
        IV percentile (the cleanest leg) needs an options feed — not shown; run-up + stretch are the proxies.
        {e.next && ` Next past the horizon: ${e.next.name} (${e.next.sym}) in ${e.next.daysTo}d.`}
      </div>
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

// Business days between a YYYY-MM-DD and today (UTC). For the daily-cadence stale check.
// Counted on the US BOND calendar (lib/bondDays.js): every series aged here (DGS, DFII10, T10YIE,
// BAMLH0A0HYM2, EFFR) is a Treasury or Fed print, and none prints on Columbus or Veterans Day
// even though the stock exchange is open. `half` days still count: an early close is a session.
function bizDaysAgo(dateStr) {
  return businessDaysSince(dateStr, { calendar: "bond" });
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
    // MORE THAN ONE BUSINESS DAY BEHIND IS STALE. At the old threshold of two, a Wednesday print
    // read on Friday rendered as current — and the term premium, which lags by design and
    // feeds the one macro read supporting the gold position, sat six calendar days old looking
    // live. A number that has not moved since before the last session should not look like one
    // that has.
    const stale = bd != null && bd > 1;
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
// ── SPARKLINE ─────────────────────────────────────────────────────────────────
// A point value hides direction, and on both series this is used for the direction is the read.
// The 10Y real yield at 2.34% says nothing on its own; 2.34% having turned up over three weeks is
// the restrictive-policy leg of the debasement classifier. HY OAS at the 6th percentile of three
// years is not information either — whether it is compressing or widening from there is.
//
// Deliberately unlabelled: no axes, no ticks, no tooltip. It answers "which way" and hands the
// level to the number above it. `mark` draws one reference line where a level has a stated
// meaning, so the shape can be read against it rather than against the window's own extremes.
function Spark({ series, days = 20, color = C.blue, mark = null, markLabel = null }) {
  const rows = (Array.isArray(series) ? series : [])
    .filter(r => r && Number.isFinite(+r.value))
    .slice(-days)
    .map(r => ({ d: r.date, v: +r.value }));
  if (rows.length < 3) return null;                    // two points is a line, not a trend
  const vals = rows.map(r => r.v);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  // The mark only belongs in frame when it is near the data. Stretching the axis to reach a
  // threshold 200bp away would flatten the series into a straight line and hide the very
  // movement the sparkline exists to show.
  const span = hi - lo || Math.abs(hi) * 0.01 || 1;
  const inFrame = mark != null && mark >= lo - span * 1.5 && mark <= hi + span * 1.5;
  if (inFrame) { lo = Math.min(lo, mark); hi = Math.max(hi, mark); }
  const pad = (hi - lo || 1) * 0.15;
  const rising = vals[vals.length - 1] >= vals[0];
  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ height: 30, marginLeft: -4 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 2, right: 2, bottom: 0, left: 0 }}>
            <YAxis hide domain={[lo - pad, hi + pad]} />
            {inFrame && <ReferenceLine y={mark} stroke={C.amber} strokeDasharray="2 2" strokeWidth={1} />}
            <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.6} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div style={{ fontSize: 10, color: C.muted, display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span>{rows.length}d {rising ? "▲" : "▼"}</span>
        {inFrame && markLabel && <span style={{ color: C.amber }}>┄ {markLabel}</span>}
        {mark != null && !inFrame && <span title={`${markLabel} is outside this window`}>┄ {markLabel} off-scale</span>}
      </div>
    </div>
  );
}

function MacroCell({ field, value, delta, deltaSuffix, extra = null }) {
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
        {/* SHORT ON A TILE. The full "last print 2026-09-24 · 2d" wrapped to three lines in a 170px
            tile; the chip says the date and the age, the hover says the rest. */}
        {mf.text && (mf.stale ? <StaleChip title={[mf.text, field?.vintage?.late ? field.vintage.note : null].filter(Boolean).join(" — ")}>{staleTileText(mf.text)}</StaleChip> : <span style={{ color: C.lbl }}>{mf.text}</span>)}
        {/* A CHECK THAT STOPPED MUST SAY SO. A derived card that quietly renders "—" looks like a
            feed outage; this one names the vintage mismatch that prevented it, so the blank is
            legible rather than alarming. */}
        {/* P4-A — LATE FOR ITS OWN SCHEDULE, said on the tile that carries the number. `macroFresh`
            already grades staleness by cadence; this is the sharper question the credit gate has
            always asked and no other tile did: the series publishes daily and today's print is
            missing. A live field says so instead — it has nothing to age. */}
        {field?.live === true && field?.liveAsOf && (
          <span style={{ color: C.green, fontWeight: 700 }} title={`live quote · ${field.liveSrc || ""}`}>live {String(field.liveAsOf).slice(11)}</span>
        )}
        {/* ONE MARK, NOT TWO. With the stale chip already up, "no print since" was the same date
            and the same count a second time, in a second colour, on a tile 170px wide. */}
        {field?.vintage?.late && !mf.stale && (
          <span style={{ color: C.amber, fontWeight: 700 }} title={field.vintage.note || ""}>
            ⚠ no print since {field.vintage.obsDate} ({field.vintage.bizDays}d)
          </span>
        )}
        {field?.align && field.align.checked === false && (
          <span style={{ color: C.amber, fontWeight: 700 }} title={field.align.reason || ""}>⚠ not computed — inputs disagree on date</span>
        )}
        <BenchChip b={field?.benchmark} />
      </div>
      {extra}
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
export function SouthboundPanel({ onSaved = null } = {}) {
  const [manualSeries, setSeries] = useState([]);
  const [smicAH, setSmicAH] = useState(null);
  const [sbFeed, setSbFeed] = useState(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [agg, setAgg] = useState("");
  const [smic, setSmic] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    fetch("/api/manual-entry").then(r => r.json()).then(j => setSeries(j.southbound?.series || [])).catch(() => {});
    // ONE FIELD, NOT THE ROUTE. This fetched /api/indicators whole — a second full FRED burst in
    // the same page load as the Macro tab's own, which is what tipped the key over its minute
    // budget on 2026-09-21. ?smic=1 answers with the SMIC feed alone and touches FRED not at all.
    fetch("/api/indicators?smic=1").then(r => r.json()).then(j => { setSmicAH(j.smicAH || null); setSbFeed(j.southbound || null); }).catch(() => {});
  }, []);
  // AUTOMATIC NOW. The aggregate net is HKEX's own daily file (lib/hkexSouthbound.js); a hand-entered
  // row still wins for its day, and the SMIC CCASS holding — not in that file — stays manual.
  const series = mergeSouthbound(sbFeed?.series || [], manualSeries);
  const sbAuto = !!sbFeed?.ok;

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
        onSaved?.();
        setAgg(""); setSmic(""); setNotes(""); setMsg({ ok: true, text: `Saved ${date}` });
      } else setMsg({ ok: false, text: j.error || "save failed" });
    } catch (e) { setMsg({ ok: false, text: String(e.message) }); }
    setSaving(false);
  }

  const inp = { padding: "6px 9px", fontSize: 12, border: "1px solid " + C.bdrMd, borderRadius: 6, background: C.surf, color: C.text };
  const win = (w) => `${w.sum > 0 ? "+" : ""}${w.sum} (${w.days}d, ${w.dir})`;
  const dlt = (v) => v == null ? "—" : `${v > 0 ? "+" : ""}${v}pp`;
  const CCASS = "https://www3.hkexnews.hk/sdw/search/searchsdw.aspx";
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <SLabel><span style={{ display: "inline-block", background: P.red700, color: C.onFill, fontSize: 9, fontWeight: 800, padding: "1px 4px", borderRadius: 3, marginRight: 5 }}>HK</span>China-policy trade — SMIC A/H premium + Southbound flow</SLabel>
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
          <div style={{ fontSize: 11, color: C.mid, fontWeight: 700 }}>Aggregate Southbound net (HKD bn) <span style={{ color: C.muted, fontWeight: 700 }}>· {sbAuto ? "auto · HKEX daily Stock Connect stats" : "✍️ manual"}</span></div>
          {latest ? (
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 1.6 }}>
              {latest.date}: <b style={{ color: latest.aggregateNet > 0 ? C.green : latest.aggregateNet < 0 ? C.red : C.muted }}>{latest.aggregateNet != null ? (latest.aggregateNet > 0 ? "+" : "") + latest.aggregateNet : "—"}</b>{stale && <StaleChip />}<br />
              5-day <b style={{ color: C.text }}>{win(tAgg.w5)}</b> · 20-day <b style={{ color: C.text }}>{win(tAgg.w20)}</b>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: C.lbl, marginTop: 3, lineHeight: 1.5 }}>{sbFeed && !sbFeed.ok ? "HKEX's daily file did not answer — hand-enter the day's total Southbound net buy below." : "Loading HKEX's daily Stock Connect statistics…"}</div>
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
        <button onClick={save} disabled={saving} style={{ background: C.blue, color: C.onFill, border: "none", borderRadius: 8, padding: "7px 16px", fontSize: 12.5, fontWeight: 800, cursor: saving ? "wait" : "pointer", opacity: saving ? 0.6 : 1 }}>{saving ? "Saving…" : "Save day"}</button>
        <span style={{ fontSize: 11, color: C.lbl }}>{tAgg.nObs} day{tAgg.nObs === 1 ? "" : "s"} stored</span>
        {msg && <span style={{ fontSize: 11.5, fontWeight: 700, color: msg.ok ? C.green : C.red }}>{msg.text}</span>}
      </div>
    </Card>
  );
}

// Korea manual-entry: paste the KOFIA panel → preview (with the recompute-pct guard) →
// Save (to the Redis document via /api/korea-save, so Pre-Reads pick it up too).
export function KoreaManualEntry({ kofia, gate2 = null, onSaved }) {
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
  const [fetching, setFetching] = useState(false);
  const [fetchedNow, setFetchedNow] = useState(null);    // the button's own lastFetch, until redeploy
  const lastFetch = fetchedNow || kofia?.lastFetch || null;

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

  // FETCH NOW — the scheduled run's KOFIA + KRX read, on demand. The readings and the stamp come
  // back in the answer, so the panel updates now; the commit redeploys for the Pre-Reads.
  async function fetchNow() {
    setFetching(true); setMsg(null);
    try {
      const r = await fetch("/api/korea-save?fetch=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (j.latest) { setSavedLatest(j.latest); onSaved?.(j.latest); }
      if (j.lastFetch) setFetchedNow(j.lastFetch);
      if (!r.ok) setMsg({ ok: false, text: j.error || ("Fetch failed " + r.status) });
      else setMsg({ ok: j.ok, text: (j.changed ? "Fetched — new readings below. " : "Fetched — nothing new since the last read. ") + (j.ok ? "" : (j.report || []).filter(l => /FAILED/.test(l)).join(" · ")) });
    } catch (e) { setMsg({ ok: false, text: "Fetch error: " + e.message }); }
    setFetching(false);
  }

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
        onSaved?.(j.latest || null);              // …and hand them up, so the hub's age updates too
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
      <SLabel><span style={{ display: "inline-block", background: P.navy700, color: C.onFill, fontSize: 9, fontWeight: 800, padding: "1px 4px", borderRadius: 3, marginRight: 5, letterSpacing: 0 }}>KR</span>Korea — KOFIA + KRX flows (automatic) · 7709 units (manual)</SLabel>
      {/* WHEN IT LAST LOOKED. Each reading's as-of date says how old the figure is; this says when
          the fetch last ran and whether it worked, so a quiet day and a run that never happened
          read differently. */}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 11.5, margin: "2px 0 4px" }}>
        {lastFetch ? (
          <span style={{ color: lastFetch.ok ? C.mid : C.red, fontWeight: 700 }} title={(lastFetch.report || []).join("\n")}>
            Last fetched {seoulStamp(lastFetch.at) || lastFetch.at} · {lastFetch.by === "button" ? "by you" : lastFetch.by === "manual run" ? "manual run" : "scheduled"}
            {" · "}{lastFetch.ok ? (lastFetch.changed ? "new readings" : "nothing new") : `failed — ${Object.entries(lastFetch.sources || {}).filter(([, v]) => v === "failed").map(([k]) => k.toUpperCase()).join(" + ") || "see details"}`}
            {lastFetch.ok && lastFetch.sources?.krx === "in session" ? " · KRX still in session" : ""}
          </span>
        ) : <span style={{ color: C.muted }}>No automatic fetch recorded yet</span>}
        <button onClick={fetchNow} disabled={fetching || saving}
          style={{ background: C.surf, color: C.blue, border: "1.5px solid " + C.blue, borderRadius: 7, padding: "3px 10px", fontSize: 11.5, fontWeight: 800, cursor: fetching ? "wait" : "pointer", opacity: fetching ? 0.6 : 1 }}>
          {fetching ? "Fetching…" : "Fetch now"}
        </button>
        {fetching && <span style={{ color: C.muted }}>KOFIA and KRX, up to a minute</span>}
      </div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
        KOFIA and the KRX flow table are read automatically after the Seoul close (16:10 and 20:10 KST, weekdays). The paste below still works as a fallback; CSOP 7709 units stay a hand entry.
      </div>
      <div style={{ fontSize: 11, margin: "3px 0 8px", display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ color: C.muted, fontWeight: 700 }}>Sources:</span>
        <a href="https://freesis.kofia.or.kr/" target="_blank" rel="noopener noreferrer" style={{ color: C.blue, textDecoration: "none", fontWeight: 700 }}>KOFIA freesis ↗</a>
        <a href="https://data.krx.co.kr/" target="_blank" rel="noopener noreferrer" style={{ color: C.blue, textDecoration: "none", fontWeight: 700 }}>KRX 투자자별 매매동향 ↗</a>
        <a href="https://www.csopasset.com/en/products/hk-skhy-2l" target="_blank" rel="noopener noreferrer" style={{ color: C.blue, textDecoration: "none", fontWeight: 700 }}>CSOP 7709 ↗</a>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, margin: "8px 0 10px" }}>
        {["marginLoans", "deposits", "cma", "kr3yGovt", "kr3yCorp", "units7709", "foreignNet", "instNet", "retailNet"].map(k => {
          const e = latest[k];
          const line = kofiaStoredLine(k, e, new Date(), { staleMark: false });
          const old = !!(e?.asOf && kofiaStale(e.asOf));
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
              <div style={{ fontSize: 13, fontWeight: 800, color: line ? ((isCur || isFlow) ? col : C.text) : C.lbl }}>{line || "— not set"}{old && <StaleChip title={`as of ${e.asOf} — more than two Seoul sessions old`} />}</div>
              {e?.unit && <div style={{ fontSize: 9.5, color: C.lbl }}>unit {e.unit}{nObs ? ` · ${nObs} obs` : ""}</div>}
            </div>
          );
        })}
      </div>
      {/* KOSDAQ flows: one line, context only. The gate and the read use the KOSPI table — the
          market SK hynix and Samsung trade on. KOSDAQ is where Korean retail risk appetite shows:
          retail chasing KOSDAQ while selling KOSPI is speculation, not de-risking. */}
      {latest.foreignNetKq && (
        <div style={{ fontSize: 11.5, color: C.muted, margin: "-4px 0 10px" }}>
          <b style={{ color: C.lbl, fontWeight: 800 }}>KOSDAQ</b> · {latest.foreignNetKq.asOf}
          {[["foreign", "foreignNetKq"], ["inst", "instNetKq"], ["retail", "retailNetKq"]].map(([lab, k]) => {
            const v = latest[k]?.value;
            return v == null ? null : <span key={k}> · {lab} <b style={{ color: v > 0 ? C.green : v < 0 ? C.red : C.muted }}>{v > 0 ? "+" : ""}{withCommas(v)}</b></span>;
          })}
          <span style={{ color: C.lbl }}> ₩bn · context only, not in the gate</span>
        </div>
      )}
      {koreaFlowRead(latest) && (
        <div style={{ margin: "0 0 12px", padding: "8px 12px", background: C.bg, border: "1px solid " + C.bdr, borderRadius: 8 }}>
          <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.55 }}>
            <b style={{ color: C.muted, fontWeight: 800 }}>READ · </b>{koreaFlowRead(latest)}
          </div>
          {(() => {
            // The implication now depends on the FX gate as well as the flow table. Computed once
            // rather than called twice: the two calls used to be able to disagree if anything in
            // between changed, and one of them decided whether the other rendered at all.
            const impl = koreaFlowImplication(latest, { gate2 });
            if (!impl) return null;
            const nonOrganic = /NOT ORGANIC/.test(impl);
            return (
              <div style={{ fontSize: 12.5, lineHeight: 1.55, marginTop: 5, paddingTop: 5,
                            borderTop: "1px dashed " + C.bdr,
                            color: nonOrganic ? C.amber : C.text }}>
                <b style={{ color: nonOrganic ? C.amber : C.blue, fontWeight: 800 }}>
                  {nonOrganic ? "⚠ IMPLICATION · " : "IMPLICATION · "}
                </b>{impl}
              </div>
            );
          })()}
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
  if (sym.endsWith(".AE")) return "AE";
  return "US";
}

// ── THE RATES, IN ONE LINE ───────────────────────────────────────────────────
// The Overview carried the Macro tab's whole rates card — nine tiles and a regime-inputs grid —
// as its fifth block. The full card lives in the fold below; what the synthesis needs above it is
// the five numbers a rates scenario turns on, on one line, with their day's move.
function RatesStrip({ macro }) {
  if (!macro) return null;
  const bp = (d) => d == null ? "" : ` ${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d))}bp`;
  const it = (label, v, d, unit = "%") => v == null ? null : (
    <span key={label} style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: C.lbl, fontWeight: 700 }}>{label} </span>
      <b style={{ color: C.text, fontVariantNumeric: "tabular-nums" }}>{v}{unit}</b>
      {d != null && <span style={{ color: d > 0 ? C.amber : d < 0 ? C.green : C.muted, fontSize: 11, fontWeight: 700 }}>{bp(d)}</span>}
    </span>
  );
  const items = [
    it("2Y", macro.us2y?.value, macro.us2y?.deltaBps),
    it("10Y", macro.us10y?.value, macro.us10y?.deltaBps),
    it("30Y", macro.us30y?.value, macro.us30y?.deltaBps),
    macro.twos10s != null ? it("2s10s", `${macro.twos10s >= 0 ? "+" : ""}${macro.twos10s}`, macro.twos10sDeltaBps, "bp") : null,
    it("OAS", macro.oas?.value, macro.oas?.deltaBps, ""),
    macro.wti?.value != null ? it("WTI", `$${macro.wti.value}`, null, "") : null,
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", gap: "4px 16px", flexWrap: "wrap", alignItems: "baseline", fontSize: 12.5,
                  padding: "8px 14px", background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 12 }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: C.lbl, letterSpacing: 1.5, textTransform: "uppercase" }}>Rates</span>
      {items}
      <span style={{ marginLeft: "auto", fontSize: 10.5, color: C.lbl }}>full card in Data below</span>
    </div>
  );
}

// ── THE FOLD ─────────────────────────────────────────────────────────────────
// Everything below the synthesis — regime per region, the rates card, tape, breadth, events,
// handoff, names, indices, cross-asset, calendar — is reference. It is what the synthesis was
// composed FROM, and it is where a reader goes to check a claim, not to form one. Roughly twenty
// card-level blocks sat on the same scroll as the six that carry the conclusion. Closed by
// default; the choice is remembered, because a reader who wants it open wants it open every day.
function DataFold({ children }) {
  const [open, setOpen] = useState(() => cacheLoad("overview_data_open_v1", false));
  return (
    <details open={open}
      onToggle={e => { const o = e.currentTarget.open; setOpen(o); cacheSave("overview_data_open_v1", o); }}
      style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 14, padding: "10px 16px" }}>
      <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 800, color: C.mid, letterSpacing: 1.2, textTransform: "uppercase", listStyle: "none" }}>
        {open ? "▾" : "▸"} Data
        <span style={{ fontWeight: 600, letterSpacing: 0, textTransform: "none", color: C.muted, marginLeft: 8 }}>
          regime · rates · breadth · events · handoff · names · indices · cross-asset · calendar — what the read above was composed from
        </span>
      </summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>{children}</div>
    </details>
  );
}

export function GlobalPlaybook({ byRegion, regions, toggleRegion, loading, errorBy = {}, updatedBy = {}, onRefresh, fmtTime, reconSummary, liveIntervention, regime = null, layers = null, onOpenCalendar = null }) {
  // Both All and single-region are filtered views of ONE spine. `active` = loaded data for
  // the selected region(s); `data` heads the page — the stance, scenarios, tripwires, the read —
  // and is the US whenever it is selected and loaded (lib/overviewRegions.js), not whichever
  // region happens to be first in the selection.
  const active = regions.map(r => byRegion[r]).filter(Boolean);
  const lead = leadRegion(regions, byRegion);
  const data = lead ? byRegion[lead] : null;
  const stamps = regionStamps(regions, { updatedBy, errorBy, byRegion });
  const regionName = (r) => (PB_REGIONS.find(x => x.id === r)?.label || r).replace(/^\S+\s/, "");
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
                background: on ? C.blue : C.surf, color: on ? C.onFill : C.mid,
                border: "1.5px solid " + (on ? C.blue : C.bdr), borderRadius: 8,
                padding: "7px 14px", fontSize: 13, fontWeight: 700, cursor: "pointer", opacity: on ? 1 : 0.6,
              }}>{on ? "✓ " : ""}{r.label}</button>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* ONE STAMP PER REGION. FETCHED, not "as of": the tiles beneath refresh on different
              cadences, so a fetch time is an upper bound on freshness, never a statement that
              everything on screen is current to it. Rehydrated from localStorage, so it can be days
              old; fmtTime then carries the date and age, and an old copy is flagged. */}
          <span style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 12, color: C.muted, justifyContent: "flex-end" }}>
            {stamps.map(st => (
              <span key={st.region} title={st.at ? st.at.toString() : "never fetched"}
                style={{ color: st.error || st.old ? C.amber : C.muted, fontWeight: st.error || st.old ? 700 : 400 }}>
                {regionName(st.region)}{st.region === lead && multi ? " (lead)" : ""}: {st.error ? "⚠ failed" : st.old ? "⚠ cached " : ""}{st.at ? fmtTime(st.at) : st.error ? "" : "—"}
              </span>
            ))}
          </span>
          <Btn onClick={onRefresh} disabled={loading} color={C.blue} bgColor={C.blBg} label={loading ? "⏳ …" : "🔄 Refresh"} />
        </div>
      </div>

      {stamps.some(st => st.error) && (
        <Card style={{ background: C.rBg, border: "1.5px solid " + C.rBdr }}>
          {stamps.filter(st => st.error).map(st => (
            <div key={st.region} style={{ color: C.red, fontSize: 13 }}>
              {regionName(st.region)}: {st.error}{st.loaded ? " — showing the last good copy." : ""}
            </div>
          ))}
        </Card>
      )}

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
          {data.posture && <PostureCard p={data.posture} regime={regime} tape={data.marketRegime} layers={layers} regionTape={data.regionTape} />}
          {/* 1 — Scenario board (synthesis). */}
          {data.scenarios && <ScenarioBoard scenarios={data.scenarios} board={data.scenarioBoard} />}
          {/* P7 — Treasury supply. Sits directly under the scenario board because three of the six
              scenarios are rates scenarios and this is the supply side of all three. */}
          {data.auctions && <AuctionCard a={data.auctions} />}
          {/* 2 — Tripwires: vol regime + gauges + 7709, tagged by scenario. */}
          {data.volTerm && <VolRegime v={data.volTerm} />}
          {/* CTA positioning sits beside vol because the funds size to it: lower vol, bigger
              positions for the same trend. Self-fetching (/api/atr?cta=1), like the gamma panel. */}
          <CtaPanel />
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

          <RatesStrip macro={data.macro} />

          <DataFold>
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
            {/* FLIPS IF — where each gate on this card changes state, read back from the same
                constants the gates run on. The card said what the credit gate WAS; not where it
                would stop being that. */}
            {(() => {
              const f = regimeFlipsIf(d.regime, { oas: d.macro?.oas?.value ?? data.macro?.oas?.value ?? null });
              return f ? (
                <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "baseline" }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, minWidth: 66, flexShrink: 0 }}>Flips if</span>
                  <span style={{ fontSize: 12, color: C.blue, fontWeight: 700, lineHeight: 1.5 }}>{f}</span>
                </div>
              ) : null;
            })()}
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
              <MacroCell field={data.macro.wti}   value={data.macro.wti?.value != null ? "$" + data.macro.wti.value : "—"}     delta={data.macro.wti?.delta} deltaSuffix=" $/bbl" />
              <MacroCell field={data.macro.brent} value={data.macro.brent?.value != null ? "$" + data.macro.brent.value : "—"} delta={data.macro.brent?.delta} deltaSuffix=" $/bbl" />
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
              {/* The date is the one BOTH legs share, from lib/derived.js — not the 10Y's standing
                  in for the pair, which is what it used to be. When they disagree the spread is not
                  computed, and the card says so rather than going blank. */}
              <MacroCell
                field={{ name: "2s10s", src: "DGS10−DGS2", date: data.macro.twos10sAlign?.date, cadence: "daily",
                         align: data.macro.twos10sAlign }}
                value={data.macro.twos10s != null ? (data.macro.twos10s >= 0 ? "+" : "") + data.macro.twos10s + "bps" : "—"}
                delta={data.macro.twos10sDeltaBps} deltaSuffix="bps" />
              {/* DXY dedup'd — owned by the FX legs group in the Cross-asset card (a blend read
                  next to its EUR/JPY legs), so it is not repeated here. */}
              {/* 2.90 is the logged CALM/WATCH boundary from lib/gates.js. Drawn as a mark rather
                  than a tripwire: the series has oscillated 6bp inside a single week at these
                  levels, so the distance to it is noise and only the direction toward it is not. */}
              <MacroCell field={data.macro.oas}   value={data.macro.oas?.value ?? "—"} delta={data.macro.oas?.deltaBps} deltaSuffix="bps"
                extra={<Spark series={data.macro.oas?.series} days={20} color={C.mid} mark={2.9} markLabel="2.90 watch" />} />
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
                <MacroCell field={data.macro.realYield} value={data.macro.realYield?.value != null ? data.macro.realYield.value + "%" : "—"} delta={data.macro.realYield?.deltaBps} deltaSuffix="bps"
                  extra={<Spark series={data.macro.realYield?.series} days={20} color={C.blue} />} />
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
                const unconfirmed = /UNCONFIRMED|AMBIGUOUS|DIVERGENT|MIXED|not debasement|PASS-THROUGH/i.test(rs.label || "");
                const be = rs.breakevens || {};
                const mismatch = rs.mismatch;
                return (
                  <div style={{ marginTop: 10, padding: "10px 12px", background: C.bg, border: "1.5px solid " + (mismatch ? C.rBdr : unconfirmed ? C.aBdr : C.bdrMd), borderRadius: 8 }}>
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 700 }}>Debasement / stagflation read (gold+BTC)</div>
                    {/* P4-A — WHAT THIS READ IS COMPOSED FROM. Gold and BTC tick all day; the real
                        yield and the breakeven are end-of-day FRED prints. The classifier is
                        comparing this hour against a settled session, which is structural rather
                        than a fault — so it is disclosed here rather than silently averaged. */}
                    {rs.vintageNote && (
                      <div style={{ fontSize: 10.5, color: C.amber, fontWeight: 600, marginTop: 2, lineHeight: 1.45 }}>
                        ⚠ {rs.vintageNote}
                      </div>
                    )}
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
                    {/* WHAT DECIDED IT. The discriminator used to take one undifferentiated
                        "breakevens" input and had no view of the term structure — which is the only
                        thing separating an oil pass-through from a monetary repricing. Both the
                        verdict and the two numbers behind it are printed, so the label can be
                        checked rather than trusted. */}
                    {rs.discriminator && (
                      <div style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 4,
                                    color: /⚠/.test(rs.discriminator) ? C.amber : C.mid }}>
                        {rs.discriminator}
                      </div>
                    )}
                    {(be.tenYrBps != null || be.fwd5y5yBps != null) && (
                      <div style={{ fontSize: 11, color: C.muted, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
                        inflation expectations · 10Y BE {be.tenYrBps == null ? "—" : `${be.tenYrBps >= 0 ? "+" : ""}${be.tenYrBps}bp`}
                        {" · "}5y5y fwd {be.fwd5y5yBps == null ? "—" : `${be.fwd5y5yBps >= 0 ? "+" : ""}${be.fwd5y5yBps}bp`}
                        {be.spreadBps != null && (
                          <span style={{ color: be.spreadBps > 0 ? C.amber : C.muted, fontWeight: 700 }}>
                            {" · "}10Y sits {Math.abs(be.spreadBps)}bp {be.spreadBps > 0 ? "above" : be.spreadBps < 0 ? "below" : "level with"} the forward
                            {be.spreadBps > 0 ? " (front-of-curve — supply shape)" : ""}
                          </span>
                        )}
                      </div>
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
            <KoreaManualEntry kofia={byRegion.asia.kofia} gate2={byRegion.asia.won?.gate2 ?? null} onSaved={() => onRefresh()} />}

          {/* The China read (lib/chinaRead.js) — five rows and a verdict, ahead of the Southbound
              detail it draws on. Its own read; it does not vote on the Signal Board. */}
          {regions.includes("asia") && <ChinaPanel />}

          {/* Southbound Stock Connect (SMIC mainland flow) — same class as the Korea flow panel,
              shown alongside it when Asia is active. Self-fetches its own manual store. */}
          {regions.includes("asia") && <SouthboundPanel />}

          {/* Concentration ladder (P5) — fixed order, widest beta to narrowest. */}
          {data.ladder && data.ladder.spread != null && (
            <Card>{/* I.2 — alert flag is not a status badge; no bar. */}
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <SLabel>🪜 Breadth ladder</SLabel>
                <span style={{ fontSize: 10, color: C.muted, fontWeight: 700 }}>SMH (SOXX) → QQQ → SPY → IWM → HYG</span>
                <span style={{ marginLeft: "auto", fontSize: 13, fontWeight: 900, color: data.ladder.alert ? C.amber : C.mid }}>
                  {/* The size of the gap and which end moved most — a bare signed spread read as an error on a down day. */}
                  {data.ladder.span ?? Math.abs(data.ladder.spread)}pp{data.ladder.direction === "down" ? ` · ${data.ladder.rungs[0].sym} weakest` : data.ladder.direction === "up" ? ` · ${data.ladder.rungs[0].sym} strongest` : ""}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 4, alignItems: "baseline" }}>
                {data.ladder.rungs.map((r, i) => {
                  const cell = (sym, pct, title) => (
                    <span key={sym} title={title} style={{ fontSize: 12.5, fontWeight: 700 }}>
                      <span style={{ color: C.muted }}>{sym}</span>{" "}
                      <span style={{ color: pct == null ? C.lbl : pbPctColor(pct) }}>{pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct}%`}</span>
                    </span>
                  );
                  // SOXX sits beside SMH as the broader semis read. It is shown, not ranked: the
                  // order check runs on the five rungs only, and the gap between the two is read below.
                  return i === 0 && data.smhSoxx?.available
                    ? <span key="semis" style={{ display: "inline-flex", gap: 6, alignItems: "baseline", padding: "1px 7px", border: "1px solid " + C.bdr, borderRadius: 6 }}>
                        {cell(r.sym, r.pct)}<span style={{ color: C.bdr }}>|</span>{cell("SOXX", data.smhSoxx.soxxPct, "Broader semis, shown beside SMH; not part of the order check")}
                      </span>
                    : cell(r.sym, r.pct);
                })}
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
              {/* SOFTWARE vs HARDWARE — the fourth rung, so the chain reads equipment → semis →
                  software: the actual capex-to-monetization sequence. The two rungs above it
                  measure SPENDING; this one measures whether the spending is being monetized, and
                  the two diverge at cycle turns. */}
              <MonetizationRung m={data.monetization} />
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
              {/* THE PER-LEG FLAGS ARE THE SOURCE OF TRUTH, AND THEY STAND ALONE.
                  This used to be nested inside the legacy boolean's card, which meant clearing
                  that boolean — as the operator did at 08:25 on 2026-09-03 — silently took the
                  per-leg flags off the screen with it. The old annotation is retired; the flags
                  below are what Gate 2 and every contamination check actually read, so they render
                  on their own terms.
                  Scoped per currency: a JPY flag contaminates the yen leg and DXY only because DXY
                  contains it. It says nothing about EUR/USD — a different market with a different
                  central bank. */}
              {data.contamination?.any && (
                <div style={{ marginBottom: 8, padding: "7px 10px", background: C.aBg,
                  border: "1px solid " + C.aBdr, borderRadius: 6, fontSize: 11.5, lineHeight: 1.55 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "baseline" }}>
                    <b style={{ fontSize: 11.5, color: C.amber }}>Intervention — by leg</b>
                    {Object.values(data.contamination.flagged).map(f => (
                      <span key={f.currency} title={f.why}
                        style={{ fontSize: 10.5, fontWeight: 800, color: C.amber, background: C.surf,
                                 border: "1px solid " + C.aBdr, borderRadius: 4, padding: "1px 6px" }}>
                        ⚑ {f.currency} {f.regime ? f.regime.grade : "EVENT"}
                        {f.regime?.since ? ` · since ${f.regime.since}` : ""}
                        {f.regime?.review ? ` · review ${f.regime.review}` : ""}
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11, color: C.mid }}>{data.contamination.note}</div>
                </div>
              )}
              {/* The automatic yen flag, when it is live: what the scan saw and what the MoF says. */}
              {data.interventionAuto?.active && <div style={{ marginBottom: 8 }}><InterventionAutoBlock auto={data.interventionAuto} compact /></div>}
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
              <SLabel>📅 Calendar — Current / Upcoming{onOpenCalendar && <> · <button onClick={onOpenCalendar} style={{ background: "none", border: "none", padding: 0, color: C.blue, fontWeight: 700, cursor: "pointer", font: "inherit" }}>the quarter ahead on Markets › Calendar</button></>}</SLabel>
              {data.calendar.map((e, i) => {
                // C6 — countdown chip so imminence is legible, and adjacent same-window catalysts read
                // as the collision they are (e.g. NVDA Aug 26 → Jackson Hole Aug 27–29).
                const days = Math.round((new Date(e.date + "T00:00:00Z") - new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z")) / 864e5);
                // A past event not marked reported is "passed", not "today" — `days <= 0` used to cover both.
                const cd = e.reported ? null : days < 0 ? "passed" : days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days}d`;
                const soon = !e.reported && days >= 0 && days <= 2;
                return (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0", fontSize: 13, color: e.reported ? C.lbl : C.mid, borderBottom: i < data.calendar.length - 1 ? "1px solid " + C.bdr : "none" }}>
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

          </DataFold>

          <div style={{ fontSize: 11, color: C.lbl, textAlign: "center" }}>
            Same data spine as the Discord pre-reads · {regions.length === 3 ? "All regions" : regions.map(r => r.toUpperCase()).join(" · ")}
          </div>
        </>
      )}
    </div>
  );
}
