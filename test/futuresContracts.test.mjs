// test/futuresContracts.test.mjs — a future is a contract, not a share.
import { FAMILIES, MULTIPLIER, familyOf, parentFamily, isIndexFamily, lastTradeDate, rollBy, contractMonths, monthSymbol, frontMonth,
         termStructure, gapTest, rollLine, looksLikeSpread, bizDaysFrom } from '../lib/futuresContracts.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };
const ok = (n, c) => eq(n, !!c, true);
const H = ['2026-09-07', '2026-11-26', '2026-12-25'];

// ── FAMILIES ─────────────────────────────────────────────────────────────────
{
  eq('the brief\'s multipliers', [MULTIPLIER.CL, MULTIPLIER.MCL, MULTIPLIER.NG, MULTIPLIER.GC, MULTIPLIER.MGC, MULTIPLIER.ES, MULTIPLIER.MES, MULTIPLIER.NQ, MULTIPLIER.MNQ, MULTIPLIER.NKD, MULTIPLIER['6J'], MULTIPLIER.MJY, MULTIPLIER.ZN, MULTIPLIER.BZ],
     [1000, 100, 10000, 100, 10, 50, 5, 20, 2, 5, 12500000, 1250000, 1000, 1000]);
  eq('every spelling of crude is CL', [familyOf('CL=F'), familyOf('CLZ26'), familyOf('CLZ26.NYM'), familyOf('cl'), familyOf('CL Dec-26')], ['CL', 'CL', 'CL', 'CL', 'CL']);
  eq('the micro is its own family with CL as parent', [familyOf('MCL=F'), parentFamily('MCL'), FAMILIES.CL.micro], ['MCL', 'CL', 'MCL']);
  eq('a stock is not a family', [familyOf('WTI'), familyOf('QQQ'), familyOf(''), familyOf(null)], [null, null, null, null]);
  eq('index families are the market', [isIndexFamily('ES'), isIndexFamily('MES'), isIndexFamily('MNQ'), isIndexFamily('NKD'), isIndexFamily('CL'), isIndexFamily('GC'), isIndexFamily('6J')], [true, true, true, true, false, false, false]);
  eq('physical delivery where the brief says', [FAMILIES.CL.physical, FAMILIES.MCL.physical, FAMILIES.NG.physical, FAMILIES.GC.physical, FAMILIES.ES.physical, FAMILIES['6J'].physical, FAMILIES.BZ.physical, FAMILIES.ZN.physical], [true, true, true, true, false, false, false, false]);
  eq('COIL is priced through BZ and says so', [parentFamily('COIL'), monthSymbol('COIL', 2026, 12), !!FAMILIES.COIL.note], ['BZ', 'BZZ26.NYM', true]);
  eq('the feed symbol for a month', [monthSymbol('CL', 2026, 11), monthSymbol('MCL', 2026, 12), monthSymbol('ES', 2026, 12), monthSymbol('GC', 2026, 12), monthSymbol('6J', 2026, 12), monthSymbol('ZN', 2026, 12)],
     ['CLX26.NYM', 'MCLZ26.NYM', 'ESZ26.CME', 'GCZ26.CMX', '6JZ26.CME', 'ZNZ26.CBT']);
}

// ── DATES, AGAINST KNOWN CONTRACTS ───────────────────────────────────────────
{
  eq('business days back skip weekends and holidays', [bizDaysFrom('2026-11-30', 3, H), bizDaysFrom('2026-09-08', 1, H)], ['2026-11-24', '2026-09-04']);
  eq('CL Nov-26 stops 20 Oct (25 Oct is a Sunday)', lastTradeDate('CL', 2026, 11, H), '2026-10-20');
  eq('CL Dec-26 stops 20 Nov', lastTradeDate('CL', 2026, 12, H), '2026-11-20');
  eq('MCL follows CL', lastTradeDate('MCL', 2026, 12, H), '2026-11-20');
  eq('BZ Dec-26 stops on the last business day of October', lastTradeDate('BZ', 2026, 12, H), '2026-10-30');
  eq('NG Nov-26 stops three business days before 1 Nov', lastTradeDate('NG', 2026, 11, H), '2026-10-28');
  eq('GC Dec-26 stops on the third-last business day of December', lastTradeDate('GC', 2026, 12, H), '2026-12-29');
  eq('ES Dec-26 stops on the third Friday', lastTradeDate('ES', 2026, 12, H), '2026-12-18');
  eq('6J Dec-26 stops two business days before the third Wednesday', lastTradeDate('6J', 2026, 12, H), '2026-12-14');
  eq('ZN Dec-26 stops seven business days before month end', lastTradeDate('ZN', 2026, 12, H), '2026-12-21');
  eq('the roll-by is three business days earlier', rollBy('2026-11-20', H), '2026-11-17');
  eq('an unknown family has no rule', lastTradeDate('ZZZ', 2026, 12, H), null);
}

// ── THE MONTH LIST ───────────────────────────────────────────────────────────
{
  const ms = contractMonths('CL', { today: '2026-09-22', count: 3, holidays: H });
  // 22 Sep 2026 IS Oct-26's last trading day (three business days before Fri 25 Sep): listed, with
  // no days left, and not the default. Nov-26 stops 20 Oct — 28 days — and is the front.
  eq('CL from 22 Sep: Oct on its last day, then Nov and Dec',
     ms.map(x => [x.label, x.code, x.lastTrade, x.days]), [['Oct-26', 'CLV26', '2026-09-22', 0], ['Nov-26', 'CLX26', '2026-10-20', 28], ['Dec-26', 'CLZ26', '2026-11-20', 59]]);
  eq('the default month is the first with a day left — Nov-26 (CLX6), 28 days', [frontMonth(ms).code, frontMonth(ms).days], ['CLX26', 28]);
  ok('each carries a roll-by for a physical family', ms.every(x => x.rollBy));
  const es = contractMonths('ES', { today: '2026-09-22', count: 2, holidays: H });
  eq('ES lists the quarterly cycle only', es.map(x => x.label), ['Dec-26', 'Mar-27']);
  eq('…and no roll-by, being cash-settled', es[0].rollBy, null);
  const gc = contractMonths('GC', { today: '2026-09-22', count: 2, holidays: H });
  eq('GC lists its even-month cycle', gc.map(x => x.label), ['Oct-26', 'Dec-26']);
  eq('an unknown family lists nothing', contractMonths('ZZZ', { today: '2026-09-22' }), []);
}

// ── THE THREE LINES ──────────────────────────────────────────────────────────
{
  const nov = { code: 'CLX26', label: 'Nov-26', y: 2026, m: 11, price: 92.27 };
  const dec = { code: 'CLZ26', label: 'Dec-26', y: 2026, m: 12, price: 89.04 };
  const t = termStructure(nov, dec);
  eq('Nov over Dec is backwardation, −$3.23, −3.5%/mo', [t.spread, t.pctPerMonth, t.shape, t.months], [-3.23, -3.5, 'backwardation', 1]);
  ok('and the carry sentence is the brief\'s', t.carry === 'long earns convergence, short pays it' && /backwardation/.test(t.text));
  eq('contango the other way', termStructure({ ...nov, price: 80 }, { ...dec, price: 82 }).carry, 'long pays convergence, short earns it');
  eq('the front against itself is no line', termStructure(nov, nov), null);
  const g = gapTest({ contracts: 2, price: 89.04, multiplier: 100, nlv: 212000 });
  eq('2 MCL at 89.04: $17,808; a 5% day is $890, 0.42% NLV; 10% is $1,781', [g.notional, g.five.usd, g.five.pctNlv, g.ten.usd, g.ten.pctNlv], [17808, 890.4, 0.42, 1780.8, 0.84]);
  const r = rollLine({ lastTrade: '2026-11-20', days: 59, rollBy: '2026-11-17' }, 'CL');
  ok('the roll line carries the physical warning', r.physical && /roll by 2026-11-17/.test(r.text) && !r.amber);
  ok('six days out is amber and still a line', rollLine({ lastTrade: '2026-09-28', days: 6, rollBy: '2026-09-23' }, 'CL').amber);
  ok('a cash-settled family says so', /cash-settled/.test(rollLine({ lastTrade: '2026-12-18', days: 87, rollBy: null }, 'ES').text));
  eq('a spread typed as one symbol is recognised', [looksLikeSpread('COIL Z6-Z7'), looksLikeSpread('CLZ26/CLF27'), looksLikeSpread('CL=F'), looksLikeSpread('MCL')], [true, true, false, false]);
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
