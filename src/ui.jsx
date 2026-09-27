// src/ui.jsx — the shared visual vocabulary.
//
// Extracted from App.jsx so that a tab living in its own module can render in the same idiom
// without importing the entire dashboard. These four are used on every surface: the palette and
// the three primitives every card is built from.
//
// The palette moved to theme.js: a module exporting both components and plain values cannot be
// hot-reloaded reliably, so every edit to a colour forced a full remount and lost page state.
import { C, alpha } from "./theme.js";

export function SLabel({ children, color }) {
  return <div style={{ fontSize: 12, letterSpacing: 2.5, color: color || C.lbl, textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>{children}</div>;
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
export function StaleChip({ children = null, title = undefined }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6, verticalAlign: "middle",
      fontSize: 10, fontWeight: 900, letterSpacing: 0.6, textTransform: "uppercase", whiteSpace: "nowrap",
      color: C.amber, background: C.aBg, border: "1px solid " + C.aBdr, borderRadius: 5, padding: "1px 6px" }}>
      ⚠ stale{children ? <span style={{ fontWeight: 700, textTransform: "none", letterSpacing: 0 }}>· {children}</span> : null}
    </span>
  );
}
