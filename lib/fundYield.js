// lib/fundYield.js — a fund's 30-day SEC yield, from the issuer, on the day it was published.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// The cash comparison ran on two constants in the source: USFR at 3.71% as of 2026-08-06 and SGOV
// at 3.57% as of 2026-07-30. Read on 2026-09-10 those were 35 and 42 days old, and a refresh of the
// dashboard did nothing to either — they needed a code change and a deploy. The verdict a reader
// acts on ("USFR by 12bp, about $64/yr") was computed from a figure five weeks old.
//
// iShares publishes SGOV's live figure in the product page's own structured data. Measured
// 2026-09-10: 3.62% as of Sep 08, against the stored 3.57% — five basis points, and two days old
// instead of forty-two.
//
// WisdomTree does not. Every route to USFR — the product page, the API path, the holdings CSV —
// answers 403 from a WAF, so USFR keeps its published anchor and the fitted proxy in
// lib/cashyield.js. That asymmetry is the reason the SGOV fetch is worth more than its own number:
// it is the only fund of the two whose true value can be observed, so it is the only way to measure
// what the proxy's error actually IS on a given day rather than assuming the residual still holds.
//
// ── THE IDENTITY IS ASSERTED, NOT ASSUMED ────────────────────────────────────
// This nearly shipped a wrong number. Reaching for a second fund to cross-check against, the
// obvious-looking iShares product id 271544 returned a page whose 30-day SEC yield read 5.16% —
// impossible for a Treasury floating-rate fund while 3-month bills yield 3.80%. The regex was
// right and the page was real: id 271544 is SYSB, the Systematic Bond ETF, not TFLO. Nothing in the
// URL said so and nothing in the extraction would have caught it.
//
// So a page must name the fund it is for. The ticker has to appear in the document title or the
// parse is refused — a yield attached to the wrong fund is worse than no yield, because it looks
// exactly as trustworthy as a right one.

export const ISHARES_URL = Object.freeze({
  SGOV: 'https://www.ishares.com/us/products/314116/ishares-0-3-month-treasury-bond-etf',
});

// A 30-day SEC yield outside this range is not a US Treasury money-market figure; it is a parse
// that has landed on the wrong field or the wrong fund. Deliberately wide — this is a sanity bound,
// not a forecast — and it is the second guard after the identity check, not a substitute for it.
export const PLAUSIBLE_SEC_YIELD = Object.freeze({ lo: 0, hi: 12 });

// "Sep 08, 2026" → "2026-09-08". The issuer writes a human date; everything downstream compares ISO.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function isoFromIssuerDate(s) {
  const m = String(s || '').trim().match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].slice(0, 3));
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
}

export function parseIsharesSecYield(html, ticker) {
  const h = String(html || '');
  const want = String(ticker || '').trim().toUpperCase();
  if (!want) return { ok: false, reason: 'no ticker to verify against' };

  // ── IDENTITY FIRST ─────────────────────────────────────────────────────────
  const title = (h.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  if (!title) return { ok: false, reason: 'page carries no title to identify the fund by' };
  if (!new RegExp(`\\b${want}\\b`, 'i').test(title)) {
    return { ok: false, reason: `page is not ${want} — its title reads "${title.trim().slice(0, 70)}"` };
  }

  // The date lives INSIDE this field's own valueReference, so the match is bounded by that
  // object's closing brace. An unbounded `[^}]*}` ran past it and picked up the NEXT property's
  // value — which is how a yield ends up dated by whatever field happens to follow it.
  const m = h.match(/"name":"30 Day SEC Yield as of","value":"([\d.]+)%","valueReference":\{[^}]*"value":"([^"]+)"\}/);
  if (!m) return { ok: false, reason: 'no 30-day SEC yield field in the page' };
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return { ok: false, reason: `unparseable yield "${m[1]}"` };
  if (value < PLAUSIBLE_SEC_YIELD.lo || value > PLAUSIBLE_SEC_YIELD.hi) {
    return { ok: false, reason: `${value}% is outside the plausible range for a Treasury fund` };
  }
  const asOf = isoFromIssuerDate(m[2]);
  // A yield with no date cannot be aged, and an undated figure presented beside dated ones invites
  // the reader to assume it is today's.
  if (!asOf) return { ok: false, reason: `yield ${value}% carried no readable date ("${m[2]}")` };

  return { ok: true, ticker: want, value, asOf, source: 'iShares product page · 30-Day SEC Yield' };
}

export async function fetchIsharesSecYield(ticker, { timeoutMs = 9000 } = {}) {
  const url = ISHARES_URL[String(ticker || '').toUpperCase()];
  if (!url) return { ok: false, reason: `no issuer page configured for ${ticker}` };
  try {
    const r = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { ok: false, reason: `iShares answered ${r.status}` };
    return parseIsharesSecYield(await r.text(), ticker);
  } catch (e) {
    // Never fatal. Losing this costs the live figure, not the card — the published anchor stands.
    return { ok: false, reason: `iShares fetch failed — ${String(e?.message || e)}` };
  }
}
