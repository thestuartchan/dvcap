// lib/scenarios.js — the scenario board (Part C shared structure). The dashboard is
// category-bucketed; this is the synthesis layer that answers "which scenario am I in" without
// making the user assemble it from five sections. Each scenario is a name + 2–4 confirming
// conditions, each with a threshold and a live value, plus an X/N met-count. Sorted by proximity
// to confirming. EVERY threshold lives in SCENARIO_CFG so the board is retuned in one place.
//
// A condition's `met` is true / false / null (input unavailable — shown as "n/a", never counted
// as met and never as a clean miss).

export const SCENARIO_CFG = Object.freeze({
  hawkish30y:     5.35,   // C — 30Y yield above this = hawkish repricing underway
  disorderly30y:  5.50,   // D — 30Y above this AND …
  disorderlyOas:  3.50,   // D — … HY OAS above this = disorderly
  units7709Drop:  -3,     // Korea mechanical — 7709 units 1d % at/below this
  ahCompress:     0,      // China policy — A/H premium change below this (pp) = compressing
});

const fmtPct = (v, sfx = '%') => v == null ? '—' : `${v}${sfx}`;
const cond = (label, met, display) => ({ label, met: met == null ? null : !!met, display });

// live = {
//   us30y:{value}, oas:{value}, tenThirtyDeltaBps, tlt:{dir}, basket:[{name,dir}...],
//   korea:{ volBand, volRolling }, units7709:{ dayPct }, ah:{ d5, d20 }
// }  — any leg may be absent; its conditions then render null (n/a).
export function evaluateScenarios(live = {}, cfg = SCENARIO_CFG) {
  const { us30y, oas, tenThirtyDeltaBps, tlt, basket, korea, units7709, ah } = live;
  const y30 = us30y?.value ?? null;
  const oasV = oas?.value ?? null;

  // C — risk-parity basket selling together (TLT, XLU, XLP, IWM, GLD all falling).
  const basketRows = Array.isArray(basket) ? basket.filter(b => b && b.dir != null) : [];
  const allSelling = basketRows.length >= 3 ? basketRows.every(b => b.dir === 'falling') : null;
  const basketDisplay = basketRows.length ? `${basketRows.filter(b => b.dir === 'falling').length}/${basketRows.length} falling` : 'n/a';

  const scenarios = [
    {
      id: 'A', name: 'PLAN WORKS', tone: 'green',
      gloss: 'dovish data lifts duration; the curve does not break',
      conditions: [
        cond('TLT rising (duration bid)', tlt?.dir == null ? null : tlt.dir === 'rising', tlt?.dir ? `TLT ${tlt.dir}` : 'n/a'),
        cond('10s30s not steepening', tenThirtyDeltaBps == null ? null : tenThirtyDeltaBps <= 0, tenThirtyDeltaBps == null ? 'n/a' : `${tenThirtyDeltaBps >= 0 ? '+' : ''}${tenThirtyDeltaBps}bps 1d`),
      ],
    },
    {
      id: 'B', name: 'DURATION LEG BREAKS', tone: 'amber',
      gloss: 'dovish data but TLT will not hold; the long end steepens',
      conditions: [
        cond('TLT flat or falling', tlt?.dir == null ? null : tlt.dir !== 'rising', tlt?.dir ? `TLT ${tlt.dir}` : 'n/a'),
        cond('10s30s steepening', tenThirtyDeltaBps == null ? null : tenThirtyDeltaBps > 0, tenThirtyDeltaBps == null ? 'n/a' : `${tenThirtyDeltaBps >= 0 ? '+' : ''}${tenThirtyDeltaBps}bps 1d`),
      ],
    },
    {
      id: 'C', name: 'HAWKISH RETURNS', tone: 'amber',
      gloss: 'long-end yields break higher; everything rate-sensitive sells together',
      conditions: [
        cond(`30Y > ${cfg.hawkish30y}%`, y30 == null ? null : y30 > cfg.hawkish30y, fmtPct(y30)),
        cond('gold/TLT/XLU/XLP/IWM selling together', allSelling, basketDisplay),
      ],
    },
    {
      id: 'D', name: 'DISORDERLY', tone: 'red',
      gloss: 'a hawkish break AND credit cracking at the same time',
      conditions: [
        cond(`30Y > ${cfg.disorderly30y}%`, y30 == null ? null : y30 > cfg.disorderly30y, fmtPct(y30)),
        cond(`HY OAS > ${cfg.disorderlyOas}%`, oasV == null ? null : oasV > cfg.disorderlyOas, fmtPct(oasV, '')),
      ],
    },
    {
      id: 'KM', name: 'KOREA MECHANICAL UNWIND', tone: 'amber',
      gloss: 'forced-seller signature — mean-reverts violently once it exhausts',
      conditions: [
        cond(`7709 units falling >${Math.abs(cfg.units7709Drop)}%/day`, units7709?.dayPct == null ? null : units7709.dayPct <= cfg.units7709Drop, units7709?.dayPct == null ? 'n/a' : `${units7709.dayPct >= 0 ? '+' : ''}${units7709.dayPct}% 1d`),
        cond('VKOSPI extreme', korea?.volBand == null ? null : (korea.volBand === 'EXTREME' || korea.volBand === 'HIGH'), korea?.volBand ? korea.volBand : 'n/a'),
        cond('VKOSPI not yet rolled', korea?.volRolling == null ? null : korea.volRolling === false, korea?.volRolling == null ? 'n/a' : (korea.volRolling ? 'rolling over' : 'not rolled')),
      ],
    },
    {
      id: 'CP', name: 'CHINA POLICY TRADE UNWINDING', tone: 'amber',
      gloss: 'mainland enthusiasm draining — the A/H premium leads the name',
      conditions: [
        cond('SMIC A/H premium compressing 5d', ah?.d5 == null ? null : ah.d5 < cfg.ahCompress, ah?.d5 == null ? 'n/a' : `${ah.d5 >= 0 ? '+' : ''}${ah.d5}pp 5d`),
        cond('SMIC A/H premium compressing 20d', ah?.d20 == null ? null : ah.d20 < cfg.ahCompress, ah?.d20 == null ? 'n/a' : `${ah.d20 >= 0 ? '+' : ''}${ah.d20}pp 20d`),
      ],
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

  // Score each: met / evaluable (nulls excluded from the denominator). Confirmed when every
  // evaluable condition is met and at least one was evaluable.
  for (const s of scenarios) {
    const evaluable = s.conditions.filter(c => c.met !== null);
    s.met = evaluable.filter(c => c.met).length;
    s.total = evaluable.length;
    s.unavailable = s.conditions.length - evaluable.length;
    s.confirmed = s.total > 0 && s.met === s.total;
    s.proximity = s.total > 0 ? s.met / s.total : -1;   // sort key
    s.consequence = CONSEQUENCE[s.id] || null;
    s.weight = WEIGHT[s.id] ?? 5;
    s.side = posture[s.id] || 'neutral';   // supportive vs adverse for the book (headline WORKING/NOT)
    s.watch = WATCH[s.id] || null;
  }
  // A3 — sort by CONSEQUENCE, not raw proximity: confirmed first, then by book/cash-deployment
  // weight, ties broken by proximity then met-count.
  scenarios.sort((a, b) =>
    (Number(b.confirmed) - Number(a.confirmed)) ||
    (b.weight - a.weight) ||
    (b.proximity - a.proximity) ||
    (b.met - a.met));
  return scenarios;
}
