// The Global Macro rows read the same way whatever the market does (Stu, 25 Nov 2026: "the
// scenarios in the future should flip accordingly"). Every combination — 20 days up, down, flat or
// exactly zero; the week with it or against it, smaller or bigger — is run through the real line
// builders (ratioRows, fxRow in both quote directions, crossRow) on synthetic prices, and each line
// is checked against the rules rather than against fixed text:
//   • one meaning per line, and it is the meaning of the move the line leads with;
//   • the arrow points the way of that move;
//   • a counter-move is "bounced" when the week is up and "pulled back" when it is down;
//   • a turn names what it undid ("gain" after an up month, "drop" after a down one, "flat" after none);
//   • "today ran the other way" only ever runs against the direction the line leads with.
import { ratioRows, fxRow, crossRow, GLOBAL_FX, GLOBAL_CROSS, FLAT_20D } from '../lib/globalMacro.js';
import { CARDS, LEGS, TURN_MIN } from '../lib/ratios.js';
let pass = 0, fail = 0;
const ok = (n, c, why = '') => { if (c) pass++; else { fail++; console.log('❌', n, why); } };

// Weekday dates ending Fri 20 Nov 2026; "now" is the Saturday after, so the 20th is settled.
const NOW = Date.parse('2026-11-21T12:00:00Z');
const dates = [];
for (let t = Date.parse('2026-11-20T12:00:00Z'); dates.length < 320; t -= 864e5) {
  const g = new Date(t).getUTCDay();
  if (g !== 0 && g !== 6) dates.unshift(new Date(t).toISOString().slice(0, 10));
}
const n = dates.length;
// A wide oscillation before the last 21 sessions keeps the 60-day range wide, so no case is a
// range break (a break takes precedence in the words); then a straight line to the target moves.
function path(ch20, ch5) {
  const v = dates.map((_, i) => 100 * (1 + 0.35 * Math.sin(i / 4.7)));
  const a = n - 21, b = n - 6, z = n - 1;
  const va = 100, vb = 100 * (1 + ch20) / (1 + ch5), vz = 100 * (1 + ch20);
  for (let i = a; i <= z; i++) v[i] = i <= b ? va + (vb - va) * (i - a) / (b - a) : vb + (vz - vb) * (i - b) / (z - b);
  return dates.map((d, i) => [d, +v[i].toFixed(6)]);
}
const flat = dates.map(d => [d, 100]);

const sgn = (x) => (x > 0 ? 'up' : 'down');
const ARROW = { up: '▲', down: '▼', flat: '▶' };
const pctNum = (s) => Number(s.replace('−', '-').replace('%', ''));

function check(label, line, { ch20, ch5, means, turnMin }) {
  const flat20 = Math.abs(ch20) < FLAT_20D;
  const against = Math.abs(ch5) >= turnMin && Math.sign(ch5) !== Math.sign(ch20) && !(turnMin === 0.005 && flat20);
  const turned = against && Math.abs(ch5) >= Math.abs(ch20);
  const lead = !against ? (flat20 ? 'flat' : sgn(ch20)) : turned ? sgn(ch5) : sgn(ch20);
  const arrowAt = line.match(/[▲▼▶]/)?.[0];
  ok(`${label}: arrow follows the leading move (${lead})`, arrowAt === ARROW[lead], line);
  if (lead !== 'flat') {
    ok(`${label}: says what the leading move means`, line.includes(means[lead]), line);
    ok(`${label}: never both meanings`, !line.includes(means[lead === 'up' ? 'down' : 'up']), line);
  }
  ok(`${label}: no "reversing"`, !/reversing/.test(line), line);
  if (against && !turned) ok(`${label}: names the counter-move`, line.includes(ch5 > 0 ? 'bounced this week' : 'pulled back this week'), line);
  if (turned) {
    ok(`${label}: says it is turning`, line.includes('**turning:**'), line);
    ok(`${label}: names what it undid`, line.includes(flat20 ? 'the 20 days were flat' : `undid the 20-day ${ch20 > 0 ? 'gain' : 'drop'}`), line);
  }
  const today = line.match(/today ran the other way:\*\* ([−+]?[\d.]+%)/);
  if (today && lead !== 'flat') ok(`${label}: "today" runs against the lead`, sgn(pctNum(today[1])) !== lead, line);
}

const CASES = [];
for (const ch20 of [0.12, -0.12, 0.0002, 0]) for (const ch5 of [0.03, -0.03, 0.2, -0.2, 0.004, -0.004]) CASES.push({ ch20, ch5 });

// Ratios: the card's numerator follows the path, everything else is flat.
for (const card of CARDS.filter(c => c.num.length === 1 && c.den.length === 1)) {
  for (const { ch20, ch5 } of CASES) {
    const closes = Object.fromEntries(LEGS.map(s => [s, flat]));
    closes[card.num[0]] = path(ch20, ch5);
    const r = ratioRows(closes, { now: NOW });
    const line = r.lines.find(l => l.startsWith(`**${card.short}**`));
    check(`${card.short} 20d ${ch20} / 5d ${ch5}`, line || '', { ch20, ch5, means: card.means, turnMin: TURN_MIN });
  }
}

// FX: both quote directions, judged in the dollar's frame.
for (const def of GLOBAL_FX.filter(d => ['EUR', 'JPY'].includes(d.short))) {
  for (const { ch20, ch5 } of CASES) {
    const row = fxRow(def, path(ch20, ch5));
    // In the dollar's frame a quote pair moves the other way: +x% EUR/USD ≈ −x% for the dollar.
    const usd20 = def.usd === 'quote' ? 1 / (1 + ch20) - 1 : ch20;
    const usd5 = def.usd === 'quote' ? 1 / (1 + ch5) - 1 : ch5;
    check(`${def.short} 20d ${ch20} / 5d ${ch5}`, row?.line || '', { ch20: usd20, ch5: usd5, means: def.means, turnMin: 0.005 });
  }
}

// Cross-asset: a price row and a volatility row.
for (const def of GLOBAL_CROSS.filter(d => ['Gold', 'VIX'].includes(d.short))) {
  for (const { ch20, ch5 } of CASES) {
    const row = crossRow(def, { [def.sym]: path(ch20, ch5) });
    check(`${def.short} 20d ${ch20} / 5d ${ch5}`, row?.line || '', { ch20, ch5, means: def.means, turnMin: 0.005 });
  }
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
if (fail) process.exit(1);
