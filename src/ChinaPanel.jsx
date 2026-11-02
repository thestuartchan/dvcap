// src/ChinaPanel.jsx — the China read (lib/chinaRead.js, served by /api/indicators?china=1).
// One verdict line, then five rows to scan: what the row says, the evidence, what would flip it.
// Its own read: it does not vote on the Signal Board.
import { useEffect, useState } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { dubaiEt, zonedInstant } from "../lib/timeFmt.js";

const TONE = { support: C.green, risk: C.red, neutral: C.amber, unknown: C.muted };
const MARK = { support: "▲", risk: "▼", neutral: "■", unknown: "○" };
const VERDICT = { supportive: C.green, "risk-off": C.red, mixed: C.amber, unknown: C.muted };

function eventWhen(e) {
  const t = e.time && e.tz ? zonedInstant(e.date, e.time, e.tz) : null;
  const day = new Date(`${e.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  return t ? `${day}, ${dubaiEt(t)}` : day;
}

export function ChinaPanel() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetch("/api/indicators?china=1").then(r => r.json())
      .then(j => (j?.rows ? setD(j) : setErr(j?.error || "no answer")))
      .catch(e => setErr(String(e.message || e)));
  }, []);
  const head = <SLabel><span style={{ display: "inline-block", background: C.red, color: C.onFill, fontSize: 9, fontWeight: 800, padding: "1px 4px", borderRadius: 3, marginRight: 5 }}>CN</span>China read</SLabel>;
  if (err) return <Card>{head}<div style={{ color: C.amber, fontSize: 12.5, fontWeight: 700 }}>Could not load the China read: {err}</div></Card>;
  if (!d) return <Card>{head}<div style={{ color: C.muted, fontSize: 12.5 }}>Loading…</div></Card>;
  const vc = VERDICT[d.verdict] || C.muted;
  return (
    <Card>
      {head}
      <div style={{ fontSize: 13.5, lineHeight: 1.45, marginBottom: 10, color: C.text }}>
        <b style={{ color: vc }}>{d.headline.split(":")[0]}</b>
        <span style={{ color: C.mid }}>{d.headline.includes(":") ? `:${d.headline.split(":").slice(1).join(":")}` : ""}</span>
        <span style={{ fontSize: 11, color: C.muted }}> · score {d.score >= 0 ? "+" : "−"}{Math.abs(d.score)} of {d.of} rows</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 12, rowGap: 8 }}>
        {d.rows.map(r => [
          <div key={r.key} style={{ fontSize: 10.5, fontWeight: 800, color: C.lbl, textTransform: "uppercase", letterSpacing: 0.4, paddingTop: 2, whiteSpace: "nowrap" }}>{r.label}</div>,
          <div key={r.key + "v"} style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: TONE[r.state] || C.text }}>{MARK[r.state]} {r.plain}</div>
            <div style={{ fontSize: 11.5, color: C.mid, lineHeight: 1.4 }}>{r.line}{r.asOf ? <span style={{ color: C.muted }}> · {r.asOf}</span> : null}</div>
            {r.flips && <div style={{ fontSize: 11, color: C.muted }}>Flips: {r.flips}</div>}
          </div>,
        ])}
      </div>
      {d.events?.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: C.mid, lineHeight: 1.5 }}>
          <b style={{ color: C.text }}>Next China data:</b> {d.events.map(e => `${e.title} (${eventWhen(e)})`).join(" · ")}
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 10.5, color: C.muted, lineHeight: 1.45 }}>
        Each row scores ▲ +1, ■ 0 or ▼ −1; the sum gives the verdict (+2 or more supportive, −2 or less risk-off). Own read: it does not vote on the Signal Board.
        Sources: HKEX Southbound, Yahoo daily closes (510300 and 3033 ETFs, USD/CNY, KWEB, copper), NBS official PMI{d.pmiSource ? <> (<a href={d.pmiSource} target="_blank" rel="noopener noreferrer" style={{ color: C.blue }}>release ↗</a>)</> : null}.
      </div>
    </Card>
  );
}
