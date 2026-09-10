// test/fundYield.test.mjs — a fund's SEC yield, and the wrong number that nearly shipped.
//
// The cash comparison ran on two constants: USFR 3.71% as of 2026-08-06, SGOV 3.57% as of
// 2026-07-30. Read on 2026-09-10 those were 35 and 42 days old, and refreshing the dashboard did
// nothing to either. The verdict a reader acts on was computed from a figure five weeks old.
import { parseIsharesSecYield, isoFromIssuerDate, PLAUSIBLE_SEC_YIELD, ISHARES_URL } from '../lib/fundYield.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// The shape iShares publishes, reduced to the two fields that matter. The date lives INSIDE the
// yield's own valueReference, which is the detail the first regex got wrong.
const page = (ticker, title, yieldPct, asOf) =>
  `<html><head><title>${title}</title></head><body>{"@type":"PropertyValue","name":"NAV as of","value":"100.48"},`
  + `{"@type":"PropertyValue","name":"30 Day SEC Yield as of","value":"${yieldPct}%","valueReference":`
  + `{"@type":"PropertyValue","name":"As of Dates","value":"${asOf}"}},`
  + `{"@type":"PropertyValue","name":"12m Trailing Yield as of","value":"9.99%","valueReference":`
  + `{"@type":"PropertyValue","name":"As of Dates","value":"Jan 01, 1999"}}</body></html>`;

// ── the good case ────────────────────────────────────────────────────────────
{
  const r = parseIsharesSecYield(page('SGOV', 'iShares 0-3 Month Treasury Bond ETF | SGOV', '3.62', 'Sep 08, 2026'), 'SGOV');
  eq('the yield is read', r.value, 3.62);
  eq('and dated from its OWN valueReference', r.asOf, '2026-09-08');
  ok('the parse succeeds', r.ok);
  // THE DATE MUST COME FROM THE YIELD'S OWN OBJECT. An unbounded match ran past that object's
  // closing brace and picked up the NEXT property's value — which is how a yield ends up dated by
  // whatever field happens to follow it. The fixture's next field is deliberately Jan 01, 1999.
  ok('never from the field that follows it', r.asOf !== '1999-01-01');
  ok('and the trailing yield is not mistaken for the SEC one', r.value !== 9.99);
}

// ── THE WRONG NUMBER THAT NEARLY SHIPPED ─────────────────────────────────────
// Reaching for a second fund to cross-check against, the obvious-looking iShares product id 271544
// returned a page whose 30-day SEC yield read 5.16% — impossible for a Treasury floating-rate fund
// while 3-month bills yield 3.80%. The regex was right and the page was real: id 271544 is SYSB,
// the Systematic Bond ETF, not TFLO. Nothing in the URL said so and nothing in the extraction would
// have caught it. A yield attached to the wrong fund looks exactly as trustworthy as a right one.
{
  const wrong = parseIsharesSecYield(page('SYSB', 'iShares Systematic Bond ETF | SYSB', '5.16', 'Sep 08, 2026'), 'TFLO');
  eq('a page for another fund is refused', wrong.ok, false);
  ok('and says which fund it actually is', /SYSB/.test(wrong.reason));
  ok('no value escapes the refusal', wrong.value === undefined);
  // The right ticker on the same page still works, so the guard tests identity and not the title.
  eq('while the fund it IS for parses', parseIsharesSecYield(page('SYSB', 'iShares Systematic Bond ETF | SYSB', '5.16', 'Sep 08, 2026'), 'SYSB').ok, true);
  eq('a page with no title cannot be identified', parseIsharesSecYield('<html><body>x</body></html>', 'SGOV').ok, false);
  eq('and no ticker to check against is a refusal', parseIsharesSecYield(page('SGOV', 'x | SGOV', '3.62', 'Sep 08, 2026'), '').ok, false);
}

// ── the second guard, after identity ─────────────────────────────────────────
{
  ok('the plausible band is stated', PLAUSIBLE_SEC_YIELD.hi > PLAUSIBLE_SEC_YIELD.lo);
  const silly = parseIsharesSecYield(page('SGOV', 'iShares | SGOV', '61.20', 'Sep 08, 2026'), 'SGOV');
  eq('an implausible yield is refused', silly.ok, false);
  ok('with the number named', /61.2/.test(silly.reason));
  // AN UNDATED FIGURE IS REFUSED. Presented beside dated ones it invites the reader to assume it is
  // today's, and it cannot be aged.
  const undated = parseIsharesSecYield(page('SGOV', 'iShares | SGOV', '3.62', 'not a date'), 'SGOV');
  eq('and so is one with no readable date', undated.ok, false);
  eq('a missing yield field is a refusal too', parseIsharesSecYield('<html><head><title>SGOV</title></head><body></body></html>', 'SGOV').ok, false);
}

// ── date parsing ─────────────────────────────────────────────────────────────
{
  eq('the issuer writes a human date', isoFromIssuerDate('Sep 08, 2026'), '2026-09-08');
  eq('a single-digit day is padded', isoFromIssuerDate('Jan 3, 2026'), '2026-01-03');
  eq('a full month name works', isoFromIssuerDate('September 08, 2026'), '2026-09-08');
  eq('nonsense is not a date', isoFromIssuerDate('As of Dates'), null);
  eq('nor is nothing', isoFromIssuerDate(null), null);
}

// Only funds with a configured issuer page can be asked for. WisdomTree answers 403 to every route,
// so USFR is deliberately absent rather than half-wired.
{
  ok('SGOV has an issuer page', !!ISHARES_URL.SGOV);
  eq('USFR does not, and is not pretended to', ISHARES_URL.USFR, undefined);
}


// ── THE HAND ENTRY ───────────────────────────────────────────────────────────
// SGOV's figure is fetched. USFR's cannot be — WisdomTree sits behind a Cloudflare bot challenge
// that answers 403 to every automated route (product page, API path, holdings CSV) while loading
// fine in a browser. That is exactly the case manual entry exists for, so the card carries the link
// and the field name rather than pretending the number is unavailable.
{
  const { ISSUER_PAGE, SEC_YIELD_TICKERS } = await import('../lib/cashyield.js');
  eq('both funds are tracked', SEC_YIELD_TICKERS, ['USFR', 'SGOV']);
  ok('each has an issuer page to read it from', SEC_YIELD_TICKERS.every(t => /^https:\/\//.test(ISSUER_PAGE[t]?.url || '')));
  // WHICH FIELD. "SEC 30-Day Yield" and "12m Trailing Yield" sit next to each other on both pages,
  // and the trailing one is the backward-looking figure this whole card exists to stop using.
  ok('and names the exact field to copy', SEC_YIELD_TICKERS.every(t => /SEC/.test(ISSUER_PAGE[t]?.field || '')));
  eq('SGOV is marked fetchable', ISSUER_PAGE.SGOV.fetchable, true);
  eq('USFR is not', ISSUER_PAGE.USFR.fetchable, false);
  // A FLAG WITHOUT A REASON ROTS. Someone will retry the fetch in six months; the note says what
  // they will hit and that the URL is not the problem.
  ok('with the reason recorded', /Cloudflare|403/.test(ISSUER_PAGE.USFR.why || ''));
  ok('and the fetchable one needs none', ISSUER_PAGE.SGOV.why === null);
  // The fetcher and the hand entry must agree about what is plausible, or one route accepts a
  // number the other refuses.
  const { PLAUSIBLE_SEC_YIELD: bounds } = await import('../lib/fundYield.js');
  ok('both routes share one plausible band', bounds.hi > bounds.lo && bounds.lo >= 0);
}


// ── TAKING WHAT A PERSON ACTUALLY PASTES ─────────────────────────────────────
// The form asked for a bare number and a typed YYYY-MM-DD — asking someone reading an issuer page
// to retype two things they are looking at. Retyping is where the wrong digit comes from, and the
// only reason this field exists is that the figure could not be fetched.
{
  const { parseYieldValue, parseIssuerDate, parseSecYieldPaste } = await import('../lib/fundYield.js');

  eq('a bare number', parseYieldValue('3.68'), 3.68);
  eq('with the per-cent sign', parseYieldValue('3.68%'), 3.68);
  eq('and with the spacing a copy leaves behind', parseYieldValue(' 3.68 % '), 3.68);
  // A SINGLE CLEAN NUMBER OR NOTHING. "3.68 / 3.71" silently taking the first is worse than
  // refusing, because the reader has no way to see which half was kept.
  eq('two numbers is not a yield', parseYieldValue('3.68/3.71'), null);
  eq('nor is prose', parseYieldValue('3.68 percent'), null);
  eq('nor nothing', parseYieldValue(''), null);

  // The forms the issuer pages actually print.
  eq('the iShares form', parseIssuerDate('Sep 08, 2026'), '2026-09-08');
  eq('spelled out', parseIssuerDate('September 08, 2026'), '2026-09-08');
  eq('ISO', parseIssuerDate('2026-09-08'), '2026-09-08');
  eq('day-first with a month name', parseIssuerDate('08 Sep 2026'), '2026-09-08');
  // AMBIGUOUS DATES ARE READ US-STYLE AND SAID SO — both funds are US-listed with US pages.
  eq('the slash form is US month-first', parseIssuerDate('09/08/2026'), '2026-09-08');
  // ...and anything that cannot be a US month is refused rather than silently swapped.
  eq('a first field above twelve is refused, not swapped', parseIssuerDate('13/08/2026'), null);
  // A date that does not exist is a typo, not a date.
  eq('the 31st of February is a typo', parseIssuerDate('2026-02-31'), null);
  eq('and so is month thirteen', parseIssuerDate('2026-13-01'), null);
  eq('nonsense is not a date', parseIssuerDate('as of'), null);

  // A whole pasted line, in either order.
  eq('value and date from one paste', parseSecYieldPaste('30 Day SEC Yield as of 09/08/2026  3.68%'),
     { value: 3.68, asOf: '2026-09-08', ambiguous: null });
  // TWO PERCENTAGES IS AMBIGUOUS. "SEC 30-Day Yield" sits beside "12m Trailing Yield" on both
  // pages, and the trailing figure is the backward-looking one this card exists to stop using.
  // It still fills — and it reports what it found, so the reader can check which was taken.
  {
    const both = parseSecYieldPaste('SEC 30-Day Yield 3.68% 12m Trailing 3.69% as of Sep 08, 2026');
    eq('the first percentage is taken', both.value, 3.68);
    eq('and the ambiguity is reported, not hidden', both.ambiguous, [3.68, 3.69]);
  }
  // A partial paste fills what it can rather than refusing everything.
  eq('a date with no yield still yields a date', parseSecYieldPaste('as of 2026-09-08').asOf, '2026-09-08');
  eq('and an empty paste claims nothing', parseSecYieldPaste(''), { value: null, asOf: null });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
