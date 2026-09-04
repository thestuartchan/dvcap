// /api/preread?region=asia|eu|us
// Assembles live data + deterministic regime + the COMPOSED read (lib/read.js), formats
// Discord-ready (no tables, bullets, bold), optionally posts to the webhook.
// There is no model call anywhere in this path — every figure traces to a parsed field.

import { UNIVERSE } from '../data/universe.js';
import { assembleRegion } from '../lib/assemble.js';
import { structure } from '../lib/regime.js';
import { weekHighlights } from '../lib/calendar.js';
import { marketState, localHour, localMinutesOfDay, localDateIn, isWeekendIn, localWeekday, closedExchanges, halfDayLabels, freshness, freshnessText, sessionCloseMin } from '../lib/sessions.js';
import { kvGetJson, kvSetJson, kvConfigured } from '../lib/kv.js';
import { coreSpread } from '../lib/inflation.js';

// One key, one small object per region. A skipped brief left NO trace anywhere — the only detector
// was a human noticing an absence in a Discord channel, which is how this morning's was found.
const PREREAD_LAST_KEY = 'dvcap:preread:last:v1';
import { kofiaStoredLine, koreaFlowRead, koreaFlowImplication, withCommas } from '../lib/kofia.js';
import KOFIA_STORE from '../data/korea_kofia.json' with { type: 'json' };


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
function freshLabel(sym, q) {
  const t = freshnessText(freshness(sym, q));
  return t ? ` · ${t}` : '';   // live → no suffix
}

// Pick the price/%chg/label to display. US pre/post-market override: when the US
// market is SHUT but a FRESH extended-hours print exists, show it (labeled · pre-mkt /
// · post) instead of the stale prior regular close — that's the live gap at the 09:00
// ET fire. Everywhere else, the regular print + market-state freshness label.
function displayQuote(q, region) {
  if (region === 'us' && marketState(q.sym) === 'closed' && q.ext && !q.ext.stale) {
    const sess = localHour('America/New_York') < 12 ? 'pre-mkt' : 'post';
    return { price: q.ext.price, changePct: q.ext.changePct, tail: ` · ${sess}` };
  }
  return { price: q.price, changePct: q.changePct, tail: freshLabel(q.sym, q) };
}

function buildBlocks(region, quotes, indices, macro, regime, cal, cross, sox) {
  const R = UNIVERSE[region];
  const names = R.names;

  // Line shape: bold ticker anchors the eye, then price, %chg, structure, leader ⭐,
  // freshness. `·` separators keep it scannable (Discord collapses runs of spaces).
  // ONE SHARED LABEL, ONCE. Before the open every line carries the same freshness tail — fifteen
  // repetitions of "· prior close" on a brief that fires two hours before the market opens, which
  // is a fact about the hour rather than about any name. When every quoted line agrees, the tail is
  // lifted into the header; the moment they diverge (one exchange open, another shut, a delayed
  // feed) it drops back onto the lines, because then it IS per-name information.
  const nameQ = quotes.map((q, i) => ({ q, m: names[i], d: displayQuote(q, region) }));
  const idxQ  = indices.map(q => ({ q, d: displayQuote(q, region) }));
  const tails = [...nameQ, ...idxQ].map(x => x.d.tail);
  const sharedTail = (tails.length && tails.every(t => t === tails[0]) && tails[0]) ? tails[0] : null;
  const tailOf = (d) => sharedTail ? '' : d.tail;

  const nameLines = nameQ.map(({ m, q, d }) => {
    const st = structure(q);
    const bits = [`**${m.name}**`, `${d.price != null ? withCommas(d.price) : '—'}`, fmtPct(d.changePct)];
    if (st) bits.push(st);
    let line = `• ${bits.join(' · ')}`;
    if (m.leader) line += ' ⭐';
    return line + tailOf(d);
  }).join('\n');

  const idxLines = idxQ.map(({ q, d }) =>
    `• **${q._name}** · ${d.price != null ? withCommas(d.price) : '—'} · ${fmtPct(d.changePct)}${tailOf(d)}`
  ).join('\n');

  // ── OVERNIGHT US ───────────────────────────────────────────────────────────
  // The Asia brief fires at 06:45 HKT — 18:45 ET, nearly three hours after the US close — and the
  // single most predictive input for the Asia open was nowhere on it. SOX especially: this book is
  // semis-heavy and the overnight SOX print is what the Korean and Taiwanese names gap to. All of
  // it was already fetched and simply never rendered. Not shown for the US brief, where the same
  // numbers are the session about to start rather than a handoff into it.
  // A move smaller than half a tenth is not a direction, and "-0.0%" is a worse way of saying so
  // than the word is.
  const pct = (v) => v == null ? '—' : Math.abs(v) < 0.05 ? 'flat' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
  // Cross-asset rows carry `price`, not `value` — reading the wrong one dropped VIX from the block
  // silently, which is the same shape of bug as every other field-name miss this week.
  const crossRow = (group, name) => (cross?.[group]?.rows || []).find(r => r.name === name) || null;
  const overnightLines = (() => {
    if (region === 'us' || !cross) return null;
    const legs = [
      sox?.changePct != null ? `**SOX** ${pct(sox.changePct)}` : null,
      ...['SMH', 'QQQ', 'SPY'].map(n => { const r = crossRow('breadth', n); return r?.changePct != null ? `**${n}** ${pct(r.changePct)}` : null; }),
    ].filter(Boolean);
    const vix = crossRow('volCredit', 'VIX'), hyg = crossRow('volCredit', 'HYG');
    const risk = [
      vix?.price != null ? `**VIX** ${vix.price}${vix.changePct != null ? ` ${pct(vix.changePct)}` : ''}${vix.benchmark?.band ? ` [${vix.benchmark.band}]` : ''}` : null,
      hyg?.changePct != null ? `**HYG** ${pct(hyg.changePct)}` : null,
    ].filter(Boolean);
    if (!legs.length && !risk.length) return null;
    return [legs.length ? `• ${legs.join(' · ')}` : null, risk.length ? `• ${risk.join(' · ')}` : null].filter(Boolean).join('\n');
  })();

  const oil = macro.wti?.price != null
    ? `• **WTI** $${macro.wti.price} ${regime.oil.above ? '▲' : '▼'}${macro.wti.stale ? ' ⚠️' : ''}\n• **Brent** $${macro.brent?.price ?? '—'}`
    : '• oil: no live print';

  const macroLines =
    `${oil}\n`
    + `• **US 2Y** ${macro.us2y?.value ?? '—'}% · **10Y** ${macro.us10y?.value ?? '—'}%\n`
    + `• **HY OAS** ${macro.oas?.value ?? '—'} (${macro.oas?.date ?? 'n/a'}, last hard print) · ${regime.credit.state}`
    // THE GAP, NOT THE LEVEL. Core CPI and core PCE measure the same idea and disagree
    // structurally — PCE normally runs below on a much lighter shelter weight — so the sign is
    // the information. Only rendered when it is saying something: an inversion while the Fed's
    // own gauge is still elevated.
    + (() => {
        const sp = coreSpread(macro.corePce?.value, macro.coreCpi?.value);
        if (!sp) return '';
        const tail = sp.divergent
          ? ` — **inverted**, and PCE is what the Fed targets`
          : sp.inverted ? ' — inverted, though both sit near target' : '';
        return `\n• **Core PCE** ${sp.pce}% vs **core CPI** ${sp.cpi}% · ${sp.pp >= 0 ? '+' : '−'}${Math.abs(sp.pp).toFixed(2)}pp${tail}`;
      })();

  const koreaLines = buildKorea(regime.korea);

  let regimeLines = regime.staleWhileOpen
    ? `• ⚠️ **Equity axes stale** — market open but prints are prior-close; split/AI reads suppressed\n`
    : '';
  regimeLines +=
    `• **Split:** ${regime.split.stale ? 'stale — mkt open, awaiting live' : `${regime.split.label} (foundry ${fmtPct(regime.split.fnd)} vs memory ${fmtPct(regime.split.mem)})`}\n`
    + `• **AI vs non-AI:** ${regime.aiAxis.stale ? 'stale — mkt open, awaiting live' : `${regime.aiAxis.label} (AI ${fmtPct(regime.aiAxis.ai)} vs non-AI ${fmtPct(regime.aiAxis.non)})`}\n`
    + `• **Credit** (global/OAS gate): ${regime.credit.compound || regime.credit.state} — ${regime.credit.note}\n`
    + `• **Oil:** ${regime.oil.label}`;
  // The Korea cluster used to be repeated here verbatim — the same string, including the same
  // parenthesised 1d figures, already printed under KOREA STRESS a few lines above. The gate is
  // named so the regime list stays complete; the reading itself is not restated.
  if (regime.korea) {
    regimeLines += `\n• **Korea** (local gate): ${regime.korea.cluster} — see Korea Stress above`;
  }

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
  const calLines = cal.length
    ? cal.map(e => {
        const dow = DOW[new Date(e.date + 'T00:00:00Z').getUTCDay()];
        if (e.reported) return `• ~~**${dow} ${e.date.slice(5)}** · ${e.title}~~ _(reported)_`;
        return `• **${dow} ${e.date.slice(5)}** · ${e.title}${e.scope === 'global' ? ' 🌐' : ''}${whenTag(e)}`;
      }).join('\n')
    : '• (nothing flagged in the next 10 days)';

  // Half-day heads-up: a region can span several exchanges, so flag whichever are on an
  // early-close session today (the Pre-Read fires pre-open, so this is a forward warning).
  const halfEx = halfDayLabels([...quotes.map(q => q.sym), ...indices.map(q => q.sym)]);
  const halfDayNote = halfEx.length
    ? `🕐 **HALF DAY** — ${halfEx.join(', ')} ${halfEx.length === 1 ? 'closes' : 'close'} early today`
    : null;

  return { nameLines, idxLines, macroLines, koreaLines, regimeLines, calLines, halfDayNote, overnightLines, sharedTail };
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

function assembleDiscord(region, label, blocks, read) {
  const emoji = { asia: '🌏', eu: '🇪🇺', us: '🇺🇸' }[region] || '📊';
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Each section is header + body; sections are separated by a blank line AND a thin
  // rule so they breathe (Discord collapses bare consecutive newlines, so we use an
  // explicit divider rather than relying on extra \n's).
  const RULE = '───────────────';
  const sections = [
    // The handoff comes FIRST for a brief that fires after the US close and before this region
    // opens: it is the thing every line below reacts to.
    ...(blocks.overnightLines ? [`🌙 **OVERNIGHT US** _(prior close)_\n${blocks.overnightLines}`] : []),
    `📋 **NAMES**${blocks.sharedTail ? ` _(all${blocks.sharedTail.replace(/^ · /, ' ')})_` : ''}\n${blocks.nameLines}`,
    `📈 **INDICES**\n${blocks.idxLines}`,
    `🛢️ **MACRO**\n${blocks.macroLines}`,
    ...(blocks.koreaLines ? [`🇰🇷 **KOREA STRESS**\n${blocks.koreaLines}`] : []),
    `🧭 **REGIME**\n${blocks.regimeLines}`,
    `📝 **READ**\n${read}`,
    `📅 **CALENDAR** _(current / upcoming)_\n${blocks.calLines}`,
  ];

  return [
    `${emoji} **DAILY PRE-READ · ${label} · ${now}Z**`,
    // Prominent half-day warning right under the header (only when applicable).
    ...(blocks.halfDayNote ? [blocks.halfDayNote] : []),
    ...sections.flatMap(s => [RULE, s]),
    RULE,
    `*⭐ sector leader (cross-market tell) · ⏱ delayed feed · 🌐 global event · "prior close" = market shut*`,
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

  const { quotes, idxRaw, macro, regime, cross, sox, read: composed } = await assembleRegion(region);
  // attach display names to indices
  const indices = idxRaw.map((q, i) => ({ ...q, _name: R.indices[i].name }));
  const cal = weekHighlights(new Date(), region, R.tz);
  const blocks = buildBlocks(region, quotes, indices, macro, regime, cal, cross, sox);
  // The READ is the COMPOSED, deterministic one (lib/read.js) — same text the dashboard
  // shows. No model call in the read path: every figure is traceable to a parsed field, so
  // the Pre-Read cannot hallucinate a number or drift into positioning language.
  const read = composed?.text || '(no gate inputs available)';
  const message = assembleDiscord(region, R.label, blocks, read);

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
  let previous = null;
  if (kvConfigured()) {
    try {
      const log = (await kvGetJson(PREREAD_LAST_KEY)) || {};
      previous = log[region] || null;
      if (posted?.ok) {
        // localDate is what the dedupe reads back. Written only on a confirmed post, so a failed
        // delivery leaves the day open for the next attempt rather than marking it done.
        await kvSetJson(PREREAD_LAST_KEY, { ...log, [region]: {
          at: new Date().toISOString(), localDate: localDateIn(R.tz), cron: req.query.cron === '1' } });
      }
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
