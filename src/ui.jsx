// src/ui.jsx — the shared visual vocabulary.
//
// Extracted from App.jsx so that a tab living in its own module can render in the same idiom
// without importing the entire dashboard. These four are used on every surface: the palette and
// the three primitives every card is built from.
//
// The palette moved to theme.js: a module exporting both components and plain values cannot be
// hot-reloaded reliably, so every edit to a colour forced a full remount and lost page state.
import { Component } from "react";
import { C, alpha } from "./theme.js";

export function SLabel({ children, color, style }) {
  return <div style={{ fontSize: 12, letterSpacing: 2.5, color: color || C.lbl, textTransform: "uppercase", fontWeight: 700, marginBottom: 10, ...style }}>{children}</div>;
}

export function Card({ children, style, onClick, id }) {
  return <div id={id} onClick={onClick} style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 5px rgba(0,0,0,.05)", ...style }}>{children}</div>;
}

export function Btn({ onClick, disabled, color, bgColor, label }) {
  return (
    <button onClick={onClick} disabled={!!disabled} style={{ background: bgColor || color, color: bgColor ? color : C.onFill, border: bgColor ? "1.5px solid " + alpha(color, 0x60) : "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: disabled ? 0.6 : 1, whiteSpace: "nowrap" }}>
      {label}
    </button>
  );
}

// ── STALE, AS ITS OWN MARK ──
// A stale flag typed into the same string as its number took the number's colour — a red margin
// loan read "…09-22 ⚠stale" in red, a green deposit line in green — and was missed for days. It is
// a separate chip everywhere now: amber on its own tint, bordered, in capitals, so it reads as a
// status and never as part of the figure beside it.
//
// IT WRAPS INSIDE ITS BOX. Unbreakable, a chip carrying "last print 2026-09-24 · 2d" was wider than
// a macro tile and ran through the tile's border into the next one. The word STALE stays on one
// line; the detail after it wraps, and the chip never grows past the width it is given.
export function StaleChip({ children = null, title = undefined }) {
  return (
    <span title={title} style={{ display: "inline-flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 4, marginLeft: 6, verticalAlign: "middle",
      maxWidth: "calc(100% - 6px)", minWidth: 0, boxSizing: "border-box", overflowWrap: "anywhere",
      fontSize: 10, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase",
      color: C.amber, background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 5, padding: "1px 6px" }}>
      <span style={{ whiteSpace: "nowrap" }}>⚠ stale</span>{children ? <span style={{ fontWeight: 700, textTransform: "none", letterSpacing: 0, minWidth: 0 }}>· {children}</span> : null}
    </span>
  );
}

// ── Moved from App.jsx (7 Nov 2026) so the page modules share them ──
export function Pill({ label, color, bg, bdr }) {
  return (
    <span style={{ background: bg || alpha(color, 0x18), color, border: "1.5px solid " + (bdr || alpha(color, 0x44)), borderRadius: 6, padding: "3px 9px", fontSize: 12, fontWeight: 800 }}>
      {label}
    </span>
  );
}

// Error boundary — a render error in ONE tab must not tear down the whole dashboard.
// Without this, a single bad property access blanks the entire page (header + nav included),
// which is exactly what a shape-mismatched cached payload once did. Offers a cache-clear
// escape hatch, since a stale localStorage payload is the most likely cause.
export class TabErrorBoundary extends Component {
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
          try { Object.keys(localStorage).filter(k => k.startsWith("cache_")).forEach(k => localStorage.removeItem(k)); } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
          window.location.reload();
        }} color={C.red} bgColor={C.rBg} label="🧹 Clear cache & reload" />
      </Card>
    );
  }
}

// ── Unified metric card ──────────────────────────────────────────────────────
// ONE shell for every metric group (Macro, Cross-Asset, Indices, Names, Korea gate) so
// styling cannot drift between sections and nothing renders as a floating label-value pair.
// Purely presentational: callers pass already-formatted values, so no formatting logic
// lives here and no displayed number can change by routing through it.
export function MetricGrid({ children, min = 200 }) {
  return <div className="mwd-metric-grid" style={{ "--mwd-min": min + "px" }}>{children}</div>;
}

export function MetricCard({ label, labelRight, value, valueColor, strike, sub, badge, accent, title, children }) {
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

// ── HAND-KEPT, AND SAID SO ───────────────────────────────────────────────────
// Several blocks on the Macro tab are maintained by a person after an event — the Fed-language
// read after each FOMC, the September hike odds, the recession narrative, the panel of house
// forecasts — and they rendered in the same visual weight as tiles fed by a live series. A reader
// could not tell a print from an opinion written three weeks ago. This names both facts: that a
// person wrote it, and when. Amber, with REFRESH DUE, once it is older than the cadence the block
// is meant to be refreshed on — so a stale essay looks stale rather than current.
export function HandKept({ asOf, cadenceDays = null, what = null }) {
  const t = Date.parse(asOf || "");
  // eslint-disable-next-line react-hooks/purity -- Date.now for an age label; each render refreshes it, which is the intent
  const days = Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
  const stale = cadenceDays != null && days != null && days > cadenceDays;
  const col = stale ? C.amber : C.muted;
  return (
    <span title={what ? `Updated by hand ${what} — not fed by a live series.` : "Updated by hand, not fed by a live series."}
      style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: col,
               background: stale ? C.aBg : "transparent", border: "1px solid " + alpha(col, 0x66), borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
      ✍ hand-kept{asOf ? ` · as of ${asOf}` : ""}{days != null ? ` · ${days}d` : ""}{stale ? " · REFRESH DUE" : ""}
    </span>
  );
}
