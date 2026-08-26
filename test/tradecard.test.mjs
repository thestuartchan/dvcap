// Regression tests for lib/tradecard.js and lib/discord.js.
//
// The privacy tests below are the point of the file. They do not check that the current code
// happens to omit a private figure — they check that no private figure can reach a payload, by
// building rows whose private values are distinctive digit strings and asserting those strings
// appear nowhere in the serialised output. A future edit that adds "· 600 @ 18.06" to a line fails
// here rather than on a Discord server.
import { publicView, buildCard, buildAlert, diffRows, tradeLine, distTo, daysHeld, isCashLeg, fitLines, DESC_BUDGET, PUBLIC_FIELDS } from '../lib/tradecard.js';
import { isWebhookUrl, alertTtlMin, mentionFromEnv, webhookFromEnv } from '../lib/discord.js';
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
  pnl: { total: SECRET.unrealized, totalPct: 12.99, unrealized: SECRET.unrealized, marketValue: SECRET.mv },
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
ok('targets carry their distance', tradeLine(publicView({ ...row, levels: [...row.levels, { kind: 'sell', at: 25.25 }] })).includes('TP 25.25 (+24%)'));

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
for (const n of [10, 25, 45, 61])
  ok(`${n} maximal positions still fit the budget`, fitLines(mk(n)).body.length <= DESC_BUDGET);
eq(`nothing is dropped at 61`, fitLines(mk(61)).dropped, 0);
// Past the point where even minimal fits, the list is cut — but never silently.
const over = fitLines(mk(120));
ok('past the ceiling it cuts', over.dropped > 0);
ok('and says how many are missing', /and \d+ more not shown/.test(over.body));
ok('while still respecting the budget', over.body.length <= DESC_BUDGET);
ok('a real card stays inside the description limit', buildCard(mk(120).map(v => ({
  symbol: v.symbol, price: v.price, derived: { status: 'open', avgCost: v.avg, firstDate: '2026-06-10', scaleOuts: [] }, pnl: { totalPct: v.pct },
}))).embeds[0].description.length <= 4096);

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
