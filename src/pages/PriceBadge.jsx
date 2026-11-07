// src/pages/PriceBadge.jsx — a ticker's live price, or the hand-entered one with its date and a link
// to the exchange page when the feed has no quote. Shared by Hedges/Income asset detail and the
// Smart Money fund cards.
import { useState } from "react";
import { C } from "../theme.js";

// Exchange deep-links for UAE names, for the manual price entry. Yahoo prices the DFM names
// (DEWA, EMAAR) but no ADX name (checked 21 Oct 2026: FAB, ADNOCGAS, ADNOCDIST, EAND, ALDAR, ADIB),
// so the ADX ones need the hand-entered price.
const EXCHANGE_LINKS = {
  "DEWA.AE":     "https://www.dfm.ae/the-exchange/market-information/company/DEWA/trading",
  "ADNOCGAS.AE": "https://www.adx.ae/English/Pages/SecurityDetails.aspx?Symbol=ADNOCGAS",
  "EMAAR.AE":    "https://www.dfm.ae/the-exchange/market-information/company/EMAAR/trading",
  "FAB.AE":      "https://www.adx.ae/English/Pages/SecurityDetails.aspx?Symbol=FAB",
};

function ccyPrefix(ticker) {
  if (typeof ticker !== "string") return "$";
  if (ticker.endsWith(".TO")) return "C$";
  if (ticker.endsWith(".HK")) return "HK$";
  if (ticker.endsWith(".AE")) return "AED ";
  return "$";
}

function readManual(ticker) {
  try { return { price: localStorage.getItem("manual_price_" + ticker), date: localStorage.getItem("manual_price_date_" + ticker) }; }
  catch (_) { return { price: null, date: null }; }
}

// Format a stored ISO date as e.g. "Jun 25, 2026" (tolerant of "YYYY-MM-DD" too).
function fmtManualDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Manual price entry for tickers with no live feed (ADX/DFM names). Mirrors the
// recession-table manual-update pattern: saved price shown live-style with a ✏️ to
// edit, "Updated: <date>" beneath, exchange deep-link always visible.
function ManualPrice({ ticker }) {
  const stored = readManual(ticker);
  const [editing, setEditing] = useState(false);
  const [val, setVal]   = useState(stored.price || "");
  const [date, setDate] = useState(stored.date || "");
  const [draft, setDraft] = useState(stored.price || "");
  const link = EXCHANGE_LINKS[ticker];
  function commit() {
    setEditing(false);
    const clean = String(draft).replace(/[^0-9.]/g, "");
    if (!clean) return;
    const isoNow = new Date().toISOString();
    try {
      localStorage.setItem("manual_price_" + ticker, clean);
      localStorage.setItem("manual_price_date_" + ticker, isoNow);
    } catch (_) { /* storage refused — a private window stores nothing, and none of this is load-bearing */ }
    setVal(clean); setDate(isoNow);
  }
  const linkIcon = link && (
    <a href={link} target="_blank" rel="noopener noreferrer" title="Open exchange page" style={{ fontSize: 12, textDecoration: "none" }}>🔗</a>
  );
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      {editing ? (
        <input
          autoFocus value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          type="number" step="0.01" placeholder="price"
          style={{ width: 70, fontSize: 13, padding: "2px 5px", border: "1.5px solid " + C.blBdr, borderRadius: 5, color: C.text }}
        />
      ) : val ? (
        <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.25 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{ccyPrefix(ticker)}{val}</span>
            <span onClick={() => { setDraft(val); setEditing(true); }} title="Edit price" style={{ cursor: "pointer", fontSize: 11 }}>✏️</span>
          </span>
          {date && <span style={{ color: C.lbl, fontSize: 10 }}>Updated: {fmtManualDate(date)}</span>}
        </span>
      ) : (
        <span onClick={() => { setDraft(""); setEditing(true); }} title="Tap to enter price" style={{ cursor: "pointer", color: C.lbl, fontSize: 12, fontStyle: "italic" }}>
          Tap to enter price
        </span>
      )}
      {linkIcon}
    </span>
  );
}

export function PriceBadge({ ticker, prices }) {
  const p = prices[ticker];
  const isAE = typeof ticker === "string" && ticker.endsWith(".AE");
  // No live price → manual entry for unsupported feeds (.AE) or any ticker the
  // user has already saved a manual price for; otherwise the usual placeholder.
  if (!p) {
    if (isAE || readManual(ticker).price) return <ManualPrice ticker={ticker} />;
    return <span style={{ color: C.lbl, fontSize: 12 }}>—</span>;
  }
  const up = (p.changePercent || 0) >= 0;
  const col = up ? C.green : C.red;
  const link = EXCHANGE_LINKS[ticker];
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      <span style={{ color: C.text, fontWeight: 700, fontSize: 14 }}>{ccyPrefix(ticker)}{(p.price || 0).toFixed(2)}</span>
      <span style={{ color: col, fontWeight: 700, fontSize: 13 }}>
        {up ? "↑" : "↓"}{Math.abs(p.changePercent || 0).toFixed(2)}%
      </span>
      {link && <a href={link} target="_blank" rel="noopener noreferrer" title="Open exchange page" style={{ fontSize: 12, textDecoration: "none" }}>🔗</a>}
    </span>
  );
}
