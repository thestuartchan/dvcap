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

const DATA_PATH = 'data/manual_entry.json';

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
  if (!r.ok) return { store: { fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, recession: {} }, sha: null };
  const meta = await r.json();
  let store = { fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, recession: {} };
  try { store = JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8')); } catch { /* default */ }
  store.fedPath ||= { latest: null, series: [] };
  store.fedPath.series ||= [];
  store.oasRecon ||= [];
  store.intervention ??= null;
  store.recession ||= {};   // manual overrides for the Wall Street recession sources
  store.southbound ||= { series: [] };   // HKEX Southbound Stock Connect daily flow (hand-entered)
  store.southbound.series ||= [];
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

export default async function handler(req, res) {
  if (req.method === 'GET') {
    if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
      return res.status(200).json({ fedPath: { latest: null, series: [] }, oasRecon: [], intervention: null, note: 'store not configured' });
    }
    try {
      const { store } = await readStore();
      res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
      return res.status(200).json({
        fedPath: { latest: store.fedPath.latest, series: store.fedPath.series.slice(-120) },
        oasRecon: store.oasRecon.slice(-180),
        intervention: store.intervention,
        recession: store.recession,
        southbound: { series: store.southbound.series.slice(-60) },
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

  const { fedPath, oasRecon, intervention, recession, southbound } = req.body || {};
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

  if (!saved.length) return res.status(400).json({ error: 'nothing to save' });

  const content = Buffer.from(JSON.stringify(store, null, 2) + '\n', 'utf8').toString('base64');
  const w = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${DATA_PATH}`, {
    method: 'PUT', headers: ghHeaders(),
    body: JSON.stringify({
      message: `Manual entry — ${saved.join(', ')} @ ${new Date().toISOString().slice(0, 10)}`,
      content, branch: process.env.GITHUB_BRANCH || 'main', ...(sha ? { sha } : {}),
    }),
  });
  if (!w.ok) return res.status(502).json({ error: 'GitHub commit failed', detail: (await w.text()).slice(0, 300) });
  return res.status(200).json({ ok: true, saved, fedPath: store.fedPath.latest, reconRows: store.oasRecon.length });
}
