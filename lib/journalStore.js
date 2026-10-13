// lib/journalStore.js — the journal inbox's Redis side. lib/journalInbox.js decides; this reads and
// writes. Server only.
//
// THE TOKEN IS SCOPED TO ONE ACTION. JOURNAL_INBOX_TOKEN appends a note and counts the pending
// ones. It is not a service key and does not pass authorised() anywhere (lib/apiauth.js refuses a
// presented value equal to it, so the two stay apart even if someone set them to the same string),
// and the service key is not accepted here. Worst case if it leaks: junk drafts that get dismissed.
// Rotate by changing the variable.

import { kvGetJson, kvSetJson, kvSetJsonEx, kvIncrEx, kvRpush, kvLlen, kvLrange, kvLrem, kvConfigured, CONSOLE_KEY } from './kv.js';
import { INBOX_KEY, PROCESSED_KEY, DRAFTS_KEY, SEEN_KEY, WHY_KEY, RATE_KEY, TOKEN_ENV, TOKEN_HEADER, RATE_PER_HOUR,
         PROCESSED_TTL_DAYS, processInbox, appendProcessed, chooseCandidate, resolveAmend, retryAmends, exactMatch, orderUnits, fillOf, matchNote, amendTargets } from './journalInbox.js';
import { upgradeDrafts } from './sameDayFills.js';

export function journalToken() { return String(process.env[TOKEN_ENV] || '').trim(); }

// Header only — never a query string, which ends up in access logs.
export function journalTokenOk(req) {
  const want = journalToken();
  if (!want) return false;
  const got = String(req?.headers?.[TOKEN_HEADER] ?? '').trim();
  if (!got || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

// 60 an hour, counted per clock hour.
export async function underRateLimit(now = new Date()) {
  const n = await kvIncrEx(`${RATE_KEY}:${now.toISOString().slice(0, 13)}`, 3700);
  return n == null ? true : n <= RATE_PER_HOUR;
}

// Append-only. A note whose id is already pending or processed is refused, so a retried POST is
// idempotent instead of a second draft; the refusal names the id and nothing else.
export async function appendNote(note, { now = new Date().toISOString() } = {}) {
  if (!kvConfigured()) return { ok: false, status: 503, error: 'the inbox store is not configured' };
  const pending = (await kvLrange(INBOX_KEY)) || [];
  const done = (await kvGetJson(PROCESSED_KEY)) || [];
  if (pending.some(x => x.value?.id === note.id) || done.some(x => x?.id === note.id)) {
    return { ok: false, status: 409, error: `a note with id ${note.id} was already received` };
  }
  // AN AMEND IS RESOLVED NOW. It needs no fill, so it does not wait for the daily run: the open
  // console trades are read here, server-side, and the result — a rule change to confirm, a note
  // with no target, or an ambiguity — is written straight to the drafts. The caller still learns
  // only { id, received_at }; nothing about the console leaves this function.
  if (note.kind === 'amend') {
    const rows = ((await kvGetJson(CONSOLE_KEY))?.rows) || [];
    const { item, outcome } = resolveAmend({ ...note, received_at: now }, rows, { now });
    const stored = (await kvGetJson(DRAFTS_KEY)) || { drafts: [] };
    const drafts = (Array.isArray(stored.drafts) ? stored.drafts : []).filter(d => d.id !== item.id);
    const wrote = await kvSetJson(DRAFTS_KEY, { drafts: [...drafts, item], updatedAt: now });
    if (!wrote) return { ok: false, status: 502, error: 'the draft could not be stored — nothing was kept' };
    await recordProcessed([{ id: note.id, outcome, note }]);
    return { ok: true, id: note.id, received_at: now };
  }
  const n = await kvRpush(INBOX_KEY, { ...note, received_at: now });
  if (n == null) return { ok: false, status: 502, error: 'the inbox write failed — nothing was stored' };
  return { ok: true, id: note.id, received_at: now };
}

export async function pendingCount() {
  if (!kvConfigured()) return null;
  return (await kvLlen(INBOX_KEY)) ?? 0;
}

// What the console shows. Served on the session-gated GET only.
// The pending notes themselves are served here too — on the session-gated route, never the token
// one — so a note nobody recognises can be seen and removed before the daily run drafts it.
export async function readJournal() {
  if (!kvConfigured()) return null;
  const [drafts, inbox, why] = await Promise.all([kvGetJson(DRAFTS_KEY), kvLrange(INBOX_KEY), kvGetJson(WHY_KEY)]);
  // Each waiting note carries the last run's reason it did not match, when there was a run.
  const pendingNotes = (inbox || []).map(x => x.value).filter(v => v && v.id).map(v => (why?.[v.id] ? { ...v, why: why[v.id] } : v));
  return { drafts: Array.isArray(drafts?.drafts) ? drafts.drafts : [], pending: pendingNotes.length, pendingNotes };
}

// A WAITING NOTE, TREATED AS A RULE CHANGE on a trade it describes (Stu's click, never inferred).
// The note leaves the inbox and becomes an amend draft on that trade — confirmed or dismissed on the
// console like any other rule change. Only a trade the note's instrument actually matches is accepted.
export async function noteToAmend(id, rowId) {
  if (!kvConfigured()) return { ok: false, error: 'the inbox store is not configured' };
  const inbox = (await kvLrange(INBOX_KEY)) || [];
  const hit = inbox.find(x => x.value?.id === id);
  if (!hit) return { ok: false, error: 'no pending note with that id — the daily run may already have taken it' };
  const rows = ((await kvGetJson(CONSOLE_KEY))?.rows) || [];
  if (!amendTargets(hit.value, rows).some(r => r.id === rowId)) return { ok: false, error: `the note does not describe ${rowId} — nothing changed` };
  const { item } = resolveAmend({ ...hit.value, kind: 'amend', supersedes: rowId }, rows);
  const stored = (await kvGetJson(DRAFTS_KEY)) || { drafts: [] };
  const drafts = (Array.isArray(stored.drafts) ? stored.drafts : []).filter(d => d.id !== item.id);
  const wrote = await kvSetJson(DRAFTS_KEY, { drafts: [...drafts, item], updatedAt: new Date().toISOString() });
  if (!wrote) return { ok: false, error: 'the draft could not be stored — the note was left where it was' };
  await kvLrem(INBOX_KEY, hit.raw);
  await recordProcessed([{ id, outcome: 'converted-to-amend', target: rowId, note: hit.value }]);
  return { ok: true };
}

// Take one pending note out of the inbox by hand — a duplicate, or one that should not be there.
export async function dropNote(id) {
  if (!kvConfigured()) return { ok: false, error: 'the inbox store is not configured' };
  const inbox = (await kvLrange(INBOX_KEY)) || [];
  const hit = inbox.find(x => x.value?.id === id);
  if (!hit) return { ok: false, error: 'no pending note with that id — the daily run may already have taken it' };
  const n = await kvLrem(INBOX_KEY, hit.raw);
  if (!n) return { ok: false, error: 'Redis did not remove it' };
  await recordProcessed([{ id, outcome: 'dropped' }]);
  return { ok: true };
}

const recordProcessed = async (entries) => {
  const list = appendProcessed((await kvGetJson(PROCESSED_KEY)) || [], entries);
  return kvSetJsonEx(PROCESSED_KEY, list, PROCESSED_TTL_DAYS * 86400);
};

// Confirm, dismiss, or choose one candidate of an ambiguous draft. The console has already written
// the row by the time it confirms; this only takes the draft off the list.
// CONFIRM ALL EXACT MATCHES — the console has already written every row; this takes the drafts
// off the list in one write and logs each confirmation exactly as a single confirm is logged, with
// `bulk: true`. Each id is checked again here: anything that is not an exact match (an amend, an
// ambiguous draft, an unjournaled fill, a ✗ or ⚠) is refused and left where it is.
export async function resolveMany({ ids = [] } = {}) {
  if (!kvConfigured()) return { ok: false, error: 'the inbox store is not configured' };
  const stored = (await kvGetJson(DRAFTS_KEY)) || { drafts: [] };
  const drafts = Array.isArray(stored.drafts) ? stored.drafts : [];
  const want = new Set((ids || []).map(String));
  const take = drafts.filter(d => want.has(d.id) && exactMatch(d).ok);
  const refused = [...want].filter(id => !take.some(d => d.id === id));
  if (!take.length) return { ok: false, error: 'none of those drafts is an exact match any more', refused };
  const gone = new Set(take.map(d => d.id));
  const next = drafts.filter(d => !gone.has(d.id));
  const wrote = await kvSetJson(DRAFTS_KEY, { drafts: next, updatedAt: new Date().toISOString() });
  if (!wrote) return { ok: false, error: 'Redis write failed' };
  await recordProcessed(take.map(d => ({ id: d.note?.id || d.id, outcome: 'confirmed', draft: d.id, bulk: true })));
  return { ok: true, drafts: next, confirmed: take.map(d => d.id), refused };
}

export async function resolveDraft({ id, action, orderId = null } = {}) {
  if (!kvConfigured()) return { ok: false, error: 'the inbox store is not configured' };
  if (!['confirm', 'dismiss', 'choose'].includes(action)) return { ok: false, error: 'action must be confirm, dismiss or choose' };
  const stored = (await kvGetJson(DRAFTS_KEY)) || { drafts: [] };
  const drafts = Array.isArray(stored.drafts) ? stored.drafts : [];
  const d = drafts.find(x => x.id === id);
  if (!d) return { ok: false, error: 'no such draft — it may already have been resolved on another device' };
  let next = drafts.filter(x => x.id !== id);
  if (action === 'choose') {
    const promoted = chooseCandidate(d, orderId);
    if (!promoted) return { ok: false, error: 'that fill is not one of the candidates' };
    next = [...next.filter(x => x.id !== promoted.id), promoted];
  } else {
    await recordProcessed([{ id: d.note?.id || d.id, outcome: action === 'confirm' ? 'confirmed' : 'dismissed', draft: d.id }]);
  }
  const wrote = await kvSetJson(DRAFTS_KEY, { drafts: next, updatedAt: new Date().toISOString() });
  return wrote ? { ok: true, drafts: next } : { ok: false, error: 'Redis write failed' };
}

// ── THE DAILY RUN ────────────────────────────────────────────────────────────
// Called by api/flex-sync.js after the trade plan and before the channel is told. Dry unless
// `apply`: a dry run reports what it would draft and writes nothing.
// `provisional` + `skipUnjournaled` are the same-day path's (api/flex-sync.js ?tc=1). On the
// statement's run `asOf` is the statement's day, and same-day drafts still waiting take the
// statement's numbers first (lib/sameDayFills.js upgradeDrafts).
export async function runJournal({ trades = [], known = new Set(), today, holidays = [], apply = false, provisional = false, skipUnjournaled = null, asOf = null } = {}) {
  if (!kvConfigured()) return { ok: false, reason: 'Redis not configured' };
  const inbox = (await kvLrange(INBOX_KEY)) || [];
  const [draftsStored, seen] = await Promise.all([kvGetJson(DRAFTS_KEY), kvGetJson(SEEN_KEY)]);
  const notes = inbox.map(x => x.value).filter(v => v && v.id);
  let prior = draftsStored?.drafts || [], upgraded = 0;
  if (!provisional) {
    const up = upgradeDrafts(prior, orderUnits(trades), { asOf, fillOf, rematch: (note, u) => matchNote(note, u, { holidays }) });
    prior = up.drafts; upgraded = up.changed;
  }
  const rows = ((await kvGetJson(CONSOLE_KEY))?.rows) || [];
  const out = processInbox({ notes, trades, known, seen: seen || {}, drafts: prior, today, holidays, provisional, skipUnjournaled, rows });
  // Amends that found no trade when they arrived, tried again against today's console.
  const retried = retryAmends(out.drafts, rows);
  out.drafts = retried.drafts;
  const leftIds = new Set(out.leaving.map(l => l.note.id));
  const waitingToday = notes.filter(n => !leftIds.has(n.id) && n.kind !== 'amend' && n.trade_date === today).length;
  const result = { ok: true, applied: false, counts: { ...out.counts, amendsResolved: retried.changed, sameDayUpgraded: upgraded }, symbols: out.symbols, inbox: notes.length,
    fate: out.fate, units: out.units, waitingToday };
  if (!apply) return result;
  const wrote = await kvSetJson(DRAFTS_KEY, { drafts: out.drafts, updatedAt: new Date().toISOString() });
  if (!wrote) return { ...result, ok: false, reason: 'Redis write failed — the inbox was left as it was' };
  await kvSetJson(SEEN_KEY, out.seen);
  await kvSetJson(WHY_KEY, out.why || {});
  if (out.leaving.length) {
    await recordProcessed(out.leaving.map(({ note, outcome }) => ({ id: note.id, outcome, note })));
    // Only now, and only the exact elements processed: a note posted during the run stays put.
    const leavingIds = new Set(out.leaving.map(l => l.note.id));
    for (const x of inbox) if (leavingIds.has(x.value?.id)) await kvLrem(INBOX_KEY, x.raw);
  }
  return { ...result, applied: true };
}
