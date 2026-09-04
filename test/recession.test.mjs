import { horizonOf, HORIZON, consensusFor, calendarWindow, blockOf, dispersionRead, consensusVintage } from '../lib/recession.js';
let p=0,f=0;const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`));ok?p++:f++;};

// horizon classification
eq('horizon 12-month', horizonOf('12-month'), HORIZON.ROLLING);
eq('horizon End-2026', horizonOf('End-2026'), HORIZON.CALENDAR);
eq('horizon End-2027', horizonOf('End-2027'), HORIZON.CALENDAR);
eq('horizon qualitative', horizonOf('qualitative'), null);

// blocks
eq('block kalshi', blockOf('Kalshi prediction market'), 'market-implied');
eq('block polymarket', blockOf('Polymarket'), 'market-implied');
eq('block goldman', blockOf('Goldman Sachs'), null);

// calendar window shrink
const w=calendarWindow('2026-08-25',2026);
eq('cal monthsLeft', w.monthsLeft, 4.2);
eq('cal shrinking', w.shrinking, true);
eq('cal Jun not shrinking', calendarWindow('2026-06-01',2026).shrinking, false);
eq('cal expired', calendarWindow('2027-01-05',2026).expired, true);

// THE KEY TEST: horizon separation
const rows=[
 {name:'NY Fed Yield Curve Model',prob:15,weight:0.20,recency:1,timeframe:'12-month',year:2026},
 {name:'Goldman Sachs',prob:15,weight:0.20,recency:0.667,timeframe:'12-month',year:2026},
 {name:'Kalshi prediction market',prob:22,weight:0.10,recency:1,timeframe:'End-2026',year:2026},
 {name:'Polymarket',prob:12.5,weight:0.10,recency:1,timeframe:'End-2026',year:2026},
 {name:'JPMorgan',prob:35,weight:0.15,recency:0.017,timeframe:'12-month',year:2026,archived:true},
 {name:'BNP Paribas',prob:null,weight:0,recency:1,timeframe:'12-month',year:2026},
];
const roll=consensusFor(rows,HORIZON.ROLLING);
const cal=consensusFor(rows,HORIZON.CALENDAR);
console.log('\n  rolling12m ->', JSON.stringify({v:roll.value,n:roll.nSources,eff:roll.nEffective,range:[roll.lo,roll.hi]}));
console.log('  calendar   ->', JSON.stringify({v:cal.value,n:cal.nSources,eff:cal.nEffective,range:[cal.lo,cal.hi]}),'\n');
eq('rolling excludes archived', roll.nSources, 2);
eq('rolling value', roll.value, 15);
eq('calendar rows', cal.nSources, 2);
eq('calendar DEDUPED to 1 view', cal.nEffective, 1);   // Kalshi+Polymarket = one block
eq('calendar keeps raw dispersion', [cal.lo,cal.hi], [12.5,22]);

// dispersion
eq('wide spread flagged', dispersionRead({value:20,spread:16,lo:12,hi:28}).wide, true);
eq('tight spread ok', dispersionRead({value:15,spread:3,lo:14,hi:17}).wide, false);

// ── CONSENSUS VINTAGE — the age must tick and the deferral must expire ────────────────────────
// Both were hardcoded prose ("2 months stale", "deferred to after Aug 7 and Aug 28"). The whole
// bug class is a stamp that cannot change, so every test here MOVES THE CLOCK — asserting the
// output at one instant would have passed against the frozen strings too.
const VB = { asOf: '2026-06-30', gatedOn: [
  { date: '2026-08-07', label: 'July Employment Situation' },
  { date: '2026-08-28', label: 'BLS benchmark revision' },
]};
const at = iso => consensusVintage(VB, new Date(iso + 'T00:00:00Z'));

eq('vintage label from asOf', at('2026-09-04').label, 'as of Jun 2026');
// The age TICKS. This is the assertion the hardcoded string could never have satisfied.
eq('age same-month', at('2026-07-10').staleNote, 'current');
eq('age 1 month singular', at('2026-08-05').staleNote, '1 month stale');
eq('age 2 months', at('2026-09-04').staleNote, '2 months stale');
eq('age 12 months later', at('2027-07-04').staleNote, '12 months stale');

// The deferral EXPIRES. Before the last gating release it is deferred and nothing is owed;
// after it, the refresh is due — the state the dashboard was silently stuck on the wrong side of.
eq('both releases pending -> not due', at('2026-08-01').refreshDue, false);
eq('pending names both', at('2026-08-01').dueNote,
   'refresh deferred until July Employment Situation and BLS benchmark revision');
eq('one landed -> still deferred', at('2026-08-15').refreshDue, false);
eq('one landed names only the outstanding one', at('2026-08-15').dueNote,
   'refresh deferred until BLS benchmark revision');
eq('last release landed -> DUE', at('2026-08-29').refreshDue, true);
eq('due note names the release that landed', at('2026-08-29').dueNote,
   'refresh is DUE — BLS benchmark revision landed 2026-08-28 and the inputs have not been rebuilt since');
eq('deferredUntil cleared once due', at('2026-08-29').deferredUntil, null);
// The boundary: a release landing TODAY has landed. > not >=, or the card claims a deferral on
// the morning the number it was waiting for is already published.
eq('release day itself counts as landed', at('2026-08-28').refreshDue, true);

// Unknown is never green — an undatable vintage reports as unverified and DUE, not as fresh.
eq('no asOf -> age unknown', consensusVintage({ gatedOn: [] }).staleNote, 'age unknown');
eq('no asOf -> due', consensusVintage({ gatedOn: [] }).refreshDue, true);
eq('garbage asOf -> age unknown', consensusVintage({ asOf: 'soon', gatedOn: [] }).staleNote, 'age unknown');
// No gating releases at all is not a deferral either.
eq('no gates -> due', consensusVintage({ asOf: '2026-06-30', gatedOn: [] }, new Date('2026-09-04T00:00:00Z')).refreshDue, true);

console.log(f?`\n❌ ${f} FAILED`:`\n✅ ALL ${p} PASSED`);
process.exit(f?1:0);
