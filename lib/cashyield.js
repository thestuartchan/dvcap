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
  USFR: { value: 3.71, asOf: '2026-08-06', expense: 0.15, src: 'WisdomTree product page · SEC 30-Day Yield' },
  SGOV: { value: 3.57, asOf: '2026-07-30', expense: 0.09, src: 'BlackRock product page · 30-Day SEC Yield' },
};

// Live proxy off DTB3 (FRED 3-month bill, daily/free). SGOV is a pure pass-through: DTB3 − expense.
// USFR holds FRNs that pay the bill rate PLUS a discount margin (DM) over a fee, so its net offset
// is DTB3 − 0.15% + DM; DM is calibrated (~0.20%) to reconcile to the published 3.71% and is the
// thing the >10bp flag watches — if it trips, the discount margin has shifted and DM needs re-fitting.
export const PROXY = {
  SGOV: { expense: 0.09, dm: 0,    formula: 'DTB3 − 0.09%' },
  USFR: { expense: 0.15, dm: 0.20, formula: 'DTB3 − 0.15% + DM' },
};
export const PROXY_DIVERGENCE_BP = 10;

export function secYieldProxy(dtb3) {
  if (dtb3 == null || !Number.isFinite(dtb3)) return null;
  return {
    SGOV: +(dtb3 - PROXY.SGOV.expense + PROXY.SGOV.dm).toFixed(2),
    USFR: +(dtb3 - PROXY.USFR.expense + PROXY.USFR.dm).toFixed(2),
  };
}

// |proxy − published| in basis points, and whether it exceeds the re-fit threshold.
export function proxyDivergence(dtb3) {
  const est = secYieldProxy(dtb3);
  if (!est) return null;
  const out = {};
  for (const k of ['SGOV', 'USFR']) {
    const bp = Math.round((est[k] - SEC_YIELDS[k].value) * 100);
    out[k] = { est: est[k], published: SEC_YIELDS[k].value, bp, diverged: Math.abs(bp) > PROXY_DIVERGENCE_BP };
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
