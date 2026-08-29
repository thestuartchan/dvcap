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

    // P2.2 — run-up ALONE cannot separate "priced for perfection" from "de-risked into the print"
    // (AMD: record double-beat, −9% — an IV/expectations story, not a run-up story). The clean
    // leg is IV percentile, which needs an options feed we do not have server-side. So the card is
    // PARTIAL: it shows the observable legs and a soft LEAN, but withholds a verdict.
    const ivAvailable = (e.ivPercentile != null);   // wired only if an options feed is attached
    let lean, tone, status;
    if (chg5d == null && chg20d == null) {
      lean = 'no run data'; tone = 'muted'; status = 'PARTIAL';
    } else if (ivAvailable) {
      // Full read (unreachable until an IV feed is wired) — kept so the shape is ready.
      const rich = chg20d != null && vs50dPct != null && chg20d >= cfg.hotRun20d && vs50dPct >= cfg.stretch50d && e.ivPercentile >= 70;
      const cheap = chg20d != null && chg20d <= cfg.deRisked20d && e.ivPercentile <= 40;
      lean = rich ? 'richly positioned — priced for perfection' : cheap ? 'de-risked — room for a surprise' : 'neutral positioning';
      tone = rich ? 'amber' : cheap ? 'green' : 'muted'; status = 'FULL';
    } else {
      const softUp = chg20d != null && vs50dPct != null && chg20d >= cfg.hotRun20d && vs50dPct >= cfg.stretch50d;
      const softDown = chg20d != null && chg20d <= cfg.deRisked20d;
      lean = softUp ? 'run-up leans stretched (IV unknown)' : softDown ? 'run-up leans de-risked (IV unknown)' : 'run-up neutral (IV unknown)';
      tone = 'muted'; status = 'PARTIAL';
    }
    out.push({ name: e.name, sym: e.sym, label: e.label, date: e.date, daysTo, chg5d, chg20d, vs50dPct, reading: lean, tone, status,
      ivPercentile: e.ivPercentile ?? null });
  });
  out.sort((a, b) => a.daysTo - b.daysTo);
  // WHY IT IS EMPTY, not just that it is. The catalyst list is hand-maintained, and every entry in
  // it eventually goes past — at which point this module goes dark and looks identical to a feed
  // that failed. It is currently in exactly that state: one entry, NVDA on 2026-08-26, now expired.
  // A card that says "the list needs restocking" gets restocked; one that silently disappears does
  // not, and its absence is indistinguishable from there being nothing to worry about.
  const configured = (events || []).length;
  const past = (events || []).filter(e => {
    const ms = Date.parse(`${e.date}T00:00:00Z`);
    return Number.isFinite(ms) && Math.ceil((ms - now) / 86400000) < 0;
  }).length;
  const reason = out.length ? null
    : !configured ? 'no catalysts configured'
    : past === configured ? `every catalyst in the list has passed (${configured}) — lib/events.js needs restocking`
    : 'no catalyst inside the horizon';
  return { available: out.length > 0, events: out, configured, past, reason };
}
