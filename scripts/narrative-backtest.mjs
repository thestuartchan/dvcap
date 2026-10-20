#!/usr/bin/env node
// scripts/narrative-backtest.mjs — does the Signal Board's Narrative row (lib/signalBoard.js narrativeState,
// GDELT AI build-out coverage and tone) say anything about the next 1 / 3 / 5 sessions of SOXX and QQQ?
//
// Uses the board's own functions (parseTimeline, joinNarrative, narrativeMetrics, narrativeState), so the
// test and the live row cannot drift. GDELT daily from 2017-01 (as far back as the DOC API's timelines
// go); Yahoo daily opens and closes.
//
// TIMING, NO LOOK-AHEAD. A GDELT day is a UTC day; it completes at 00:00 UTC = 20:00 New York, after the
// US close. So the signal for session S is the state through the last UTC day BEFORE S, and the trade is
// entered at S's OPEN: the 1-session return is open(S) → close(S), 3 is open(S) → close(S+2), 5 → close(S+4).
// The 3- and 5-session windows overlap day to day, so their n overstates the independent samples.
//
// Usage:  NODE_USE_ENV_PROXY=1 node scripts/narrative-backtest.mjs [--cache DIR]
//   --cache DIR reads/writes DIR/{timelinevolraw,timelinetone,QQQ,SOXX}.json instead of refetching.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gdeltUrl, parseTimeline, joinNarrative } from '../lib/narrativeFeed.js';
import { narrativeMetrics, narrativeState } from '../lib/signalBoard.js';

const argi = process.argv.indexOf('--cache');
const CACHE = argi > 0 ? process.argv[argi + 1] : null;
if (CACHE) mkdirSync(CACHE, { recursive: true });
const NOW = new Date();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cached(name, get) {
  const p = CACHE ? `${CACHE}/${name}.json` : null;
  if (p && existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const j = await get();
  if (p) writeFileSync(p, JSON.stringify(j));
  return j;
}
async function gdelt(mode) {
  const url = gdeltUrl(mode, { start: new Date('2017-01-01T00:00:00Z'), end: NOW });
  for (let k = 0; k < 8; k++) {
    await sleep(k ? 30000 : 6000);           // GDELT: one request per five seconds, and it remembers
    try {
      const r = await fetch(url);
      const t = await r.text();
      if (r.ok && t.trim().startsWith('{')) return JSON.parse(t);
      console.error(`GDELT ${mode}: HTTP ${r.status}, retrying`);
    } catch (e) { console.error(`GDELT ${mode}: ${e.cause?.code || e.message}, retrying`); }
  }
  throw new Error(`GDELT ${mode}: gave up`);
}
async function yahoo(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&period1=1483228800&period2=${Math.floor(NOW / 1000)}`;
  const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo ${sym} HTTP ${r.status}`);
  return r.json();
}
const bars = (j) => {
  const res = j.chart.result[0], q = res.indicators.quote[0];
  return res.timestamp.map((t, i) => ({ date: new Date((t - 4 * 3600) * 1000).toISOString().slice(0, 10), open: q.open[i], close: q.close[i] }))
    .filter(b => Number.isFinite(b.open) && Number.isFinite(b.close));
};

// Spearman with average ranks for ties.
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}
function spearman(x, y) {
  const rx = ranks(x), ry = ranks(y), n = x.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const mean = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 1000) / 1000 : null);

const vol = await cached('timelinevolraw', () => gdelt('timelinevolraw'));
const tone = await cached('timelinetone', () => gdelt('timelinetone'));
const px = { QQQ: bars(await cached('QQQ', () => yahoo('QQQ'))), SOXX: bars(await cached('SOXX', () => yahoo('SOXX'))) };

const daily = joinNarrative(parseTimeline(vol, 'timelinevolraw', { now: NOW }), parseTimeline(tone, 'timelinetone', { now: NOW }));
const sig = [];   // ascending {date, state, dTone, cov}
for (let i = 0; i < daily.length; i++) {
  const m = narrativeMetrics(daily, i);
  if (m?.cov_5v20 == null || m.tone_chg5 == null) continue;
  sig.push({ date: m.as_of, state: narrativeState(m.cov_5v20, m.tone_chg5), dTone: m.tone_chg5, cov: m.cov_5v20 });
}
const covs = sig.map(s => s.cov).sort((a, b) => a - b), dts = sig.map(s => s.dTone).sort((a, b) => a - b);
const q = (a, p) => a[Math.floor(p * (a.length - 1))];
console.log(`GDELT days ${daily.length} (${daily[0]?.date} → ${daily.at(-1)?.date}); signal days ${sig.length}`);
console.log(`quartiles: coverage 5d vs 20d p25 ${q(covs, 0.25)}% / p75 ${q(covs, 0.75)}%; tone change p25 ${q(dts, 0.25)} / p75 ${q(dts, 0.75)}`);
const share = (st) => pct(sig.filter(s => s.state === st).length, sig.length);
console.log(`state mix (all days): on ${share('on')}% · neutral ${share('neutral')}% · off ${share('off')}%`);

function run(from, to, label) {
  console.log(`\n== ${label}: sessions ${from} → ${to}`);
  for (const t of ['SOXX', 'QQQ']) {
    const b = px[t];
    for (const k of [1, 3, 5]) {
      const obs = [];
      let si = 0;
      for (let j = 0; j + k - 1 < b.length; j++) {
        const S = b[j].date;
        if (S < from || S > to) continue;
        while (si + 1 < sig.length && sig[si + 1].date < S) si++;
        const s = sig[si];
        if (!s || s.date >= S || (Date.parse(S) - Date.parse(s.date)) / 864e5 > 4) continue;
        obs.push({ ...s, ret: (b[j + k - 1].close / b[j].open - 1) * 100 });
      }
      const on = obs.filter(o => o.state === 'on'), off = obs.filter(o => o.state === 'off'), neu = obs.filter(o => o.state === 'neutral');
      const up = obs.filter(o => o.ret > 0).length;
      const rhoS = spearman(obs.map(o => (o.state === 'on' ? 1 : o.state === 'off' ? -1 : 0)), obs.map(o => o.ret));
      const rhoT = spearman(obs.map(o => o.dTone), obs.map(o => o.ret));
      console.log(`${t} ${k}d  n ${obs.length} · base up ${pct(up, obs.length)}% · ON n ${on.length} up ${pct(on.filter(o => o.ret > 0).length, on.length)}% mean ${mean(on.map(o => o.ret))}% · OFF n ${off.length} down ${pct(off.filter(o => o.ret < 0).length, off.length)}% (base down ${pct(obs.length - up, obs.length)}%) mean ${mean(off.map(o => o.ret))}% · NEUTRAL mean ${mean(neu.map(o => o.ret))}% · Spearman state ${rhoS.toFixed(3)} · tone-change ${rhoT.toFixed(3)}`);
    }
  }
}
const last = px.QQQ.at(-1).date;
run('2017-02-01', last, 'FULL');
run('2017-02-01', '2022-12-31', 'PRE-CHATGPT (2017-02 → 2022)');
run('2023-01-01', last, 'AI BUILD-OUT ERA (2023 →)');
