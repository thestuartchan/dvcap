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

  const ind = bare(readFileSync(new URL('../api/indicators.js', import.meta.url), 'utf8'));
  ok('indicators imports the limiter', /import \{[^}]*limiter[^}]*\} from '\.\.\/lib\/throttle\.js'/.test(ind));
  ok('and gates its FRED requests', /fredGate\(\(\) => fetch\(/.test(ind));
  ok('and backs off between tries', /sleep\(backoffMs\(/.test(ind));
  // fredLabor called fetch directly and so never retried, while the panel said it had.
  eq('no FRED request is made outside fredFetch',
     (ind.match(/await fetch\(`https:\/\/api\.stlouisfed/g) || []).length, 0);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
