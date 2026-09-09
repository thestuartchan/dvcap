// test/prereadSections.test.mjs — the two new pre-read sections.
//
// The map and the watchlist are what a day trade is actually placed against, and both have a way
// of failing that looks like working: a map whose two rows are on different scales, and a
// watchlist that quietly reaches into the book. Both are tested for here rather than trusted.
import { mapRow, pinOf, renderGexSection, MAP_W, PIN_MIN_SHARE, PIN_NEAR_PCT } from '../lib/gexBrief.js';
import { watchlist, corroborate, renderWatchlist, bucketOf, WATCH_MAX, WATCH_MIN_PCT } from '../lib/watchlist.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// The real board of 2026-09-09.
const QQQ = { name: 'QQQ', spot: 718.36, putWall: 700, callWall: 720, flipLevel: 718.83 };
const SPY = { name: 'SPY', spot: 762.40, putWall: 760, callWall: 770, flipLevel: 769.60 };

// ── the map ──────────────────────────────────────────────────────────────────
{
  const q = mapRow('QQQ', QQQ), s = mapRow('SPY', SPY);
  // ONE SCALE. Both rows are percent-of-their-own-spot with price centred, so the same column is
  // the same distance on both. Normalising each to its own zone made them look comparable when
  // QQQ's walls span 2.8% and SPY's 1.3%.
  eq('both rows are the same width', [q.length, s.length], [MAP_W + 4, MAP_W + 4]);
  eq('and price is in the same column on both', q.indexOf('^'), s.indexOf('^'));

  // The marker has to break the dot run, which is why it is not a round glyph.
  ok('price is marked with a caret', q.includes('^'));
  // MEASURE INSIDE THE TRACK, NOT THE WHOLE ROW. indexOf('P') on "SPY ····P···" finds the P in
  // the TICKER, which made the put-wall assertion measure the label. The ticker prefix is four
  // characters and every mark lives after it.
  const track = (row) => row.slice(4);
  const [qt, st] = [track(q), track(s)];
  ok('QQQ shows its put wall far left', qt.indexOf('P') < qt.indexOf('^') - 10);
  ok('while SPY\'s sits right under price', st.indexOf('^') - st.indexOf('P') <= 2);
  // The asymmetry the section exists to show: QQQ's pivot and ceiling are on top of price, SPY's
  // are a long way right.
  ok('QQQ pivot is adjacent to price', qt.indexOf('|') - qt.indexOf('^') === 1);
  ok('SPY pivot is far from price', st.indexOf('|') - st.indexOf('^') > 4);

  // Mobile code blocks scroll rather than wrap, so width is a hard constraint.
  ok('the row fits a phone without scrolling', q.length <= 42);
  eq('no spot, no row', mapRow('X', { spot: 0 }), null);
  eq('a missing wall simply is not drawn', (mapRow('X', { spot: 100, callWall: 101 }).match(/P/g) || []).length, 0);
}

// ── the pin ──────────────────────────────────────────────────────────────────
// Its ABSENCE is the finding. An index with nothing expiring near spot is free to trend, which
// matters most when it is also the one nearest a wall.
{
  const grid = (share, put, call) => ({ expiries: [{ expiry: '2026-09-09', shareOfAbs: share, peakPutStrike: put, peakCallStrike: call }] });
  const at = { spot: 718.36, today: '2026-09-09' };
  const p = pinOf(grid(23.7, 717, 719), at);
  eq('a heavy expiry stacked on spot is a pin', p.pinned, true);
  eq('with its band named', p.band, '717–719');
  // SPY that day: only 3.6% expiring, and not near spot.
  eq('a light expiry is not', pinOf(grid(3.6, 760, 768), { spot: 762.40, today: '2026-09-09' }).pinned, false);
  // Heavy but FAR is also not a pin — the hedging has to be near spot to hold it.
  eq('heavy but far from spot is not a pin', pinOf(grid(40, 690, 695), at).pinned, false);
  eq('no expiry today at all', pinOf(grid(40, 717, 719), { spot: 718.36, today: '2026-09-10' }).pinned, false);
  ok('the thresholds are stated', PIN_MIN_SHARE > 0 && PIN_NEAR_PCT > 0);
}

// ── the section ──────────────────────────────────────────────────────────────
{
  const rows = [
    { ...QQQ, pin: { pinned: true, share: 23.7, band: '717–719' } },
    { ...SPY, pin: { pinned: false, share: 3.6, band: null } },
  ];
  const out = renderGexSection(rows, { rung: 'repriced', from: '2026-09-08', asOf: '2026-09-08T22:00:00Z' });
  ok('the map is fenced, or the alignment collapses', out.includes('```'));
  ok('the numbers are printed too, so the picture is never load-bearing', /put wall 700\.00/.test(out));
  // The best line on the board, and it only exists as a comparison.
  ok('anchored vs not is stated as one claim', /QQQ is anchored, SPY is not/.test(out));
  ok('and it says what that means', /free to trend/.test(out));
  // The vintage must never be silent — a repriced book is not a live one.
  ok('the rung is labelled', /one settlement behind/.test(out));
  ok('with the date it came from', /2026-09-08/.test(out));

  // ── TENSE ──────────────────────────────────────────────────────────────────
  // The Asia brief fires at 23:13 UTC against a US close of 20:00 and printed "35% of QQQ's book
  // expires today ... which holds it there until the last hour" — present tense, under a heading
  // saying "today", about options that had expired three hours earlier.
  const closed = renderGexSection(rows, { rung: 'stored', from: '2026-09-09', tense: 'closed' });
  ok('a finished session makes no claim about a pin', !/expires today/.test(closed));
  ok('nor about holding anything', !/holds it there|free to trend/.test(closed));
  ok('it reports where price finished instead', /closed below its pivot/.test(closed));
  ok('and says the expiry is gone', /expiry is gone/.test(closed));
  ok('and that settlement will move it', /overnight settlement/.test(closed));
  // The map itself still renders — where the US finished IS the handoff the next session opens on.
  ok('the map survives the tense change', closed.includes('```'));

  eq('an expired pin is never pinned', pinOf(
    { expiries: [{ expiry: '2026-09-09', shareOfAbs: 35, peakPutStrike: 716, peakCallStrike: 717 }] },
    { spot: 716.27, today: '2026-09-09', expired: true }).pinned, false);
  ok('though the same book pins before the close', pinOf(
    { expiries: [{ expiry: '2026-09-09', shareOfAbs: 35, peakPutStrike: 716, peakCallStrike: 717 }] },
    { spot: 716.27, today: '2026-09-09', expired: false }).pinned);

  const asTaken = renderGexSection(rows, { rung: 'stored', from: '2026-09-08' });
  ok('an unrepriced read says the pivot is not now\'s', /not repriced/.test(asTaken));
  eq('nothing stored renders nothing', renderGexSection(rows, { rung: 'none' }), null);
  eq('and no rows likewise', renderGexSection([], { rung: 'repriced' }), null);
  // Both loose: the absence is still reported rather than left as a gap.
  const loose = renderGexSection(rows.map(r => ({ ...r, pin: { pinned: false } })), { rung: 'repriced' });
  ok('nothing anchored is itself said out loud', /Nothing is anchored today/.test(loose));
}

// ── the watchlist ────────────────────────────────────────────────────────────
{
  const names = [
    { name: 'NVDA', sym: 'NVDA', role: 'gpu', leader: true }, { name: 'MU', sym: 'MU', role: 'memory', leader: true },
    { name: 'TSM', sym: 'TSM', role: 'foundry-leading', leader: true }, { name: 'INTC', sym: 'INTC', role: 'foundry-leading' },
    { name: 'ARM', sym: 'ARM', role: 'gpu' }, { name: 'AMZN', sym: 'AMZN', role: 'megacap' }, { name: 'GOOGL', sym: 'GOOGL', role: 'megacap' },
  ];
  const Q = { NVDA: -0.91, MU: 2.75, TSM: -0.83, INTC: 1.69, ARM: 1.03, AMZN: -1.78, GOOGL: -2.28 };
  const q = (s) => Q[s] == null ? null : { price: 100, changePercent: Q[s] };
  const rows = watchlist(names, q);

  eq('biggest move first', rows[0].name, 'MU');
  ok('capped at five', rows.length <= WATCH_MAX);
  // A SPLIT GROUP HAS NO MIDDLE. Chips are 2 up / 2 down; a median through that reads +0.10 and
  // reports every member as alone against a flat group, which is false twice over.
  eq('a split group is named as split', rows.find(r => r.name === 'MU').tag, 'the group is split');
  eq('and the split is counted', rows.find(r => r.name === 'MU').split, { up: 2, down: 2 });
  // ONE PEER IS ENOUGH. The US universe has exactly two megacaps, so requiring two peers left the
  // entries most in need of context with no tag at all.
  //
  // NAMED WHILE THEY FIT. The live Asia brief tagged BYD −2.44% and Xiaomi −2.01% as "moving
  // alone" — they moved together, but Tencent and Alibaba sat flat and dragged the megacap median
  // to −0.3%. Corroboration is counted now, not averaged, and the peer is named: "with AMZN
  // (−1.8%)" is a fact the reader can check, where "with the group" is a summary they cannot.
  eq('two-name groups name their peer', rows.find(r => r.name === 'GOOGL').tag, 'with AMZN (-1.8%)');
  eq('and it works both ways round', rows.find(r => r.name === 'AMZN').tag, 'with GOOGL (-2.3%)');

  // Corroboration on its own.
  eq('moving the other way to a moving group', corroborate(2.0, [-1.5, -1.4, -1.6]).tag, 'against the group');
  // Past two peers the names stop fitting and the count is the point.
  eq('three agreeing peers are counted, not listed', corroborate(-1.5, [-1.4, -1.6, -1.5]).tag, 'with 3 of the group');
  eq('one agreeing peer is named', corroborate(-1.5, [{ name: 'AMZN', changePct: -1.4 }]).tag, 'with AMZN (-1.4%)');
  // A peer that barely moved does not corroborate anything.
  eq('a flat peer leaves it alone', corroborate(-2.4, [{ name: 'X', changePct: -0.1 }]).tag, 'moving alone');
  // And an unnamed peer falls back to the count rather than printing "with null".
  eq('an unnamed peer is counted', corroborate(-1.5, [-1.4]).tag, 'with 1 of the group');
  eq('moving alone against a flat group', corroborate(3.0, [0.1, 0.0, -0.1]).tag, 'moving alone');
  eq('no peers at all, no claim', corroborate(3.0, []).tag, null);

  // Drift is not a move.
  eq('sub-threshold names are left out', watchlist(names, s => ({ price: 100, changePercent: 0.2 })).length, 0);
  ok('the floor is stated', WATCH_MIN_PCT > 0);
  eq('a name with no quote is skipped, not zeroed', watchlist(names, s => s === 'MU' ? q(s) : null).length, 1);

  // ── SILENCE, NOT BOOKKEEPING ───────────────────────────────────────────────
  // An empty list renders nothing at all — no count, no "nothing cleared", no explanation of why
  // there are four entries instead of five.
  eq('an empty watchlist renders nothing', renderWatchlist([]), null);
  const txt = renderWatchlist(rows);
  ok('no slot count leaks into the output', !/slot|unused|of 5|cleared the bar/i.test(txt));
  ok('the tag is rendered in words', /_the group is split_/.test(txt));
  ok('and no colour vocabulary is introduced', !/🟢|🔴|🟡/.test(txt));

  eq('roles map to comparison buckets', [bucketOf('memory'), bucketOf('megacap'), bucketOf('nonsense')], ['chips', 'megacaps', 'other']);
}

// ── THE PUBLIC-CHANNEL RULE ──────────────────────────────────────────────────
// An earlier draft ranked by portfolio weight and quoted average cost and lot basis. This asserts
// the shape that makes that impossible: watchlist() takes names and a quote function, and there is
// no parameter through which a holding could arrive.
{
  const src = (await import('node:fs')).readFileSync(new URL('../lib/watchlist.js', import.meta.url), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const w of ['costBasis', 'avgCost', 'qty', 'position', 'weight', 'holding', 'pnl', 'realized']) {
    eq(`no "${w}" anywhere in the watchlist`, new RegExp(w, 'i').test(bare), false);
  }
  eq('it takes exactly names and a quote fn', /export function watchlist\(names = \[\], quote = /.test(bare), true);
}

// ── THE ADJACENT INSTRUMENT ──────────────────────────────────────────────────
// DIRECTIONAL, because one ticker per name only works if you are always long. A falling name wants
// the inverse. Pointing a reader at an instrument that moves AGAINST the observation it is attached
// to is worse than showing nothing, and the risk is measured rather than theoretical: RGTZ reads
// like a 2x long RGTI and is a 2x SHORT. It was in the map as `up` until its owner corrected it.
{
  const { ADJACENT, adjacentFor, renderAdjacent } = await import('../data/adjacent.js');
  const { WATCH_UNIVERSE, IN_WATCH_UNIVERSE } = await import('../data/watchUniverse.js');

  eq('a rising name gets the leveraged long', renderAdjacent('META', 2.1), ' [METU 2x]');
  eq('a falling one gets the inverse', renderAdjacent('META', -2.1), ' [METD -1x]');
  // THE ONE THAT WAS WRONG.
  eq('RGTZ is the SHORT side, not the long', ADJACENT.RGTI.down, 'RGTZ');
  eq('and RGTX is the long', ADJACENT.RGTI.up, 'RGTX');
  eq('so a falling RGTI points at RGTZ', renderAdjacent('RGTI', -5), ' [RGTZ -2x]');
  eq('and a rising one at RGTX', renderAdjacent('RGTI', 5), ' [RGTX 2x]');

  // Venue marked only when it is not US, because the core ticker decides the brief and a reader
  // must not reach for a Hong Kong product in a US session.
  ok('a non-US product carries its venue', /HKEX/.test(renderAdjacent('000660.KS', 3.5)));
  ok('a US one does not', !/US|NASDAQ|NYSE/.test(renderAdjacent('META', 2.1)));
  // CSOP moved to a flexible factor on 2026-08-03: up to 2x, varying daily. Stated as a maximum.
  ok('a flexible factor is not stated as a constant', /up to 2x/.test(renderAdjacent('000660.KS', 3.5)));

  // MISSING SIDES RENDER AS NOTHING. SK Hynix has a 2x long and no inverse; inventing one is the
  // most expensive kind of helpful.
  eq('no inverse means no bracket', renderAdjacent('000660.KS', -3.5), '');
  eq('nor for a name with no products at all', renderAdjacent('ZETA', 3), '');
  eq('a flat move gets nothing either way', renderAdjacent('META', 0), '');
  eq('and an unreadable move likewise', renderAdjacent('META', null), '');
  eq('adjacentFor returns null rather than a blank', adjacentFor('ZETA', 3), null);

  // ── THE UNIVERSE ───────────────────────────────────────────────────────────
  // By CORE ticker: nothing Hong Kong-listed reaches the US brief even though CSOP lists leveraged
  // products on US stocks there, and nothing US-listed is filed under Asia.
  ok('the US list holds no HK, KR, TW or SG symbols',
    WATCH_UNIVERSE.us.every(t => !/\.(HK|KS|TW|SI)$/.test(t)));
  ok('the Asia list is entirely Asian venues',
    WATCH_UNIVERSE.asia.every(t => /\.(HK|KS|TW|SI|T)$/.test(t)));
  ok('and the EU list entirely European',
    WATCH_UNIVERSE.eu.every(t => /\.(L|AS|PA|DE)$/.test(t)));

  // LEVERAGED PRODUCTS ARE BRACKETS, NOT ENTRIES. All five were in the source list and were moved
  // rather than dropped — a leveraged product is a way to express a view on something else.
  for (const t of ['AMDL', 'IRE', 'RGTZ', 'TSLL', 'UNHG']) {
    eq(`${t} is not a watchlist entry`, IN_WATCH_UNIVERSE.has(t), false);
  }
  ok('but each still appears as a bracket',
    ['AMD', 'IREN', 'RGTI', 'TSLA', 'UNH'].every(c => ADJACENT[c]));
  // And their underlyings ARE entries, which is the whole point of the swap.
  ok('while their underlyings are', ['AMD', 'IREN', 'RGTI', 'TSLA', 'UNH'].every(c => IN_WATCH_UNIVERSE.has(c)));

  ok('the universe is not trivially small', IN_WATCH_UNIVERSE.size > 100);
  eq('no symbol is filed under two regions',
    IN_WATCH_UNIVERSE.size, Object.values(WATCH_UNIVERSE).flat().length);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
