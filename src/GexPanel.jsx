// src/GexPanel.jsx — gamma exposure. Its own tab, its own data, nothing in App.jsx.
//
// TWO CHARTS, AND THE SECOND IS THE POINT. The by-strike profile is what every GEX screenshot on
// the internet shows and it is available anywhere. The time series is not: open interest cannot be
// re-fetched, so a history of flip levels and net gamma only exists if something captured it daily.
// That is the whole reason this module stores anything at all, and it is why the series chart is
// given equal weight rather than tucked underneath.
import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ReferenceArea, ResponsiveContainer, Cell,
} from "recharts";
import { C, Card, SLabel, Btn } from "./ui.jsx";

const fmtUsd = (v) => {
  if (v == null || !Number.isFinite(+v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
  return `${s}$${a.toFixed(0)}`;
};
const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? "—" : (+v).toFixed(d);

// How old the capture is, in calendar days. The snapshot runs pre-open on weekdays, so anything
// past three days means a run was missed and the numbers below describe a book that has moved.
function staleness(dateStr) {
  if (!dateStr) return { days: null, stale: true, note: "no capture on record" };
  const d = Date.parse(`${dateStr}T00:00:00Z`);
  if (!Number.isFinite(d)) return { days: null, stale: true, note: "unreadable capture date" };
  const days = Math.floor((Date.now() - d) / 86400000);
  return { days, stale: days > 3, note: days === 0 ? "captured today" : `captured ${days}d ago` };
}

function Stat({ label, value, sub, color }) {
  return (
    <div style={{ flex: "1 1 130px", minWidth: 120 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 800, color: color || C.text, marginTop: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 1, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  );
}

export function GexPanel() {
  const [symbol, setSymbol] = useState("QQQ");
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null);
    fetch(`/api/gex?symbol=${encodeURIComponent(symbol)}`, { credentials: "include" })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => { if (!cancelled) setData(j); })
      .catch(e => { if (!cancelled) setErr(String(e.message || e)); });
    return () => { cancelled = true; };
  }, [symbol]);

  const latest = data?.latest || null;
  const fresh = staleness(latest?.date);

  const strikeRows = useMemo(() => (data?.byStrike || []).map(r => ({
    strike: r.strike, net: r.netGexUsd, call: r.callGexUsd, put: r.putGexUsd == null ? null : -r.putGexUsd,
  })), [data]);

  const seriesRows = useMemo(() => (data?.series || []).map(r => ({
    date: r.date, gex: r.gexUsd, flip: r.flipLevel, spot: r.spot,
    callWall: r.callWall, putWall: r.putWall,
  })), [data]);

  const header = (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
      <SLabel>🌀 Gamma exposure</SLabel>
      <div style={{ display: "flex", gap: 5 }}>
        {(data?.symbols || ["QQQ", "SPY"]).map(s => (
          <button key={s} onClick={() => setSymbol(s)}
            style={{ cursor: "pointer", fontSize: 12, fontWeight: 800, padding: "3px 10px", borderRadius: 7,
                     border: "1.5px solid " + (s === symbol ? C.blue : C.bdr),
                     background: s === symbol ? C.blBg : C.surf, color: s === symbol ? C.blue : C.mid }}>{s}</button>
        ))}
      </div>
      {latest && (
        <span style={{ fontSize: 11.5, fontWeight: 700, color: fresh.stale ? C.amber : C.muted }}>
          {fresh.stale ? "⚠ " : ""}{fresh.note}
        </span>
      )}
    </div>
  );

  if (err) return <Card>{header}<div style={{ fontSize: 12.5, color: C.red, marginTop: 8 }}>Could not load: {err}</div></Card>;
  if (!data) return <Card>{header}<div style={{ fontSize: 12.5, color: C.muted, marginTop: 8 }}>Loading…</div></Card>;
  if (!data.available) {
    return (
      <Card>{header}
        <div style={{ fontSize: 12.5, color: C.mid, marginTop: 8, lineHeight: 1.6 }}>
          Nothing captured yet. The snapshot runs pre-open each weekday and writes one row per symbol;
          the by-strike chart appears after the first run and the time series becomes meaningful after
          a few. <b>Open interest cannot be back-filled</b> — Yahoo and OCC serve today only — so the
          history starts from the first successful capture and no earlier.
        </div>
      </Card>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        {header}
        <div style={{ marginTop: 10, display: "flex", gap: 20, flexWrap: "wrap" }}>
          <Stat label="Spot" value={fmtNum(latest.spot)} sub={latest.date} />
          <Stat label="Net GEX" value={fmtUsd(latest.gexUsd)} sub="per 1% move"
            color={latest.gexUsd == null ? C.muted : latest.gexUsd >= 0 ? C.green : C.red} />
          <Stat label="Flip" value={fmtNum(latest.flipLevel)}
            color={latest.flipFragile ? C.amber : C.text}
            sub={latest.flipLevel == null ? latest.flipReason
              : latest.spot ? `${latest.flipLevel > latest.spot ? "+" : ""}${fmtNum(latest.flipLevel - latest.spot)} from spot` : null} />
          <Stat label="Call wall" value={fmtNum(latest.callWall)} color={C.green}
            sub={latest.callWall && latest.spot ? `${fmtNum(((latest.callWall / latest.spot) - 1) * 100, 1)}%` : null} />
          <Stat label="Put wall" value={fmtNum(latest.putWall)} color={C.red}
            sub={latest.putWall && latest.spot ? `${fmtNum(((latest.putWall / latest.spot) - 1) * 100, 1)}%` : null} />
          <Stat label="OI-wtd IV" value={latest.oiWeightedIv == null ? "—" : `${fmtNum(latest.oiWeightedIv * 100, 1)}%`}
            sub={`${(latest.callOi ?? 0).toLocaleString()}c / ${(latest.putOi ?? 0).toLocaleString()}p`} />
        </div>

        {/* THE ASSUMPTION, STATED. The flip is where call gamma balances put gamma, so reweighting
            the dealer put assumption moves it by construction — measured at 3–5% of spot on every
            book shape tried. Presenting a single number as a line would be the actual error. */}
        {latest.flipNote && (
          <div style={{ marginTop: 9, padding: "7px 10px", borderRadius: 7, fontSize: 11.5, lineHeight: 1.5,
                        background: latest.flipFragile ? C.aBg : C.surf,
                        border: "1px solid " + (latest.flipFragile ? C.aBdr : C.bdr),
                        color: latest.flipFragile ? C.amber : C.mid }}>
            {latest.flipFragile ? "⚠ " : ""}{latest.flipNote}
          </div>
        )}
        <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 7, lineHeight: 1.5 }}>
          Both dealer sign conventions are stored. They are exact reflections of one another, so they
          agree on the flip by construction and only the SIGN of net GEX differs — the level and the
          walls are the actionable outputs, and absolute GEX is not comparable across sources.
          {latest.rateSource ? ` Risk-free rate ${(latest.rate * 100).toFixed(2)}% (${latest.rateSource}).` : " No risk-free rate on this row."}
          {latest.partial ? " ⚠ Some expiries failed to fetch — this row is partial." : ""}
        </div>
      </Card>

      {/* 1 — net gamma by strike */}
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
          <SLabel>Net gamma by strike</SLabel>
          <span style={{ fontSize: 11.5, color: C.muted }}>dollars per 1% move · {latest.date}</span>
        </div>
        {!strikeRows.length ? (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>No raw chain stored for this date — it prunes after 30 days.</div>
        ) : (
          <div style={{ height: Math.max(260, strikeRows.length * 15), marginTop: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={strikeRows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="2 3" stroke={C.bdr} />
                <XAxis type="number" tick={{ fontSize: 10, fill: C.lbl }} tickFormatter={fmtUsd} />
                <YAxis type="category" dataKey="strike" tick={{ fontSize: 9.5, fill: C.lbl }} width={46} reversed />
                <Tooltip formatter={(v) => fmtUsd(v)} labelFormatter={(l) => `Strike ${l}`}
                  contentStyle={{ fontSize: 11.5, borderRadius: 8, border: "1px solid " + C.bdr }} />
                {/* The flip drawn as a BAND, not a line — its width is the measured sensitivity to
                    the dealer put assumption. A line would claim precision the data cannot carry. */}
                {latest.flipZoneLo != null && latest.flipZoneHi != null && (
                  <ReferenceArea y1={latest.flipZoneLo} y2={latest.flipZoneHi} fill={C.amber} fillOpacity={0.12} />
                )}
                {latest.flipLevel != null && <ReferenceLine y={latest.flipLevel} stroke={C.amber} strokeDasharray="4 3"
                  label={{ value: `flip ${fmtNum(latest.flipLevel)}`, fontSize: 10, fill: C.amber, position: "insideTopRight" }} />}
                {latest.spot != null && <ReferenceLine y={latest.spot} stroke={C.blue} strokeWidth={1.5}
                  label={{ value: `spot ${fmtNum(latest.spot)}`, fontSize: 10, fill: C.blue, position: "insideBottomRight" }} />}
                <Bar dataKey="net" name="Net GEX" isAnimationActive={false}>
                  {strikeRows.map((r, i) => <Cell key={i} fill={(r.net ?? 0) >= 0 ? C.green : C.red} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {/* 2 — the history, which is the reason any of this is stored */}
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
          <SLabel>Net GEX and flip over time</SLabel>
          <span style={{ fontSize: 11.5, color: C.muted }}>{data.days} capture{data.days === 1 ? "" : "s"}</span>
        </div>
        {data.days < 2 ? (
          <div style={{ fontSize: 12, color: C.mid, marginTop: 8, lineHeight: 1.55 }}>
            One capture so far. A single point is not a series — this chart fills in as the daily
            snapshot runs, and it cannot be back-filled, because open interest is not served
            historically by any free source.
          </div>
        ) : (
          <div style={{ height: 280, marginTop: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={seriesRows} margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
                <CartesianGrid strokeDasharray="2 3" stroke={C.bdr} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: C.lbl }} />
                <YAxis yAxisId="l" tick={{ fontSize: 10, fill: C.lbl }} tickFormatter={fmtUsd} />
                <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: C.lbl }} domain={["auto", "auto"]} />
                <Tooltip contentStyle={{ fontSize: 11.5, borderRadius: 8, border: "1px solid " + C.bdr }}
                  formatter={(v, n) => n === "Net GEX" ? fmtUsd(v) : fmtNum(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine yAxisId="l" y={0} stroke={C.bdrMd} />
                <Line yAxisId="l" type="monotone" dataKey="gex" name="Net GEX" stroke={C.blue} dot={false} strokeWidth={2} isAnimationActive={false} />
                <Line yAxisId="r" type="monotone" dataKey="flip" name="Flip" stroke={C.amber} dot={false} strokeWidth={1.6} isAnimationActive={false} />
                <Line yAxisId="r" type="monotone" dataKey="spot" name="Spot" stroke={C.muted} dot={false} strokeWidth={1.2} strokeDasharray="3 3" isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 7, lineHeight: 1.5 }}>
          <b>Before trusting any of this,</b> run it a week and compare the flip and the walls against a
          public source. A systematic offset is almost certainly the sign convention or the rate input,
          not the arithmetic. The flip and the walls are the actionable outputs; absolute GEX is
          convention-dependent and should not be compared across providers.
        </div>
      </Card>
    </div>
  );
}
