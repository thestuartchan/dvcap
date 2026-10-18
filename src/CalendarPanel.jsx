// src/CalendarPanel.jsx — Markets › Calendar. Six weeks of the one hand-kept calendar, by week,
// with the feed's auction rows (lib/calendarView.js). It reads the same events as the pre-reads.
import { useMemo, useState } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { calendarWeeks, tzCity, REGIONS, CAL_TAB_AHEAD_DAYS } from "../lib/calendarView.js";

// The viewer's own calendar date — "today" is where they are, not UTC.
const localToday = () => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const fmtWeek = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const REGION_LABEL = { ALL: "All", US: "US", ASIA: "Asia", EU: "Europe" };

export function CalendarPanel({ extra = [] }) {
  const [region, setRegion] = useState("ALL");
  const [majorOnly, setMajorOnly] = useState(false);
  const today = localToday();
  const view = useMemo(() => calendarWeeks({ today, extra, region, majorOnly }), [today, extra, region, majorOnly]);

  const pill = (on, label, onClick, title) => (
    <button onClick={onClick} title={title} aria-pressed={on} style={{
      background: on ? C.blBg : "transparent", border: "1.5px solid " + (on ? C.blue : C.bdr), borderRadius: 999,
      color: on ? C.blue : C.mid, padding: "4px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
    }}>{label}</button>
  );
  const countdown = (e) => {
    if (e.reported) return { txt: "reported", warn: false };
    if (e.days === 0) return { txt: "today", warn: true };
    if (e.days === 1) return { txt: "tomorrow", warn: true };
    return { txt: `in ${e.days}d`, warn: e.days <= 2 };
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card>
        <SLabel>📅 Calendar · next {CAL_TAB_AHEAD_DAYS / 7} weeks</SLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {["ALL", ...REGIONS].map(r => pill(region === r, REGION_LABEL[r], () => setRegion(r), r === "ALL" ? "Every region" : `${REGION_LABEL[r]} events and the ones that move every market`))}
          <span style={{ width: 1, height: 20, background: C.bdr, margin: "0 4px" }} />
          {pill(majorOnly, "Major only", () => setMajorOnly(v => !v), "Tier 1 only: the prints and decisions that move the regime read")}
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
          The hand-kept calendar plus weekly jobless claims and announced Treasury auctions. The pre-reads and the sizer's catalyst check read the same list.
          {view.beyondEntered && <> <b style={{ color: C.amber }}>Entries run to {fmtDay(view.lastEntered)}</b>; later weeks show only the weekly rules until the calendar is extended.</>}
        </div>
      </Card>

      {view.weeks.length === 0 && (
        <Card><div style={{ color: C.muted, fontSize: 13 }}>Nothing in this window for this filter.</div></Card>
      )}

      {view.weeks.map(w => (
        <Card key={w.monday} style={w.current ? { borderColor: C.blBdr } : undefined}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: w.current ? C.blue : C.lbl }}>
              Week of {fmtWeek(w.monday)}
            </span>
            {w.current && <span style={{ fontSize: 10, fontWeight: 800, color: C.blue }}>THIS WEEK</span>}
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {w.days.map((d, di) => (
              <div key={d.date} style={{ display: "grid", gridTemplateColumns: "minmax(76px, 92px) minmax(0, 1fr)", gap: 10, padding: "6px 0", borderTop: di ? "1px solid " + C.bdr : "none" }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: d.date === today ? C.blue : d.date < today ? C.lbl : C.mid, fontVariantNumeric: "tabular-nums" }}>{fmtDay(d.date)}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  {d.events.map((e, i) => {
                    const cd = countdown(e);
                    const city = tzCity(e.tz);
                    return (
                      <div key={i} style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 13, color: e.reported ? C.lbl : C.text, minWidth: 0 }}>
                        <span style={{ fontWeight: Number(e.tier) === 1 ? 700 : 500, textDecoration: e.reported ? "line-through" : "none", overflowWrap: "anywhere" }}>{e.title}</span>
                        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 8px", fontSize: 11.5, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
                          <span style={{ fontWeight: 700, color: C.lbl }}>{REGION_LABEL[e.region] || e.region}</span>
                          {e.time && <span>{e.time}{city ? ` ${city}` : ""}</span>}
                          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: cd.warn ? C.amber : C.lbl, background: cd.warn ? C.aBg : "transparent", border: "1px solid " + (cd.warn ? C.aBdr : C.bdr), borderRadius: 4, padding: "1px 5px" }}>{cd.txt}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
