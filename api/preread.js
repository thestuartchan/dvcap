// /api/preread?region=asia|eu|us
// Assembles live data + deterministic regime + the COMPOSED read (lib/read.js), formats
// Discord-ready (no tables, bullets, bold), optionally posts to the webhook.
// There is no model call anywhere in this path — every figure traces to a parsed field.

import { UNIVERSE } from '../data/universe.js';
import { assembleRegion } from '../lib/assemble.js';
import { weekHighlights } from '../lib/calendar.js';
import { marketState, localHour, localMinutesOfDay, localDateIn, isWeekendIn, localWeekday, closedExchanges, halfDayLabels, freshness, freshnessText, sessionCloseMin, sessionCountdown } from '../lib/sessions.js';
import { kvGetJson, kvSetJson, kvConfigured } from '../lib/kv.js';
import { coreSpread } from '../lib/inflation.js';

// One key, one small object per region. A skipped brief left NO trace anywhere — the only detector
// was a human noticing an absence in a Discord channel, which is how this morning's was found.
const PREREAD_LAST_KEY = 'dvcap:preread:last:v1';
import { kofiaStoredLine, koreaFlowRead, koreaFlowImplication } from '../lib/kofia.js';
import KOFIA_STORE from '../data/korea_kofia.json' with { type: 'json' };
import { readGex, repriceStored, GEX_SYMBOLS } from '../lib/gexStore.js';
import { renderGexSection, pinOf } from '../lib/gexBrief.js';
import { watchlist, renderWatchlist } from '../lib/watchlist.js';
import { WATCH_UNIVERSE } from '../data/watchUniverse.js';
import {
  clockSection, overnightSection, breadthNote, backdropSection, changeSection,
  compressLine, creditLine, ratesLine, oilLine, volLine, plainTripwire, pctWord, clockIn, sinceSection,
} from '../lib/briefSections.js';


function fmtPct(p) { return p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`; }

// Pre-read cron timing. The crons (vercel.json) fire LEAD minutes before each region's target
// local hour so the assemble+post runtime lands the brief on time instead of a few minutes
// late. WINDOW is the half-open accept span [target-lead, target-lead+WINDOW); keep it < 60 so
// the two DST candidate crons (60min apart in local time) can never both pass. See the gate
// in the handler. Firing at target-15 with a 55-min window delivers ~on-time and tolerates
// roughly 40min of positive cron jitter before a run would fall out of the window.
const PREREAD_LEAD_MIN   = 15;

// ── THE WINDOW IS A DEADLINE NOW, NOT A DURATION ─────────────────────────────
// It used to be a fixed 55 minutes, chosen so the two DST candidate crons (exactly 60 local
// minutes apart) could never both pass. The same-day dedupe removed that constraint: a second
// firing in one window is now a no-op that says so, so the span is free to describe something
// real instead.
//
// And it has to, because the old one measured the wrong thing. A brief is useful until the market
// it is about opens; 55 minutes is a number with no relationship to that. Measured 2026-09-03:
// the only run GitHub delivered all day arrived at 08:02 HKT and was refused for being 22 minutes
// outside a window that had closed at 07:40 — while Hong Kong itself was still 88 minutes from
// opening. Each region now carries `prereadDeadlineLocal` in data/universe.js with the reason it
// is where it is: Korea/Japan's open for Asia, an hour into the session for Europe, the NYSE open
// for the US.
//
// FALLBACK. A region without a deadline keeps the old 55, so this cannot silently widen anything
// that was not given a considered figure.
const PREREAD_WINDOW_MIN = 55;
// GRACE: how far BEFORE the window opens a firing is still accepted. Five minutes of lead-in
// costs nothing, and the alternative was losing a whole day to a cron a minute early or to clock
// skew between the scheduler and this container's Intl evaluation — a dropped brief that recorded
// nothing at all.
const PREREAD_GRACE_MIN  = 5;

export function prereadWindow(nowMin, targetHour, { lead = PREREAD_LEAD_MIN, window = PREREAD_WINDOW_MIN, grace = PREREAD_GRACE_MIN, deadlineMin = null } = {}) {
  const open = targetHour * 60 - lead - grace;
  // The deadline wins where a region states one, but never SHRINKS the window below the old
  // behaviour — a region whose deadline sits inside the legacy span would otherwise start
  // refusing firings it used to accept, which is a regression wearing the clothes of a fix.
  const close = Math.max(open + grace + window, Number.isFinite(deadlineMin) ? deadlineMin : 0);
  const sinceOpen = nowMin - open;
  return {
    accept: nowMin >= open && nowMin < close,
    open, close, sinceOpen,
    // How late against the TARGET, which is what the reader cares about — not against the window,
    // which is an implementation detail. Negative means early.
    lateMin: nowMin - targetHour * 60,
  };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// A countdown is a fact about a VENUE, not about whichever index this brief happens to quote, so
// the clock rows are named for the city. Keyed by the exchange's own timezone because that is
// what sessionCountdown returns and what makes two indices on one exchange collapse to one row.
const CITY = {
  'Asia/Hong_Kong': 'Hong Kong', 'Asia/Seoul': 'Seoul', 'Asia/Tokyo': 'Tokyo', 'Asia/Taipei': 'Taipei',
  'Europe/London': 'London', 'Europe/Paris': 'Amsterdam/Paris', 'Europe/Berlin': 'Frankfurt',
  'America/New_York': 'New York',
};

// A wall-clock time in a named zone → the UTC instant, DST included. Done by probing rather than
// by an offset table: format a candidate instant back into the zone and correct by the difference,
// which is exact for every offset the IANA database defines and needs no dependency.
export function zonedToUtc(dateStr, hh, mm, tz) {
  try {
    const guess = Date.UTC(...dateStr.split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v), hh, mm);
    const seen = new Date(guess).toLocaleString('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const [d, t] = seen.split(', ');
    const [mo, da, yr] = d.split('/').map(Number);
    const [sh, sm] = t.split(':').map(Number);
    return guess + (guess - Date.UTC(yr, mo - 1, da, sh % 24, sm));
  } catch { return null; }
}

// Honest freshness label, keyed off the MARKET's state — not a blunt stale flag.
//   market closed (pre/post/weekend) → "· prior close"  (expected; the pre-market case)
//   market in lunch                  → "· lunch"         (mid-session, price frozen)
//   market open + feed lagging       → "⏱Nm delayed"     (keyless Yahoo runs ~15m behind)
//   market open + fresh              → ""                 (live)
//   no price                         → "⚠️no print"
// `now` is threaded rather than defaulted. freshness() falls back to Date.now(), which made the
// golden brief only PARTLY deterministic: CLOCK's countdowns were pinned and the per-quote
// freshness labels were not, so a fixture rendered an hour later produced different tails and the
// golden drifted on its own. A golden that changes without a code change is worse than no golden —
// it teaches a reader to bless the diff without reading it.
function freshLabel(sym, q, now = Date.now()) {
  const t = freshnessText(freshness(sym, q, now));
  return t ? ` · ${t}` : '';   // live → no suffix
}

// Pick the price/%chg/label to display. US pre/post-market override: when the US
// market is SHUT but a FRESH extended-hours print exists, show it (labeled · pre-mkt /
// · post) instead of the stale prior regular close — that's the live gap at the 09:00
// ET fire. Everywhere else, the regular print + market-state freshness label.
function displayQuote(q, region, now = new Date()) {
  if (region === 'us' && marketState(q.sym, now) === 'closed' && q.ext && !q.ext.stale) {
    const sess = localHour('America/New_York', now) < 12 ? 'pre-mkt' : 'post';
    return { price: q.ext.price, changePct: q.ext.changePct, tail: ` · ${sess}` };
  }
  return { price: q.price, changePct: q.changePct, tail: freshLabel(q.sym, q, now.getTime()) };
}

export function buildBlocks(region, quotes, indices, macro, regime, cal, cross, sox, opts = {}) {
  const { leaning = null, composed = null, foreign = {}, prevSnap = null, now = new Date() } = opts;
  const R = UNIVERSE[region];
  const names = R.names;

  // Line shape: bold ticker anchors the eye, then price, %chg, structure, leader ⭐,
  // freshness. `·` separators keep it scannable (Discord collapses runs of spaces).
  // ONE SHARED LABEL, ONCE. Before the open every line carries the same freshness tail — fifteen
  // repetitions of "· prior close" on a brief that fires two hours before the market opens, which
  // is a fact about the hour rather than about any name. When every quoted line agrees, the tail is
  // lifted into the header; the moment they diverge (one exchange open, another shut, a delayed
  // feed) it drops back onto the lines, because then it IS per-name information.
  const nameQ = quotes.map((q, i) => ({ q, m: names[i], d: displayQuote(q, region, now) }));
  const idxQ  = indices.map(q => ({ q, d: displayQuote(q, region, now) }));
  const tails = [...nameQ, ...idxQ].map(x => x.d.tail);
  const sharedTail = (tails.length && tails.every(t => t === tails[0]) && tails[0]) ? tails[0] : null;

  // nameLines / idxLines used to render one quote per line here — fifteen lines for the names
  // and four for the indices. BACKDROP compresses both (lib/briefSections.js, compressLine), so
  // only the nameQ/idxQ rows and the shared freshness label survive; the per-line rendering does
  // not. `tailOf` goes with them: with the quotes compressed there is no per-line tail to hang.

  // ── OVERNIGHT US ───────────────────────────────────────────────────────────
  // The Asia brief fires at 06:45 HKT — 18:45 ET, nearly three hours after the US close — and the
  // single most predictive input for the Asia open was nowhere on it. SOX especially: this book is
  // semis-heavy and the overnight SOX print is what the Korean and Taiwanese names gap to. All of
  // it was already fetched and simply never rendered. Not shown for the US brief, where the same
  // numbers are the session about to start rather than a handoff into it.
  // A move smaller than half a tenth is not a direction, and "-0.0%" is a worse way of saying so
  // than the word is.
  // Cross-asset rows carry `price`, not `value` — reading the wrong one dropped VIX from the block
  // silently, which is the same shape of bug as every other field-name miss this week.
  const crossRow = (group, name) => (cross?.[group]?.rows || []).find(r => r.name === name) || null;
  // The old OVERNIGHT builder stood here and was suppressed for the US brief entirely. Its
  // replacement is region-aware and lives with the other five sections at the foot of this
  // function, so the US reader stops being the only one with no answer to "what already happened".

  // macroLines carried oil, the two yields, the credit spread and the inflation gap as one
  // four-line block of labels and numbers. Each is now its own named line in BACKDROP with the
  // gauge described rather than abbreviated — see ratesLine / creditLine / oilLine / volLine.

  const koreaLines = buildKorea(regime.korea);

  // regimeLines restated the credit state, the oil label and the Korea cluster that MACRO and
  // KOREA STRESS had already printed a few lines above. The two classifications that were NOT
  // restatements — the foundry/memory split and the AI axis — moved into BACKDROP; the rest was
  // the third telling of the same fact and is gone.

  // WHEN, not just WHAT — AND ALWAYS IN GMT. "Fri 08-28 · US July PCE" does not say whether it
  // lands inside your session or hours after it closes, and that is most of what the line is for.
  //
  // ONE CLOCK FOR THE WHOLE BRIEF. Every time shown anywhere is Z, matching the header, so a brief
  // read from Hong Kong and one read from London describe the same instant with the same number.
  // Rendering each region's local hour instead would mean the Asia and EU briefs quoted different
  // times for the same release, which is precisely the ambiguity a shared clock removes.
  //
  // STORED IN ITS NATIVE CLOCK, THOUGH. `time` alone is read as UTC; `time` + `tz` is read in that
  // zone. That is not inconsistency, it is what keeps the data from rotting: a US release is
  // anchored to 08:30 ET, which is 12:30Z in summer and 13:30Z in winter, so storing the UTC value
  // would be wrong for half of every year and would need editing twice annually. The conversion
  // happens here, once, against the event's real date.
  //
  // An entry with no time claims nothing. Inferring a release hour from a title is how a brief
  // starts inventing facts.
  // Measured against the region's PRIMARY exchange — the one its first index trades on, which is
  // also the latest close in each region (HK 16:00 outlasts Seoul and Tokyo; NYSE and LSE speak
  // for their own). So "after your close" means after the last thing in this brief stops trading.
  const primary = sessionCloseMin(R.indices?.[0]?.sym || '');
  const whenTag = (e) => {
    if (!e.time) return '';
    const [hh, mm] = String(e.time).split(':').map(Number);
    if (!Number.isFinite(hh)) return '';
    const utc = e.tz ? zonedToUtc(e.date, hh, mm || 0, e.tz)
                     : Date.UTC(...e.date.split('-').map(Number).map((v, i) => i === 1 ? v - 1 : v), hh, mm || 0);
    if (utc == null) return '';
    const z = new Date(utc).toISOString().slice(11, 16);
    // The session comparison still happens in the exchange's own clock — that is the only place a
    // local time means anything — but the number the reader sees stays Z.
    if (!primary) return ` _(${z}Z)_`;
    const local = new Date(utc).toLocaleString('en-GB', { timeZone: primary.tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const [lh, lm] = local.split(':').map(Number);
    const after = (lh * 60 + lm) > primary.closeMin;
    return ` _(${z}Z${after ? ', after your close' : ''})_`;
  };
  // calLines rendered ten days of events in one undifferentiated list ordered by date, so a
  // release landing inside the session about to start sat wherever the calendar happened to put
  // it. CLOCK splits them: what lands today, then what is ahead. `whenTag` is still the source of
  // the time and the after-your-close test, and is read from there.

  // Half-day heads-up: a region can span several exchanges, so flag whichever are on an
  // early-close session today (the Pre-Read fires pre-open, so this is a forward warning).
  const halfEx = halfDayLabels([...quotes.map(q => q.sym), ...indices.map(q => q.sym)]);
  const halfDayNote = halfEx.length
    ? `🕐 **HALF DAY** — ${halfEx.join(', ')} ${halfEx.length === 1 ? 'closes' : 'close'} early today`
    : null;


  // ══ THE SIX SECTIONS ═══════════════════════════════════════════════════════
  // Everything above builds the raw material. What follows arranges it into the six sections the
  // brief actually ships, in lib/briefSections.js's voice. The blocks above are kept because
  // several of them (calLines, the freshness machinery, the Korea bundle) are still the source of
  // truth for what goes into these — the change is what the reader is shown, not what is measured.

  // ── 🕐 CLOCK ───────────────────────────────────────────────────────────────
  // Which of this region's markets are open, when the rest of them open, when the US opens in the
  // reader's own clock, and what lands today as distinct from what lands this week.
  const clockLines = (() => {
    // One row per DISTINCT exchange in the region, named for the city rather than the index — a
    // countdown is a fact about a venue, and "Hong Kong opens in 1h 36m" survives a change to
    // which index this brief happens to quote.
    const seen = new Set(), markets = [];
    for (const i of (R.indices || [])) {
      const cd = sessionCountdown(i.sym, now);
      const key = cd.tz || i.sym;
      if (seen.has(key)) continue;
      seen.add(key);
      markets.push({ name: CITY[key] || i.name, ...cd });
    }
    // The US clock, for everyone. For the US brief this IS the region row above, so it is not
    // repeated; for the other two it is the question the old brief never answered in any form.
    let usOpen = null;
    if (region !== 'us') {
      const cd = sessionCountdown('QQQ', now);
      // Rendered in the READER'S zone, not New York's — the whole point is to remove the
      // conversion, and quoting 09:30 ET puts it straight back.
      const openAt = cd.toOpen != null ? new Date(now.getTime() + cd.toOpen * 60000) : null;
      usOpen = { ...cd, localTime: openAt ? clockIn(R.tz, openAt) : null };
    }

    const todayLocal = localDateIn(R.tz, now);
    // TITLES ARE WRITTEN FOR A CALENDAR, NOT FOR A LINE. data/events carries editorial tails —
    // "US CPI (Aug) — the print the Fed path trades off" — which are useful in a ten-day list and
    // are three quarters of the width here, where four of them share one line. The tail is cut at
    // the em-dash and the parenthetical kept, because "(Aug)" distinguishes two prints of the same
    // series and the sentence after the dash does not distinguish anything.
    const short = (t) => String(t).split(' — ')[0].trim();
    const calText = (e) => {
      const tag = whenTag(e).replace(/^ _\(/, '').replace(/\)_$/, '');
      return `${short(e.title)}${tag ? ` _(${tag})_` : ''}`;
    };
    const todayEv = cal.filter(e => e.date === todayLocal && !e.reported).map(calText);
    const aheadEv = cal.filter(e => e.date > todayLocal && !e.reported).slice(0, 3)
      .map(e => `**${DOW[new Date(e.date + 'T00:00:00Z').getUTCDay()]}** ${short(e.title)}`);
    return clockSection({ markets, usOpen, halfDayNote, today: todayEv, ahead: aheadEv });
  })();

  // ── 🌙 OVERNIGHT ───────────────────────────────────────────────────────────
  // For Asia and Europe: the US tape they are reacting to. For the US: Asia and Europe, which the
  // old brief suppressed entirely — leaving the US reader the only one of the three with no answer
  // to "what already happened", while Asia had finished and Europe was two hours in.
  const overnight = (() => {
    if (region === 'us') {
      // The other two regions' indices, quoted through the same batch the watchlist uses. Asia has
      // closed by the 09:00 ET fire; Europe is mid-session, and its rows say so by being live.
      const rows = [];
      for (const key of ['asia', 'eu']) {
        for (const i of (UNIVERSE[key].indices || [])) {
          const f = foreign[i.sym];
          if (f?.changePercent != null) rows.push({ name: i.name, changePct: +f.changePercent, key });
        }
      }
      if (!rows.length) return null;
      const grp = (k, emoji, word) => {
        const r = rows.filter(x => x.key === k);
        if (!r.length) return null;
        return `${emoji} **${word}** — ${r.map(x => `${x.name} ${pctWord(x.changePct)}`).join(' · ')}`;
      };
      // ONE LINE EACH. Joined with the section's usual ' · ' they ran together into a single
      // 140-character line in which the boundary between the two continents was a middot.
      const legs = [grp('asia', '🌏', 'Asia'), grp('eu', '🇪🇺', 'Europe')].filter(Boolean);
      // The lead is the SHAPE of the two together: agreeing is one piece of information and
      // disagreeing is a different one, and neither is deducible from six percentages in a row.
      // A REGION THAT DISAGREES WITH ITSELF IS NOT "FLAT". Averaging Hong Kong −0.5, Korea +1.4 and
      // Japan 0.0 gives +0.02, which under a threshold test reads as no move at all — and the same
      // day Europe was down 1.5% across every index it quotes. The reading was suppressed on the
      // one morning it had something to say. So each region is classified by whether its own
      // indices AGREE, and only then compared with the other.
      const dir = (k) => {
        const r = rows.filter(x => x.key === k && Math.abs(x.changePct) >= 0.15);
        const all = rows.filter(x => x.key === k);
        if (!all.length) return null;
        if (!r.length) return 0;                                   // genuinely quiet
        const up = r.filter(x => x.changePct > 0).length;
        if (up === r.length) return 1;
        if (up === 0) return -1;
        return null;                                               // internally split
      };
      const a = dir('asia'), e = dir('eu');
      const word = (v) => v > 0 ? 'higher' : v < 0 ? 'lower' : 'flat';
      let lead = null;
      if (a != null && e != null && a === e && a !== 0) {
        lead = `👉 Asia and Europe both finished ${word(a)} — the US opens into a one-way overnight rather than a split one.`;
      } else if (a != null && e != null && a !== e && a !== 0 && e !== 0) {
        lead = `👉 Asia finished ${word(a)} and Europe ${word(e)}, so there is no single overnight direction to carry into the open.`;
      } else if (a === null && e != null && e !== 0) {
        lead = `👉 Asia's markets disagreed with each other while Europe moved ${word(e)} together — the cleaner signal into the open is the European one.`;
      } else if (e === null && a != null && a !== 0) {
        lead = `👉 Europe's markets disagreed with each other while Asia moved ${word(a)} together — the cleaner signal into the open is the Asian one.`;
      }
      return overnightSection({ lines: legs, lead });
    }
    if (!cross) return null;
    const soxPct = sox?.changePct ?? null;
    const spy = crossRow('breadth', 'SPY');
    const legs = [
      soxPct != null ? `📉 **Chips** SOX ${pctWord(soxPct)}` : null,
      ...['SMH', 'QQQ', 'SPY'].map(n => { const r = crossRow('breadth', n); return r?.changePct != null ? `**${n}** ${pctWord(r.changePct)}` : null; }),
    ].filter(Boolean);
    const vix = crossRow('volCredit', 'VIX'), hyg = crossRow('volCredit', 'HYG');
    const risk = [
      vix?.price != null ? `😰 **VIX** ${vix.price}${vix.changePct != null ? ` ${pctWord(vix.changePct)}` : ''}` : null,
      // NAMED FOR THE INSTRUMENT. "junk bonds -0.2%" is the ETF's PRICE and reads like the credit
      // spread, which is the other credit number in this brief and is quoted in percentage POINTS
      // at a level rather than as a daily change. Two different instruments, neither labelled, four
      // sections apart.
      hyg?.changePct != null ? `**junk-bond ETF (HYG)** ${pctWord(hyg.changePct)}` : null,
    ].filter(Boolean);
    if (!legs.length && !risk.length) return null;
    const note = breadthNote(soxPct, spy?.changePct ?? null, { narrow: 'chips', broad: 'the broad market' });
    return overnightSection({ legs, risk, lead: note ? `👉 ${note}` : null });
  })();

  // ── 🌡️ BACKDROP ────────────────────────────────────────────────────────────
  // NAMES, INDICES, MACRO, KOREA STRESS and REGIME were five headings carrying about six facts
  // between them, one quote per line. Compressed here, biggest movers first, with each slow gauge
  // named for what it measures rather than for its ticker.
  const backdropLines = (() => {
    const out = [];
    const nameRow = nameQ.map(({ m, d }) => ({ name: m.name, changePct: d.changePct }));
    // VIX IS NOT AN INDEX HERE. It sits in the US region's `indices` list, so it was rendered
    // among QQQ/SOXX/SMH as a percentage change — and then again, four lines down, as the Fear
    // gauge with its level and its band. Twice in one section, in two vocabularies.
    const idxRow  = idxQ.filter(({ q }) => q.sym !== '^VIX').map(({ q, d }) => ({ name: q._name, changePct: d.changePct }));
    const nl = compressLine(nameRow), il = compressLine(idxRow, { max: 4 });
    const when = sharedTail ? ` _(${sharedTail.replace(/^ · /, '')})_` : '';
    if (il) out.push(`📈 **Indices:**${when} ${il}`);
    if (nl) out.push(`📋 **Names:**${sharedTail ? '' : ''} ${nl}`);
    // The sector cut, only where it was computed. Europe's names carry no memory tag, so this
    // rendered two em-dashes and an abbreviation on every EU brief.
    if (!regime.staleWhileOpen && regime.split.label !== 'n/a') {
      // THE LABEL IS RELATIVE AND THE NUMBERS ARE ABSOLUTE, and printing them side by side made
      // the line contradict itself: "foundry +0.4% vs memory +2.8% — foundry-specific weakness"
      // says weakness about a group that rose. The comparison is derived from the two figures
      // instead, which is what the label was reaching for and cannot be read as a claim about
      // either group's own direction.
      const f = regime.split.fnd, mem = regime.split.mem;
      const gap = (f != null && mem != null) ? f - mem : null;
      const rel = gap == null ? null
        : Math.abs(gap) < 0.5 ? 'the two moved together'
        : gap > 0 ? 'foundry ahead of memory' : 'memory ahead of foundry';
      out.push(`🔬 **Inside chips:** foundry ${pctWord(f) ?? '—'} vs memory ${pctWord(mem) ?? '—'}${rel ? ` — ${rel}` : ''}`);
    }
    if (!regime.staleWhileOpen && regime.aiAxis.label && regime.aiAxis.label !== 'n/a') {
      out.push(`🤖 **AI vs the rest:** ${pctWord(regime.aiAxis.ai) ?? '—'} vs ${pctWord(regime.aiAxis.non) ?? '—'} — ${regime.aiAxis.label}`);
    }
    if (regime.staleWhileOpen) out.push('⚠️ **Equity prints are stale** — the market is open but these are prior closes, so the sector cuts are suppressed');
    out.push(ratesLine({ us2y: macro.us2y?.value, us10y: macro.us10y?.value, us30y: macro.us30y?.value }));
    out.push(creditLine({
      oas: macro.oas?.value, date: macro.oas?.date, state: regime.credit.state,
      stale: composed?.structured?.rows?.find(r => r.label === 'CREDIT')?.stale ?? false,
      hygPct: crossRow('volCredit', 'HYG')?.changePct ?? null,
    }));
    out.push(oilLine({ wti: macro.wti?.price, brent: macro.brent?.price, above: regime.oil.above, stale: macro.wti?.stale }));
    // ONCE PER BRIEF. For Asia and Europe the VIX is part of the US handoff and OVERNIGHT already
    // carries it; printing it again here put the same number, to the same two decimals, in two
    // sections of one message. The US brief has no US handoff, so this is its only rendering.
    if (region === 'us') {
      const vixRow = crossRow('volCredit', 'VIX');
      out.push(volLine({ vix: vixRow?.price, changePct: vixRow?.changePct, band: vixRow?.benchmark?.band }));
    }
    // The inflation gap, only when it is saying something — see the note on coreSpread above.
    const sp = coreSpread(macro.corePce?.value, macro.coreCpi?.value);
    // BACKWARDS AS SHIPPED. `divergent` in lib/inflation.js means core PCE is ABOVE core CPI and
    // still elevated — core CPI looks like the job is done and the series the Fed actually targets
    // says it is not. The line read "the one it targets is the lower of the two", which is the
    // reassuring reading of the alarming case, and it went out on the live Asia brief at 00:24Z
    // over PCE 3.34% against CPI 2.47%.
    if (sp?.divergent) {
      out.push(`🌡️ **Inflation:** the headline-style measure reads **${sp.cpi}%**, but the gauge the Fed actually targets is **higher at ${sp.pce}%**`
        + ` — the cooler of the two is not the one policy is set against`);
    }
    // Korea keeps its own line rather than its own section: one gate, one sentence.
    if (koreaLines && regime.korea) {
      const k = regime.korea;
      const won = k.won?.level != null ? `won at **${k.won.level}**` : 'no won print';
      const vol = k.vol?.level != null ? ` · Korean fear gauge **${k.vol.level}**${k.vol.band && k.vol.band !== 'n/a' ? ` (${String(k.vol.band).toLowerCase()})` : ''}` : '';
      // ONE STATE LINE, ONE IMPLICATION. Rendering k.cluster AND k.note AND the flow implication
      // gave Korea three lines and two 👉 markers, and the tail of k.note ("won flat (+1.64 1d),
      // VKOSPI HIGH rolling over (−3.36% 1d)") restated in gauge shorthand the two numbers already
      // printed at the head of this very line. The state joins the data; only the flow reading —
      // which is the part not deducible from the figures shown — gets the implication marker.
      const state = String(k.note || '').split(' — ')[0].trim() || k.cluster || null;
      out.push(`🇰🇷 **Korea:** ${won}${vol}${state ? ` — ${state}` : ''}`);
      const impl = koreaFlowImplication(KOFIA_STORE.latest || {});
      if (impl) out.push(`👉 ${impl}`);
    }
    return backdropSection(out);
  })();

  // ── 🔀 WHAT WOULD CHANGE IT ────────────────────────────────────────────────
  // composed.leaning, not the raw one — see the note on its return in lib/read.js. A US brief must
  // not carry a Korean flow gauge among its own tripwires.
  const changeLines = changeSection({
    items: ((composed?.leaning || leaning)?.items || []).map(plainTripwire).filter(Boolean),
    flipsIf: composed?.structured?.flipsIf || null,
    lead: composed?.structured?.lead || null,
  });

  // ── 🔄 SINCE YESTERDAY ─────────────────────────────────────────────────────
  // The slow gauges only, and only when one of them actually moved. The snapshot is built here
  // from the same values the sections above rendered, so the delta can never describe a figure the
  // brief did not show.
  const vixNow = crossRow('volCredit', 'VIX');
  const snap = {
    oas: macro.oas?.value ?? null,
    vix: vixNow?.price ?? null,
    krw: regime.korea?.won?.level ?? null,
    wti: macro.wti?.price ?? null,
    wires: Object.fromEntries(((composed?.leaning || leaning)?.items || [])
      .filter(i => i?.name && i.tripped != null)
      .map(i => [plainTripwire(i)?.name || i.name, !!i.tripped])),
  };
  const sinceLines = sinceSection(snap, prevSnap);

  return { clockLines, overnightLines: overnight, backdropLines, changeLines, halfDayNote, snap, sinceLines };
}

// Korea-stress cluster block (Asia only). null when there's no Korea gate.
function buildKorea(k) {
  if (!k) return null;
  const { won, vol } = k;
  const wonLine = won.level != null
    ? `• **USD/KRW** ${won.level}${won.dir !== 'n/a' ? ` (${won.dir})` : ''} · ${won.flag}`
    : '• **USD/KRW** — no print';
  // VKOSPI here is the FUTURES (V-KOSPI, KRX:VKI1! via TradingView) — the tradeable
  // contract, not the spot index. Labeled "fut" for precision.
  const volLine = vol.level != null
    ? `• **VKOSPI fut** ${vol.level}${vol.band !== 'n/a' ? ` [${vol.band}]` : ''}${vol.changePct != null ? ` ${fmtPct(vol.changePct)}` : ''} · ${vol.flag}`
    : '• **VKOSPI fut** — no print';
  // KOFIA manual-entry gate: margin loans (신용융자) — the deleveraging tell that replaced
  // 7709 — plus investor cash and KR 3Y yields. Latest from data/korea_kofia.json (server).
  const kf = KOFIA_STORE.latest || {};
  const kfLine = (key, label) => { const s = kofiaStoredLine(key, kf[key]); return s ? `• **${label}** ${s}` : null; };
  const yields = (kf.kr3yGovt || kf.kr3yCorp)
    ? `• **KR 3Y** ${kf.kr3yGovt ? `govt ${kf.kr3yGovt.value}%` : ''}${kf.kr3yGovt && kf.kr3yCorp ? ' · ' : ''}${kf.kr3yCorp ? `corp ${kf.kr3yCorp.value}%` : ''}${kf.kr3yGovt?.asOf ? ` · ${kf.kr3yGovt.asOf.slice(5)}` : ''}`
    : null;
  const kofiaLines = [
    kfLine('marginLoans', 'Margin Loans'),
    kfLine('deposits', 'Deposits'),
    kfLine('cma', 'CMA'),
    yields,
    kfLine('foreignNet', 'Foreign Net'),
    kfLine('instNet', 'Inst Net'),
    kfLine('retailNet', 'Retail Net'),
    kfLine('units7709', '7709 units'),
  ].filter(Boolean);
  // Flow read + macro implication (same logic as the dashboard Korea panel).
  const read = koreaFlowRead(kf);
  const impl = koreaFlowImplication(kf);
  const readLines = [
    read ? `• **Read:** ${read}` : null,
    impl ? `• **Implication:** ${impl}` : null,
  ].filter(Boolean);
  return [wonLine, volLine, ...kofiaLines, `• **Cluster:** ${k.cluster} — ${k.note}`, ...readLines].join('\n');
}

// NOTE: the model-written READ paragraph (synthProse) was removed in Round 4 Stage 4.
// The READ is now composed deterministically in lib/read.js from the structured gate state,
// so there is no LLM call anywhere in the read path — no latency, no cost, and no chance of
// a hallucinated figure on a trading surface. Git history has the old implementation if a
// prose variant is ever wanted alongside (not instead of) the composed read.

// ── THE DAY-TRADE LAYER ──────────────────────────────────────────────────────
// Walks the cascade in lib/gexBrief.js and returns the best rung available, never throwing: a
// missing option book must cost the brief one section, not the brief.
//
// `spot` comes from the live quote where the region has one — for the US that is the pre-market
// print, which is the whole reason repricing is worth doing. Where no live spot is available the
// stored row stands as captured and says so.
async function gexBlock(liveSpot, tense = 'preview') {
  const rows = [], vint = { rung: 'none', from: null, asOf: null };
  for (const sym of GEX_SYMBOLS) {
    try {
      const stored = await readGex(sym);
      const latest = stored?.latest;
      if (!latest?.spot) continue;
      const today = new Date().toISOString().slice(0, 10);
      const expired = tense === 'closed';
      const spot = liveSpot?.(sym) ?? null;

      let row = null, rung = 'stored';
      if (spot > 0 && Math.abs(spot / latest.spot - 1) > 1e-9) {
        const rp = await repriceStored(sym, { spot });
        if (rp?.row) {
          row = { ...rp.row, pin: pinOf(rp.grid, { spot, today, expired }) };
          rung = 'repriced';
        }
      }
      if (!row) row = { ...latest, pin: pinOf(stored.grid, { spot: latest.spot, today, expired }) };

      rows.push({ name: sym, spot: row.spot, putWall: row.putWall, callWall: row.callWall,
                  flipLevel: row.flipLevel, pin: row.pin,
                  // The book's own open-interest-weighted vol, for the expected-range line. It
                  // survives repricing unchanged — repriceStored moves the spot, not the surface.
                  iv: row.oiWeightedIv ?? latest.oiWeightedIv ?? null });
      // The WORST rung across the symbols wins the label — a footer claiming the spot is live is
      // false the moment one of the two could not be repriced.
      if (vint.rung === 'none' || (vint.rung === 'repriced' && rung === 'stored')) vint.rung = rung;
      vint.from = latest.date; vint.asOf = latest.asOf;
    } catch { /* one symbol short is a smaller loss than no section */ }
  }
  if (!rows.length) return null;
  return {
    text: renderGexSection(rows, { ...vint, tense }),
    walls: Object.fromEntries(rows.map(r => [r.name, { putWall: r.putWall, callWall: r.callWall }])),
    spot: Object.fromEntries(rows.map(r => [r.name, r.spot])),
  };
}

// The snapshot from the last delivered brief, or null on a first run. Named so the two call sites
// cannot drift into reading the record differently.
const prevSnapFor = (prev) => prev?.snap || null;

export function assembleDiscord(region, label, blocks) {
  const emoji = { asia: '🌏', eu: '🇪🇺', us: '🇺🇸' }[region] || '📊';
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Each section is header + body; sections are separated by a blank line AND a thin
  // rule so they breathe (Discord collapses bare consecutive newlines, so we use an
  // explicit divider rather than relying on extra \n's).
  const RULE = '───────────────';
  const sections = [
    // ── THE ORDER IS THE ARGUMENT ──────────────────────────────────────────────
    // Levels first, because that is the surface a day trade is placed against. Then the names
    // moving against it. Then the clock that governs when. Then what already happened. Then the
    // slower conditions all of it sits inside. And last the things that would make the page wrong,
    // which is the only part still useful after the figures above have gone stale.
    //
    // GEX IS US-ONLY NOW. It is a map of the US option book, and Asia read it at 23:13 UTC against
    // a session that had closed at 20:00 with its front expiry already expired — the map described
    // a market that no longer existed. Europe reads it eight hours before the US opens, against a
    // spot it has no live print for. Both got a picture accurate to the minute about the wrong
    // minute. The US brief fires into the pre-open, which is the one time it is a preview.
    ...(region === 'us' && blocks.gexLines ? [`⚡ **TODAY'S MAP**\n${blocks.gexLines}`] : []),
    ...(blocks.watchLines ? [`👀 **TODAY'S WATCHLIST**\n${blocks.watchLines}`] : []),
    ...(blocks.clockLines ? [`🕐 **CLOCK**\n${blocks.clockLines}`] : []),
    ...(blocks.overnightLines ? [`🌙 **OVERNIGHT**\n${blocks.overnightLines}`] : []),
    // Between what happened overnight and the conditions it happened inside — a delta against the
    // last brief this region received. Absent on a day nothing slow moved, and on a first run.
    ...(blocks.sinceLines ? [`🔄 **SINCE YOUR LAST BRIEF**\n${blocks.sinceLines}`] : []),
    ...(blocks.backdropLines ? [`🌡️ **BACKDROP**\n${blocks.backdropLines}`] : []),
    ...(blocks.changeLines ? [`🔀 **WHAT WOULD CHANGE IT**\n${blocks.changeLines}`] : []),
  ];

  return [
    `${emoji} **DAILY PRE-READ · ${label} · ${now}Z**`,
    // Prominent half-day warning right under the header (only when applicable).
    ...(blocks.halfDayNote ? [blocks.halfDayNote] : []),
    ...sections.flatMap(s => [RULE, s]),
    RULE,
    `*👉 = what the arrangement is consistent with, never what to do · "prior close" = that market was shut when the price was taken*`,
  ].join('\n\n');
}

// One region, start to finish. Extracted from the handler so a single call can run all three —
// see the note on ALL MODE below — and so every exit is a value rather than a write to `res`.
async function runRegion(region, req) {
  const R = UNIVERSE[region];
  if (!R) return { status: 400, body: { error: 'bad region' } };

  // DST-safe, LEAD-TIMED cron gating. Vercel crons are UTC-only and would drift an hour
  // across daylight-saving shifts. For DST-observing regions (EU/US) we schedule the cron at
  // BOTH candidate UTC hours and gate here on the region's real local time (Intl, DST-aware),
  // so exactly one firing per day actually posts. Asia (HK/KR/TW/JP keep no DST) needs one
  // entry, but the same gate applies harmlessly.
  //
  // Why a WINDOW, not `localHour === prereadHourLocal`: the old gate could only pass once the
  // local clock had already reached the top of the target hour, so cron jitter + the
  // assemble-and-post runtime always landed the brief a few minutes AFTER the intended time.
  // The crons now fire PREREAD_LEAD_MIN before the target (see vercel.json), and we accept a
  // half-open window [target-lead, target-lead+PREREAD_WINDOW_MIN). Window < 60min so the two
  // DST candidate crons (exactly 60min apart in local time) can never both pass, while still
  // absorbing up to ~an hour of positive cron jitter. Only scheduled calls pass cron=1 —
  // manual calls/dry-runs skip the gate, so tests always run.
  // ── NO BRIEF FOR A SESSION THAT WILL NOT HAPPEN ────────────────────────────────────────────
  // The gate below decides WHEN in the day to post and whether today's brief already went out.
  // Neither asks whether there is a session at all, so a Friday-night UTC cron delivered a
  // "pre-market" read at 06:42 Saturday in Hong Kong. Asked in the REGION'S timezone, because for
  // Asia the UTC day and the local day are different days — which is the whole reason the cron's
  // own day-of-week field could not have fixed this on its own.
  //
  // This gate binds on DELIVERY, not on the cron flag: a manual ?post=1 on a Saturday is the same
  // mistake made by hand. Dry runs (no post) are never blocked, so the brief stays testable any
  // day of the week, and ?force=1 posts anyway for the deliberate exception.
  if (req.query.post === '1' && req.query.force !== '1') {
    const localDate = localDateIn(R.tz);
    const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][localWeekday(R.tz)] ?? null;
    // Every exchange the region covers, judged in ITS OWN local date — a region spans several and
    // they do not close together. One market shut out of four is content for the brief; all four
    // shut means there is no session to be ahead of.
    const shut = closedExchanges([...R.names.map(n => n.sym), ...R.indices.map(i => i.sym)]);
    if (shut.allClosed) {
      const weekend = isWeekendIn(R.tz);
      return { status: 200, body: {
        region, skipped: true, noSession: true, weekend, localDate, localWeekday: dayName,
        closedExchanges: shut.closed,
        reason: weekend
          ? `${localDate} is a weekend in ${R.tz} — there is no session to be ahead of. `
            + `Add &force=1 to post anyway; drop &post=1 to assemble it without delivering.`
          : `${localDate} is a full-day closure for every exchange this region covers `
            + `(${shut.closed.join(', ')}, per data/holidays.json) — there is no session to be `
            + `ahead of. Add &force=1 to post anyway; drop &post=1 to assemble without delivering.`,
      } };
    }
  }

  if (req.query.cron === '1') {
    // ── ONCE A DAY, WHATEVER THE SCHEDULER DOES ──────────────────────────────
    // The window gate alone was enough while exactly one firing per region arrived per day. It is
    // not enough now: GitHub's scheduler delivered every run on 2026-09-02 between 1h46m and 4h32m
    // late, and two of the five never arrived at all, so the fix is to fire MANY attempts and let
    // the gate pick the one that lands in the window. That only works if a second attempt landing
    // in the same window is harmless — otherwise the cure is a double-posted brief.
    //
    // Asked in the REGION'S day, not UTC's. Asia targets 07:00 HKT, which is the previous calendar
    // day in UTC; a UTC-dated check would call the second attempt a new day and post it again.
    const todayLocal = localDateIn(R.tz);
    if (kvConfigured() && todayLocal) {
      try {
        const log = (await kvGetJson(PREREAD_LAST_KEY)) || {};
        const last = log[region];
        if (last?.localDate === todayLocal) {
          return { status: 200, body: {
            region, skipped: true, previous: last,
            reason: `already delivered for ${todayLocal} (posted ${last.at}) — a later attempt in the same window is a duplicate, not a retry`,
          } };
        }
      } catch { /* a KV failure must not silence the brief — fall through to the window gate */ }
    }
    const nowMin = localMinutesOfDay(R.tz);
    const w = prereadWindow(nowMin, R.prereadHourLocal, { deadlineMin: R.prereadDeadlineLocal ?? null });
    const openMin = w.open;
    if (!w.accept) {
      const hh = Math.floor(nowMin / 60), mm = String(nowMin % 60).padStart(2, '0');
      return { status: 200, body: {
        region, skipped: true, lateMin: w.lateMin,
        reason: `off-window (target ${R.prereadHourLocal}:00 ${R.tz}, delivery window ${Math.floor(openMin/60)}:${String(openMin%60).padStart(2,'0')}–${Math.floor(w.close/60)}:${String(w.close%60).padStart(2,'0')}, now ${hh}:${mm})`,
      } };
    }
  }

  const { quotes, idxRaw, macro, regime, cross, sox, leaning, hyg, nqLow, usRthOpen, usPrevSession, read: composed } = await assembleRegion(region);
  // attach display names to indices
  const indices = idxRaw.map((q, i) => ({ ...q, _name: R.indices[i].name }));
  const cal = weekHighlights(new Date(), region, R.tz);

  // ONE BATCHED QUOTE, TWO CONSUMERS. The watchlist needs whatever the region's own fetch did not
  // cover, and the US brief's OVERNIGHT section needs the Asian and European indices. Both are the
  // same call against the same route, so it is made once here rather than twice below.
  const byS = new Map(quotes.map(q => [q.sym, q]));
  const wanted = new Set(WATCH_UNIVERSE[region] || []);
  if (region === 'us') for (const k of ['asia', 'eu']) for (const i of UNIVERSE[k].indices) wanted.add(i.sym);
  const missing = [...wanted].filter(sym => !byS.has(sym) && !indices.some(q => q.sym === sym));
  let extraQuotes = {};
  if (missing.length) {
    try {
      // Same deployment, so the origin comes off the request rather than being configured — a
      // hardcoded host is one preview deployment away from quoting production's prices.
      const proto = req.headers?.['x-forwarded-proto'] || 'https';
      const base = `${proto}://${req.headers?.host}`;
      const r = await fetch(`${base}/api/prices?tickers=${encodeURIComponent(missing.join(','))}`,
        { headers: { cookie: req.headers?.cookie || '' } });
      if (r.ok) extraQuotes = await r.json();
    } catch { /* the watchlist thins and OVERNIGHT drops — neither takes the brief down */ }
  }

  // ── THE LAST BRIEF THIS REGION ACTUALLY RECEIVED ───────────────────────────
  // Read BEFORE the sections are built, because SINCE YESTERDAY is one of them. The same record
  // backs the same-day dedupe and the delivery log; it is read once here and reused at the foot of
  // this function rather than fetched twice.
  //
  // "Yesterday" means the last DELIVERED brief, not the last calendar day. A dropped run leaves no
  // record, so the next brief compares against the last thing the reader actually saw — which is
  // the comparison they can make in their head, and the only one that is not a lie after a gap.
  let prevLog = null, previous = null;
  if (kvConfigured()) {
    try {
      prevLog = (await kvGetJson(PREREAD_LAST_KEY)) || {};
      previous = prevLog[region] || null;
    } catch { /* no record is a first run, which renders no delta at all */ }
  }

  // ── ?state=1 — THE INPUTS, SO THE RENDER CAN BE TESTED WITHOUT THE FEEDS ───
  // MEASURED: six of the thirty content lines on a live Asia brief — one in five — never render in
  // a local run, because their inputs come from keyed feeds. Money, Credit and Inflation are the
  // whole macro backdrop and all three are among them. That is not a gap in coverage, it is a
  // section of the product that reaches the reader before it reaches anyone who could check it,
  // and it is how "the one it targets is the lower of the two" shipped over a PCE of 3.34 against
  // a CPI of 2.47 — a sentence that said the opposite of what the numbers said.
  //
  // check-env-independent.mjs does not catch this and is not meant to: it sets every variable to a
  // DUMMY, which proves the answer does not depend on configuration. A dummy key returns no data,
  // so the branches that need data still do not run.
  //
  // So the inputs come out and get frozen into test/fixtures-preread-*.json, and the suite renders
  // the brief from them with no network and no keys at all. Nothing here is private — it is market
  // data, the same figures the brief prints — and it is returned only when asked for.
  if (req.query.state === '1') {
    // hyg / nqLow / usRthOpen / usPrevSession come out too, so the test can REBUILD `leaning` and
    // `composed` from the inputs rather than replaying the frozen copies. Both are outputs of
    // lib/gates.js and lib/read.js, and a fixture holding them means a change to either — a new
    // gauge, a reworded row — cannot reach the golden. The whole point is that a change to the code
    // shows up in the diff.
    return { status: 200, body: { region, capturedAt: new Date().toISOString(),
      state: { quotes, indices, macro, regime, cal, cross, sox, leaning, composed,
               hyg, nqLow, usRthOpen, usPrevSession } } };
  }

  const blocks = buildBlocks(region, quotes, indices, macro, regime, cal, cross, sox,
    { leaning, composed, foreign: extraQuotes, prevSnap: previous?.snap || null });

  // ── THE TWO NEW SECTIONS ───────────────────────────────────────────────────
  // Both are best-effort and both are omitted rather than faked. The option book is the same in
  // every region — it is the US book, and a day trade placed from Hong Kong is placed against the
  // same levels — so all three briefs carry it. The freshness differs a lot and the footer says so:
  // Asia fires 42 minutes after the close capture, the US brief 14h42m after it.
  const liveSpot = (sym) => {
    const hit = indices.find(q => q.sym === sym) || quotes.find(q => q.sym === sym);
    const px = hit ? displayQuote(hit, region).price : null;   // live path — real clock is right here
    return Number.isFinite(+px) && +px > 0 ? +px : null;
  };
  // ── WHOSE SESSION IS THIS MAP ABOUT? ───────────────────────────────────────
  // Asia fires at 23:13 UTC against a US close of 20:00 — the book it would draw belongs to a
  // session that is OVER, and its front expiry has expired. So Asia gets the handoff form: where
  // the US finished against its book, one line per index, no pin and no map. EU (08:42) and the US
  // (12:42) both fire before the open and get the full map, which for them is a preview of what
  // the session runs into.
  //
  // NOT FETCHED AT ALL outside the US brief. It was rendered on all three and is now dropped from
  // two, so paying for the KV reads to build a block nobody sees would be waste with a latency
  // cost attached. `tense` survives because a manual US run after 20:00 UTC is describing a closed
  // session and must not claim a pin on options that have already expired.
  if (region === 'us') {
    const usClosedNow = new Date().getUTCHours() * 60 + new Date().getUTCMinutes() >= 20 * 60;
    const tense = usClosedNow ? 'closed' : 'preview';
    try {
      const g = await gexBlock(liveSpot, tense);
      blocks.gexLines = g?.text || null;
      blocks.gexTense = tense;
      // Walls and spot go into the snapshot so tomorrow's brief can say a level moved. A reader
      // placing against yesterday's put wall needs to know before they place, not after.
      if (g?.walls) { blocks.snap.walls = g.walls; blocks.snap.spot = g.spot; }
    } catch { blocks.gexLines = null; }
    // Recomputed once the walls exist — the delta above ran before the option book was read.
    blocks.sinceLines = sinceSection(blocks.snap, prevSnapFor(previous));
  }
  // PUBLIC CHANNEL. Candidates are the region's configured universe and nothing else — lib/
  // watchlist.js takes no argument through which a holding could reach it.
  try {
    // The WATCH universe, not the semis `names` block. The old scan could only see 10 US names —
    // of the 24 roots actually traded in the last quarter it could see two — so it was answering
    // "what is moving in semiconductors" under a heading that promised something else.
    const wu = (WATCH_UNIVERSE[region] || []).map(sym => ({ name: sym, sym, role: null }));
    blocks.watchLines = renderWatchlist(watchlist(wu, sym => {
      const q = byS.get(sym);
      if (q) { const d = displayQuote(q, region); return { price: d.price, changePercent: d.changePct }; }
      const m = extraQuotes[sym];
      return m?.price != null ? { price: m.price, changePercent: m.changePercent } : null;
    }));
  } catch { blocks.watchLines = null; }
  // THE READ SECTION IS GONE, NOT LOST. Its structured rows are what BACKDROP now renders and its
  // tripwires are what WHAT WOULD CHANGE IT now renders — both from the same composed object, so
  // there is still no model call anywhere in this path and every figure traces to a parsed field.
  // What was removed is the third restatement: the READ repeated the credit level, the cross-asset
  // pairing and the Korea cluster that MACRO, REGIME and KOREA STRESS had each already printed.
  const message = assembleDiscord(region, R.label, blocks);

  // Optional: post to Discord if a webhook is set and ?post=1.
  // We check Discord's response (204 = success) and surface failures instead of
  // swallowing them — a bad/expired webhook must not read as a clean post.
  let posted = null;
  if (req.query.post === '1') {
    if (!process.env.DISCORD_WEBHOOK) {
      posted = { ok: false, error: 'DISCORD_WEBHOOK not set' };
    } else {
      try {
        // Post as an embed: description caps at 4096 chars (vs 2000 for plain
        // `content`), so the full Pre-Read fits in one message without truncating
        // off the calendar/read. Markdown (bold, bullets) still renders.
        const wr = await fetch(process.env.DISCORD_WEBHOOK, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ embeds: [{ description: message.slice(0, 4096) }] }),
        });
        const body = wr.ok ? '' : (await wr.text().catch(() => ''));
        posted = wr.ok
          ? { ok: true, status: wr.status }
          : { ok: false, status: wr.status, error: body.slice(0, 300) };
      } catch (e) {
        posted = { ok: false, error: String(e?.message || e) };
      }
    }
  }

  // WHAT RAN, AND WHEN. Written only on a confirmed post, so the record means "this brief reached
  // the channel" rather than "the function executed". A gate skip deliberately does not write —
  // the gap in the record IS the signal.
  if (kvConfigured() && posted?.ok) {
    try {
      // localDate is what the dedupe reads back. Written only on a confirmed post, so a failed
      // delivery leaves the day open for the next attempt rather than marking it done — and so
      // the snapshot always describes a brief that a reader actually received.
      await kvSetJson(PREREAD_LAST_KEY, { ...(prevLog || {}), [region]: {
        at: new Date().toISOString(), localDate: localDateIn(R.tz), cron: req.query.cron === '1',
        snap: blocks.snap } });
    } catch { /* the brief matters more than the bookkeeping */ }
  }

  return { status: 200, body: { region, message, regime, posted, previous, generatedAt: new Date().toISOString() } };
}

// ── ALL MODE, AND WHY IT EXISTS ──────────────────────────────────────────────
// Vercel's Hobby plan allows two CRON ENTRIES, and the original design spent five on this — one
// per region per DST half — of which only the first two ever ran. Moving to GitHub Actions traded
// that cap for a worse problem: measured across two independent workflows on 2026-09-02/03, its
// scheduler ran jobs between 53 minutes and 3h24m late and dropped six of seven firings outright.
// Vercel's crons, over the same period, were 16 to 33 minutes late and never missed.
//
// So the reliable scheduler comes back, and the cap stops mattering: ONE entry, one path, a
// schedule carrying every candidate hour, and this mode runs all three regions on each firing.
// The window gate keeps the wrong ones out and the same-day dedupe makes a repeat a no-op, so
// firing five times a day to deliver three briefs costs nothing but a few hundred milliseconds.
//
// `message` is deliberately not echoed here — three full briefs would make a response nobody
// reads, and the length is the part worth logging.
async function runAll(req, regions = ['asia', 'eu', 'us']) {
  const results = {};
  for (const rg of regions) {
    const r = await runRegion(rg, req);
    const b = r.body || {};
    results[rg] = b.skipped
      ? { skipped: true, reason: b.reason, ...(b.lateMin != null ? { lateMin: b.lateMin } : {}) }
      : { posted: b.posted ?? null, bytes: (b.message || '').length, previous: b.previous ?? null };
  }
  const delivered = Object.keys(results).filter(k => results[k]?.posted?.ok);
  return { status: 200, body: { all: true, delivered, results, generatedAt: new Date().toISOString() } };
}

export default async function handler(req, res) {
  const r = req.query.all === '1'
    ? await runAll(req)
    : await runRegion((req.query.region || 'asia').toLowerCase(), req);
  res.status(r.status).json(r.body);
}
