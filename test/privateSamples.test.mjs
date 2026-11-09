// test/privateSamples.test.mjs — the private channel's "one of every type" test (lib/privateSamples.js).
import { privateSamples } from '../lib/privateSamples.js';
import { SOURCES } from '../lib/alerts.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const s = privateSamples(new Date('2026-11-09T15:00:00Z'));
const privateSources = Object.entries(SOURCES).filter(([, v]) => v.channel === 'private').map(([k]) => k).sort();
eq('a sample for every private message type, plus the connection test', s.map(x => x.source).filter(x => x !== 'test').sort(), privateSources);
eq('every sample builds a Discord embed', s.every(x => x.payload?.embeds?.length > 0), true);
eq('every sample except the connection test says TEST in its title', s.filter(x => x.source !== 'test').every(x => x.payload.embeds.every(e => e.title.startsWith('TEST · '))), true);
eq('no sample can mention anyone', s.every(x => JSON.stringify(x.payload.allowed_mentions) === '{"parse":[]}'), true);
eq('placeholder tickers only', s.every(x => !/\b(QQQ|SPY)\b/.test(JSON.stringify(x.payload))), true);
console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
