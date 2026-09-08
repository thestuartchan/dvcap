// lib/throttle.js — not asking for more at once than the far end will answer.
//
// WHY THIS EXISTS. api/indicators.js has 33 FRED call sites and most fire at once; several of them
// are two requests rather than one. FRED allows 120 requests a minute per key, so a cold load asks
// for its whole day in one burst and the tail of it comes back 429. The tiles those series feed
// then render blank, which reads as "no figure has been published" rather than "we asked too fast".
//
// The fix is not a longer retry. It is not asking for more at once than the far end will answer,
// with a retry that backs OFF rather than re-colliding: a fixed delay after a rate limit tends to
// land every retry inside the same window as every other retry, which is the burst again.

// A concurrency gate. `limiter(6)` returns a function that takes a thunk and resolves with its
// result, never running more than six at a time. Order is preserved on entry, not on completion —
// callers that need ordering already await in order.
//
// A rejecting task must free its slot exactly like a resolving one, or the gate leaks capacity and
// eventually deadlocks. That is the whole reason this is a tested module rather than four lines
// inline: the failure is silent, and it looks like the far end being slow.
export function limiter(max = 6) {
  const cap = Math.max(1, Math.floor(max));
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < cap && queue.length) {
      const { fn, resolve, reject } = queue.shift();
      active++;
      // Promise.resolve so a thunk that throws SYNCHRONOUSLY is a rejection rather than an
      // exception thrown out of pump(), which would abandon the slot it just took.
      //
      // The slot is released BEFORE the caller is resolved, not in a trailing .finally(). Chained
      // after, the release lands a microtask late, so a caller that awaits its own result and then
      // reads active() sees a slot still held — an accurate gate that reports itself wrong. It also
      // means the next queued task starts immediately rather than after the caller's continuation.
      const done = () => { active--; pump(); };
      Promise.resolve().then(fn).then(
        (v) => { done(); resolve(v); },
        (e) => { done(); reject(e); },
      );
    }
  };
  const run = (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
  run.pending = () => queue.length;
  run.active = () => active;
  return run;
}

// Exponential backoff with FULL JITTER. The jitter is the point: without it every caller that was
// throttled together waits the same interval and retries together, reproducing the burst that
// caused the throttle. Randomising across the whole interval spreads them instead.
//
// `attempt` is zero-based, so the first wait is drawn from [0, base).
export function backoffMs(attempt, { base = 400, cap = 8000, random = Math.random } = {}) {
  const ceiling = Math.min(cap, base * (2 ** Math.max(0, attempt)));
  return Math.floor(random() * ceiling);
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
