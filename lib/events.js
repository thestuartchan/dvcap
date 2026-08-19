// lib/events.js — event positioning (D2). The question before a catalyst is not what the company
// will report — it is what is already PAID FOR. AMD delivered a record double-beat with in-line
// guidance and fell 9% because it was priced for perfection. This reads how a name is positioned
// INTO a known event: the run-up (5d/20d) and how far it sits above its 50-day line.
//
// (IV percentile — the cleanest "priced for perfection" leg — needs an options feed, which we do
// not have keyless; it is intentionally omitted rather than faked. The run-up + stretch are the
// observable proxies.) Events live in one editable list.

export const EVENTS = [
  { name: 'NVDA', sym: 'NVDA', date: '2026-08-26', label: 'earnings' },
];

export const EVENT_CFG = Object.freeze({
  horizonDays: 14,   // only surface events within this window
  hotRun20d:   15,   // 20d run at/above this …
  stretch50d:  5,    // … and this % above the 50d line = richly positioned
  deRisked20d: -10,  // 20d run at/below this = de-risked into the print
});

// events: [{name,sym,date,label}]. trends: aligned yahooTrend results ({price, chg5d, chg20d,
// ma50}). nowMs: Date.now() passed in (serverless clock). Returns only in-window events.
export function eventPositioning({ events = EVENTS, trends = [], nowMs } = {}, cfg = EVENT_CFG) {
  const now = nowMs ?? 0;
  const out = [];
  events.forEach((e, i) => {
    const t = trends[i];
    const ms = Date.parse(e.date + 'T00:00:00Z');
    if (!Number.isFinite(ms)) return;
    const daysTo = Math.ceil((ms - now) / 86400000);
    if (daysTo < 0 || daysTo > cfg.horizonDays) return;   // past, or too far out
    const chg5d = t?.chg5d ?? null, chg20d = t?.chg20d ?? null;
    const vs50dPct = (t?.price != null && t?.ma50) ? +(((t.price - t.ma50) / t.ma50) * 100).toFixed(1) : null;

    let reading, tone;
    if (chg20d != null && vs50dPct != null && chg20d >= cfg.hotRun20d && vs50dPct >= cfg.stretch50d) {
      reading = 'richly positioned into the print — priced for perfection; a beat may already be paid for';
      tone = 'amber';
    } else if (chg20d != null && chg20d <= cfg.deRisked20d) {
      reading = 'de-risked into the print — low expectations, room for an upside surprise';
      tone = 'green';
    } else if (chg5d == null && chg20d == null) {
      reading = 'positioning unavailable — no run data';
      tone = 'muted';
    } else {
      reading = 'neutral positioning into the print';
      tone = 'muted';
    }
    out.push({ name: e.name, sym: e.sym, label: e.label, date: e.date, daysTo, chg5d, chg20d, vs50dPct, reading, tone });
  });
  out.sort((a, b) => a.daysTo - b.daysTo);
  return { available: out.length > 0, events: out };
}
