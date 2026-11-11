// src/FlowPanel.jsx — Unusual Whales flow (build step 8, lib/uw.js via /api/flow), under the Gamma
// board: Market Tide, QQQ/SPY net premium and NOPE, UW's GEX levels against dvcap's board, dark-pool
// levels and the latest flow alerts. Read-only. UW data is licensed for personal use: the route
// answers only the dashboard session, and nothing here is posted anywhere.
import { useEffect, useState, useCallback } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ReferenceArea, ComposedChart, Area } from "recharts";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { gammaCrossCheck } from "../lib/uw.js";
import { dubaiEtStamp } from "../lib/timeFmt.js";

const usd = (v) => (v == null || !Number.isFinite(v) ? "—"
  : `${v < 0 ? "−" : "+"}$${Math.abs(v) >= 1e9 ? (Math.abs(v) / 1e9).toFixed(2) + "bn" : Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(1) + "M" : Math.round(Math.abs(v) / 1e3) + "k"}`);
const tone = (v) => (v == null ? C.mid : v > 0 ? C.green : v < 0 ? C.red : C.mid);
const lvl = (v) => (v == null || !Number.isFinite(v) ? "—" : (+v).toFixed(v >= 100 ? 0 : 2));

function Stat({ label, value, color, sub }) {
  return (
    <div style={{ minWidth: 104 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 800, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>}
    </div>
  );
}

function Ticker({ sym, t, board }) {
  const cc = board ? gammaCrossCheck(t.gex, board, board.spot ?? t.spot) : null;
  const top = (t.alerts || []).slice().sort((a, b) => (b.premium || 0) - (a.premium || 0)).slice(0, 6);
  return (
    <div style={{ border: "1px solid " + C.bdr, borderRadius: 10, padding: 12, display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <b style={{ fontSize: 16 }}>{sym}</b>
        <span style={{ fontSize: 11.5, color: C.muted }}>{t.spot != null ? `spot ${lvl(t.spot)}` : ""}</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
        <Stat label="Net premium" value={usd(t.netPrem?.net)} color={tone(t.netPrem?.net)} sub={t.netPrem ? `calls ${usd(t.netPrem.netCall)} · puts ${usd(t.netPrem.netPut)}` : "not available"} />
        <Stat label="NOPE" value={t.nope?.nope != null ? t.nope.nope.toFixed(2) : "—"} color={tone(t.nope?.nope)} sub="net options delta ÷ stock volume" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr 1fr", gap: "2px 12px", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
        <span style={{ color: C.lbl, fontWeight: 700 }}>GEX</span><span style={{ color: C.lbl, fontWeight: 700 }}>UW (flow-weighted)</span><span style={{ color: C.lbl, fontWeight: 700 }}>dvcap board</span>
        <span style={{ color: C.muted }}>Call wall</span><span>{lvl(t.gex?.callWall)}</span><span>{lvl(board?.callWall)}</span>
        <span style={{ color: C.muted }}>Flip</span><span>{lvl(t.gex?.flip)}</span><span>{lvl(board?.flip)}</span>
        <span style={{ color: C.muted }}>Put wall</span><span>{lvl(t.gex?.putWall)}</span><span>—</span>
      </div>
      {cc && <div style={{ fontSize: 12, fontWeight: 700, color: cc.agree ? C.green : C.amber }}>
        {cc.agree ? "Both books agree within 0.5%" : `Books disagree: wall ${cc.wallGapPct ?? "—"}% · flip ${cc.flipGapPct ?? "—"}% of spot (both shown, neither overrides)`}
      </div>}
      {(t.darkpool || []).length > 0 && (
        <div style={{ fontSize: 12.5 }}>
          <div style={{ color: C.lbl, fontWeight: 700, marginBottom: 2 }}>Dark-pool levels</div>
          {t.darkpool.map(r => <div key={r.price} style={{ display: "flex", justifyContent: "space-between", fontVariantNumeric: "tabular-nums" }}>
            <span>{lvl(r.price)}</span><span style={{ color: C.muted }}>{Math.round(r.share * 100)}% of off-exchange volume</span></div>)}
        </div>
      )}
      {top.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
            <thead><tr style={{ color: C.lbl, textAlign: "left" }}><th>Alert</th><th>Premium</th><th>Side</th><th>Rule</th></tr></thead>
            <tbody>{top.map((a, i) => (
              <tr key={i} style={{ borderTop: "1px solid " + C.bdr }}>
                <td style={{ color: a.type === "put" ? C.red : C.green, fontWeight: 700 }}>{a.type} {lvl(a.strike)} {a.expiry ? a.expiry.slice(5) : ""}</td>
                <td>{usd(a.premium).replace("+", "")}</td>
                <td>{a.side || "—"}</td>
                <td style={{ color: C.muted }}>{a.rule}{a.sweep ? " · sweep" : ""}{a.floor ? " · floor" : ""}{a.opening ? " · opening" : ""}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 0DTE FLOW CHART (10 Nov 2026) ─────────────────────────────────────────────
// Price with dvcap's levels, and beneath it the running options buying vs selling pressure (UW
// directional delta flow, all expiries and today's expiry). A view only: no signal, no alerts.
const delta = (v) => (v == null || !Number.isFinite(v) ? "—" : `${v < 0 ? "−" : "+"}${Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(1) + "M" : Math.round(Math.abs(v) / 1e3) + "k"}`);
const nyClock = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { wd: p.weekday, min: +p.hour * 60 + +p.minute };
};
const sessionLive = () => { const c = nyClock(); return !["Sat", "Sun"].includes(c.wd) && c.min >= 9 * 60 + 25 && c.min <= 16 * 60 + 20; };
const hhmmNy = (iso) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

function IntradayChart({ sym, board }) {
  const [snap, setSnap] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = () => fetch(`/api/flow?intraday=1&symbol=${sym}`, { credentials: "include" })
      .then(r => r.json()).then(j => { if (stop) return; if (j?.snap) { setSnap(j.snap); setErr(j.ok ? null : "no flow yet today"); } else setErr(j?.why || "no answer"); })
      .catch(e => !stop && setErr(String(e?.message || e)));
    load();
    // Once a minute, only while the US session is live and this tab is visible.
    const id = setInterval(() => { if (sessionLive() && document.visibilityState === "visible") load(); }, 60000);
    return () => { stop = true; clearInterval(id); };
  }, [sym]);
  const pts = (snap?.points || []).map(p => ({ ...p, hm: hhmmNy(p.t) }));
  const last = snap?.last;
  const lean = (v) => (v == null ? C.mid : v > 0 ? C.green : v < 0 ? C.purple : C.mid);
  const prices = pts.map(p => p.price).filter(v => v != null);
  const lvls = [board?.callWall, board?.putWall, board?.flip].filter(v => v != null && prices.length && v > Math.min(...prices) * 0.985 && v < Math.max(...prices) * 1.015);
  const lo = prices.length ? Math.min(...prices, ...lvls) : 0, hi = prices.length ? Math.max(...prices, ...lvls) : 1;
  return (
    <div style={{ border: "1px solid " + C.bdr, borderRadius: 10, padding: 12, display: "grid", gap: 8, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <b style={{ fontSize: 16 }}>{sym} · 0DTE flow</b>
        <span style={{ fontSize: 11.5, color: C.muted }}>{snap?.at ? `updated ${dubaiEtStamp(snap.at)}` : err ? "" : "loading…"}</span>
      </div>
      {err && !pts.length && <div style={{ fontSize: 12.5, color: C.amber }}>Flow not available: {err}</div>}
      {pts.length > 2 && (<>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 12.5, fontVariantNumeric: "tabular-nums" }}>
          <span style={{ color: C.lbl, fontWeight: 700 }}>Flow now</span>
          <span style={{ color: lean(last?.cum), fontWeight: 800 }}>{delta(last?.cum)} Δ · {last?.cum > 0 ? "options buyers in control" : last?.cum < 0 ? "options sellers in control" : "balanced"}</span>
          <span style={{ color: C.lbl, fontWeight: 700 }}>0DTE only</span>
          <span style={{ color: lean(last?.cum0), fontWeight: 800 }}>{delta(last?.cum0)} Δ · {last?.cum0 > 0 ? "today's expiry leaning up" : last?.cum0 < 0 ? "today's expiry leaning down" : "balanced"}</span>
        </div>
        <div style={{ height: 150 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={pts} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} syncId={`flow-${sym}`}>
              <CartesianGrid stroke={C.bdr} strokeDasharray="2 4" />
              <XAxis dataKey="hm" tick={{ fontSize: 10, fill: C.muted }} interval="preserveStartEnd" minTickGap={40} />
              <YAxis domain={[lo, hi]} tick={{ fontSize: 10, fill: C.muted }} width={48} tickFormatter={(v) => (+v).toFixed(0)} />
              <Tooltip formatter={(v, n) => [n === "price" ? (+v).toFixed(2) : v, n]} />
              {board?.flipLo != null && board?.flipHi != null && <ReferenceArea y1={board.flipLo} y2={board.flipHi} fill={C.amber} fillOpacity={0.12} />}
              {board?.callWall != null && <ReferenceLine y={board.callWall} stroke={C.green} strokeDasharray="4 3" label={{ value: `call wall ${board.callWall}`, fontSize: 10, fill: C.green, position: "insideTopRight" }} />}
              {board?.putWall != null && <ReferenceLine y={board.putWall} stroke={C.purple} strokeDasharray="4 3" label={{ value: `put support ${board.putWall}`, fontSize: 10, fill: C.purple, position: "insideBottomRight" }} />}
              <Line type="monotone" dataKey="price" stroke={C.text} dot={false} strokeWidth={1.8} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ height: 110 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={pts} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} syncId={`flow-${sym}`}>
              <CartesianGrid stroke={C.bdr} strokeDasharray="2 4" />
              <XAxis dataKey="hm" tick={{ fontSize: 10, fill: C.muted }} interval="preserveStartEnd" minTickGap={40} />
              <YAxis tick={{ fontSize: 10, fill: C.muted }} width={48} tickFormatter={(v) => delta(v)} />
              <Tooltip formatter={(v, n) => [delta(v), n === "cum" ? "all expiries" : "0DTE"]} />
              <ReferenceLine y={0} stroke={C.mid} />
              <Area type="monotone" dataKey="cum" stroke={lean(last?.cum)} fill={lean(last?.cum)} fillOpacity={0.18} strokeWidth={1.6} />
              <Line type="monotone" dataKey="cum0" stroke={C.amber} dot={false} strokeWidth={1.4} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </>)}
    </div>
  );
}

// ── VOLATILITY & EARNINGS (build step 9) ───────────────────────────────────────
const pct = (v, d = 0) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`);
const VERDICT_TONE = { Recommended: C.green, Consider: C.amber, Avoid: C.muted };
function VolBoard() {
  const [b, setB] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetch("/api/flow?vol=1", { credentials: "include" }).then(r => r.json())
      .then(j => (j?.board ? setB(j.board) : setErr(j?.why || "no answer"))).catch(e => setErr(String(e?.message || e)));
  }, []);
  if (!b && !err) return null;
  const th = { textAlign: "left", fontWeight: 700, color: C.lbl, padding: "4px 6px", whiteSpace: "nowrap" };
  const td = { padding: "4px 6px", borderTop: "1px solid " + C.bdr, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <b style={{ fontSize: 14 }}>Volatility &amp; earnings</b>
        <span style={{ fontSize: 11.5, color: C.muted }}>{b?.at ? `as of ${dubaiEtStamp(b.at)} · QQQ, SPY and your Desk names` : ""}</span>
      </div>
      {err && <div style={{ fontSize: 12.5, color: C.amber }}>Not available: {err}</div>}
      {b && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead><tr>{["Ticker", "Options vs moves", "IV30", "IV rank", "Next earnings", "Implied move", "Past moves (avg)", "UW calendar screen"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{b.rows.map(r => (
              <tr key={r.ticker}>
                <td style={{ ...td, fontWeight: 800 }}>{r.ticker}</td>
                <td style={{ ...td, color: r.rich === "rich" ? C.red : r.rich === "cheap" ? C.green : C.text, fontWeight: 700 }}>{r.rich ? `${r.rich} (${r.ivRv.toFixed(2)}×)` : "—"}</td>
                <td style={td}>{pct(r.iv30)}</td>
                <td style={td}>{r.ivRank != null ? Math.round(r.ivRank) : "—"}</td>
                <td style={td}>{r.earningsDate ? `${String(r.earningsDate).slice(5, 10)}${r.earningsTime ? ` ${r.earningsTime}` : ""}` : "—"}</td>
                <td style={td}>{r.impliedMovePct != null ? pct(r.impliedMovePct > 1.5 ? r.impliedMovePct / 100 : r.impliedMovePct, 1) : "—"}</td>
                <td style={td}>{r.pastN ? `${pct(r.pastMove, 1)} (${r.pastN})` : "—"}</td>
                <td style={{ ...td, color: VERDICT_TONE[r.uwVerdict] || C.muted, fontWeight: 700 }} title={r.slopeWhy || ""}>{r.uwVerdict || "—"}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 11.5, color: C.muted }}>
        <b>Options vs moves</b><span>30-day implied vol ÷ 30-day realised (Yang-Zhang): rich ≥ 1.25×, fair 0.9–1.25×, cheap &lt; 0.9×</span>
        <b>IV rank</b><span>where today&apos;s implied vol sits in its 1-year range (0–100)</span>
        <b>Past moves</b><span>average next-day move after the last earnings reports (count in brackets)</span>
        <b>UW calendar screen</b><span>Unusual Whales&apos; own screen for an earnings long-calendar spread (volume ≥ 1.5M, IV/RV ≥ 1.25, front IV above 45-day IV). UW&apos;s label, not a dvcap call or a recommendation</span>
      </div>
    </div>
  );
}

// ── UW GAMMA vs DVCAP (build step 11) ────────────────────────────────────────
// UW's open-interest book, read at each dvcap capture and scored on dvcap's definitions.
const STATE = { match: ["✓", C.green], near: ["≈", C.green], differ: ["✗", C.amber], context: ["·", C.muted], unknown: ["—", C.muted] };
const cell = (v) => (v == null ? "—" : typeof v === "number" ? lvl(v) : String(v));
function GammaScore() {
  const [g, setG] = useState(null);
  useEffect(() => {
    fetch("/api/flow?gamma=1", { credentials: "include" }).then(r => r.json()).then(j => (j?.ok ? setG(j) : null)).catch(() => {});
  }, []);
  const syms = Object.keys(g?.latest || {}).sort();
  if (!g) return null;
  const th = { textAlign: "left", fontWeight: 700, color: C.lbl, padding: "3px 6px", whiteSpace: "nowrap" };
  const td = { padding: "3px 6px", borderTop: "1px solid " + C.bdr, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
      <b style={{ fontSize: 14 }}>UW gamma vs dvcap&apos;s board</b>
      {!syms.length && <div style={{ fontSize: 12.5, color: C.muted }}>No sessions scored yet: the first runs with the next gamma snapshot (10:15 ET).</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12 }}>
        {syms.map(sym => {
          const r = g.latest[sym], sc = g.score?.[sym];
          return (
            <div key={sym} style={{ border: "1px solid " + C.bdr, borderRadius: 10, padding: 10, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <b>{sym}</b>
                <span style={{ fontSize: 11.5, color: C.muted }}>{r.session} · {dubaiEtStamp(r.at)}</span>
              </div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: r.agree === r.scored ? C.green : C.amber, margin: "4px 0" }}>
                {r.scored ? `Agree on ${r.agree} of ${r.scored}` : "Nothing scored"}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                  <thead><tr>{["Check", "dvcap", "UW", "", "Agree so far"].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
                  <tbody>{(r.checks || []).filter(c => c.score).map(c => {
                    const [mark, col] = STATE[c.state] || STATE.unknown;
                    const t = sc?.checks?.[c.name];
                    return (
                      <tr key={c.name} title={c.detail || ""}>
                        <td style={td}>{c.name}</td><td style={td}>{cell(c.ours)}</td><td style={td}>{cell(c.theirs)}</td>
                        <td style={{ ...td, color: col, fontWeight: 800 }}>{mark}</td>
                        <td style={td}>{t ? `${t.agree}/${t.of}` : "—"}</td>
                      </tr>);
                  })}</tbody>
                </table>
              </div>
              {r.uwLevels && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                UW&apos;s own levels (its definitions): call wall {lvl(r.uwLevels.callWall)} · put wall {lvl(r.uwLevels.putWall)} · flip {lvl(r.uwLevels.flip)}
              </div>}
              {sc && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 4 }}>
                {sc.sessions} reading{sc.sessions === 1 ? "" : "s"} since {sc.first}{sc.medianFlipGapPct != null ? ` · typical flip gap ${sc.medianFlipGapPct}% of spot` : ""}
              </div>}
            </div>);
        })}
      </div>
    </div>
  );
}

export function FlowPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [boards, setBoards] = useState({});
  const load = useCallback((fresh) => {
    fetch(`/api/flow${fresh ? "?fresh=1" : ""}`, { credentials: "include" })
      .then(r => { if (r.status === 401) { setHidden(true); return null; } return r.json(); })
      .then(j => { if (!j) return; if (j.ok && j.snap) { setD(j.snap); setErr(null); } else setErr(j.why || j.error || "no answer"); })
      .catch(e => setErr(String(e.message || e)));
  }, []);
  useEffect(() => { load(false); }, [load]);
  // dvcap's own board for the cross-check (the same stored board the Gamma panel above reads).
  useEffect(() => {
    ["QQQ", "SPY"].forEach(s => fetch(`/api/gex?symbol=${s}`, { credentials: "include" }).then(r => r.json())
      .then(j => { const l = j?.latest; if (l) setBoards(b => ({ ...b, [s]: { callWall: l.callWall ?? null, putWall: l.putWall ?? null, flip: l.flipLevel ?? null, flipLo: l.flipZoneLo ?? null, flipHi: l.flipZoneHi ?? null, spot: l.spot ?? null } })); })
      .catch(() => {}));
  }, []);
  if (hidden) return null;
  const tide = d?.tide;
  const series = (tide?.series || []).map(p => ({ t: String(p.t).slice(11, 16), calls: p.c / 1e6, puts: p.p / 1e6 }));
  return (
    <Card style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <SLabel>🐋 Options flow · Unusual Whales</SLabel>
        <span style={{ fontSize: 11.5, color: C.muted }}>
          {d?.at ? `as of ${dubaiEtStamp(d.at)} · ${d.ok}/${d.of} sources` : err ? "" : "loading…"}
          {" "}<button type="button" onClick={() => load(true)} style={{ font: "inherit", fontSize: 11.5, border: "1px solid " + C.bdr, background: "transparent", color: C.text, borderRadius: 999, padding: "1px 10px", cursor: "pointer" }}>↻</button>
        </span>
      </div>
      {err && <div style={{ fontSize: 12.5, color: C.amber, marginTop: 6 }}>Flow not available: {err}</div>}
      {tide && (
        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 18 }}>
            <Stat label="Market Tide" value={tide.lean === "calls" ? "Calls lead" : tide.lean === "puts" ? "Puts lead" : "Flat"} color={tone(tide.net)} sub={`net ${usd(tide.net)} · ${tide.date}`} />
            <Stat label="Net call premium" value={usd(tide.netCall)} color={tone(tide.netCall)} />
            <Stat label="Net put premium" value={usd(tide.netPut)} color={tone(-tide.netPut)} />
          </div>
          {series.length > 2 && (
            <div style={{ height: 150 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={C.bdr} strokeDasharray="2 4" />
                  <XAxis dataKey="t" tick={{ fontSize: 10, fill: C.muted }} interval="preserveStartEnd" minTickGap={40} />
                  <YAxis tick={{ fontSize: 10, fill: C.muted }} width={44} tickFormatter={(v) => `${Math.round(v)}M`} />
                  <Tooltip formatter={(v, n) => [`$${(+v).toFixed(1)}M`, n]} />
                  <ReferenceLine y={0} stroke={C.mid} />
                  <Line type="monotone" dataKey="calls" stroke={C.green} dot={false} strokeWidth={2} />
                  <Line type="monotone" dataKey="puts" stroke={C.red} dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", gap: 12, marginTop: 12 }}>
        {["QQQ", "SPY"].map(s => <IntradayChart key={s} sym={s} board={boards[s]} />)}
      </div>
      {d?.tickers && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12, marginTop: 12 }}>
          {Object.entries(d.tickers).map(([s, t]) => <Ticker key={s} sym={s} t={t} board={boards[s]} />)}
        </div>
      )}
      <GammaScore />
      <VolBoard />
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 11.5, color: C.muted, marginTop: 12 }}>
        <b>0DTE flow</b><span>running total of options delta bought minus sold since the open (green = buyers, purple = sellers); amber line = today&apos;s expiry only. A view, not a signal</span>
        <b>Levels</b><span>dvcap&apos;s call wall, put support and flip zone (shaded) on the price chart</span>
        <b>Tide</b><span>net premium at the ask minus at the bid, market-wide, cumulative</span>
        <b>Net premium</b><span>the same, for one ticker</span>
        <b>UW GEX</b><span>built from the day&apos;s directional volume; dvcap&apos;s board from open interest</span>
        <b>UW gamma check</b><span>UW&apos;s open-interest book, read at each dvcap gamma snapshot (10:15 and 17:00 ET) and scored on dvcap&apos;s definitions</span>
        <b>✓ / ≈ / ✗</b><span>same strike / within 0.5% of spot / further apart. Both books shown; neither overrides</span>
        <b>Alerts</b><span>UW&apos;s unusual-activity rules; side = where ≥60% of premium traded</span>
        <b>Source</b><span>Unusual Whales API · personal use · snapshots 09:50, 12:30, 15:30 ET and the close; 0DTE chart every minute while open in the session</span>
      </div>
    </Card>
  );
}
