// test/overviewRegions.test.mjs — the Daily Overview's lead region and per-region stamps.
import { leadRegion, regionStamps } from '../lib/overviewRegions.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

const all = { asia: { region: 'asia' }, eu: { region: 'eu' }, us: { region: 'us' } };
eq('in All, the US leads whatever order the selection is in', leadRegion(['asia', 'eu', 'us'], all), 'us');
eq('without the US loaded, Europe, then Asia', [leadRegion(['asia', 'eu', 'us'], { asia: {}, eu: {} }), leadRegion(['asia', 'us'], { asia: {} })], ['eu', 'asia']);
eq('a single region leads itself', leadRegion(['asia'], all), 'asia');
eq('nothing loaded is no lead', leadRegion(['us'], {}), null);

const now = new Date('2026-10-18T09:00:00Z');
const rows = regionStamps(['asia', 'eu', 'us'], {
  updatedBy: { us: '2026-10-18T08:55:00Z', eu: '2026-10-17T08:00:00Z' },
  errorBy: { asia: 'Fetch error: HTTP 504' }, byRegion: { us: {}, eu: {} }, now });
eq('one row per region, in lead order', rows.map(r => r.region), ['us', 'eu', 'asia']);
eq('each with its own age and error', rows.map(r => [r.old, r.error, r.loaded]), [[false, null, true], [true, null, true], [false, 'Fetch error: HTTP 504', false]]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
