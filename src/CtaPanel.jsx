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
const fmtK = (v) => { if (v == null) return "—"; const a = Math.abs(v); const t = a >= 1e6 ? `${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : String(a); return `${v > 0 ? "+" : v < 0 ? "−" : ""}${t}`; };
const fmtDay = (iso) => (iso ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—");

// The CFTC's week, and whether that category has ever tested the replica in this market. A record
// that runs the other way is said so, rather than its weekly verdict being read as a check.
function CotLine({ c }) {
  if (!c) return null;
  const t = c.track;
  const head = `CFTC ${c.trader}, week to ${fmtDay(c.date)}: net ${fmtK(c.net)} (${c.netPctOI == null ? "—" : signed(c.netPctOI)}% of open interest), ${fmtK(c.netChange)} on the week`;
  const rec = t ? `agrees ${t.agree} of ${t.clear} weeks (corr ${signed(t.corr, 2)})` : null;
  return (
    <div style={{ marginTop: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.55 }}>
      {head}
      {t?.tracks && c.week !== "unclear" && <span> — <b style={{ color: c.week === "agrees" ? C.mid : C.amber }}>{c.week === "agrees" ? "with" : "against"} the replica this week</b></span>}
      {rec && <span>. Past year: {rec}</span>}
      {t && !t.tracks && <span> — this category does not track the replica here, so it does not test it</span>}
      .
    </div>
  );
}

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

// THE TRIGGER, IN WORDS. What the level does, not what it is called: for a long, where selling
// starts; for a short, where covering starts; for a neutral market, the net-flat price where the
// three windows cancel and the model tips to one side.
function KeyLevel({ m }) {
  const c = m.cut;
  const dist = (x) => `${signed(x.flipPct)}%, ${signed(x.flipSigmas)} daily σ`;
  let lead;
  if (!c) lead = <span>No window flip on the reducing side</span>;
  else if (c.net) lead = <span>Tips net {c.tips} {c.side} <b style={{ color: C.text }}>{fmtPx(c.flip)}</b> ({dist(c)}) — where the three windows cancel</span>;
  else if (m.position > 0) lead = <span>Selling starts below <b style={{ color: C.text }}>{fmtPx(c.flip)}</b> ({dist(c)}), where the {c.label} window turns short</span>;
  else lead = <span>Covering starts above <b style={{ color: C.text }}>{fmtPx(c.flip)}</b> ({dist(c)}), where the {c.label} window turns long</span>;
  return (
    <div style={{ marginTop: 5, fontSize: 12, color: C.mid, lineHeight: 1.55 }}>
      <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: C.lbl, marginRight: 6 }}>Key level</span>
      {lead}
      {c && !c.net && m.flip != null && <span style={{ color: C.muted }}> · net flat at {fmtPx(m.flip)} ({signed(m.flipPct)}%)</span>}
    </div>
  );
}

// EACH WINDOW'S OWN SIDE, beside the price that turns it. "Flips 1m 4,653.30" left the reader to
// work out what it flipped from and to; the side is what makes the level readable.
function Windows({ m }) {
  return (
    <div style={{ marginTop: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.6, display: "flex", flexWrap: "wrap", gap: "0 14px" }}>
      {m.windows.map(w => {
        const side = w.score > 0 ? "long" : w.score < 0 ? "short" : "flat";
        const turns = w.flip < m.price ? `short below` : `long above`;
        return (
          <span key={w.label} style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
            <b style={{ color: C.mid }}>{w.label}</b>{" "}
            <span style={{ color: toneOf(w.score), fontWeight: 700 }}>{pct(w.score)} {side}</span>
            {" → "}{turns} {fmtPx(w.flip)} ({signed(w.flipPct)}%)
          </span>
        );
      })}
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
      <KeyLevel m={m} />
      <Windows m={m} />
      <div style={{ marginTop: 2, fontSize: 11.5, color: C.muted, lineHeight: 1.55, fontVariantNumeric: "tabular-nums" }}>
        Position at −2σ {pct(sc(-2))} · −1σ {pct(sc(-1))} · unchanged {pct(sc(0))} · +1σ {pct(sc(1))} · +2σ {pct(sc(2))}
        {m.roll === "high" && <span> · levels in front-month terms; the longer windows span contract rolls</span>}
      </div>
      <CotLine c={m.cot} />
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
              {n && <span style={{ color: C.mid }}> — nearest key level: {n.key} {fmtPx(n.flip)} ({n.label === "net" ? "net flat" : `${n.label} window`}, {signed(n.pct)}%, {signed(n.sigmas)} daily σ)</span>}
            </div>
          )}
          {data.calibration?.tested && (
            <div style={{ marginTop: 4, fontSize: 12, color: C.mid, lineHeight: 1.5 }}>
              CFTC check, week to {fmtDay(data.calibration.date)}:{" "}
              {data.calibration.tested.length
                ? <>tests the replica in {data.calibration.tested.join(", ")} ({data.calibration.week.agree} of {data.calibration.week.clear} with it this week)</>
                : <>tests the replica in no market this year</>}
              {data.calibration.untested.length > 0 && (
                <span style={{ color: C.muted }}>; not in {data.calibration.untested.join(", ")}, where the funds category runs opposite the replica</span>
              )}
              .
            </div>
          )}
          {data.calibration?.error && <div style={{ marginTop: 4, fontSize: 12, color: C.muted }}>CFTC check unavailable: {data.calibration.error}</div>}
          <div style={{ marginTop: 8 }}>
            {data.markets.map(m => <MarketRow key={m.key} m={m} />)}
          </div>
          <div style={{ marginTop: 8, fontSize: 11.5, color: C.muted, lineHeight: 1.55 }}>
            How to read it: the net position is what the model holds — the average of its 1-, 3- and
            12-month windows, ±100% at the maximum — so read it for crowding. The key level is the nearest
            price that changes it, so read it as the trigger. The 1-month window is the fast money and
            usually flips first; the 12-month is the slow backdrop. A model of where trend funds probably
            sit, not their orders.
            Flip levels apply to {live ? "today's" : "the next"} close. No dollar flow is estimated. The CFTC's
            weekly report is the check: managed money in commodities is the closest public proxy for trend
            funds; leveraged funds in financial futures are dominated by basis and relative-value books.
          </div>
        </>
      )}
    </Card>
  );
}
