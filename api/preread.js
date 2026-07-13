// /api/preread?region=asia|eu|us
// Assembles live data + deterministic regime, asks Sonnet 5 ONLY for the synthesis prose,
// formats Discord-ready (no tables, bullets, bold), optionally posts to the webhook.

import { UNIVERSE } from '../data/universe.js';
import { getQuotes, getMacro } from './lib/quotes.js';
import { computeRegime, structure, arrow } from './lib/regime.js';
import { weekHighlights } from './lib/calendar.js';

const MODEL = 'claude-sonnet-5';

function fmtPct(p) { return p == null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`; }

function buildBlocks(region, quotes, indices, macro, regime, cal) {
  const R = UNIVERSE[region];
  const names = R.names;

  const nameLines = quotes.map((q, i) => {
    const m = names[i];
    const st = structure(q);
    const flag = q.stale ? ' ⚠️stale' : '';
    return `- ${m.name} ${q.price ?? '—'} ${fmtPct(q.changePct)}${st ? ` · ${st}` : ''}${m.leader ? ' ·L' : ''}${flag}`;
  }).join('\n');

  const idxLines = indices.map(q =>
    `- ${q._name} ${q.price ?? '—'} ${fmtPct(q.changePct)}`).join('\n');

  const oil = macro.wti?.price != null
    ? `- WTI $${macro.wti.price} ${regime.oil.above ? '▲' : '▼'}${macro.wti.stale ? ' ⚠️' : ''}\n- Brent $${macro.brent?.price ?? '—'}`
    : '- oil: no live print';

  const macroLines =
    `${oil}\n`
    + `- US 2Y ${macro.us2y?.value ?? '—'}% · 10Y ${macro.us10y?.value ?? '—'}%\n`
    + `- HY OAS ${macro.oas?.value ?? '—'} (${macro.oas?.date ?? 'n/a'}, last hard print) · ${regime.credit.state}`;

  const regimeLines =
    `- Split: ${regime.split.label} (foundry ${fmtPct(regime.split.fnd)} vs memory ${fmtPct(regime.split.mem)})\n`
    + `- Credit: ${regime.credit.state} — ${regime.credit.note}\n`
    + `- Oil: ${regime.oil.label}`;

  const calLines = cal.length
    ? cal.map(e => `- ${e.date} — ${e.title} [${e.region}]`).join('\n')
    : '- (no flagged events this week)';

  return { nameLines, idxLines, macroLines, regimeLines, calLines };
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
  return [
    `${emoji} **DAILY PRE-READ — ${label} — ${now}Z**`,
    ``,
    `**NAMES**`, blocks.nameLines,
    ``, `**INDICES**`, blocks.idxLines,
    ``, `🛢️ **MACRO**`, blocks.macroLines,
    ``, `🧭 **REGIME**`, blocks.regimeLines,
    ``, `🧭 **READ**`, read,
    ``, `📅 **THIS WEEK**`, blocks.calLines,
  ].join('\n');
}

export default async function handler(req, res) {
  const region = (req.query.region || 'asia').toLowerCase();
  const R = UNIVERSE[region];
  if (!R) return res.status(400).json({ error: 'bad region' });

  const nameSyms = R.names.map(n => n.sym);
  const idxSyms  = R.indices.map(n => n.sym);

  const [quotes, idxRaw, macro] = await Promise.all([
    getQuotes(nameSyms), getQuotes(idxSyms), getMacro(),
  ]);
  // attach display names to indices
  const indices = idxRaw.map((q, i) => ({ ...q, _name: R.indices[i].name }));

  const regime = computeRegime({ quotes, names: R.names, macro });
  const cal = weekHighlights();
  const blocks = buildBlocks(region, quotes, indices, macro, regime, cal);
  const read = await synthProse(region, blocks);
  const message = assembleDiscord(region, R.label, blocks, read);

  // Optional: post to Discord if a webhook is set and ?post=1
  if (req.query.post === '1' && process.env.DISCORD_WEBHOOK) {
    await fetch(process.env.DISCORD_WEBHOOK, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: message.slice(0, 3900) }),
    });
  }

  res.status(200).json({ region, message, regime, generatedAt: new Date().toISOString() });
}
