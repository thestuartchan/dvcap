// lib/occHealth.js — was the map that went out actually sound, and would anyone know?
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// Every soundness check the settled rung runs already exists: occVintage says whether the file
// rolled and held still, mergeOccIv reports coverage against CBOE, compareGex scores the walls
// against a second source, and the rung itself degrades honestly when any of it fails.
//
// All of it is computed at request time and thrown away. So the questions that actually matter —
// "has the brief ever gone out on a stale book?", "how often does the cross-check disagree?",
// "is this getting better or worse?" — had no answer at all, and the only way anyone would learn
// the map was wrong was by reading a footer at the moment it was wrong.
//
// Three nights of scheduled probes were spent chasing OCC's publication hour. That was the wrong
// target. The rung has never trusted a clock — it asks the file whether it rolled — so the hour is
// DIAGNOSTIC and the verdict is load-bearing. This records the verdict, on every call, for ever.
//
// ── AND IT CLOSES WITHOUT A SAMPLING GRID ────────────────────────────────────
// The open question left by the probes was atomic-versus-progressive, which seemed to need
// minute-resolution sampling through a roll nobody can predict. It does not. A settlement that is
// written atomically produces exactly ONE fingerprint transition; a progressive write produces two
// or more, and the gap between the first and last IS the write duration — the number
// OCC_CONFIRM_MIN has to exceed. Counting transitions per settlement answers it from whatever
// traffic there happens to be, and the answer sharpens on its own as the panel gets used.

export const HEALTH_MAX = 400;        // ~three months of weekday publishes plus panel traffic

// How close two transitions have to be to belong to the same settlement rather than to two nights.
// Generous on purpose: a settlement runs in minutes and the next one is a day away, so anything
// short of several hours is the same event.
export const SAME_WRITE_MAX_MIN = 240;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;

// ── ONE SAMPLE ───────────────────────────────────────────────────────────────
// GRADED, because "ok" is not one question. A book that rolled and held still but disagrees with
// CBOE on a wall is a different failure from one that never rolled, and folding them into a
// boolean would make the rarer and worse of the two invisible inside the commoner one.
//
// The order is worst-first and the FIRST match wins: a stale book that also disagrees with CBOE is
// reported as stale, because that is the one that has to be fixed.
export function grade(s) {
  if (!s) return 'failed';
  if (s.ok === false) return 'failed';
  if (s.shrank === true) return 'suspect';              // smaller than last time — partial write
  if (s.rolledSinceClose === false) return 'stale';     // the previous session's book
  if (s.coverage != null && s.coverage < 0.9) return 'thin';
  if (s.complete !== true) return 'unconfirmed';        // rolled but not held long enough, or first ever
  if (s.crossCheckClean === false) return 'disputed';   // rolled, held, and a second source disagrees
  if (s.ivReusedMin != null) return 'reusedIv';         // sound book, surface older than the fetch
  return 'sound';
}

// Everything the map's soundness turns on, flattened from a settledGex result. Deliberately small:
// this is written on every call and read a page at a time.
export function healthSample(res, { symbol, at = new Date().toISOString(), published = false, rung = null } = {}) {
  if (!res) return null;
  const v = res.vintage || null, oi = res.oi || null, x = res.crossCheck || null;
  const s = {
    at, symbol, published: !!published, rung: rung ?? (res.ok ? 'occ' : null),
    ok: res.ok !== false,
    ...(res.ok === false ? { why: String(res.reason || 'unknown').slice(0, 120) } : {}),
    fingerprint: v?.fingerprint ?? null,
    rolledSinceClose: v?.rolledSinceClose ?? null,
    complete: v?.complete ?? null,
    shrank: v?.shrank ?? null,
    unchangedMin: v?.unchangedMin ?? null,
    rows: v?.rows ?? null,
    coverage: num(oi?.coverage),
    missingFromOcc: oi?.missingFromOcc ?? null,
    deltaVsCboe: oi?.deltaVsCboe ?? null,
    // null when no cross-check ran at all, which is a third state and not a pass.
    crossCheckClean: x?.ok ? !!x.clean : null,
    crossCheckVerdict: x?.ok ? String(x.verdict || '').slice(0, 90) : null,
    spotSource: res.spotSource ?? null,
    ivReusedMin: res.chain?.ivBlackout?.ageMin ?? null,
    expiries: Array.isArray(res.expiriesUsed) ? res.expiriesUsed.length : null,
    expiriesDropped: res.expiriesDropped?.length || 0,
  };
  return { ...s, grade: grade(s) };
}

export function appendHealth(log = [], sample, max = HEALTH_MAX) {
  if (!sample) return Array.isArray(log) ? log : [];
  return [...(Array.isArray(log) ? log : []), sample].slice(-max);
}

// ── WAS WHAT WENT OUT SOUND? ─────────────────────────────────────────────────
// The loop closes on the PUBLISHED samples, not on all of them. Panel traffic at 3am is worth
// recording and says nothing about whether the brief was right; the brief is the thing that
// reaches a reader and cannot be taken back.
export function healthSummary(log = [], { days = 30, now = new Date(), symbol = null } = {}) {
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const rows = (Array.isArray(log) ? log : [])
    .filter(r => r?.at && r.at >= since && (!symbol || r.symbol === symbol));
  const pub = rows.filter(r => r.published);
  const tally = (list) => list.reduce((m, r) => ({ ...m, [r.grade]: (m[r.grade] || 0) + 1 }), {});
  const sound = pub.filter(r => r.grade === 'sound').length;
  // EXCEPTIONS ARE LISTED, NOT COUNTED. A rate alone cannot be acted on; the dates and the reason
  // are what a person needs to decide whether it mattered.
  const exceptions = pub.filter(r => r.grade !== 'sound')
    .map(r => ({ at: r.at, symbol: r.symbol, grade: r.grade, rung: r.rung,
                 detail: r.grade === 'stale' ? `book had not rolled since the prior close`
                       : r.grade === 'unconfirmed' ? `rolled ${r.unchangedMin}min before the read — under the confirm window`
                       : r.grade === 'disputed' ? r.crossCheckVerdict
                       : r.grade === 'thin' ? `coverage ${(r.coverage * 100).toFixed(1)}%`
                       : r.grade === 'reusedIv' ? `vol surface ${r.ivReusedMin}min older than the fetch`
                       : r.grade === 'suspect' ? `${r.rows} rows — smaller than the prior settlement`
                       : r.why || null }));
  return {
    days, n: rows.length, published: pub.length, sound,
    // Null rather than 100% on an empty window: a rate computed over nothing is not a pass, and
    // reporting one is how a monitor that has stopped receiving data reads as healthy.
    soundPct: pub.length ? +((sound / pub.length) * 100).toFixed(1) : null,
    byGrade: tally(rows), publishedByGrade: tally(pub),
    exceptions,
    note: !pub.length ? `no published map recorded in ${days} days — the brief has not run, or is not stamping what it publishes`
        : `${sound} of ${pub.length} published maps sound over ${days} days`
          + (exceptions.length ? ` · ${exceptions.length} exception${exceptions.length === 1 ? '' : 's'}` : ''),
  };
}

// ── ATOMIC OR PROGRESSIVE, FROM WHATEVER TRAFFIC THERE IS ────────────────────
// Transitions are grouped into RUNS: consecutive rolls closer together than SAME_WRITE_MAX_MIN
// belong to one settlement. A run of one is an atomic write at the resolution observed. A run of
// two or more is a progressive write, and its span is how long the file spent changing — which is
// the floor OCC_CONFIRM_MIN must clear, or the stability check passes a half-written file.
//
// This needs no sampling schedule. It gets sharper as the panel is used and it cannot be fooled by
// a gap: a missed transition makes a run look shorter, never longer, so the reported floor is a
// LOWER bound and is stated as one.
export function transitionRuns(rollLog = [], { symbol = null, gapMin = SAME_WRITE_MAX_MIN } = {}) {
  const rows = (Array.isArray(rollLog) ? rollLog : [])
    .filter(e => e?.to && (!symbol || e.symbol === symbol))
    .sort((a, b) => String(a.to).localeCompare(String(b.to)));
  const runs = [];
  for (const e of rows) {
    const last = runs[runs.length - 1];
    const gap = last ? (Date.parse(e.to) - Date.parse(last.endAt)) / 60000 : Infinity;
    if (last && gap <= gapMin) { last.n++; last.endAt = e.to; last.spanMin = Math.round((Date.parse(e.to) - Date.parse(last.startAt)) / 60000); }
    else runs.push({ startAt: e.to, endAt: e.to, n: 1, spanMin: 0 });
  }
  const multi = runs.filter(r => r.n > 1);
  const worst = multi.sort((a, b) => b.spanMin - a.spanMin)[0] || null;
  return {
    runs: runs.length, settlements: runs.length,
    atomic: runs.filter(r => r.n === 1).length,
    progressive: multi.length,
    // A LOWER BOUND, ALWAYS. We can only see transitions we sampled, so an unobserved one makes a
    // write look shorter than it was. Saying "the write takes N minutes" would be the one claim
    // this data cannot support.
    minWriteSpanMin: worst?.spanMin ?? null,
    note: !runs.length ? 'no transition observed yet'
        : !multi.length ? `${runs.length} settlement${runs.length === 1 ? '' : 's'} observed, each a single transition — consistent with an atomic write at the resolution sampled`
        : `${multi.length} of ${runs.length} settlements wrote in more than one step — the longest spanned at least ${worst.spanMin}min, which is a floor and not a duration`,
  };
}

// What the evidence permits saying about OCC_CONFIRM_MIN. Deliberately refuses to recommend a cut
// on an absence: "we never saw a progressive write" and "progressive writes do not happen" are
// different statements, and only the first is supported by not having looked hard enough.
export function confirmMinVerdict(runs, current) {
  if (!runs || !runs.runs) return { verdict: 'unmeasured', note: 'no settlement observed yet — the current value rests on nothing, as it always has' };
  if (runs.progressive) {
    const floor = runs.minWriteSpanMin ?? 0;
    return {
      verdict: floor >= current ? 'too low' : 'covered',
      floorMin: floor,
      note: floor >= current
        ? `a write spanned at least ${floor}min against a ${current}min confirm window — the stability check can pass a half-written file`
        : `the longest observed write spanned ${floor}min, inside the ${current}min window`,
    };
  }
  return {
    verdict: 'consistent-with-atomic',
    note: `${runs.runs} settlement${runs.runs === 1 ? '' : 's'} each observed as a single transition. That is consistent with an atomic write and is NOT evidence that a progressive one cannot happen — `
        + `the sampling cannot see a write that finished between two observations, so ${current}min stands rather than being cut on an absence`,
  };
}
