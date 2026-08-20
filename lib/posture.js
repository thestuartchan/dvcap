// lib/posture.js — the headline POSTURE card (A1). Deterministic, no model. A confirmed scenario
// states what is TRUE; the posture card states what to DO — and resolves the fact that several
// scenarios can read confirmed at once pointing opposite ways. Derived from the tripwire count, the
// vol-regime state, the credit gate, and which confirmed scenarios are supportive vs adverse.

const daysTo = (dateStr, nowMs) => {
  const ms = Date.parse(String(dateStr) + 'T00:00:00Z');
  if (!Number.isFinite(ms)) return null;
  return Math.round((ms - nowMs) / 86400000);
};

export function composePosture({ scenarios = [], leaning, volTerm, credit, calendar = [], events = [], nowMs = 0 } = {}) {
  const confirmed = scenarios.filter(s => s.confirmed);
  const working = confirmed.filter(s => s.side === 'supportive');
  const adverse = confirmed.filter(s => s.side === 'adverse');

  // ── Deterministic posture score (higher = more de-risked) ──
  let score = 0;
  const reasons = [];
  const trippedRatio = leaning?.usable ? leaning.tripped / leaning.usable : 0;
  if (trippedRatio >= 0.6) { score += 1; reasons.push(`${leaning.tripped}/${leaning.usable} tripwires`); }
  else if (trippedRatio >= 0.4) score += 0.5;
  if (volTerm?.regime === 'BACKWARDATION') { score += 1; reasons.push('vol backwardation'); }
  else if (volTerm?.regime === 'FLAT') score += 0.5;
  const cstate = String(credit?.effective || credit?.state || credit?.level || '').toLowerCase();
  if (/stress|recession/.test(cstate)) { score += 1.5; reasons.push('credit stressed'); }
  else if (/watch|widen/.test(cstate)) score += 0.5;
  for (const s of adverse) score += (s.id === 'D' ? 1.5 : 1);
  for (const s of working) score -= 0.5;

  let posture, tone;
  if (!scenarios.length && !(leaning?.usable)) { posture = 'NO SIGNAL'; tone = 'muted'; }
  else if (score >= 2.5) { posture = 'RISK-OFF'; tone = 'red'; }
  else if (score <= 0)   { posture = 'RISK-ON'; tone = 'green'; }
  else                   { posture = 'NEUTRAL, SELECTIVE'; tone = 'amber'; }

  // WORKING / NOT — confirmed scenarios split supportive vs adverse.
  const workingLines = working.map(s => `${s.consequence || s.name} (${s.id} ${s.met}/${s.total})`);
  const notLines     = adverse.map(s => `${s.name} (${s.id} ${s.met}/${s.total})`);
  // Supportive market context worth naming even without a confirmed scenario.
  if (volTerm?.regime === 'CONTANGO') workingLines.push('vol contango — dips buyable, premium sellable');
  if (/calm/.test(cstate)) workingLines.push('credit calm');

  // DO — consequences of confirmed scenarios, highest weight first.
  const doLines = [...confirmed].sort((a, b) => b.weight - a.weight).map(s => s.consequence).filter(Boolean);

  // WATCH — the watch metric of the highest-weight confirmed scenario (else the closest to confirming).
  const topConfirmed = [...confirmed].sort((a, b) => b.weight - a.weight)[0];
  const nearest = [...scenarios].filter(s => !s.confirmed && s.proximity > 0).sort((a, b) => (b.proximity - a.proximity) || (b.weight - a.weight))[0];
  const watch = (topConfirmed || nearest)?.watch || null;

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
    tripwires: leaning?.usable ? `${leaning.tripped}/${leaning.usable}` : null,
    scoreReasons: reasons,
    working: workingLines,
    not: notLines,
    do: doLines,
    watch,
    next,
  };
}
