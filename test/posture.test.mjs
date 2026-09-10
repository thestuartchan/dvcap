// test/posture.test.mjs — the tape stance card, and the day it printed RISK-ON on a risk-off tape.
import { composePosture, tapeRead, regimeBlock, applyRegimeGuard,
         REGIME_BLOCK_PCT, TAPE_LEGS } from '../lib/posture.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// ── THE 2026-09-10 RENDER, REBUILT FROM THE BRIEF ────────────────────────────
// 13:28Z. The card read RISK-ON in green. On the same screen: gold −0.64%, BTC −1.71%,
// QQQ −1.28%, NQ through its prior low, USD/KRW +7.21 with Korea Stress ACTIVE, DXY up,
// 2 of 6 tripwires leaning de-risking, and the header's own regime label reading Stagflation 71%.
//
// Every number below is from that render. ATRs are the instruments' ordinary daily ranges.
const TAPE_0910 = {
  equity: { value: -1.28, atr: 1.20 },   // QQQ
  gold:   { value: -0.64, atr: 1.00 },   // GLD
  btc:    { value: -1.71, atr: 2.40 },
  dxy:    { value:  0.31, atr: 0.35 },
};
const LEANING_0910 = { tripped: 2, usable: 6, unavailable: [] };
const VOL_CONTANGO = { regime: 'CONTANGO' };
// FRED published on the 9th; this observation is from the 8th, read after the publish hour.
const CREDIT_CALM_STALE = { level: 'CALM', effective: 'calm',
  obs: { available: true, obsDate: '2026-09-08', bizDays: 2 } };
const NOW = new Date('2026-09-10T13:28:00Z');

{
  const p = composePosture({ scenarios: [], leaning: LEANING_0910, volTerm: VOL_CONTANGO,
    credit: CREDIT_CALM_STALE, tape: TAPE_0910, now: NOW });

  // THE DEFECT ITSELF.
  ok('the stance is not RISK-ON', p.posture !== 'RISK-ON');
  ok('and it is not green', p.tone !== 'green');
  // NAMING THE CONFLICT IS THE USEFUL OUTPUT. Picking the structural side publishes a green
  // light; picking the tape side throws away the fact that the options market is not
  // corroborating. The brief asked for the sentence, so the sentence is the assertion.
  eq('it names the conflict', p.posture, 'MIXED — vol structure calm, tape risk-off');
  eq('in amber', p.tone, 'amber');

  // THE TAPE IS A REQUIRED INPUT AND IT IS VISIBLE.
  eq('the tape reads risk-off', p.tape.direction, 'risk-off');
  eq('on all four legs', p.tape.riskOff.length, 4);
  ok('equity is one of them', p.tape.riskOff.includes('equity'));
  ok('and BTC another', p.tape.riskOff.includes('btc'));
  // Gold falling WITH equities is the rates-repricing signature, not a flight bid — and it is
  // still risk-off. The direction sets the flavour, not the sign.
  ok('gold votes risk-off and says which kind', p.tape.riskOff.includes('gold'));
  ok('naming the signature', /rates-repricing/.test(p.tape.legs.find(l => l.name === 'gold').why));
  // A dollar bid is risk-off; DXY +0.31% clears half of its 0.35 ATR, so it counts.
  eq('a dollar bid votes risk-off', p.tape.legs.find(l => l.name === 'dxy').vote, -1);
  // The floor is real, though: the same direction inside half the range says nothing.
  eq('the same direction under half its range does not vote',
     tapeRead({ dxy: { value: 0.09, atr: 0.35 } }).legs.find(l => l.name === 'dxy').vote, 0);

  // THE TAPE APPEARS IN THE PROSE, WHICH IS WHERE THE READER LOOKS.
  ok('the NOT row carries the tape', p.not.some(l => /tape risk-off/.test(l)));

  // GUARD 4 — A STANCE RESTING ON A STALE INPUT IS DOWNGRADED, NOT PUBLISHED.
  ok('the stale credit gate is flagged', p.creditStale === true);
  ok('and it is marked where it is claimed as working', p.working.some(l => /credit calm ⚠ stale/.test(l)));
  ok('and it is a stated reason RISK-ON was withheld', p.blockedBy.some(b => /stale observation/.test(b)));

  // WHY NOT RISK-ON — the audit trail.
  ok('the tripwire count withholds it', p.blockedBy.some(b => /2\/6 tripwires/.test(b)));
  ok('and so does the tape', p.blockedBy.some(b => /tape is risk-off/.test(b)));
}

// ── GUARD 2: NON-ZERO TRIPWIRES BAR RISK-ON BY CONSTRUCTION ──────────────────
// "2/6 leaning de-risking" beside "RISK-ON" is incoherent however calm the structure is. One
// fired gauge is enough: the old ratio steps meant 2/6 (0.33) contributed exactly nothing.
{
  const quiet = { equity: { value: 0.9, atr: 1.2 }, gold: { value: 0.2, atr: 1.0 },
                  btc: { value: 2.0, atr: 2.4 }, dxy: { value: -0.4, atr: 0.35 } };
  const clean = composePosture({ scenarios: [], leaning: { tripped: 0, usable: 6, unavailable: [] },
    volTerm: VOL_CONTANGO, credit: { level: 'CALM', effective: 'calm' }, tape: quiet, now: NOW });
  eq('a genuinely calm tape with nothing fired earns RISK-ON', clean.posture, 'RISK-ON');
  eq('and nothing is withholding it', clean.blockedBy, []);

  const oneFired = composePosture({ scenarios: [], leaning: { tripped: 1, usable: 6, unavailable: [] },
    volTerm: VOL_CONTANGO, credit: { level: 'CALM', effective: 'calm' }, tape: quiet, now: NOW });
  ok('one fired tripwire is enough to withhold it', oneFired.posture !== 'RISK-ON');
  eq('and it says RISK-ON is what was withheld', oneFired.withheld, 'RISK-ON');
  ok('naming the count', oneFired.blockedBy.some(b => /1\/6 tripwires/.test(b)));
}

// ── ABSENCE OF EVIDENCE IS NOT A GREEN LIGHT ─────────────────────────────────
// The original scored zero when nothing fired AND when nothing was looking, and published both
// as RISK-ON.
{
  const dark = composePosture({ scenarios: [], leaning: { tripped: 0, usable: 0, unavailable: [] },
    volTerm: VOL_CONTANGO, credit: { level: 'CALM', effective: 'calm' }, tape: {}, now: NOW });
  ok('a board with no tape does not print RISK-ON', dark.posture !== 'RISK-ON');
  eq('nothing at all is NO SIGNAL', dark.posture, 'NO SIGNAL');
  eq('and the tape says so rather than reading calm', dark.tape.direction, 'unavailable');
}
{
  // A leg with a value but no scale gets no vote — magnitude cannot be judged without a range.
  const t = tapeRead({ equity: -1.28, gold: { value: -0.64, atr: 1.0 } });
  eq('an unscaled leg is unreadable, not calm', t.legs.find(l => l.name === 'equity').vote, null);
  ok('and says why', /no ATR/.test(t.legs.find(l => l.name === 'equity').why));
}

// ── GOLD ABSTAINS WHEN EQUITIES ARE NOT FALLING ──────────────────────────────
// Gold rising while equities rise is a debasement bid, not a risk-appetite statement, and
// scoring it either way would put a thumb on the scale.
{
  const t = tapeRead({ equity: { value: 1.4, atr: 1.2 }, gold: { value: -1.2, atr: 1.0 },
                       btc: { value: 3.0, atr: 2.4 }, dxy: { value: -0.5, atr: 0.35 } });
  eq('gold abstains on a rising tape', t.legs.find(l => l.name === 'gold').vote, 0);
  ok('and says why', /says nothing about risk appetite/.test(t.legs.find(l => l.name === 'gold').why));
  eq('the tape still reads risk-on off the other legs', t.direction, 'risk-on');
}

// ── A SPLIT TAPE IS MIXED, NOT A COIN FLIP CALLED EITHER WAY ─────────────────
{
  const t = tapeRead({ equity: { value: -1.5, atr: 1.2 }, btc: { value: 3.0, atr: 2.4 },
                       dxy: { value: -0.5, atr: 0.35 }, gold: { value: -1.2, atr: 1.0 } });
  eq('two each way is mixed', t.direction, 'mixed');
  ok('and the phrase carries both sides', /against/.test(t.phrase));
}
{
  const t = tapeRead({ equity: { value: 0.1, atr: 1.2 }, btc: { value: 0.2, atr: 2.4 },
                       dxy: { value: 0.01, atr: 0.35 }, gold: { value: 0.1, atr: 1.0 } });
  eq('everything inside its own range is quiet, not risk-on', t.direction, 'quiet');
}
eq('the leg set is the one the brief named', TAPE_LEGS, ['equity', 'gold', 'btc', 'dxy']);

// ── GUARD 3: THE REGIME AXIS ─────────────────────────────────────────────────
// Different axes, and they are allowed to differ — but not opposed in the same header row.
{
  eq('stagflation above the threshold blocks', typeof regimeBlock({ label: 'Stagflation', pct: 71 }), 'string');
  eq('below it does not', regimeBlock({ label: 'Stagflation', pct: REGIME_BLOCK_PCT - 1 }), null);
  eq('a benign regime does not', regimeBlock({ label: 'Reflationary Growth', pct: 88 }), null);
  eq('and neither does a missing probability', regimeBlock({ label: 'Stagflation' }), null);

  const green = { posture: 'RISK-ON', tone: 'green', blockedBy: [] };
  const guarded = applyRegimeGuard(green, { label: 'Stagflation', pct: 71 });
  eq('the guard downgrades the stance', guarded.posture, 'NEUTRAL, SELECTIVE');
  eq('to amber', guarded.tone, 'amber');
  eq('recording what was withheld', guarded.withheld, 'RISK-ON');
  ok('and why', guarded.blockedBy.some(b => /Stagflation 71%/.test(b)));
  // IT NEVER MANUFACTURES RISK-OFF. The regime is not a statement about today's tape.
  const red = { posture: 'RISK-OFF', tone: 'red' };
  eq('a risk-off stance is untouched', applyRegimeGuard(red, { label: 'Stagflation', pct: 71 }), red);
  eq('and no regime is a no-op', applyRegimeGuard(green, null), green);
}

// ── THE WATCH ROW RENDERS ON EVERY STANCE ────────────────────────────────────
// It vanished on 2026-09-10. The old resolution took the top confirmed scenario, else the
// nearest with proximity > 0 — and on a board where nothing was confirmed and everything scored
// 0/2, nothing had positive proximity and the row was simply dropped. An uncertain stance is
// when the flip condition matters MOST.
{
  const zeroed = [
    { id: 'C', name: 'HAWKISH RETURNS', side: 'adverse', weight: 6, met: 0, total: 2,
      confirmed: false, broken: false, proximity: 0, watch: '30Y back below 5.35%' },
    { id: 'B', name: 'DURATION LEG BREAKS', side: 'supportive', weight: 6, met: 0, total: 2,
      confirmed: false, broken: false, proximity: 0, watch: 'TLT — a resumed bid flips this back to A' },
  ];
  const p = composePosture({ scenarios: zeroed, leaning: LEANING_0910, volTerm: VOL_CONTANGO,
    credit: CREDIT_CALM_STALE, tape: TAPE_0910, now: NOW });
  ok('a board of nothing-confirmed still names a watch', !!p.watch);

  // A BROKEN scenario is not something to watch — it is over.
  const allBroken = zeroed.map(s => ({ ...s, broken: true, proximity: -1 }));
  const q = composePosture({ scenarios: allBroken, leaning: LEANING_0910, volTerm: VOL_CONTANGO,
    credit: CREDIT_CALM_STALE, tape: TAPE_0910, now: NOW });
  ok('with every scenario over, the watch falls back to what is holding the stance', !!q.watch);
  ok('and points at a real blocker', q.blockedBy.some(b => q.watch.startsWith(b)));
}

// ── RISK-OFF STILL FIRES ─────────────────────────────────────────────────────
// The guards withhold a green light; they must not smother a red one.
{
  const p = composePosture({
    scenarios: [{ id: 'D', name: 'DISORDERLY', side: 'adverse', weight: 9, met: 2, total: 2,
                  confirmed: true, broken: false, proximity: 1, watch: 'HY OAS', consequence: 'Insurance scenario' }],
    leaning: { tripped: 5, usable: 6, unavailable: [] },
    volTerm: { regime: 'BACKWARDATION' },
    credit: { level: 'STRESS', effective: 'stress' },
    tape: TAPE_0910, now: NOW,
  });
  eq('a stressed board still reads RISK-OFF', p.posture, 'RISK-OFF');
  eq('in red', p.tone, 'red');
  ok('and the confirmed consequence still reaches DO', p.do.includes('Insurance scenario'));
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
