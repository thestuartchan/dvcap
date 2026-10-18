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

import { kvGetJson, kvSetJson, kvSetJsonEx, kvConfigured, CONSOLE_KEY, FLEX_NOTE_KEY, CASHBOOK_KEY, OPTION_MARKS_KEY } from '../lib/kv.js';
import { nextRev } from '../lib/consoleRev.js';

// What the channel was last told. Only the SIGNATURE, so this can never become a second copy of
// the book.
const SEEN_KEY = 'dvcap:flex:seen:v1';
// The statement IBKR is still building, so the next call (the workflow's retry, or Re-check) polls
// it instead of asking for a new one and restarting the wait (lib/flex.js fetchStatement). Only the
// reference and the URL — never the token, never in a response — and it expires on its own: IBKR
// keeps a reference for minutes, not hours.
const PENDING_KEY = 'dvcap:flex:pending:v1';
const PENDING_TTL_S = 15 * 60;
import { derivePosition, splitIntoTrades } from '../lib/positions.js';
import { parseTrades, tradeSections, planTrades, applyPlan, verify, planTouches, summariseTrades, unrecordedTrades, dropCreatedAdds } from '../lib/flexTrades.js';
import { fetchStatement, reconcile, summarise, summariseActionable, signatureOf, planAck, reconcilingFill, flexEnv, flexConfigured, isoDate, optionFindings, addLabel, cashBookOf, optionMarksOf } from '../lib/flex.js';
import { post, webhookFromEnv } from '../lib/discord.js';
import { refresh } from './tradecard.js';
import { authorised as gate, refusalReason } from '../lib/apiauth.js';
import { fetchCboeGreeks, fetchCboeIndex } from '../lib/cboe.js';
import { parseOptionSymbol, contractKey, TREND_WINDOW } from '../lib/bookExposure.js';
import { appendRun, SIZER_RUNS_KEY, MAX_RUNS } from '../lib/sizer.js';
import { catalystLookup } from '../lib/catalystFeed.js';
import { runJournal } from '../lib/journalStore.js';
import { journalLine, orderUnits } from '../lib/journalInbox.js';
import { parseTradeConfirms, tcSections } from '../lib/flexTrades.js';
import { adoptProvisional, tcQueryId, TC_QUERY_ENV, TC_WAITS_MS, SYNC_NOW_MIN_INTERVAL_S, skipOnSameDay, syncNowLine, recordLag, lagText } from '../lib/sameDayFills.js';
import { hasSessionCookie } from '../lib/apiauth.js';
import { readJournal } from '../lib/journalStore.js';
import { kvSetNxEx } from '../lib/kv.js';
import HOLIDAYS from '../data/holidays.json' with { type: 'json' };

// The same optional secret the card endpoint uses, so the scheduler carries one key rather than
// two. Unset leaves both open, which is the state the project starts in.
// Same fail-open shape as api/tradecard.js, and the same consequence: with TRADECARD_SECRET unset
// this returned the IBKR account, its positions and their summary to anyone who asked. Closed.
const authorised = (req) => gate(req);   // async — the caller must await it

async function tell(rec, asOf, tradePlan = null, journal = null) {
  // A recorded trade is a real event and is announced whether or not anything else is wrong — but
  // it carries SYMBOLS and counts only. Quantities and prices never leave the console.
  const traded = tradePlan ? summariseTrades(tradePlan, { forChannel: true }) : '';
  // The journal's line is built from counts and symbols alone (lib/journalInbox.js journalLine):
  // never a note's rationale, levels, quantity or price.
  const journaled = journal?.applied ? journalLine(journal) : '';
  const sig = [signatureOf(rec), traded, journaled].filter(Boolean).join(' || ');
  const seen = await kvGetJson(SEEN_KEY);
  if (seen?.sig === sig) return { posted: false, reason: 'unchanged since the last run' };
  await kvSetJson(SEEN_KEY, { sig, at: new Date().toISOString() });
  const line = [traded, journaled, summariseActionable(rec, { forChannel: true })].filter(Boolean).join(' · ');
  if (!line) return { posted: false, reason: 'nothing needs acting on' };
  const hook = webhookFromEnv();
  if (!hook) return { posted: false, reason: 'no webhook configured' };
  await post(hook, { content: `🧾 IBKR statement ${asOf || ''} — ${line}`.trim(), allowed_mentions: { parse: [] } });
  return { posted: true };
}

export async function sync(origin, { apply = false, ack = [], trades = false, from: from0 = null, peek = false, unrecorded = false, since = null } = {}) {
  if (!flexConfigured()) return { ok: false, error: 'IBKR_FLEX_TOKEN / IBKR_FLEX_QUERY_ID not set in the environment' };
  if (!kvConfigured()) return { ok: false, error: 'Redis not configured — there is nowhere to read the console from' };

  const { token, queryId } = flexEnv();
  let pending = null;
  try { pending = await kvGetJson(PENDING_KEY); } catch { /* start fresh */ }
  const got = await fetchStatement({ token, queryId, pending });
  // Kept while IBKR is still building it; cleared once a statement arrives or IBKR has forgotten it.
  try {
    if (got.pending) await kvSetJsonEx(PENDING_KEY, got.pending, PENDING_TTL_S);
    else if (pending) await kvSetJsonEx(PENDING_KEY, null, 1);
  } catch { /* the next call simply starts fresh */ }
  // `retryable` tells the workflow (and the console's Re-check) to try again in a minute rather than
  // give up for the day. `pending` itself never leaves the server.
  if (!got.ok) return { ok: false, error: got.error, retryable: !!got.retryable };

  const stored = await kvGetJson(CONSOLE_KEY);
  const rows = Array.isArray(stored?.rows) ? stored.rows : [];
  // NOTE: no applyRolls. A rolled position's entry is back-adjusted for the card; the broker reports
  // the contract, not the trade, so reconciling against the adjusted figure would disagree with
  // every statement for ever. And CLOSED rows are passed in as well as open ones — the statement is
  // a report about a past day, and reconcile needs to know what the console has finished since.
  const withDerived = rows.map(r => ({ ...r, derived: derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }) }));

  const asOf = isoDate(got.statement.toDate);
  // ── SAME-DAY FILLS, TAKEN OVER BY THE STATEMENT ───────────────────────────
  // A fill confirmed from the same-day report (?tc=1) is provisional. Here the statement adopts it
  // by IBKR's order id — clearing the mark, correcting quantity or price to the statement's — so
  // the planner below sees it as already recorded and never applies it a second time. The adoption
  // is part of the batch: written only with it, and a share or futures root it CORRECTED is held to
  // the same Open Positions check as everything the batch changes. A provisional fill the statement
  // does not contain is flagged, never deleted.
  const adoption = adoptProvisional(rows, orderUnits(parseTrades(got.xml)), { asOf });
  const adoptedDerived = adoption.changed
    ? adoption.rows.map(r => ({ ...r, derived: derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side }) }))
    : withDerived;
  // THE CASH BOOK — values only, to a private key the console reads on its signed-in load. Never in
  // this response (the workflow log is public) and never rows.
  if (apply) { try { await kvSetJson(CASHBOOK_KEY, { ...cashBookOf(got.statement), fetchedAt: new Date().toISOString() }); } catch { /* the console keeps the last one */ } }
  // IBKR's close mark per option contract — the price of record for anything CBOE does not list
  // (an option on a future). Contract → mark only, private key, never in this response.
  if (apply) { try { await kvSetJson(OPTION_MARKS_KEY, { ...optionMarksOf(got.statement), fetchedAt: new Date().toISOString() }); } catch { /* the card falls back to no mark */ } }
  // The deriver goes in so reconcile can ask what a row looked like on the statement's own day —
  // the same function that produced `derived` above, so the two can never drift apart.
  const deriveRow = (r) => derivePosition(r.fills || [], { multiplier: r.multiplier, side: r.side });
  // ── THE READ-ONLY BRANCH ──────────────────────────────────────────────────
  // Returns before any of the reconciliation, planning or writing below. The console is a swing
  // book by design and everything else — scalps, options, cash legs — is filtered out on the way
  // in and counted rather than kept. This answers what all of it did, and changes nothing.
  if (unrecorded) {
    const parsed = parseTrades(got.xml);
    const out = unrecordedTrades(withDerived, parsed, { since, splitIntoTrades, derivePosition });
    return { ok: true, mode: 'unrecorded', readOnly: true, account: got.statement.accountId, asOf,
      sections: parsed.length ? undefined : tradeSections(got.xml), ...out };
  }

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
    // Rows quoted off a different listing from the one IBKR holds (lib/listings.js). Symbols only.
    listings: rec.listings.map(l => ({ id: l.id, root: l.root, quoteAs: l.quoteAs, current: l.current, explicit: l.explicit })),
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
      tradePlan = planTrades(adoptedDerived, parsed, { from, positions: got.statement.positions });
      const after = applyPlan(adoption.rows, tradePlan);
      gate = verify(after, got.statement.positions, {
        derive: deriveRow,
        roots: [...new Set([...planTouches(tradePlan), ...adoption.roots])],
        asOf,
      });
      result.trades = { ...result.trades, plan: tradePlan, verified: gate.ok, problems: gate.problems, summary: summariseTrades(tradePlan) };
      const changes = tradePlan.adopt.length + tradePlan.apply.length + tradePlan.creates.length + adoption.adopted.length;
      if (changes && gate.ok) tradeRows = after;
      else if (changes) {
        // NAME THE ROOTS. "The batch did not reconcile" sent the reader to every position; the gate
        // knows exactly which ones failed and why, and the banner is where that belongs.
        const who = (gate.problems || []).map(p => `${p.root}${p.console != null ? ` (console ${p.console}${p.consoleSide ? ` ${String(p.consoleSide).toUpperCase()}` : ''}, statement ${p.ibkr != null ? `${p.ibkr}${p.ibkrSide ? ` ${String(p.ibkrSide).toUpperCase()}` : ''}` : 'not held'})` : ''}`);
        // THE WATERMARK, SUGGESTED. A root the statement does not hold, left open by fills the planner
        // put in a row it CREATED, is the batch reaching back over hand-kept history: the fills that
        // built the phantom are dated before the hand entries they should have matched. The day after
        // the latest of them is the earliest watermark that excludes them.
        const failedRoots = new Set((gate.problems || []).map(p => String(p.root).split('|')[0]));
        const createdIds = new Set((tradePlan.creates || []).map(r => r.id));
        const phantomDates = (tradePlan.apply || [])
          .filter(a => createdIds.has(a.rowId) && failedRoots.has(String(a.root)))
          .map(a => a.fill?.date).filter(Boolean).sort();
        let suggest = '';
        if (phantomDates.length) {
          const last = new Date(phantomDates[phantomDates.length - 1] + 'T00:00:00Z'); last.setUTCDate(last.getUTCDate() + 1);
          const day = last.toISOString().slice(0, 10);
          result.trades.suggestedFrom = day;
          suggest = ` — the fills that built it are dated ${phantomDates[0]}${phantomDates.length > 1 ? ` to ${phantomDates[phantomDates.length - 1]}` : ''}, before the hand entries they should have matched; set "IBKR is the record from" to ${day} to take the statement from there`;
        }
        result.trades.discarded = `the batch did not reconcile against the statement’s own position list${who.length ? ` — ${who.join('; ')}` : ''} — so none of it was applied${suggest}`;
      }
    }
  }

  // ── THE JOURNAL INBOX ─────────────────────────────────────────────────────
  // Notes written from chat, matched to the statement's orders (lib/journalInbox.js). After the
  // plan, so a fill the planner adopted from a hand entry counts as journaled; before the channel
  // is told, so the line can say how many drafts are waiting. Drafts only — nothing here touches a
  // console row; Stu confirms each one on the console.
  let journal = null;
  try {
    const parsedAll = parseTrades(got.xml);
    const known = new Set();
    for (const r of adoption.rows) for (const f of (r.fills || [])) if (f.tradeId) known.add(String(f.tradeId));
    for (const a of (tradePlan?.adopt || [])) known.add(String(a.tradeId));
    journal = await runJournal({ trades: parsedAll, known, today: new Date().toISOString().slice(0, 10),
      holidays: HOLIDAYS?.US?.closed || [], apply, asOf });
    result.journal = { ok: journal.ok, applied: !!journal.applied, inbox: journal.inbox ?? null, counts: journal.counts || null, reason: journal.reason || null };
    // Counts only: which fills were adopted, corrected or are missing is the console's to show.
    result.sameDay = { adopted: adoption.adopted.length, corrected: adoption.corrected.length, missing: adoption.missing.length, ambiguous: adoption.ambiguous.length };
  } catch (e) {
    console.error('journal inbox', e?.message || e);
    result.journal = { ok: false, reason: String(e?.message || e) };
  }

  // ── ONE ROW PER POSITION ──────────────────────────────────────────────────
  // The reconciliation above ran against the console before the trade plan existed, so a position
  // the console had never seen is in BOTH rec.adds (flat, at average cost) and tradePlan.creates
  // (opened from its first fill). CRCL, 2026-09-22: two cards. The Trades row wins when the batch
  // is being written; the position add is dropped and named.
  let rec2 = rec;
  if (tradeRows && tradePlan?.creates?.length) {
    const { adds, dropped } = dropCreatedAdds(rec.adds, tradePlan.creates);
    if (dropped.length) {
      rec2 = { ...rec, adds };
      result.adds = adds;
      result.trades.openedNotAdded = dropped.map(r => r.symbol);
    }
  }

  // An ack is an explicit instruction naming the row and, implicitly, the number — so it writes on
  // its own rather than waiting for apply=1, which is about adding rows the request did not name.
  const plan = planAck(rec2, ack);
  if (plan.ack.length || plan.refused.length) { result.acknowledged = plan.ack; result.refused = plan.refused; }

  // Append only. An id collision would overwrite an existing row, so a clash is skipped and said.
  const have = new Set(rows.map(r => r.id));
  const fresh = apply ? rec2.adds.filter(r => !have.has(r.id)) : [];
  if (apply) result.skipped = rec2.adds.length - fresh.length;
  // WHAT THE CONSOLE SHOWS. The channel gets a message; the console gets the same thing as state,
  // so opening the tab answers "did the sync do anything" without going to Discord for it. Written
  // on scheduled runs only — a dry run someone typed into a browser is not news to anybody.
  const noteOf = () => ({
    at: new Date().toISOString(),
    asOf,
    // The broker's NLV and its date, or why there is none (lib/flex.js navOf). This note is read
    // only by the signed-in console, which offers it for Settings › Account equity; it never goes
    // to the channel.
    nav: got.statement.nav || null,
    applied: !!(fresh.length || plan.ack.length || (apply && tradeRows)),
    // Counts for the console's status line (lib/flexStatus.js) — how many of the statement's
    // positions the console agrees with, so a quiet run reads as checked rather than as absent.
    agree: rec.agree.length,
    positions: got.statement.positions.length,
    added: fresh.map(addLabel),
    recorded: tradePlan ? tradePlan.apply.length : 0,
    opened: tradePlan ? tradePlan.creates.map(c => c.symbol) : [],
    discarded: result.trades?.discarded || null,
    suggestedFrom: result.trades?.suggestedFrom || null,
    // Same-day fills the statement took over, and the ones it did not contain — the card flags
    // those by fill id (lib/sameDayFills.js provisionalBadge). Ids and dates, no sizes.
    sameDay: { adopted: adoption.adopted.length, corrected: adoption.corrected.length,
      written: !!(apply && tradeRows && adoption.changed),
      missing: [...adoption.missing, ...adoption.ambiguous.map(a => ({ ...a, asOf, ambiguous: true }))] },
    // Everything that a human has to decide, flattened into one list the banner can render.
    needsYou: [
      // WHICH kind of disagreement, so the banner can offer the one-click acknowledgement only where
      // it applies: a cost-basis gap on a partly exited position is an accounting convention; a
      // quantity gap is a fill the console never recorded and must not be papered over.
      // WITH THE NUMBERS. "Quantity disagrees" sent the reader to the statement to find out by how
      // much; the reconciliation already knows both figures.
      ...rec.differs.map(d => ({
        what: d.qty ? `quantity disagrees — console ${d.qty.console}, statement ${d.qty.ibkr}: a fill is missing here`
                    : `cost basis disagrees — console ${d.avg?.console}, statement ${d.avg?.ibkr}`,
        root: d.root, id: d.id, qty: d.qty || null, avg: d.avg || null,
        qtyDiffers: !!d.qty, costDiffers: !!d.avg, ackable: !d.qty && !!(d.avg && d.avg.ibkr != null),
        // What to record so the console matches the statement — IBKR is the record.
        fix: reconcilingFill(d, { asOf, statementFills: (tradePlan?.apply || []).filter(a => a.root === d.root && (a.rowId === d.id || !rows.some(r => r.id === a.rowId))).map(a => a.fill) }) })),
      // QUOTED OFF THE WRONG LISTING. A London ETF priced as the US fund of the same ticker. The
      // banner offers the one-click "Quote as" — the console sets the field, as a person would; this
      // sync still never edits a row. A quoteSymbol set by hand is named, and the button says so.
      ...rec.listings.map(l => ({ what: `priced off ${l.current}, but IBKR holds it on ${l.listing} — quote it as ${l.quoteAs}${l.explicit ? ' (Quote as was set by hand)' : ''}`,
        root: l.root, id: l.id, quoteAs: l.quoteAs, listing: l.listing })),
      ...rec.ambiguous.map(a => ({ what: 'ambiguous — two rows share this symbol', root: a.root })),
      ...rec.report.filter(r => r.kind === 'missing-at-broker').map(r => ({ what: 'open here, not at the broker', root: r.root, id: r.id })),
      // Option contracts, by contract rather than by underlying (lib/flex.js optionFindings).
      ...optionFindings(rec).map(o => ({ what: o.kind === 'option-differs' ? `${o.contract}: console ${o.qty.console}, statement ${o.qty.ibkr}`
                                            : o.kind === 'option-not-in-console' ? `${o.contract}: held at IBKR, not in the console`
                                            : `${o.contract}: in the console, not at IBKR`, root: o.root, id: o.ids?.[0] || null })),
      ...((tradePlan?.report) || []).map(r => ({ what: r.kind.replace(/-/g, ' '), root: r.root })),
      ...adoption.missing.map(m => ({ what: `same-day fill of ${m.date} is not in this statement — kept, provisional; check it against IBKR`, root: m.symbol, id: m.rowId })),
      ...adoption.ambiguous.map(m => ({ what: `same-day fill of ${m.date} matches more than one statement order — kept, provisional`, root: m.symbol, id: m.rowId })),
    ].slice(0, 12),
    summary: [tradePlan ? summariseTrades(tradePlan) : '', summariseActionable(rec)].filter(Boolean).join(' · ') || 'everything reconciles',
    // The statement's close mark per matched row — prices, no sizes; this note is read only by the
    // signed-in console. It flags a row whose live price is far from the broker's (lib/listings.js
    // markGap): the net under the listing check, for a wrong ticker IBKR's listing cannot name.
    marks: rec.marks,
  });

  // TELL SOMEONE. A reconciliation nobody reads is a reconciliation that does not exist, and until
  // now only an ADD reached the channel — a quantity that disagreed, or a position open here and
  // gone at the broker, sat in a JSON response nobody had a reason to open. Scheduled runs now
  // announce anything actionable, once, and again only if what is wrong changes.
  if (apply) result.told = await tell(rec2, asOf, apply && tradeRows ? tradePlan : null, journal);
  const writingTrades = apply && !!tradeRows;
  if (!fresh.length && !plan.ack.length && !writingTrades && !from0) {
    if (apply) await kvSetJson(FLEX_NOTE_KEY, noteOf());
    return result;
  }

  const acked = new Map(plan.ack.map(a => [a.id, a.to]));
  const base = writingTrades ? tradeRows : rows;
  const merged = base.map(r => acked.has(r.id) ? { ...r, costBasisAck: acked.get(r.id) } : r);
  const settings = from0 ? { ...(stored?.settings || {}), flexTradesFrom: from0 } : (stored?.settings || {});
  // A new revision (lib/consoleRev.js): a browser holding the copy from before this write is
  // refused on its next save rather than putting these fills back the way they were.
  const next = { ...stored, rows: [...merged, ...fresh], settings, updatedAt: new Date().toISOString(), rev: nextRev(stored) };
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

// ── SYNC NOW: TODAY'S FILLS, MINUTES AFTER THEY TRADE ─────────────────────────
// The console's button. Reads the Trade Confirmation query (IBKR_FLEX_TC_QUERY_ID, the same Flex
// token) and runs the journal matcher over it — DRAFTS ONLY. No planner, no auto-add, no console
// row: a same-day report has no Open Positions section to reconcile a write against, so it never
// writes one. What Stu confirms from it is provisional until tomorrow's statement adopts it.
//
// The answer is one line for the console and nothing more. The fills themselves are already in the
// drafts Stu is looking at; nothing here is logged, and the lag record keeps timings and order ids.
const TC_PENDING_KEY = 'dvcap:flex:tc:pending:v1';
const TC_LOCK_KEY = 'dvcap:flex:tc:lock:v1';
export const TC_LAG_KEY = 'dvcap:flex:tc:lag:v1';
const nyToday = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);

export async function syncNow({ now = new Date(), fetchImpl = fetch, sleep } = {}) {
  const token = flexEnv().token, queryId = tcQueryId();
  if (!token || !queryId) return { ok: false, setup: true, line: `Same-day fills are not set up — ${!token ? 'IBKR_FLEX_TOKEN' : TC_QUERY_ENV} is not set in the deployment (the PR describes the IBKR steps).` };
  if (!kvConfigured()) return { ok: false, line: 'Redis is not configured — there is nowhere to put the drafts.' };
  let pending = null;
  try { pending = await kvGetJson(TC_PENDING_KEY); } catch { /* start fresh */ }
  const got = await fetchStatement({ token, queryId, pending, fetchImpl, waits: TC_WAITS_MS, attempts: TC_WAITS_MS.length + 1, ...(sleep ? { sleep } : {}) });
  try {
    if (got.pending) await kvSetJsonEx(TC_PENDING_KEY, got.pending, PENDING_TTL_S);
    else if (pending) await kvSetJsonEx(TC_PENDING_KEY, null, 1);
  } catch { /* the next click starts fresh */ }
  if (!got.ok) {
    return { ok: false, retryable: !!got.retryable,
      line: got.retryable ? 'IBKR is still building the same-day report — click Sync now again in a minute.' : `IBKR's same-day report could not be read: ${got.error}` };
  }
  const trades = parseTradeConfirms(got.xml);
  const at = now.toISOString(), today = nyToday(now);
  const stored = await kvGetJson(CONSOLE_KEY);
  const known = new Set();
  for (const r of (Array.isArray(stored?.rows) ? stored.rows : [])) for (const f of (r.fills || [])) if (f.tradeId) known.add(String(f.tradeId));
  const holidays = HOLIDAYS?.US?.closed || [];
  const journal = await runJournal({ trades, known, today, holidays, apply: true, provisional: true,
    skipUnjournaled: (u) => skipOnSameDay(u, { holidays }) });
  if (!journal.ok) return { ok: false, line: `The fills were read but the drafts could not be written: ${journal.reason}` };
  // How far behind IBKR's report runs, measured on this account rather than assumed.
  let lag = null;
  try {
    const { store, lags } = recordLag((await kvGetJson(TC_LAG_KEY)) || {}, { trades, at });
    await kvSetJson(TC_LAG_KEY, store);
    if (lags.length) lag = lagText(lags.sort((a, b) => b.upToMin - a.upToMin)[0]);
  } catch { /* the lag is a measurement, never a reason to fail the sync */ }
  const line = syncNowLine({ fate: journal.fate, units: journal.units, waitingToday: journal.waitingToday, sections: trades.length ? null : tcSections(got.xml) })
    + (!trades.length && got.xml && !/<TradeConfirms?\b/.test(got.xml) && !/<Order\b/.test(got.xml) ? ' (the report has no Trade Confirmations section — check the query)' : '');
  return { ok: true, at, line, lag, journal: await readJournal() };
}

// ── EXPOSURE: PUBLISHED GREEKS FOR CONTRACTS THE BOOK HOLDS ──────────────────
// GATED, and it lives on this route rather than the public /api/gex for one reason: the LIST of
// contracts asked about is itself a statement about the book. /api/gex is declared public because
// it carries "no account state", and a request that names the exact strikes someone holds would
// quietly stop being true.
//
// Nothing about the position goes out. The caller sends contract identifiers; the response is the
// exchange's published delta, gamma, theta and vega plus the underlying spot. Quantities, cost and
// account value never leave the console — the arithmetic that turns greeks into a book total
// happens in the browser, on the console's own rows.
export const EXPOSURE_TREND_KEY = 'dvcap:exposure:trend:v1';
const MAX_CONTRACTS = 60;

export async function exposureGreeks(spec = '') {
  // "QQQ|2026-10-16|C|730,AVGO|2026-10-16|C|390" — or bare symbols, which parse to the same key.
  const keys = [...new Set(String(spec || '').split(',').map(x => x.trim()).filter(Boolean))].slice(0, MAX_CONTRACTS);
  const parsed = keys.map(k => {
    const parts = k.split('|');
    if (parts.length === 4) {
      const strike = Number(parts[3]);
      if (!Number.isFinite(strike)) return null;
      return { root: parts[0].toUpperCase(), expiry: parts[1],
               type: parts[2].toUpperCase() === 'C' ? 'call' : 'put', strike };
    }
    return parseOptionSymbol(k);
  }).filter(Boolean);
  if (!parsed.length) return { ok: false, reason: 'no parseable contracts requested' };

  // One CBOE request per ROOT, not per contract: the delayed-quote payload is the whole chain.
  const byRoot = new Map();
  for (const c of parsed) {
    if (!byRoot.has(c.root)) byRoot.set(c.root, []);
    byRoot.get(c.root).push(contractKey(c));
  }
  const results = await Promise.all([...byRoot.entries()].map(([root, want]) => fetchCboeGreeks(root, want)));
  const greeks = {}, spots = {}, failed = [];
  let asOf = null;
  for (const r of results) {
    if (!r.ok) { failed.push({ symbol: r.symbol, reason: r.reason }); continue; }
    Object.assign(greeks, r.greeks);
    if (r.spot != null) spots[r.symbol] = r.spot;
    // The OLDEST stamp across the roots wins — a tile cannot be fresher than the stalest leg in it.
    if (r.asOf && (asOf == null || r.asOf < asOf)) asOf = r.asOf;
  }
  const missing = parsed.map(contractKey).filter(k => !greeks[k]);
  return {
    ok: true, greeks, spots, asOf, failed, missing,
    requested: parsed.length, matched: Object.keys(greeks).length,
    source: 'CBOE delayed quotes — published greeks, not modelled',
  };
}

// The 20d series. One row per date, and a re-post on the same date REPLACES rather than appends —
// the panel recomputes on every refresh and a day would otherwise carry twenty readings.
export async function exposureTrend(point = null) {
  if (!kvConfigured()) return { ok: false, reason: 'Redis not configured' };
  const stored = (await kvGetJson(EXPOSURE_TREND_KEY)) || { rows: [] };
  const rows = Array.isArray(stored.rows) ? stored.rows : [];
  if (point && point.date && Number.isFinite(Number(point.ratio))) {
    const keep = rows.filter(r => r?.date !== point.date);
    keep.push({ date: point.date, ratio: +Number(point.ratio).toFixed(2),
                deltaNotional: Number.isFinite(Number(point.deltaNotional)) ? Math.round(Number(point.deltaNotional)) : null,
                at: new Date().toISOString() });
    keep.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const trimmed = keep.slice(-(TREND_WINDOW * 3));
    await kvSetJson(EXPOSURE_TREND_KEY, { rows: trimmed });
    return { ok: true, rows: trimmed, wrote: true };
  }
  return { ok: true, rows, wrote: false };
}

// ── SIZER RUNS ───────────────────────────────────────────────────────────────
// Every time a size is asked for, whether or not the trade is taken. That last part is the point:
// lib/decisions.js begins at a FILL, so a trade that was sized and then declined leaves no trace
// in it — and "sized and not taken" is the outcome the whole exercise exists to produce more of.
// Gated, on the account route, for the same reason the greeks are: this is the book.
export async function sizerRuns(run = null) {
  if (!kvConfigured()) return { ok: false, reason: 'Redis not configured' };
  const stored = (await kvGetJson(SIZER_RUNS_KEY)) || { runs: [] };
  const runs = Array.isArray(stored.runs) ? stored.runs : [];
  if (run && run.at && run.symbol) {
    const next = appendRun(runs, run, MAX_RUNS);
    await kvSetJson(SIZER_RUNS_KEY, { runs: next });
    return { ok: true, runs: next, wrote: true };
  }
  return { ok: true, runs, wrote: false };
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!(await authorised(req))) { res.status(401).json({ error: 'unauthorised', why: refusalReason(req) }); return; }
  // ?tc=1 — Sync now. THE CONSOLE'S OWN SESSION ONLY: not the cron's service key, and never the
  // journal token (which passes nothing anywhere — lib/apiauth.js). About one a minute: a click
  // inside the window is answered with how long to wait, not queued.
  if (String(req.query?.tc ?? '') === '1') {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'POST') { res.status(405).json({ ok: false, line: 'Sync now is a POST from the console.' }); return; }
    if (!(await hasSessionCookie(req))) { res.status(401).json({ ok: false, line: 'Sync now needs the console\'s signed-in session.' }); return; }
    try {
      if (kvConfigured() && !(await kvSetNxEx(TC_LOCK_KEY, Date.now(), SYNC_NOW_MIN_INTERVAL_S))) {
        res.status(429).json({ ok: false, line: 'Sync now ran under a minute ago — try again in a minute.' }); return;
      }
      res.status(200).json(await syncNow());
    } catch (e) {
      console.error('sync-now failed');   // no detail: the error text could carry report content
      res.status(200).json({ ok: false, line: `Sync now failed: ${String(e?.message || e).slice(0, 160)}` });
    }
    return;
  }
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
  // ?unrecorded=1[&since=YYYY-MM-DD] — READ ONLY, and separate from ?from= on purpose: `from`
  // writes the trade watermark into the console's settings, and a diagnostic must not change what
  // the next scheduled run will do.
  const unrecorded = String(req.query?.unrecorded ?? '') === '1';
  const sinceQ = String(req.query?.since ?? '').trim();
  const since = /^\d{4}-\d{2}-\d{2}$/.test(sinceQ) ? sinceQ : null;
  const fromQ = String(req.query?.from ?? '').trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromQ) ? fromQ : null;
  // ?greeks=QQQ|2026-10-16|C|730,... — published greeks for contracts the book holds, plus the
  // 20d exposure series. Read-only unless a point is posted. See exposureGreeks above for why it
  // is here and not on the public chain route.
  // ?sizer=1 — GET reads the recorded runs, POST appends one. See sizerRuns above.
  if (String(req.query?.sizer ?? '') === '1') {
    try {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      const run = req.method === 'POST' && body && typeof body === 'object' ? body.run : null;
      res.status(200).json(await sizerRuns(run || null));
    } catch (e) {
      console.error('sizer-runs', e);
      res.status(200).json({ ok: false, reason: String(e?.message || e) });
    }
    return;
  }
  // ?catalyst=INTC&expiry=2026-10-02&kind=option — the position sizer's catalyst window: the macro
  // calendar inside the contract's life, the name's own earnings date (confirmed/estimated, cached
  // a day), and the read-across names. Information only; lib/catalyst.js. Here because the
  // function count is at the cap, and gated because what is being sized is the book.
  const catQ = String(req.query?.catalyst ?? '').trim().toUpperCase();
  if (catQ) {
    try {
      if (!/^[A-Z0-9.^=-]{1,14}$/.test(catQ)) { res.status(200).json({ ok: false, reason: 'not a symbol' }); return; }
      const expQ = String(req.query?.expiry ?? '').trim();
      const kind = String(req.query?.kind ?? '') === 'stock' ? 'stock' : 'option';
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(await catalystLookup({ symbol: catQ, expiry: /^\d{4}-\d{2}-\d{2}$/.test(expQ) ? expQ : null, kind }));
    } catch (e) {
      console.error('catalyst', e);
      res.status(200).json({ ok: false, reason: String(e?.message || e) });
    }
    return;
  }
  // ?chain=SOFI — the expiries and strikes the root trades, for the entry form's leg table. Read
  // from the same exchange feed as the greeks; carries nothing about the book, and sits on the
  // gated route because the form that asks is the book's.
  const chainQ = String(req.query?.chain ?? '').trim().toUpperCase();
  if (chainQ) {
    try {
      if (!/^[A-Z][A-Z0-9.]{0,7}$/.test(chainQ)) { res.status(200).json({ ok: false, reason: 'not an underlying symbol' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(await fetchCboeIndex(chainQ));
    } catch (e) {
      console.error('chain-index', e);
      res.status(200).json({ ok: false, reason: String(e?.message || e) });
    }
    return;
  }
  const greeksQ = String(req.query?.greeks ?? '').trim();
  if (greeksQ) {
    try {
      // Vercel parses a JSON body into an object; a client that sends a different content-type
      // leaves it a string, and a silently ignored point is a series that never populates.
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
      const point = req.method === 'POST' && body && typeof body === 'object' ? body.point : null;
      const [g, t] = await Promise.all([exposureGreeks(greeksQ), exposureTrend(point || null)]);
      res.status(200).json({ ...g, trend: t.ok ? t.rows : [], trendWrote: !!t.wrote });
    } catch (e) {
      console.error('exposure-greeks', e);
      res.status(200).json({ ok: false, reason: String(e?.message || e) });
    }
    return;
  }
  try {
    res.status(200).json(await sync(origin, { apply, ack, trades, from, peek, unrecorded, since }));
  } catch (e) {
    console.error('flex-sync', e);
    res.status(200).json({ ok: false, error: String(e?.message || e) });   // never fail the cron
  }
}
