// ledger.js — every hand-kept input, in one place, with its age and what happens when it is late.
//
// Why this exists: the inputs a person has to keep current were scattered across a paste panel,
// three entry forms, eight constants in the dashboard source and two data files, each with its
// own badge or none. The ones that changed daily had the strictest rules and the ones that set
// position size had the loosest, and nothing listed them together — so something was always
// overlooked for a while. This is the list. Each row says what it is, when it was last kept, how
// often it is meant to be, what the system DOES when it is late (suppress, exclude, haircut,
// badge, nothing), and where it is kept. Pure: the dashboard hands it the stores and the
// constants; the clock is injectable.
import { observationAge } from './gates.js';
import { kofiaStale } from './kofia.js';
import { sbStale } from './southbound.js';
import { ISM_STALE_DAYS } from './growth.js';

// States, in the order the ledger sorts them. 'stale' means the system has stopped using the
// input; 'due' means it is past its cadence but still used; 'missing' was never entered.
export const LEDGER_STATES = ['stale', 'missing', 'due', 'fresh', 'retired', 'undated'];
const RANK = Object.fromEntries(LEDGER_STATES.map((s, i) => [s, i]));

const calDays = (asOf, now) => {
  const t = Date.parse(String(asOf || '').slice(0, 10) + 'T00:00:00Z');
  return Number.isFinite(t) ? Math.floor((now.getTime() - t) / 864e5) : null;
};
const bizDays = (asOf, now) => asOf ? (observationAge(String(asOf).slice(0, 10), now)?.bizDays ?? null) : null;

function row(o) {
  return { key: o.key, label: o.label, group: o.group, asOf: o.asOf ?? null, days: o.days ?? null, bizDays: o.bizDays ?? null,
           cadence: o.cadence ?? null, state: o.state, rule: o.rule, effect: o.effect, where: o.where, note: o.note ?? null };
}

// `manual` is /api/manual-entry's GET body; `kofia` is the Korea store's `latest`; `consts` are
// the dashboard's dated constants (announced prints carry the live series' as-of so the ledger can
// tell a retired overlay from one in use); `files` carries what the two data files reach to.
export function handKeptLedger({ manual = {}, kofia = null, consts = {}, files = {}, now = new Date() } = {}) {
  const rows = [];
  const nowIso = now.toISOString().slice(0, 10);

  // ── KOFIA — the strictest rule in the system: two business days, then the clause is gone ──
  const kof = (key, label, keys, effect) => {
    const e = keys.map(k => kofia?.[k]).find(x => x?.asOf) || null;
    if (!e) return rows.push(row({ key, label, group: 'Korea (KOFIA paste)', state: 'missing', cadence: 'each Seoul session',
      rule: 'never entered — the clause it drives does not render', effect, where: 'Overview · Korea panel · paste the KOFIA blob' }));
    const stale = kofiaStale(e.asOf, now);
    rows.push(row({ key, label, group: 'Korea (KOFIA paste)', asOf: e.asOf, days: calDays(e.asOf, now), bizDays: bizDays(e.asOf, now), cadence: 'each Seoul session (2 business days)',
      state: stale ? 'stale' : 'fresh', rule: 'past 2 business days the clause is SUPPRESSED and the tripwire withheld — not footnoted', effect,
      where: 'Overview · Korea panel · paste the KOFIA blob' }));
  };
  kof('kofiaFlows', 'Korea flows (foreign / institutional / retail)', ['foreignNet', 'instNet', 'retailNet'], 'Korea read, retail-absorption gauge, Discord Korea block');
  kof('kofiaBalances', 'Korea balances (margin loans, deposits, CMA)', ['marginLoans', 'deposits', 'cma'], 'Korea flow implication, leverage and dry-powder read');
  kof('kofia7709', '7709 units', ['units7709'], 'the 7709 tripwire');

  // ── Manual-entry store ──
  const fp = manual?.fedPath?.latest || null;
  {
    const bd = fp?.date ? bizDays(fp.date, now) : null;
    rows.push(row({ key: 'fedPath', label: 'Fed path — ZQ futures settle', group: 'Manual entry', asOf: fp?.date ?? null, days: fp?.date ? calDays(fp.date, now) : null, bizDays: bd,
      cadence: 'daily (3 business days)', state: !fp ? 'missing' : bd > 3 ? 'stale' : 'fresh',
      rule: 'past 3 business days the derived hike/cut count is SUPPRESSED; the implied rate still shows', effect: 'Fed path card, ladder',
      where: 'Macro · Market-implied Fed path panel' }));
  }
  {
    const L = manual?.ism?.latest || null;
    const d = L?.asOf ? calDays(L.asOf, now) : null;
    rows.push(row({ key: 'ism', label: 'ISM manufacturing PMI', group: 'Manual entry', asOf: L?.asOf ?? null, days: d, cadence: `monthly (${ISM_STALE_DAYS} days)`,
      state: !L ? 'missing' : d > ISM_STALE_DAYS ? 'stale' : 'fresh',
      rule: `past ${ISM_STALE_DAYS} days from the release the leg is EXCLUDED from the growth axis`, effect: 'growth axis, monthly leg (one of four)',
      where: 'Macro · Growth axis card · enter this month' }));
  }
  {
    const sy = manual?.secYields?.USFR || consts.secYields?.USFR || null;
    const d = sy?.asOf ? calDays(sy.asOf, now) : null;
    rows.push(row({ key: 'usfr', label: 'USFR 30-day SEC yield', group: 'Manual entry', asOf: sy?.asOf ?? null, days: d, cadence: 'weekly-ish (14 days)',
      state: !sy ? 'missing' : d > 14 ? 'due' : 'fresh', rule: 'the DTB3 proxy flags drift beyond 10bp; the stored figure is still shown', effect: 'cash-yield comparison',
      where: 'Macro · Cash yields panel · from the issuer page' }));
  }
  {
    const sb = manual?.southbound?.series || [];
    const last = sb.length ? sb[sb.length - 1].date : null;
    rows.push(row({ key: 'southbound', label: 'HKEX Southbound flow', group: 'Manual entry', asOf: last, days: last ? calDays(last, now) : null, cadence: 'each HK session',
      state: !last ? 'missing' : sbStale(last, nowIso) ? 'stale' : 'fresh', rule: 'when stale the card falls back to the A/H premium alone', effect: 'Southbound card (Asia)',
      where: 'Overview · Southbound panel' }));
  }
  {
    const iv = manual?.intervention || null;
    const active = !!(iv && (iv.active || iv.grade));
    rows.push(row({ key: 'intervention', label: 'FX intervention flag', group: 'Manual entry', asOf: iv?.since ?? null, days: iv?.since ? calDays(iv.since, now) : null, cadence: 'event-driven',
      state: active ? 'fresh' : 'retired', rule: 'clears itself on any of three conditions, or by hand', effect: 'FX contamination read on the Overview',
      where: 'Overview · intervention toggle', note: active ? `set since ${iv.since ?? '—'}` : 'not set — nothing to keep' }));
  }
  for (const [k, o] of Object.entries(manual?.recession || {})) {
    if (!o || o.probability == null || o.probability === '') continue;
    const d = o.asOf ? calDays(o.asOf, now) : null;
    rows.push(row({ key: `override:${k}`, label: `Recession override — ${k}`, group: 'Manual entry', asOf: o.asOf ?? null, days: d, cadence: 'while the house view stands (180-day decay)',
      state: d == null ? 'undated' : d >= 180 ? 'stale' : d > 90 ? 'due' : 'fresh',
      rule: 'outranks the live feed; its weight decays linearly to zero at 180 days', effect: 'regime engine consensus', where: 'Macro · Recession sources · entry panel' }));
  }

  // ── Dated constants in the dashboard source ──
  const cv = consts.consensusVintage || null;
  if (cv) rows.push(row({ key: 'consensus', label: 'Consensus inputs (recession table vintage)', group: 'Source constants', asOf: cv.asOf ?? null, days: cv.asOf ? calDays(cv.asOf, now) : null, cadence: 'quarterly, after each SEP round',
    state: cv.refreshDue ? 'due' : 'fresh', rule: 'when the refresh is due the regime is graded DECAYED: the sizer takes a haircut and the action card stops arguing on it',
    effect: 'regime, sizing, action card, header', where: 'lib/regimeEngine.js · RECESSION_SOURCES and CONSENSUS_VINTAGE_BASE · docs/recession-board.md', note: cv.dueNote ?? null }));
  for (const src of consts.recessionSources || []) {
    if (!src?.asOf || src.source === 'auto' || src.source === 'manual') continue;
    const cadence = consts.recessionCadence?.[src.name] ?? 90;
    const d = calDays(src.asOf, now);
    rows.push(row({ key: `src:${src.name}`, label: `Recession source — ${src.name}${src.year === 2027 ? ' (2027)' : ''}`, group: 'Source constants', asOf: src.asOf, days: d, cadence: `${cadence} days`,
      state: d >= 180 ? 'stale' : d > cadence ? 'due' : 'fresh', rule: 'weight decays linearly to zero at 180 days; past its cadence it is flagged overdue',
      effect: 'regime engine consensus', where: 'lib/regimeEngine.js · RECESSION_SOURCES, or an override in the entry panel' }));
  }
  const dated = (key, label, asOf, cadence, rule, effect, where) => {
    const d = asOf ? calDays(asOf, now) : null;
    rows.push(row({ key, label, group: 'Source constants', asOf, days: d, cadence: `${cadence} days`, state: asOf == null ? 'undated' : d > cadence ? 'due' : 'fresh', rule, effect, where }));
  };
  if (consts.fedLanguage) dated('fedLanguage', 'Fed language status', consts.fedLanguage.lastUpdated, 49, 'badge only — the stance keeps rendering', 'Fed chip on every tab, analyst-board hawkishness', 'src/App.jsx · FED_LANGUAGE_STATUS');
  if (consts.sepOdds) dated('sepOdds', 'September hike odds', consts.sepOdds.asOf, 7, 'badge only — the figure keeps rendering', 'analyst-view conditions', 'src/App.jsx · SEP_HIKE_ODDS');
  if (consts.analystBoard) dated('analystBoard', 'Analyst view board', consts.analystBoard.asOf, consts.analystBoard.cadence ?? 90, 'badge only — conditions are evaluated live, the theses are not', 'analyst board, divergence read', 'lib/analystViews.js · ANALYST_VIEWS');
  if (consts.recessionProse) dated('recessionProse', 'Recession read (prose)', consts.recessionProse.asOf, consts.recessionProse.cadence ?? 30, 'badge only', 'Macro · recession section', 'src/App.jsx');

  // ── Announced prints — retire themselves when FRED catches up ──
  for (const [k, a] of Object.entries(consts.announced || {})) {
    if (!a) continue;
    const live = a.fredAsOf ?? null;
    const retired = !!(live && String(live) >= a.period);
    rows.push(row({ key: `announced:${k}`, label: `Announced print — ${a.label}`, group: 'Overlays', asOf: a.released ?? null, days: a.released ? calDays(a.released, now) : null, cadence: 'until FRED carries it',
      state: retired ? 'retired' : 'fresh', rule: 'auto-retires the moment the live series reaches the period', effect: 'regime context, labour panels',
      where: 'lib/regimeEngine.js · ANNOUNCED_PRINTS / LABOR_ANNOUNCED', note: retired ? `retired — FRED carries ${live}` : `in use — FRED still at ${live ?? 'unknown'}` }));
  }

  // ── Data files ──
  if (files.holidaysThrough) {
    const left = -calDays(files.holidaysThrough, now);
    rows.push(row({ key: 'holidays', label: 'Exchange holiday calendar', group: 'Data files', asOf: files.holidaysThrough, days: left, cadence: 'annual top-up',
      state: left < 60 ? 'due' : 'fresh', rule: 'a missing date falls back to a normal session — closures then look like live sessions and the countdown breaks',
      effect: 'session state, freshness labels, pre-read timing', where: 'data/holidays.json', note: `covers through ${files.holidaysThrough} (${left} days)` }));
  }
  // Either the counted form or the raw events; the count is taken here so the dashboard does not
  // have to read the clock in render.
  let calendar = files.calendar || null;
  if (!calendar && Array.isArray(files.calendarEvents)) {
    const in14 = new Date(now.getTime() + 14 * 864e5).toISOString().slice(0, 10);
    const evs = files.calendarEvents;
    calendar = { upcoming14: evs.filter(e => e?.date >= nowIso && e?.date <= in14).length, lastDate: evs.map(e => e?.date).filter(Boolean).sort().at(-1) ?? null };
  }
  if (calendar) {
    const { upcoming14 = 0, lastDate = null } = calendar;
    rows.push(row({ key: 'calendar', label: 'Macro / earnings / auction calendar', group: 'Data files', asOf: lastDate, days: lastDate ? -calDays(lastDate, now) : null, cadence: 'ongoing',
      state: upcoming14 === 0 ? 'due' : 'fresh', rule: 'silent — an empty week reads as "nothing scheduled"', effect: 'week highlights, the stance card NEXT row, catalyst list',
      where: 'data/calendar.json', note: `${upcoming14} events in the next 14 days · last entered ${lastDate ?? '—'}` }));
  }
  rows.push(row({ key: 'tables', label: 'Allocation and ranking tables', group: 'Judgement', cadence: 'on conviction change', state: 'undated',
    rule: 'none — no date, no expiry', effect: 'Posture, Insurance and Income tabs', where: 'src/App.jsx · POSTURE_ALLOCATIONS, ASSETS, INCOME_PLAYS' }));

  rows.sort((a, b) => (RANK[a.state] - RANK[b.state]) || ((b.days ?? -1) - (a.days ?? -1)));
  const counts = Object.fromEntries(LEDGER_STATES.map(s => [s, rows.filter(r => r.state === s).length]));
  return { rows, counts, asOf: nowIso };
}
