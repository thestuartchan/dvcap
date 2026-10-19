// src/CalendarPanel.jsx — Markets › Calendar. The one hand-kept calendar a quarter out, by month
// and then by week, with the feed's auction rows (lib/calendarView.js). The pre-reads read the same
// events.
import { useMemo, useState } from "react";
import { C } from "./theme.js";
import { Card, SLabel } from "./ui.jsx";
import { calendarMonths, tzCity, REGIONS } from "../lib/calendarView.js";
import { dubaiEt, zonedInstant } from "../lib/timeFmt.js";

// Dubai first, ET in brackets (lib/timeFmt.js), then the event's own city when it is neither:
// "03:50 Dubai (18:50 ET) · Tokyo 08:50". A row with no zone keeps the time as entered.
const whenOf = (e, city) => {
  const at = e.tz ? zonedInstant(e.date, e.time, e.tz) : null;
  if (!at) return `${e.time}${city ? ` ${city}` : ""}`;
  const own = city && e.tz !== "America/New_York" && e.tz !== "Asia/Dubai" ? ` · ${city} ${e.time}` : "";
  return `${dubaiEt(at, { refDate: e.date })}${own}`;
};

// The viewer's own calendar date — "today" is where they are, not UTC.
const localToday = () => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const fmtDay = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const fmtWeek = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtMonth = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const fmtMonthShort = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
const REGION_LABEL = { ALL: "All", US: "US", ASIA: "Asia", EU: "Europe" };

const SOURCE_LABEL = { fomc: "Fed", ecb: "ECB", boj: "BoJ", bea: "BEA", census: "Census", fred: "FRED (BLS)", earnings: "Earnings (Nasdaq)" };

export function CalendarPanel({ extra = [], autoSources = null }) {
  const [region, setRegion] = useState("ALL");
  const [majorOnly, setMajorOnly] = useState(false);
  const today = localToday();
  const view = useMemo(() => calendarMonths({ today, extra, region, majorOnly }), [today, extra, region, majorOnly]);
  const jump = (ym) => { try { document.getElementById(`cal-${ym}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { /* old browser: no smooth scroll */ } };

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
        <SLabel>📅 Calendar · to {view.to ? fmtDay(view.to) : "—"}</SLabel>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {["ALL", ...REGIONS].map(r => pill(region === r, REGION_LABEL[r], () => setRegion(r), r === "ALL" ? "Every region" : `${REGION_LABEL[r]} events and the ones that move every market`))}
          <span style={{ width: 1, height: 20, background: C.bdr, margin: "0 4px" }} />
          {pill(majorOnly, "Major only", () => setMajorOnly(v => !v), "Tier 1 only: the prints and decisions that move the regime read")}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 8 }}>
          <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase", color: C.lbl }}>Jump to</span>
          {view.months.map(m => pill(false, `${fmtMonthShort(m.month)} · ${m.count}`, () => jump(m.month), `${fmtMonth(m.month)}: ${m.count} events, ${m.major} major`))}
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
          Central-bank decisions (Fed, ECB, BoJ) and the main US releases are read automatically from the bodies that set them; your hand-kept entries win wherever both cover the same event. Weekly jobless claims, Treasury auctions and the earnings of the US-listed names on the watch list are automatic too; an earnings date the company has not announced yet is marked "est.".
          {view.beyondEntered && <> <b style={{ color: C.amber }}>Hand-kept entries run to {fmtDay(view.lastEntered)}</b>: Asia/Europe data and Korea-listed earnings after that are not on the page yet.</>}
          {autoSources && (() => {
            const bad = Object.entries(autoSources).filter(([, v]) => v && v.ok === false);
            return bad.length ? <> <b style={{ color: C.amber }}>Not read this time: {bad.map(([k, v]) => `${SOURCE_LABEL[k] || k} (${v.error})`).join(", ")}.</b></> : null;
          })()}
        </div>
      </Card>

      {view.months.map(m => (
        <section key={m.month} id={`cal-${m.month}`} style={{ display: "flex", flexDirection: "column", gap: 10, scrollMarginTop: "calc(var(--nav-h, 0px) + 8px)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "4px 10px", padding: "6px 2px 0", borderBottom: "2px solid " + C.bdr }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 900, color: C.text }}>{fmtMonth(m.month)}</h3>
            <span style={{ fontSize: 12, color: C.muted, fontWeight: 700 }}>{m.count} event{m.count === 1 ? "" : "s"} · {m.major} major</span>
            {m.partial && <span style={{ fontSize: 11, fontWeight: 700, color: C.amber }}>automatic dates only: earnings and Asia/Europe data not entered yet</span>}
          </div>
          {m.weeks.length === 0 && <div style={{ color: C.muted, fontSize: 13, padding: "4px 2px" }}>Nothing in this month for this filter.</div>}
          {m.weeks.map(w => (
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
                            <span title={e.auto ? `Read automatically from ${e.source}` : undefined} style={{ fontWeight: Number(e.tier) === 1 ? 700 : 500, textDecoration: e.reported ? "line-through" : "none", overflowWrap: "anywhere" }}>{e.title}</span>
                            <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 8px", fontSize: 11.5, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
                              <span style={{ fontWeight: 700, color: C.lbl }}>{REGION_LABEL[e.region] || e.region}</span>
                              {e.time && <span>{whenOf(e, city)}</span>}
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
        </section>
      ))}
    </div>
  );
}
