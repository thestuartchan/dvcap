// src/SpMapCard.jsx — the S&P side of the Gamma panel: SPY's board with SPX's map on it (12 Oct 2026).
//
// SPX index options (SPX + SPXW) carry ~94% of S&P options gamma, and some levels exist only there.
// Stu trades SPY, MES and ES — so SPX is drawn as a MAP in SPY prices, not as a board of its own:
//   · one ladder, two bars per SPY strike from the same zero axis — SPY hollow on top, SPX (converted)
//     solid below; green positive, purple negative; each book scaled to its own largest bar;
//   · rows the two books agree on carry a gold band and ★, SPX-only levels a blue band and ◆, with a
//     short label on the right; both flips dashed, the space between them shaded as a grey zone when
//     they are more than 0.2% apart; spot drawn at the SPY price;
//   · chips (SPY net, SPX net, SPX share, the ratio, the ES premium) and the S&P key levels — SPY
//     board, SPX → SPY price, ES equivalent, agreement.
// The numbers are lib/spMap.js's, served by /api/gex?spmap=1 from the feed's own two boards. If the
// map cannot be built the card says why and the SPY-only ladder (`fallback`) is drawn instead.
import { useEffect, useMemo, useState } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";

const ROW = 18;
const fmtBn = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v) >= 10 ? Math.abs(v).toFixed(1) : Math.abs(v).toFixed(2)}bn`);
const fmtMn = (v) => (v == null ? "—" : Math.abs(v) >= 1000 ? `${v >= 0 ? "+" : "−"}$${(Math.abs(v) / 1000).toFixed(1)}bn` : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(0)}M`);
const f2 = (v) => (v == null ? "—" : (+v).toFixed(2));
const AGREE = {
  agree: { sym: "★", text: "agree", color: C.amber, bg: C.aBg, bdr: C.aBdr },
  spx_only: { sym: "◆", text: "SPX-only", color: C.blue, bg: C.blBg, bdr: C.blBdr },
  disagree: { sym: "✗", text: "disagree", color: C.red, bg: C.rBg, bdr: C.rBdr },
  spy_only: { sym: "·", text: "SPY-only", color: C.muted, bg: "transparent", bdr: C.bdr },
};

function Chip({ k, v, sub, color, warn }) {
  return (
    <div style={{ border: "1px solid " + C.bdr, borderRadius: 8, padding: "5px 9px", background: C.bg, minWidth: 92 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: C.lbl }}>{k}</div>
      <div style={{ fontSize: 14, fontWeight: 900, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>{warn ? "⚠ " : ""}{v}</div>
      {sub && <div style={{ fontSize: 10, color: C.muted }}>{sub}</div>}
    </div>
  );
}

// Where a price sits on the ladder: rows are SPY strikes, highest first, ROW px apart.
function yOf(keys, price) {
  if (price == null || !keys.length) return null;
  if (price >= keys[0]) return ROW / 2 - (price - keys[0]) * ROW;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (price <= a && price >= b) return (i + (a - price) / (a - b)) * ROW + ROW / 2;
  }
  return (keys.length - 1) * ROW + ROW / 2 + (keys[keys.length - 1] - price) * ROW;
}

function DualLadder({ rows, map }) {
  const keys = rows.map(r => r.spy_strike);
  const spyMax = Math.max(1, ...rows.map(r => Math.abs(r.spy_mn)));
  const spxMax = Math.max(1, ...rows.map(r => Math.abs(r.spx_mn)));
  const H = rows.length * ROW;
  const spot = map.spy.spot, spyFlip = map.spy.flip, spxFlip = map.spx.flip_spy;
  const g = map.grey_zone;
  const inView = (y) => y != null && y >= 0 && y <= H;
  const line = (y, color, dashed, label, side = "right") => inView(y) && (
    <div style={{ position: "absolute", left: 44, right: 0, top: y, height: 0, borderTop: `${dashed ? 1.5 : 2}px ${dashed ? "dashed" : "solid"} ${color}`, pointerEvents: "none", zIndex: 2 }}>
      <span style={{ position: "absolute", [side]: 4, top: -14, fontSize: 10, fontWeight: 900, color, background: C.surf, padding: "0 4px", borderRadius: 3, whiteSpace: "nowrap" }}>{label}</span>
    </div>
  );
  const bar = (v, max, hollow) => {
    if (!v) return null;
    const w = `${Math.min(50, (Math.abs(v) / max) * 50)}%`;
    const col = v > 0 ? C.green : C.purple;
    return (
      <div style={{ position: "absolute", top: hollow ? 2 : 9, height: 7, width: w, [v > 0 ? "left" : "right"]: "50%",
                    background: hollow ? "transparent" : col, border: hollow ? `1.5px solid ${col}` : "none", boxSizing: "border-box", borderRadius: 2 }} />
    );
  };
  return (
    <div style={{ position: "relative", height: H, marginTop: 8 }}>
      {g && inView(yOf(keys, g.hi)) && inView(yOf(keys, g.lo)) && (
        <div style={{ position: "absolute", left: 44, right: 0, top: yOf(keys, g.hi), height: Math.max(2, yOf(keys, g.lo) - yOf(keys, g.hi)),
                      background: C.rBg, borderTop: `1px dashed ${C.rBdr}`, borderBottom: `1px dashed ${C.rBdr}`, zIndex: 0, pointerEvents: "none" }}>
          <span style={{ position: "absolute", left: "52%", top: 1, fontSize: 9.5, fontWeight: 800, color: C.red, whiteSpace: "nowrap" }}>grey zone · the flips disagree</span>
        </div>
      )}
      {rows.map((r, i) => {
        const a = r.mark ? AGREE[r.mark] : null;
        return (
          <div key={r.spy_strike} title={`${r.label ? r.label + " — " : ""}${r.spy_strike} · SPY ${fmtMn(r.spy_mn)} · SPX ${fmtMn(r.spx_mn)}`}
            style={{ position: "absolute", top: i * ROW, left: 0, right: 0, height: ROW, display: "flex", alignItems: "center",
                     background: a ? a.bg : "transparent", borderLeft: a ? `3px solid ${a.bdr}` : "3px solid transparent", zIndex: 1 }}>
            <span style={{ width: 41, textAlign: "right", paddingRight: 5, fontSize: 10.5, fontWeight: 800, color: a ? a.color : C.lbl, fontVariantNumeric: "tabular-nums", flex: "none" }}>
              {a ? a.sym : ""}{r.spy_strike}
            </span>
            <div style={{ position: "relative", flex: "1 1 55%", height: ROW, minWidth: 120 }}>
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, borderLeft: `1px solid ${C.bdrMd}` }} />
              {bar(r.spy_mn, spyMax, true)}
              {bar(r.spx_mn, spxMax, false)}
            </div>
            <span style={{ flex: "1 1 45%", minWidth: 0, paddingLeft: 6, fontSize: 10.5, fontWeight: 800, color: a ? a.color : C.muted,
                           overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label || ""}</span>
          </div>
        );
      })}
      {line(yOf(keys, spot), C.blue, false, `spot · SPY ${f2(spot)}`, "left")}
      {line(yOf(keys, spyFlip), C.mid, true, `SPY flip ${f2(spyFlip)}`)}
      {line(yOf(keys, spxFlip), C.lbl, true, `SPX flip ${f2(map.spx.flip)} → ${f2(spxFlip)}`)}
    </div>
  );
}

function KeyLevels({ levels }) {
  // Rows that wrap rather than a table that scrolls: the label and its note, then four captioned
  // values — one line on a desktop, the values under the label on a phone.
  const cell = (cap, v, strong, w = 92) => (
    <div style={{ width: w, textAlign: "right", flex: "none" }}>
      <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: C.lbl }}>{cap}</div>
      <div style={{ fontVariantNumeric: "tabular-nums", fontWeight: strong ? 800 : 600, color: C.text }}>{v}</div>
    </div>
  );
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: C.lbl, marginBottom: 2 }}>S&amp;P key levels</div>
      {levels.map((r, i) => {
        const a = AGREE[r.agreement] || null;
        return (
          <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: "4px 10px", alignItems: "flex-start", padding: "6px 0", borderTop: "1px solid " + C.bdr, fontSize: 11.5 }}>
            <div style={{ flex: "1 1 230px", minWidth: 0 }}>
              <b style={{ color: C.text }}>{r.label}</b>
              {r.note && <div style={{ fontSize: 10.5, color: r.agreement === "disagree" ? C.red : C.muted, marginTop: 1 }}>{r.note}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, flex: "none", marginLeft: "auto", flexWrap: "wrap", justifyContent: "flex-end" }}>
              {cell("SPY board", r.spy != null ? f2(r.spy) : "—", true, 66)}
              {cell("SPX → SPY", r.spx != null ? <><span style={{ color: C.muted, fontWeight: 600 }}>{r.spx} → </span>{f2(r.spx_spy_eq)}</> : "—", true, 118)}
              {cell("ES equiv.", r.es_eq != null ? f2(r.es_eq) : "—", false, 66)}
              <div style={{ width: 80, flex: "none" }}>
                <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: C.lbl }}>Agreement</div>
                <div style={{ color: a ? a.color : C.muted, fontWeight: 800, whiteSpace: "nowrap" }}>{a ? `${a.sym} ${a.text}` : "—"}</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SpMapCard({ fallback = null, refreshKey = 0 }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let cancelled = false;
    // The previous map stays on screen while a refresh is in flight; the first load shows the note.
    fetch("/api/gex?spmap=1", { credentials: "include" })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(j => { if (!cancelled) setD(j); })
      .catch(e => { if (!cancelled) setD({ ok: false, reason: String(e.message || e) }); });
    return () => { cancelled = true; };
  }, [refreshKey]);
  const m = d?.map;
  const rows = useMemo(() => (d?.ladder || []), [d]);
  if (!d) {
    return <Card><SLabel>S&amp;P gamma · SPY + SPX</SLabel><div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>Reading the SPX book (SPX + SPXW, OCC open interest on CBOE's surface) — a few seconds…</div></Card>;
  }
  if (!d.ok || !m?.ok) {
    return (
      <>
        <Card>
          <SLabel>S&amp;P gamma · SPY + SPX</SLabel>
          <div style={{ fontSize: 12, color: C.amber, marginTop: 6 }}>The SPX map is not available — {d.reason || m?.reason || "no answer"}. The SPY-only ladder is below.</div>
        </Card>
        {fallback}
      </>
    );
  }
  const spxStale = d.spx?.staleReason;
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <SLabel>S&amp;P gamma · SPY board + SPX map</SLabel>
        <span style={{ fontSize: 11.5, color: C.muted }}>SPX (SPX + SPXW) converted into SPY prices · dollars per 1% move</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <Chip k="SPY net" v={fmtBn(m.spy.net_bn)} color={m.spy.net_bn >= 0 ? C.green : C.purple} />
        <Chip k="SPX net" v={fmtBn(m.spx.net_bn)} color={m.spx.net_bn >= 0 ? C.green : C.purple} sub={`${d.spx?.expiries ?? "?"} expiries`} />
        <Chip k="SPX share" v={m.spx_share_pct != null ? `${Math.round(m.spx_share_pct)}%` : "—"} sub="of S&P options gamma" />
        <Chip k="Ratio" v={m.ratio?.toFixed(5)} warn={m.ratio_warn} sub={m.ratio_warn ? `read ${m.ratio_gap_min} min apart` : (m.ratio_basis || null)} />
        <Chip k="ES premium" v={m.es_basis != null ? `${m.es_basis >= 0 ? "+" : ""}${m.es_basis.toFixed(2)}` : "—"} sub={m.es_basis_label === "live" ? "ES front − SPX, live" : "at the last SPX close"} />
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 10.5, color: C.mid, marginTop: 9 }}>
        <span><span style={{ display: "inline-block", width: 18, height: 7, border: `1.5px solid ${C.green}`, verticalAlign: "middle", marginRight: 4 }} />SPY (hollow, top)</span>
        <span><span style={{ display: "inline-block", width: 18, height: 7, background: C.green, verticalAlign: "middle", marginRight: 4 }} />SPX in SPY prices (solid, below)</span>
        <span style={{ color: C.amber, fontWeight: 800 }}>★ both books agree</span>
        <span style={{ color: C.blue, fontWeight: 800 }}>◆ SPX-only</span>
        <span>each book scaled to its own largest bar — SPY {fmtMn(Math.max(...rows.map(r => Math.abs(r.spy_mn))))}, SPX {fmtMn(Math.max(...rows.map(r => Math.abs(r.spx_mn))))} (SPX is ~{Math.round(Math.abs(m.spx.net_bn / (m.spy.net_bn || 1)))}× larger in dollars)</span>
      </div>
      <DualLadder rows={rows} map={m} />
      <KeyLevels levels={m.levels} />
      <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 8, lineHeight: 1.5 }}>
        Ratio {m.ratio?.toFixed(5)} = SPY ÷ SPX ({m.ratio_basis}{m.ratio_asof ? `, ${m.ratio_asof}` : ""}) — never a fixed 10; it drifts with dividends.
        ES = SPX level + {m.es_basis != null ? m.es_basis.toFixed(2) : "—"} ({m.es_basis_label}; ES front from Yahoo's feed of the CME contract).
        ★: an SPY node and an SPX node of the same sign within 0.1%, each at least a quarter of its own book's largest within ±3%.
        SPX board: {d.spx?.mode === "live_recompute" ? "live recompute" : d.spx?.mode} {d.spx?.asOf ? `at ${String(d.spx.asOf).slice(0, 16).replace("T", " ")} UTC` : ""},
        OCC settled open interest on CBOE's surface, every listed expiry{spxStale ? ` · ⚠ ${spxStale}` : ""}.
      </div>
    </Card>
  );
}
