// lib/events.js — event positioning (D2). The question before a catalyst is not what the company
// will report — it is what is already PAID FOR. AMD delivered a record double-beat with in-line
// guidance and fell 9% because it was priced for perfection. This reads how a name is positioned
// INTO a known event: the run-up (5d/20d) and how far it sits above its 50-day line.
//
// (IV percentile — the cleanest "priced for perfection" leg — needs an options feed, which we do
// not have keyless; it is intentionally omitted rather than faked. The run-up + stretch are the
// observable proxies.) Events live in one editable list.
//
// A CATALYST IS NOT A CALENDAR ENTRY. data/calendar.json answers "what lands this week" and takes
// free text — ISM, JOLTS, a Waller speech. This list only takes things with a TICKER, because the
// whole output is a price read on that ticker going in. A macro print has no run-up to measure, so
// it belongs there and not here; the two lists overlap only on single-name events.
//
// DATES ARE PROVIDER-SCHEDULED, not company-confirmed. Where the feed returned more than one
// candidate for the same quarter the entry carries `alt` and the card says so — a catalyst read
// that fires a week early is worse than one that does not fire, so the ambiguity is shown, not
// resolved by guessing. Curated 2026-08-30 through year-end; December is thin because the
// provider has not published those dates yet, not because the quarter is quiet.

export const EVENTS = [
  { name: 'CrowdStrike',  sym: 'CRWD',  date: '2026-09-01', label: 'Q2 earnings' },
  { name: 'Broadcom',     sym: 'AVGO',  date: '2026-09-03', label: 'Q3 earnings', alt: ['2026-09-02'] },
  { name: 'Alibaba',      sym: 'BABA',  date: '2026-09-04', label: 'Q1 FY27 earnings' },
  { name: 'Oracle',       sym: 'ORCL',  date: '2026-09-08', label: 'Q1 earnings — AI-capex read' },
  { name: 'Micron',       sym: 'MU',    date: '2026-09-30', label: 'Q4 earnings — memory cycle', alt: ['2026-09-22', '2026-09-29'] },
  { name: 'TSMC',         sym: 'TSM',   date: '2026-10-15', label: 'Q3 earnings — semi bellwether' },
  { name: 'Alphabet',     sym: 'GOOGL', date: '2026-10-28', label: 'Q3 earnings', alt: ['2026-11-04'] },
  { name: 'Meta',         sym: 'META',  date: '2026-10-28', label: 'Q3 earnings', alt: ['2026-11-04'] },
  { name: 'Microsoft',    sym: 'MSFT',  date: '2026-10-28', label: 'Q3 earnings', alt: ['2026-11-04'] },
  { name: 'Apple',        sym: 'AAPL',  date: '2026-10-29', label: 'FQ4 earnings' },
  { name: 'Amazon',       sym: 'AMZN',  date: '2026-10-29', label: 'Q3 earnings' },
  { name: 'AMD',          sym: 'AMD',   date: '2026-11-03', label: 'Q3 earnings' },
  { name: 'Uber',         sym: 'UBER',  date: '2026-11-03', label: 'Q3 earnings' },
  { name: 'Arm',          sym: 'ARM',   date: '2026-11-04', label: 'FQ2 earnings' },
  { name: 'NVIDIA',       sym: 'NVDA',  date: '2026-11-18', label: 'Q3 earnings' },
  { name: 'CrowdStrike',  sym: 'CRWD',  date: '2026-12-01', label: 'Q3 earnings' },
  { name: 'Marvell',      sym: 'MRVL',  date: '2026-12-01', label: 'Q3 earnings' },
];

export const EVENT_CFG = Object.freeze({
  horizonDays: 14,   // only surface events within this window
  hotRun20d:   15,   // 20d run at/above this …
  stretch50d:  5,    // … and this % above the 50d line = richly positioned
  deRisked20d: -10,  // 20d run at/below this = de-risked into the print
});

const dayDelta = (dateStr, now) => {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.ceil((ms - now) / 86400000) : null;
};

// Which catalysts are close enough to be worth a price fetch. Exported so the caller pulls trends
// for THOSE ONLY — a year-long list would otherwise cost one network round trip per entry on every
// assemble, the overwhelming majority of them for prints months away.
export function dueEvents(events = EVENTS, nowMs = Date.now(), cfg = EVENT_CFG) {
  return (events || []).filter(e => {
    const d = dayDelta(e.date, nowMs);
    return d != null && d >= 0 && d <= cfg.horizonDays;
  });
}

// events: [{name,sym,date,label,alt?}]. trends: { [sym]: {price, chg5d, chg20d, ma50} } — keyed by
// symbol, not positional, so filtering the fetch above cannot silently misalign a name with another
// name's run-up. nowMs: Date.now() passed in (serverless clock). Returns only in-window events.
export function eventPositioning({ events = EVENTS, trends = {}, nowMs } = {}, cfg = EVENT_CFG) {
  const now = nowMs ?? 0;
  const out = [];
  (events || []).forEach((e) => {
    const daysTo = dayDelta(e.date, now);
    if (daysTo == null) return;
    if (daysTo < 0 || daysTo > cfg.horizonDays) return;   // past, or too far out
    const t = trends?.[e.sym];
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
    // An unresolved date is worth a word on the card. Reading positioning into the wrong day is the
    // one failure this module can produce silently.
    const dateNote = e.alt?.length ? `date unconfirmed — also scheduled ${e.alt.join(' / ')}` : null;
    out.push({ name: e.name, sym: e.sym, label: e.label, date: e.date, daysTo, chg5d, chg20d, vs50dPct, reading: lean, tone, status,
      dateNote, alt: e.alt ?? null, ivPercentile: e.ivPercentile ?? null });
  });
  out.sort((a, b) => a.daysTo - b.daysTo);

  // WHY IT IS EMPTY, not just that it is. The catalyst list is hand-maintained, and every entry in
  // it eventually goes past — at which point this module goes dark and looks identical to a feed
  // that failed. A card that says "the list needs restocking" gets restocked; one that silently
  // disappears does not, and its absence is indistinguishable from there being nothing to worry
  // about. `next` carries the same weight the other way: a quiet fortnight is only reassuring if
  // you can see what is sitting just past the edge of it.
  const configured = (events || []).length;
  const past = (events || []).filter(e => { const d = dayDelta(e.date, now); return d != null && d < 0; }).length;
  const next = (events || [])
    .map(e => ({ ...e, daysTo: dayDelta(e.date, now) }))
    .filter(e => e.daysTo != null && e.daysTo > cfg.horizonDays)
    .sort((a, b) => a.daysTo - b.daysTo)[0] || null;
  const reason = out.length ? null
    : !configured ? 'no catalysts configured'
    : past === configured ? `every catalyst in the list has passed (${configured}) — lib/events.js needs restocking`
    : next ? `nothing inside ${cfg.horizonDays} days — next is ${next.name} (${next.sym}) in ${next.daysTo}`
    : 'no catalyst inside the horizon';
  return {
    available: out.length > 0, events: out, configured, past, reason,
    next: next ? { name: next.name, sym: next.sym, label: next.label, date: next.date, daysTo: next.daysTo } : null,
  };
}
