// test/occ.test.mjs — settled open interest, and the two ways of getting it wrong.
//
// A gamma map is open interest × gamma. We compute the gamma; the open interest has to come from
// somewhere, and every source available was wrong in the hour the map is read. Yahoo serves none at
// all before the US open. CBOE serves a settlement behind: measured 2026-09-10 at 01:30 UTC against
// OCC on the same 10,170 QQQ series, 3,477 disagreed, OCC net +621,592 contracts, spread across
// EVERY expiry rather than the one that had just expired — and the following day's expiry stood at
// CBOE 111,953 against OCC 227,301, which is what the prior session had built.
//
// An earlier check found the two in exact agreement and recorded that as a property of the sources.
// It was a property of the HOUR it ran in.
import { readFileSync } from 'node:fs';
import { parseOccSeries, mergeOccIv, occKey, defaultExpiries, refreshExpiries, MIN_OCC_COVERAGE, DEFAULT_NEAR_COUNT,
         seenRecord, rollEntry, appendRoll, rollSummary, ROLL_LOG_MAX, occVintage } from '../lib/occ.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

const FIX = readFileSync(new URL('./fixtures-occ-qqq.txt', import.meta.url), 'utf8');

// ── the parse ────────────────────────────────────────────────────────────────
{
  const q = parseOccSeries(FIX, 'QQQ');
  ok('the file parses', !!q && q.rows > 0);
  // Header lines, the prose banner and the venue list all sit above the data and must not become
  // contracts. A parse that yields a contract from "Series Search Results for QQQ" is a parse that
  // will yield one from anything.
  ok('no header line becomes a contract', [...q.oi.keys()].every(k => /^\d{4}-\d{2}-\d{2}\|(call|put)\|[\d.]+$/.test(k)));
  ok('open interest is counted', q.totalOi > 0);
  ok('and expiries collected', q.expiries.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(q.expiries[0]));

  // ── THE ROOT IS MATCHED EXACTLY ────────────────────────────────────────────
  // The SPY file also carries `2SPY`: adjusted series from a corporate action, a different
  // deliverable on a different number of shares. Folding those into SPY's open interest would
  // inflate it with positions that are not on the underlying at all — and the fixture's 2SPY rows
  // carry real size, including 906 contracts at a strike of 479.42 that SPY itself does not list.
  const spy = parseOccSeries(FIX, 'SPY');
  ok('the adjusted root is seen and skipped', spy.skippedRoot > 0);
  eq('and none of its strikes reach the book', spy.oi.get(occKey('2026-09-09', 'put', 479.42)), undefined);
  ok('while SPY’s own rows do', spy.oi.has(occKey('2026-09-09', 'put', 500)));
  // A substring match would have swallowed 2SPY; an exact one cannot.
  ok('QQQ does not pick up SPY either', [...parseOccSeries(FIX, 'QQQ').oi.keys()].length !== spy.oi.size);

  // ── THE STRIKE IS INTEGER PLUS THOUSANDTHS ─────────────────────────────────
  // 479 + 420 is 479.42, not 479420 and not 479.
  const adj = parseOccSeries(FIX, '2SPY');
  ok('a fractional strike is reassembled', adj.oi.has(occKey('2026-09-09', 'put', 479.42)));
  eq('with its open interest intact', adj.oi.get(occKey('2026-09-09', 'put', 479.42)), 906);

  // ── ZERO IS NOT A POSITION ─────────────────────────────────────────────────
  // A strike with no open interest carries no gamma exposure by construction. Dropping it keeps the
  // contract counts comparable with every other rung.
  ok('an empty leg is not stored', !adj.oi.has(occKey('2026-09-09', 'call', 550)) || adj.oi.get(occKey('2026-09-09', 'call', 550)) > 0);
  ok('every stored leg is positive', [...q.oi.values()].every(v => v > 0));

  eq('an unknown root yields nothing', parseOccSeries(FIX, 'NOSUCH'), null);
  eq('and so does an empty payload', parseOccSeries('', 'QQQ'), null);
  eq('a missing root is a refusal, not a wildcard', parseOccSeries(FIX, ''), null);
}

// ── the merge ────────────────────────────────────────────────────────────────
// OCC's open interest onto CBOE's implied vol. Neither source is sufficient: OCC publishes no
// greeks at all, and CBOE's open interest is the older settlement.
{
  const occ = { oi: new Map([
    [occKey('2026-10-16', 'call', 700), 1000],
    [occKey('2026-10-16', 'put', 700), 2000],
    [occKey('2026-10-16', 'call', 710), 500],
  ]) };
  const cboe = [
    { expiry: '2026-10-16', type: 'call', strike: 700, oi: 900, iv: 0.20 },
    { expiry: '2026-10-16', type: 'put',  strike: 700, oi: 1800, iv: 0.22 },
    { expiry: '2026-10-16', type: 'call', strike: 710, oi: 400, iv: null },   // no vol → no gamma
    { expiry: '2026-10-16', type: 'put',  strike: 720, oi: 300, iv: 0.19 },   // OCC does not list it
  ];
  const m = mergeOccIv(occ, cboe);

  eq('only contracts present in both survive', m.matched, 2);
  // THE OPEN INTEREST IS OCC'S. That is the entire point of the rung.
  eq('and they carry OCC’s open interest, not CBOE’s', m.contracts.map(c => c.oi), [1000, 2000]);
  eq('while the implied vol stays CBOE’s', m.contracts.map(c => c.iv), [0.20, 0.22]);
  eq('a contract OCC does not list is dropped and counted', m.missingFromOcc, 1);
  // NO VOL MEANS NO GAMMA. CBOE's own gamma is deliberately not substituted: it was computed at
  // CBOE's spot, and recomputing at ours is the whole reason this rung exists.
  eq('one with no implied vol likewise', m.noIv, 1);
  ok('and no contract arrives without a vol', m.contracts.every(c => c.iv > 0));

  // ── TWO TOTALS, NOT ONE RATIO ──────────────────────────────────────────────
  // The first version divided OCC's open interest on the MATCHED contracts by CBOE's across ALL of
  // them and called it coverage. It came out at 109% — a coverage figure above one is a sign the
  // ratio is measuring two things at once, and it was: how much of the book survived the join, and
  // how much bigger the newer settlement is.
  eq('coverage is the share of CBOE’s book that joined', m.coverage, +(2700 / 3400).toFixed(4));
  ok('and cannot exceed one', m.coverage <= 1);
  // Like for like, on the contracts that joined: 3,000 against 2,700.
  eq('the settlement difference is measured on the matched set', m.oiDeltaVsCboe, 300);

  eq('nothing settled means no merge', mergeOccIv({ oi: new Map() }, cboe), null);
  eq('and no CBOE contracts means nothing joins', mergeOccIv(occ, []).matched, 0);
  ok('the coverage floor is stated', MIN_OCC_COVERAGE > 0 && MIN_OCC_COVERAGE <= 1);
}

// ── which expiries ───────────────────────────────────────────────────────────
// The full listed book is ~3,240 contracts against the ~1,020 the daily capture stores, and
// gexSummary solves the flip six times over a 400-step spot scan — so its cost is linear in
// contracts and the full book took it from 2.2s to 6.8s, most of a ten-second function budget for
// one symbol of two. It also would not be comparing like with like: a map drawn over a different
// universe cannot be checked against the rung below it in the cascade.
{
  const NOW = new Date('2026-09-10T09:00:00Z');
  const listed = ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15',
                  '2026-09-18', '2026-10-16', '2026-12-18', '2027-01-15'];
  const picked = defaultExpiries(listed, NOW);

  ok('an expiry already past is not picked', !picked.includes('2026-09-09'));
  ok('the nearest dailies are', picked.includes('2026-09-10') && picked.includes('2026-09-11'));
  eq('and the count of near ones is stated', DEFAULT_NEAR_COUNT, 3);
  // The front monthly and the two after it, found by horizon rather than by knowing which dates are
  // monthlies — the calendar changes and a hardcoded rule about third Fridays would rot.
  ok('the front monthly is reached by horizon', picked.includes('2026-09-18'));
  ok('and the two beyond it', picked.includes('2026-10-16') && picked.includes('2026-12-18'));
  // SIX, the shape the stored capture uses — three dailies plus three horizons.
  eq('which reproduces the stored capture’s shape', picked.length, 6);
  ok('sorted, so the set is stable across runs', picked.join() === [...picked].sort().join());
  eq('nothing listed picks nothing', defaultExpiries([], NOW), []);
  eq('and everything expired likewise', defaultExpiries(['2026-01-01'], NOW), []);
}


// ── HAS THE FILE ROLLED? ─────────────────────────────────────────────────────
// "Pull at 08:00 UTC" is only as good as the day it was measured on. If OCC ever shifts its
// publication, a scheduled fetch would serve the previous session's positioning under today's date
// with nothing noticing — the exact failure this rung was built to escape. So the file says whether
// it rolled, by remembering what it looked like last time.
{
  const { occFingerprint, occVintage, priorUsClose, US_CLOSE_UTC_HOUR } = await import('../lib/occ.js');
  const T = (s) => new Date(s);
  const parsed = { rows: 5085, totalOi: 12893337 };

  eq('the close is 16:00 ET', US_CLOSE_UTC_HOUR, 20);
  eq('the fingerprint is rows and total open interest', occFingerprint(parsed), '5085:12893337');
  eq('nothing parsed has no fingerprint', occFingerprint(null), null);

  // The most recent close AT OR BEFORE the moment asked about.
  eq('mid-morning looks back to yesterday’s close', priorUsClose(T('2026-09-10T10:20:00Z')).toISOString(), '2026-09-09T20:00:00.000Z');
  eq('and after today’s close, to today’s', priorUsClose(T('2026-09-10T22:30:00Z')).toISOString(), '2026-09-10T20:00:00.000Z');
  // A weekend has no close of its own — a Saturday fetch still describes Friday's settlement.
  eq('a Sunday walks back to Friday', priorUsClose(T('2026-09-13T10:00:00Z')).toISOString(), '2026-09-11T20:00:00.000Z');
  eq('and a Saturday likewise', priorUsClose(T('2026-09-12T10:00:00Z')).toISOString(), '2026-09-11T20:00:00.000Z');

  // UNKNOWN IS NOT TRUE. On a first observation there is no evidence the file rolled, and treating
  // the absence of evidence as a pass is how a stale book gets drawn as a current one.
  const first = occVintage(parsed, null, T('2026-09-10T01:10:00Z'));
  eq('a first fetch cannot vouch for the vintage', first.rolledSinceClose, null);
  ok('and says so rather than passing', /first observation/.test(first.note));

  const stored = { fingerprint: first.fingerprint, firstSeenAt: first.firstSeenAt };

  // THE LIVE CASE. Seen at 01:10Z, read at the 12:42Z pre-read: it rolled after the 09-09 close, so
  // it is that session's settlement.
  const atBrief = occVintage(parsed, stored, T('2026-09-10T12:42:00Z'));
  eq('a file first seen after the close has rolled', atBrief.rolledSinceClose, true);
  eq('and is unchanged since', atBrief.changed, false);
  ok('with how long it has been still', atBrief.unchangedHours > 11);

  // THE CASE THAT MATTERS. After today's close but before OCC republishes, the SAME bytes are now
  // the previous session's book — and a clock-based rule would not notice.
  const afterClose = occVintage(parsed, stored, T('2026-09-10T22:30:00Z'));
  eq('the same file after the next close has NOT rolled', afterClose.rolledSinceClose, false);
  ok('and says whose book it actually is', /previous session/.test(afterClose.note));

  // ── A CHANGED FILE IS NOT NECESSARILY A FINISHED ONE ──────────────────────
  // The roll was observed through a 2h28m gap, which says the file changed and NOT that the change
  // was atomic. If OCC writes the series list progressively, a fetch landing mid-write returns a
  // real, parseable, PARTIAL book — fewer contracts, less open interest, walls drawn from whatever
  // had been written. Worse than a stale file, because a stale one is at least self-consistent.
  {
    const { OCC_CONFIRM_MIN, OCC_SHRINK_TOL } = await import('../lib/occ.js');
    ok('a hold period is stated', OCC_CONFIRM_MIN > 0);
    ok('and a shrink tolerance', OCC_SHRINK_TOL > 0 && OCC_SHRINK_TOL < 1);

    const sameSeen = { fingerprint: '5085:12893337', firstSeenAt: '2026-09-10T01:10:00Z', rows: 5085 };
    // Stable for eleven hours, rolled after the close, same size: as complete as observation can say.
    eq('held still and full size is complete', occVintage(parsed, sameSeen, T('2026-09-10T12:42:00Z')).complete, true);
    // Freshly changed is UNKNOWN, not complete — it has been stable for zero minutes by definition.
    eq('a fingerprint seen seconds ago is not yet finished',
       occVintage({ rows: 5090, totalOi: 13000000 }, sameSeen, T('2026-09-11T01:03:00Z')).complete, null);
    // A PARTIAL WRITE IS SMALLER, and this catches it even if it is fetched twice and looks settled.
    {
      const small = occVintage({ rows: 3000, totalOi: 7000000 },
        { ...sameSeen, fingerprint: 'other', firstSeenAt: '2026-09-11T00:10:00Z' }, T('2026-09-11T01:00:00Z'));
      eq('a collapsed row count is not complete', small.complete, false);
      ok('and says why', /possibly a partial write/.test(small.note));
    }
    // Expiries roll off legitimately, so a small fall is not a collapse.
    eq('a few rows fewer is still complete',
       occVintage({ rows: 5000, totalOi: 12800000 },
         { fingerprint: '5000:12800000', firstSeenAt: '2026-09-10T01:10:00Z', rows: 5085 },
         T('2026-09-10T12:42:00Z')).complete, true);
    // And the file NOT having rolled is a definite false, not an unknown.
    eq('the previous session’s book is definitely not complete',
       occVintage(parsed, sameSeen, T('2026-09-10T22:30:00Z')).complete, false);
  }

  // A changed fingerprint restamps the roll time.
  const rolled = occVintage({ rows: 5090, totalOi: 13000000 }, stored, T('2026-09-11T01:00:00Z'));
  eq('new bytes are a new vintage', rolled.changed, true);
  eq('dated to when they were seen', rolled.firstSeenAt, '2026-09-11T01:00:00.000Z');
  eq('and that counts as rolled', rolled.rolledSinceClose, true);
}


// ── A STORED EXPIRY LIST GOES STALE ONE DATE AT A TIME ──────────────────────
// The stored capture's expiry list is replayed so the settled recompute is like-for-like with the
// rung below it. But a list captured yesterday names yesterday's dates.
//
// Measured on the live QQQ recompute, 2026-09-11 16:04Z: it ran on
//   2026-09-10, 2026-09-11, 2026-09-14, 2026-09-18, 2026-10-16, 2026-12-18
// — six dates, one of them already expired. So the map was drawn over FIVE, and every "% of the
// gamma" below it was a share of five while reporting as a share of the sample. A denominator that
// shrinks silently rounds the concentration number UP.
{
  const AVAIL = ['2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
                 '2026-09-18', '2026-09-21', '2026-10-16', '2026-12-18'];
  const NOW = new Date('2026-09-11T16:00:00Z');
  const STORED = ['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-18', '2026-10-16', '2026-12-18'];

  const r = refreshExpiries(STORED, AVAIL, NOW);
  eq('the expired date is dropped', r.dropped, ['2026-09-10']);
  eq('and reported, not swallowed', r.dropped.length, 1);
  // TOPPED BACK UP, so the sample is the size the rule meant it to be rather than one short.
  eq('the sample is restored to its full size', r.expiries.length, STORED.length);
  eq('with the next live daily taking the empty slot', r.expiries,
     ['2026-09-11', '2026-09-14', '2026-09-15', '2026-09-18', '2026-10-16', '2026-12-18']);
  ok('and nothing expired survives', r.expiries.every(d => d >= '2026-09-11'));
  // TODAY IS NOT EXPIRED. The front expiry is the whole subject of the decay tile; dropping it on
  // its own expiry day would remove the one number that matters most that day.
  ok("today's expiry is kept", r.expiries.includes('2026-09-11'));

  // A LIST THAT IS ALREADY CURRENT IS LEFT ALONE — no churn, and the cache key stays a hit.
  const same = refreshExpiries(r.expiries, AVAIL, NOW);
  eq('a current list is unchanged', same.expiries, r.expiries);
  eq('and drops nothing', same.dropped, []);

  // TOP-UP ONLY FROM WHAT IS ACTUALLY LISTED — never invented.
  const scarce = refreshExpiries(STORED, ['2026-09-11', '2026-12-18'], NOW);
  ok('it cannot top up past what exists', scarce.expiries.every(d => ['2026-09-11', '2026-09-14', '2026-09-18', '2026-10-16', '2026-12-18'].includes(d)));
  ok('and every survivor is live', scarce.expiries.every(d => d >= '2026-09-11'));

  // Nothing stored at all falls through to the default shape rather than to an empty universe.
  eq('an empty stored list still yields the default set', refreshExpiries([], AVAIL, NOW).expiries,
     defaultExpiries(AVAIL, NOW));
}


// ── THE ROLL, MEASURED RATHER THAN GUESSED AT ───────────────────────────────
// Three nights of hand-scheduled probes produced three brackets that do not agree — rolled by
// 01:10Z one night, still unrolled at 01:46Z another — and each sample cost a session wake. The
// measurement was then thrown away: the vintage store keeps one record per symbol, so every
// transition it observed was overwritten by the one that followed.
//
// The two fields that were missing are `lastSeenAt` and somewhere to append.
{
  const P = (rows, totalOi) => ({ rows, totalOi, oi: new Map(), skippedRoot: 0, expiries: [] });
  const at = (iso) => new Date(iso);

  // THE FIRST SIGHTING IS NOT A ROLL. There is no prior fingerprint, so there is no bracket — and
  // recording it as one would put an entry of unknown width into a series whose value IS the width.
  const v1 = occVintage(P(5843, 12996090), null, at('2026-09-12T01:45:58Z'));
  eq('a first observation has no prior to compare against', v1.rolledSinceClose, null);
  eq('and yields no roll entry', rollEntry(null, v1, P(5843, 12996090), { symbol: 'QQQ' }), null);

  // ── lastSeenAt IS THE HALF NOBODY WAS KEEPING ─────────────────────────────
  // Without it the best lower bound is when the OLD fingerprint was FIRST seen — which on a file
  // that holds still for twenty hours is the age of the settlement, not the width of the roll.
  const seen1 = seenRecord(v1, P(5843, 12996090), at('2026-09-12T01:45:58Z'));
  eq('the record carries both ends', [!!seen1.firstSeenAt, !!seen1.lastSeenAt], [true, true]);
  eq('and the size, so a shrink can be judged', [seen1.rows, seen1.totalOi], [5843, 12996090]);

  // Re-observed unchanged at 01:45, having first been seen at 00:26: lastSeenAt moves, firstSeenAt
  // does NOT — restarting the stability clock every five minutes is the one thing it must not do.
  const early = occVintage(P(5843, 12996090), null, at('2026-09-12T00:26:00Z'));
  const earlyRec = seenRecord(early, P(5843, 12996090), at('2026-09-12T00:26:00Z'));
  const held = occVintage(P(5843, 12996090), earlyRec, at('2026-09-12T01:45:58Z'));
  const heldRec = seenRecord(held, P(5843, 12996090), at('2026-09-12T01:45:58Z'));
  eq('an unchanged file keeps its first sighting', heldRec.firstSeenAt, earlyRec.firstSeenAt);
  eq('while the last sighting advances', heldRec.lastSeenAt, '2026-09-12T01:45:58.000Z');
  eq('and it is not a roll', rollEntry(earlyRec, held, P(5843, 12996090), { symbol: 'QQQ' }), null);

  // ── THE REAL TRANSITION, AS OBSERVED 2026-09-12 ───────────────────────────
  // Pre-roll at 01:45:58Z, post-roll at 02:30:46Z. QQQ 5843 rows → 5793 (the 09-10 expiry drops
  // out) while open interest rises 12,996,090 → 13,224,816 (the new session is added).
  const after = occVintage(P(5793, 13224816), heldRec, at('2026-09-12T02:30:46Z'));
  eq('the fingerprint moved', after.changed, true);
  const roll = rollEntry(heldRec, after, P(5793, 13224816), { symbol: 'QQQ' });
  eq('the bracket opens at the last pre-roll sighting', roll.from, '2026-09-12T01:45:58.000Z');
  eq('and closes at the first post-roll one', roll.to, '2026-09-12T02:30:46.000Z');
  eq('44 minutes wide, which is the measurement', roll.bracketMin, 45);
  // THE DIRECTION IS THE CHECK. A settlement drops the expired series and adds the session's open
  // interest, so rows falling while OI rises is the shape of a real roll — the opposite pair would
  // be a partial write wearing a new fingerprint.
  eq('rows fall', roll.rowsDelta, -50);
  eq('while open interest rises', roll.oiDelta, 228726);

  // AN OLD RECORD HAS ONLY ONE END, and says so rather than reporting the age of the settlement as
  // the width of the roll.
  const legacy = { fingerprint: 'x:1', firstSeenAt: '2026-09-11T12:20:00Z', rows: 5843 };
  const fromLegacy = rollEntry(legacy, after, P(5793, 13224816), { symbol: 'QQQ' });
  eq('no lastSeenAt, no bracket', fromLegacy.bracketMin, null);
  eq('but the transition is still recorded', fromLegacy.prevFp, 'x:1');

  // ── THE LOG ───────────────────────────────────────────────────────────────
  eq('nothing to append is the log unchanged', appendRoll([roll], null), [roll]);
  eq('it is bounded', appendRoll(Array.from({ length: ROLL_LOG_MAX }, (_, i) => ({ to: `${i}` })), roll).length, ROLL_LOG_MAX);
  ok('and the newest survives the cap', appendRoll(Array.from({ length: ROLL_LOG_MAX }, (_, i) => ({ to: `${i}` })), roll).at(-1) === roll);
}

// ── READING A WEEK OF IT ────────────────────────────────────────────────────
// The operational question is not "what minute does OCC publish" — it is "is the book rolled by
// the time the US pre-read fires at 12:42Z". Those need different evidence and only one needs a
// minute.
{
  const e = (to, from, symbol = 'QQQ') => ({ symbol, to, from,
    bracketMin: Math.round((Date.parse(to) - Date.parse(from)) / 60000) });
  const log = [
    e('2026-09-15T01:05:00Z', '2026-09-15T00:35:00Z'),   // Mon session
    e('2026-09-16T02:31:00Z', '2026-09-16T01:46:00Z'),   // Tue session — the latest
    e('2026-09-17T01:12:00Z', '2026-09-17T00:42:00Z'),   // Wed session
    e('2026-09-18T00:58:00Z', '2026-09-18T00:28:00Z', 'SPY'),
  ];
  const s = rollSummary(log, { symbol: 'QQQ', againstUtc: '12:42' });
  eq('only this symbol is counted', s.n, 3);
  // THE WORST NIGHT GOVERNS. An average would be reassuring and wrong: the question is whether the
  // pre-read is ever late, not whether it usually is not.
  eq('the latest bracket end is the one reported', s.latestEndUtc, '02:31');
  eq('and the margin is measured to it', s.marginMin, 611);
  eq('the tightest bracket is carried too', s.tightestBracketMin, 30);
  // A COUNT OF NIGHTS, ALWAYS. Three brackets that disagree are not a schedule, and a
  // recommendation that does not carry how thin it is gets read as one.
  ok('the note says how many nights it rests on', /^3 rolls observed/.test(s.note));
  ok('and how much room there is', /10\.2h clear of 12:42Z/.test(s.note));

  // THE SESSION, NOT THE UTC DAY. A roll at 02:31Z on a Saturday is FRIDAY's settlement; bucketing
  // it by the calendar day it landed on would invent a weekend session.
  eq('a small-hours roll belongs to the previous session', rollSummary([e('2026-09-12T02:31:00Z', '2026-09-12T01:46:00Z')]).entries[0].session, 'Fri');
  eq('and a late-evening one to the same day', rollSummary([e('2026-09-15T22:50:00Z', '2026-09-15T22:20:00Z')]).entries[0].session, 'Tue');

  eq('an empty log reports nothing rather than guessing', rollSummary([]).n, 0);
  ok('and says why', /no roll observed yet/.test(rollSummary([]).note));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
