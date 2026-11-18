// src/LevelTape.jsx — the level tape and the watch list (lib/levelTape.js, /api/gex?tape=…).
//
// Three gamma books side by side for the name in view — dvcap's settled OI, UW's flow levels and
// UW's OI levels — captured every 15 minutes in the session; the running scorecard of how price
// treated each book's levels; and up to three watch names (an earnings name for today and the next
// session) that ride the same tape. Signed-in only: the answers carry UW numbers (personal-use) and
// the watch list is the book's plan.
import { Fragment, useCallback, useEffect, useState } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { dubaiEt } from "../lib/timeFmt.js";
import { SOURCES, SOURCE_LABEL, KINDS, KIND_LABEL, BOOK_SYMBOLS, WATCH_MAX } from "../lib/levelTape.js";

const fmtLv = (v) => (v == null || !Number.isFinite(+v) ? "—" : Number.isInteger(+v) ? String(+v) : (+v).toFixed(2));
const fmtUsd = (v) => {
  if (v == null || !Number.isFinite(+v)) return "—";
  const a = Math.abs(v), s = v < 0 ? "−" : "+";
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : `${s}$${Math.round(a / 1e3)}K`;
};
const dayShort = (iso) => {
  if (!iso) return "";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
};
const OUT_TONE = { held: "green", broke: "red", stalled: "amber", untested: "muted" };

function Chip({ on, onClick, children, title }) {
  return (
    <button onClick={onClick} title={title}
      style={{ cursor: "pointer", fontSize: 12, fontWeight: 800, padding: "3px 10px", borderRadius: 7, whiteSpace: "nowrap",
               border: "1.5px solid " + (on ? C.blue : C.bdr), background: on ? C.blBg : C.surf, color: on ? C.blue : C.mid }}>
      {children}
    </button>
  );
}

// One label → value row of the explainer grid.
const Row = ({ k, v }) => (<><span style={{ color: C.lbl, fontWeight: 700 }}>{k}</span><span style={{ color: C.mid }}>{v}</span></>);

export function LevelTape({ onOpen = null }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState("QQQ");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [showGrades, setShowGrades] = useState(false);
  const [showRule, setShowRule] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/gex?tape=read", { credentials: "include" });
      const j = await r.json().catch(() => null);
      if (r.status === 401) { setErr(401); return; }   // hidden, like the flow panel, unless the session can read it
      if (!j?.ok) { setErr(j?.error || j?.reason || `HTTP ${r.status}`); return; }
      setErr(null); setData(j);
    } catch (e) { setErr(String(e?.message || e)); }
  }, []);
  useEffect(() => {
    Promise.resolve().then(load);
    const t = setInterval(() => { if (typeof document === "undefined" || document.visibilityState === "visible") load(); }, 5 * 60000);
    return () => clearInterval(t);
  }, [load]);

  const watch = data?.watch || [];
  // A removed (or expired) watch name falls back to QQQ.
  const cur = BOOK_SYMBOLS.includes(sel) || watch.some(n => n.symbol === sel) ? sel : "QQQ";

  const pick = (s) => { setSel(s); if (onOpen) onOpen(s); };
  const act = async (op, symbol) => {
    const s = String(symbol || "").trim().toUpperCase();
    if (!s) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch(`/api/gex?tape=watch&op=${op}&symbol=${encodeURIComponent(s)}`, { method: "POST", credentials: "include" });
      const j = await r.json().catch(() => null);
      if (!j?.ok) setMsg(j?.why || j?.error || `HTTP ${r.status}`);
      else if (op === "add") { setInput(""); setMsg(j.first === "captured" ? `${s} on — first capture taken` : `${s} on — captures start at the next session`); setSel(s); if (onOpen) onOpen(s); }
      await load();
    } catch (e) { setMsg(String(e?.message || e)); }
    setBusy(false);
  };

  const group = BOOK_SYMBOLS.includes(cur) ? cur : "watch";
  const board = data?.boards?.[cur] || null;
  const sum = data?.summary?.[group] || null;
  const graded = data?.graded?.rows?.[cur] || null;
  const entry = watch.find(n => n.symbol === cur) || null;
  const usage = data?.health?.usage;

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <SLabel style={{ marginBottom: 0, whiteSpace: "nowrap" }}>🎯 Level tape</SLabel>
      {BOOK_SYMBOLS.map(s => <Chip key={s} on={cur === s} onClick={() => pick(s)}>{s}</Chip>)}
      {watch.map(n => (
        <span key={n.symbol} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <Chip on={cur === n.symbol} onClick={() => pick(n.symbol)}
            title={`On the tape ${dayShort(n.from)} → ${dayShort(n.until)}${n.earnings?.date ? ` · earnings ${dayShort(n.earnings.date)}${n.earnings.time ? " " + n.earnings.time : ""}` : ""}`}>
            {n.symbol}{n.earnings?.date ? <span style={{ fontWeight: 700, color: C.purple, marginLeft: 5 }}>ER {dayShort(n.earnings.date).split(" ")[0]}</span> : null}
          </Chip>
          <button onClick={() => act("remove", n.symbol)} disabled={busy} aria-label={`Remove ${n.symbol}`}
            style={{ cursor: "pointer", background: "none", border: "none", color: C.muted, fontWeight: 800, fontSize: 13, padding: "0 3px" }}>×</button>
        </span>
      ))}
      {watch.length < WATCH_MAX && (
        <span style={{ display: "inline-flex", gap: 5 }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !busy) act("add", input); }}
            placeholder="XYZ" aria-label="Watch a ticker" title="Add a name to the tape for today and the next session (max 3)"
            style={{ width: 60, background: "transparent", border: "1.5px solid " + C.bdr, borderRadius: 7, padding: "3px 8px",
                     fontSize: 12, fontWeight: 800, color: C.text, textTransform: "uppercase" }} />
          <button onClick={() => act("add", input)} disabled={busy || !input.trim()}
            style={{ cursor: busy ? "wait" : "pointer", fontSize: 12, fontWeight: 800, padding: "3px 10px", borderRadius: 7,
                     border: "1.5px solid " + C.blue, background: C.surf, color: C.blue, opacity: busy || !input.trim() ? 0.6 : 1 }}>
            {busy ? "…" : "+ Watch 2 days"}
          </button>
        </span>
      )}
      <span style={{ marginLeft: "auto", fontSize: 11, color: C.muted, fontWeight: 700 }}>
        every {data?.everyMin || 15} min · 09:45–15:45 ET
        {usage?.limit ? ` · UW ${Number(usage.today || 0).toLocaleString()}/${Number(usage.limit).toLocaleString()} today` : ""}
      </span>
    </div>
  );

  if (err === 401) return null;
  if (err) return <Card>{header}<div style={{ marginTop: 8, fontSize: 12.5, color: C.amber }}>{err}</div></Card>;
  if (!data) return <Card>{header}<div style={{ marginTop: 8, fontSize: 12.5, color: C.muted }}>Loading…</div></Card>;

  const cell = { padding: "4px 6px", borderBottom: "1px solid " + C.bdr, fontSize: 12.5, textAlign: "right", whiteSpace: "nowrap" };
  const head = { ...cell, fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4 };

  return (
    <Card>
      {header}
      {msg && <div style={{ marginTop: 6, fontSize: 11.5, color: C.mid, fontWeight: 700 }}>{msg}</div>}
      {!data.uwConfigured && <div style={{ marginTop: 6, fontSize: 11.5, color: C.amber }}>UW key not set on this deployment — dvcap's levels only.</div>}

      {/* 1 — THE THREE BOOKS, NOW */}
      <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 14, color: C.text }}>{cur}</b>
        {board ? (
          <span style={{ fontSize: 11.5, color: C.muted, fontWeight: 700 }}>
            spot {fmtLv(board.spot)} · {board.captures} capture{board.captures === 1 ? "" : "s"} today · last {dubaiEt(board.at)}
          </span>
        ) : <span style={{ fontSize: 11.5, color: C.muted }}>no capture today yet — the first is at 09:45 ET</span>}
        {entry?.earnings?.date && (
          <span style={{ fontSize: 11.5, color: C.purple, fontWeight: 800 }}>
            earnings {dayShort(entry.earnings.date)}{entry.earnings.time ? ` · ${entry.earnings.time}` : ""}{entry.earnings.status === "estimated" ? " (est.)" : ""}
          </span>
        )}
        {entry && <span style={{ fontSize: 11.5, color: C.muted }}>on until {dayShort(entry.until)}</span>}
      </div>
      {board && (
        <div style={{ overflowX: "auto", marginTop: 6 }}>
          <table style={{ borderCollapse: "collapse", minWidth: 300, width: "100%" }}>
            <thead><tr>
              <th style={{ ...head, textAlign: "left" }}>Level</th>
              {SOURCES.map(s => <th key={s} style={head}>{SOURCE_LABEL[s]}</th>)}
            </tr></thead>
            <tbody>
              {KINDS.map(k => (
                <tr key={k}>
                  <td style={{ ...cell, textAlign: "left", color: C.lbl, fontWeight: 700 }}>{KIND_LABEL[k]}</td>
                  {SOURCES.map(s => <td key={s} style={{ ...cell, fontWeight: 800, color: board.cols?.[s]?.[k] != null ? C.text : C.muted }}>{fmtLv(board.cols?.[s]?.[k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {board?.prem && (
        <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 12 }}>
          <Row k="Net premium" v={<b style={{ color: board.prem.net >= 0 ? C.green : C.red }}>{fmtUsd(board.prem.net)}</b>} />
          <Row k="Calls · puts" v={`${fmtUsd(board.prem.netCall)} · ${fmtUsd(board.prem.netPut)}`} />
          {board.premPath?.length > 1 && <Row k="Through the day" v={board.premPath.map(p => fmtUsd(p.net)).join(" → ")} />}
        </div>
      )}

      {/* 2 — THE SCORECARD: held % of tested, per book and level */}
      <div style={{ marginTop: 14, display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b style={{ fontSize: 12.5, color: C.text }}>Scorecard · {group === "watch" ? "watch names, pooled" : group}</b>
        <span style={{ fontSize: 11.5, color: C.muted, fontWeight: 700 }}>
          {sum?.days ? `${sum.days} session${sum.days === 1 ? "" : "s"} · ${dayShort(sum.first)} → ${dayShort(sum.last)}` : "no graded session yet — the first grades land at 16:25 ET"}
        </span>
        <button onClick={() => setShowRule(v => !v)} style={{ marginLeft: "auto", cursor: "pointer", background: "none", border: "none", color: C.blue, fontSize: 11.5, fontWeight: 800 }}>
          {showRule ? "hide rule" : "the rule"}
        </button>
      </div>
      {showRule && (
        <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", fontSize: 11.5 }}>
          <Row k="Tested" v={`a 5-min bar comes within ${data.rule.testPct}% of the level`} />
          <Row k="Held" v={`moves ${data.rule.bouncePct}%+ away within ${data.rule.windowMin} min, no close through`} />
          <Row k="Broke" v={`a 5-min close goes through by more than ${data.rule.throughPct}%`} />
          <Row k="Stalled" v="tested, neither" />
          <Row k="Counted" v="once a day, from the first capture that names the level" />
        </div>
      )}
      {sum?.days > 0 && (
        <div style={{ overflowX: "auto", marginTop: 6 }}>
          <table style={{ borderCollapse: "collapse", minWidth: 420, width: "100%" }}>
            <thead><tr>
              <th style={{ ...head, textAlign: "left" }}>Book</th>
              {[...KINDS, "all"].map(k => <th key={k} style={head}>{k === "all" ? "All" : KIND_LABEL[k]}</th>)}
            </tr></thead>
            <tbody>
              {SOURCES.map(s => (
                <tr key={s}>
                  <td style={{ ...cell, textAlign: "left", color: C.lbl, fontWeight: 700 }}>{SOURCE_LABEL[s]}</td>
                  {[...KINDS, "all"].map(k => {
                    const c = sum.bySrc?.[s]?.[k];
                    return (
                      <td key={k} style={cell} title={c ? `${c.n} levels · ${c.tested} tested · held ${c.held} · broke ${c.broke} · stalled ${c.stalled}` : undefined}>
                        {c?.tested ? (<><b style={{ color: c.holdRate >= 50 ? C.green : C.amber }}>{c.holdRate}%</b>
                          <span style={{ color: C.muted, fontSize: 10.5 }}> of {c.tested}</span></>) : <span style={{ color: C.muted }}>{c?.n ? `0 of ${c.n}` : "—"}</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 10.5, color: C.muted, marginTop: 3 }}>held % of tested · hover a cell for broke / stalled / untested</div>
        </div>
      )}

      {/* 3 — THE LAST GRADED SESSION, LEVEL BY LEVEL */}
      {graded?.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setShowGrades(v => !v)} style={{ cursor: "pointer", background: "none", border: "none", padding: 0, color: C.blue, fontSize: 11.5, fontWeight: 800 }}>
            {showGrades ? "▾" : "▸"} {cur} grades · {dayShort(data.graded.date)} · {graded.length} levels
          </button>
          {showGrades && (
            <div style={{ marginTop: 4, display: "grid", gridTemplateColumns: "auto auto auto auto 1fr", gap: "2px 12px", fontSize: 11.5, alignItems: "baseline" }}>
              {graded.map((r, i) => (
                <Fragment key={i}>
                  <span style={{ color: C.lbl, fontWeight: 700 }}>{SOURCE_LABEL[r.src]}</span>
                  <span style={{ color: C.mid }}>{KIND_LABEL[r.kind]}</span>
                  <b style={{ color: C.text, textAlign: "right" }}>{fmtLv(r.level)}</b>
                  <span style={{ color: C.muted }}>{r.distPct != null ? `${r.distPct > 0 ? "+" : ""}${r.distPct}%` : ""}</span>
                  <span style={{ color: C[OUT_TONE[r.outcome]] || C.mid, fontWeight: 800 }}>{r.outcome}{r.testAt ? <span style={{ color: C.muted, fontWeight: 600 }}> · {dubaiEt(r.testAt)}</span> : null}</span>
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
