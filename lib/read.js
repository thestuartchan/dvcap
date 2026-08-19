// read.js — the composed READ. Fully deterministic: rules over structured gate state.
// NO model call, no template substitution.
//
// Why composed rather than templated: the old READ was a hardcoded template doing
// one-number-one-clause substitution, which is how it produced "foreign exit dominates" by
// looking at foreign flow in ISOLATION while retail was absorbing nearly all of it. Each
// sentence here cross-references several gauges against their thresholds.
//
// SCOPE (deliberate — do not "improve" by making this more conclusive):
//   • Observational only. No trade calls, entries, or positioning language.
//   • Genuine gauge disagreement is SURFACED, never resolved into one confident answer.
//   • Hedged wording ("consistent with", not "is"). Confidence is tagged when a key input is
//     stale or a threshold is close.

import { KRW_FLIP } from './gates.js';
import { kofiaStale } from './kofia.js';

// Tunables.
export const REAL_YIELD_HIGH = 2.0;    // 10Y real above this is restrictive
export const KRW_NEAR_FLIP   = 15;     // within this many won of the flip = "close to threshold"
export const ABSORB_RATIO    = 0.5;    // retail taking >= this share of the foreign sell = absorbing

const n = (v, d = 2) => (v == null || !Number.isFinite(+v)) ? null : +Number(v).toFixed(d);
const signed = (v, d = 2) => { const x = n(v, d); return x == null ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x)}`; };

// Every figure quoted in the READ is registered here with the field it came from, so the
// citation list can be asserted against the source state (4A: "must match its source field").
function citer() {
  const cites = [];
  return {
    cites,
    // Register and return the display string.
    q(label, value, field, opts = {}) {
      const d = opts.digits ?? 2;
      cites.push({ label, value: n(value, d), field });
      return opts.raw != null ? opts.raw : String(n(value, d));
    },
  };
}

// ── Credit ────────────────────────────────────────────────────────────────────
function creditSentence(credit, hyg, c) {
  if (!credit || credit.level == null) return null;
  const lvl = credit.level;
  const v = c.q('HY OAS', credit.d1?.to ?? null, 'credit.d1.to');
  let s = `Credit: HY OAS ${v === 'null' ? '' : v + ' '}reads ${lvl}`;
  if (credit.word && credit.d1) {
    s += ` and ${credit.word.toLowerCase()} (${signed(credit.d1.delta)} ${credit.d1.basis}`;
    if (credit.d5) s += `, ${signed(credit.d5.delta)} ${credit.d5.basis}`;
    s += ')';
    if (credit.escalated) s += `, ${credit.runs} consecutive sessions — level-calm but trending, so the gate is elevated to ${String(credit.effective || credit.state).toUpperCase()}`;
  } else {
    s += ' with no prior print, so direction is unavailable';
  }
  // HYG is the live tell and OAS is EOD/T+1 — cross-reference them rather than describing each.
  if (hyg?.available) {
    const agree = (credit.dir === 'rising' && hyg.stressing) || (credit.dir === 'falling' && !hyg.stressing);
    s += hyg.stressing
      ? `; HYG ${signed(hyg.changePct)}% 1D is selling credit intraday${agree ? ', consistent with the OAS direction' : ' while OAS is not widening — the live tape leads the EOD print'}`
      : `; HYG ${signed(hyg.changePct)}% 1D shows no live credit stress${credit.dir === 'rising' ? ', which does not confirm the OAS widening' : ''}`;
  }
  return s + '.';
}

// ── Korea: mechanical vs flight, weighed across FOUR gauges together ──────────
function koreaSentence(korea, kofiaLatest, c) {
  if (!korea) return null;
  const won = korea.won, vol = korea.vol;
  const f = kofiaLatest?.foreignNet, r = kofiaLatest?.retailNet;
  const ml = kofiaLatest?.marginLoans;

  const evidence = [];      // points toward mechanical/domestic
  const against = [];       // points toward flight
  const missing = [];

  // P4 — a STALE manual (KOFIA) input must not compose a confident clause. A field older than
  // the staleness threshold is treated as ABSENT here — the clause it would drive is SUPPRESSED,
  // not merely footnoted while still asserting yesterday's number as today's read. The footer
  // still records the staleness, so the reader sees WHY the clause is gone. USD/KRW and VKOSPI
  // are LIVE feeds (Yahoo / KRX futures), so they are never gated by KOFIA staleness.
  const staleTag = e => (e && e.asOf && kofiaStale(e.asOf)) ? e.asOf.slice(5) : null;
  const usable   = e => e && e.value != null && !staleTag(e);

  // 1) Foreign vs retail absorption — the pair, never foreign alone.
  let absorbing = null;
  if (usable(f) && usable(r) && (!f.asOf || !r.asOf || f.asOf === r.asOf)) {
    const fv = c.q('foreign net', f.value, 'kofiaLatest.foreignNet.value', { digits: 0 });
    const rv = c.q('retail net', r.value, 'kofiaLatest.retailNet.value', { digits: 0 });
    if (f.value < 0) {
      absorbing = r.value > 0 && r.value >= Math.abs(f.value) * ABSORB_RATIO;
      const share = Math.round((r.value / Math.abs(f.value)) * 100);
      (absorbing ? evidence : against).push(
        absorbing ? `retail ${signed(r.value, 0)} absorbing ${share}% of foreign ${signed(f.value, 0)}`
                  : `retail ${signed(r.value, 0)} not absorbing foreign ${signed(f.value, 0)}`);
    } else {
      evidence.push(`foreign ${signed(f.value, 0)} is a net buyer`);
    }
  } else if (staleTag(f) || staleTag(r)) {
    missing.push(`foreign/retail flows stale (${staleTag(f) || staleTag(r)}) — suppressed`);
  } else missing.push('retail (개인) print');

  // 2) USD/KRW vs the flip.
  if (won?.level != null) {
    c.q('USD/KRW', won.level, 'korea.won.level');
    const flip = won.flip ?? KRW_FLIP;
    (won.aboveFlip ? against : evidence).push(
      won.aboveFlip ? `KRW ${won.level} above ${flip}` : `KRW firm at ${won.level} (<${flip})`);
  } else missing.push('USD/KRW');

  // 3) VKOSPI level + direction.
  if (vol?.level != null && vol.dir) {
    c.q('VKOSPI', vol.level, 'korea.vol.level');
    (vol.band === 'EXTREME' || vol.band === 'HIGH' ? (vol.dir === 'rising' ? against : evidence) : evidence)
      .push(`VKOSPI ${vol.level} ${vol.band} and ${vol.dir}`);
  } else missing.push('VKOSPI direction');

  // 4) Margin-loan direction (leverage unwinding is the mechanical signature).
  if (ml?.pct != null && !staleTag(ml)) {
    c.q('margin loans %', ml.pct, 'kofiaLatest.marginLoans.pct');
    (ml.pct < 0 ? evidence : against).push(`margin loans ${ml.pct}% (${ml.pct < 0 ? 'deleveraging' : 'leverage building'})`);
  } else if (staleTag(ml)) {
    missing.push(`margin loans stale (${staleTag(ml)}) — suppressed`);
  } else missing.push('margin-loan direction');

  if (!evidence.length && !against.length) return `Korea: no usable gate inputs (${missing.join(', ')} missing).`;

  // The conclusion weighs the gauges TOGETHER, and stays hedged.
  let verdict;
  if (against.length === 0)      verdict = 'consistent with a domestic/mechanical unwind rather than flight';
  else if (evidence.length === 0) verdict = 'consistent with flight rather than a mechanical unwind';
  else                            verdict = 'mixed — mechanical and flight signals both present';

  let s = `Korea: ${[...evidence, ...against].join(', ')} — ${verdict}`;
  if (missing.length) s += ` (${missing.join(', ')} unavailable)`;
  return s + '.';
}

// The tripwire that flips the Korea read — stated explicitly so the reader knows what to watch.
function koreaFlip(korea, kofiaLatest) {
  const conds = [];
  const flip = korea?.won?.flip ?? KRW_FLIP;
  if (korea?.won?.level != null) {
    conds.push(korea.won.aboveFlip ? `KRW back below ${flip}` : `KRW >${flip}`);
  }
  // Only offer the absorption flip when the flows are FRESH — a stale pair can't define a
  // watch-for tripwire (P4).
  if (kofiaLatest?.retailNet?.value != null && kofiaLatest?.foreignNet?.value != null
      && !kofiaStale(kofiaLatest.retailNet.asOf) && !kofiaStale(kofiaLatest.foreignNet.asOf)) {
    conds.push('retail stops absorbing foreign selling');
  }
  if (korea?.vol?.band && korea.vol.band !== 'EXTREME') conds.push('VKOSPI into EXTREME');
  return conds.length ? `Flips if ${conds.join(' or ')}.` : null;
}

// ── Cross-asset regime ───────────────────────────────────────────────────────
// Reasons over the cross-asset row rather than restating it: BOTH risk assets down while real
// yields are restrictive is the deleveraging/dash-for-cash signature, NOT a debasement bid.
function regimeSentence(crossRegime, regimeSignal, c) {
  const rows = crossRegime?.rows || [];
  const get = name => rows.find(r => r.name === name);
  const gold = get('Gold'), btc = get('BTC'), real = get('10Y real'), dxy = get('DXY');
  if (!gold || !btc) return null;

  const bothDown = gold.dir === 'falling' && btc.dir === 'falling';
  const bothUp   = gold.dir === 'rising'  && btc.dir === 'rising';
  const realHigh = real?.price != null && real.price >= REAL_YIELD_HIGH;

  if (gold.price != null) c.q('Gold', gold.price, 'cross.regime.Gold.price');
  if (btc.price != null)  c.q('BTC', btc.price, 'cross.regime.BTC.price');
  if (real?.price != null) c.q('10Y real', real.price, 'cross.regime.10Y real.price');

  let s = `Cross-asset: gold ${gold.price} ${signed(gold.changePct)}% and BTC ${btc.price} ${signed(btc.changePct)}% 1D`;
  if (bothDown) {
    s += realHigh
      ? `, both lower with the 10Y real yield at ${real.price}% (restrictive, ≥${REAL_YIELD_HIGH}%) — consistent with deleveraging / dash-for-cash rather than a debasement bid`
      : ', both lower — consistent with broad risk reduction rather than a debasement bid';
  } else if (bothUp) {
    s += realHigh
      ? `, both higher despite a restrictive ${real.price}% real yield — an unusual pairing; treat the debasement read as unconfirmed`
      : ', both higher — consistent with a debasement/liquidity bid';
  } else {
    s += ' diverging — no clean cross-asset regime signal';
  }
  if (dxy?.dir) s += `; DXY ${dxy.dir}`;
  s += '.';

  // Surface (do not resolve) a disagreement between the smoothed 5d classifier and today's 1D.
  let conflict = null;
  if (regimeSignal?.label) {
    const smoothedDebasement = /Debasement bid/i.test(regimeSignal.label) && !/UNCONFIRMED/i.test(regimeSignal.label);
    if (smoothedDebasement && bothDown) {
      conflict = `Regime gauges split: the 5d classifier reads "${regimeSignal.label}" while gold and BTC are both lower on the day — the smoothed and daily windows disagree.`;
    }
  }
  return { sentence: s, conflict };
}

// ── Conflict detection across gauges ─────────────────────────────────────────
function findConflicts({ credit, hyg, korea, leaning, cross }) {
  const out = [];
  // Live credit tape vs the EOD OAS gate.
  if (credit?.dir === 'rising' && hyg?.available && !hyg.stressing) {
    out.push(`Credit gauges split: OAS is widening (EOD print) while HYG is ${hyg.dir} intraday — the live tape is not confirming.`);
  }
  // Korea gate cluster vs its own vol wording.
  if (korea?.halt?.circuitBreaker && korea?.vol?.rolling) {
    out.push(`Korea gauges split: a halt fired (${korea.halt.circuitBreaker}) while VKOSPI is rolling over — a falling vol print on a halt day is not evidence of stress draining.`);
  }
  // Equities steady while the tripwires stack up.
  if (leaning && leaning.usable >= 3 && leaning.tripped >= leaning.usable - 1) {
    const vix = cross?.volCredit?.rows?.find(r => r.sym === '^VIX');
    if (vix && vix.dir === 'falling') {
      out.push(`Gauges split: ${leaning.tripped}/${leaning.usable} tripwires lean de-risking while VIX is falling.`);
    }
  }
  return out;
}

// ── Public: compose the whole READ ───────────────────────────────────────────
export function composeRead(state = {}) {
  const { credit, korea, cross, hyg, leaning, regimeSignal, kofiaLatest, staleNotes = [] } = state;
  const c = citer();
  const sentences = [];
  const conflicts = [];

  const cs = creditSentence(credit, hyg, c);
  if (cs) sentences.push(cs);

  const rs = regimeSentence(cross?.regime, regimeSignal, c);
  if (rs?.sentence) sentences.push(rs.sentence);
  if (rs?.conflict) conflicts.push(rs.conflict);

  const ks = koreaSentence(korea, kofiaLatest, c);
  if (ks) sentences.push(ks);

  if (leaning?.usable) {
    sentences.push(`Tripwires: ${leaning.tripped}/${leaning.usable} leaning de-risking${leaning.unavailable?.length ? ` (${leaning.unavailable.length} unavailable: ${leaning.unavailable.join(', ')})` : ''}.`);
  }

  conflicts.push(...findConflicts({ credit, hyg, korea, leaning, cross }));

  const flip = koreaFlip(korea, kofiaLatest);

  // Confidence: degraded by stale inputs, missing gauges, or a value sitting near a threshold.
  const caveats = [...staleNotes];
  if (leaning?.unavailable?.length) caveats.push(`${leaning.unavailable.length} gauge(s) unavailable`);
  if (korea?.won?.level != null) {
    const flipLvl = korea.won.flip ?? KRW_FLIP;
    if (Math.abs(korea.won.level - flipLvl) <= KRW_NEAR_FLIP) caveats.push(`USD/KRW within ${KRW_NEAR_FLIP} of the ${flipLvl} flip`);
  }
  if (credit?.d1 == null) caveats.push('no OAS prior print');
  const confidence = caveats.length === 0 ? 'clean' : caveats.length <= 1 ? 'qualified' : 'low';

  return {
    sentences, conflicts, flip, confidence, caveats,
    citations: c.cites,
    text: [
      ...sentences,
      ...(conflicts.length ? conflicts : []),
      ...(flip ? [flip] : []),
      caveats.length ? `Confidence ${confidence} — ${caveats.join('; ')}.` : `Confidence ${confidence}.`,
    ].join(' '),
  };
}

// ── Scope guard (4B) ─────────────────────────────────────────────────────────
// The READ must stay observational. This is asserted, not assumed: directive/positioning
// vocabulary in the output is a bug. Descriptive flow words ("net buyers", "oversold") are
// fine — only imperative/positioning forms are banned.
const BANNED = /\b(buy|sell|bought|sold|go long|go short|short the|long the|add to|trim|enter|exit|allocate|overweight|underweight|take profit|stop loss|position size|we like|recommend)\b/i;
export function assertObservational(text) {
  const m = String(text || '').match(BANNED);
  return m ? { ok: false, violation: m[0] } : { ok: true };
}

// Assert every cited figure matches its source field in the state (4A).
export function assertCitations(citations, state) {
  const bad = [];
  const dig = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
  for (const cite of citations || []) {
    if (cite.value == null) continue;
    // cross.regime rows are addressed by NAME, not index — resolve those specially.
    let actual;
    const m = cite.field.match(/^cross\.regime\.(.+)\.price$/);
    if (m) actual = state.cross?.regime?.rows?.find(r => r.name === m[1])?.price;
    else actual = dig(state, cite.field);
    if (actual == null) { bad.push({ ...cite, reason: 'source field missing' }); continue; }
    if (Math.abs(+actual - +cite.value) > Math.max(0.011, Math.abs(+actual) * 1e-6)) {
      bad.push({ ...cite, actual, reason: 'value does not match source field' });
    }
  }
  return { ok: bad.length === 0, bad };
}
