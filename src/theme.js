// src/theme.js — the palette, and nothing else.
//
// It lived in ui.jsx beside the shared components, which tripped react-refresh: a module that
// exports both components and plain values cannot be hot-reloaded reliably, so every edit to a
// colour forced a full remount and lost whatever state the page was holding. That was the only
// error the linter reported about src/ once the false ones were cleared, and it was describing a
// real cost paid on every theme tweak.
//
// Constants here, components in ui.jsx. Nothing imports this for its side effects.
export const C = {
  bg:"#F2F3F7", surf:"#FFFFFF", bdr:"#E4E7F0", bdrMd:"#C9D0E4",
  text:"#1C1F2E", mid:"#4B5068", muted:"#7C82A0", lbl:"#9CA3C0",
  green:"#166534", gBg:"#F0FDF4", gBdr:"#86EFAC",
  amber:"#92400E", aBg:"#FFFBEB", aBdr:"#FCD34D",
  red:"#991B1B",   rBg:"#FEF2F2", rBdr:"#FCA5A5",
  blue:"#1E40AF",  blBg:"#EFF6FF", blBdr:"#BFDBFE",
};
