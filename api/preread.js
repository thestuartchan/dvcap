// /api/preread?region=asia|eu|us
// Assembles live data + deterministic regime, asks Sonnet 5 ONLY for the synthesis prose,
// formats Discord-ready (no tables, bullets, bold), optionally posts to the webhook.

import { UNIVERSE } from '../data/universe.js';
import { assembleRegion } from '../lib/assemble.js';
import { structure } from '../lib/regime.js';
import { weekHighlights } from '../lib/calendar.js';
import { marketState, localHour, halfDayLabels, freshness, freshnessText } from '../lib/sessions.js';
import { kofiaStoredLine, koreaFlowRead, koreaFlowImplication } from '../lib/kofia.js';
import KOFIA_STORE from '../data/korea_kofia.json' with { type: 'json' };

const MODEL = 'claude-sonnet-5';

function fmtPct(p) { return p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`; }

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
    const bits = [`**${m.name}**`, `${d.price ?? '—'}`, fmtPct(d.changePct)];
    if (st) bits.push(st);
    let line = `• ${bits.join(' · ')}`;
    if (m.leader) line += ' ⭐';
    return line + d.tail;
  }).join('\n');

  const idxLines = indices.map(q => {
    const d = displayQuote(q, region);
    return `• **${q._name}** · ${d.price ?? '—'} · ${fmtPct(d.changePct)}${d.tail}`;
  }).join('\n');

  const oil = macro.wti?.price != null
    ? `• **WTI** $${macro.wti.price} ${regime.oil.above ? '▲' : '▼'}${macro.wti.stale ? ' ⚠️' : ''}\n• **Brent** $${macro.brent?.price ?? '—'}`
    : '• oil: no live print';

  const macroLines =
    `${oil}\n`
    + `• **US 2Y** ${macro.us2y?.value ?? '—'}% · **10Y** ${macro.us10y?.value ?? '—'}%\n`
    + `• **HY OAS** ${macro.oas?.value ?? '—'} (${macro.oas?.date ?? 'n/a'}, last hard print) · ${regime.credit.state}`;

  const koreaLines = buildKorea(regime.korea);

  let regimeLines =
    `• **Split:** ${regime.split.label} (foundry ${fmtPct(regime.split.fnd)} vs memory ${fmtPct(regime.split.mem)})\n`
    + `• **Credit** (global/OAS gate): ${regime.credit.state} — ${regime.credit.note}\n`
    + `• **Oil:** ${regime.oil.label}`;
  // Surface the Korea-local cluster to the model as a SEPARATE gate from OAS.
  if (regime.korea) {
    regimeLines += `\n• **Korea** (local gate): ${regime.korea.cluster} — ${regime.korea.note}`;
  }

  const calLines = cal.length
    ? cal.map(e => {
        const dow = DOW[new Date(e.date + 'T00:00:00Z').getUTCDay()];
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

async function synthProse(region, blocks) {
  // The model gets ONLY the computed numbers + regime, and writes the read paragraph.
  // Standing constraints baked in: research/data only, no positions, no advice, no disclaimers.
  const sys = `You write a terse market "read" paragraph for a private trading Discord.
Rules: research and data only. Never mention anyone's portfolio, positions, or theses.
No instructional guidance (no "don't short X"). No disclaimers or "not advice" footers.
2-4 sentences max. Lead with the single most important thing. Plain, punchy, scannable.`;

  const user = `Region: ${region.toUpperCase()}
Names:\n${blocks.nameLines}
Indices:\n${blocks.idxLines}
Macro:\n${blocks.macroLines}
Regime (computed, authoritative — do not contradict the numbers):\n${blocks.regimeLines}
Write only the READ paragraph.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 400,
      system: sys, messages: [{ role: 'user', content: user }] }),
  });
  const j = await r.json();
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

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
    `📅 **WEEK AHEAD**\n${blocks.calLines}`,
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

  // DST-safe cron gating. Vercel crons are UTC-only and would drift an hour across
  // daylight-saving shifts. For DST-observing regions (EU/US) we schedule the cron at
  // BOTH candidate UTC hours and gate here on the region's real local hour (Intl,
  // DST-aware), so exactly one firing per day actually posts. Asia (HK/KR/TW/JP keep
  // no DST) needs one entry, but the same gate applies harmlessly. Only scheduled
  // calls pass cron=1 — manual calls/dry-runs skip the gate, so tests always run.
  if (req.query.cron === '1' && localHour(R.tz) !== R.prereadHourLocal) {
    return res.status(200).json({
      region, skipped: true,
      reason: `off-target local hour (want ${R.prereadHourLocal}:00 ${R.tz}, now ${localHour(R.tz)}:00)`,
    });
  }

  const { quotes, idxRaw, macro, regime } = await assembleRegion(region);
  // attach display names to indices
  const indices = idxRaw.map((q, i) => ({ ...q, _name: R.indices[i].name }));
  const cal = weekHighlights(new Date(), region, R.tz);
  const blocks = buildBlocks(region, quotes, indices, macro, regime, cal);
  const read = await synthProse(region, blocks);
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

  res.status(200).json({ region, message, regime, posted, generatedAt: new Date().toISOString() });
}
