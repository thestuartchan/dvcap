// src/TickerPanel.jsx — Tickers › Ticker page: one name on one screen, the terminal's DES.
//
// What each card reads, and from where:
//   price and the year's chart     /api/prices and /api/atr?history=1 (Yahoo, as everywhere else)
//   fundamentals and filings       /api/atr?des=SYM — SEC EDGAR, the company's own XBRL (lib/secDes.js)
//   gamma                          /api/gex?symbol=SYM — the stored board, where one is kept
//   next earnings                  the calendar rows the app already loads (passed in)
//   market context                 the Ratios cards and the breadth ladder (lib/tickerPage.js)
//   suppliers and customers        data/supplychain.json, bundled: each company's own annual report
//                                  on EDGAR, read by scripts/supplychain-build.mjs (SupplyChainCard)
//   your line                      the Console's rows, already in this logged-in browser (passed in).
//                                  It is read here and shown here; it is never sent anywhere.
// A card with nothing to show says why rather than going blank. Under the name, one line says what
// each part of the dashboard does with this symbol (lib/coverage.js), so a blank card is expected.
import { useEffect, useMemo, useState } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { SupplyChainCard } from "./SupplyChainCard.jsx";
import { dubaiEt, dubaiEtStamp, zonedInstant } from "../lib/timeFmt.js";
import { linesFor, ratioContext, nextEarnings, chartOf, money, cleanSymbol, TICKER_RE } from "../lib/tickerPage.js";
import { eventsBetween } from "../lib/calendar.js";
import { coverageFor, priceSymbol, kindOf, GAMMA_STORED } from "../lib/coverage.js";

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const pctTxt = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`);
const pctCol = (v) => (v == null || v === 0 ? C.muted : v > 0 ? C.green : C.red);
const shortDate = (iso) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" }) : "—");
const qLabel = (end) => (end ? new Date(`${end}T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }) : "");

// One fetch per symbol per source. The answer is kept with the symbol it was for, so a slow reply
// for the previous name can never paint over the current one, and "loading" is simply "the answer
// on hand is for some other symbol".
function useFor(sym, url) {
  const [got, setGot] = useState(null);
  useEffect(() => {
    if (!sym || !url) return undefined;
    let cancel = false;
    fetch(url).then(r => r.json().catch(() => null).then(j => ({ ok: r.ok, status: r.status, j })))
      .then(x => { if (!cancel) setGot({ sym, ...x }); })
      .catch(e => { if (!cancel) setGot({ sym, ok: false, error: String(e?.message || e) }); });
    return () => { cancel = true; };
  }, [sym, url]);
  return got?.sym === sym ? got : null;
}

// One line under the name: what each part of the dashboard does with this symbol. Green: covered.
// Blue: an open source that answers if it has the symbol. Grey: not covered, with the reason on hover.
const COV_TONE = { yes: () => [C.green, C.gBg], try: () => [C.blue, C.blBg], no: () => [C.lbl, C.bg] };
function CoverageLine({ rows }) {
  if (!rows?.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }} aria-label="What the dashboard covers for this symbol">
      {rows.map(r => {
        const [col, bg] = (COV_TONE[r.status] || COV_TONE.no)();
        return <span key={r.id} title={r.why} style={{ fontSize: 10.5, fontWeight: 700, color: col, background: bg, border: "1px solid " + C.bdr, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
          {r.status === "yes" ? "✓" : r.status === "try" ? "?" : "–"} {r.label}
        </span>;
      })}
      <span style={{ fontSize: 10.5, color: C.lbl, alignSelf: "center" }}>✓ covered · ? if the source has it · – not covered (hover for why) · type COV for the full list</span>
    </div>
  );
}

const Why = ({ children }) => <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{children}</div>;
const Row = ({ k, v, sub, col }) => (
  <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", padding: "4px 0", borderBottom: "1px solid " + C.bdr }}>
    <span style={{ minWidth: 110, fontSize: 12, fontWeight: 700, color: C.mid }}>{k}</span>
    <span style={{ fontSize: 14, fontWeight: 800, color: col || C.text, fontFamily: MONO }}>{v}</span>
    {sub && <span style={{ fontSize: 11, color: C.muted }}>{sub}</span>}
  </div>
);

export function TickerPanel({ symbol, onSymbol, consoleRows = null, calendarExtra = [], onOpenGamma = null, onOpenConsole = null }) {
  const sym = cleanSymbol(symbol);
  const [typed, setTyped] = useState(sym);
  // Read once per mount (the page remounts per symbol): today, and the end of the earnings window.
  const [[today, until]] = useState(() => { const n = Date.now(); return [new Date(n).toISOString().slice(0, 10), new Date(n + 200 * 86400000).toISOString().slice(0, 10)]; });

  // The price feed's spelling (BRK.B → BRK-B, SPX → ^GSPC); SEC and the page keep what was typed.
  const ps = priceSymbol(sym);
  const kind = kindOf(sym);
  const cov = useMemo(() => coverageFor(sym), [sym]);
  const why = (id) => cov.find(r => r.id === id)?.why || null;
  // SEC is asked only about what could be a US company; the stored gamma board only where one is kept.
  const secAsk = kind === "us" || kind === "class";
  const gexAsk = GAMMA_STORED.includes(sym);
  const quote = useFor(sym, `/api/prices?tickers=${encodeURIComponent(ps)}`);
  const hist = useFor(sym, `/api/atr?history=1&range=1y&tickers=${encodeURIComponent(ps)}`);
  const des = useFor(sym, secAsk ? `/api/atr?des=${encodeURIComponent(sym)}` : null);
  const gex = useFor(sym, gexAsk ? `/api/gex?symbol=${encodeURIComponent(sym)}` : null);

  const q = quote?.j?.[ps] || null;
  const closes = hist?.j?.symbols?.[ps]?.closes || null;
  const chart = useMemo(() => chartOf(closes || [], { w: 340, h: 120 }), [closes]);
  const d = des?.j || null;
  const lines = useMemo(() => linesFor(consoleRows || [], sym), [consoleRows, sym]);
  const ctx = useMemo(() => ratioContext(sym), [sym]);
  // Which companies on the supply-chain map the Console holds open: worked out here, in this
  // browser, from the rows the Console already loaded. Only the map's tint reads it.
  const held = useMemo(() => (consoleRows ? { has: (t) => linesFor(consoleRows, t).some(l => l.status === "open") } : null), [consoleRows]);
  const events = useMemo(() => [...eventsBetween(today, until), ...(calendarExtra || [])], [calendarExtra, today, until]);
  const earn = useMemo(() => nextEarnings(events, sym, { name: d?.name || null, today }), [events, sym, d?.name, today]);
  const g = gex?.j?.available ? gex.j.latest : null;

  const go = () => { const s = cleanSymbol(typed); if (s && TICKER_RE.test(s)) onSymbol?.(s); };

  // Fundamentals table: one column per quarter the revenue line carries, the other lines looked up
  // by period end so a missing figure shows as a gap in its own column rather than shifting left.
  const f = d?.fundamentals || null;
  const cols = (f?.flow?.revenue?.quarters?.length ? f.flow.revenue.quarters : f?.flow?.netIncome?.quarters || []).slice(-6).map(x => x.end);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── THE NAME ── */}
      <Card>
        <form onSubmit={(e) => { e.preventDefault(); go(); }} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} aria-label="Ticker" placeholder="NVDA"
            autoCapitalize="characters" autoComplete="off" spellCheck={false}
            style={{ width: 120, padding: "7px 10px", fontSize: 16, fontWeight: 800, fontFamily: MONO, border: "1.5px solid " + C.bdr, borderRadius: 8, background: C.bg, color: C.text }} />
          <button type="submit" style={{ padding: "7px 14px", fontSize: 13, fontWeight: 800, borderRadius: 8, border: "1.5px solid " + C.blue, background: C.blBg, color: C.blue, cursor: "pointer" }}>Open</button>
          <span style={{ fontSize: 11, color: C.muted }}>or type <b style={{ fontFamily: MONO }}>{sym || "NVDA"} DES</b> in the Go bar</span>
        </form>
        <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 24, fontWeight: 900, color: C.text, fontFamily: MONO }}>{sym}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: C.mid }}>{d?.name || hist?.j?.symbols?.[ps]?.name || ""}</span>
          {d?.sic && <span style={{ fontSize: 11, color: C.muted }}>{d.sic}</span>}
          {ps !== sym && <span style={{ fontSize: 11, color: C.muted }}>priced as <b style={{ fontFamily: MONO }}>{ps}</b></span>}
        </div>
        <CoverageLine rows={cov} />
        {q?.price != null ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginTop: 4 }}>
            <span style={{ fontSize: 22, fontWeight: 900, fontFamily: MONO, color: C.text }}>{q.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: pctCol(q.changePercent) }}>{pctTxt(q.changePercent)}</span>
            <span style={{ fontSize: 11, color: C.muted }}>{q.currency || ""} · last trade {q.ts ? dubaiEtStamp(new Date(q.ts * 1000)) : "—"}</span>
          </div>
        ) : <Why>{quote ? "No quote for this symbol from the price feed." : "Loading the quote…"}</Why>}
      </Card>

      {/* ── THE YEAR ── */}
      <Card>
        <SLabel>Price · one year, daily closes</SLabel>
        {chart ? (
          <>
            <svg viewBox={`0 0 ${chart.w} ${chart.h}`} width="100%" height="120" preserveAspectRatio="none" role="img" aria-label={`${sym} daily closes, one year`} style={{ display: "block", marginTop: 6 }}>
              <path d={chart.d} fill="none" stroke={C.blue} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
            </svg>
            <div style={{ display: "flex", gap: "4px 14px", flexWrap: "wrap", fontSize: 12, marginTop: 6 }}>
              <span>1d <b style={{ color: pctCol(chart.ch1d) }}>{pctTxt(chart.ch1d)}</b></span>
              <span>1m <b style={{ color: pctCol(chart.ch1m) }}>{pctTxt(chart.ch1m)}</b></span>
              <span>1y <b style={{ color: pctCol(chart.ch1y) }}>{pctTxt(chart.ch1y)}</b></span>
              <span style={{ color: C.muted }}>high {chart.hi.toFixed(2)} ({shortDate(chart.hiDate)}) · low {chart.lo.toFixed(2)} ({shortDate(chart.loDate)})</span>
            </div>
            <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 4 }}>Settled closes only, last {shortDate(chart.lastDate)} · Yahoo daily history</div>
          </>
        ) : <Why>{hist ? `No daily history for ${ps} (${hist?.j?.symbols?.[ps]?.status || "feed unavailable"}).` : "Loading the year's closes…"}</Why>}
      </Card>

      {/* ── YOUR LINE ── read in this browser from what the Console already loaded; never sent. */}
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <SLabel>Your line</SLabel>
          {onOpenConsole && <button onClick={onOpenConsole} style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Open the Console →</button>}
        </div>
        {consoleRows == null ? <Why>The Console's rows haven't loaded in this browser, so there is nothing to compare.</Why>
          : lines.length === 0 ? <Why>Nothing open or on watch in the Console for {sym}.</Why>
          : lines.map((l, i) => (
            <div key={l.id ?? i} style={{ padding: "6px 0", borderBottom: "1px solid " + C.bdr, fontSize: 13 }}>
              <b style={{ textTransform: "uppercase", fontSize: 10.5, letterSpacing: 0.4, color: l.status === "open" ? C.green : C.amber, marginRight: 6 }}>{l.status}</b>
              <span style={{ fontFamily: MONO, fontWeight: 700 }}>{l.symbol}</span>
              {l.side && <span style={{ color: C.muted }}> · {l.side}</span>}
              {l.legs > 1 && <span style={{ color: C.muted }}> · {l.legs} legs</span>}
              {l.thesis && <div style={{ fontSize: 11.5, color: C.mid, marginTop: 2, overflowWrap: "anywhere" }}>{String(l.thesis).slice(0, 160)}</div>}
            </div>
          ))}
      </Card>

      {/* ── NEXT EARNINGS ── */}
      <Card>
        <SLabel>Next earnings</SLabel>
        {earn ? (
          <Row k={shortDate(earn.date)} v={earn.time && earn.tz ? (() => { const at = zonedInstant(earn.date, earn.time, earn.tz); return at ? dubaiEt(at, { refDate: earn.date }) : earn.time; })() : "time not given"}
            sub={`${earn.title}${earn.estimated ? " · est., not yet confirmed" : ""} · ${earn.source}`} />
        ) : <Why>No earnings date for {sym} on the calendar in the next six months{cov.find(r => r.id === "earnings")?.status === "no" ? ` — ${why("earnings")}` : ""}.</Why>}
      </Card>

      {/* ── FUNDAMENTALS ── SEC EDGAR, the company's own XBRL. */}
      <Card>
        <SLabel>Fundamentals · from the filings</SLabel>
        {!secAsk ? <Why>Not read for {sym}: {why("sec")}.</Why>
          : !des ? <Why>Reading SEC EDGAR…</Why>
          : !d?.ok ? <Why>{d?.why || des?.error || "SEC EDGAR did not answer."}</Why>
          : !f?.gaap ? <Why>{d.fundamentalsWhy || (f?.ifrs ? `${d.name} reports in IFRS (a foreign filer); this page reads US-GAAP figures only. Its filings are listed below.` : "No US-GAAP XBRL figures in this company's filings.")}</Why>
          : (
            <>
              <div style={{ overflowX: "auto", marginTop: 6 }}>
                <table style={{ borderCollapse: "collapse", fontSize: 12, fontFamily: MONO, minWidth: "100%" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "4px 6px", color: C.muted, fontWeight: 700 }}></th>
                      {cols.map(c => <th key={c} style={{ textAlign: "right", padding: "4px 6px", color: C.muted, fontWeight: 700, whiteSpace: "nowrap" }}>{qLabel(c)}</th>)}
                      <th style={{ textAlign: "right", padding: "4px 6px", color: C.mid, fontWeight: 800 }}>TTM</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(f.flow).map(([k, line]) => (
                      <tr key={k} style={{ borderTop: "1px solid " + C.bdr }}>
                        <td style={{ padding: "4px 6px", fontFamily: "inherit", color: C.mid, fontWeight: 700, whiteSpace: "nowrap" }}>{line.label}</td>
                        {cols.map(c => {
                          const x = line.quarters.find(r => r.end === c);
                          return <td key={c} title={x ? `${x.form || "?"} · period ${x.start || "?"} → ${x.end} · filed ${x.filed || "?"}${x.derived ? ` · derived: ${x.derived}` : ""}` : "not filed for this quarter"}
                            style={{ textAlign: "right", padding: "4px 6px", whiteSpace: "nowrap", color: x ? C.text : C.lbl }}>{x ? `${money(x.val, { perShare: k === "eps" })}${x.derived ? "*" : ""}` : "—"}</td>;
                        })}
                        <td style={{ textAlign: "right", padding: "4px 6px", fontWeight: 800, whiteSpace: "nowrap" }} title={line.ttm ? `${line.ttm.from} → ${line.ttm.to}` : "fewer than four consecutive quarters"}>{line.ttm ? money(line.ttm.val, { perShare: k === "eps" }) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ marginTop: 8 }}>
                {Object.entries(f.instant).map(([k, x]) => <Row key={k} k={x.label} v={money(x.val)} sub={x.end ? `${x.form || ""} · as of ${shortDate(x.end)}` : "not in the filings"} />)}
                <Row k="Shares out" v={f.shares?.val != null ? `${(f.shares.val / 1e6).toLocaleString("en-US", { maximumFractionDigits: 1 })}M` : "—"} sub={f.shares ? `${f.shares.form || ""} cover page · ${shortDate(f.shares.end)}` : "not on the cover page"} />
              </div>
              <div style={{ fontSize: 10.5, color: C.lbl, marginTop: 6, lineHeight: 1.5 }}>
                Quarterly figures as filed, the latest filing of each period. * a fourth quarter derived as the year less the three quarters filed in it (10-K files the year only); EPS is never derived that way. Hover a figure for its form, period and filing date. {d.source} · {d.cache === "live" ? "read" : "kept"} {dubaiEtStamp(d.at)}.
              </div>
            </>
          )}
      </Card>

      {/* ── FILINGS ── */}
      <Card>
        <SLabel>Recent filings · SEC EDGAR</SLabel>
        {!secAsk ? <Why>Not read for {sym}: {why("sec")}.</Why>
          : !des ? <Why>Reading SEC EDGAR…</Why>
          : !d?.ok ? <Why>{d?.why || "No filing index."}</Why>
          : !d.filings?.length ? <Why>{d.filingsWhy || "No 10-K, 10-Q or 8-K on file."}</Why>
          : d.filings.map((x, i) => (
            <a key={i} href={x.url} target="_blank" rel="noreferrer" style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "5px 0", borderBottom: "1px solid " + C.bdr, textDecoration: "none", color: C.text, fontSize: 12.5 }}>
              <b style={{ minWidth: 48, fontFamily: MONO, color: C.blue }}>{x.form}</b>
              <span style={{ minWidth: 70, color: C.mid }}>{shortDate(x.filed)}</span>
              <span style={{ color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{x.period && x.form !== "8-K" ? `period ${shortDate(x.period)}` : x.items ? `items ${x.items}` : x.desc || ""}</span>
            </a>
          ))}
      </Card>

      {/* ── GAMMA ── */}
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <SLabel>Gamma</SLabel>
          {onOpenGamma && <button onClick={() => onOpenGamma(sym)} style={{ marginLeft: "auto", background: "none", border: "none", padding: 0, color: C.blue, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>Open {sym} on Gamma →</button>}
        </div>
        {g ? (
          <>
            <Row k="Spot" v={g.spot?.toFixed?.(2) ?? "—"} sub={g.asOf ? `board ${dubaiEtStamp(g.asOf)}` : g.date} />
            <Row k="Flip" v={g.flipLevel != null ? Number(g.flipLevel).toFixed(2) : "—"} sub={g.flipZoneLo != null && g.flipZoneHi != null ? `zone ${Number(g.flipZoneLo).toFixed(0)}–${Number(g.flipZoneHi).toFixed(0)}` : null} />
            <Row k="Call wall" v={g.callWall ?? "—"} />
            <Row k="Put wall" v={g.putWall ?? "—"} />
            {g.gexUsd != null && <Row k="Net gamma" v={money(g.gexUsd)} sub="per 1% move" col={g.gexUsd >= 0 ? C.green : C.red} />}
          </>
        ) : <Why>{gexAsk ? (gex ? `No stored board for ${sym} came back.` : "Reading the stored board…")
          : `No stored board for ${sym}: boards are kept for ${GAMMA_STORED.join(" and ")} only. Here, ${why("gamma")}.`}</Why>}
      </Card>

      {/* ── WHERE IT SITS IN THE MARKET READ ── */}
      <Card>
        <SLabel>Market context</SLabel>
        {!ctx.cards.length && !ctx.ladder && !ctx.concentration ? <Why>{sym} isn't a leg of any Ratios card or the breadth ladder.</Why> : (
          <>
            {ctx.cards.map(c => <Row key={c.id} k={`Ratios #${c.n}`} v={c.formula} sub={`${c.title} · ${sym} is the ${c.side}`} />)}
            {ctx.ladder && <Row k="Breadth ladder" v={`rung ${ctx.ladder.rung} of ${ctx.ladder.of}`} sub={ctx.ladder.order.join(" → ")} />}
            {ctx.concentration && <Row k="Concentration" v="SMH ÷ SOXX" sub="the chip-concentration tell on State" />}
          </>
        )}
      </Card>

      {/* ── SUPPLY CHAIN ── who it buys from and sells to, each link quoted from a filing. */}
      <Card>
        <SupplyChainCard symbol={sym} held={held} />
      </Card>
    </div>
  );
}
