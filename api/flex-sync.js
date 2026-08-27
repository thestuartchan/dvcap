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

import { kvGetJson, kvSetJson, kvConfigured, CONSOLE_KEY } from '../lib/kv.js';
import { derivePosition } from '../lib/positions.js';
import { fetchStatement, reconcile, summarise, flexEnv, flexConfigured, isoDate } from '../lib/flex.js';
import { post, webhookFromEnv } from '../lib/discord.js';
import { refresh } from './tradecard.js';

// The same optional secret the card endpoint uses, so the scheduler carries one key rather than
// two. Unset leaves both open, which is the state the project starts in.
function authorised(req) {
  const want = (process.env.TRADECARD_SECRET || '').trim();
  if (!want) return true;
  const got = String(req.query?.key ?? req.headers['x-tradecard-key'] ?? '').trim();
  return got.length === want.length && got === want;
}

export async function sync(origin, { apply = false } = {}) {
  if (!flexConfigured()) return { ok: false, error: 'IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID not set in the environment' };
  if (!kvConfigured()) return { ok: false, error: 'Redis not configured — there is nowhere to read the console from' };

  const { token, queryId } = flexEnv();
  const got = await fetchStatement({ token, queryId });
  if (!got.ok) return { ok: false, error: got.error };

  const stored = await kvGetJson(CONSOLE_KEY);
  const rows = Array.isArray(stored?.rows) ? stored.rows : [];
  const withDerived = rows.map(r => ({ ...r, derived: derivePosition(r.fills || [], { multiplier: r.multiplier }) }));
  const open = withDerived.filter(r => r.derived.status !== 'closed');

  const asOf = isoDate(got.statement.toDate);
  const rec = reconcile(open, got.statement.positions, { asOf });
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
  if (!apply || !rec.adds.length) return result;

  // Append only. An id collision would overwrite an existing row, so a clash is skipped and said.
  const have = new Set(rows.map(r => r.id));
  const fresh = rec.adds.filter(r => !have.has(r.id));
  result.skipped = rec.adds.length - fresh.length;
  if (!fresh.length) return result;

  const next = { ...stored, rows: [...rows, ...fresh], settings: stored?.settings || {}, updatedAt: new Date().toISOString() };
  const wrote = await kvSetJson(CONSOLE_KEY, next);
  if (!wrote) return { ...result, ok: false, error: 'Redis write failed — nothing was changed' };
  result.applied = true;
  result.added = fresh.map(r => r.id);

  // The card is a notification about the console, so it follows the write rather than replacing it:
  // a failed refresh does not undo a good save.
  try { result.card = await refresh(origin); } catch (e) { result.card = { error: String(e?.message || e) }; }
  const hook = webhookFromEnv();
  if (hook) await post(hook, { content: `🧾 IBKR statement ${asOf || ''} — ${summarise(rec)}`.trim(), allowed_mentions: { parse: [] } });
  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!authorised(req)) { res.status(401).json({ error: 'unauthorised' }); return; }
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const origin = `${proto}://${req.headers.host}`;
  const apply = String(req.query?.apply ?? '') === '1';
  try {
    res.status(200).json(await sync(origin, { apply }));
  } catch (e) {
    console.error('flex-sync', e);
    res.status(200).json({ ok: false, error: String(e?.message || e) });   // never fail the cron
  }
}
