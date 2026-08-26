// Regression tests for lib/cashyield.js — the yield conversions the cash-comparison card depends on.
import { apyFromSec, afterWht, billFromDiscount, BILL_DAYS, compareCash } from '../lib/cashyield.js';
let pass=0,fail=0;
const eq=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log(`${ok?'✅':'❌'} ${n}`+(ok?'':`  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`));ok?pass++:fail++;};

// ── SEC 30-day (annualised simple) → APY, monthly compounding ──
eq('USFR 3.71 -> APY', apyFromSec(3.71), 3.77);
eq('SGOV 3.57 -> APY', apyFromSec(3.57), 3.63);
eq('APY exceeds the simple rate', apyFromSec(5) > 5, true);
eq('zero stays zero', apyFromSec(0), 0);
eq('missing stays missing', apyFromSec(null), null);

// ── a T-bill DISCOUNT rate is not a yield ──
// FRED DTB3/DTB6 quote against FACE on a 360-day year; what the money earns is measured against
// the smaller PRICE on a 365-day year, so the yield is strictly above the quoted discount.
const six = billFromDiscount(3.80, BILL_DAYS['6M']);
eq('6M bill keeps its quoted discount', six.discount, 3.80);
eq('6M bill coupon-equivalent', six.couponEquiv, 3.93);
eq('6M bill effective annual', six.apy, 3.97);
eq('yield is above the discount rate', six.apy > six.discount, true);
eq('and the bill trades below par', six.price < 1, true);

const three = billFromDiscount(3.72, BILL_DAYS['3M']);
eq('3M bill coupon-equivalent', three.couponEquiv, 3.81);
eq('3M bill effective annual', three.apy, 3.86);
// The gap widens with maturity — the same discount rate is worth more on a longer bill.
eq('longer bill, wider gap', billFromDiscount(3.80, 182).apy - 3.80 > billFromDiscount(3.80, 91).apy - 3.80, true);

// Guard rails: the closed-form coupon-equivalent is only valid to 182 days.
eq('over 182 days refused', billFromDiscount(3.8, 270), null);
eq('nonsense refused', billFromDiscount('x', 182), null);
eq('zero refused', billFromDiscount(0, 182), null);

// A price that would go non-positive cannot produce a yield.
eq('absurd discount refused', billFromDiscount(300, 182), null);

// ── withholding ──
eq('0% WHT is a no-op', afterWht(3.77, 0), 3.77);
eq('15% WHT', afterWht(4, 15), 3.4);
eq('missing stays missing', afterWht(null, 15), null);

// ── the comparison picks the better fund on the chosen convention ──
const apyCmp = compareCash({ usfrSec: 3.71, sgovSec: 3.57, bankRate: 3.65, bankConvention: 'apy', positionUsd: 53418 });
eq('USFR wins on APY', apyCmp.best, 'USFR');
eq('edge over the deposit, bp', apyCmp.edgeVsBankBp, 12);
eq('dollar edge at size', apyCmp.dollarVsBank, 64);
eq('fund gap, bp', apyCmp.fundGapBp, 14);
// Withholding can flip the winner — the point of comparing after WHT rather than on the headline.
eq('WHT flips it', compareCash({ usfrSec: 3.71, sgovSec: 3.57, usfrWht: 20, bankConvention: 'apy' }).best, 'SGOV');

console.log(fail?`\n❌ ${fail} FAILED`:`\n✅ ALL ${pass} PASSED`);
process.exit(fail?1:0);
