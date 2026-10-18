// lib/consoleRev.js — a Console save names the copy it was made from, and a stale copy is refused.
//
// The browser owns the console and saves it WHOLESALE (api/manual-entry.js). Two writers share
// the one key: this browser, another device, and the IBKR sync, which adds rows and fills on its
// own schedule (api/flex-sync.js). A tab opened on Monday and saved on Tuesday replaced Tuesday's
// statement fills with Monday's book, and nothing said so. Every write now carries a revision
// number, every save says which revision it started from, and a save from an older one is
// refused with what to do about it instead of overwriting.
//
// THE OLD TAB. A browser still running the previous build sends no revision. Before any revision
// has been written that is every save there is, so it is accepted (and starts the count). Once a
// revision exists, a save without one can only be an old tab, and it is refused with "reload".
//
// Not atomic: the read and the write are two calls to Redis, so two saves landing in the same
// instant can both pass. The case it exists for is hours apart, not milliseconds.

export const revOf = (stored) => {
  const r = Number(stored?.rev);
  return Number.isInteger(r) && r >= 0 ? r : 0;
};
const hasRev = (stored) => stored?.rev != null && Number.isInteger(Number(stored.rev));

// { ok, rev } — the revision the write should carry — or { ok: false, status, error, current }.
export function saveCheck(stored, baseRev) {
  const current = revOf(stored);
  if (baseRev == null || baseRev === '') {
    if (!hasRev(stored)) return { ok: true, rev: current + 1, legacy: true };
    return { ok: false, status: 409, current, reason: 'no-revision',
             error: 'Not saved — this tab is running an older version of the console. Reload the page, then save again; your edits are kept in this browser until you do.' };
  }
  const base = Number(baseRev);
  if (!Number.isInteger(base) || base < 0) return { ok: false, status: 400, current, reason: 'bad-revision', error: 'baseRev must be a whole number' };
  if (base !== current) {
    const when = stored?.updatedAt ? ` at ${String(stored.updatedAt).slice(0, 16).replace('T', ' ')} UTC` : '';
    return { ok: false, status: 409, current, base, reason: 'stale',
             error: `Not saved — the console was changed${when} (by another device or the IBKR sync) after this page loaded it. Reload to pick up the newer copy, or overwrite it with this one.` };
  }
  return { ok: true, rev: current + 1 };
}

// What a server-side writer (the IBKR sync) stamps on its own write.
export const nextRev = (stored) => revOf(stored) + 1;
