// src/CtaPanel.jsx — where trend funds (CTAs) probably sit, on the Daily Overview.
//
// STATE → EVIDENCE → WHAT FLIPS IT, per market: the replica's position and how it has moved over a
// week; the three windows behind it; and the prices that would cut it. It is a MODEL of mechanical
// trend funds rebuilt from public prices (lib/cta.js), not their orders, and the card says so.
import { useEffect, useState } from "react";
import { C, alpha } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { priceDp, CROWDED, NEUTRAL } from "../lib/cta.js";

const fmtPx = (p) => (p == null ? "—" : Number(p).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: priceDp(p) }));
const pct = (v) => { if (v == null) return "—"; const n = Math.round(v * 100); return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}%`; };
const signed = (v, dp = 1) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}`);
// Neutral is grey, not a faint long: inside ±20% the model is close to flat, and colour would say otherwise.
const toneOf = (pos) => (pos == null || Math.abs(pos) < NEUTRAL ? C.muted : pos > 0 ? C.green : C.purple);

// −100% … +100% as a bar from the centre, so a long and a short read in opposite directions.
function PositionBar({ pos }) {
  const w = Math.min(1, Math.abs(pos ?? 0)) * 50;
  const col = toneOf(pos);
  return (
    <div style={{ position: "relative", height: 8, width: 120, background: C.inset, borderRadius: 4, flex: "0 0 auto" }}>
      <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: C.bdrMd }} />
      {pos != null && (
        <div style={{ position: "absolute", top: 0, bottom: 0, borderRadius: 4, background: col,
                      left: pos >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />
      )}
    </div>
  );
}

function MarketRow({ m }) {
  if (!m.ok) {
    return (
      <div style={{ padding: "8px 0", borderTop: "1px solid " + C.bdr, fontSize: 12.5, color: C.muted }}>
        <b style={{ color: C.mid }}>{m.key}</b> {m.label} — no read ({m.reason})
      </div>
    );
  }
  const tone = toneOf(m.position);
  const crowded = Math.abs(m.position) >= CROWDED;
  const flips = m.windows.map(w => `${w.label} ${fmtPx(w.flip)} (${signed(w.flipPct)}%)`).join(" · ");
  const sc = (k) => m.scenarios.find(s => s.sigmas === k)?.position;
  return (
    <div style={{ padding: "9px 0", borderTop: "1px solid " + C.bdr }}>
      <div style={{ display: "flex", alignItems: "center", gap: "4px 10px", flexWrap: "wrap" }}>
        <b style={{ fontSize: 14, color: C.text, minWidth: 28 }}>{m.key}</b>
        <span style={{ fontSize: 12.5, color: C.muted, minWidth: 92 }}>{m.label}</span>
        <span style={{ fontSize: 13, color: C.mid, fontVariantNumeric: "tabular-nums", minWidth: 72 }}>{fmtPx(m.price)}</span>
        <PositionBar pos={m.position} />
        <b style={{ fontSize: 13, color: tone, fontVariantNumeric: "tabular-nums" }}>{pct(m.position)} {m.stance}</b>
        {crowded && (
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", color: tone,
                         background: alpha(tone, 0.12), border: "1px solid " + alpha(tone, 0.35), borderRadius: 999, padding: "1px 7px" }}>
            crowded
          </span>
        )}
        {m.change != null && m.change !== 0 && (
          <span style={{ fontSize: 12, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
            {m.change > 0 ? "▲" : "▼"} {signed(m.change * 100, 0)} pts over 5 sessions
          </span>
        )}
      </div>
      <div style={{ marginTop: 5, fontSize: 12, color: C.mid, lineHeight: 1.55 }}>
        {m.cut ? (
          <span>Cut level <b style={{ color: C.text }}>{fmtPx(m.cut.flip)}</b> ({m.cut.label} window, {signed(m.cut.flipPct)}%, {signed(m.cut.flipSigmas)} daily σ)</span>
        ) : (
          <span>No window flip on the cutting side</span>
        )}
        <span style={{ color: C.muted }}> · net flat at {fmtPx(m.flip)} ({signed(m.flipPct)}%)</span>
      </div>
      <div style={{ marginTop: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.55 }}>
        Flips {flips}
      </div>
      <div style={{ marginTop: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.55, fontVariantNumeric: "tabular-nums" }}>
        Position at −2σ {pct(sc(-2))} · −1σ {pct(sc(-1))} · unchanged {pct(sc(0))} · +1σ {pct(sc(1))} · +2σ {pct(sc(2))}
        {m.roll === "high" && <span> · levels in front-month terms; the longer windows span contract rolls</span>}
      </div>
    </div>
  );
}

export function CtaPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/atr?cta=1")
      .then(r => r.json())
      .then(j => { if (!cancelled) { if (j?.ok) setData(j); else setErr(j?.reason || "no read"); } })
      .catch(e => { if (!cancelled) setErr(String(e.message || e)); });
    return () => { cancelled = true; };
  }, []);

  const live = data?.markets?.some(m => m.ok && m.live);
  const n = data?.summary?.nearest;
  return (
    <Card id="daily-cta">
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <SLabel>CTA positioning · trend-fund replica</SLabel>
        {data?.at && <span style={{ fontSize: 11, color: C.muted }}>computed {new Date(data.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      {err && <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>No CTA read: {err}</div>}
      {!data && !err && <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>Loading…</div>}
      {data && (
        <>
          {data.summary && (
            <div style={{ marginTop: 6, fontSize: 13.5, color: C.text, lineHeight: 1.5 }}>
              <b>{data.summary.line}</b>
              {n && <span style={{ color: C.mid }}> — nearest cut: {n.key} {fmtPx(n.flip)} ({n.label}, {signed(n.pct)}%, {signed(n.sigmas)} daily σ)</span>}
            </div>
          )}
          <div style={{ marginTop: 8 }}>
            {data.markets.map(m => <MarketRow key={m.key} m={m} />)}
          </div>
          <div style={{ marginTop: 8, fontSize: 11.5, color: C.muted, lineHeight: 1.55 }}>
            A model of where mechanical trend funds probably sit, not their orders. Each market blends
            1-, 3- and 12-month trends measured in its own volatility; ±100% is the model&apos;s maximum.
            Flip levels apply to {live ? "today's" : "the next"} close. No dollar flow is estimated.
          </div>
        </>
      )}
    </Card>
  );
}
