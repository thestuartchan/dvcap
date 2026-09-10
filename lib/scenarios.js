// lib/scenarios.js — the scenario board (Part C shared structure). The dashboard is
// category-bucketed; this is the synthesis layer that answers "which scenario am I in" without
// making the user assemble it from five sections. Each scenario is a name + 2–4 confirming
// conditions, each with a threshold and a live value, plus an X/N met-count. Sorted by proximity
// to confirming. EVERY threshold lives in SCENARIO_CFG so the board is retuned in one place.
//
// A condition's `met` is true / false / null (input unavailable — shown as "n/a", never counted
// as met and never as a clean miss).

// ── MAGNITUDE, NOT SIGN ──────────────────────────────────────────────────────
// The board was validating "TLT rising" on +0.10% and "10s30s not steepening" on −2bp against a
// 72bp spread, and rendering both as confirmations. Neither is an observation; they are the noise
// floor of the instrument, and a scenario built from them reports the last tick's rounding.
//
// So every magnitude input must clear half its own ATR before it counts as anything — a
// confirmation OR a rejection. Below that it renders neutral, because "too small to tell" is a
// third answer and collapsing it into either of the other two is the error being fixed. A tick
// that cannot confirm equally cannot deny.
//
// ATR comes from lib/atr.js, on the instrument's own series and period. An input with no ATR is
// also neutral: magnitude cannot be judged without a scale, and judging it anyway is what the old
// board did.
import { aligned } from './derived.js';

export const ATR_GATE = 0.5;

// ── A THRESHOLD PREDICATE MUST NOT EVALUATE AGAINST A STALE OBSERVATION ──────
// 2026-09-10, 13:28Z. The board scored C (`30Y > 5.35%`) and D (`30Y > 5.5%`) against 5.25% and
// printed `✗ … 0/2` on both. The live 30Y was 5.344%: nine basis points higher, and six tenths of
// one basis point from C's line. `0/2` reads as "not close", and it was rendered on the day rates
// were the entire story.
//
// The machinery to catch this already existed one layer up — A and B correctly went UNVERIFIED
// with "observation dates disagree" off the same 09-08 curve — and it was never applied to the
// threshold comparisons themselves. The disclosure landed; the scoring guard did not.
//
// WHAT COUNTS AS STALE IS NOT SIMPLY "OLDER THAN TODAY". A pass/fail mark is unsafe when the age
// of the observation could plausibly have flipped it, and safe when it could not: HY OAS at 2.67
// against a 3.50 line is 83bp clear, roughly forty times the spread's own daily range, and two
// days of staleness cannot carry it through. Marking that UNSCORED would delete the insurance
// scenario from the board every single day and tell the reader nothing.
//
// So the test is REACH, in the instrument's own units: how far the value could have travelled in
// the days since the observation, against how far it sits from the line. Inside reach the mark is
// withheld; outside it the mark is published with the vintage stated. An input with no ATR has no
// reach that can be computed, so it is withheld — the same rule the magnitude gate uses, for the
// same reason.
//
// An input carrying `live: true` skips all of this. It is today's number; there is nothing to age.
// TWO ATRs per stale business day, not one. An ATR is the AVERAGE true range; a guard has to
// survive a wide day, not the median one. The move this was written for — DGS30 5.25 on 09-08
// against a live 5.344 on the 10th — is 9.4bp against the 30Y's own 2.75bp ATR, so it travelled
// 3.4 ATRs in two sessions and a one-ATR reach would have published the mark anyway. Two is the
// point past which withholding starts costing more than it saves: at three, HY OAS 83bp clear of
// its line would go dark on ordinary lag. The live feed in lib/liveRates.js is the primary
// defence and this is the fallback for what has none — the 2Y, HY OAS, and any hour or weekend
// when the live quote is not fresh.
export const STALE_REACH_ATR = 2.0;   // ATRs per stale business day the value could have moved
// However clear of its line, a mark is not published off an observation older than this. Past a
// few sessions the ATR reach stops being a statement about the instrument and starts being one
// about how long nobody has looked.
export const MAX_STALE_BIZ_DAYS = 3;

export function bizDaysBetween(fromDate, toDate) {
  const a = Date.parse(String(fromDate) + 'T00:00:00Z'), b = Date.parse(String(toDate) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  let n = 0;
  for (const cur = new Date(a); cur.getTime() < b; ) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// Returns null when the mark is safe to publish, or { days, reach } when it must be withheld.
export function staleReach({ value, atr, date, live }, threshold, asOf) {
  if (live || !date || !asOf || value == null || threshold == null) return null;
  const days = bizDaysBetween(date, String(asOf).slice(0, 10));
  if (days <= 0) return null;
  if (days > MAX_STALE_BIZ_DAYS) return { days, reach: null };
  if (!(atr > 0)) return { days, reach: null };
  const reach = STALE_REACH_ATR * atr * days;
  return Math.abs(value - threshold) > reach ? null : { days, reach: +reach.toFixed(3) };
}

export const SCENARIO_CFG = Object.freeze({
  hawkish30y:     5.35,   // C — 30Y yield above this = hawkish repricing underway
  disorderly30y:  5.50,   // D — 30Y above this AND …
  disorderlyOas:  3.50,   // D — … HY OAS above this = disorderly
  units7709Drop:  -3,     // Korea mechanical — 7709 units 1d % at/below this
  ahCompress:     0,      // China policy — A/H premium change below this (pp) = compressing
});

const fmtPct = (v, sfx = '%') => v == null ? '—' : `${v}${sfx}`;
const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// An input may arrive as { value, atr, date } or as a bare number from an older caller. Both are
// accepted; a bare number simply has no scale and no vintage, and says so rather than pretending.
const norm = (x) => {
  if (x == null) return { value: null, atr: null, date: null, live: false, liveAsOf: null };
  if (typeof x === 'object' && !Array.isArray(x)) {
    return { value: num(x.value), atr: num(x.atr), date: x.date || null,
             // `live` is the only thing that exempts an input from the stale guard, so it is read
             // explicitly rather than inferred from a fresh-looking date.
             live: x.live === true, liveAsOf: x.liveAsOf || null };
  }
  return { value: num(x), atr: null, date: null, live: false, liveAsOf: null };
};

// The three condition shapes. Each returns met true / false / null, and null carries WHY — a
// condition that renders as a dash without saying whether it is missing, unscaled or merely small
// is three different situations wearing one face.
const NEUTRAL = (label, display, date, reason) => ({ label, met: null, display, date: date ?? null, reason, neutral: true });
// UNSCORED is its own state, not a flavour of neutral. Neutral means the INPUT said nothing;
// unscored means the input said something the board is not willing to score. Rendered with the
// distance to the line and the age of the print, because "no mark" without either is worse than
// the wrong mark it replaces.
const UNSCORED = (label, display, date, reason) =>
  ({ label, met: null, display, date: date ?? null, reason, neutral: false, unscored: true });

// A CHANGE that has to clear its own noise floor before it means anything.
function moveCond(label, input, test, fmt) {
  const { value, atr, date } = norm(input);
  if (value == null) return NEUTRAL(label, 'n/a', date, 'no value');
  if (atr == null || atr <= 0) return NEUTRAL(label, `${fmt(value)} · no ATR`, date, 'no ATR — magnitude cannot be judged against the instrument’s own range');
  const floor = ATR_GATE * atr;
  if (Math.abs(value) < floor) {
    // The floor is a MAGNITUDE, so it is rendered without the sign the value formatter adds —
    // "under 0.5×ATR (+2.05bps)" reads as a signed change and it is not one.
    const floorTxt = String(fmt(+floor.toFixed(2))).replace('+', '');
    return NEUTRAL(label, `${fmt(value)} · under ${ATR_GATE}×ATR (${floorTxt})`, date,
      'below half an ATR — too small to confirm or deny');
  }
  return { label, met: !!test(value), display: `${fmt(value)} · ${(Math.abs(value) / atr).toFixed(1)}×ATR`, date, reason: null, neutral: false };
}

// A LEVEL against a fixed threshold. The ATR gate applies to the DISTANCE from the line: a 30Y at
// 5.3501 against a 5.35 threshold is not above it in any sense a reader should act on.
//
// ── THE DISTANCE IS THE INFORMATION (P6) ─────────────────────────────────────
// The board rendered `✗ 30Y > 5.35%   5.25%` and that is three facts short. It does not say how
// far from the line, whether that distance is large or small for this instrument, or when the
// number was observed. On 2026-09-10 the live 30Y sat six tenths of a basis point under C's
// threshold and the card carried no hint of it. Every level condition now returns its gap in the
// instrument's own units, that gap as a multiple of the instrument's daily range, the vintage,
// and a `near` flag when it is inside half an ATR of the line.
function levelCond(label, input, threshold, test, fmt, { gapUnit = null, asOf = null } = {}) {
  const n = norm(input);
  const { value, atr, date, live } = n;
  if (value == null) return NEUTRAL(label, 'n/a', date, 'no value');

  const gap = value - threshold;
  const sign = gap >= 0 ? '+' : '−';
  const gapTxt = gapUnit === 'bp'
    ? `${sign}${Math.abs(gap * 100).toFixed(1)}bp`
    : `${sign}${Math.abs(gap).toFixed(2)}`;
  const atrMult = atr > 0 ? +(Math.abs(gap) / atr).toFixed(2) : null;
  const dist = `${gapTxt}${atrMult != null ? ` (${atrMult}×ATR)` : ''}`;
  // WHERE THE NUMBER CAME FROM, on the same line as the number. A live quote names its minute; a
  // delayed print names its observation date. Neither is left for the reader to assume.
  const vintage = live ? `live ${n.liveAsOf || date || ''}`.trim() : date ? `obs ${date}` : null;
  const shown = [fmt(value), dist, vintage].filter(Boolean).join(' · ');
  const base = { label, display: shown, date, gap: +gap.toFixed(4), gapDisplay: gapTxt,
                 atrMult, threshold, live: !!live, vintage };

  // ── THE GUARD (P0-2) ───────────────────────────────────────────────────────
  // Withheld, not marked. `0/2` on a stale print reads as "not close" and is worse than showing
  // nothing, so the count is suppressed too — see the scenario loop below.
  const st = staleReach(n, threshold, asOf);
  if (st) {
    const why = st.reach == null
      ? (st.days > MAX_STALE_BIZ_DAYS
          ? `the observation is ${st.days} business days old — past ${MAX_STALE_BIZ_DAYS}, no mark is published however clear of the line`
          : 'no ATR — the reach of a stale observation cannot be judged')
      : `the observation is ${st.days} business day${st.days === 1 ? '' : 's'} old and sits ${gapTxt} from the line, `
        + `inside the ${STALE_REACH_ATR}×ATR/day it could have travelled (±${st.reach})`;
    return { ...UNSCORED(label, shown, date, why), ...base, met: null, unscored: true,
             neutral: false, staleDays: st.days, reach: st.reach };
  }

  if (atr != null && atr > 0 && Math.abs(gap) < ATR_GATE * atr) {
    return { ...NEUTRAL(label, shown, date,
      'sitting on the threshold — closer to the line than the instrument’s own daily range'),
      ...base, met: null, neutral: true, near: true };
  }
  // ── ALREADY VINTAGE-CHECKED, ONE LEG AT A TIME ─────────────────────────────
  // A published level mark has just been asked the vintage question in the sharpest form there
  // is: could the age of this observation have carried the value across this line? The answer was
  // no, or there would be no mark. So it does not ALSO need the scenario-wide "all dates must
  // agree" veto, and applying both breaks the scenario that matters most.
  //
  // D is the case. Its legs are `30Y > 5.5%` and `HY OAS > 3.5%`; the 30Y is now live and there
  // is no live HY OAS anywhere on this board, so the two dates disagree every day by
  // construction. Without this the insurance scenario — the one that exists for the worst day —
  // could never confirm, however far through both lines the market went.
  //
  // MOVE conditions are NOT exempt and must still agree. A one-day change composed across two
  // different days is a statement about the release calendar, which is the failure lib/derived.js
  // was built for and the reason the blanket check exists at all.
  return { ...base, met: !!test(value), reason: null, neutral: false, near: false, dateSafe: true };
}

// A CATEGORICAL input — a volatility band, a boolean state. No magnitude, so no ATR gate; it is
// either reported or it is not.
const flagCond = (label, met, display, date = null) =>
  met == null ? NEUTRAL(label, display ?? 'n/a', date, 'not reported')
    : { label, met: !!met, display, date: date ?? null, reason: null, neutral: false };

// ── WHAT EACH SCENARIO WOULD MEAN, AND WHAT WOULD BREAK IT ───────────────────
// Observation only. The board describes state; it does not tell anyone what to hold. Sizing,
// entries and exits go through the console's guard panel and the decision log, where they are
// recorded against an outcome — a board that quietly issues instructions is a board nobody can
// audit afterwards.
//
// The FALSIFIER is the more useful of the two and the one usually missing: a scenario you cannot
// state a disproof for is a mood, not a reading.
const IMPLICATION = {
  A:  'Real yields falling with credit calm; duration is being bid for growth reasons, not stress',
  B:  'The dovish repricing is not reaching the long end — a term-premium problem, not a growth one',
  C:  'The long end is repricing hawkishly and everything held for its duration sells with it',
  D:  'A hawkish break and a credit crack at once — the combination insurance exists for',
  KM: 'Selling driven by mechanics rather than a view, so it exhausts rather than resolving',
  CP: 'The mainland policy premium is draining out of the name independently of the macro tape',
};
// ── THE FALSIFIER, SCORED ────────────────────────────────────────────────────
// These strings used to be the whole of it: rendered as grey prose under the conditions, read by a
// human, evaluated by nobody. On 2026-09-09 KM showed "2/3 · one leg away" while both halves of its
// own falsifier were true ON THE SAME SCREEN — CSOP 7709 units −7.2% (still falling) and VKOSPI
// −3.36%, which the Korea panel itself labelled "rolling over" and independently called EXHAUSTING.
// The board did not move, because nothing was scoring the sentence.
//
// A scenario you cannot state a disproof for is a mood rather than a reading — and a disproof you
// state but never evaluate is decoration. The predicates below use the same three helpers and the
// same ATR gate as the entry criteria, so a break is held to exactly the standard a confirmation is.
//
// `mode` is load-bearing. Some falsifiers are conjunctions ("X while Y") and some are disjunctions
// ("on either horizon"); collapsing them to one rule would either break scenarios that are still
// live or fail to break ones that are over.
const FALSIFIER = {
  A:  '10s30s steepening more than 0.5×ATR while TLT rises',
  B:  'TLT rising more than 0.5×ATR with the curve flattening — the duration bid returning',
  C:  '30Y back below the threshold by more than 0.5×ATR, or the basket no longer selling together',
  D:  'HY OAS back under the threshold while the 30Y stays high — hawkish, but credit is holding',
  KM: 'VKOSPI rolling over while units are still falling — the mechanical seller is done',
  CP: 'The A/H premium widening again on either horizon',
};

// live = {
//   us30y:{value}, oas:{value}, tenThirtyDeltaBps, tlt:{dir}, basket:[{name,dir}...],
//   korea:{ volBand, volRolling }, units7709:{ dayPct }, ah:{ d5, d20 }
// }  — any leg may be absent; its conditions then render null (n/a).
export function evaluateScenarios(live = {}, cfg = SCENARIO_CFG, { previous = [], now = null } = {}) {
  const { us30y, oas, tenThirtyDeltaBps, tlt, basket, korea, units7709, ah, koreaBidNonOrganic } = live;
  // The render date every threshold predicate ages its observation against. Defaulting to `now`
  // rather than to nothing: a guard that quietly turns itself off when a caller forgets an
  // argument is a guard nobody can rely on.
  const asOf = String(now || new Date().toISOString()).slice(0, 10);
  // Yields are quoted in percent and read in basis points. A 30Y "0.10 from the line" is ten
  // basis points and everyone on that desk says it that way.
  const bp = { gapUnit: 'bp', asOf };
  const lv = { asOf };

  // C — risk-parity basket selling together (TLT, XLU, XLP, IWM, GLD all falling).
  const basketRows = Array.isArray(basket) ? basket.filter(b => b && b.dir != null) : [];
  const allSelling = basketRows.length >= 3 ? basketRows.every(b => b.dir === 'falling') : null;
  const basketDisplay = basketRows.length ? `${basketRows.filter(b => b.dir === 'falling').length}/${basketRows.length} falling` : 'n/a';
  // One date for the basket only if every member shares it — otherwise the scenario's vintage check
  // has nothing honest to compare against and says so.
  const basketDates = [...new Set(basketRows.map(b => b?.date).filter(Boolean))];
  const basketDate = basketDates.length === 1 ? basketDates[0] : null;

  const scenarios = [
    {
      id: 'A', name: 'PLAN WORKS', tone: 'green',
      gloss: 'dovish data lifts duration; the curve does not break',
      conditions: [
        moveCond('TLT rising (duration bid)', tlt, v => v > 0, v => `TLT ${v >= 0 ? '+' : ''}${v}%`),
        moveCond('10s30s not steepening', tenThirtyDeltaBps, v => v <= 0, v => `${v >= 0 ? '+' : ''}${v}bps 1d`),
      ],
      breaks: { mode: 'all', conditions: [
        moveCond('10s30s steepening', tenThirtyDeltaBps, v => v > 0, v => `${v >= 0 ? '+' : ''}${v}bps 1d`),
        moveCond('TLT rising', tlt, v => v > 0, v => `TLT ${v >= 0 ? '+' : ''}${v}%`),
      ] },
    },
    {
      id: 'B', name: 'DURATION LEG BREAKS', tone: 'amber',
      gloss: 'dovish data but TLT will not hold; the long end steepens',
      conditions: [
        moveCond('TLT falling', tlt, v => v < 0, v => `TLT ${v >= 0 ? '+' : ''}${v}%`),
        moveCond('10s30s steepening', tenThirtyDeltaBps, v => v > 0, v => `${v >= 0 ? '+' : ''}${v}bps 1d`),
      ],
      breaks: { mode: 'all', conditions: [
        moveCond('TLT rising', tlt, v => v > 0, v => `TLT ${v >= 0 ? '+' : ''}${v}%`),
        moveCond('10s30s flattening', tenThirtyDeltaBps, v => v < 0, v => `${v >= 0 ? '+' : ''}${v}bps 1d`),
      ] },
    },
    {
      id: 'C', name: 'HAWKISH RETURNS', tone: 'amber',
      gloss: 'long-end yields break higher; everything rate-sensitive sells together',
      conditions: [
        levelCond(`30Y > ${cfg.hawkish30y}%`, us30y, cfg.hawkish30y, v => v > cfg.hawkish30y, v => fmtPct(v), bp),
        flagCond('gold/TLT/XLU/XLP/IWM selling together', allSelling, basketDisplay, basketDate),
      ],
      // "or" — either leg alone ends it. The basket no longer selling together is enough on its
      // own; so is the 30Y coming back through the line by more than its own daily range.
      breaks: { mode: 'any', conditions: [
        levelCond(`30Y back below ${cfg.hawkish30y}%`, us30y, cfg.hawkish30y, v => v < cfg.hawkish30y, v => fmtPct(v), bp),
        flagCond('basket no longer selling together', allSelling == null ? null : !allSelling, basketDisplay, basketDate),
      ] },
    },
    {
      id: 'D', name: 'DISORDERLY', tone: 'red',
      gloss: 'a hawkish break AND credit cracking at the same time',
      conditions: [
        levelCond(`30Y > ${cfg.disorderly30y}%`, us30y, cfg.disorderly30y, v => v > cfg.disorderly30y, v => fmtPct(v), bp),
        levelCond(`HY OAS > ${cfg.disorderlyOas}%`, oas, cfg.disorderlyOas, v => v > cfg.disorderlyOas, v => fmtPct(v, ''), lv),
      ],
      breaks: { mode: 'all', conditions: [
        levelCond(`HY OAS back under ${cfg.disorderlyOas}%`, oas, cfg.disorderlyOas, v => v < cfg.disorderlyOas, v => fmtPct(v, ''), lv),
        levelCond(`30Y still above ${cfg.disorderly30y}%`, us30y, cfg.disorderly30y, v => v > cfg.disorderly30y, v => fmtPct(v), bp),
      ] },
    },
    {
      id: 'KM', name: 'KOREA MECHANICAL UNWIND', tone: 'amber',
      gloss: 'forced-seller signature — mean-reverts violently once it exhausts',
      conditions: [
        moveCond(`7709 units falling >${Math.abs(cfg.units7709Drop)}%/day`, units7709?.dayPct != null || units7709?.value != null ? { value: units7709.value ?? units7709.dayPct, atr: units7709.atr, date: units7709.date } : null,
          v => v <= cfg.units7709Drop, v => `${v >= 0 ? '+' : ''}${v}% 1d`),
        flagCond('VKOSPI extreme', korea?.volBand == null ? null : (korea.volBand === 'EXTREME' || korea.volBand === 'HIGH'), korea?.volBand ? korea.volBand : 'n/a', korea?.date),
        flagCond('VKOSPI not yet rolled', korea?.volRolling == null ? null : korea.volRolling === false, korea?.volRolling == null ? 'n/a' : (korea.volRolling ? 'rolling over' : 'not rolled'), korea?.date),
      ],
      // The one that was observed failing. Note the second leg is "still falling" — ANY fall, not
      // the >X%/day the entry condition needs. The unwind exhausting is about the seller finishing
      // while supply is still coming, not about the pace of it.
      breaks: { mode: 'all', conditions: [
        flagCond('VKOSPI rolling over', korea?.volRolling == null ? null : korea.volRolling === true,
          korea?.volRolling == null ? 'n/a' : (korea.volRolling ? 'rolling over' : 'not rolled'), korea?.date),
        moveCond('7709 units still falling', units7709?.dayPct != null || units7709?.value != null ? { value: units7709.value ?? units7709.dayPct, atr: units7709.atr, date: units7709.date } : null,
          v => v < 0, v => `${v >= 0 ? '+' : ''}${v}% 1d`),
      ] },
    },
    {
      id: 'CP', name: 'CHINA POLICY TRADE UNWINDING', tone: 'amber',
      gloss: 'mainland enthusiasm draining — the A/H premium leads the name',
      conditions: [
        moveCond('SMIC A/H premium compressing 5d', ah?.d5 == null ? null : { value: ah.d5, atr: ah.atr5 ?? ah.atr, date: ah.date }, v => v < cfg.ahCompress, v => `${v >= 0 ? '+' : ''}${v}pp 5d`),
        moveCond('SMIC A/H premium compressing 20d', ah?.d20 == null ? null : { value: ah.d20, atr: ah.atr20 ?? ah.atr, date: ah.date }, v => v < cfg.ahCompress, v => `${v >= 0 ? '+' : ''}${v}pp 20d`),
      ],
      breaks: { mode: 'any', conditions: [
        moveCond('A/H premium widening 5d', ah?.d5 == null ? null : { value: ah.d5, atr: ah.atr5 ?? ah.atr, date: ah.date }, v => v > 0, v => `${v >= 0 ? '+' : ''}${v}pp 5d`),
        moveCond('A/H premium widening 20d', ah?.d20 == null ? null : { value: ah.d20, atr: ah.atr20 ?? ah.atr, date: ah.date }, v => v > 0, v => `${v >= 0 ? '+' : ''}${v}pp 20d`),
      ] },
    },
  ];

  // A2 — the CONSEQUENCE: not what is true, but what to DO about it. One line per scenario, rendered
  // under the conditions and fed into the posture headline card.
  const CONSEQUENCE = {
    A:  'Duration leg validated — USFR → IEF/TLT sequencing on track',
    B:  'Skip the bond leg — go bills → equities directly',
    C:  'Stay in bills. The AI book is the exposure',
    D:  'Insurance scenario — credit confirming is what separates this from C',
    KM: 'Do not add Korea risk until VKOSPI rolls. Mean-reverts violently once exhausted',
    CP: "SMIC's policy premium is draining — position risk independent of macro",
  };
  // A3 — consequence WEIGHT: scenarios touching the largest position or the cash-deployment decision
  // outrank the rest. D (insurance trigger) is highest when confirmed; KM/CP hit the biggest book
  // positions (Korea memory block, SMIC ~⅓ NLV); A/B/C drive the cash-deployment sequence.
  const WEIGHT = { D: 9, KM: 8, CP: 8, A: 6, B: 6, C: 6 };
  const posture = { A: 'supportive', B: 'supportive', C: 'adverse', D: 'adverse', KM: 'adverse', CP: 'adverse' };
  // A1 — the single metric closest to flipping each scenario (fed to the headline WATCH line).
  const WATCH = {
    A:  '10s30s — a steepening flips this to B (duration leg breaks)',
    B:  'TLT — a resumed bid flips this back to A',
    C:  '30Y back below 5.35% or the rate-sensitive basket stops selling together',
    D:  'HY OAS — credit cracking (>3.5%) is what confirms this over C',
    KM: 'VKOSPI — rising; the unwind exhausts only once it rolls over',
    CP: 'SMIC A/H premium — watch for the compression to stall or reverse',
  };

  // ── VINTAGE: A SCENARIO IS A DERIVED VALUE ──────────────────────────────────
  // Scenario A was validating a duration thesis from a TLT quote twelve hours old against rate
  // cards stale to 09-01. Composing observations from different days produces a statement about
  // the release calendar, not about the market — the exact failure lib/derived.js was built for,
  // so it is routed through the same helper rather than given a second implementation.
  //
  // A mismatch renders UNVERIFIED with the disagreeing dates, NOT a checkmark and not a blank. A
  // board that silently stops verifying is worse than one that never did: it looks identical.
  const prevById = Object.fromEntries((Array.isArray(previous) ? previous : []).map(p => [p?.id, p]));
  const stamp = now || new Date().toISOString();

  for (const s of scenarios) {
    const evaluable = s.conditions.filter(c => c.met !== null);
    s.met = evaluable.filter(c => c.met).length;
    s.total = evaluable.length;
    // ── UNSCORED IS ITS OWN COUNT AND ITS OWN STATE (P0-2) ────────────────────
    // A condition the guard withheld is not "unavailable" — the input arrived, it is simply not
    // safe to mark. Counted separately so the header can say which of the two it is, and so a
    // withheld mark never quietly inflates the missing-input tally.
    s.unscoredConditions = s.conditions.filter(c => c.unscored);
    s.unscored = s.unscoredConditions.length;
    s.unavailable = s.conditions.length - evaluable.length - s.unscored;
    // NEAR — any unmet leg sitting inside half an ATR of its own line (P6). This is the state the
    // 2026-09-10 board could not express: C was six tenths of a basis point from confirming and
    // rendered identically to a scenario nowhere near it.
    s.nearConditions = s.conditions.filter(c => c.near);
    s.near = s.nearConditions.length > 0;
    // Neutral is its own count: "two inputs too small to read" is a different board from "two
    // inputs missing", and both used to render as the same dash.
    s.neutral = s.conditions.filter(c => c.neutral && c.reason && !/no value|not reported/.test(c.reason)).length;

    // Only the conditions actually contributing to the verdict need to agree on a date — and only
    // those that have not already passed a sharper per-leg vintage test of their own. See
    // `dateSafe` in levelCond.
    const dated = evaluable.filter(c => c.date && !c.dateSafe);
    const align = aligned(dated.map((c, i) => ({ name: c.label || `c${i}`, value: 1, date: c.date })), () => 1);
    s.vintage = dated.length === 0
      ? { checked: false, date: null, reason: 'no observation dates on the contributing inputs' }
      : { checked: align.checked, date: align.date, reason: align.reason, dates: align.dates };
    s.unverified = dated.length > 1 && !align.checked;

    // ── SUPPRESSING EVIDENCE MUST NOT STRENGTHEN A CONCLUSION ─────────────────
    // `met === total` with nulls excluded from the denominator means every condition that drops
    // out makes the scenario EASIER to confirm. With the ATR gate live that is not a rare edge: on
    // 2026-09-03 Scenario A read CONFIRMED 1/1 while the TLT leg — the duration bid the scenario is
    // named for — was suppressed for being under half an ATR. "PLAN WORKS · Duration leg validated"
    // on a board where duration said nothing.
    //
    // So CONFIRMED requires every condition to have been READABLE. A missing feed and a move too
    // small to interpret are different reasons and the same consequence: there is no complete
    // reading, so there is no confirmation. The met/total count still shows what was true of what
    // could be seen — the claim is what is withheld, not the arithmetic.
    s.allReadable = s.conditions.every(c => c.met !== null);
    s.confirmed = !s.unverified && s.total > 0 && s.met === s.total && s.allReadable;

    // ── IS IT OVER? ───────────────────────────────────────────────────────────
    // Scored on the SAME terms as a confirmation, including the ATR gate and the vintage check,
    // because a break called from a move too small to read or from observations taken on different
    // days is the same error a confirmation would be — and it is the more expensive one here,
    // since it retires a scenario rather than raising it.
    //
    // The vintage check runs over the BREAK's own contributing conditions, not the scenario's.
    // Entry legs disagreeing on their dates says nothing about whether the disproof is composable,
    // and letting it veto would leave a dead scenario reading "one leg away" for the wrong reason.
    const bx = s.breaks?.conditions || [];
    const bEval = bx.filter(c => c.met !== null);
    s.breakConditions = bx;
    s.breakMode = s.breaks?.mode || 'all';
    s.breakMet = bEval.filter(c => c.met).length;
    s.breakTotal = bEval.length;
    const bDated = bEval.filter(c => c.date && !c.dateSafe);
    const bAlign = aligned(bDated.map((c, i) => ({ name: c.label || `b${i}`, value: 1, date: c.date })), () => 1);
    s.breakUnverified = bDated.length > 1 && !bAlign.checked;
    s.breakVintage = bDated.length === 0
      ? { checked: false, date: null, reason: 'no observation dates on the break inputs' }
      : { checked: bAlign.checked, date: bAlign.date, reason: bAlign.reason, dates: bAlign.dates };
    // 'all' demands every leg readable AND met — a conjunction with a leg it cannot see is not
    // satisfied, it is unknown. 'any' needs one met leg and does not care that others are dark.
    s.broken = !s.breakUnverified && bx.length > 0 && (
      s.breakMode === 'any'
        ? s.breakMet > 0
        : bEval.length === bx.length && bEval.length > 0 && s.breakMet === bEval.length);
    s.brokenBy = s.broken ? bEval.filter(c => c.met).map(c => `${c.label} (${c.display})`) : [];

    s.status = s.broken ? 'BROKEN'
      : s.unverified ? 'UNVERIFIED'
      : s.confirmed ? 'CONFIRMED'
      // ── THE COUNT IS SUPPRESSED, NOT JUST THE MARK ────────────────────────
      // "0/2" on a stale print reads as "not close" and is worse than showing nothing. It ranks
      // above PARTIAL because it is a statement about the BOARD rather than about the market: a
      // reader who sees PARTIAL believes the evidence was weighed.
      : s.unscored > 0 ? 'UNSCORED'
      // Everything that COULD be read agrees, but something could not be read. Named separately
      // from PARTIAL because it is a different message: not "the evidence is mixed" but "the
      // evidence is incomplete, and what there is of it points one way".
      : (s.total > 0 && s.met === s.total && !s.allReadable) ? 'INCOMPLETE'
      : s.total > 0 ? 'PARTIAL' : 'UNREADABLE';
    // A BROKEN scenario is not "close to firing" however many entry legs happen to be true — that
    // is the exact misreading the brief flagged, where 2/3 read as one leg away from a scenario
    // that was already over. It sorts as a non-finding, like UNVERIFIED.
    // A withheld mark cannot contribute a proximity either — that is the same false precision one
    // step along, and it is what would put an UNSCORED scenario back at the top of the board.
    s.proximity = (s.unverified || s.broken || s.unscored > 0) ? -1 : s.total > 0 ? s.met / s.total : -1;   // sort key
    // The count, ready to render, so no surface has to re-derive when to suppress it.
    s.countDisplay = (s.unverified || s.unscored > 0) ? null : s.total > 0 ? `${s.met}/${s.total}` : null;
    // WHAT IS BEING WITHHELD AND WHY, in the header's own words.
    s.unscoredNote = s.unscored > 0
      ? s.unscoredConditions.map(c => `${c.label} — ${c.reason}`).join(' · ')
      : null;
    // THE NEAREST UNMET LEG, for the header chip and for sorting. Distance in the leg's own units.
    s.nearest = [...s.nearConditions].sort((a, b) => Math.abs(a.gap ?? Infinity) - Math.abs(b.gap ?? Infinity))[0] || null;
    s.consequence = CONSEQUENCE[s.id] || null;
    s.implication = IMPLICATION[s.id] || null;
    s.falsifier = FALSIFIER[s.id] || null;
    s.weight = WEIGHT[s.id] ?? 5;
    s.side = posture[s.id] || 'neutral';   // supportive vs adverse for the book (headline WORKING/NOT)
    s.watch = WATCH[s.id] || null;
    // A cross-panel qualifier, not a condition. It does not move the count or the status — it
    // lowers what the count is worth, and says why, on the one scenario it bears on.
    s.qualifier = (s.id === 'KM' && koreaBidNonOrganic)
      ? 'Lower conviction — the Korean bid is not organic. Gate 2 reads SUSPECT and institutions '
        + 'are the sole net buyer, so the tape is held up by one counterparty. An unwind '
        + 'exhausting against a supported bid says less about what follows than one exhausting '
        + 'against organic flow.'
      : null;

    // ── HOW LONG IT HAS SAID THIS ─────────────────────────────────────────────
    // A scenario sitting at 2/2 for three weeks and one that turned this morning read identically,
    // and they are not the same information. The stamp moves only when the READING changes —
    // status or met-count — so a stable board does not reset its own clock every refresh.
    const prev = prevById[s.id];
    const same = prev && prev.status === s.status && prev.met === s.met && prev.total === s.total
      && !!prev.broken === !!s.broken;
    s.lastFlipped = same ? (prev.lastFlipped || stamp) : stamp;
    s.flippedNow = !same && !!prev;
  }
  // A3 — sort by CONSEQUENCE, not raw proximity: confirmed first, then by book/cash-deployment
  // weight, ties broken by proximity then met-count.
  // UNVERIFIED never sorts to the top. It is not a finding, it is the absence of one.
  scenarios.sort((a, b) =>
    (Number(a.unverified) - Number(b.unverified)) ||
    // A NEAR scenario sorts UP. On 2026-09-10 C sat six tenths of a basis point from its line and
    // ranked as an ordinary miss, which is the difference between a board a reader scans and one
    // a reader has to reconstruct. Above weight, because a leg about to trip outranks a heavier
    // scenario that is nowhere near tripping — but still below confirmed and below BROKEN's
    // demotion, so it cannot resurrect a scenario that is over.
    (Number(b.near && !b.broken && !b.unverified) - Number(a.near && !a.broken && !a.unverified)) ||
    // Below live findings, above nothing else. A scenario that just died still matters — KM and CP
    // carry the two biggest book positions — so it keeps its consequence weight rather than being
    // swept to the bottom where a reader would never see that it had ended.
    (Number(a.broken) - Number(b.broken)) ||
    (Number(b.confirmed) - Number(a.confirmed)) ||
    (b.weight - a.weight) ||
    (b.proximity - a.proximity) ||
    (b.met - a.met));
  return scenarios;
}
