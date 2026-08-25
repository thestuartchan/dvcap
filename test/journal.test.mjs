// Regression tests for lib/journal.js — honest regime attribution and closed-trade measures.
import { regimeOnDate, closeTrade, performanceByRegime } from '../lib/journal.js';
let pass=0,fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};

// A slice of the real log shape.
const HIST=[
 {date:'2026-08-05',live_regime:'stag',stagflation_p:55,reflationary_p:20,deflationary_p:20,inflationary_p:5},
 {date:'2026-08-12',live_regime:'stag',stagflation_p:65,reflationary_p:5,deflationary_p:25,inflationary_p:5},
 {date:'2026-08-21',live_regime:'stag',stagflation_p:65,reflationary_p:5,deflationary_p:25,inflationary_p:5},
];

// Exact hit
eq('exact date hit', regimeOnDate(HIST,'2026-08-12').regime, 'stag');
eq('exact flagged exact', regimeOnDate(HIST,'2026-08-12').exact, true);
eq('carries probs', regimeOnDate(HIST,'2026-08-12').probs.stag, 65);

// Weekend / non-logged day falls back to the PRIOR session, and says so.
eq('falls back to prior session', regimeOnDate(HIST,'2026-08-15').date, '2026-08-12');
eq('prior-session not exact', regimeOnDate(HIST,'2026-08-15').exact, false);

// THE KEY CASE: a trade older than the log must NOT borrow today's regime.
eq('predates log -> null regime', regimeOnDate(HIST,'2026-06-01').regime, null);
eq('predates log -> explains why', /before the regime log begins/.test(regimeOnDate(HIST,'2026-06-01').note), true);
eq('no history -> null', regimeOnDate([],'2026-08-12').regime, null);
eq('no date -> null', regimeOnDate(HIST,null).regime, null);

// Closing: R needs a stop.
const withStop = closeTrade({entry:100,stop:95,exit:110,shares:10});
eq('R computed with stop', withStop.realizedR, 2);
eq('measure is R', withStop.measure, 'R');
eq('pnl', withStop.pnl, 100);
eq('pct', withStop.pctReturn, 10);

const noStop = closeTrade({entry:100,exit:110,shares:10});
eq('no stop -> no R', noStop.realizedR, null);
eq('no stop -> measure pct', noStop.measure, 'pct');
eq('no stop -> explains', /no R to compute/.test(noStop.note), true);

// Shorts invert.
const short = closeTrade({entry:100,stop:105,exit:90,shares:10,side:'short'});
eq('short profits when price falls', short.realizedR, 2);
eq('short win', short.win, true);
eq('missing exit rejected', closeTrade({entry:100}).ok, false);

// Performance grouping
const J=[
 {entryPrice:100,exitPrice:110,realizedR:2,pctReturn:10,regimeAtEntryId:'stag'},
 {entryPrice:100,exitPrice:95,realizedR:-1,pctReturn:-5,regimeAtEntryId:'stag'},
 {entryPrice:50,exitPrice:55,realizedR:null,pctReturn:10,regimeAtEntryId:null},   // unknown regime
];
const p=performanceByRegime(J);
eq('total closed', p.totalClosed, 3);
eq('stag bucket n', p.rows.find(r=>r.regime==='stag').n, 2);
eq('stag avg R', p.rows.find(r=>r.regime==='stag').avgR, 0.5);
eq('stag win rate', p.rows.find(r=>r.regime==='stag').winRate, 50);
eq('unknown kept separate', !!p.rows.find(r=>r.regime==='unknown'), true);
eq('single regime not comparable', p.comparable, false);
eq('says why not comparable', /nothing to compare yet/.test(p.note), true);

// Two regimes -> comparable
const J2=[...J,{entryPrice:10,exitPrice:12,realizedR:1,pctReturn:20,regimeAtEntryId:'ref'}];
eq('two regimes comparable', performanceByRegime(J2).comparable, true);
eq('empty journal note', /No closed trades yet/.test(performanceByRegime([]).note), true);

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
