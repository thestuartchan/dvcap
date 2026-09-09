// test/throttle.test.mjs — the gate must never leak a slot.
//
// A limiter that forgets to free a slot when a task REJECTS does not fail loudly. It slowly runs
// out of capacity and eventually stops running anything, and from the outside that is
// indistinguishable from the far end having gone slow. So the rejection paths are tested as
// carefully as the happy one.
import { limiter, backoffMs } from '../lib/throttle.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `\n     got  ${JSON.stringify(g)}\n     want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);
const tick = () => new Promise(r => setTimeout(r, 0));

// A task that resolves when we say so, and reports the high-water mark of concurrency.
function harness() {
  let active = 0, peak = 0;
  const gates = [];
  const task = (fails = false) => () => {
    active++; peak = Math.max(peak, active);
    return new Promise((res, rej) => gates.push(() => { active--; fails ? rej(new Error('nope')) : res('ok'); }));
  };
  return { task, release: () => gates.shift()?.(), releaseAll: () => { while (gates.length) gates.shift()(); }, peak: () => peak, waiting: () => gates.length };
}

// ── THE CAP HOLDS ────────────────────────────────────────────────────────────
{
  const h = harness(), gate = limiter(2);
  const all = [gate(h.task()), gate(h.task()), gate(h.task()), gate(h.task()), gate(h.task())];
  await tick();
  eq('only two run at once', h.waiting(), 2);
  eq('and three are queued', gate.pending(), 3);
  h.releaseAll(); await tick(); h.releaseAll(); await tick(); h.releaseAll(); await tick();
  eq('everything resolves', (await Promise.all(all)).length, 5);
  eq('and the cap was never exceeded', h.peak(), 2);
  eq('the queue drains', gate.pending(), 0);
  eq('and nothing is left active', gate.active(), 0);
}

// ── A REJECTION FREES ITS SLOT ───────────────────────────────────────────────
// This is the leak. If it regresses, the gate degrades to capacity zero over time.
{
  const h = harness(), gate = limiter(1);
  // The handler is attached at CREATION, not after the await. A rejection with no handler yet is an
  // unhandled rejection, which takes the process down before the assertion can run — a bug in the
  // test that looks exactly like a bug in the gate.
  const a = gate(h.task(true)).then(() => 'resolved', () => 'rejected');
  const b = gate(h.task());
  await tick();
  h.releaseAll(); await tick();
  eq('the failing task rejects', await a, 'rejected');
  eq('and the next one was let through anyway', h.waiting(), 1);
  h.releaseAll();
  eq('which then resolves', await b, 'ok');
  eq('leaving no slot held', gate.active(), 0);
}

// A thunk that throws SYNCHRONOUSLY must also free its slot, not throw out of the pump.
{
  const gate = limiter(1);
  let threw = false;
  await gate(() => { throw new Error('sync'); }).catch(() => { threw = true; });
  ok('a synchronous throw is a rejection', threw);
  eq('and it did not strand the slot', gate.active(), 0);
  eq('so later work still runs', await gate(() => 'after'), 'after');
}

// ── DEGENERATE CAPS ──────────────────────────────────────────────────────────
{
  eq('a cap below one is still one', limiter(0).active(), 0);
  const g = limiter(0);
  eq('and it runs, rather than deadlocking', await g(() => 'ran'), 'ran');
  eq('a fractional cap floors', await limiter(2.9)(() => 'ran'), 'ran');
}

// ── BACKOFF ──────────────────────────────────────────────────────────────────
// Full jitter: the wait is drawn from [0, ceiling), and the CEILING doubles. Two callers throttled
// together must not wait the same interval, or the retry is the burst again.
{
  const max = (a) => backoffMs(a, { random: () => 0.999999 });
  const min = (a) => backoffMs(a, { random: () => 0 });
  eq('the first ceiling is the base', max(0), 399);
  eq('and it doubles', max(1), 799);
  eq('and again', max(2), 1599);
  eq('the floor is always zero, which is what spreads them', [min(0), min(1), min(5)], [0, 0, 0]);
  eq('the ceiling is capped', max(99), 7999);
  eq('a negative attempt is treated as the first', max(-3), max(0));

  // The property that matters: repeated draws differ.
  const draws = new Set(Array.from({ length: 40 }, () => backoffMs(3)));
  ok('successive waits are not all identical', draws.size > 1);
  ok('and all sit inside the ceiling', [...draws].every(d => d >= 0 && d < 3200));
}

// ── THE GATES ARE ACTUALLY IN THE PATH ───────────────────────────────────────
// A limiter nothing routes through is a limiter that does not limit, and it fails silently — the
// burst continues and the module looks like it has a gate. Asserted by reading the source, because
// the alternative is trusting a comment.
{
  const alchemy = readFileSync(new URL('../lib/alchemy.js', import.meta.url), 'utf8');
  const bare = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const a = bare(alchemy);
  ok('alchemy imports the limiter', /import \{[^}]*limiter[^}]*\} from '\.\/throttle\.js'/.test(a));
  ok('and builds a gate from it', /limiter\(\s*\d+\s*\)/.test(a));
  ok('and routes requests through it', /await gated\(/.test(a));
  // The one that matters: nothing may call the raw fetch impl directly, or that call is ungated.
  eq('no request bypasses the gate', (a.match(/await fetchImpl\(/g) || []).length, 0);
  eq('and every Alchemy request goes through it',
     (a.match(/await gated\(/g) || []).length, (a.match(/method: 'alchemy_/g) || []).length);

  // ── ONE FRED BUDGET, NOT ONE PER ROUTE ────────────────────────────────────
  // indicators.js built its own limiter(8) and spent a budget it believed it had to itself. It did
  // not: FRED's 120/min is per KEY, lib/fred.js drives thirteen more call sites for lib/quotes.js,
  // and a Macro tab load fires both files at once — so the route that throttled queued politely
  // behind requests that did not, and five feeds still came back 429 on 2026-09-09.
  //
  // The gate lives next to the fetch now and both sides draw on the ONE instance. These assert the
  // arrangement rather than the old shape: a second limiter appearing anywhere in the FRED path is
  // the regression, and it would look exactly like a fix.
  const ind = bare(readFileSync(new URL('../api/indicators.js', import.meta.url), 'utf8'));
  const fredSrc = bare(readFileSync(new URL('../lib/fred.js', import.meta.url), 'utf8'));

  ok('the FRED gate is built in lib/fred.js', /export const fredGate = limiter\(/.test(fredSrc));
  ok('from the shared limiter', /import \{[^}]*limiter[^}]*\} from '\.\/throttle\.js'/.test(fredSrc));
  ok('and indicators shares that one instead of building a second',
     /import \{[^}]*fredGate[^}]*\} from '\.\.\/lib\/fred\.js'/.test(ind));
  eq('indicators builds no limiter of its own', (ind.match(/limiter\(/g) || []).length, 0);

  ok('indicators still gates its FRED requests', /fredGate\(\(\) => fetch\(/.test(ind));
  ok('and backs off between tries', /sleep\(backoffMs\(/.test(ind));
  ok('so does lib/fred.js', /sleep\(backoffMs\(/.test(fredSrc));
  ok('and it retries rather than treating one 429 as fatal', /tries = 3/.test(fredSrc));
  // A 400 means the request is wrong and a retry fails identically; only 429/5xx are worth another.
  ok('but does not retry a bad request', /status !== 429 && r\.status < 500/.test(fredSrc));

  // fredLabor called fetch directly and so never retried, while the panel said it had.
  eq('no FRED request is made outside fredFetch',
     (ind.match(/await fetch\(`https:\/\/api\.stlouisfed/g) || []).length, 0);
  // The same rule on the library side. ONE fetch call in the whole file, and it is the one inside
  // fredJson — so a new reader cannot quietly reintroduce an ungated request, which is exactly how
  // this file came to have four of them.
  eq('lib/fred.js calls fetch exactly once', (fredSrc.match(/fetch\(/g) || []).length, 1);
  ok('and that one call is gated', /fredGate\(\(\) => fetch\(/.test(fredSrc));
  // Every exported reader routes through fredJson. Counted against the readers rather than every
  // export, since fredJson is itself exported and is the thing being routed to.
  {
    const readers = (fredSrc.match(/^export async function fred\w+/gm) || [])
      .filter(x => !/fredJson/.test(x));
    eq('four readers, all through the gate', readers.length, 4);
    eq('each with a fredJson call', (fredSrc.match(/await fredJson\(/g) || []).length, readers.length);
  }
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
