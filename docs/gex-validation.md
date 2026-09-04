# GEX validation against QuantWheel

Five sessions of side-by-side readings before the flip is trusted for sizing. The
walls are the primary check — they are strike locations, so they barely move with
spot or time decay, and a disagreement there is a real problem in the weighting or
the strike band. The flip is next. Absolute net GEX is convention-dependent and is
NOT expected to match.

## Day 1 — 2026-09-04

Theirs at 09:45 ET (15 min after the open). Ours is the 2026-09-03 capture — a day
older, because our snapshot had not yet run. Noted rather than corrected: it makes
the walls comparison stronger (they survived a day) and the flip comparison weaker.

| | QuantWheel 09-04 09:45 ET | dvcap 09-03 capture | |
|---|---|---|---|
| spot | 720.10 | 718.68 | |
| call wall | **720** | **720.00** | exact |
| put wall | **700** | **700.00** | exact |
| gamma flip | 716.63 | 713.68 | **2.95 apart** |
| regime | Positive | Positive gamma — moves damp | agree |

Both walls exact and the regime agrees on day one. That is the outcome that
matters most, and it is better than expected.

### The flip gap has two candidate causes, and neither is arithmetic

**1. We carry far-dated expiries they do not display.** Ours includes 2026-10-16
(−$154.3M) and 2026-12-18 (−$370.8M); their board stops at Sep 18. Those two are
large and NEGATIVE, and a negative far-dated block pulls a flip DOWN — which is the
direction ours is off.

**2. Our strike band is four times wider.** We take ±10% of spot (648–792); their
grid runs roughly 685–730, about ±2.5%. On the one expiry both show, ours reads
$1.33B against their 249.4M — a ratio consistent with counting far more strikes
rather than with a scaling error.

### And a real gap in what we sample

They show ten expiries in the front fortnight: Sep 4, 8, 9, 10, 11, 14, 15, 16, 17,
18. We take six by rule — front weekly, two more weeklies, front monthly, next
monthly, next quarterly — and so miss Sep 9, 10, 11, 14, 15, 16 and 17 entirely.
QQQ has daily expiries now and `pickExpiries` predates that.

In their numbers those seven sum to about 77M against Sep 4's 249M, so this is not
what explains the flip gap. It is worth fixing on its own terms.

### Deliberately not acting yet

One day cannot separate a systematic offset from the hours between two readings.
If the flip is consistently ~3 points low across five sessions, the far-dated
expiries and the band are the things to test — in that order, and one at a time.
If it scatters, it is the timing difference and there is nothing to fix.

## Day 2 —

## Day 3 —

## Day 4 —

## Day 5 —
