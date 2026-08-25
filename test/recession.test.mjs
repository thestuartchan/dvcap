import { horizonOf, HORIZON, consensusFor, calendarWindow, blockOf, dispersionRead } from '../lib/recession.js';
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

console.log(f?`\n❌ ${f} FAILED`:`\n✅ ALL ${p} PASSED`);
process.exit(f?1:0);
