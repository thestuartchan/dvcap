// api/flex-sync.js — reconcile the trade console against IBKR's own statement, once a day.
//
// THE PROBLEM THIS SOLVES. The console is hand-maintained, and the failure mode is not a wrong
// number — it is a position that is simply not there. Six were missing when the account was last
// checked against the broker, two of them QQQ calls down five figures, invisible for weeks because
// nothing ever compared the two lists. A number that is wrong gets noticed; a row that does not
// exist does not.
//
// WHAT IT DOES, and the line it will not cross:
//   • ADDS shares and futures the statement has and the console lacks, tagged `new` + `flex`.
//   • REPORTS everything else — options and cash legs (deliberately outside the card's scope, so
//     auto-adding them would re-create a row the card then hides, every day), quantity and cost
//     disagreements, and rows open here that the broker does not have.
//   • NEVER deletes, and never edits an existing row. "IBKR does not have this" is ambiguous — it
//     may be closed, held elsewhere, or outside the saved query's scope — and a sync that resolves
//     that ambiguity by deleting is one bad report away from erasing the book.
//
// DRY BY DEFAULT. A GET reports; ?apply=1 writes. The cron passes apply=1; a human poking the URL
// gets an answer, not a mutation.
//
// The statement's own numbers are in the RESPONSE, which goes to the caller. The only thing that
// reaches Discord is lib/flex.js's summary, which carries symbols and counts and no sizes.

import { kvGetJson, kvSetJson, kvConfigured, CONSOLE_KEY, FLEX_NOTE_KEY } from '../lib/kv.js';

// What the channel was last told. Only the SIGNATURE, so this can never become a second copy of
// the book.
const SEEN_KEY = 'dvcap:flex:seen:v1';
import { derivePosition } from '../lib/positions.js';
import { parseTrades, tradeSections, planTrades, applyPlan, verify, planTouches, summariseTrades } from '../lib/flexTrades.js';
import { fetchStatement, reconcile, summarise, summariseActionable, actionable, signatureOf, planAck, flexEnv, flexConfigured, isoDate } from '../lib/flex.js';
import { post, webhookFromEnv } from '../lib/discord.js';
import { refresh } from './tradecard.js';
import { authorised as gate, refusalReason } from '../lib/apiauth.js';

// The same optional secret the card endpoint uses, so the scheduler carries one key rather than
// two. Unset leaves both open, which is the state the project starts in.
// Same fail-open shape as api/tradecard.js, and the same consequence: with TRADECARD_SECRET unset
// this returned the IBKR account, its positions and their summary to anyone who asked. Closed.
const authorised = (req) => gate(req);

async function tell(rec, asOf, tradePlan = null) {
  // A recorded trade is a real event and is announced whether or not anything else is wrong — but
  // it carries SYMBOLS and counts only. Quantities and prices never leave the console.
  const traded = tradePlan ? summariseTrades(tradePlan, { forChannel: true }) : '';
  const sig = [signatureOf(rec), traded].filter(Boolean).join(' || ');
  const seen = await kvGetJson(SEEN_KEY);
  if (seen?.sig === sig) return { posted: false, reason: 'unchanged since the last run' };
  await kvSetJson(SEEN_KEY, { sig, at: new Date().toISOString() });
  const line = [traded, summariseActionable(rec)].filter(Boolean).join(' · ');
  if (!line) return { posted: false, reason: 'nothing needs acting on' };
  const hook = webhookFromEnv();
  if (!hook) return { posted: false, reason: 'no webhook configured' };
  await post(hook, { content: `🧾 IBKR statement ${asOf || ''} — ${line}`.trim(), allowed_mentions: { parse: [] } });
  return { posted: true };
}

export async function sync(origin, { apply = false, ack = [], trades = false, from: from0 = null, peek = false } = {}) {
  if (!flexConfigured()) return { ok: false, error: 'IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID not set in the environment' };
  if (!kvConfigured()) return { ok: false, error: 'Redis not configured — there is nowhere to read the console from' };

  const { token, queryId } = flexEnv();
  const got = await fetchStatement({ token, queryId });
  if (!got.ok) return { ok: false, error: got.error };

  const stored = await kvGetJson(CONSOLE_KEY);
  const rows = Array.isArray(stored?.rows) ? stored.rows : [];
  // NOTE: no applyRolls. A rolled position's entry is back-adjusted for the card; the broker reports
  // the contract, not the trade, so reconciling against the adjusted figure would disagree with
  // every statement for ever. And CLOSED rows are passed in as well as open ones — the statement is
  // a report about a past day, and reconcile needs to know what the console has finished since.
  const withDerived = rows.map(r => ({ ...r, derived: derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }) }));

  const asOf = isoDate(got.statement.toDate);
  // The deriver goes in so reconcile can ask what a row looked like on the statement's own day —
  // the same function that produced `derived` above, so the two can never drift apart.
  const deriveRow = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
  const rec = reconcile(withDerived, got.statement.positions, { asOf, derive: deriveRow });
  const result = {
    ok: true,
    account: got.statement.accountId,
    asOf,
    applied: false,
    positions: got.statement.positions.length,
    summary: summarise(rec),
    agree: rec.agree,
    differs: rec.differs,
    ambiguous: rec.ambiguous,
    report: rec.report,
    // The rows it WOULD add, always — so a dry run shows exactly what an apply would do.
    adds: rec.adds,
  };
  // ── TRADES ────────────────────────────────────────────────────────────────
  // The Open Positions section cannot say whether an exit was recorded — a sold position is simply
  // absent, which looks identical to one the console never knew about. The Trades section can.
  //
  // Nothing below writes on the strength of the trade list alone: the plan is applied to a COPY,
  // re-derived, and held against the Open Positions section of the same statement. Only a batch
  // that reconciles is committed, and a batch that does not is discarded whole.
  let tradePlan = null, gate = null, tradeRows = null;
  if (trades) {
    const parsed = parseTrades(got.xml);
    // The watermark is set once. Passing ?from=YYYY-MM-DD writes it into the console's settings so
    // it survives, rather than being a flag that has to be remembered on every call.
    const from = from0 || String(stored?.settings?.flexTradesFrom || '').slice(0, 10) || null;
    result.trades = { inStatement: parsed.length, from };
    if (!parsed.length) {
      // Say what the document DID contain, so "nothing came back" is diagnosable without guessing.
      result.trades.sections = tradeSections(got.xml);
      result.trades.note = 'no trades in the statement — check the Flex query has the Trades section with Orders ticked, and that its period covers the days you traded';
    } else if (!from) {
      // Refusing to guess the watermark. Ingesting a 30-day window against bulk-averaged history
      // would fail adoption on nearly every trade and reject the batch anyway; worse, it might not.
      result.trades.note = 'settings.flexTradesFrom is unset, so there is no date from which the broker is the record — set it in the console (or pass ?from=YYYY-MM-DD once) before trades are ingested';
    } else {
      // ?peek=1 returns the in-scope trades as parsed. Three times now a shape assumption has been
      // wrong in a way that only real data could show, and each cost a round trip to find.
      if (peek) result.trades.sample = parsed.filter(t => t.date >= from).slice(0, 25);
      tradePlan = planTrades(withDerived, parsed, { from, positions: got.statement.positions });
      const after = applyPlan(rows, tradePlan);
      gate = verify(after, got.statement.positions, {
        derive: deriveRow,
        roots: planTouches(tradePlan),
        asOf,
      });
      result.trades = { ...result.trades, plan: tradePlan, verified: gate.ok, problems: gate.problems, summary: summariseTrades(tradePlan) };
      const changes = tradePlan.adopt.length + tradePlan.apply.length + tradePlan.creates.length;
      if (changes && gate.ok) tradeRows = after;
      else if (changes) result.trades.discarded = 'the batch did not reconcile against the statement’s own position list, so none of it was applied';
    }
  }

  // An ack is an explicit instruction naming the row and, implicitly, the number — so it writes on
  // its own rather than waiting for apply=1, which is about adding rows the request did not name.
  const plan = planAck(rec, ack);
  if (plan.ack.length || plan.refused.length) { result.acknowledged = plan.ack; result.refused = plan.refused; }

  // Append only. An id collision would overwrite an existing row, so a clash is skipped and said.
  const have = new Set(rows.map(r => r.id));
  const fresh = apply ? rec.adds.filter(r => !have.has(r.id)) : [];
  if (apply) result.skipped = rec.adds.length - fresh.length;
  // WHAT THE CONSOLE SHOWS. The channel gets a message; the console gets the same thing as state,
  // so opening the tab answers "did the sync do anything" without going to Discord for it. Written
  // on scheduled runs only — a dry run someone typed into a browser is not news to anybody.
  const noteOf = () => ({
    at: new Date().toISOString(),
    asOf,
    applied: !!(fresh.length || plan.ack.length || (apply && tradeRows)),
    added: fresh.map(r => r.symbol),
    recorded: tradePlan ? tradePlan.apply.length : 0,
    opened: tradePlan ? tradePlan.creates.map(c => c.symbol) : [],
    discarded: result.trades?.discarded || null,
    // Everything that a human has to decide, flattened into one list the banner can render.
    needsYou: [
      ...rec.differs.map(d => ({ what: 'disagrees with the statement', root: d.root, id: d.id })),
      ...rec.ambiguous.map(a => ({ what: 'ambiguous — two rows share this symbol', root: a.root })),
      ...rec.report.filter(r => r.kind === 'missing-at-broker').map(r => ({ what: 'open here, not at the broker', root: r.root, id: r.id })),
      ...((tradePlan?.report) || []).map(r => ({ what: r.kind.replace(/-/g, ' '), root: r.root })),
    ].slice(0, 12),
    summary: [tradePlan ? summariseTrades(tradePlan) : '', summariseActionable(rec)].filter(Boolean).join(' · ') || 'everything reconciles',
  });

  // TELL SOMEONE. A reconciliation nobody reads is a reconciliation that does not exist, and until
  // now only an ADD reached the channel — a quantity that disagreed, or a position open here and
  // gone at the broker, sat in a JSON response nobody had a reason to open. Scheduled runs now
  // announce anything actionable, once, and again only if what is wrong changes.
  if (apply) result.told = await tell(rec, asOf, apply && tradeRows ? tradePlan : null);
  const writingTrades = apply && !!tradeRows;
  if (!fresh.length && !plan.ack.length && !writingTrades && !from0) {
    if (apply) await kvSetJson(FLEX_NOTE_KEY, noteOf());
    return result;
  }

  const acked = new Map(plan.ack.map(a => [a.id, a.to]));
  const base = writingTrades ? tradeRows : rows;
  const merged = base.map(r => acked.has(r.id) ? { ...r, costBasisAck: acked.get(r.id) } : r);
  const settings = from0 ? { ...(stored?.settings || {}), flexTradesFrom: from0 } : (stored?.settings || {});
  const next = { ...stored, rows: [...merged, ...fresh], settings, updatedAt: new Date().toISOString() };
  const wrote = await kvSetJson(CONSOLE_KEY, next);
  if (!wrote) return { ...result, ok: false, error: 'Redis write failed — nothing was changed' };
  // `applied` means ROWS CHANGED. Writing only the watermark is a settings change and used to set
  // this true, which read as "the trades were ingested" on a run that ingested nothing.
  result.applied = !!(fresh.length || plan.ack.length || writingTrades);
  if (from0) result.watermarkSet = from0;
  if (fresh.length) result.added = fresh.map(r => r.id);
  if (writingTrades) result.trades.applied = true;

  // The card is a notification about the console, so it follows the write rather than replacing it:
  // a failed refresh does not undo a good save.
  try { result.card = await refresh(origin); } catch (e) { result.card = { error: String(e?.message || e) }; }
  if (apply) await kvSetJson(FLEX_NOTE_KEY, noteOf());
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!authorised(req)) { res.status(401).json({ error: 'unauthorised', why: refusalReason(req) }); return; }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  const apply = String(req.query?.apply ?? '') === '1';
  // ?ack=ARM-open,FOO-open — record the broker's cost basis on rows where the two accountings
  // legitimately differ, so the daily run stops reporting a difference that is expected.
  const ack = String(req.query?.ack ?? '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 20);
  // ?trades=1 — read the Trades section too. Off by default while it proves itself; a dry run
  // shows the whole plan and the verification result without writing anything.
  const trades = String(req.query?.trades ?? '') === '1';
  const peek = String(req.query?.peek ?? '') === '1';
  const fromQ = String(req.query?.from ?? '').trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromQ) ? fromQ : null;
  try {
    res.status(200).json(await sync(origin, { apply, ack, trades, from, peek }));
  } catch (e) {
    console.error('flex-sync', e);
    res.status(200).json({ ok: false, error: String(e?.message || e) });   // never fail the cron
  }
}
