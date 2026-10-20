// src/CoveragePanel.jsx — Data health › Ticker coverage (Go: COV). Which tickers each part of the
// dashboard takes: a box to check one symbol, the open sources and what they answer for, and every
// fixed list with where it lives in the code. All of it from lib/coverage.js, which reads the lists
// the screens themselves use.
import { useState } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { coverageFor, priceSymbol, COVERAGE_LISTS, COVERAGE_OPEN } from "../lib/coverage.js";
import { TICKER_RE } from "../lib/goCommands.js";
import { UniverseAdd } from "./UniverseAdd.jsx";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const TONE = { yes: ["✓", () => C.green], try: ["?", () => C.blue], no: ["–", () => C.lbl] };

export function CoveragePanel({ onOpenTicker = null }) {
  const [typed, setTyped] = useState("");
  const [sym, setSym] = useState("");
  const [open, setOpen] = useState(null);
  const rows = sym ? coverageFor(sym) : [];
  const check = (e) => { e.preventDefault(); const s = typed.trim().toUpperCase(); if (s && TICKER_RE.test(s)) setSym(s); };

  return (
    <Card id="coverage" style={{ scrollMarginTop: 170 }}>
      <SLabel>Ticker coverage</SLabel>
      <div style={{ fontSize: 12.5, color: C.mid, lineHeight: 1.55, marginBottom: 10 }}>
        Two kinds. <b>Open</b> sources take any symbol and answer if they have it: price from Yahoo, filings from SEC EDGAR, a custom gamma read from OCC and CBOE. <b>Fixed</b> lists are what a screen was built around. Check a symbol, or read the lists below.
      </div>

      <form onSubmit={check} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} aria-label="Symbol to check" placeholder="NVDA, 005930.KS, CL=F, ^VIX"
          autoCapitalize="characters" autoComplete="off" spellCheck={false}
          style={{ width: 220, maxWidth: "100%", padding: "7px 10px", fontSize: 14, fontWeight: 700, fontFamily: MONO, border: "1.5px solid " + C.bdr, borderRadius: 8, background: C.bg, color: C.text }} />
        <button type="submit" style={{ padding: "7px 14px", fontSize: 13, fontWeight: 800, borderRadius: 8, border: "1.5px solid " + C.blue, background: C.blBg, color: C.blue, cursor: "pointer" }}>Check</button>
        {typed && !TICKER_RE.test(typed.trim().toUpperCase()) && <span style={{ fontSize: 11.5, color: C.amber }}>Not a symbol shape: letters, digits, and . - = with an optional leading ^.</span>}
      </form>

      {sym && (
        <div style={{ marginTop: 10, border: "1px solid " + C.bdr, borderRadius: 8, padding: "8px 10px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
            <b style={{ fontFamily: MONO, fontSize: 15 }}>{sym}</b>
            {priceSymbol(sym) !== sym && <span style={{ fontSize: 11.5, color: C.muted }}>priced as <b style={{ fontFamily: MONO }}>{priceSymbol(sym)}</b></span>}
            {onOpenTicker && <button onClick={() => onOpenTicker(sym)} style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Open its ticker page →</button>}
          </div>
          {rows.map(r => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "3px 0", borderTop: "1px solid " + C.bdr, fontSize: 12.5 }}>
              <b style={{ width: 14, color: TONE[r.status][1]() }}>{TONE[r.status][0]}</b>
              <span style={{ minWidth: 96, fontWeight: 700, color: C.mid }}>{r.label}</span>
              <span style={{ color: C.text, overflowWrap: "anywhere" }}>{r.why}</span>
            </div>
          ))}
          <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 4 }}>✓ covered · ? an open source; it works if the source has this symbol · – not covered</div>
          <UniverseAdd sym={sym} />
        </div>
      )}

      <div style={{ marginTop: 14, fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", color: C.lbl }}>Open — any symbol the source has</div>
      {COVERAGE_OPEN.map(o => (
        <div key={o.feature} style={{ padding: "6px 0", borderBottom: "1px solid " + C.bdr, fontSize: 12.5, lineHeight: 1.5 }}>
          <b>{o.feature}</b> <span style={{ color: C.muted }}>· {o.source}</span>
          <div style={{ color: C.mid }}>{o.takes}</div>
        </div>
      ))}

      <div style={{ marginTop: 14, fontSize: 10.5, fontWeight: 800, letterSpacing: 1.2, textTransform: "uppercase", color: C.lbl }}>Fixed — only these</div>
      {COVERAGE_LISTS.map(l => (
        <div key={l.id} style={{ padding: "6px 0", borderBottom: "1px solid " + C.bdr, fontSize: 12.5, lineHeight: 1.5 }}>
          <button onClick={() => setOpen(open === l.id ? null : l.id)} aria-expanded={open === l.id}
            style={{ display: "flex", gap: 8, alignItems: "baseline", width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", color: C.text, textAlign: "left", font: "inherit" }}>
            <b>{l.title}</b>
            <span style={{ color: C.muted }}>{l.names.length} {l.names.length === 1 ? "name" : "names"}</span>
            <span style={{ marginLeft: "auto", color: C.blue, fontWeight: 700, fontSize: 12 }}>{open === l.id ? "hide" : "show"}</span>
          </button>
          <div style={{ color: C.mid }}>{l.note}</div>
          {open === l.id && (
            <>
              <div style={{ fontFamily: MONO, fontSize: 12, color: C.text, marginTop: 4, overflowWrap: "anywhere", lineHeight: 1.7 }}>{l.names.join("  ")}</div>
              <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 2 }}>Kept in {l.where}</div>
            </>
          )}
        </div>
      ))}
    </Card>
  );
}
