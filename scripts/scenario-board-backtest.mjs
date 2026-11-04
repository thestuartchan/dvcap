#!/usr/bin/env node
// scripts/scenario-board-backtest.mjs — how often each scenario on the board (lib/scenarioBoard.js) was
// active over ten years, how long it lasted, and what SPY, QQQ, SMH, equal-weight and TLT did next.
//
// It runs the board's own evaluateBoard over the whole history (keepDays), so the test and the live
// board cannot drift. Yahoo daily bars, the same symbols the board fetches, plus RSP for the
// equal-weight read.
//
// TIMING, NO LOOK-AHEAD. The board is read on a settled close. A scenario that switches ACTIVE on the
// close of session S is acted on at the NEXT session's open: the 20-session return is open(S+1) →
// close(S+20). Episodes are runs of ACTIVE sessions; two runs fewer than 4 sessions apart are one
// episode (a leg dipping under its exit line for a day is not a new event). The base is the same
// return from every session, active or not.
//
// Usage:  NODE_USE_ENV_PROXY=1 node scripts/scenario-board-backtest.mjs [--cache DIR] [--out FILE]
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { yahooDailyOHLC } from '../lib/yahoo.js';
import { evaluateBoard, BOARD_SYMBOLS, SCENARIO_DEFS, GROUPS, alignCloses, WINDOW, VOL_LOOKBACK } from '../lib/scenarioBoard.js';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const CACHE = arg('--cache');
const OUT = arg('--out');
const RANGE = arg('--range') || '10y';
const HORIZON = 20;
const MERGE_GAP = 3;
if (CACHE) mkdirSync(CACHE, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function bars(sym) {
  const p = CACHE ? `${CACHE}/${sym.replace(/[^A-Za-z0-9]/g, '_')}-${RANGE}.json` : null;
  if (p && existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  let b = [];
  for (let k = 0; k < 3 && !b.length; k++) { if (k) await sleep(2000); b = await yahooDailyOHLC(sym, RANGE); }
  if (p && b.length) writeFileSync(p, JSON.stringify(b));
  return b;
}

const EXTRA = ['RSP'];
const syms = [...new Set([...BOARD_SYMBOLS, ...EXTRA])];
const all = {};
for (const s of syms) { all[s] = await bars(s); await sleep(150); }
const missing = syms.filter(s => !all[s]?.length);
if (missing.length) { console.error('no bars for', missing.join(', ')); process.exit(1); }

// Settled sessions only: drop a bar dated today (a live print while the US session trades).
const today = new Date().toISOString().slice(0, 10);
for (const s of syms) all[s] = all[s].filter(b => b.date < today);

const boardBars = Object.fromEntries(BOARD_SYMBOLS.map(s => [s, all[s].map(b => ({ date: b.date, close: b.close }))]));
const n = all.SPY.length;
const history = n - Math.max(WINDOW, VOL_LOOKBACK) - 1;
const t0 = Date.now();
const board = evaluateBoard(boardBars, { history, keepDays: true });
const dates = board.scenarios[0].days.map(d => d.date);
console.error(`board walked ${dates.length} sessions (${dates[0]} → ${dates.at(-1)}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Opens and closes on the board's calendar.
const cal = alignCloses({ SPY: all.SPY.map(b => ({ date: b.date, close: b.close })) }, 'SPY').dates;
const idx = Object.fromEntries(cal.map((d, i) => [d, i]));
const col = (sym, field) => {
  const by = Object.fromEntries(all[sym].map(b => [b.date, b[field]]));
  let last = null;
  return cal.map(d => (by[d] != null && by[d] > 0 ? (last = +by[d]) : last));
};
const px = Object.fromEntries(['SPY', 'QQQ', 'SMH', 'RSP', 'TLT'].map(s => [s, { o: col(s, 'open'), c: col(s, 'close') }]));
// open(S+1) → close(S+H), log return in %.
const fwd = (sym, i) => {
  const o = px[sym].o[i + 1], c = px[sym].c[i + HORIZON];
  return o && c ? 100 * Math.log(c / o) : null;
};
const TARGETS = [
  { key: 'SPY', f: (i) => fwd('SPY', i) },
  { key: 'QQQ', f: (i) => fwd('QQQ', i) },
  { key: 'SMH', f: (i) => fwd('SMH', i) },
  { key: 'EW−SPY', f: (i) => { const a = fwd('RSP', i), b = fwd('SPY', i); return a == null || b == null ? null : a - b; } },
  { key: 'TLT', f: (i) => fwd('TLT', i) },
];
const median = (xs) => { const v = xs.filter(x => x != null).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const upShare = (xs) => { const v = xs.filter(x => x != null); return v.length ? v.filter(x => x > 0).length / v.length : null; };

const base = {};
for (const t of TARGETS) {
  const xs = dates.map(d => t.f(idx[d]));
  base[t.key] = { median: median(xs), up: upShare(xs) };
}

const activeOn = Object.fromEntries(board.scenarios.map(s => [s.id, s.days.map(d => d.status === 'ACTIVE')]));
const results = board.scenarios.map(s => {
  const st = s.days.map(d => d.status);
  const N = st.length;
  const active = st.filter(x => x === 'ACTIVE').length;
  const building = st.filter(x => x === 'BUILDING').length;
  // Episodes, merging short gaps.
  const eps = [];
  for (let k = 0; k < N; k++) {
    if (st[k] !== 'ACTIVE') continue;
    const prev = eps.at(-1);
    if (prev && k - prev.end <= MERGE_GAP + 1) prev.end = k;
    else eps.push({ start: k, end: k });
    while (k + 1 < N && st[k + 1] === 'ACTIVE') { k++; eps.at(-1).end = k; }
  }
  const lens = eps.map(e => e.end - e.start + 1);
  const starts = eps.map(e => idx[dates[e.start]]);
  const after = Object.fromEntries(TARGETS.map(t => {
    const xs = starts.map(i => t.f(i));
    return [t.key, { median: median(xs), up: upShare(xs), n: xs.filter(x => x != null).length }];
  }));
  // Which other scenario was most often ACTIVE on the same days.
  const mine = activeOn[s.id];
  const overlap = board.scenarios.filter(o => o.id !== s.id).map(o => {
    const both = mine.filter((a, k) => a && activeOn[o.id][k]).length;
    return { id: o.id, name: o.name, share: active ? both / active : 0 };
  }).sort((a, b) => b.share - a.share)[0];
  // The same, split at the window's midpoint: does it hold in both halves?
  const mid = idx[dates[Math.floor(dates.length / 2)]];
  const halves = [starts.filter(i => i < mid), starts.filter(i => i >= mid)].map(ss => Object.fromEntries(
    ['SPY', 'SMH', 'EW−SPY'].map(k => { const t = TARGETS.find(x => x.key === k); const xs = ss.map(i => t.f(i)); return [k, { median: median(xs), n: xs.filter(x => x != null).length }]; })));
  return {
    halves,
    id: s.id, name: s.name, group: s.group, side: s.side, now: s.status,
    activePct: 100 * active / N, buildingPct: 100 * building / N,
    episodes: eps.length, medianLen: median(lens), longest: lens.length ? Math.max(...lens) : 0,
    lastEpisode: eps.length ? dates[eps.at(-1).start] : null,
    after, overlap,
  };
});

// ── REPORT ───────────────────────────────────────────────────────────────────
const NEW = new Set(['SL', 'RR', 'EX', 'RF', 'RO', 'DR', 'AR']);
const f1 = (x) => (x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`);
const pct = (x) => (x == null ? '—' : `${Math.round(100 * x)}%`);
const lines = [];
lines.push(`# Scenario board backtest`);
lines.push('');
lines.push(`- **Window:** ${dates[0]} → ${dates.at(-1)}, ${dates.length} sessions (Yahoo daily, ${RANGE})`);
lines.push(`- **Engine:** \`evaluateBoard\` from lib/scenarioBoard.js, walked over every session — same legs, thresholds and hysteresis as the live board`);
lines.push(`- **Episode:** a run of ACTIVE sessions; runs ${MERGE_GAP} or fewer sessions apart are merged`);
lines.push(`- **After:** open of the session after the scenario switches on → close ${HORIZON} sessions later, log %, median across episodes; "up" = share of episodes positive`);
lines.push(`- **Base:** the same ${HORIZON}-session return from every session: SPY ${f1(base.SPY.median)}% (${pct(base.SPY.up)} up), QQQ ${f1(base.QQQ.median)}% (${pct(base.QQQ.up)}), SMH ${f1(base.SMH.median)}% (${pct(base.SMH.up)}), equal-weight − SPY ${f1(base['EW−SPY'].median)} pts (${pct(base['EW−SPY'].up)}), TLT ${f1(base.TLT.median)}% (${pct(base.TLT.up)})`);
lines.push(`- **Small samples:** most scenarios have 10–40 episodes in ten years. Treat a median from fewer than 15 as a hint, not a rate.`);
lines.push('');
lines.push(`## How often, and for how long`);
lines.push('');
lines.push(`| Scenario | Group | Now | Active % of sessions | Building % | Episodes | Median length | Longest | Last started | Most often alongside |`);
lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
const gl = Object.fromEntries(GROUPS.map(g => [g.id, g.label]));
for (const r of results) {
  lines.push(`| ${NEW.has(r.id) ? '**' + r.name + '** (new)' : r.name} | ${gl[r.group] || r.group} | ${r.now.toLowerCase()} | ${r.activePct.toFixed(0)}% | ${r.buildingPct.toFixed(0)}% | ${r.episodes} | ${r.medianLen ?? '—'} | ${r.longest} | ${r.lastEpisode ?? '—'} | ${r.overlap && r.overlap.share > 0 ? `${r.overlap.name} (${pct(r.overlap.share)})` : '—'} |`);
}
lines.push('');
lines.push(`## What followed over the next ${HORIZON} sessions (median %, share of episodes up)`);
lines.push('');
lines.push(`| Scenario | n | SPY | QQQ | SMH | Equal-weight − SPY | TLT |`);
lines.push(`|---|---|---|---|---|---|---|`);
lines.push(`| *Base (every session)* | ${dates.length} | ${f1(base.SPY.median)} · ${pct(base.SPY.up)} | ${f1(base.QQQ.median)} · ${pct(base.QQQ.up)} | ${f1(base.SMH.median)} · ${pct(base.SMH.up)} | ${f1(base['EW−SPY'].median)} · ${pct(base['EW−SPY'].up)} | ${f1(base.TLT.median)} · ${pct(base.TLT.up)} |`);
for (const r of results) {
  const a = r.after;
  lines.push(`| ${NEW.has(r.id) ? '**' + r.name + '**' : r.name} | ${a.SPY.n} | ${f1(a.SPY.median)} · ${pct(a.SPY.up)} | ${f1(a.QQQ.median)} · ${pct(a.QQQ.up)} | ${f1(a.SMH.median)} · ${pct(a.SMH.up)} | ${f1(a['EW−SPY'].median)} · ${pct(a['EW−SPY'].up)} | ${f1(a.TLT.median)} · ${pct(a.TLT.up)} |`);
}
lines.push('');
const midDate = dates[Math.floor(dates.length / 2)];
const baseHalf = [dates.slice(0, dates.length >> 1), dates.slice(dates.length >> 1)].map(ds => Object.fromEntries(
  ['SPY', 'SMH', 'EW−SPY'].map(k => { const t = TARGETS.find(x => x.key === k); return [k, median(ds.map(d => t.f(idx[d])))]; })));
lines.push(`## Does it hold in both halves? (${dates[0]} → ${midDate} | ${midDate} → ${dates.at(-1)}; median ${HORIZON}-session %, n episodes)`);
lines.push('');
lines.push(`| Scenario | SPY 1st | SPY 2nd | SMH 1st | SMH 2nd | EW−SPY 1st | EW−SPY 2nd |`);
lines.push(`|---|---|---|---|---|---|---|`);
lines.push(`| *Base* | ${f1(baseHalf[0].SPY)} | ${f1(baseHalf[1].SPY)} | ${f1(baseHalf[0].SMH)} | ${f1(baseHalf[1].SMH)} | ${f1(baseHalf[0]['EW−SPY'])} | ${f1(baseHalf[1]['EW−SPY'])} |`);
for (const r of results) {
  const [h1, h2] = r.halves;
  const c = (h, k) => `${f1(h[k].median)} (${h[k].n})`;
  lines.push(`| ${NEW.has(r.id) ? '**' + r.name + '**' : r.name} | ${c(h1, 'SPY')} | ${c(h2, 'SPY')} | ${c(h1, 'SMH')} | ${c(h2, 'SMH')} | ${c(h1, 'EW−SPY')} | ${c(h2, 'EW−SPY')} |`);
}
lines.push('');
const md = lines.join('\n') + '\n';
if (OUT) writeFileSync(OUT, md);
process.stdout.write(md);
if (process.argv.includes('--json')) writeFileSync((OUT || 'scenario-board-backtest.md').replace(/\.md$/, '.json'), JSON.stringify({ base, results }, null, 2));
void SCENARIO_DEFS;
