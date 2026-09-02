// Regression tests for lib/tradecard.js and lib/discord.js.
//
// The privacy tests below are the point of the file. They do not check that the current code
// happens to omit a private figure — they check that no private figure can reach a payload, by
// building rows whose private values are distinctive digit strings and asserting those strings
// appear nowhere in the serialised output. A future edit that adds "· 600 @ 18.06" to a line fails
// here rather than on a Discord server.
import { publicView, buildCard, buildClosedCard, closedLine, rOf, lockedPct, isOptionTrade, showsOnCard, CLOSED_WINDOW_DAYS, buildAlert, diffRows, tradeLine, distTo, daysHeld, isCashLeg, dirOf, fitLines, sortForCard, DESC_BUDGET, PUBLIC_FIELDS } from '../lib/tradecard.js';
import { isWebhookUrl, alertTtlMin, mentionFromEnv, webhookFromEnv } from '../lib/discord.js';
import fs from 'node:fs';
let pass=0,fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};
const ok=(n,c)=>eq(n,!!c,true);

// A row whose every private number is a string that could not occur by chance.
// The four forbidden quantities: size, absolute P&L, market value, share of book. PRICES are not
// among them — entry, stop and target are the idea itself, and are published deliberately. The four
// below describe the size of the ACCOUNT rather than the merit of a trade, and none may appear
// anywhere in a payload.
const SECRET = { qty: 987654, realized: 555444.33, unrealized: 222111.99, mv: 888777.66, weight: 44.44 };
const row = {
  id: 'r1', symbol: 'METU', trade: '2x META', currency: 'USD', price: 20.41,
  levels: [{ id: 'l1', kind: 'stop', at: 16.5 }],
  levelHits: ['buy zone hit at 16.85'],
  derived: { status: 'open', qty: SECRET.qty, avgCost: 18.06, avgEntry: 18.06,
             realized: SECRET.realized, spent: 108380, firstDate: '2026-08-18', lastDate: '2026-08-18', multiplier: 1 },
  pnl: { total: SECRET.unrealized, totalPct: 6.01, unrealizedPct: 12.99, unrealized: SECRET.unrealized, marketValue: SECRET.mv },
  weightPct: SECRET.weight,
};

// ── the whitelist is a whitelist, not a delete-list ──
eq('publicView returns exactly the public fields', Object.keys(publicView(row)).sort(), [...PUBLIC_FIELDS].sort());
const v = publicView(row, { today: '2026-08-26' });
eq('symbol survives', v.symbol, 'METU');
eq('percentage survives', v.pct, 12.99);
eq('days held survives', v.days, 8);
eq('the entry average is published', v.avg, 18.06);
eq('the stop level is published', v.stop.at, 16.5);
eq('quantity does not', v.qty, undefined);
eq('the raw average cost field does not', v.avgCost, undefined);
eq('market value does not', v.marketValue, undefined);
eq('absolute P&L does not', v.total, undefined);
eq('share of book does not', v.weightPct, undefined);

// ── nothing private reaches a payload ──
const secretStrings = Object.values(SECRET).flatMap(n => [String(n), String(Math.round(n)), String(n).replace('.', ',')]);
const scan = (label, payload) => {
  const s = JSON.stringify(payload);
  const leaked = secretStrings.filter(t => t.length > 3 && s.includes(t));
  eq(`${label} leaks nothing`, leaked, []);
};
scan('card', buildCard([row]));
scan('open alert', buildAlert({ kind: 'opened', row }, { mentionId: '12345' }));
scan('close alert', buildAlert({ kind: 'closed', row }));
scan('level alert', buildAlert({ kind: 'level', row, level: 'buy zone hit at 16.85' }));

// The card is about what is ON, not about how the account has done. No footer, and no aggregate
// of any kind — a win rate over the closed book describes the account, which is the same objection
// that rules out the balance, one step further out.
const card = buildCard([row]);
ok('no footer at all', card.embeds[0].footer === undefined);
ok('no currency symbol anywhere', !/[$€£¥]/.test(JSON.stringify(card)));
ok('no win rate', !/win/i.test(JSON.stringify(card)));

// ── R multiple ──
eq('distance to a level below', distTo(16.5, 20.41), -19.2);
eq('distance to a level above', distTo(25.25, 20.41), 23.7);
eq('no price, no distance', distTo(16.5, null), null);
// R is not printed: avg and SL are both on the line, which is the same information in a form the
// reader can check rather than take on trust.
const line = tradeLine(v);
for (const part of ['METU', '20.41', 'avg 18.06', '+12.99%', 'SL 16.5', '8d'])
  ok(`line carries ${part}`, line.includes(part));
ok('no direction marker — every position here is long', !/ L · /.test(line));
ok('trims appear when a position has been scaled out', tradeLine(publicView({ ...row, derived: { ...row.derived, scaleOuts: [{ pct: 8.2 }, { pct: 14.1 }] } })).includes('trimmed +8%, +14%'));
ok('and not when it has not', !tradeLine(v).includes('trimmed'));
// A target reads in R when a stop makes R computable, and falls back to plain distance when it
// does not — the reward on a unit of risk is the more useful of the two whenever it exists.
ok('a target reads in R when there is a stop', tradeLine(publicView({ ...row, levels: [...row.levels, { kind: 'sell', at: 25.25 }] })).includes('TP 25.25 (+4.6R)'));
ok('and in distance when there is not', tradeLine(publicView({ ...row, levels: [{ kind: 'sell', at: 25.25 }] })).includes('TP 25.25 (+24%)'));

// ── days held ──
eq('days held', daysHeld('2026-08-18', '2026-08-26'), 8);
eq('open-ended', daysHeld(null, '2026-08-26'), null);
eq('a closed trade measures to its exit', publicView({ ...row, derived: { ...row.derived, status: 'closed', lastDate: '2026-08-20' } }).days, 2);

// ── which changes are worth interrupting for ──
const setup = { id: 'a', symbol: 'AAA', derived: { status: 'setup' }, pnl: {} };
const open  = { id: 'a', symbol: 'AAA', derived: { status: 'open', firstDate: '2026-08-01' }, pnl: {} };
const closed= { id: 'a', symbol: 'AAA', derived: { status: 'closed', firstDate: '2026-08-01', lastDate: '2026-08-09' }, pnl: {} };
eq('a setup becoming a position is an event', diffRows([setup], [open]).map(e => e.kind), ['opened']);
eq('a position closing is an event', diffRows([open], [closed]).map(e => e.kind), ['closed']);
eq('a brand new open row is an event', diffRows([], [open]).map(e => e.kind), ['opened']);
// A scale-in changes size and nothing a reader would act on. It must stay silent, or the channel
// stops being read.
const scaled = { ...open, derived: { ...open.derived, qty: 999 } };
eq('a scale-in is not an event', diffRows([open], [scaled]), []);
eq('an unchanged book is silent', diffRows([open], [open]), []);
eq('a new level hit is an event', diffRows([open], [{ ...open, levelHits: ['stop hit at 16.5'] }]).map(e => e.kind), ['level']);
eq('the same hit does not fire twice', diffRows([{ ...open, levelHits: ['x'] }], [{ ...open, levelHits: ['x'] }]), []);

// ── the card holds together with nothing in it ──
const empty = buildCard([]);
ok('an empty book still renders', !!empty.embeds[0].description);
ok('and says so', /nothing open/i.test(empty.embeds[0].description));
ok('with no empty field block', empty.embeds[0].fields === undefined);

// The count lives in the title once. A field wrapping the positions would have to be named, and
// the only honest name repeats it.
const titled = buildCard([row]);
eq('title carries the count', titled.embeds[0].title, '📊 Portfolio · 1 position');
ok('positions are the description, not a field', titled.embeds[0].description.includes('METU'));
ok('and no field repeats the count', (titled.embeds[0].fields || []).every(f => !/^Open/.test(f.name)));
eq('plural when it should be', buildCard([row, { ...row, id: 'r2', symbol: 'HOOD' }]).embeds[0].title, '📊 Portfolio · 2 positions');

// ── mentions only fire when configured ──
eq('no mention id, no ping', buildAlert({ kind: 'opened', row }).allowed_mentions.users, []);
eq('a mention id pings exactly one person', buildAlert({ kind: 'opened', row }, { mentionId: '42' }).allowed_mentions.users, ['42']);

// ── the webhook URL is a credential; only Discord's own host is accepted ──
ok('a real webhook passes', isWebhookUrl('https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL'));
ok('discordapp.com passes', isWebhookUrl('https://discordapp.com/api/webhooks/1234567890/tok_en-1'));
ok('a versioned path passes', isWebhookUrl('https://discord.com/api/v10/webhooks/1234567890/tok'));
for (const bad of ['https://evil.com/api/webhooks/1/x', 'http://discord.com/api/webhooks/1/x',
                   'https://discord.com/api/webhooks/abc/x', 'https://discord.com.evil.net/api/webhooks/1/x', '', null, 7])
  ok(`rejects ${JSON.stringify(bad)}`, !isWebhookUrl(bad));
eq('no env, no webhook', webhookFromEnv({}), null);
eq('a bad env value is not used', webhookFromEnv({ DISCORD_TRADES_WEBHOOK: 'https://evil.com/x' }), null);

// Alerts persist unless a TTL is set — a notice that deletes itself before it is read is worse
// than no notice.
eq('alerts are permanent by default', alertTtlMin({}), 0);
eq('a TTL can be set', alertTtlMin({ TRADE_ALERT_TTL_MIN: '90' }), 90);
eq('a nonsense TTL is ignored', alertTtlMin({ TRADE_ALERT_TTL_MIN: 'soon' }), 0);
eq('a negative TTL is ignored', alertTtlMin({ TRADE_ALERT_TTL_MIN: '-5' }), 0);
eq('a mention id must look like one', mentionFromEnv({ DISCORD_USER_ID: 'me' }), null);
eq('and is used when it does', mentionFromEnv({ DISCORD_USER_ID: '123456789012345678' }), '123456789012345678');

// ── cash is not a position ──
for (const sym of ['USFR', 'SGOV', 'BIL', 'SHV', 'TFLO', 'TBIL', 'JPST'])
  ok(`${sym} is cash`, isCashLeg({ symbol: sym }));
ok('a HK ticker suffix does not hide it', isCashLeg({ symbol: 'SGOV.US' }));
ok('a real position is not', !isCashLeg({ symbol: 'METU' }));
ok('nor is one that merely mentions cash flow', !isCashLeg({ symbol: 'AAPL', trade: 'cashflow compounder' }));
ok('the label is an escape hatch', isCashLeg({ symbol: 'VMFXX', trade: 'cash sweep' }));
ok('so is a tag', isCashLeg({ symbol: 'WHATEVER', tags: ['cash'] }));

// ── the book has to fit an embed, and detail degrades before the list is cut ──
const heavy = (i) => ({ symbol: `TICK${i}`, label: '', price: 123.45, avg: 98.76, pct: 24.99,
  trims: [8, 14, 21, 45, 119, 33], stop: { at: 88.5, dist: -28 },
  targets: [{ at: 150, dist: 21 }, { at: 180, dist: 46 }, { at: 220, dist: 78 }],
  days: 77, since: '2026-06-10', status: 'open', flags: ['sell 150 reached'] });
const mk = (n) => Array.from({ length: n }, (_, i) => heavy(i));
ok('detail shrinks a line', tradeLine(heavy(1), 'compact').length < tradeLine(heavy(1), 'full').length);
ok('and shrinks it again', tradeLine(heavy(1), 'minimal').length < tradeLine(heavy(1), 'compact').length);
eq('a small book keeps full detail', fitLines(mk(10)).detail, 'full');
eq('a large one drops to compact', fitLines(mk(25)).detail, 'compact');
eq('a larger one to minimal', fitLines(mk(45)).detail, 'minimal');
// The ceiling is asserted as a PROPERTY rather than a magic number, because the number moves every
// time a line gains a word — adding "held " to each line shifted it, and a hard-coded 61 turned a
// deliberate wording change into a failing test that said nothing about correctness. What must hold
// is: the body always fits, and nothing is dropped until the minimal form genuinely cannot.
for (const n of [10, 25, 45, 55])
  ok(`${n} maximal positions still fit the budget`, fitLines(mk(n)).body.length <= DESC_BUDGET);
const ceiling = (() => { let n = 0; while (fitLines(mk(n + 1)).dropped === 0 && n < 200) n++; return n; })();
ok(`nothing is dropped below the ceiling (found at ${ceiling})`, fitLines(mk(ceiling)).dropped === 0);
ok('and the ceiling is comfortably past a real book', ceiling >= 50);
ok('one past it drops and says so', /more not shown/.test(fitLines(mk(ceiling + 1)).body));
// Past the point where even minimal fits, the list is cut — but never silently.
const over = fitLines(mk(120));
ok('past the ceiling it cuts', over.dropped > 0);
ok('and says how many are missing', /and \d+ more not shown/.test(over.body));
ok('while still respecting the budget', over.body.length <= DESC_BUDGET);
ok('a real card stays inside the description limit', buildCard(mk(120).map(v => ({
  symbol: v.symbol, price: v.price, derived: { status: 'open', avgCost: v.avg, firstDate: '2026-06-10', scaleOuts: [] }, pnl: { totalPct: v.pct },
}))).embeds[0].description.length <= 4096);

// ── the contract between api/tradecard.js and api/prices.js ──
// This is not a unit test of either file; it is the seam between them, and the seam is where the
// first live run broke. tradecard asked for ?symbols= while prices reads req.query.tickers, so the
// call 400'd, every price came back null, and the card rendered "—" and "0.00%" for the whole book
// without anything reporting a failure. Reading the parameter name out of the provider and
// asserting the consumer uses it costs nothing and catches a rename from either side.
const pricesSrc = fs.readFileSync(new URL('../api/prices.js', import.meta.url), 'utf8');
const cardSrc = fs.readFileSync(new URL('../api/tradecard.js', import.meta.url), 'utf8');
const wantsParam = /const \{ (\w+) \} = req\.query/.exec(pricesSrc)?.[1];
const sendsParam = /api\/prices\?(\w+)=/.exec(cardSrc)?.[1];
eq('the price endpoint still reads one named query param', typeof wantsParam, 'string');
eq('and the card sends exactly that one', sendsParam, wantsParam);
// The provider answers with the quote map at the top level, so the consumer must not reach into a
// wrapper key that does not exist.
ok('prices answers at the top level', /res\.status\(200\)\.json\(results\)/.test(pricesSrc));
ok('and the card does not unwrap a missing key', !/await r\.json\(\)\)\?\.prices/.test(cardSrc));

// ── cash is excluded from ALERTS too, not only from the card ──
const cashRow = { id: 'c', symbol: 'USFR', trade: 'cash leg', derived: { status: 'open', firstDate: '2026-07-10' }, pnl: {} };
ok('a cash row is recognised', isCashLeg(cashRow));
// diffRows itself is unfiltered by design — the endpoint decides what is announceable — so the
// test is that filtering with isCashLeg removes it before the diff sees it.
eq('filtered out before the diff', diffRows([], [cashRow].filter(r => !isCashLeg(r))), []);
eq('while a real position survives', diffRows([], [{ id: 'm', symbol: 'METU', derived: { status: 'open' }, pnl: {} }].filter(r => !isCashLeg(r))).length, 1);

// ── a first run must not announce a book that is weeks old ──
ok('the endpoint seeds silently on a cold start', /const firstRun = !state\.rows;/.test(cardSrc));
ok('and only diffs once there is something to diff against', /firstRun \? \[\] : diffRows\(state\.rows/.test(cardSrc));

// ── the percentage must agree with the two numbers printed beside it ──
// price and avg are both on the line, so the reader derives (price − avg) / avg whether or not it
// is offered. A total-return figure — right for the console, where it sits under its own
// denominator — would contradict them.
const consistent = publicView({ ...row, price: 251.06,
  derived: { ...row.derived, avgCost: 331.5567 },
  pnl: { unrealizedPct: -24.28, totalPct: -12.33 } });
eq('the card takes the move from average cost', consistent.pct, -24.28);
const derivable = ((251.06 - 331.5567) / 331.5567) * 100;
ok('which is what the line implies', Math.abs(consistent.pct - derivable) < 0.01);
ok('not the return on everything deployed', consistent.pct !== -12.33);

// ── the dot says which way, even when the percentage rounds flat ──
// MGC: one micro gold contract, ten cents up on 4,649.70. The move is +0.002%, which is 0.00 at the
// two decimals the card prints — and the dot used to read that as "no price" and go grey.
eq('a move too small to print is still a move', dirOf(0, 4649.80, 4649.70464) > 0, true);
eq('and downward the same way', dirOf(0, 4649.60, 4649.70464) < 0, true);
eq('a real percentage is used as-is', dirOf(-24.28, 251.06, 331.56), -24.28);
eq('genuinely flat is flat', dirOf(0, 100, 100), 0);
eq('nothing to compare stays nothing', dirOf(null, null, null), null);
eq('a null percentage with no mark is nothing', dirOf(null, null, 10), null);
// and the printed sign agrees with it, so neither half of the line contradicts the other.
ok('the sign agrees with the dot',
  tradeLine({ symbol: 'MGC', label: '', price: 4649.80, avg: 4649.70464, pct: 0, trims: [], stop: null, targets: [], days: 1, since: '', status: 'open', flags: [], tags: [] }).includes('**+0.00%**'));
ok('and downward too',
  tradeLine({ symbol: 'MGC', label: '', price: 4649.60, avg: 4649.70464, pct: 0, trims: [], stop: null, targets: [], days: 1, since: '', status: 'open', flags: [], tags: [] }).includes('**-0.00%**'));
ok('a genuine flat gets no sign',
  tradeLine({ symbol: 'X', label: '', price: 100, avg: 100, pct: 0, trims: [], stop: null, targets: [], days: 1, since: '', status: 'open', flags: [], tags: [] }).includes('**0.00%**'));
ok('so the line goes green, not grey',
  tradeLine({ symbol: 'MGC', label: '', price: 4649.80, avg: 4649.70464, pct: 0, trims: [], stop: null, targets: [], days: 1, since: '', status: 'open', flags: [], tags: [] }).startsWith('🟢'));
ok('and a closed trade that scratched shows its direction too',
  closedLine({ symbol: 'TQQQ', exit: 69.443, avg: 69.400203, realisedPct: 0, r: null, days: 4 }).startsWith('🟢'));

// ── order decides what gets read ──
const V = (symbol, pct, flags = []) => ({ symbol, label: '', price: 10, avg: 10, pct, trims: [], stop: null, targets: [], days: 1, since: '', status: 'open', flags, tags: [] });
const ordered = sortForCard([V('WIN_SMALL', 1.4), V('LOSS_BIG', -36.5), V('WIN_BIG', 11), V('LOSS_SMALL', -1.1), V('HIT', -10.6, ['stop reached'])]);
eq('one ranking, best to worst', ordered.map(v => v.symbol), ['WIN_BIG', 'WIN_SMALL', 'LOSS_SMALL', 'HIT', 'LOSS_BIG']);
// The card is read from the BOTTOM to find work: the last line is the position furthest underwater.
eq('the worst position is the last line', ordered[ordered.length - 1].symbol, 'LOSS_BIG');
ok('and the percentages descend the whole way', ordered.every((v, i) => i === 0 || ordered[i - 1].pct >= v.pct));
// A level hit no longer jumps the queue — it sits at its return and shouts on its own line instead.
eq('a hit does not move a loser up', sortForCard([V('L', -20, ['stop reached']), V('W', 30)])[0].symbol, 'W');
ok('the flag still rides along', tradeLine(V('L', -20, ['stop reached'])).includes('⚡ stop reached'));
// A long hold is not special-cased either: INTC down 10% ranks below a swing up 2% and above one
// down 30%, which is where its return puts it, and the reader can see that without a rule.
eq('a hold in the red ranks by its return like anything else',
  sortForCard([V('SWING_BAD', -36), { ...V('HOLD_BAD', -24), label: 'long hold' }, V('WIN', 11)]).map(v => v.symbol),
  ['WIN', 'HOLD_BAD', 'SWING_BAD']);
// No price is not a zero, and must not sort as the best position in the book either.
const noprice = sortForCard([V('A', -5), V('B', null), V('C', 5)]);
eq('an unpriced row sorts last, not first', noprice.map(v => v.symbol), ['C', 'A', 'B']);
eq('two ties break on the symbol', sortForCard([V('ZZ', 4), V('AA', 4)]).map(v => v.symbol), ['AA', 'ZZ']);
eq('an empty book sorts fine', sortForCard([]), []);
ok('sorting does not mutate the input', (() => { const a = [V('X', 1), V('Y', 9)]; sortForCard(a); return a[0].symbol === 'X'; })());

eq('the tag survives publicView', publicView({ symbol: 'X', tags: ['hold'], derived: {}, pnl: {} }).tags, ['hold']);

// ── R ──
eq('R from entry, stop and price', rOf(20.05, 18.06401, 16.5), 1.3);
eq('a target in R is the reward on 1R of risk', rOf(25.25, 18.06401, 16.5), 4.6);
eq('the stop itself is minus one R', rOf(16.5, 18.06401, 16.5), -1);
eq('a loser is negative R', rOf(17.28, 18.06, 16.5), -0.5);
// R exists only if a stop does — a position with no invalidation level has no risk unit to be a
// multiple OF, so the answer is nothing rather than a number.
eq('no stop, no R', rOf(20.05, 18.06, null), null);
eq('a stop at entry is not a risk unit', rOf(20.05, 18.06, 18.06), null);
eq('nor is one above it', rOf(20.05, 18.06, 19), null);

const withStop = publicView({ symbol: 'METU', price: 20.05, levels: [{ kind: 'stop', at: 16.5 }, { kind: 'sell', at: 25.25 }],
  derived: { status: 'open', avgCost: 18.06401, firstDate: '2026-08-18', scaleOuts: [] }, pnl: { unrealizedPct: 11 } });
const wl = tradeLine(withStop);
ok('R sits beside the percentage', wl.includes('(+1.3R)'));
ok('the stop keeps its absolute price', wl.includes('SL 16.50'));
ok('the target carries both price and R', wl.includes('TP 25.25 (+4.6R)'));
ok('and no R at all without a stop', !/R\b/.test(tradeLine(publicView({ symbol: 'X', price: 20, levels: [], derived: { status: 'open', avgCost: 18, scaleOuts: [] }, pnl: { unrealizedPct: 11 } }))));

// ── the closed card ──
const closedRow = (symbol, entry, exit, stop, date) => ({ symbol, levels: stop ? [{ kind: 'stop', at: stop }] : [],
  derived: { status: 'closed', avgEntry: entry, avgExit: exit, avgCost: entry, realizedPct: +(((exit - entry) / entry) * 100).toFixed(2),
             firstDate: date, lastDate: date, scaleOuts: [] }, pnl: {} });
const cc = buildClosedCard([closedRow('TQQQ', 69.4, 69.44, 67.5, '2026-08-20'), closedRow('SPY', 2.74, 0.52, null, '2026-06-08')]);
ok('titled by count', cc.embeds[0].title.includes('2 trades'));
ok('a stopped trade reports R', /R/.test(cc.embeds[0].description.split('\n')[0]));
// R OR NOTHING. A percentage in R's slot is a different measurement wearing its clothes, and a
// column that switches between them cannot be read down.
ok('one without shows no move at all', !/[%R]/.test(cc.embeds[0].description.split('\n')[1]));
ok('and the card says why', /no R to show/.test(cc.embeds[0].footer.text));
ok('days are labelled', cc.embeds[0].description.includes('held '));
// "out" was doing no work — a price on a closed line is the exit by definition.
ok('no redundant label on the exit price', !/\bout\b/.test(cc.embeds[0].description));
ok('every line still carries the exit price', cc.embeds[0].description.split('\n').every(l => /\d/.test(l)));
eq('an empty archive still renders', /Nothing closed in the last 90 days/.test(buildClosedCard([]).embeds[0].description), true);
ok('no footer when every trade has R', buildClosedCard([closedRow('A', 10, 12, 9, '2026-08-01')]).embeds[0].footer === undefined);
// It must be as private as the open card.
scan('closed card', buildClosedCard([{ ...row, derived: { ...row.derived, status: 'closed', avgExit: 21.39, realizedPct: -0.05 } }]));

// ── one exclusion rule, both cards ──
ok('an option row is recognised by tag', isOptionTrade({ tags: ['archive', 'option'] }));
ok('and by its multiplier when untagged', isOptionTrade({ multiplier: 100 }));
ok('a margined x100 contract is not an option', !isOptionTrade({ multiplier: 100, margined: true }));
ok('shares are not', !isOptionTrade({ multiplier: 1 }));
ok('futures are not', !isOptionTrade({ multiplier: 10, margined: true }));
// "If it does not make it onto the portfolio card it does not belong on the closed card" is only
// true if ONE function decides for both.
ok('cash is off both', !showsOnCard({ symbol: 'SGOV' }));
ok('options are off both', !showsOnCard({ symbol: 'SPCX', tags: ['option'] }));
ok('a share swing is on both', showsOnCard({ symbol: 'METU', multiplier: 1 }));
ok('a futures hold is on both', showsOnCard({ symbol: 'MGC', multiplier: 10, margined: true }));

// ── the closed card is a 90-day window, not the whole record ──
const dated = (symbol, closedOn) => ({ symbol, levels: [],
  derived: { status: 'closed', avgEntry: 10, avgExit: 11, avgCost: 10, realizedPct: 10, firstDate: closedOn, lastDate: closedOn, scaleOuts: [] }, pnl: {} });
const win = buildClosedCard([dated('RECENT', '2026-08-20'), dated('EDGE', '2026-06-01'), dated('OLD', '2026-03-01')], { today: '2026-08-27' });
ok('the recent one is in', win.embeds[0].description.includes('RECENT'));
ok('so is one just inside the window', win.embeds[0].description.includes('EDGE'));
ok('the old one is gone', !win.embeds[0].description.includes('OLD'));
ok('and the title says which view this is', win.embeds[0].title.includes('last 90 days'));
eq('the count is of the window, not the archive', win.embeds[0].title.includes('2 trades'), true);
eq('the window is 90 days', CLOSED_WINDOW_DAYS, 90);
// Exactly on the boundary is still in.
ok('the boundary day is included', buildClosedCard([dated('B', '2026-05-29')], { today: '2026-08-27' }).embeds[0].description.includes('B'));
// A trade whose exit date was never captured is KEPT — the window retires old trades, it does not
// discard ones with missing data.
ok('an undated close is kept', buildClosedCard([{ symbol: 'NODATE', levels: [],
  derived: { status: 'closed', avgEntry: 10, avgExit: 11, avgCost: 10, realizedPct: 10, firstDate: null, lastDate: null, scaleOuts: [] }, pnl: {} }],
  { today: '2026-08-27' }).embeds[0].description.includes('NODATE'));
// Most recently CLOSED first, not most recently opened.
const order = buildClosedCard([
  { ...dated('OPENED_FIRST', '2026-08-25'), derived: { status: 'closed', avgEntry: 10, avgExit: 11, avgCost: 10, realizedPct: 10, firstDate: '2026-06-01', lastDate: '2026-08-25', scaleOuts: [] } },
  { ...dated('CLOSED_LAST', '2026-08-26') },
], { today: '2026-08-27' }).embeds[0].description.split('\n');
eq('sorted by exit date', order[0].includes('CLOSED_LAST'), true);

// ── A STOP ABOVE ENTRY IS A FLOOR, NOT A RISK ───────────────────────────────
// The ASTX line from the 2026-08-27 card, which read "SL 10.50 (-1%)" while the stop sat 14% above
// the average. Every number below is from that card.
{
  eq('a stop above entry reports what it books', lockedPct(10.50, 9.20), 14.1);
  eq('an ordinary stop reports nothing', lockedPct(32.25, 35.40), null);
  eq('a stop exactly at entry is not a floor', lockedPct(9.20, 9.20), null);
  eq('nor a hair below it', lockedPct(9.19, 9.20), null);
  ok('a hair above it is', lockedPct(9.21, 9.20) > 0);
  eq('no entry, no answer', lockedPct(10.50, null), null);
  eq('no stop, no answer', lockedPct(null, 9.20), null);
  eq('a zero entry cannot divide', lockedPct(10.50, 0), null);

  const astx = publicView({
    symbol: 'ASTX', price: 10.62, pnl: { unrealizedPct: 15.43 },
    derived: { avgCost: 9.20, firstDate: '2026-08-26', status: 'open' },
    levels: [{ kind: 'stop', at: 10.50 }, { kind: 'sell', at: 12.10 }],
  }, { today: '2026-08-27' });
  eq('the view carries the floor', astx.stop.locked, 14.1);
  eq('and still carries the distance from here', astx.stop.dist, -1.1);
  eq('R stays null - there is no risk unit to divide by', astx.r, null);

  const line = tradeLine(astx);
  ok('the line says what triggering the stop books', line.includes('+14% locked'));
  ok('and keeps the room left before it triggers', line.includes('SL 10.50 (-1%)'));
  ok('room first, then outcome', line.indexOf('(-1%)') < line.indexOf('locked'));

  const iren = publicView({
    symbol: 'IREN', price: 37.49, pnl: { unrealizedPct: 5.90 },
    derived: { avgCost: 35.40, firstDate: '2026-08-26', status: 'open' },
    levels: [{ kind: 'stop', at: 32.25 }],
  }, { today: '2026-08-27' });
  eq('a normal position carries no floor', iren.stop.locked, null);
  ok('and its line is unchanged', !tradeLine(iren).includes('locked'));
  eq('R still works where a risk unit exists', iren.r, 0.7);

  ok('the floor survives compact detail', tradeLine(astx, 'compact').includes('locked'));
}

// ── A DISTANCE THAT ROUNDS TO ZERO IS NOT ZERO ──────────────────────────────
{
  const rklb = publicView({
    symbol: 'RKLB', price: 62.58, pnl: { unrealizedPct: -2.98 },
    derived: { avgCost: 64.50, firstDate: '2026-08-26', status: 'open' },
    levels: [{ kind: 'stop', at: 62.45 }],
  }, { today: '2026-08-27' });
  const line = tradeLine(rklb);
  ok('a sub-1% distance keeps a digit', line.includes('(-0.2%)'));
  ok('and no longer reads as zero', !line.includes('(-0%)'));

  const iren = publicView({
    symbol: 'IREN', price: 37.49, pnl: { unrealizedPct: 5.9 },
    derived: { avgCost: 35.40, firstDate: '2026-08-26', status: 'open' },
    levels: [{ kind: 'stop', at: 32.25 }],
  }, { today: '2026-08-27' });
  ok('an ordinary distance stays whole', tradeLine(iren).includes('(-14%)'));

  const tight = publicView({
    symbol: 'X', price: 100, pnl: { unrealizedPct: 0 },
    derived: { avgCost: 100, firstDate: '2026-08-26', status: 'open' },
    levels: [{ kind: 'stop', at: 99.998 }],
  }, { today: '2026-08-27' });
  ok('a truly negligible distance is allowed to read as zero', /\(-?0%\)/.test(tradeLine(tight)));
}

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
