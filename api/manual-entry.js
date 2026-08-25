// api/manual-entry.js — manual/derived series that have no keyless feed.
//   • fedPath  (P6.2) — 30-day fed funds futures (ZQ). No free feed exists: IBKR has no
//     stateless auth and its futures data is ~20-min delayed, so this is a daily hand entry.
//   • intervention (F3) — coordinated-FX-intervention flag. Manual because no keyless feed
//     reports intervention in real time; MOF/BOK confirmations arrive after the fact, so an
//     inferred flag would manufacture certainty from a wide daily move.
//   • oasRecon (P2.5) — the OAS/HYG reconciliation log. Establishes whether the live proxy is
//     actually predictive, so the card can be demoted or dropped on evidence rather than
//     trusted by habit.
// Both live in one endpoint to stay inside the 12-function Hobby cap (this is the 8th).

import { kvGetJson, kvSetJson, kvConfigured, CONSOLE_KEY } from '../lib/kv.js';

const DATA_PATH = 'data/manual_entry.json';

// ── Where each kind of state lives ───────────────────────────────────────────
// GIT (data/manual_entry.json): curated macro inputs — fedPath, oasRecon, intervention, recession
//   overrides, southbound. Version history is a FEATURE here: you want to see when a recession
//   override changed and what it was before.
// REDIS (Upstash, lib/kv.js): the trade console — positions, cost basis, journal, settings.
//   Personal, high-churn, and a permanent diffable history of a real book is a liability, not a
//   feature. Redis writes replace; nothing accumulates.
// Until the Upstash env vars exist, console reads fall back to whatever is already in the git
// store (so nothing is lost on migration) and writes stay local to the browser.
async function readConsole(gitFallback) {
  if (kvConfigured()) {
    const kv = await kvGetJson(CONSOLE_KEY);
    if (kv) return { ...kv, _store: 'kv' };
    // First run after wiring Upstash: nothing in Redis yet, so serve (and thereby migrate) the
    // copy already committed to git. The next save writes it to Redis.
    if (gitFallback) return { ...gitFallback, _store: 'git-fallback' };
    return { watchlist: [], journal: [], settings: {}, _store: 'kv-empty' };
  }
  return { ...(gitFallback || { watchlist: [], journal: [], settings: {} }), _store: 'git' };
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dvcap-manual-entry',
  };
}

async function readStore() {
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${DATA_PATH}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders() });
  const emptyConsole = () => ({ watchlist: [], journal: [], settings: {} });
  if (!r.ok) return { store: { fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, recession: {}, console: emptyConsole() }, sha: null };
  const meta = await r.json();
  let store = { fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, recession: {}, console: emptyConsole() };
  try { store = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8')); } catch { /* default */ }
  store.fedPath ||= { latest: null, series: [] };
  store.fedPath.series ||= [];
  store.oasRecon ||= [];
  store.intervention ??= null;
  store.recession ||= {};   // manual overrides for the Wall Street recession sources
  store.southbound ||= { series: [] };   // HKEX Southbound Stock Connect daily flow (hand-entered)
  store.southbound.series ||= [];
  store.console ||= emptyConsole();       // Tier 3 trade console — watchlist / journal / settings
  store.console.watchlist ||= [];
  store.console.journal ||= [];
  store.console.settings ||= {};
  return { store, sha: meta.sha };
}

// ZQ is quoted as 100 − implied average fed funds for the contract month.
export function zqImpliedRate(price) {
  if (price == null || !Number.isFinite(+price)) return null;
  return +(100 - Number(price)).toFixed(4);
}
// Moves vs current EFFR, in 25bp increments. Sign carries direction: + = hikes priced.
export function zqMovesPriced(impliedRate, effr) {
  if (impliedRate == null || effr == null) return null;
  return +((impliedRate - effr) / 0.25).toFixed(2);
}

// ── Console (Tier 3) sanitizers ──────────────────────────────────────────────
// The console syncs its full state wholesale (the browser owns it); we bound every field so a
// synced payload can never bloat the committed store file. cs = capped string, cn = number-or-null.
const cs = (v, max = 200) => (v == null ? null : String(v).slice(0, max));
const cn = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
function sanitizeWatchItem(w) {
  if (!w || typeof w !== 'object') return null;
  const sym = cs(w.symbol, 20);
  if (!sym) return null;
  return {
    id: cs(w.id, 48) || `${sym}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: sym.toUpperCase(),
    side: (w.side === 'long' || w.side === 'short') ? w.side : null,
    entry: cn(w.entry), stop: cn(w.stop),
    targets: Array.isArray(w.targets) ? w.targets.map(cn).filter(x => x != null).slice(0, 4) : [],
    riskPct: cn(w.riskPct),
    currency: /^[A-Z]{3}$/.test(String(w.currency || '').toUpperCase()) ? String(w.currency).toUpperCase() : 'USD',
    status: cs(w.status, 16) || 'idea',
    note: cs(w.note, 500),
    addedAt: cs(w.addedAt, 40) || new Date().toISOString(),
  };
}
function sanitizeJournalItem(j) {
  if (!j || typeof j !== 'object') return null;
  const sym = cs(j.symbol, 20);
  if (!sym) return null;
  return {
    id: cs(j.id, 48) || `${sym}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: sym.toUpperCase(),
    side: (j.side === 'long' || j.side === 'short') ? j.side : null,
    thesis: cs(j.thesis, 1000),
    entryPrice: cn(j.entryPrice), exitPrice: cn(j.exitPrice), shares: cn(j.shares),
    realizedR: cn(j.realizedR),
    regimeAtEntry: cs(j.regimeAtEntry, 48),
    dateIn: cs(j.dateIn, 12), dateOut: cs(j.dateOut, 12),
    notes: cs(j.notes, 1000),
  };
}
function sanitizeConsoleSettings(s) {
  if (!s || typeof s !== 'object') return {};
  const out = {
    equity: cn(s.equity), baseRiskPct: cn(s.baseRiskPct), alertsEnabled: !!s.alertsEnabled,
    baseCurrency: /^[A-Z]{3}$/.test(String(s.baseCurrency || '').toUpperCase()) ? String(s.baseCurrency).toUpperCase() : 'USD',
  };
  if (s.sizing && typeof s.sizing === 'object') {
    out.sizing = {};
    for (const k of ['ref', 'inf', 'stag', 'def']) {
      const m = cn(s.sizing[k]?.mult ?? s.sizing[k]);
      if (m != null) out.sizing[k] = Math.max(0, Math.min(3, m));   // clamp multiplier to 0–3×
    }
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
      return res.status(200).json({ fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, note: 'store not configured' });
    }
    try {
      const { store } = await readStore();
      // NOT edge-cached. This response now carries the trade console — real positions and cost
      // basis — and a shared s-maxage cache would both hold private state at the edge and serve a
      // stale book to a second device, defeating the cross-device sync this store exists for.
      res.setHeader('Cache-Control', 'private, no-store');
      return res.status(200).json({
        fedPath: { latest: store.fedPath.latest, series: store.fedPath.series.slice(-120) },
        oasRecon: store.oasRecon.slice(-180),
        intervention: store.intervention,
        recession: store.recession,
        southbound: { series: store.southbound.series.slice(-60) },
        // Console comes from Redis when configured, else the git copy (migration path).
        console: await readConsole(store.console),
        kv: { configured: kvConfigured() },
      });
    } catch (e) {
      return res.status(200).json({ fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, error: String(e?.message || e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST only' });
  if (!/(^|;\s*)mwd_auth=true(;|$)/.test(req.headers.cookie || '')) {
    return res.status(401).json({ error: 'not authenticated — log in to the dashboard first' });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: 'GITHUB_TOKEN / GITHUB_REPO not configured' });
  }

  const { fedPath, oasRecon, intervention, recession, southbound, console: consoleIn } = req.body || {};
  const { store, sha } = await readStore();
  const saved = [];

  // ── P6.2 fed path ──
  if (fedPath && fedPath.price != null) {
    const price = Number(fedPath.price);
    if (!Number.isFinite(price) || price <= 90 || price >= 101) {
      return res.status(422).json({ error: `ZQ price ${fedPath.price} is out of range — expected ~90–101 (100 minus the implied rate)` });
    }
    const date = String(fedPath.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const impliedRate = zqImpliedRate(price);
    const row = {
      date, contract: fedPath.contract || null, price, impliedRate,
      effr: fedPath.effr ?? null,
      movesPriced: zqMovesPriced(impliedRate, fedPath.effr ?? null),
      enteredAt: new Date().toISOString(),
    };
    store.fedPath.series = [...store.fedPath.series.filter(r => r.date !== date), row]
      .sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    store.fedPath.latest = row;
    saved.push('fedPath');
  }

  // ── P2.5 reconciliation ──
  // Appended when a delayed OAS observation finally publishes: compare its direction to what
  // the HYG proxy said on that same date.
  if (Array.isArray(oasRecon) && oasRecon.length) {
    for (const r of oasRecon) {
      if (!r?.date) continue;
      const row = {
        date: String(r.date).slice(0, 10),
        hyg_chg: r.hyg_chg ?? null,
        hyg_qqq_divergence: r.hyg_qqq_divergence ?? null,
        oas_actual_chg: r.oas_actual_chg ?? null,
        direction_agreed: (r.hyg_chg != null && r.oas_actual_chg != null)
          // HYG DOWN implies credit stress => OAS should WIDEN. Opposite signs = agreement.
          ? (Math.sign(r.hyg_chg) !== Math.sign(r.oas_actual_chg))
          : null,
        loggedAt: new Date().toISOString(),
      };
      store.oasRecon = [...store.oasRecon.filter(x => x.date !== row.date), row]
        .sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    }
    saved.push('oasRecon');
  }

  // ── F3 intervention flag ──
  // Tested with != null rather than truthiness: this is a TOGGLE, so an explicit false must be
  // storable. A truthy test would accept turning it on and silently no-op turning it off.
  if (intervention != null) {
    const active = !!intervention.active;
    const since = intervention.since ? String(intervention.since).slice(0, 10) : null;
    if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      return res.status(422).json({ error: `intervention.since '${intervention.since}' is not YYYY-MM-DD` });
    }
    store.intervention = active
      ? { active: true, since: since || new Date().toISOString().slice(0, 10),
          note: intervention.note ? String(intervention.note).slice(0, 300) : null,
          setAt: new Date().toISOString() }
      // Clearing records WHEN it was cleared and what window it closed. A flag that simply
      // vanishes leaves the episode unauditable afterwards, and the window is the useful part.
      : { active: false, since: null, note: null, clearedAt: new Date().toISOString(),
          previousSince: store.intervention?.since ?? null };
    saved.push(active ? 'intervention:on' : 'intervention:off');
  }

  // ── Recession-source manual overrides ──
  // Keyed by the source name exactly as it appears in RECESSION_SOURCES, so an entry here
  // replaces that row's probability/as-of on the client. A cleared entry (clear:true) removes
  // the override and lets the static/auto value show through again — the same toggle discipline
  // as the intervention flag, so an override can be un-set rather than only overwritten.
  if (recession && recession.name) {
    const name = String(recession.name).slice(0, 80);
    if (recession.clear) {
      delete store.recession[name];
      saved.push('recession:clear:' + name);
    } else {
      const asOf = recession.asOf ? String(recession.asOf).slice(0, 10) : null;
      if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
        return res.status(422).json({ error: `recession.asOf '${recession.asOf}' is not YYYY-MM-DD` });
      }
      const prob = recession.probability != null ? String(recession.probability).slice(0, 16) : null;
      if (prob != null && !/\d/.test(prob)) {
        return res.status(422).json({ error: `recession.probability '${recession.probability}' has no number to parse` });
      }
      store.recession[name] = {
        probability: prob,
        asOf,
        notes: recession.notes ? String(recession.notes).slice(0, 500) : null,
        enteredAt: new Date().toISOString(),
      };
      saved.push('recession:' + name);
    }
  }

  // ── Southbound Stock Connect daily flow ──
  // One row per HK trading day: aggregate net (HKD bn, + = net buy) and the SMIC 0981.HK net.
  // Upsert by date so a re-entry corrects rather than duplicates; the client computes 5d/20d
  // trends from the series. No live HKEX feed is clean enough to trust — hand-entered like KOFIA.
  if (southbound && southbound.date) {
    const date = String(southbound.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(422).json({ error: `southbound.date '${southbound.date}' is not YYYY-MM-DD` });
    }
    const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
    const row = {
      date,
      aggregateNet: num(southbound.aggregateNet),   // HKD bn — daily Southbound net buy (a flow)
      smicHolding: num(southbound.smicHolding),     // SMIC 0981.HK Southbound holding, % of issued (a LEVEL, read off CCASS)
      notes: southbound.notes ? String(southbound.notes).slice(0, 300) : null,
      enteredAt: new Date().toISOString(),
    };
    if (row.aggregateNet == null && row.smicHolding == null) {
      return res.status(422).json({ error: 'southbound needs at least an aggregateNet or smicHolding number' });
    }
    store.southbound.series = [...store.southbound.series.filter(r => r.date !== date), row]
      .sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    saved.push('southbound:' + date);
  }

  // ── Console (Tier 3) — full-state sync, to REDIS not git ──
  // The browser owns the console state and syncs the whole object; we replace wholesale (bounded
  // by the sanitizers + slice caps) rather than upserting rows. Absent sub-keys keep what's stored,
  // so a settings-only save doesn't wipe the watchlist. This deliberately does NOT touch the git
  // store — a real book's positions and cost basis should not accrue permanent version history.
  let consoleResult = null;
  if (consoleIn && typeof consoleIn === 'object') {
    const prev = await readConsole(store.console);
    const watchlist = Array.isArray(consoleIn.watchlist)
      ? consoleIn.watchlist.map(sanitizeWatchItem).filter(Boolean).slice(0, 100)
      : (prev.watchlist || []);
    const journal = Array.isArray(consoleIn.journal)
      ? consoleIn.journal.map(sanitizeJournalItem).filter(Boolean).slice(0, 1000)
      : (prev.journal || []);
    const settings = consoleIn.settings ? sanitizeConsoleSettings(consoleIn.settings) : (prev.settings || {});
    const payload = { watchlist, journal, settings, updatedAt: new Date().toISOString() };

    if (kvConfigured()) {
      const ok = await kvSetJson(CONSOLE_KEY, payload);
      consoleResult = ok ? { stored: 'kv' } : { stored: 'failed', error: 'Redis write failed — state kept locally in your browser' };
    } else {
      // No Redis yet: say so plainly rather than silently accepting. The browser keeps its local
      // copy, so nothing is lost — it just will not follow you to another device.
      consoleResult = { stored: 'none', error: 'cross-device sync not configured (KV_REST_API_URL / KV_REST_API_TOKEN unset) — saved locally in this browser only' };
    }
    // Console never counts toward `saved`, which drives the GIT commit below.
    if (consoleResult.stored === 'kv') saved.push('console→kv');
  }

  // A console-only save has nothing to commit to git — return the KV result directly.
  const gitSaves = saved.filter(s => s !== 'console→kv');
  if (!gitSaves.length) {
    if (consoleResult) {
      return res.status(consoleResult.stored === 'failed' ? 502 : 200)
        .json({ ok: consoleResult.stored === 'kv', console: consoleResult });
    }
    return res.status(400).json({ error: 'nothing to save' });
  }

  // Console state is owned by Redis — strip it so a macro save never re-commits a real book.
  if (kvConfigured()) delete store.console;
  const content = Buffer.from(JSON.stringify(store, null, 2) + '\n', 'utf8').toString('base64');
  const w = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${DATA_PATH}`, {
    method: 'PUT', headers: ghHeaders(),
    body: JSON.stringify({
      message: `Manual entry — ${gitSaves.join(', ')} @ ${new Date().toISOString().slice(0, 10)}`,
      content, branch: process.env.GITHUB_BRANCH || 'main', ...(sha ? { sha } : {}),
    }),
  });
  if (!w.ok) return res.status(502).json({ error: 'GitHub commit failed', detail: (await w.text()).slice(0, 300) });
  return res.status(200).json({ ok: true, saved, console: consoleResult, fedPath: store.fedPath.latest, reconRows: store.oasRecon.length });
}
