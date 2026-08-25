// src/ui.jsx — the shared visual vocabulary.
//
// Extracted from App.jsx so that a tab living in its own module can render in the same idiom
// without importing the entire dashboard. These four are used on every surface: the palette and
// the three primitives every card is built from.

export const C = {
  bg:"#F2F3F7", surf:"#FFFFFF", bdr:"#E4E7F0", bdrMd:"#C9D0E4",
  text:"#1C1F2E", mid:"#4B5068", muted:"#7C82A0", lbl:"#9CA3C0",
  green:"#166534", gBg:"#F0FDF4", gBdr:"#86EFAC",
  amber:"#92400E", aBg:"#FFFBEB", aBdr:"#FCD34D",
  red:"#991B1B",   rBg:"#FEF2F2", rBdr:"#FCA5A5",
  blue:"#1E40AF",  blBg:"#EFF6FF", blBdr:"#BFDBFE",
};

export function SLabel({ children, color }) {
  return <div style={{ fontSize: 12, letterSpacing: 2.5, color: color || C.lbl, textTransform: "uppercase", fontWeight: 700, marginBottom: 10 }}>{children}</div>;
}

export function Card({ children, style, onClick }) {
  return <div onClick={onClick} style={{ background: C.surf, border: "1.5px solid " + C.bdr, borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 5px rgba(0,0,0,.05)", ...style }}>{children}</div>;
}

export function Btn({ onClick, disabled, color, bgColor, label }) {
  return (
    <button onClick={onClick} disabled={!!disabled} style={{ background: bgColor || color, color: bgColor ? color : "#fff", border: bgColor ? "1.5px solid " + color + "60" : "none", borderRadius: 8, padding: "8px 14px", fontSize: 14, fontWeight: 700, cursor: "pointer", opacity: disabled ? 0.6 : 1, whiteSpace: "nowrap" }}>
      {label}
    </button>
  );
}
