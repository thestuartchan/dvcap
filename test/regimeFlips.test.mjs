// test/regimeFlips.test.mjs — where each gate on the regime card changes state.
import { regimeFlipsIf, SPLIT_BAR } from '../lib/regime.js';
import { OAS_LEVELS, OAS_ESCALATE } from '../lib/gates.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── ONE BAR, ONE HOME ───────────────────────────────────────────────────────
// Both sector cuts spoke above a literal 1.5 written twice. A threshold with two homes is a
// threshold that will one day have two values.
eq('the sector-cut bar is named', SPLIT_BAR, 1.5);

// ── THE CREDIT GATE, READ BACK FROM ITS OWN CONSTANTS ───────────────────────
{
  const calm = regimeFlipsIf({ credit: { level: 'CALM', effective: 'CALM', dir: 'rising', runs: 1, escalated: false } }, { oas: 2.84 });
  ok('CALM names the level above it, at its boundary', /credit leaves CALM \(now 2\.84\) — WATCHFUL at 3\.00/.test(calm));
  ok('and has no level below', !/below/.test(calm));
  // THE EARLIER EXIT. At tight levels the trend carries the signal, and the gate escalates on a
  // run of widening sessions before the band is reached — so the sentence says so, with the count.
  ok('and the escalation, with the run so far', /or earlier, to WATCHFUL on 3 consecutive widening sessions \(1 so far\)/.test(calm));
  eq('the escalation reads the same constant the gate runs on', OAS_ESCALATE.minRuns, 3);

  const calmFlat = regimeFlipsIf({ credit: { level: 'CALM', dir: 'flat', runs: 0 } });
  ok('a flat run is not counted toward the escalation', /consecutive widening sessions$/.test(calmFlat));
  ok('and with no OAS value none is invented', !/now/.test(calmFlat));

  const watchful = regimeFlipsIf({ credit: { effective: 'WATCHFUL', escalated: true } }, { oas: 3.4 });
  ok('WATCHFUL names both neighbours', /STRESSED at 4\.50/.test(watchful) && /CALM below 3\.00/.test(watchful));
  ok('and once escalated the earlier exit is not repeated', !/or earlier/.test(watchful));

  const top = regimeFlipsIf({ credit: { level: 'RECESSIONARY' } });
  ok('the top band has only a way down', /STRESSED below 8\.00/.test(top) && !/ at /.test(top));
  eq('the ladder read back is the ladder', OAS_LEVELS.map(l => l.label), ['CALM', 'WATCHFUL', 'STRESSED', 'RECESSIONARY']);

  // A lower-case state — the shape one payload carries — reads the same.
  ok('case does not matter', /credit leaves CALM/.test(regimeFlipsIf({ credit: { state: 'calm' } })));
  eq('an unknown level says nothing rather than guessing', regimeFlipsIf({ credit: { level: 'PURPLE' } }), null);
}

// ── THE SECTOR CUTS ─────────────────────────────────────────────────────────
{
  const quiet = regimeFlipsIf({ split: { spread: 0.4 }, aiAxis: { spread: -0.8 } });
  ok('under the bar, each cut says when it would speak', /memory vs foundry speaks at 1\.5pp \(now 0\.4pp apart\)/.test(quiet));
  ok('for both cuts', /AI vs the rest speaks at 1\.5pp \(now 0\.8pp apart\)/.test(quiet));
  const loud = regimeFlipsIf({ split: { spread: 2.3 } });
  ok('over the bar, it says when it would go quiet', /goes quiet below 1\.5pp \(now 2\.3pp apart\)/.test(loud));
  eq('a cut with no spread is skipped, not invented', regimeFlipsIf({ split: { label: 'n/a', spread: null } }), null);
}

// ── ALL TOGETHER, AND NOTHING AT ALL ────────────────────────────────────────
{
  const all = regimeFlipsIf({ credit: { level: 'CALM', dir: 'falling', runs: 2 }, split: { spread: 0.4 }, aiAxis: { spread: 2.0 } }, { oas: 2.7 });
  eq('the three join on a middle dot', all.split(' · ').length, 3);
  eq('an empty regime is null, not an empty sentence', regimeFlipsIf({}), null);
  eq('and so is nothing', regimeFlipsIf(null), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
