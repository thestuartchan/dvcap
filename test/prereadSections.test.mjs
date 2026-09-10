// test/prereadSections.test.mjs — the two new pre-read sections.
//
// The map and the watchlist are what a day trade is actually placed against, and both have a way
// of failing that looks like working: a map whose two rows are on different scales, and a
// watchlist that quietly reaches into the book. Both are tested for here rather than trusted.
import { mapRow, pinOf, renderGexSection, MAP_W, PIN_MIN_SHARE, PIN_NEAR_PCT } from '../lib/gexBrief.js';
import { watchlist, corroborate, renderWatchlist, WATCH_MAX, WATCH_MIN_PCT } from '../lib/watchlist.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
// Floating-point results need a tolerance, not an equality — expectedRange divides by √252.
const near = (n, g, w, tol) => { const good = Number.isFinite(+g) && Math.abs(+g - w) <= tol; console.log(`${good ? '✅' : '❌'} ${n}` + (good ? '' : `  got ${g} want ${w}±${tol}`)); good ? pass++ : fail++; };

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
  // REAL SYMBOLS, because the groups are real now. The fixture used to invent roles, and roles
  // only exist on the ten-name semis list in data/universe.js — which is exactly how the live
  // brief ended up with all sixty-three Asian names in one bucket and every row tagged "the group
  // is split". Grouping is asserted against data/watchMeta.js, the thing that actually ships.
  const names = ['NVDA', 'MU', 'INTC', 'ARM', 'AMD', 'AMZN', 'GOOGL', 'META'].map(sym => ({ name: sym, sym, role: null }));
  const Q = { NVDA: -0.91, MU: 2.75, AMD: -0.83, INTC: 1.69, ARM: 1.03, AMZN: -1.78, GOOGL: -2.28, META: -2.05 };
  const q = (s) => Q[s] == null ? null : { price: 100, changePercent: Q[s] };
  const rows = watchlist(names, q);

  eq('biggest move first', rows[0].name, 'MU');
  ok('capped at five', rows.length <= WATCH_MAX);

  // ── THE GROUP IS THE INDUSTRY, NOT EVERYTHING QUOTED ───────────────────────
  eq('a chip name is grouped with chips', rows.find(r => r.name === 'MU').group, 'semis');
  eq('and not with the whole tech sector', rows.find(r => r.name === 'GOOGL').group, 'internet');

  // A SPLIT GROUP HAS NO MIDDLE. Semis here are 2 up / 2 down; a median through that reads near
  // flat and reports every member as alone against a flat group, which is false twice over.
  eq('a split group is named as split', rows.find(r => r.name === 'MU').tag, 'semis is split');
  eq('and the split is counted', rows.find(r => r.name === 'MU').split, { up: 2, down: 2 });

  // THE GROUP IS NAMED IN THE TAG. "the group is split" never said which group, so a reader could
  // not tell whether twelve chipmakers disagreed or everything quoted that morning did.
  ok('no anonymous group survives in a tag', rows.every(r => !/\bthe group\b/.test(r.tag || '')));

  // NAMED WHILE THEY FIT. The live Asia brief tagged BYD −2.44% and Xiaomi −2.01% as "moving
  // alone" — they moved together, but Tencent and Alibaba sat flat and dragged the megacap median
  // to −0.3%. Corroboration is counted now, not averaged, and the peer is named.
  eq('a two-name group names its peer', rows.find(r => r.name === 'GOOGL').tag, 'with META (-2.0%)');

  // ── A GROUP TOO THIN TO JUDGE WIDENS, IT DOES NOT LIE ──────────────────────
  // AMZN is the only online retailer here. "moving alone" would claim its peers went elsewhere
  // when it has none, so the comparison widens to the sector — and when THAT is empty too the row
  // carries no tag at all.
  {
    const { groupFor, GROUP_MIN_PEERS } = await import('../lib/watchlist.js');
    // One peer is the floor, and the naming rule is what makes that safe — see the note in
    // lib/watchlist.js. Two silenced GOOGL and META, the only two internet names in the universe.
    eq('one peer is enough to say something', GROUP_MIN_PEERS, 1);
    const scanned = ['NVDA', 'MU', 'INTC'].map(sym => ({ sym, levels: ['semis', 'tech'] }));
    eq('a populated sub-group is used as-is', groupFor('NVDA', scanned).level, 'semis');
    const thin = [{ sym: 'AMZN', levels: ['online retail', 'consumer cyclical'] },
                  { sym: 'DKNG', levels: ['gambling', 'consumer cyclical'] },
                  { sym: 'LULU', levels: ['apparel retail', 'consumer cyclical'] }];
    eq('a thin sub-group widens to the sector', groupFor('AMZN', thin).level, 'consumer cyclical');
    eq('and a name with nobody at either level gets no group',
       groupFor('AMZN', [{ sym: 'NVDA', levels: ['semis', 'tech'] }]).level, null);
    // A single peer is named on BOTH sides. "against the group" over one name describes a group of
    // one, and the reader cannot tell from those words whether it is one name or twelve.
    eq('a lone dissenting peer is named, not called a group',
       corroborate(-2.0, [{ name: 'META', changePct: 1.4 }]).tag, 'against META (+1.4%)');
    eq('past two the count is the point again',
       corroborate(-2.0, [{ name: 'A', changePct: 1.4 }, { name: 'B', changePct: 1.2 }, { name: 'C', changePct: 1.1 }]).tag,
       'against the group');
    eq('which renders as no claim, not as "alone"',
       watchlist([{ name: 'AMZN', sym: 'AMZN' }, { name: 'NVDA', sym: 'NVDA' }], q).find(r => r.name === 'AMZN').tag, null);
  }

  // Corroboration on its own.
  eq('moving the other way to a moving group', corroborate(2.0, [-1.5, -1.4, -1.6]).tag, 'against the group');
  // Past two peers the names stop fitting and the count is the point.
  // "with 3 of the group" reads as three out of its total. It is three that agreed.
  eq('three agreeing peers are counted, not listed', corroborate(-1.5, [-1.4, -1.6, -1.5]).tag, 'with 3 others in the group');
  eq('one agreeing peer is named', corroborate(-1.5, [{ name: 'AMZN', changePct: -1.4 }]).tag, 'with AMZN (-1.4%)');
  // A peer that barely moved does not corroborate anything.
  eq('a flat peer leaves it alone', corroborate(-2.4, [{ name: 'X', changePct: -0.1 }]).tag, 'moving alone');
  // And an unnamed peer falls back to the count rather than printing "with null".
  eq('an unnamed peer is counted', corroborate(-1.5, [-1.4]).tag, 'with 1 other in the group');
  eq('moving alone against a flat group', corroborate(3.0, [0.1, 0.0, -0.1]).tag, 'moving alone');
  eq('no peers at all, no claim', corroborate(3.0, []).tag, null);

  // Drift is not a move.
  eq('sub-threshold names are left out', watchlist(names, () => ({ price: 100, changePercent: 0.2 })).length, 0);
  ok('the floor is stated', WATCH_MIN_PCT > 0);
  eq('a name with no quote is skipped, not zeroed', watchlist(names, s => s === 'MU' ? q(s) : null).length, 1);

  // ── A TICKER IS NOT A NAME ─────────────────────────────────────────────────
  // "373220.KS +6.46%" shipped live as one of five things to look at today. It is LG Energy
  // Solution, and no reading of that line on a phone gets a person there.
  {
    const asian = watchlist([{ name: '373220.KS', sym: '373220.KS' }, { name: '051910.KS', sym: '051910.KS' },
                             { name: '005930.KS', sym: '005930.KS' }],
      s => ({ price: 100, changePercent: ({ '373220.KS': 6.46, '051910.KS': 5.56, '005930.KS': -2.1 })[s] }));
    // ── BOTH, NOT EITHER ─────────────────────────────────────────────────────
    // The first version shipped bare tickers and told a reader nothing about what they were.
    // Replacing them with names shipped the opposite failure: "Largan · 6,870 · +5.69%" is
    // recognisable and cannot be typed into an order ticket.
    eq('a local listing carries its company name', asian[0].name, 'LG Energy');
    const txt = renderWatchlist(asian);
    ok('and the ticker beside it, so the row can be acted on', /\*\*LG Energy\*\* `373220\.KS`/.test(txt));
    // A US ticker IS its own name and must not be printed twice.
    const us = renderWatchlist(watchlist([{ name: 'NVDA', sym: 'NVDA' }, { name: 'MU', sym: 'MU' }],
      () => ({ price: 100, changePercent: 2.1 })));
    ok('a name that is its own ticker is not doubled', !/NVDA\*\* `NVDA`/.test(us));
  }

  // ── SILENCE, NOT BOOKKEEPING ───────────────────────────────────────────────
  // An empty list renders nothing at all — no count, no "nothing cleared", no explanation of why
  // there are four entries instead of five.
  eq('an empty watchlist renders nothing', renderWatchlist([]), null);
  const txt = renderWatchlist(rows);
  ok('no slot count leaks into the output', !/slot|unused|of 5|cleared the bar/i.test(txt));
  ok('the tag is rendered in words', /_semis is split_/.test(txt));
  ok('and no colour vocabulary is introduced', !/🟢|🔴|🟡/.test(txt));
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


// ── THE SIX SECTIONS ─────────────────────────────────────────────────────────
// GEX (US) / TODAY'S WATCHLIST / CLOCK / OVERNIGHT / BACKDROP / WHAT WOULD CHANGE IT.
// The brief used to run to eleven sections in the voice of an instrument panel: eleven of its
// twenty-nine content lines were a label, a number and a classification, with no sentence saying
// what any of it meant.
{
  const B = await import('../lib/briefSections.js');

  // ── plain words for plain quantities ───────────────────────────────────────
  eq('a sub-tenth move is flat, not "-0.0%"', B.pctWord(-0.02), 'flat');
  eq('and a real one keeps its sign', B.pctWord(2.35), '+2.4%');
  eq('no print is not a flat print', B.pctWord(null), null);
  eq('a round wait drops its zero minutes', B.humanDur(180), '3h');
  eq('and a short one is minutes only', B.humanDur(45), '45m');
  eq('a negative wait is not a duration', B.humanDur(-5), null);

  // ── 🕐 CLOCK ───────────────────────────────────────────────────────────────
  // Markets that open at the same minute are ONE event to a reader, and three identical lines
  // were three ways of saying it once.
  {
    const c = B.clockSection({
      markets: [{ name: 'Seoul', toOpen: 6 }, { name: 'Tokyo', toOpen: 6 }, { name: 'Hong Kong', toOpen: 96 }],
      usOpen: { toOpen: 795, localTime: '21:30' }, today: ['US CPI 12:30Z'], ahead: ['Wed FOMC'],
    });
    ok('simultaneous opens are one line', /Seoul and Tokyo\*\* open in \*\*6m/.test(c));
    ok('and a later one is its own', /Hong Kong\*\* opens in \*\*1h 36m/.test(c));
    // The single most-asked question of a brief read outside New York, and the old one answered it
    // in no form at all.
    ok('the US open is given in the reader’s own clock', /US opens in 13h 15m\*\* — 21:30 your time/.test(c));
    // Today governs the session about to start; the rest is a note to yourself. They were one
    // undifferentiated ten-day list ordered by date.
    ok('today is separated from the week ahead', /📌 \*\*Today:\*\*/.test(c) && /📆 \*\*Ahead:\*\*/.test(c));
  }
  // A countdown reaching past midnight is a different claim and has to say so.
  ok('a next-session countdown is marked as one',
     /next session/.test(B.clockSection({ markets: [{ name: 'New York', toOpen: 800, nextDay: true }] })));
  ok('a trading market shows time LEFT, not time until', /trading — \*\*40m\*\* left/
     .test(B.clockSection({ markets: [{ name: 'London', toClose: 40 }] })));
  eq('nothing to say renders no section', B.clockSection({}), null);

  // ── 🌙 OVERNIGHT ───────────────────────────────────────────────────────────
  // The implication reads as a conclusion, and a conclusion above its evidence asks to be taken on
  // trust and then checked backwards.
  {
    const o = B.overnightSection({ legs: ['**SOX** -1.8%'], risk: ['**VIX** 17.2'], lead: '👉 concentrated' });
    const lines = o.split('\n');
    eq('the implication comes last', lines[lines.length - 1], '• 👉 concentrated');
    eq('and never alone', B.overnightSection({ lead: '👉 concentrated' }), null);
  }
  // SHAPE, NOT SIZE. Whether the risk was concentrated or spread is the part that survives into
  // the next session.
  ok('a wider chip move than index move reads as concentrated', /concentrated rather than broad/.test(B.breadthNote(-1.8, -0.4)));
  ok('and a wider index move as broad risk', /broad risk rather than a chip story/.test(B.breadthNote(-0.4, -1.8)));
  ok('opposite signs are neither', /moved opposite ways/.test(B.breadthNote(-1.8, 0.9)));
  eq('half a comparison is not a weaker comparison', B.breadthNote(-1.8, null), null);

  // ── 🌡️ BACKDROP ────────────────────────────────────────────────────────────
  // Fifteen quotes at one per line, for a reader who had said the individual prints were not what
  // they read it for. Biggest movers both ways — alphabetical order kept the ±0.1% names and lost
  // the outliers.
  {
    const rows = [{ name: 'A', changePct: 0.1 }, { name: 'B', changePct: -4.2 }, { name: 'C', changePct: 3.9 }, { name: 'D', changePct: 0.2 }];
    const line = B.compressLine(rows, { max: 2 });
    ok('the biggest movers survive the compression', /\*\*B\*\* -4.2% · \*\*C\*\* \+3.9%/.test(line));
    ok('and the rest are counted, not listed', /_\(\+2 more\)_/.test(line));
    eq('nothing quoted renders nothing', B.compressLine([]), null);
  }
  // NAMED FOR WHAT IT MEASURES. A reader who does not know what OAS stands for learns nothing from
  // the abbreviation, and one who does loses nothing from the words.
  ok('the credit gauge is described, not abbreviated',
     /risky companies pay \*\*2.67pp\*\* over government debt/.test(B.creditLine({ oas: 2.67, state: 'CALM' })));
  ok('and no ticker or acronym reaches the reader', !/\bOAS\b|\bHY\b/.test(B.creditLine({ oas: 2.67, state: 'CALM' })));
  // A SPREAD THAT DID NOT PUBLISH AND ONE THAT DID NOT MOVE ARE DIFFERENT FACTS, and they rendered
  // identically for months.
  ok('a stale print says so rather than implying flatness',
     /no new print/.test(B.creditLine({ oas: 2.67, date: '2026-09-05', state: 'CALM', stale: true })));
  ok('a fresh one does not', !/no new print/.test(B.creditLine({ oas: 2.67, date: '2026-09-09', state: 'CALM' })));
  ok('an inverted curve is described in words', /the unusual way round/.test(B.ratesLine({ us2y: 4.4, us10y: 4.1 })));
  ok('and a normal one likewise', /the normal way round/.test(B.ratesLine({ us2y: 3.6, us10y: 4.1 })));
  ok('cheap oil is a cost tailwind, not an inflation story', /takes pressure off costs/.test(B.oilLine({ wti: 62.4, above: false })));
  eq('no oil print, no oil line', B.oilLine({}), null);

  // ── 🔀 WHAT WOULD CHANGE IT ────────────────────────────────────────────────
  // A COUNT IS NOT A TRIPWIRE. "Tripwires · 2/5" sat inside the READ and never once said what
  // firing would mean.
  {
    const items = [{ name: 'OAS widening', tripped: false }, { name: 'KRW > 1400', tripped: true },
                   { name: 'NQ lower low', tripped: null }].map(B.plainTripwire);
    const out = B.changeSection({ items });
    ok('a pending wire says what to watch for', /👁 \*\*Lenders start charging more to carry risk\*\* → junk spreads above 3.00pp/.test(out));
    // Something already true is a present condition, not a thing to watch for. Collapsing the two
    // is how a brief could show "2/5" while a reader took all five as pending.
    ok('a fired one says it has already happened', /🔴 \*\*The won weakens past 1400\*\* — already true/.test(out));
    ok('and says what that means', /money leaving Korea rather than rotating inside it/.test(out));
    ok('an unmeasurable gauge is not listed as either', !/lower low/i.test(out));
    // The threshold moves, so the gloss is matched by prefix and carries the live number through.
    eq('the live threshold survives the plain-English rewrite', B.plainTripwire({ name: 'KRW > 1491', tripped: false }).name,
       'The won weakens past 1491');
    // A WRONG GLOSS ON A RISK GAUGE IS WORSE THAN NO GLOSS.
    const unknown = B.plainTripwire({ name: 'Some new gauge', tripped: false });
    eq('an unrecognised gauge keeps its own name', unknown.name, 'Some new gauge');
    eq('and is given no invented meaning', unknown.means, null);
    eq('no gauges at all renders nothing', B.changeSection({ items: [] }), null);
  }

  // ── THE WHOLE BRIEF STAYS OBSERVATIONAL ────────────────────────────────────
  // lib/read.js asserts the READ carries no positioning language. These sections replaced the READ,
  // so they inherit the assertion — an implication says what an arrangement is consistent with,
  // never what to do about it.
  {
    const { assertObservational } = await import('../lib/read.js');
    const src = (await import('node:fs')).readFileSync(new URL('../lib/briefSections.js', import.meta.url), 'utf8');
    // Only the strings the reader can actually see, not the commentary explaining them. Both
    // forms are pinned to a SINGLE LINE: a backtick class that allowed newlines ran from one
    // template literal to the next and scanned the prose between them, which flagged a comment
    // and would just as happily have missed a real violation inside the span it swallowed.
    for (const m of src.matchAll(/`([^`\\$\n]{12,})`|'([^'\n]{12,})'/g)) {
      const text = m[1] || m[2];
      if (!/[a-z]{3} [a-z]{3}/.test(text)) continue;       // skip identifiers and format strings
      const v = assertObservational(text);
      ok(`no positioning language in "${text.slice(0, 44)}"`, v.ok);
    }
  }
}


// ── 📏 EXPECTED RANGE ────────────────────────────────────────────────────────
// The map says WHERE the levels are and never how far price is expected to travel. A put wall
// 1.9% below spot is a different proposition on a day priced for ±0.6% than on one priced for
// ±1.5%, and nothing in the brief distinguished those two days.
{
  const { expectedRange, TRADING_DAYS, renderGexSection } = await import('../lib/gexBrief.js');

  eq('trading days, not calendar days', TRADING_DAYS, 252);
  {
    const e = expectedRange(716.275, 0.2175);
    near('a one-day move at 21.75% vol', e.pts, 9.81, 0.02);
    near('and as a percentage of spot', e.pct, 1.37, 0.02);
  }
  // √365 instead of √252 understates the daily move by about a fifth. Pinned, because the two
  // roots look equally plausible in a formula and only one matches how the vol is quoted.
  ok('the calendar-day root would give a smaller number', expectedRange(100, 0.20).pts > 100 * 0.20 / Math.sqrt(365));

  // A quote arrives as 0.2175 from one source and 21.75 from another. Reading the second as a
  // decimal would put the band out by a factor of a hundred.
  eq('a percentage-form vol is normalised', expectedRange(716.275, 21.75).pts, expectedRange(716.275, 0.2175).pts);
  // 300% annualised on an index is not a real reading, so the boundary sits well below it.
  eq('no vol, no band', expectedRange(716, 0), null);
  eq('no spot, no band', expectedRange(0, 0.2), null);
  eq('and a missing vol is not treated as zero', expectedRange(716, null), null);

  // It renders beside the levels, and only when the vol is there.
  {
    const rows = [{ name: 'QQQ', spot: 716.275, putWall: 700, callWall: 716, flipLevel: 719.57, iv: 0.2175, pin: { pinned: false } }];
    const withIv = renderGexSection(rows, { rung: 'repriced' });
    ok('the band renders with the levels', /Priced for\*\* \*\*QQQ\*\* ±9.81/.test(withIv));
    // A BAND IS NOT A BOUNDARY. Roughly one day in three finishes outside it, and the line says so
    // rather than letting the number read as a limit.
    ok('and does not present itself as a limit', /one day in three finishes outside it/.test(withIv));
    const noIv = renderGexSection(rows.map(r => ({ ...r, iv: null })), { rung: 'repriced' });
    ok('no vol means no line, not a blank one', !/Priced for/.test(noIv));
  }
}

// ── 🔄 SINCE YOUR LAST BRIEF ─────────────────────────────────────────────────
// Every other section describes a state. A reader who read yesterday's brief already holds most of
// that state; what they cannot get from today's message alone is what MOVED.
{
  const { sinceSection, SINCE_MIN } = await import('../lib/briefSections.js');

  // A FIRST RUN HAS NOTHING TO COMPARE, and must not say so.
  eq('no prior brief renders nothing', sinceSection({ oas: 2.67 }, null), null);
  // A QUIET DAY RENDERS NOTHING EITHER. A brief that reports the absence of news every morning
  // trains a reader to skip the line on the morning there is some.
  eq('nothing moved renders nothing', sinceSection({ oas: 2.67, vix: 16.4 }, { oas: 2.67, vix: 16.4 }), null);
  ok('and the noise floors are stated', SINCE_MIN.oas > 0 && SINCE_MIN.vix > 0);
  eq('a move under the floor is print noise', sinceSection({ oas: 2.69 }, { oas: 2.67 }), null);

  // TRIPWIRES FIRST: a gauge crossing its threshold is a change of state, the rest are changes of
  // degree.
  {
    const out = sinceSection(
      { wires: { 'The won weakens past 1400': true, 'VIX rising': false }, oas: 3.10 },
      { wires: { 'The won weakens past 1400': false, 'VIX rising': true }, oas: 2.67 });
    const lines = out.split('\n');
    ok('a wire that crossed leads', /^• 🔴 \*\*The won weakens past 1400\*\* — crossed since yesterday$/.test(lines[0]));
    ok('a wire that un-crossed is its own state', /🟢 \*\*VIX rising\*\* — no longer true/.test(out));
    ok('and the degree changes follow', lines.indexOf(lines.find(l => /Credit spread/.test(l))) > 1);
    ok('with the direction said in words', /lenders charging more/.test(out));
  }
  // A wire present in one brief and not the other is not a flip in either direction.
  eq('a wire that appeared is not reported as a crossing',
     sinceSection({ wires: { New: true } }, { wires: {} }), null);
  eq('nor one that vanished', sinceSection({ wires: {} }, { wires: { Old: true } }), null);
  // Nor is an unmeasurable gauge on either side.
  eq('an unmeasurable reading is not a flip',
     sinceSection({ wires: { A: true } }, { wires: { A: null } }), null);

  // Oil moves in per cent, not in points — a $2 move means different things at $60 and at $100.
  ok('oil is measured proportionally', /Oil\*\* 96 → \*\*102\*\* \(\+6.3%\)/.test(sinceSection({ wti: 102 }, { wti: 96 })));
  eq('and a small proportional move is nothing', sinceSection({ wti: 96.5 }, { wti: 96 }), null);

  // A LEVEL THAT MOVED IS THE ONE A READER MOST NEEDS BEFORE THEY PLACE AGAINST IT.
  {
    const out = sinceSection(
      { walls: { QQQ: { putWall: 705, callWall: 716 } }, spot: { QQQ: 716 } },
      { walls: { QQQ: { putWall: 700, callWall: 716 } } });
    ok('a wall that moved is named with both levels', /QQQ put wall\*\* 700 → \*\*705\*\*/.test(out));
    ok('and the one that did not is not mentioned', !/call wall/.test(out));
  }
}


// ── 💵 THE CURVE HAS TWO HALVES ──────────────────────────────────────────────
// The line carried 2yr and 10yr and read the shape off that pair alone, so a curve steepening at
// the LONG end — a different fact, with a different cause — was invisible to it. The 30Y was
// already fetched, already carried a 10s30s delta in lib/assemble.js and was already a scenario
// condition; it simply never reached the brief.
{
  const { ratesLine, LONG_END_LED_PP, plainTripwire } = await import('../lib/briefSections.js');
  const { SCENARIO_CFG } = await import('../lib/scenarios.js');
  const { gaugesLeaning } = await import('../lib/gates.js');

  ok('the 30Y reaches the line', /30yr 5.25%/.test(ratesLine({ us2y: 4.39, us10y: 4.8, us30y: 5.25 })));
  // A LONG-END-LED STEEPENING IS NOT A POLICY CALL. 2s10s is what the market has priced into the
  // next couple of years; 10s30s is the price of holding duration at all.
  ok('a long end steeper than the front is called out',
     /steepest part is the long end/.test(ratesLine({ us2y: 3.0, us10y: 3.4, us30y: 4.4 })));
  ok('and is not described as a view on policy',
     /rather than a view on where policy goes/.test(ratesLine({ us2y: 3.0, us10y: 3.4, us30y: 4.4 })));
  ok('a front-led one says so instead',
     /policy-sensitive front end/.test(ratesLine({ us2y: 3.0, us10y: 4.0, us30y: 4.1 })));
  // 10s30s +45bp against 2s10s +41bp is a four-basis-point difference and not a story. The
  // threshold has to stay quiet there, or the line invents a narrative every single day.
  ok('a four-basis-point difference is not a story',
     /the normal way round/.test(ratesLine({ us2y: 4.39, us10y: 4.8, us30y: 5.25 })));
  ok('the threshold is stated', LONG_END_LED_PP > 0);
  // An inversion outranks everything: it is the rarer and larger fact.
  ok('an inverted front end still leads', /the unusual way round/.test(ratesLine({ us2y: 4.6, us10y: 4.4, us30y: 4.9 })));
  ok('two legs still render without the third', /2yr 4.39%/.test(ratesLine({ us2y: 4.39, us10y: 4.8 })));
  // 2s10s is the whole shape test, so the 30Y alone cannot produce one.
  ok('and a lone 30Y does not claim a shape', !/way round|steepest/.test(ratesLine({ us30y: 5.25 })));

  // ── A MISSING LEG IS A FACT, NOT A GAP ─────────────────────────────────────
  // Observed live: a transient FRED miss dropped the 2yr and the line rendered "10yr · 30yr" with
  // no shape and nothing to say a leg was absent. That is the same ambiguity as a flat print and a
  // missing print rendering identically — the line quietly says less without saying that it is.
  {
    const short = ratesLine({ us10y: 4.8, us30y: 5.25 });
    ok('a dropped leg is named', /no print for the 2yr/.test(short));
    ok('and the withheld shape is accounted for', /the shape is not stated/.test(short));
    ok('the legs that did print still do', /10yr 4.8%/.test(short) && /30yr 5.25%/.test(short));
    ok('two absent legs read as a list', /the 2yr and 10yr/.test(ratesLine({ us30y: 5.25 })));
    // NOT NARRATED WHEN IT CHANGES NOTHING. A leg missing from a line that was making no shape
    // claim anyway is bookkeeping, and a brief that reports its own gaps teaches a reader to skip
    // the line on the day a gap matters.
    ok('a complete line says nothing about absence', !/no print/.test(ratesLine({ us2y: 4.39, us10y: 4.8, us30y: 5.25 })));
    ok('nor does one whose shape survived the gap', !/no print/.test(ratesLine({ us2y: 4.39, us10y: 4.8 })));
  }
  eq('no yields, no line', ratesLine({}), null);

  // ── THE TRIPWIRE, AT THE SCENARIO ENGINE'S OWN NUMBER ──────────────────────
  // SCENARIO_CFG.hawkish30y has sat at 5.35 all along and nothing told a reader. On the capture
  // date the yield was 5.25 — ten basis points away.
  const wires = gaugesLeaning({ us30y: { value: 5.25, deltaBps: 1 } }).items.map(i => i.name);
  ok('the long end is one of the gauges', wires.some(n => /^30Y >/.test(n)));
  // ONE NUMBER, NOT TWO COPIES. A restated threshold is a threshold that can drift, and the
  // failure is the gauge and the scenario describing the same level at different values.
  ok('and it carries the scenario engine’s threshold', wires.some(n => n === `30Y > ${SCENARIO_CFG.hawkish30y}%`));
  eq('below the level it has not fired', gaugesLeaning({ us30y: { value: 5.25 } }).items.find(i => /^30Y >/.test(i.name)).tripped, false);
  eq('above it, it has', gaugesLeaning({ us30y: { value: 5.40 } }).items.find(i => /^30Y >/.test(i.name)).tripped, true);
  // No print is unavailable, not calm — the same rule every other gauge here follows.
  eq('no print is not a passing reading', gaugesLeaning({}).items.find(i => /^30Y >/.test(i.name)).tripped, null);
  // And the live threshold survives into the plain-English name rather than being hardcoded there.
  eq('the gloss carries the live level', plainTripwire({ name: '30Y > 5.35%', tripped: false }).name,
     'The 30-year yield clears 5.35%');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
