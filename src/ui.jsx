// src/ui.jsx — the shared visual vocabulary.
//
// Extracted from App.jsx so that a tab living in its own module can render in the same idiom
// without importing the entire dashboard. These four are used on every surface: the palette and
// the three primitives every card is built from.
//
// The palette moved to theme.js: a module exporting both components and plain values cannot be
// hot-reloaded reliably, so every edit to a colour forced a full remount and lost page state.
import { C } from "./theme.js";

export function SLabel({ children, color }) {
  return <div style={{ fontSize: 12, letterSpacing: 2.5, color: color || C.lbl, textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>{children}</div>;
}

export function Card({ children, style, onClick, id }) {
  return <div id={id} onClick={onClick} style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 5px rgba(0,0,0,.05)", ...style }}>{children}</div>;
}

export function Btn({ onClick, disabled, color, bgColor, label }) {
  return (
    <button onClick={onClick} disabled={!!disabled} style={{ background: bgColor || color, color: bgColor ? color : "#fff", border: bgColor ? "1.5px solid " + color + "60" : "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: disabled ? 0.6 : 1, whiteSpace: "nowrap" }}>
      {label}
    </button>
  );
}
