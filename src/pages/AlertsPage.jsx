// src/pages/AlertsPage.jsx — Rules & Alerts: every rule dvcap can fire on, its state now, every alert
// it sent and where each kind goes. One module behind it (lib/alerts.js): a rule is set on the
// Position Desk or on a console card; this page is where they are seen together. Read-only.
// Data: /api/tradecard?alerts=1, behind the login (it carries book symbols and levels).
import { useEffect, useMemo, useState } from "react";
import { C, alpha } from "../theme.js";
import { Card, SLabel } from "../ui.jsx";
import { STATUS } from "../../lib/status.js";
import { dubaiEtStamp } from "../../lib/timeFmt.js";

// State → status token: hit is the breach, due and near are the watch, ok is quiet.
const STATE_TONE = { hit: STATUS.DANGER, due: STATUS.WATCH, near: STATUS.WATCH, ok: STATUS.BENIGN };
const SOURCE_SHORT = { desk: "Desk", console: "Console", idea: "Idea", job: "Job", statement: "Statement" };

function Stat({ label, value, color, sub }) {
  return (
    <div style={{ minWidth: 96 }}>
      <div style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>}
    </div>
  );
}

function StateChip({ state }) {
  const t = STATE_TONE[state];
  return (
    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, textTransform: "uppercase", whiteSpace: "nowrap", borderRadius: 5, padding: "1px 6px",
      color: t ? t.color : C.muted, background: t ? t.bg : "transparent", border: "1px solid " + (t ? t.bdr : C.bdr) }}>{state}</span>
  );
}

const cell = { padding: "6px 8px", borderBottom: "1px solid " + C.bdr, fontSize: 12.5, verticalAlign: "top" };
const head = { ...cell, fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4, textAlign: "left" };

export function AlertsPage() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState("all");
  useEffect(() => {
    fetch("/api/tradecard?alerts=1", { credentials: "include" })
      .then(r => (r.status === 401 ? { ok: false, why: "sign in to the dashboard to see the book's rules" } : r.json()))
      .then(j => (j?.ok ? setD(j) : setErr(j?.why || j?.error || "no answer")))
      .catch(e => setErr(String(e.message || e)));
  }, []);
  const rules = useMemo(() => (d?.rules || []).filter(r => filter === "all" || r.source === filter), [d, filter]);

  if (err) return <Card><SLabel>Rules & Alerts</SLabel><div style={{ color: C.amber, fontWeight: 700, fontSize: 12.5 }}>Could not load: {err}</div></Card>;
  if (!d) return <Card><SLabel>Rules & Alerts</SLabel><div style={{ color: C.muted, fontSize: 12.5 }}>Loading…</div></Card>;

  const sent7 = Object.values(d.week || {}).reduce((a, w) => a + w.sent, 0);
  const failed7 = Object.values(d.week || {}).reduce((a, w) => a + w.failed, 0);
  const bySource = (s) => (d.rules || []).filter(r => r.source === s).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* ── NOW ── */}
      <Card>
        <SLabel>Rules & Alerts</SLabel>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", marginBottom: 6 }}>
          <Stat label="Rules" value={d.counts.total} sub={`${bySource("desk")} Desk · ${bySource("console")} console`} />
          <Stat label="Hit" value={d.counts.hit} color={d.counts.hit ? STATUS.DANGER.color : C.text} />
          <Stat label="Due / near" value={d.counts.due + d.counts.near} color={d.counts.due + d.counts.near ? STATUS.WATCH.color : C.text} />
          <Stat label="Sent · 7 days" value={sent7} />
          <Stat label="Failed · 7 days" value={failed7} color={failed7 ? STATUS.DANGER.color : C.text} />
        </div>
        <div style={{ fontSize: 11.5, color: C.muted }}>
          Desk states from the close check{d.deskCheckedAt ? ` · ${dubaiEtStamp(new Date(d.deskCheckedAt))}` : " · not run yet"} · console levels priced now
          {d.consoleError ? <span style={{ color: C.amber }}> · console prices unavailable ({d.consoleError})</span> : null}
        </div>
      </Card>

      {/* ── THE RULES ── */}
      <Card>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <SLabel style={{ marginBottom: 0 }}>Every rule</SLabel>
          {["all", "desk", "console"].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ background: filter === f ? C.blBg : "transparent", color: filter === f ? C.blue : C.mid,
              border: "1px solid " + (filter === f ? C.blue : C.bdr), borderRadius: 999, padding: "2px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
              {f === "all" ? "All" : SOURCE_SHORT[f]}
            </button>
          ))}
        </div>
        {rules.length ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={head}>State</th><th style={head}>Position</th><th style={head}>Rule</th><th style={head}>Now</th><th style={head}>From</th></tr></thead>
              <tbody>
                {rules.map(r => (
                  <tr key={r.id}>
                    <td style={cell}><StateChip state={r.state} /></td>
                    <td style={{ ...cell, fontWeight: 700, color: C.text, whiteSpace: "nowrap" }}>{r.name}</td>
                    <td style={{ ...cell, color: C.mid }}>
                      <b style={{ color: C.text }}>{r.kind}</b>{r.rule ? ` · ${r.rule}` : r.level != null ? ` · ${r.level}` : ""}
                      {r.alerts ? null : <span style={{ color: C.muted }}> · draft, not sent</span>}
                    </td>
                    <td style={{ ...cell, color: C.mid, fontVariantNumeric: "tabular-nums" }}>{r.note || "—"}</td>
                    <td style={{ ...cell, color: C.muted, whiteSpace: "nowrap" }}>{SOURCE_SHORT[r.source]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div style={{ fontSize: 12.5, color: C.muted }}>No rules {filter === "all" ? "yet: set them on the Position Desk or as levels on a console card." : `from ${SOURCE_SHORT[filter]}.`}</div>}
      </Card>

      {/* ── WHAT WAS SENT ── */}
      <Card>
        <SLabel>Alert log · last {d.log.length}</SLabel>
        {d.log.length ? (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={head}>When</th><th style={head}>Source</th><th style={head}>Alert</th><th style={head}>Channel</th><th style={head}>Sent</th></tr></thead>
              <tbody>
                {d.log.map((l, i) => (
                  <tr key={i}>
                    <td style={{ ...cell, color: C.muted, whiteSpace: "nowrap" }}>{dubaiEtStamp(new Date(l.at))}</td>
                    <td style={{ ...cell, color: C.mid, whiteSpace: "nowrap" }}>{SOURCE_SHORT[l.source] || l.source}</td>
                    <td style={{ ...cell, color: C.text }}>{l.symbol ? <b>{l.symbol} </b> : null}{l.title || l.ruleId}</td>
                    <td style={{ ...cell, color: C.muted, whiteSpace: "nowrap" }}>{d.channels.find(c => c.id === l.channel)?.label || l.channel}</td>
                    <td style={{ ...cell, whiteSpace: "nowrap", fontWeight: 700, color: l.ok ? STATUS.BENIGN.color : STATUS.DANGER.color }}>{l.ok ? "✓" : `✗ ${l.why || ""}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div style={{ fontSize: 12.5, color: C.muted }}>Nothing sent since the log started. Every alert from now on is listed here with the rule it came from.</div>}
      </Card>

      {/* ── WHERE EACH KIND GOES ── */}
      <Card>
        <SLabel>Where alerts go</SLabel>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 6, fontSize: 12.5, lineHeight: 1.45 }}>
          {Object.entries(d.sources).map(([id, s]) => {
            const ch = d.channels.find(c => c.id === s.channel);
            return [
              <div key={id} style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4, paddingTop: 2 }}>{s.label}</div>,
              <div key={id + "v"} style={{ color: C.mid }}>
                <b style={{ color: C.text }}>{ch?.label}</b> ({ch?.who}){ch && !ch.set ? <span style={{ color: STATUS.DANGER.color, fontWeight: 700 }}> · webhook not set</span> : null}
                <span style={{ color: C.muted }}> · checked {s.checked} · fires on {s.rules}</span>
                {d.week?.[id] ? <span style={{ color: C.muted, background: alpha(C.blue, 0x10), borderRadius: 4, padding: "0 5px", marginLeft: 6 }}>{d.week[id].sent} sent this week</span> : null}
              </div>,
            ];
          })}
        </div>
      </Card>
    </div>
  );
}
