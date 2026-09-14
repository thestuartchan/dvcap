// test/ledger.test.mjs — every hand-kept input in one list, with the rule that applies to it.
import { handKeptLedger, LEDGER_STATES } from '../lib/ledger.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);
const NOW = new Date('2026-09-14T14:00:00Z');   // Monday
const find = (l, key) => l.rows.find(r => r.key === key);

// ── KOFIA: TWO BUSINESS DAYS, THEN STALE ─────────────────────────────────────
{
  const fresh = handKeptLedger({ kofia: { foreignNet: { asOf: '2026-09-11' }, deposits: { asOf: '2026-09-10' }, units7709: { asOf: '2026-09-11' } }, now: NOW });
  eq('Friday flows are fresh on Monday', find(fresh, 'kofiaFlows').state, 'fresh');
  eq('Wednesday balances are fresh on Monday — two business days, weekend-tolerant', find(fresh, 'kofiaBalances').state, 'fresh');
  const stale = handKeptLedger({ kofia: { foreignNet: { asOf: '2026-09-09' } }, now: NOW });
  eq('Wednesday flows are stale by Monday', find(stale, 'kofiaFlows').state, 'stale');
  ok('and the rule says suppressed, not footnoted', /SUPPRESSED/.test(find(stale, 'kofiaFlows').rule));
  eq('never entered is missing', find(stale, 'kofia7709').state, 'missing');
}

// ── MANUAL ENTRIES: EACH WITH ITS OWN RULE ───────────────────────────────────
{
  const manual = {
    fedPath: { latest: { date: '2026-09-08' } },                       // 4 business days
    ism: { latest: { asOf: '2026-08-01', manufacturing: 49 } },        // 44 days
    secYields: { USFR: { asOf: '2026-08-25' } },                       // 20 days
    southbound: { series: [{ date: '2026-09-01' }] },                  // 13 days
    intervention: null,
    recession: { 'Goldman Sachs': { probability: 22, asOf: '2026-03-10' }, JPMorgan: { probability: 30, asOf: '2026-08-30' } },
  };
  const l = handKeptLedger({ manual, now: NOW });
  eq('a Fed path settle four business days old is stale — the derived count is suppressed', [find(l, 'fedPath').state, find(l, 'fedPath').bizDays], ['stale', 4]);
  eq('an ISM entry past 35 days is stale — excluded from the axis', find(l, 'ism').state, 'stale');
  eq('a USFR yield past two weeks is due, still shown', find(l, 'usfr').state, 'due');
  eq('Southbound past a trading week is stale', find(l, 'southbound').state, 'stale');
  eq('an unset intervention flag is retired — nothing to keep', find(l, 'intervention').state, 'retired');
  eq('an override past 180 days is stale — its weight is zero', find(l, 'override:Goldman Sachs').state, 'stale');
  eq('a fresh override is fresh', find(l, 'override:JPMorgan').state, 'fresh');
  const fresh = handKeptLedger({ manual: { fedPath: { latest: { date: '2026-09-11' } }, ism: { latest: { asOf: '2026-09-01', manufacturing: 49 } } }, now: NOW });
  eq('Friday\'s settle is fresh on Monday', find(fresh, 'fedPath').state, 'fresh');
  eq('an ISM entered on the first is fresh on the fourteenth', find(fresh, 'ism').state, 'fresh');
}

// ── SOURCE CONSTANTS ─────────────────────────────────────────────────────────
{
  const consts = {
    consensusVintage: { asOf: '2026-06-30', refreshDue: true, dueNote: 'refresh is DUE' },
    recessionSources: [
      { name: 'Goldman Sachs', asOf: '2026-06-26', source: 'static' },
      { name: 'NY Fed Yield Curve Model', asOf: '2026-09-11', source: 'auto' },
      { name: 'Kalshi prediction market', year: 2027, asOf: '2026-09-07', source: 'static' },
    ],
    recessionCadence: { 'Goldman Sachs': 120, 'Kalshi prediction market': 1 },
    fedLanguage: { lastUpdated: '2026-08-19' }, sepOdds: { asOf: '2026-08-24' },
    analystBoard: { asOf: '2026-06-29', cadence: 90 }, recessionProse: { asOf: '2026-08-24', cadence: 30 },
    announced: { pceCore: { label: 'June core PCE', period: '2026-06-01', released: '2026-07-30', fredAsOf: '2026-07-01' },
                 gdpGrowth: { label: 'Q2 GDP', period: '2026-04-01', released: '2026-07-30', fredAsOf: '2026-01-01' } },
  };
  const l = handKeptLedger({ consts, now: NOW });
  eq('a consensus whose refresh is due is due, with the haircut named', [find(l, 'consensus').state, /DECAYED/.test(find(l, 'consensus').rule)], ['due', true]);
  eq('a static Goldman row 80 days old is inside its 120-day cadence', find(l, 'src:Goldman Sachs').state, 'fresh');
  ok('a live-fed row is not a hand-kept input', !find(l, 'src:NY Fed Yield Curve Model'));
  eq('the 2027 Kalshi static row, a week old against a one-day cadence, is due', find(l, 'src:Kalshi prediction market').state, 'due');
  eq('Fed language 26 days old is inside 49', find(l, 'fedLanguage').state, 'fresh');
  eq('hike odds three weeks old are past their week', find(l, 'sepOdds').state, 'due');
  eq('the analyst board at 77 days is inside 90', find(l, 'analystBoard').state, 'fresh');
  eq('the recession prose at 21 days is inside 30', find(l, 'recessionProse').state, 'fresh');
  eq('an announced print FRED has reached is retired', find(l, 'announced:pceCore').state, 'retired');
  eq('one it has not is still in use', find(l, 'announced:gdpGrowth').state, 'fresh');
}

// ── DATA FILES ───────────────────────────────────────────────────────────────
{
  const l = handKeptLedger({ files: { holidaysThrough: '2026-12-31', calendar: { upcoming14: 3, lastDate: '2026-12-30' } }, now: NOW });
  eq('a holiday file with 108 days left is fresh', [find(l, 'holidays').state, find(l, 'holidays').days], ['fresh', 108]);
  const soon = handKeptLedger({ files: { holidaysThrough: '2026-10-31', calendar: { upcoming14: 0, lastDate: '2026-09-20' } }, now: NOW });
  eq('under 60 days of coverage is due', find(soon, 'holidays').state, 'due');
  eq('a calendar with nothing in the next fortnight is due — silence is the failure mode', find(soon, 'calendar').state, 'due');
  ok('and the rule says so', /silent/.test(find(soon, 'calendar').rule));
  const raw = handKeptLedger({ files: { calendarEvents: [{ date: '2026-09-16' }, { date: '2026-09-26' }, { date: '2026-12-30' }] }, now: NOW });
  eq('raw events are counted against the injected clock', [find(raw, 'calendar').state, /2 events in the next 14 days · last entered 2026-12-30/.test(find(raw, 'calendar').note)], ['fresh', true]);
}

// ── ORDER AND COUNTS ─────────────────────────────────────────────────────────
{
  const l = handKeptLedger({ manual: { fedPath: { latest: { date: '2026-09-01' } }, ism: { latest: { asOf: '2026-09-01', manufacturing: 49 } } }, kofia: { foreignNet: { asOf: '2026-09-11' } }, now: NOW });
  eq('stale first, then missing, then due, then fresh', l.rows.map(r => r.state).filter((s, i, a) => a.indexOf(s) === i), ['stale', 'missing', 'fresh', 'retired', 'undated']);
  ok('counts cover every state', LEDGER_STATES.every(s => typeof l.counts[s] === 'number'));
  eq('the ledger is dated', l.asOf, '2026-09-14');
  ok('every row says what happens when late and where it is kept', l.rows.every(r => r.rule && r.where && r.effect));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
