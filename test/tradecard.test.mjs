// Regression tests for lib/tradecard.js and lib/discord.js.
//
// The privacy tests below are the point of the file. They do not check that the current code
// happens to omit a private figure — they check that no private figure can reach a payload, by
// building rows whose private values are distinctive digit strings and asserting those strings
// appear nowhere in the serialised output. A future edit that adds "· 600 @ 18.06" to a line fails
// here rather than on a Discord server.
import { publicView, buildCard, buildAlert, diffRows, tradeLine, rMultiple, daysHeld, PUBLIC_FIELDS } from '../lib/tradecard.js';
import { isWebhookUrl, alertTtlMin, mentionFromEnv, webhookFromEnv } from '../lib/discord.js';
let pass=0,fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};
const ok=(n,c)=>eq(n,!!c,true);

// A row whose every private number is a string that could not occur by chance.
// The four forbidden quantities: size, absolute P&L, market value, share of book. Entry price is
// deliberately NOT among them — it is a realistic 18.06 here, because R is (price − entry) /
// (entry − stop) and therefore implies the entry to anyone who knows the stop. That is accepted:
// an entry price is what a trade-idea channel is FOR, it is not a size and it does not reach the
// balance. The four below are the ones that do, and none may appear anywhere in a payload.
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
scan('card', buildCard([row], { stats: { winRate: 63, avgPct: 3.15, counted: 16 } }));
scan('open alert', buildAlert({ kind: 'opened', row }, { mentionId: '12345' }));
scan('close alert', buildAlert({ kind: 'closed', row }));
scan('level alert', buildAlert({ kind: 'level', row, level: 'buy zone hit at 16.85' }));

// The card carries ratios only — a win rate and an average return, never a total.
const card = buildCard([row], { stats: { winRate: 63, avgPct: 3.15, counted: 16 } });
ok('footer carries the win rate', card.embeds[0].footer.text.includes('63% win'));
ok('footer carries no currency symbol', !/[$€£¥]/.test(JSON.stringify(card)));

// ── R multiple ──
eq('R from entry, stop and price', rMultiple({ entry: 18.06, stop: 16.5, price: 20.41 }), 1.5);
eq('a losing trade is negative R', rMultiple({ entry: 18.06, stop: 16.5, price: 17.28 }), -0.5);
eq('no stop, no R', rMultiple({ entry: 18.06, stop: null, price: 20.41 }), null);
eq('a stop above entry is not a risk unit', rMultiple({ entry: 18.06, stop: 19, price: 20.41 }), null);
ok('R is preferred when there is a stop', tradeLine(v).includes('+1.5R'));
ok('and % when there is not', tradeLine(publicView({ ...row, levels: [] })).includes('12.99%'));

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
ok('an empty book still renders', empty.embeds[0].fields.length === 1);
ok('and says so', empty.embeds[0].fields[0].name === 'Nothing open');

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

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
