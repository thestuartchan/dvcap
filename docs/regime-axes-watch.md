# Regime axes — the watching cycles

The measured quadrant (growth axis × inflation axis, `lib/quadrant.js`) is logged every weekday
beside the consensus regime and drives nothing yet. **Step 3** of the plan is letting the axes
drive the regime, with the consensus as a decaying prior. This file holds what each watching
cycle found and the bar for step 3, written down before the cycle runs so the result can't move it.

## Cycle 1 — 2026-09-14 → 2026-10-15

- 29 log rows (24 written by the cron). The consensus didn't move, so 0/16 agreement shows the
  axes moved while the prior stayed put. It doesn't show which was right.
- **Inflation market leg changed verdict seven times.** Both breakevens stayed in their 2.0–2.5
  band throughout. Every change was oil's 20-session move crossing ±10% and back.
- **Weekly growth leg read 3 of 4 on 15 Oct.** That row was written at 08:36 ET, before FRED had
  posted the morning's weekly prints. The previous week's prints were a day past a tolerance set
  to the exact day.
- **Label vs quadrant.** "Turning hot" was logged next to a quadrant that read inflation as cool,
  and "turning cool" next to one that read it as hot. The state names where the legs are heading;
  the quadrant uses their sum. Both were right, but nothing on screen said so.
- The nowcast updated daily. It read BETWEEN throughout because core CPI (≤ 2.5) and core PCE
  (> 3.0) cancel each other. That's a genuine split, not a stuck feed.

## Changes for cycle 2

| Change | Where |
|---|---|
| Oil impulse held until the 20-session move is back inside ±5% (enters at ±10%) | `OIL_EXIT_PCT`, `lib/inflationAxis.js` |
| Breakeven bands left 5bp inside the line (hot until < 2.45, cold until > 2.05) | `BE_EXIT_BP`, `lib/inflationAxis.js` |
| Weekly tolerances: release-morning age + 1 (claims 10, continuing 15, WEI 10) | `GROWTH_SERIES`, `lib/growth.js` |
| Every axis carries `balance`; non-confirmed reads open "On balance …", and the card shows "leans …" | `lib/growth.js`, `lib/inflationAxis.js`, `src/App.jsx` |

The hysteresis is walked from the series on every read. No state is stored.

## Cycle 2 — 2026-10-16 → 2026-11-12

Prints inside the window:

| Date | Print |
|---|---|
| 28 Oct | FOMC (no dots) |
| 29 Oct | Sep core PCE, Q3 GDP advance |
| 2 Nov | ISM manufacturing (Oct) — hand-keyed |
| 4 Nov | ISM services (Oct) — hand-keyed |
| 10 Nov | Oct CPI |

The check runs on 12 Nov, after the 11 and 12 Nov cron rows have picked up the CPI print.

### Step-3 bar (all of 1–4 must pass)

1. **Coverage.** The quadrant is non-null on ≥ 80% of weekday cron rows.
2. **Stability.**
   - The inflation market leg changes verdict ≤ 3 times.
   - The quadrant changes ≤ 2 times on days with no new print. CPI, PCE, ISM and GDP days count as prints; daily market data doesn't.
3. **Data health.**
   - The weekly growth leg is 4/4 on ≥ 90% of rows.
   - The monthly leg is ≥ 3/4 on every row.
   - The ISM entry is never past its 35-day limit.
4. **Explainable.** Every quadrant change traces to a named leg verdict change in the log.

**Not a criterion:** agreement with the consensus. The consensus is gated on the 9 Dec FOMC and
won't move inside the window. Instead, for each disagreement, record which side the next print
(29 Oct PCE/GDP, 10 Nov CPI) supported.

### Outcome

- **Pass:** propose step 3 as its own PR. The axes feed the regime behind a flag, the consensus
  decays as the prior, and nothing else changes in that PR.
- **Fail on 1–3:** fix the named cause and run one more cycle, ending before the 9 Dec consensus
  refresh so the next comparison isn't against a stale prior.
- **Fail on 4:** stop. The axes aren't explainable enough to lead.
