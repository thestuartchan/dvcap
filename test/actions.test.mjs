// test/actions.test.mjs — the daily "action required" strip (console rework, Step 4b).
import { actionItems, DTE_WARN } from '../lib/actions.js';
let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const TODAY = '2027-01-08';
const xle = { id: 'xle', symbol: 'XLE', derived: { status: 'open', qty: 5 }, levels: [],
  opt: { label: "Jan15'27 55C", expiry: '2027-01-15', hardDate: '2027-01-08', hardDateReached: true, expired: false, dte: 7 } };
const sofi = { id: 'sofi', symbol: 'SOFI', derived: { status: 'open', qty: 500 }, levels: [{ id: 'st', kind: 'stop', at: 16.0 }] };
const arm = { id: 'arm', symbol: 'ARM', derived: { status: 'open', qty: 8 }, levels: [{ id: 's2', kind: 'stop', at: 250 }] };
const old = { id: 'old', symbol: 'INTC', derived: { status: 'closed', qty: 0 }, levels: [{ id: 'x', kind: 'stop', at: 1 }], opt: { expired: true, expiry: '2026-01-01', label: 'x' } };
const short = { id: 'sh', symbol: 'SMH', derived: { status: 'open', qty: 3 }, levels: [], opt: { label: "Sep30'26 300P", expiry: '2027-01-12', dte: 4, hardDateReached: false, expired: false } };

// ── THE BRIEF'S LINE ─────────────────────────────────────────────────────────
{
  const items = actionItems({ rows: [xle], today: TODAY });
  eq('XLE Jan27 55C — hard date today', items.map(i => i.text), ["XLE Jan15'27 55C — hard exit date today"]);
  eq('and it is the danger tone at rank 1', [items[0].tone, items[0].rank, items[0].kind], ['danger', 1, 'hard-date']);
  eq('a hard date on another day is dated', actionItems({ rows: [xle], today: '2027-01-09' })[0].text, "XLE Jan15'27 55C — hard exit date 2027-01-08");
}

// ── NOTHING TO DO IS NOTHING ─────────────────────────────────────────────────
{
  eq('no rows, no items', actionItems({}), []);
  eq('a quiet book has no items', actionItems({ rows: [sofi, arm], hits: [], atrOf: () => 0.5, priceOf: () => 18 }), []);
  eq('a closed row never appears, whatever it carries', actionItems({ rows: [old], today: TODAY }), []);
}

// ── ORDER: EXPIRED, HARD DATE, ALERT, STOP NEAR, DTE, SWING ───────────────────
{
  const expired = { ...xle, id: 'exp', opt: { ...xle.opt, expired: true, hardDateReached: false } };
  const hits = [{ position: sofi, level: sofi.levels[0], price: 15.9 }];
  const items = actionItems({
    rows: [sofi, arm, xle, expired, short], hits, today: TODAY,
    atrOf: (r) => (r.symbol === 'ARM' ? 4 : 0.5),
    priceOf: (r) => (r.symbol === 'ARM' ? 252 : 15.9),
    swingLines: [{ symbol: 'ARM', sessionsHeld: 4 }],
  });
  eq('sorted by urgency', items.map(i => i.kind), ['expired', 'hard-date', 'alert', 'stop-near', 'dte', 'swing']);
  eq('the expired contract names what is still open', items[0].text, "XLE Jan15'27 55C — past expiry 2027-01-15 with 5 still open");
  eq('the alert names the level and the price', items[2].text, 'SOFI — stop level 16 hit, price 15.9');
  eq('the stop inside an ATR says how close', items[3].text, 'ARM — stop 250 is 0.5 ATR away');
  eq('short-dated option', items[4].text, "SMH Sep30'26 300P — 4 days to expiry");
  eq('the swing trade past its window', items[5].text, 'ARM — swing trade in session 4, past the 3-session window');
  eq('every item points at its card', items.map(i => i.id), ['exp', 'xle', 'sofi', 'arm', 'sh', 'arm']);
  // A stop already hit is the alert, not a second line.
  const dup = actionItems({ rows: [sofi], hits, atrOf: () => 0.5, priceOf: () => 15.9 });
  eq('a hit stop is listed once', dup.map(i => i.kind), ['alert']);
  // The DTE line does not double a hard date that is already listed.
  const both = actionItems({ rows: [{ ...xle, opt: { ...xle.opt, dte: 3 } }], today: TODAY });
  eq('hard date beats the DTE line for the same card', both.map(i => i.kind), ['hard-date']);
  eq('the DTE threshold', DTE_WARN, 7);
  eq('exactly 7 DTE is not short-dated', actionItems({ rows: [{ ...short, opt: { ...short.opt, dte: 7 } }] }), []);
  eq('a stop on the underlying of an option row is not judged in ATRs of the combo', actionItems({ rows: [{ ...sofi, opt: { label: 'x' }, levels: [{ id: 'u', kind: 'stop', at: 15, on: 'underlying' }] }], atrOf: () => 0.1, priceOf: () => 15.05 }), []);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
