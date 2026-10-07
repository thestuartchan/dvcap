// lib/posture.js — the headline TAPE STANCE card (A1). Deterministic, no model. A confirmed
// scenario states what is TRUE; the stance card states what to DO — and resolves the fact that
// several scenarios can read confirmed at once pointing opposite ways.
//
// ── 2026-09-10: IT PRINTED RISK-ON ON A BROADLY RISK-OFF TAPE ────────────────
// At 13:28Z the card read RISK-ON, in green, while everything on the same render disagreed: gold
// −0.64%, BTC −1.71%, QQQ −1.28%, NQ through its prior low, Asia and Europe semis moving together
// to the downside, USD/KRW +7.21 with Korea Stress ACTIVE, DXY up, Brent +$4.19, 2 of 6 tripwires
// leaning de-risking, and the header's own regime label reading Stagflation 71%.
//
// The classifier could not see any of it. Its inputs were the tripwire RATIO, the vol regime, the
// credit gate and the confirmed scenarios — and on that day the ratio was 2/6 (0.33, under the
// 0.4 step), no scenario was confirmed, the VIX curve was in contango and OAS read calm. Score
// zero. Zero was RISK-ON.
//
// Two separate faults, and both are fixed here:
//
//   1. THE TAPE WAS NOT AN INPUT. Vol structure and credit are STRUCTURAL — they describe the
//      cost of insurance and the price of leverage, and they can stay calm through an entire
//      session of broad selling. A stance that reads only structure will call a green light on
//      every quiet-vol de-risking day there is.
//
//   2. A SCORE OF ZERO MEANT RISK-ON. Nothing distinguished "every gauge checked and none of them
//      is worried" from "nothing fired, and nothing was looking." An absence of evidence was
//      being published as a positive finding.
//
// So the resolution order is now TRIPWIRES → TAPE → VOL STRUCTURE → CREDIT, and RISK-ON must be
// EARNED rather than defaulted to: any blocker on the list withholds it. When the tape and the
// structural inputs disagree the stance NAMES THE CONFLICT — "MIXED — vol structure calm, tape
// risk-off" — rather than picking the structural side, because the disagreement is the finding.
import { ATR_GATE } from './scenarios.js';
import { noNewPrint } from './read.js';

const daysTo = (dateStr, nowMs) => {
  const ms = Date.parse(String(dateStr) + 'T00:00:00Z');
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - nowMs) / 86400000);
};

// ── THE CROSS-ASSET TAPE ─────────────────────────────────────────────────────
// Four legs, each a 1-day percent change with the instrument's OWN daily range beside it. The
// range is not decoration: without it "DXY +0.03%" and "DXY +0.60%" are the same shape of fact,
// and the board has spent its whole life fixing exactly that mistake elsewhere (see the ATR gate
// in lib/scenarios.js — the same constant, imported, because two copies drift).
//
// A leg with no ATR gets NO VOTE. Magnitude cannot be judged without a scale, and judging it
// anyway is the bug.
//
// GOLD IS NOT A DIRECTION VOTE, and this is the leg that most often gets it wrong. Gold rising
// while equities fall is a flight bid; gold FALLING while equities fall is the rates-repricing
// signature, where everything held for its duration sells at once. Both are risk-off for a book.
// Gold's direction therefore sets the FLAVOUR, not the sign — and when equities are rising it has
// nothing to say about risk appetite at all, so it abstains.
export const TAPE_LEGS = Object.freeze(['equity', 'gold', 'btc', 'dxy']);

const legNum = (x) => {
  if (x == null) return { value: null, atr: null };
  if (typeof x === 'object' && !Array.isArray(x)) {
    const v = Number(x.value), a = Number(x.atr);
    return { value: Number.isFinite(v) ? v : null, atr: Number.isFinite(a) && a > 0 ? a : null };
  }
  const v = Number(x);
  return { value: Number.isFinite(v) ? v : null, atr: null };
};

// −1 risk-off · +1 risk-on · 0 too small to say · null no reading
function voteOf(name, raw, { equityFalling } = {}) {
  const { value, atr } = legNum(raw);
  if (value == null) return { name, vote: null, value: null, why: 'no print' };
  if (atr == null) return { name, vote: null, value, why: 'no ATR — magnitude cannot be judged' };
  const floor = ATR_GATE * atr;
  if (Math.abs(value) < floor) {
    return { name, vote: 0, value, atr, why: `under ${ATR_GATE}×ATR (${floor.toFixed(2)}%)` };
  }
  const mult = +(Math.abs(value) / atr).toFixed(1);
  const base = { name, value, atr, mult };
  if (name === 'gold') {
    // Abstains unless equities are falling; then it votes risk-off either way and says which kind.
    if (!equityFalling) return { ...base, vote: 0, why: 'equities are not falling — gold says nothing about risk appetite here' };
    return { ...base, vote: -1, why: value < 0 ? 'falling with equities — the rates-repricing signature, not a flight bid'
                                              : 'bid while equities fall — flight to safety' };
  }
  if (name === 'dxy') return { ...base, vote: value > 0 ? -1 : 1, why: value > 0 ? 'dollar bid' : 'dollar offered' };
  return { ...base, vote: value < 0 ? -1 : 1, why: value < 0 ? 'falling' : 'rising' };
}

// ── 2026-10-07: RISK-OFF IN RED WITH EQUITIES AND BONDS BOTH UP ──────────────
// QQQ +0.46% (inside its range, so no vote), gold +0.72% (abstains: equities not falling), and the
// only two legs that cleared their floor were BTC −2.17% and DXY +0.48%. Two of two said risk-off,
// so the card printed RISK-OFF while equities, bonds and gold all rose. That is a DOLLAR SQUEEZE,
// not a risk-off tape. So a direction now needs EQUITIES to agree: risk-off needs the equity leg
// falling, risk-on needs it rising. Without it the tape is mixed, and the PATTERN names what it is.
// An equity leg with no reading cannot confirm or deny, and leaves the old majority standing.
export const TAPE_PATTERNS = Object.freeze({
  'flight':     'broad risk-off — equities sold, gold bid (flight to safety)',
  'rates-sell': 'rates-driven sell-off — equities and gold sold together',
  'equity-off': 'equity sell-off',
  'squeeze-eq': 'equities firm against a dollar squeeze',
  'goldilocks': 'goldilocks — stocks and bonds bid together',
  'reflation':  'reflation — stocks and gold bid, bonds sold',
  'risk-on':    'broad risk-on',
  'squeeze':    'dollar squeeze — USD bid, crypto sold, equities steady',
  'easing':     'dollar easing — USD offered, crypto bid, equities steady',
  'crypto-off': 'crypto-specific selling — equities steady',
  'crypto-on':  'crypto-specific bid — equities steady',
  'unconfirmed':'cross-asset legs moving without equities',
  'quiet':      'every leg inside its own daily range',
  'split':      'legs split both ways',
});
export function tapePattern(t, bonds = null) {
  const v = Object.fromEntries(t.legs.map(l => [l.name, l]));
  const eq = v.equity?.vote, gold = v.gold, dxy = v.dxy?.vote, btc = v.btc?.vote;
  const b = legNum(bonds);
  const bondsUp = b.value != null && b.atr != null && b.value >= ATR_GATE * b.atr;
  const bondsDown = b.value != null && b.atr != null && b.value <= -ATR_GATE * b.atr;
  const goldUp = gold?.value != null && gold?.atr != null && gold.value >= ATR_GATE * gold.atr;
  let id;
  if (t.direction === 'unavailable') return null;
  if (t.direction === 'quiet') id = 'quiet';
  else if (eq === -1) id = gold?.vote === -1 ? (gold.value < 0 ? 'rates-sell' : 'flight') : 'equity-off';
  else if (eq === 1) id = dxy === -1 ? 'squeeze-eq' : t.direction !== 'risk-on' ? 'split' : bondsUp ? 'goldilocks' : (goldUp && bondsDown) ? 'reflation' : 'risk-on';
  else if (dxy === -1 && btc === -1) id = 'squeeze';
  else if (dxy === 1 && btc === 1) id = 'easing';
  else if (btc === -1 && !dxy) id = 'crypto-off';
  else if (btc === 1 && !dxy) id = 'crypto-on';
  else id = t.riskOff.length && t.riskOn.length ? 'split' : 'unconfirmed';
  return { id, label: TAPE_PATTERNS[id] };
}

export function tapeRead(tape = {}) {
  // The equity leg is resolved first because gold's reading depends on it.
  const eq = legNum(tape.equity);
  const eqFloor = eq.atr != null ? ATR_GATE * eq.atr : null;
  const equityFalling = eq.value != null && eqFloor != null && eq.value < 0 && Math.abs(eq.value) >= eqFloor;

  const legs = TAPE_LEGS.map(name => voteOf(name, tape[name], { equityFalling }));
  const scored = legs.filter(l => l.vote != null);
  const off = scored.filter(l => l.vote < 0), on = scored.filter(l => l.vote > 0);
  const score = scored.reduce((a, l) => a + l.vote, 0);

  // DIRECTION IS A MAJORITY OF THE LEGS THAT SPOKE, not a bare sum: two legs risk-off and two
  // silent is a risk-off tape; two risk-off and two risk-on is a mixed one, and calling that
  // either way is how a coin flip gets dressed as a finding.
  let direction;
  if (!scored.length) direction = 'unavailable';
  else if (off.length > on.length && off.length > 0) direction = 'risk-off';
  else if (on.length > off.length && on.length > 0) direction = 'risk-on';
  else if (off.length === 0 && on.length === 0) direction = 'quiet';
  else direction = 'mixed';
  // EQUITIES CONFIRM, OR IT IS MIXED (see TAPE_PATTERNS). A null equity vote cannot speak either way.
  const eqVote = legs[0].vote;
  const unconfirmed = eqVote != null && ((direction === 'risk-off' && eqVote !== -1) || (direction === 'risk-on' && eqVote !== 1));
  if (unconfirmed) direction = 'mixed';

  const named = (arr) => arr.map(l => `${l.name} ${l.value >= 0 ? '+' : ''}${l.value}%`).join(', ');
  const phrase = direction === 'unavailable' ? 'no cross-asset legs readable'
    : direction === 'quiet' ? 'every leg inside its own daily range'
    : direction === 'risk-off' ? named(off)
    : direction === 'risk-on' ? named(on)
    : !on.length ? `${named(off)} — equities not confirming`
    : !off.length ? `${named(on)} — equities not confirming`
    : `${named(off)} against ${named(on)}`;

  const out = {
    direction, score, phrase, legs, unconfirmed,
    readable: scored.length, total: TAPE_LEGS.length,
    unreadable: legs.filter(l => l.vote == null).map(l => l.name),
    riskOff: off.map(l => l.name), riskOn: on.map(l => l.name),
  };
  out.pattern = tapePattern(out, tape.bonds);
  return out;
}

// ── GUARD 3: THE REGIME AXIS ─────────────────────────────────────────────────
// Stance and regime are different axes and are allowed to differ — but "Stagflation 71%" and
// "RISK-ON" cannot both be the correct top-line read on the same header row, and on 2026-09-10
// they were rendered eight centimetres apart. Above the threshold the regime label withholds
// RISK-ON; it never manufactures RISK-OFF, because it is not a statement about today's tape.
export const REGIME_BLOCK_PCT = 60;
// Matched on the regime ID when the caller has one — renaming a label in lib/regimes.js must not
// silently disable the guard. The label pattern remains for callers that only carry a label.
export const REGIME_BLOCK_IDS = new Set(['stag', 'def']);
export const REGIME_BLOCKS = /stagflation|deflationary/i;

export function regimeBlock(regime) {
  // The measured state (lib/marketState.js) also carries its conditions band: Stress or Crisis
  // withholds RISK-ON whatever the regime mix says — the system is not carrying risk.
  if (regime?.band === 'stress' || regime?.band === 'crisis') {
    return `market conditions read ${regime.band}${Number.isFinite(Number(regime.score)) ? ` (${Number(regime.score).toFixed(1)})` : ''}`;
  }
  const pct = Number(regime?.pct);
  const label = regime?.label ? String(regime.label) : null;
  if (!Number.isFinite(pct)) return null;
  const hostile = regime?.id ? REGIME_BLOCK_IDS.has(String(regime.id)) : (label ? REGIME_BLOCKS.test(label) : false);
  if (!hostile || pct < REGIME_BLOCK_PCT) return null;
  return `the regime classifier reads ${label || regime.id} ${Math.round(pct)}%`;
}

// Applied to an ALREADY-COMPOSED stance, so the server and the dashboard run the same guard over
// the same object. The dashboard is where the regime probability is computed (it depends on
// user-set recession weights), so it arrives after composePosture has run; a second
// implementation there would be a second thing to keep in step.
export function applyRegimeGuard(p, regime) {
  const block = regimeBlock(regime);
  if (!p || !block || p.posture !== 'RISK-ON') return p;
  return {
    ...p,
    posture: 'NEUTRAL, SELECTIVE', tone: 'amber',
    blockedBy: [...(p.blockedBy || []), block],
    withheld: 'RISK-ON', plan: doPlan('NEUTRAL, SELECTIVE'),
  };
}

const pts = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;
export const partsText = (parts = []) => parts.map(p => `${p.label} ${pts(p.pts)}`).join(', ');

// ── DO, AS AN INSTRUCTION ────────────────────────────────────────────────────
// The scenario consequences say what is TRUE; these say what to do with the book, in three parts,
// sized against the standing limits (lib/leverage.js BOOK_LIMITS: target 1.0×, position ≤ 1.2× +
// swing ≤ 0.3×, ceiling 1.5×). Generic on purpose — this object is served by a public route and
// reaches the Discord brief. The dashboard lays the live book over it (src: the Console's summary).
export function doPlan(posture) {
  const k = posture === 'RISK-OFF' ? 'off' : posture === 'RISK-ON' ? 'on' : posture === 'NO SIGNAL' ? 'none' : 'mid';
  return {
    off: { newRisk: 'No new swings. Day trades at half size, and none against the tape.',
           book: 'Gross toward the 1.0× target; swing bucket toward half its 0.3× limit (0.15×). Cut the weakest swing first.',
           hedge: 'Hedge on: an index put spread (SPY or QQQ, ~60–90 days) sized to the swing bucket.' },
    mid: { newRisk: 'Hold. Add only A-setups at three-quarter size, and none in the leg the tape is selling.',
           book: 'Stay inside the limits: position ≤ 1.2×, swing ≤ 0.3×. No adds to anything down.',
           hedge: 'Keep the hedges you have; do not add more until the stance turns.' },
    on:  { newRisk: 'Full size on setups that meet the rules.',
           book: 'Up to the 1.0× target, ceiling 1.5×.',
           hedge: 'Let hedges roll off rather than rebuying them.' },
    none:{ newRisk: 'No signal — act on the rules, not the stance.', book: '', hedge: '' },
  }[k];
}

export function composePosture({ scenarios = [], leaning, volTerm, credit, tape = null, regime = null,
                                 calendar = [], events = [], nowMs = 0, now = null } = {}) {
  const confirmed = scenarios.filter(s => s.confirmed);
  const working = confirmed.filter(s => s.side === 'supportive');
  const adverse = confirmed.filter(s => s.side === 'adverse');
  const asOf = now || (nowMs ? new Date(nowMs) : new Date());

  // ── Deterministic risk-off score (higher = more de-risked) ──
  // EVERY CONTRIBUTION IS RECORDED, half points and scenarios included. On 2026-10-07 the flip line
  // read "now 2.5 from tape risk-off (btc, dxy)" when the tape was 1.0 of it and a confirmed
  // Hawkish-repricing scenario another 1.0 — a total explained by a part of itself.
  let score = 0;
  const reasons = [];
  const parts = [];
  const add = (label, pts) => { if (!pts) return; score += pts; parts.push({ label, pts }); if (Math.abs(pts) >= 1) reasons.push(label); };
  const tripped = leaning?.tripped ?? 0;
  const usable = leaning?.usable ?? 0;
  const trippedRatio = usable ? tripped / usable : 0;
  if (trippedRatio >= 0.6) add(`${tripped}/${usable} tripwires`, 1);
  else if (trippedRatio >= 0.4) add(`${tripped}/${usable} tripwires`, 0.5);
  if (volTerm?.regime === 'BACKWARDATION') add('vol backwardation', 1);
  else if (volTerm?.regime === 'FLAT') add('vol curve flat', 0.5);
  const cstate = String(credit?.effective || credit?.state || credit?.level || '').toLowerCase();
  // GUARD 4: A STANCE DERIVED FROM A STALE INPUT IS DOWNGRADED, NOT PUBLISHED. On 2026-09-10
  // "credit calm" was one of the two things holding the green light up, off an observation from
  // the 8th. `noNewPrint` is hour-aware — FRED publishes the prior business day during the US
  // morning — so this fires when the print is genuinely late, not on the ordinary lag.
  const creditStale = noNewPrint(credit?.obs, asOf);
  const creditNote = creditStale
    ? `${credit.obs.obsDate}, ${credit.obs.bizDays} business days` : null;
  if (/stress|recession/.test(cstate)) add('credit stressed', 1.5);
  else if (/watch|widen/.test(cstate)) add('credit on watch', 0.5);
  for (const s of adverse) add(s.name || `scenario ${s.id}`, s.id === 'D' ? 1.5 : 1);
  for (const s of working) add(`${s.name || `scenario ${s.id}`} (supportive)`, -0.5);

  // ── The tape, and what it adds to the score ──
  const t = tapeRead(tape || {});
  if (t.direction === 'risk-off') add(`tape risk-off (${t.riskOff.join(', ')})`, t.riskOff.length >= 3 ? 1.5 : 1);
  else if (t.direction === 'mixed') add(`tape mixed${t.pattern ? ` (${t.pattern.label.split(' — ')[0]})` : ''}`, 0.5);

  // ── WHAT WITHHOLDS RISK-ON ───────────────────────────────────────────────────
  // Not "what makes it risk-off" — a different question. RISK-ON is a positive claim about the
  // tape and it has to be earned; each of these is a reason the claim cannot be made, and every
  // one of them was true on the render that printed it in green.
  const blockedBy = [];
  if (tripped > 0) blockedBy.push(`${tripped}/${usable} tripwires leaning de-risking`);
  if (t.direction === 'risk-off') blockedBy.push(`the cross-asset tape is risk-off — ${t.phrase}`);
  if (t.direction === 'mixed') blockedBy.push(`the cross-asset tape is mixed — ${t.phrase}`);
  if (t.direction === 'unavailable') blockedBy.push('no cross-asset tape reading — the stance would rest on vol structure and credit alone');
  if (creditStale && /calm/.test(cstate)) blockedBy.push(`credit calm is reading a stale observation (${creditNote})`);
  const rBlock = regimeBlock(regime);
  if (rBlock) blockedBy.push(rBlock);

  // ── THE CONFLICT IS THE FINDING ──────────────────────────────────────────────
  // Vol structure calm while the tape sells is a real and nameable state — insurance is cheap
  // and nobody is bidding for it while the underlying goes down. Picking the structural side
  // publishes a green light; picking the tape side throws away the fact that the options market
  // is not corroborating. Naming both is the useful output.
  const structuralCalm = (volTerm?.regime === 'CONTANGO') || (/calm/.test(cstate) && !creditStale);
  const structuralWord = volTerm?.regime === 'CONTANGO' ? 'vol structure calm'
    : /calm/.test(cstate) ? 'credit calm' : 'structure calm';

  let posture, tone, withheld = null;
  const nothing = !scenarios.length && !usable && t.direction === 'unavailable';
  if (nothing) { posture = 'NO SIGNAL'; tone = 'muted'; }
  else if (score >= 2.5) { posture = 'RISK-OFF'; tone = 'red'; }
  else if (structuralCalm && t.direction === 'risk-off') {
    posture = `MIXED — ${structuralWord}, tape risk-off`; tone = 'amber';
  }
  else if (blockedBy.length) { posture = 'NEUTRAL, SELECTIVE'; tone = 'amber'; withheld = 'RISK-ON'; }
  else if (score <= 0) { posture = 'RISK-ON'; tone = 'green'; }
  else { posture = 'NEUTRAL, SELECTIVE'; tone = 'amber'; }

  // ── FLIPS IF ─────────────────────────────────────────────────────────────
  // Every card is state → evidence → what changes it. WATCH names the thing to look at; this
  // names the CONDITION, in the stance's own terms, derived from the same branches that just
  // chose it — so it cannot describe a rule other than the one that ran. It renders on every
  // stance, because an uncertain stance is when a reader needs the flip condition most.
  const legsToTurn = t.direction === 'risk-off' ? t.riskOff : [];
  let flipsIf;
  if (nothing) flipsIf = 'any input arrives — a scenario, a gauge with a print, or a tape reading';
  else if (posture === 'RISK-OFF') {
    flipsIf = `the score drops below 2.5 — now ${score.toFixed(1)}${parts.length ? ` from ${partsText(parts)}` : ''}`;
  }
  else if (posture.startsWith('MIXED')) {
    flipsIf = `the two halves agree: the tape turning (${legsToTurn.length ? legsToTurn.join(', ') + ' reversing' : 'its legs reversing'}) opens RISK-ON; ${structuralWord} breaking closes to RISK-OFF`;
  }
  else if (withheld) {
    flipsIf = `to ${withheld} once ${blockedBy.length === 1 ? 'this clears' : `these ${blockedBy.length} clear`}: ${blockedBy.join('; ')}`;
  }
  else if (posture === 'RISK-ON') {
    flipsIf = 'any one of: a tripwire firing, the tape turning risk-off or mixed, vol leaving contango, credit leaving calm';
  }
  else {
    flipsIf = `to RISK-ON at score ≤ 0, to RISK-OFF at ≥ 2.5 — now ${score.toFixed(1)}${parts.length ? ` (${partsText(parts)})` : ''}`;
  }

  // WORKING / NOT — confirmed scenarios split supportive vs adverse.
  // By name and leg count. The scenario board shows names; "(C 3/3)" pointed at a letter nobody sees.
  const workingLines = working.map(s => `${s.consequence || s.name} (${s.name}, ${s.met}/${s.total} legs)`);
  const notLines     = adverse.map(s => `${s.name} (${s.met}/${s.total} legs)`);
  // Supportive market context worth naming even without a confirmed scenario.
  if (volTerm?.regime === 'CONTANGO') workingLines.push('vol contango — dips buyable, premium sellable');
  // A stale gate still gets to speak; it does not get to speak as though it printed this morning.
  if (/calm/.test(cstate)) workingLines.push(creditStale ? `credit calm ⚠ stale (${creditNote})` : 'credit calm');
  // NOT carries the tape, which is the half that was missing entirely.
  if (t.direction === 'risk-off') notLines.push(`tape risk-off — ${t.phrase}`);
  else if (t.direction === 'mixed') notLines.push(`tape mixed — ${t.phrase}`);

  // DO — consequences of confirmed scenarios, highest weight first.
  const doLines = [...confirmed].sort((a, b) => b.weight - a.weight).map(s => s.consequence).filter(Boolean);

  // ── WATCH RENDERS ON EVERY STANCE ────────────────────────────────────────────
  // It went missing on the 2026-09-10 render, and it is the single most useful line in the box:
  // it names the condition that CHANGES the stance. The old resolution took the top confirmed
  // scenario, else the nearest one with proximity > 0 — and on a board where every scenario was
  // 0/2 or UNSCORED, nothing had positive proximity and the row simply vanished. An uncertain
  // stance is when a reader needs the flip condition MOST, so the fallback widens rather than
  // giving up: nearest live scenario, then the highest-weight one that is still alive at all.
  const topConfirmed = [...confirmed].sort((a, b) => b.weight - a.weight)[0];
  const live = scenarios.filter(s => !s.broken && !s.confirmed);
  const nearest = [...live].filter(s => s.proximity > 0).sort((a, b) => (b.proximity - a.proximity) || (b.weight - a.weight))[0];
  const anyLive = [...live].sort((a, b) => b.weight - a.weight)[0];
  const watch = (topConfirmed || nearest || anyLive)?.watch
    // Last resort: with no scenario to point at, the thing to watch is whatever is withholding
    // the stance. Better a named condition than an empty row.
    || (blockedBy[0] ? `${blockedBy[0]} — that is what is holding the stance` : null);

  // NEXT — the next two dated calendar / event items, with countdown.
  const dated = [
    ...(calendar || []).map(c => ({ label: c.title || c.label || c.name || c.event, date: c.date })),
    ...(events || []).map(e => ({ label: `${e.name} ${e.label}`, date: e.date })),
  ].filter(x => x.label && x.date);
  const seen = new Set();
  const next = dated
    .map(x => ({ ...x, d: daysTo(x.date, nowMs) }))
    .filter(x => x.d != null && x.d >= 0)
    .filter(x => { const k = x.label + x.date; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.d - b.d)
    .slice(0, 2)
    .map(x => ({ label: x.label, date: x.date, daysTo: x.d }));

  return {
    posture, tone, score: +score.toFixed(1),
    // THE DENOMINATOR MOVES. `usable` counts only gauges with a print, so a leg going dark takes
    // the ratio from 0/5 to 0/4 with nothing saying a gauge dropped out — and the two readings look
    // like different states rather than the same state with one instrument unlit. The READ already
    // names its unavailable gauges; this said nothing.
    tripwires: usable ? `${tripped}/${usable}` : null,
    tripwiresDark: leaning?.unavailable?.length || 0,
    tripwiresNote: leaning?.unavailable?.length
      ? `${leaning.unavailable.length} gauge${leaning.unavailable.length === 1 ? '' : 's'} unavailable (${leaning.unavailable.join(', ')}) — not counted in the denominator`
      : null,
    scoreReasons: reasons,
    // Every point and where it came from, and the line it is measured against.
    scoreParts: parts, scoreText: `${parts.length ? partsText(parts) : 'nothing scored'} = ${score.toFixed(1)} · risk-off at ≥ 2.5, risk-on at ≤ 0`,
    plan: doPlan(posture),
    // The tape is returned in full so the card can show the legs it was read from. A stance whose
    // inputs are not visible is one nobody can check against their own screen — which is exactly
    // how RISK-ON survived a render that contradicted it in eleven places.
    tape: t,
    creditStale, creditNote,
    blockedBy, withheld,
    working: workingLines,
    not: notLines,
    do: doLines,
    watch,
    flipsIf,
    next,
  };
}
