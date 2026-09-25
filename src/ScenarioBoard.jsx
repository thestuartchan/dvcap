// src/ScenarioBoard.jsx — which scenario am I in, readable at a glance.
//
// One row per scenario, grouped. Status, name and a 20-session strip on one line; the legs only
// where they matter (active and building); a single "closest trigger" line for the quiet ones;
// everything else — what it means, what to expect, what it is not, what ends it — one tap away.
// The engine is lib/scenarioBoard.js: settled closes, 20-session trends, one as-of date.
import { useState } from "react";
import { C, alpha } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";

const TONE = { red: C.red, amber: C.amber, green: C.green };
const fmtDay = (iso) => (iso ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—");

function StatusPill({ status, tone }) {
  const col = TONE[tone] || C.mid;
  const style = {
    ACTIVE:    { color: C.onFill, background: col, border: "1px solid " + col },
    BUILDING:  { color: col, background: alpha(col, 0.1), border: "1px solid " + alpha(col, 0.5) },
    QUIET:     { color: C.muted, background: "transparent", border: "1px solid " + C.bdr },
    "NO DATA": { color: C.muted, background: "transparent", border: "1px dashed " + C.bdrMd },
  }[status] || {};
  return (
    <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", borderRadius: 999,
                   padding: "2px 8px", minWidth: 62, textAlign: "center", flex: "0 0 auto", ...style }}>
      {status === "NO DATA" ? "no data" : status.toLowerCase()}
    </span>
  );
}

// The last 20 sessions, oldest left. Filled for active, half for building, a hairline for quiet.
function Strip({ strip, tone }) {
  if (!strip?.length) return null;
  const col = TONE[tone] || C.mid;
  return (
    <span title={`${fmtDay(strip[0].date)} → ${fmtDay(strip.at(-1).date)}`}
          style={{ display: "inline-flex", gap: 2, alignItems: "flex-end", flex: "0 0 auto" }}>
      {strip.map(d => (
        <span key={d.date} style={{
          width: 5, borderRadius: 1,
          height: d.status === "ACTIVE" ? 12 : d.status === "BUILDING" ? 8 : 3,
          background: d.status === "ACTIVE" ? col : d.status === "BUILDING" ? alpha(col, 0.5) : d.status === "QUIET" ? C.bdrMd : "transparent",
          border: d.status === "NO DATA" ? "1px dashed " + C.bdrMd : "none",
        }} />
      ))}
    </span>
  );
}

function sinceText(s) {
  if (!s.since) return null;
  if (s.sinceCapped) return `${s.status.toLowerCase()} 60+ sessions`;
  return `since ${fmtDay(s.since)}`;
}

function Leg({ l }) {
  const col = l.met ? C.text : C.muted;
  return (
    <span style={{ fontSize: 11.5, color: col, whiteSpace: "nowrap" }}>
      <span style={{ color: l.met ? C.green : l.met === false ? C.muted : C.amber, fontWeight: 800 }}>{l.met ? "✓" : l.met === false ? "✗" : "?"}</span>{" "}
      {l.label} <span style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}>{l.display}</span>
    </span>
  );
}

function Detail({ s }) {
  const row = (k, v) => (v ? (
    <div style={{ display: "flex", gap: 8, fontSize: 12, lineHeight: 1.5 }}>
      <span style={{ flex: "0 0 74px", fontSize: 9.5, fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: C.lbl, paddingTop: 2 }}>{k}</span>
      <span style={{ color: C.mid }}>{v}</span>
    </div>
  ) : null);
  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px dashed " + C.bdr, display: "flex", flexDirection: "column", gap: 4 }}>
      {s.status !== "ACTIVE" && s.status !== "BUILDING" && s.legs?.length > 0 && (
        <div style={{ display: "flex", gap: "3px 14px", flexWrap: "wrap", marginBottom: 2 }}>{s.legs.map(l => <Leg key={l.label} l={l} />)}</div>
      )}
      {row("Means", s.meaning)}
      {row("Expect", s.expect?.length ? s.expect.join(" · ") : null)}
      {row("Not", s.notLines?.length ? s.notLines.join(" ") : null)}
      {row("Watch", s.watch)}
      {row("Ends if", s.breaksIf)}
      {row("For the book", s.consequence)}
      {row("Note", s.qualifier || s.note)}
    </div>
  );
}

function Row({ s }) {
  const [open, setOpen] = useState(false);
  const live = s.status === "ACTIVE" || s.status === "BUILDING";
  const col = TONE[s.tone] || C.text;
  return (
    <div style={{ padding: "8px 10px", borderRadius: 8, cursor: "pointer",
                  background: s.status === "ACTIVE" ? alpha(col, 0.07) : "transparent",
                  border: "1px solid " + (s.status === "ACTIVE" ? alpha(col, 0.45) : C.bdr) }}
         onClick={() => setOpen(o => !o)}>
      <div style={{ display: "flex", alignItems: "center", gap: "4px 10px", flexWrap: "wrap" }}>
        <StatusPill status={s.status} tone={s.tone} />
        <b style={{ fontSize: 13.5, color: live ? col : C.mid }}>{s.name}</b>
        <span style={{ fontSize: 12, color: C.muted, flex: "1 1 180px" }}>{s.gloss}</span>
        <Strip strip={s.strip} tone={s.tone} />
        <span style={{ fontSize: 11, color: C.muted, minWidth: 78, textAlign: "right" }}>{sinceText(s)}</span>
        <span style={{ fontSize: 11, color: C.muted }}>{open ? "▾" : "▸"}</span>
      </div>
      {live && s.legs?.length > 0 && (
        <div style={{ marginTop: 5, display: "flex", gap: "3px 14px", flexWrap: "wrap" }}>{s.legs.map(l => <Leg key={l.label} l={l} />)}</div>
      )}
      {!live && !open && (s.note || s.watch) && (
        <div style={{ marginTop: 3, fontSize: 11.5, color: C.muted }}>{s.status === "NO DATA" || s.note ? s.note || s.watch : `closest: ${s.watch}`}</div>
      )}
      {open && <Detail s={s} />}
    </div>
  );
}

export function ScenarioBoard({ scenarios, board }) {
  if (!scenarios?.length) return null;
  const groups = board?.groups?.length ? board.groups : [{ id: null, label: null }];
  const sum = board?.summary;
  return (
    <Card id="daily-scenarios">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <SLabel>🧭 Scenario board</SLabel>
        <span style={{ fontSize: 11, color: C.muted }}>
          20-session trends{board?.asOf ? ` · as of the ${fmtDay(board.asOf)} close` : ""} · tap a row for detail
        </span>
      </div>
      {sum && (
        <div style={{ marginTop: 6, fontSize: 13.5, color: C.text, lineHeight: 1.5 }}>
          {sum.active.length ? <><b>Active:</b> {sum.active.join(", ")}</> : <b>No scenario active</b>}
          {sum.building.length > 0 && <span style={{ color: C.mid }}> · <b>Building:</b> {sum.building.join(", ")}</span>}
          <span style={{ color: C.muted }}> · {sum.quiet} quiet{sum.noData.length ? ` · no data: ${sum.noData.join(", ")}` : ""}</span>
        </div>
      )}
      {groups.map(g => {
        const rows = g.id ? scenarios.filter(s => s.group === g.id) : scenarios;
        if (!rows.length) return null;
        return (
          <div key={g.id || "all"} style={{ marginTop: 10 }}>
            {g.label && <div style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.6, textTransform: "uppercase", color: C.lbl, marginBottom: 5 }}>{g.label}</div>}
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {rows.map(s => <Row key={s.id} s={s} />)}
            </div>
          </div>
        );
      })}
      <div style={{ marginTop: 10, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
        Each leg is a 20-session trend in its own volatility: it switches on past ±0.5σ and off only
        once it fades inside ±0.25σ, so a trend sitting on the line does not flicker. Active means
        every leg holds; building, at least half the directional ones. Korea and China read their own
        feeds and carry no strip.
      </div>
    </Card>
  );
}
