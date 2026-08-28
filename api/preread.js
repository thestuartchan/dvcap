// /api/preread?region=asia|eu|us
// Assembles live data + deterministic regime + the COMPOSED read (lib/read.js), formats
// Discord-ready (no tables, bullets, bold), optionally posts to the webhook.
// There is no model call anywhere in this path — every figure traces to a parsed field.

import { UNIVERSE } from '../data/universe.js';
import { assembleRegion } from '../lib/assemble.js';
import { structure } from '../lib/regime.js';
import { weekHighlights } from '../lib/calendar.js';
import { marketState, localHour, localMinutesOfDay, halfDayLabels, freshness, freshnessText } from '../lib/sessions.js';
import { kvGetJson, kvSetJson, kvConfigured } from '../lib/kv.js';

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
const PREREAD_WINDOW_MIN = 55;
// GRACE: how far BEFORE the window opens a firing is still accepted.
//
// The window used to open at exactly the minute the cron fires — every region computed
// sinceOpen = 0 on a good day, which is the first accepted value. That tolerated up to 40 minutes
// of LATE firing and not one second of early: a cron a minute ahead of schedule, or any clock skew
// between Vercel's scheduler and this container's Intl evaluation, silently dropped the entire
// day's brief. And a dropped brief is invisible — nothing recorded that it should have run.
//
// Five minutes of lead-in costs nothing. The DST pair must still be mutually exclusive, so the
// TOTAL span stays at 60: the two candidate crons are exactly 60 local minutes apart, and the
// later one lands at sinceOpen = GRACE + 60, outside a span of GRACE + WINDOW = 60.
const PREREAD_GRACE_MIN  = 5;

// Extracted so the arithmetic is testable. It decides whether a firing at `nowMin` (local minutes
// past midnight) is the one that should deliver — the whole daily brief hangs on it, and it had
// never been pinned by a test.
export function prereadWindow(nowMin, targetHour, { lead = PREREAD_LEAD_MIN, window = PREREAD_WINDOW_MIN, grace = PREREAD_GRACE_MIN } = {}) {
  const open = targetHour * 60 - lead - grace;
  const span = grace + window;
  const sinceOpen = nowMin - open;
  return { open, close: open + span, span, sinceOpen, accept: sinceOpen >= 0 && sinceOpen < span };
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

function buildBlocks(region, quotes, indices, macro, regime, cal) {
  const R = UNIVERSE[region];
  const names = R.names;

  // Line shape: bold ticker anchors the eye, then price, %chg, structure, leader ⭐,
  // freshness. `·` separators keep it scannable (Discord collapses runs of spaces).
  const nameLines = quotes.map((q, i) => {
    const m = names[i];
    const st = structure(q);
    const d = displayQuote(q, region);
    const bits = [`**${m.name}**`, `${d.price != null ? withCommas(d.price) : '—'}`, fmtPct(d.changePct)];
    if (st) bits.push(st);
    let line = `• ${bits.join(' · ')}`;
    if (m.leader) line += ' ⭐';
    return line + d.tail;
  }).join('\n');

  const idxLines = indices.map(q => {
    const d = displayQuote(q, region);
    return `• **${q._name}** · ${d.price != null ? withCommas(d.price) : '—'} · ${fmtPct(d.changePct)}${d.tail}`;
  }).join('\n');

  const oil = macro.wti?.price != null
    ? `• **WTI** $${macro.wti.price} ${regime.oil.above ? '▲' : '▼'}${macro.wti.stale ? ' ⚠️' : ''}\n• **Brent** $${macro.brent?.price ?? '—'}`
    : '• oil: no live print';

  const macroLines =
    `${oil}\n`
    + `• **US 2Y** ${macro.us2y?.value ?? '—'}% · **10Y** ${macro.us10y?.value ?? '—'}%\n`
    + `• **HY OAS** ${macro.oas?.value ?? '—'} (${macro.oas?.date ?? 'n/a'}, last hard print) · ${regime.credit.state}`;

  const koreaLines = buildKorea(regime.korea);

  let regimeLines = regime.staleWhileOpen
    ? `• ⚠️ **Equity axes stale** — market open but prints are prior-close; split/AI reads suppressed\n`
    : '';
  regimeLines +=
    `• **Split:** ${regime.split.stale ? 'stale — mkt open, awaiting live' : `${regime.split.label} (foundry ${fmtPct(regime.split.fnd)} vs memory ${fmtPct(regime.split.mem)})`}\n`
    + `• **AI vs non-AI:** ${regime.aiAxis.stale ? 'stale — mkt open, awaiting live' : `${regime.aiAxis.label} (AI ${fmtPct(regime.aiAxis.ai)} vs non-AI ${fmtPct(regime.aiAxis.non)})`}\n`
    + `• **Credit** (global/OAS gate): ${regime.credit.compound || regime.credit.state} — ${regime.credit.note}\n`
    + `• **Oil:** ${regime.oil.label}`;
  // Surface the Korea-local cluster to the model as a SEPARATE gate from OAS.
  if (regime.korea) {
    regimeLines += `\n• **Korea** (local gate): ${regime.korea.cluster} — ${regime.korea.note}`;
  }

  const calLines = cal.length
    ? cal.map(e => {
        const dow = DOW[new Date(e.date + 'T00:00:00Z').getUTCDay()];
        if (e.reported) return `• ~~**${dow} ${e.date.slice(5)}** · ${e.title}~~ _(reported)_`;
        return `• **${dow} ${e.date.slice(5)}** · ${e.title}${e.scope === 'global' ? ' 🌐' : ''}`;
      }).join('\n')
    : '• (nothing flagged in the next 10 days)';

  // Half-day heads-up: a region can span several exchanges, so flag whichever are on an
  // early-close session today (the Pre-Read fires pre-open, so this is a forward warning).
  const halfEx = halfDayLabels([...quotes.map(q => q.sym), ...indices.map(q => q.sym)]);
  const halfDayNote = halfEx.length
    ? `🕐 **HALF DAY** — ${halfEx.join(', ')} ${halfEx.length === 1 ? 'closes' : 'close'} early today`
    : null;

  return { nameLines, idxLines, macroLines, koreaLines, regimeLines, calLines, halfDayNote };
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
    `📋 **NAMES**\n${blocks.nameLines}`,
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

export default async function handler(req, res) {
  const region = (req.query.region || 'asia').toLowerCase();
  const R = UNIVERSE[region];
  if (!R) return res.status(400).json({ error: 'bad region' });

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
  if (req.query.cron === '1') {
    const nowMin = localMinutesOfDay(R.tz);
    const w = prereadWindow(nowMin, R.prereadHourLocal);
    const openMin = w.open;
    if (!w.accept) {
      const hh = Math.floor(nowMin / 60), mm = String(nowMin % 60).padStart(2, '0');
      return res.status(200).json({
        region, skipped: true,
        reason: `off-window (target ${R.prereadHourLocal}:00 ${R.tz}, delivery window ${Math.floor(openMin/60)}:${String(openMin%60).padStart(2,'0')}–${Math.floor(w.close/60)}:${String(w.close%60).padStart(2,'0')}, now ${hh}:${mm})`,
      });
    }
  }

  const { quotes, idxRaw, macro, regime, read: composed } = await assembleRegion(region);
  // attach display names to indices
  const indices = idxRaw.map((q, i) => ({ ...q, _name: R.indices[i].name }));
  const cal = weekHighlights(new Date(), region, R.tz);
  const blocks = buildBlocks(region, quotes, indices, macro, regime, cal);
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
        await kvSetJson(PREREAD_LAST_KEY, { ...log, [region]: { at: new Date().toISOString(), cron: req.query.cron === '1' } });
      }
    } catch { /* the brief matters more than the bookkeeping */ }
  }

  res.status(200).json({ region, message, regime, posted, previous, generatedAt: new Date().toISOString() });
}
