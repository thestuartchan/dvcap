// test/breadthLadder.test.mjs — how the breadth ladder and SMH − SOXX read (lib/regimeState.js,
// lib/concentration.js). Made-up numbers.
import { concentrationLadder, LADDER_SPREAD_ALERT } from '../lib/regimeState.js';
import { smhSoxxTell } from '../lib/concentration.js';
import { monetizationGate } from '../lib/monetization.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// A semis-led selloff, out of order lower down.
const down = concentrationLadder({ SMH: -3.0, QQQ: -2.2, SPY: -1.0, IWM: -1.5, HYG: -0.3 });
eq('the gap is given as a size, with the end that moved most', [down.span, down.direction], [2.7, 'down']);
eq('the signed spread the rule uses is unchanged', down.spread, -2.7);
eq('the words carry it, with no minus sign', down.note, 'not in order (2.7pp from SMH to HYG, SMH weakest) — no single-theme signature');
eq('out of order lower down (IWM below SPY), a selloff does not alert', down.alert, false);
// Both directions: a strictly ordered selloff past the threshold now alerts.
const rout = concentrationLadder({ SMH: -3.6, QQQ: -2.4, SPY: -1.5, IWM: -1.2, HYG: -0.3 });
eq('a strictly ordered semis-led selloff alerts', [rout.alert, rout.alertDirection, rout.ordered], [true, 'down', 'down']);
eq('and says so in words, not a sign', rout.note.startsWith('single-theme selloff: SMH < QQQ < SPY < IWM < HYG in order, 3.3pp'), true);
eq('a narrow ordered selloff does not', concentrationLadder({ SMH: -1.0, QQQ: -0.8, SPY: -0.5, IWM: -0.4, HYG: -0.1 }).alert, false);
eq('monotonic keeps its old meaning (top rung strongest)', [rout.monotonic, concentrationLadder({ SMH: 3.4, QQQ: 2.1, SPY: 1.2, IWM: 0.6, HYG: 0.1 }).monotonic], [false, true]);

const up = concentrationLadder({ SMH: 3.4, QQQ: 2.1, SPY: 1.2, IWM: 0.6, HYG: 0.1 });
eq('an ordered rally wider than the threshold still alerts, as before', [up.alert, up.spread > LADDER_SPREAD_ALERT], [true, true]);
eq('and keeps its wording', up.note, 'single-theme move: SMH > QQQ > SPY > IWM > HYG in order, 3.3pp top-to-bottom');
const narrow = concentrationLadder({ SMH: 1.0, QQQ: 0.8, SPY: 0.5, IWM: 0.4, HYG: 0.1 });
eq('ordered but narrow names its size and direction', narrow.note, 'ordered but narrow (0.9pp, SMH strongest) — participation is broader');

// SMH − SOXX in words for the day it is.
const r = (smh, soxx) => smhSoxxTell({ smh: { changePct: smh }, soxx: { changePct: soxx } });
eq('up day, SMH ahead: mega-cap leadership', r(2.0, 1.2).reading, 'mega-cap-only leadership');
eq('down day, SMH ahead: mega-caps held up better', r(-3.0, -3.8).reading, 'mega-caps held up better than the rest of the semis');
eq('up day, SOXX ahead: broadening', r(1.0, 1.9).reading, 'cycle broadening (picks-and-shovels confirming)');
eq('down day, SOXX ahead: mega-caps fell harder', r(-3.0, -2.1).reading, 'mega-caps fell harder than the rest of the semis');
eq('the tone follows the gap as before', [r(-3.0, -3.8).tone, r(-3.0, -2.1).tone], ['amber', 'green']);

// Software vs hardware: a day both fell says "fell less", not "leading". The state is unchanged.
const FLAT = Array.from({ length: 30 }, () => ({ spread: 0.3 }));
const bothDown = monetizationGate({ soft: -4.0, hard: -2.5, pure: -4.1, softHard: FLAT, softPure: FLAT });
eq('both down: hardware fell less, software fell more', /fell less and IGV fell more/.test(bothDown.why || bothDown.note || JSON.stringify(bothDown)), true);
const hardUp = monetizationGate({ soft: -1.5, hard: 1.0, pure: -1.4, softHard: FLAT, softPure: FLAT });
eq('hardware up: still "leading"', /is leading and IGV is falling/.test(JSON.stringify(hardUp)), true);
eq('the state is the same either way', [bothDown.candidate ?? bothDown.state, hardUp.candidate ?? hardUp.state].every(v => v === (hardUp.candidate ?? hardUp.state)), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
