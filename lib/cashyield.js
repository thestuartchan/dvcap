// lib/cashyield.js — cash-instrument yields on ONE consistent basis (2026-08-22 brief).
//
// TTM (trailing-12-month) distribution yield is backward-looking and OVERSTATES current earning
// power: SGOV's 3.74% TTM was $3.76/share paid over 12 months, down 7.7% from its 12-month average
// as higher old distributions roll off, and it only re-prices when a new monthly distribution is
// declared — frozen for a month, then it jumps. The forward, comparable standard is the 30-DAY SEC
// YIELD. Neither fund has a clean API, so the published SEC yield is a DATED manual value (issuer
// product page), reconciled against a live proxy off the 3-month bill — both funds are bill
// pass-throughs (USFR = weekly-reset FRNs off the 13-week auction; SGOV = 0–3 month bills).

// Published 30-day SEC yields — issuer product pages, manual, each with its own as-of. Update from
// the page; the proxy below flags when the live estimate drifts more than 10bp from this figure.
// `expense` is the current net expense ratio (SGOV's 0.07% waiver LAPSED mid-2024 → 0.09%).
export const SEC_YIELDS = {
  // `dtb3AtAsOf` is the FRED DTB3 observation ON the published figure's own date, not today's.
  // Without it the reconciliation compares a live rate against a three-week-old fund figure and
  // charges the difference to the model, when most of it is simply the bill having moved.
  // Source: FRED series DTB3, daily, fetched 2026-08-26.
  USFR: { value: 3.71, asOf: '2026-08-06', expense: 0.15, dtb3AtAsOf: 3.74, src: 'WisdomTree product page · SEC 30-Day Yield' },
  SGOV: { value: 3.57, asOf: '2026-07-30', expense: 0.09, dtb3AtAsOf: 3.69, src: 'BlackRock product page · 30-Day SEC Yield' },
};

// ── The bill → fund proxy, on ONE basis ──────────────────────────────────────
// Both funds are bill pass-throughs (USFR = weekly-reset FRNs off the 13-week auction; SGOV = 0–3
// month bills), so a live estimate of their SEC yield can be built off DTB3. Two things have to be
// right for that to mean anything, and previously neither was.
//
// BASIS. DTB3 is a DISCOUNT rate on a 360-day year against face. A fund's 30-day SEC yield is a
// bond-equivalent, semiannually-compounded figure. Subtracting an expense ratio from a discount
// rate to estimate a bond-equivalent yield mixes two units; it reconciled only because the fitted
// offsets silently absorbed the ~9bp conversion. The proxy now converts first.
//
// DATE. The residual is fitted against DTB3 AS OF the published figure's own date, so the fit tests
// the MODEL rather than the calendar. Fitted against today's rate, a fund that published three
// weeks ago is "wrong" by however far the bill has drifted since.
//
// What the residuals mean, now that they are not absorbing a units error:
//   SGOV +0.12pp — it holds 0–3 month bills averaging ~1 month, and the front curve is upward
//                  sloping here (3M 3.81% BEY vs 6M 3.93%), so shorter paper earns less than DTB3.
//   USFR −0.03pp — the FRN discount margin, slightly positive net of the fee. The old model put
//                  this at +0.20pp, which was mostly the missing discount→BEY conversion.
export const PROXY = {
  SGOV: { expense: 0.09, residual: 0.12,  formula: 'BEY(DTB3) − 0.09% fee − 0.12% maturity' },
  USFR: { expense: 0.15, residual: -0.03, formula: 'BEY(DTB3) − 0.15% fee + 0.03% margin' },
};
export const PROXY_DIVERGENCE_BP = 10;
// Both funds restate monthly; past this the published figure is stale enough that the live estimate
// is the better number and the manual value wants refreshing from the issuer page.
export const SEC_STALE_DAYS = 45;

// Estimate both funds' SEC yield from a DTB3 DISCOUNT rate.
export function secYieldProxy(dtb3Discount) {
  const bill = billFromDiscount(dtb3Discount, BILL_DAYS['3M']);
  if (!bill) return null;
  const from = (k) => +(bill.couponEquivExact - PROXY[k].expense - PROXY[k].residual).toFixed(2);
  return { SGOV: from('SGOV'), USFR: from('USFR'), bey: bill.couponEquiv, beyExact: bill.couponEquivExact };
}

// Reconcile the live estimate against the published figure, and SPLIT the gap into the two things
// that cause it: model error (the estimate missing the published figure on the date it was
// published) and rate movement (DTB3 having moved since). Only the first says anything is wrong.
export function proxyDivergence(dtb3Live) {
  const now = secYieldProxy(dtb3Live);
  if (!now) return null;
  const today = new Date().toISOString().slice(0, 10);
  const out = {};
  for (const k of ['SGOV', 'USFR']) {
    const pub = SEC_YIELDS[k];
    const then = secYieldProxy(pub.dtb3AtAsOf);
    const bp = (x) => Math.round(x * 100);
    const modelBp = then ? bp(then[k] - pub.value) : null;
    const rateBp = then ? bp(now[k] - then[k]) : null;
    const ageDays = Math.round((Date.parse(today) - Date.parse(pub.asOf)) / 86400000);
    out[k] = {
      est: now[k], estAtAsOf: then ? then[k] : null, published: pub.value,
      bp: bp(now[k] - pub.value), modelBp, rateBp,
      // The re-fit flag watches MODEL error only. A gap that is entirely the bill moving is the
      // proxy working, not failing, and flagging it trained the eye to ignore the flag.
      diverged: modelBp != null && Math.abs(modelBp) > PROXY_DIVERGENCE_BP,
      ageDays, stale: Number.isFinite(ageDays) && ageDays > SEC_STALE_DAYS,
    };
  }
  return out;
}

// APY from an annualised-simple SEC yield, monthly compounding: (1 + r/12)^12 − 1.
export const apyFromSec = (secPct) =>
  secPct == null ? null : +(((1 + (secPct / 100) / 12) ** 12 - 1) * 100).toFixed(2);

// ── T-bill quoted on a DISCOUNT basis ────────────────────────────────────────
// FRED's DTB3/DTB6 are "Secondary Market Rate, DISCOUNT Basis" — a discount rate, not a yield. It
// is quoted against FACE value on a 360-day year, so it is systematically LOWER than what the money
// actually earns, which is measured against the (smaller) PRICE paid on a 365-day year. Dropping a
// 3.80% discount rate into a column of fund yields therefore understates the bill by ~17bp before
// compounding is even considered, and comparing it to a compounded fund APY compounds the error.
//
// Two conversions, both Treasury-standard for a bill of 182 days or fewer:
//   coupon-equivalent (a.k.a. investment rate / BEY):  365d / (360 − d·n)
//   effective annual: price = 1 − d·n/360, then the holding return compounded 365/n times.
export const BILL_DAYS = Object.freeze({ '3M': 91, '6M': 182 });

export function billFromDiscount(discountPct, days) {
  const d = Number(discountPct) / 100, n = Number(days);
  if (!Number.isFinite(d) || !Number.isFinite(n) || d <= 0 || n <= 0 || n > 182) return null;
  const price = 1 - d * n / 360;
  if (price <= 0) return null;
  const couponEquiv = (365 * d) / (360 - d * n);
  const apy = (1 + (1 - price) / price) ** (365 / n) - 1;
  return {
    discount: +(d * 100).toFixed(2),
    couponEquiv: +(couponEquiv * 100).toFixed(2),
    couponEquivExact: couponEquiv * 100,
    apy: +(apy * 100).toFixed(2),
    price: +price.toFixed(6), days: n,
  };
}

// After-withholding yield. wht in percent (0 = none) applied to the whole distribution.
export const afterWht = (pct, wht) =>
  pct == null ? null : +(pct * (1 - (Number(wht) || 0) / 100)).toFixed(2);

// Compare the two funds (after WHT, on the chosen convention) against a bank deposit rate.
// bankConvention: 'simple' (compare on SEC/simple) or 'apy' (compare on APY). Returns the winning
// fund, the bp edge over the deposit, and the annual dollar edge at the given position size.
export function compareCash({ usfrSec, sgovSec, usfrWht = 0, sgovWht = 0, bankRate = null, bankConvention = 'apy', positionUsd = 0 } = {}) {
  const rows = {
    USFR: { sec: usfrSec, apy: apyFromSec(usfrSec), afterWht: afterWht(bankConvention === 'apy' ? apyFromSec(usfrSec) : usfrSec, usfrWht) },
    SGOV: { sec: sgovSec, apy: apyFromSec(sgovSec), afterWht: afterWht(bankConvention === 'apy' ? apyFromSec(sgovSec) : sgovSec, sgovWht) },
  };
  const best = (rows.USFR.afterWht ?? -Infinity) >= (rows.SGOV.afterWht ?? -Infinity) ? 'USFR' : 'SGOV';
  const bestYield = rows[best].afterWht;
  const bankOk = bankRate != null && Number.isFinite(+bankRate);
  const edgeVsBankBp = bankOk && bestYield != null ? Math.round((bestYield - (+bankRate)) * 100) : null;
  const dollarVsBank = (edgeVsBankBp != null && positionUsd) ? Math.round((edgeVsBankBp / 100 / 100) * positionUsd) : null;
  // Gap between the two funds too (the brief reports "vs SGOV" alongside "vs deposit").
  const fundGapBp = (rows.USFR.afterWht != null && rows.SGOV.afterWht != null)
    ? Math.round((rows.USFR.afterWht - rows.SGOV.afterWht) * 100) : null;
  const dollarFundGap = (fundGapBp != null && positionUsd) ? Math.round((Math.abs(fundGapBp) / 100 / 100) * positionUsd) : null;
  return { rows, best, bestYield, edgeVsBankBp, dollarVsBank, fundGapBp, dollarFundGap, bankConvention };
}
