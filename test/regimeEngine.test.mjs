// test/regimeEngine.test.mjs — one regime engine, two callers.
//
// The pipeline moved out of src/App.jsx so the pre-read cron can compute the regime the dashboard
// would show and write the daily row without a browser. These tests pin the composed pipeline on
// a synthetic indicators payload with the clock injected, and the log's merge rule.
import { regimeSnapshot, regimeLogRow, mergeRecessionSources, RECESSION_SOURCES, recessionSrcKey, FALLBACK_REGIMES } from '../lib/regimeEngine.js';
import { mergeRegimeRow, nextRows, HAS_CONTENT } from '../lib/regimeLog.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);

const NOW = new Date('2026-09-14T12:42:00Z');
const months = (n, gen) => Array.from({ length: n }, (_, i) => ({ date: `2025-${String(i + 1).padStart(2, '0')}-01`, value: gen(i) }));
const IND = {
  cpiHeadlineCurrent: 3.1, cpi: 3.1, pceCoreCurrent: 3.34, pceCoreHistory: [{ value: 3.4 }, { value: 3.34 }],
  gdpGrowth: 1.5, gdpGrowthPrev: 2.1, asOf: { gdpGrowth: '2026-04-01', pceCoreCurrent: '2026-07-01' },
  creditSpread: 2.7, tenY: 4.1, twoY: 3.6,
  labor: {
    u3: { ok: true, value: 4.3, delta: 0.1, date: '2026-08-01' },
    empPop: { ok: true, value: 58.8, delta: -0.1, date: '2026-08-01' },
    payrolls: { ok: true, value: 159000, delta: 22, date: '2026-08-01', history: months(14, i => 158000 + i * 30) },
  },
  recessionFeeds: {
    'NY Fed Yield Curve Model': { probability: 15, asOf: '2026-09-11', note: 'live' },
    'Kalshi prediction market': { probability: 5, asOf: '2026-09-12' },
    'Kalshi prediction market 2027': { probability: 25, asOf: '2026-09-12' },
    'Polymarket': { probability: 7, asOf: '2026-09-12' },
  },
};

// ── THE SNAPSHOT ─────────────────────────────────────────────────────────────
{
  const s = regimeSnapshot(IND, { now: NOW });
  const d = s.derivedRegimes;
  ok('the engine produces the four probabilities', d && [d.stagflation, d.reflationary, d.deflationary, d.inflationary].every(Number.isFinite));
  eq('and they sum to 100', d.stagflation + d.reflationary + d.deflationary + d.inflationary, 100);
  ok('the live regime is the argmax', ['stag', 'ref', 'def', 'inf'].includes(s.liveRegimeId) && s.liveRegime.id === s.liveRegimeId);
  eq('the clock is the date the row will carry', s.nowIso, '2026-09-14');
  ok('the vintage is graded from the same run', ['fresh', 'decayed', 'expired', 'unknown'].includes(s.regimeVintage.grade));
  ok('the announced July labour overlay retired once FRED carried August', s.laborAnnounced === false && s.laborView.empPop.value === 58.8);
  eq('the 12-month payroll average is derived from the history when there is no fixture', s.laborTwelveMoK, 30);
  const again = regimeSnapshot(IND, { now: NOW });
  eq('the same payload and clock give the same regime — the engine is a function', [again.derivedRegimes, again.liveRegimeId], [d, s.liveRegimeId]);
  const later = regimeSnapshot(IND, { now: new Date('2027-03-01T12:00:00Z') });
  ok('and a later clock decays the consensus further, not the same', (later.regimeVintage.alive ?? 0) <= (s.regimeVintage.alive ?? 1));
}
{
  const s = regimeSnapshot({}, { now: NOW });
  ok('an empty payload still resolves a regime from the static table rather than throwing', s.liveRegime && s.liveRegimeId);
  eq('the fallback split is the named constant', FALLBACK_REGIMES.stagflation, 48);
}

// ── PRECEDENCE: MANUAL > FEED > STATIC ───────────────────────────────────────
{
  const feeds = { 'Goldman Sachs': { probability: 30, asOf: '2026-09-10' } };
  const manual = { 'Goldman Sachs': { probability: 22, asOf: '2026-09-12', enteredAt: '2026-09-12T10:00:00Z' } };
  const rows = mergeRecessionSources(RECESSION_SOURCES, feeds, manual);
  const gs = rows.find(r => r.name === 'Goldman Sachs');
  eq('a manual override outranks a feed', [gs.probability, gs.source], ['22%', 'manual']);
  const auto = mergeRecessionSources(RECESSION_SOURCES, feeds, {}).find(r => r.name === 'Goldman Sachs');
  eq('a feed outranks the static row', [auto.probability, auto.source], ['30%', 'auto']);
  const stat = mergeRecessionSources(RECESSION_SOURCES, {}, {}).find(r => r.name === 'Goldman Sachs');
  eq('and the static row is the last resort', stat.source, 'static');
  eq('the two Kalshi rows key apart', recessionSrcKey({ name: 'Kalshi prediction market', year: 2027 }), 'Kalshi prediction market 2027');
}

// ── THE ROW ──────────────────────────────────────────────────────────────────
{
  const s = regimeSnapshot(IND, { now: NOW });
  const row = regimeLogRow(s, { extra: { inputs: { oas: 2.7, tenY: 4.1, twoY: 3.6 } } });
  eq('a cron row is dated by the snapshot clock and marked cron', [row.date, row.source], ['2026-09-14', 'cron']);
  eq('the view and the pin are null on the server — it has no browser to know them from', [row.view_regime, row.pinned], [null, null]);
  ok('the raw inputs are carried so the row is re-runnable', row.inputs.weightedRecessionProb != null && row.inputs.cpi === 3.1 && row.inputs.oas === 2.7);
  eq('and so is the vintage it was computed under', [row.inputs.regimeVintage != null, row.inputs.consensusAlive != null], [true, true]);
  eq('what the server cannot know is null, not invented', [row.hawkish_repricing, row.hyg_chg, row.inputs.tape], [null, null, null]);
  const client = regimeLogRow(s, { source: 'client', extra: { view_regime: 'def', pinned: true, hyg_chg: -0.4 } });
  eq('the client row carries what only it knows', [client.source, client.view_regime, client.pinned, client.hyg_chg], ['client', 'def', true, -0.4]);
}

// ── MERGE, NOT REPLACE ───────────────────────────────────────────────────────
{
  // A real cron row carries null for the view and the pin — regimeLogRow leaves them so.
  const cron = { date: '2026-09-14', stagflation_p: 45, reflationary_p: 25, deflationary_p: 25, inflationary_p: 5, live_regime: 'stag', view_regime: null, pinned: null,
    hawkish_repricing: null, hyg_chg: null, inputs: { cpi: 3.1, oas: 2.7, tape: null }, source: 'cron' };
  const client = { date: '2026-09-14', stagflation_p: 46, reflationary_p: 24, deflationary_p: 25, inflationary_p: 5, live_regime: 'stag', view_regime: 'def', pinned: true,
    hawkish_repricing: 'STAGFLATION', hyg_chg: -0.4, inputs: { cpi: 3.1, oas: null, tape: { spy: -0.3 } }, source: 'client' };
  const m = mergeRegimeRow(cron, client);
  eq('a later write updates the probabilities', m.stagflation_p, 46);
  eq('and fills what the earlier one could not know', [m.hawkish_repricing, m.hyg_chg, m.view_regime, m.pinned], ['STAGFLATION', -0.4, 'def', true]);
  eq('but a null never overwrites a value', m.inputs.oas, 2.7);
  eq('nested inputs merge the same way', m.inputs.tape, { spy: -0.3 });
  eq('provenance is a set', m.source, 'client+cron');
  const back = mergeRegimeRow(m, { ...cron, stagflation_p: 44 });
  eq('the cron writing again the next morning keeps the client fields', [back.stagflation_p, back.hyg_chg, back.view_regime], [44, -0.4, 'def']);
  eq('a first write on a date is stored as-is', mergeRegimeRow(null, cron).source, 'cron');
}
{
  const rows = [{ date: '2026-09-11', stagflation_p: 40 }, { date: '2026-09-12' }, { date: '2026-09-13', reflationary_p: 30 }];
  const next = nextRows(rows, { date: '2026-09-14', stagflation_p: 45, source: 'cron' });
  eq('a new date is appended and the husk with no probabilities is purged', next.map(r => r.date), ['2026-09-11', '2026-09-13', '2026-09-14']);
  ok('rows are content-checked by the shared predicate', HAS_CONTENT(rows[0]) && !HAS_CONTENT(rows[1]));
  const same = nextRows(next, { date: '2026-09-14', hyg_chg: -0.2, source: 'client' });
  eq('a same-date write merges rather than duplicating', [same.length, same.at(-1).stagflation_p, same.at(-1).hyg_chg, same.at(-1).source], [3, 45, -0.2, 'client+cron']);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
