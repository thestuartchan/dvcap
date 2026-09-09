// test/cboe.test.mjs — the second opinion, and the limits of what it is entitled to claim.
//
// Contracts come from test/fixtures-cboe-qqq.json, carved out of the real CDN payload on
// 2026-09-09 14:32 UTC rather than invented, so the field names, the OSI encoding and the zero-OI
// deep-ITM row are the ones the endpoint actually serves.
import { readFileSync } from 'node:fs';
import { parseOsi, parseCboe, cboeAsOf, cboeSummary, compareGex, CBOE_URL, OSI_RE, TOL } from '../lib/cboe.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const near = (n, g, w, tol) => { const good = g != null && Math.abs(g - w) <= tol;
  console.log(`${good ? '✅' : '❌'} ${n}` + (good ? '' : `  got ${g} want ${w} ±${tol}`)); good ? pass++ : fail++; };

const FX = JSON.parse(readFileSync(new URL('./fixtures-cboe-qqq.json', import.meta.url)));

// ── the OSI contract symbol ──────────────────────────────────────────────────
{
  eq('a call parses', parseOsi('QQQ260918C00720000'), { root: 'QQQ', expiry: '2026-09-18', type: 'call', strike: 720 });
  eq('a put parses', parseOsi('QQQ260918P00700000'), { root: 'QQQ', expiry: '2026-09-18', type: 'put', strike: 700 });
  // Thousandths, so a half-dollar strike must not round to a whole one.
  eq('a fractional strike survives', parseOsi('SPY260918C00763500').strike, 763.5);
  // The root is variable length — assuming three characters would silently mis-parse index options.
  eq('a four-letter root parses', parseOsi('SPXW261218P04500000'),
    { root: 'SPXW', expiry: '2026-12-18', type: 'put', strike: 4500 });
  eq('junk is null, not a guess', parseOsi('NOTACONTRACT'), null);
  eq('an empty symbol is null', parseOsi(''), null);
  eq('a missing symbol is null', parseOsi(undefined), null);
  // A date the calendar does not have is a PARSE failure. Accepting it would put a contract
  // expiring on the 32nd into the chain, where it would silently never expire.
  eq('an impossible day is rejected', parseOsi('QQQ260932C00720000'), null);
  eq('an impossible month is rejected', parseOsi('QQQ261318C00720000'), null);
  eq('a zero strike is rejected', parseOsi('QQQ260918C00000000'), null);
  ok('the regex is exported for anyone reading the parse', OSI_RE instanceof RegExp);
}

// ── the timestamp ────────────────────────────────────────────────────────────
{
  eq('CBOE\'s zoneless stamp is read as UTC', cboeAsOf('2026-09-09 14:32:12'), '2026-09-09T14:32:12Z');
  eq('a malformed stamp is null rather than an Invalid Date', cboeAsOf('yesterday'), null);
  eq('and a missing one likewise', cboeAsOf(null), null);
}

// ── the payload ──────────────────────────────────────────────────────────────
{
  const p = parseCboe(FX, { bandPct: 10 });
  near('the spot comes from their quote', p.spot, 717.86, 0.01);
  eq('the stamp is carried', p.asOf, '2026-09-09T14:32:12Z');
  // The 490 call is deep ITM with zero open interest. It carries no gamma exposure by
  // construction, and the Yahoo side drops the same rows, so the counts stay comparable.
  eq('zero-open-interest contracts are dropped', p.contracts.length, 5);
  ok('and the dropped one was the zero-OI row', !p.contracts.some(c => c.strike === 490));
  ok('every kept contract has open interest', p.contracts.every(c => c.oi > 0));
  ok('their gamma is carried through', p.contracts.every(c => c.gamma != null));
  ok('so is their implied vol', p.contracts.every(c => c.iv != null));

  // The strike band. 490 is 32% below spot and would be trimmed even with open interest.
  const tight = parseCboe(FX, { bandPct: 1 });
  ok('a tight band trims the far strikes', tight.contracts.every(c => Math.abs(c.strike - p.spot) <= p.spot * 0.01));
  ok('and that is fewer than the wide band', tight.contracts.length < p.contracts.length);

  // Expiry filtering — the comparison has to run on the same universe or it measures the universe.
  const one = parseCboe(FX, { expiries: ['2026-09-18'], bandPct: 10 });
  eq('an expiry filter is applied', one.contracts.length, 3);
  ok('and keeps only that expiry', one.contracts.every(c => c.expiry === '2026-09-18'));
  eq('an expiry nobody has yields nothing', parseCboe(FX, { expiries: ['2027-01-15'] }).contracts.length, 0);

  eq('a payload with no options is null', parseCboe({ data: { current_price: 700, options: [] } }), null);
  eq('a payload with no spot is null', parseCboe({ data: { options: FX.data.options } }), null);
  eq('an empty call does not throw', parseCboe(null), null);
}

// ── the walls, from THEIR gamma ──────────────────────────────────────────────
// The load-bearing claim of this whole module: none of lib/blackscholes.js is in this path. The
// numbers below are their open interest times their published gamma, and nothing else.
{
  const p = parseCboe(FX, { bandPct: 10 });
  const s = cboeSummary(p.contracts, p.spot);
  // Heaviest call by dollar gamma: 730 has 41,448 OI x 0.0172 = 713 against 720's 21,431 x 0.0185
  // = 396 and the 0DTE 719's 3,510 x 0.1025 = 360. Worked by hand, not read off the code.
  eq('the call wall is the heaviest call strike by their gamma', s.callWall, 730);
  eq('the put wall likewise', s.putWall, 700);
  eq('call open interest is summed', s.callOi, 21431 + 41448 + 3510);
  eq('and put open interest', s.putOi, 101859 + 4510);
  // Worked by hand: (4510x.2051 + 3510x.1952 + 101859x.2229 + 21431x.1883 + 41448x.1746) / 172758
  // = 35,586.8 / 172,758 = 20.60%. The 101,859-lot 700 put at 22.29% pulls it up and the
  // 41,448-lot 730 call at 17.46% pulls it back; weighting by CONTRACT COUNT instead gives 19.72%,
  // so the two are far enough apart that this assertion actually pins the weighting.
  near('their vol surface is open-interest weighted', s.oiWeightedIv * 100, 20.60, 0.02);
  ok('and not count-weighted', Math.abs(s.oiWeightedIv * 100 - 19.72) > 0.5);
  ok('every strike is priced', s.priced === p.contracts.length);
  eq('an empty chain summarises to null', cboeSummary([], 700), null);
  eq('and so does one with no spot', cboeSummary(p.contracts, null), null);
}

// ── what counts as agreement ─────────────────────────────────────────────────
{
  const ours = { spot: 717.9, callWall: 720, putWall: 700, callOi: 1497731, putOi: 1997472, oiWeightedIv: 0.2189 };
  const same = { spot: 717.5, callWall: 720, putWall: 700, callOi: 1453292, putOi: 2005295, oiWeightedIv: 0.2390 };

  const clean = compareGex(ours, same);
  ok('a matching read is clean', clean.clean);
  eq('and every scored check agrees', [clean.agree, clean.scored], [5, 5]);
  ok('the verdict says so', /agrees with CBOE on all 5 checks/.test(clean.verdict));
  // Spot is CONTEXT. Two chains fetched minutes apart cannot share a spot, and scoring it would
  // make the check fire every day for the one reason that is not a defect.
  const spotRow = clean.checks.find(c => c.name === 'spot');
  eq('spot is not scored', spotRow.score, false);
  eq('and is labelled as context', spotRow.state, 'context');
  ok('and says why', /clock, not a disagreement/.test(spotRow.detail));
  eq('so it cannot be part of the tally', clean.scored, clean.checks.filter(c => c.score).length);

  // The failure this exists to catch: 2026-09-08, when a broken vol surface put our put wall 17
  // points from everyone else's.
  const broken = compareGex({ ...ours, putWall: 717, oiWeightedIv: 0.066 }, same);
  ok('a 17-point wall gap is a disagreement', !broken.clean);
  ok('and the verdict names the walls', /put wall/.test(broken.verdict));
  ok('and the vol', /OI-weighted IV/.test(broken.verdict));
  eq('the put wall check fails', broken.checks.find(c => c.name === 'put wall').state, 'differ');
  eq('while the call wall still passes', broken.checks.find(c => c.name === 'call wall').state, 'match');

  // Three states, not two. A strike or two apart is not the same event as seventeen points, and a
  // check that calls them the same gets switched off.
  const oneStrike = compareGex({ ...ours, callWall: 721 }, same);
  eq('one strike apart is "near"', oneStrike.checks.find(c => c.name === 'call wall').state, 'near');
  ok('and near still counts as agreement', oneStrike.clean);
  const far = compareGex({ ...ours, callWall: 745 }, same);
  eq('far apart is not', far.checks.find(c => c.name === 'call wall').state, 'differ');
  ok('the near threshold is a share of spot, not a fixed strike count', TOL.wallNearPct > 0);

  // Open interest an order of magnitude out is the pre-open failure mode, and must be caught.
  const noOi = compareGex({ ...ours, callOi: 1200, putOi: 900 }, same);
  ok('a collapsed open interest is caught', !noOi.clean);
  eq('on both legs', [noOi.checks.find(c => c.name === 'call OI').state,
                      noOi.checks.find(c => c.name === 'put OI').state], ['differ', 'differ']);

  // A missing figure is UNKNOWN and must not be scored as either. Counting a null as agreement is
  // how a check quietly stops checking.
  const partial = compareGex({ ...ours, putWall: null }, same);
  eq('a missing wall is unknown', partial.checks.find(c => c.name === 'put wall').state, 'unknown');
  eq('and drops out of the tally rather than passing', partial.scored, 4);
  ok('the remaining four still agree', partial.clean);

  eq('nothing to compare is handled', compareGex(null, same).ok, false);
  eq('and the other way round', compareGex(ours, null).ok, false);
}

// ── the URL ──────────────────────────────────────────────────────────────────
{
  eq('the endpoint is the public CDN, no key', CBOE_URL('QQQ'), 'https://cdn.cboe.com/api/global/delayed_quotes/options/QQQ.json');
  ok('and the symbol is encoded', CBOE_URL('A B').includes('A%20B'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
