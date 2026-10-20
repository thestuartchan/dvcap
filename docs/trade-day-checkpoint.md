# Trade-day call: cushion table reconciliation and the 10:00 / 10:30 checkpoint (20 Oct 2026)

Analysis only, market data only. Script: `scripts/trade-day-checkpoint-backtest.py` (fetch steps in its
header). No production code path changes.

Definitions: implied = prior-close VXN (QQQ) / VIX (SPX, SPY) ÷ 100 ÷ √252. R = session (high − low) ÷
open ÷ implied. FR30 / FR60 = range of 09:30–10:00 / 09:30–10:30 New York ÷ open ÷ implied. R_rest =
range from the checkpoint to the close ÷ checkpoint price ÷ the same full-day implied (so its typical
value is below 1).

## 1. Why the cushion table says 1.10× and the daily backtest said 1.27×

`lib/trendTells.js` `CUSHION` has no generating script in the repo; its comment gives the method
(SPX/QQQ daily since May 2011, range ÷ prior-close implied). Rebuilding it every way, the table is
reproduced exactly (to 0.01, one SPX cell 0.80 vs 0.81) by:

- **medians**, not means;
- **negative-GEX days removed from the <20th band** (they are their own `GEX negative` row, and
  `cushionBand()` checks the sign first);
- divisor open or prior close — makes no difference at two decimals;
- effective start May 2012 (the percentile needs 252 prior rows).

| QQQ band | all days: mean / median | GEX ≥ 0 only: median (table) |
|---|---|---|
| GEX < 0 (n 317) | 1.34 / 1.20 | 1.20 (1.20) |
| <20th (n 688 / 403) | 1.27 / 1.16 | 1.10 (1.10) |
| 20–40th | 1.08 / 1.01 | 1.01 (1.01) |
| ≥80th | 0.86 / 0.78 | 0.78 (0.78) |

SPX <20th: all days 1.16 mean / 1.06 median; GEX ≥ 0 median 1.02 (table 1.02). The 1.27 / 1.16 figure
counts the 285 negative-GEX days inside the <20th band; the table does not. Both are right for what they
measure; the table understates a "<20th" day only if the brief also files negative-GEX days there.

## 2. Pre-open model (unchanged)

log R ~ cushion + |gap|/implied + prior-day R + overnight IV change, fit 2012–2020, scored 2021–2026:
Spearman +0.33 (QQQ) / +0.39 (SPX), above/below-median hit 60% / 65%.

## 3. Does the first 30 / 60 minutes predict the rest of the day?

Data: TradingView regular-session bars — 30-minute from 2 Jan 2025 (446 sessions), hourly from 3 Jan
2023 (943 sessions), QQQ and SPY; full sessions only. Scored walk-forward (each day predicted by a
regression fitted on earlier days only; first 120 days are training only). The pre-open score is the
2012–2020 fit above, so it is out of sample throughout.

| Checkpoint (sample, scored n) | Pre-open only | First range only | Both | Δ Spearman (90% bootstrap) |
|---|---|---|---|---|
| QQQ 10:30, hourly 2023–26 (823) | +0.35 / 63% | +0.36 / 61% | **+0.42 / 65%** | +0.07 [+0.04, +0.10] |
| SPY 10:30, hourly 2023–26 (823) | +0.36 / 63% | +0.39 / 65% | **+0.43 / 67%** | +0.08 [+0.05, +0.11] |
| QQQ 10:00, 30m 2025–26 (326) | +0.25 / 62% | +0.28 / 60% | +0.31 / 63% | +0.06 [+0.00, +0.10] |
| SPY 10:00, 30m 2025–26 (326) | +0.27 / 60% | +0.35 / 61% | +0.36 / 61% | +0.09 [+0.04, +0.13] |
| QQQ 10:30, 30m 2025–26 (326) | +0.28 / 61% | +0.28 / 61% | +0.35 / 64% | +0.06 [+0.02, +0.10] |
| SPY 10:30, 30m 2025–26 (326) | +0.26 / 58% | +0.29 / 61% | +0.32 / 63% | +0.06 [+0.02, +0.09] |

Cells are Spearman vs R_rest / hit rate for R_rest above vs below its median. Mean R_rest by predicted
quartile, combined model, hourly sample: QQQ 0.63 / 0.75 / 0.79 / 1.00; SPY 0.60 / 0.69 / 0.77 / 0.96.

The first range adds to the pre-open call rather than repeating it (correlation between the two
+0.31 to +0.55). It matters most on pre-open **trade** days: QQQ hourly, trade-day calls with a first
hour above median went on to R_rest 1.12; with a first hour below median, 0.80 — a selective day. On
lean-skip days the first hour moves R_rest only 0.72 → 0.80.

### The existing tell: first-hour range > 0.5 × implied 1σ

It fires too often to be a filter: 57% of QQQ sessions, 33% of SPY (hourly sample). When it fires,
R_rest ≥ median 57% vs 41% (QQQ), 69% vs 41% (SPY). A higher bar separates better:

| First-hour range (× implied) | QQQ: share of days · R_rest ≥ median (vs rest) | SPY: share · R_rest ≥ median (vs rest) |
|---|---|---|
| > 0.50 | 57% · 57% vs 41% | 33% · 69% vs 41% |
| > 0.65 | 31% · 65% vs 43% | 16% · 75% vs 45% |
| > 0.80 | 15% · 75% vs 46% | 8% · 83% vs 47% |

Quartile cut-points (hourly sample): QQQ FR60 0.43 / 0.53 / 0.70; SPY 0.32 / 0.43 / 0.55.
At 10:00 (30m sample): QQQ FR30 0.33 / 0.41 / 0.54; SPY 0.25 / 0.32 / 0.42. FR30 > 0.50σ on QQQ
(31% of days): R_rest ≥ median 70% vs 41%. FR30 > 0.35σ on SPY (43%): 70% vs 35%.

### Suggested checkpoint bands (not wired in)

- 10:00 confirm: QQQ FR30 ≥ 0.50σ, SPY FR30 ≥ 0.40σ (≈ top quartile). Quiet: QQQ < 0.33σ, SPY < 0.25σ.
- 10:30 confirm: QQQ FR60 ≥ 0.70σ, SPY FR60 ≥ 0.55σ (top quartile). Quiet: QQQ < 0.43σ, SPY < 0.32σ.
- QQQ and SPY need different thresholds: on the same day QQQ's first range is larger against VXN than
  SPY's is against VIX.

## Caveats

- Short intraday record: hourly from 2023, 30-minute from 2025. The 2012–2026 daily result is the
  long test; the checkpoint numbers are a 2–4 year sample with one regime mix.
- SPY intraday is scored with SPX daily features and VIX; QQQ with VXN.
- "Full-day R ≥ 1" given a big first range is partly mechanical (the first range is part of the day);
  R_rest is the clean measure and is what the table and models use.

## Trend-day share (added 20 Oct 2026)

The two scripts also report, per checkpoint band, the share of sessions that ended a **trend day**: the close in the top or bottom 20% of the day's range, the trade-day call's P(trend) definition (`docs/signal-board-audit.md` §8). With the free Yahoo hourly bars (2024-10 → 2026-10, n 493), the 10:30 figures are:

| | quiet | middle | confirm | base |
|---|---|---|---|---|
| QQQ | 43% | 44% | 47% | 45% |
| SPY | 37% | 44% | 42% | 41% |

A wide first hour says the rest of the day will *move*. It says almost nothing about whether the day *closes at an extreme*. 10:00 is not reported, because the free 30-minute record is 60 sessions. The checkpoint backtest now skips, instead of failing, a checkpoint with fewer than the 120 sessions its walk-forward needs.
