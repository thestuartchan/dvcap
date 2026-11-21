# 9-to-1 volume days: backtest (12 Nov 2026)

The Signal Board's `vol_thrust` row (Tape area, **shown, not voted**). Script: `scripts/vol-thrust-backtest.py`.
Data refresh: `scripts/vol-thrust-history.py` → `data/nyse_updown_volume.json`.

## Answer first (SPY, 2000–2026, non-overlapping episodes, 9 months after)

| pattern | n | up | mean | median | all days |
|---|---|---|---|---|---|
| (a) any 90% down day | 24 | 75% | **+7.2%** | +8.8% | +7.2% · 76% up |
| (b) any 90% up day | 22 | 82% | **+8.4%** | +7.5% | +7.2% · 76% up |
| (c) two 90% up days within 5 sessions | 9 | 89% (8 of 9) | **+17.6%** | +18.6% | +7.2% · 76% up |
| (d) 90% down day → 90% up day within 10 sessions | 17 | 88% | **+12.5%** | +13.2% | +7.2% · 76% up |

- **(c) holds up.** SPY 8 of 9 positive, as Quantifiable Edges said; mean **+17.6%**, not their +25.5% (QQQ: 9 of 9, **+25.8%**). Random 9-session draws beat it 1% of the time.
- **(d) helps.** +12.5% vs +7.2% (p 0.06 SPY, 0.05 QQQ at 9m; p ≤ 0.01 at 3m).
- **(a) is no sell signal.** A lone 9-to-1 down day: 9m return = the base. 3m was better than base (+4.5% vs +2.4%), the usual washout bounce.
- **(b) alone: small edge**, not significant (p 0.36 at 9m).
- **Drawdown.** Next-3-month max drawdown after (c): median **−2.7%** vs −3.2% all days; after (a)/(b)/(d) ≈ the base.
- **Small n.** (c) has 9 episodes in 27 years, 3 since 2016. Hence shown, not voted.

## Now (to the 11 Nov 2026 close)

- **No 9-to-1 day in the last 20 sessions** — confirmed on TradingView's own daily series.
- Biggest: **5 Nov** 16.4% up = **5.1:1 down** (the brief said 4 Nov; on this series 4 Nov was 2.4:1 *up*, 5 Nov the down day).
- **9 Nov** 79.7% up = **3.9:1 up** (matches).
- Last 9-to-1 up day: **22 Aug 2025**. Last 9-to-1 down day: **21 May 2025**.

## Definitions

| item | rule |
|---|---|
| up share | NYSE up volume ÷ (up + down volume) |
| 90% up day | up share ≥ 0.90 (≈ 9:1) |
| 90% down day | up share ≤ 0.10 |
| 80% days | 0.80 / 0.20 — counted as context |
| entry | close of the session that completes the pattern |
| returns | SPY / QQQ dividend-adjusted closes (Yahoo), 21 / 63 / 126 / 189 sessions |
| max DD | lowest close in the next 63 sessions ÷ entry − 1 |
| non-overlapping | per horizon: a trigger counts only once the last counted one's horizon has passed |
| base | every session in the same window, same horizon (overlapping) |
| p | share of 5,000 random draws of the same number of sessions whose mean ≥ the pattern's |

## Row states (lib/volThrust.js)

| state | rule |
|---|---|
| thrust (on) | two 90% up days within the last 5 sessions, or a 90% up day in the last 5 with a 90% down day in the 10 sessions before it |
| capitulation (off) | a 90% down day in the last 5 sessions, no 90% up day since |
| neutral | otherwise |

Flags: `90up`, `90down` (today), `double90up`, `stale` (last print > 2 sessions old). `vote: false`; dim `tape`, so it sits with the Tape rows and no cluster counts it.

## Data

| source | use | span | note |
|---|---|---|---|
| **TradingView USI:UVOL / USI:DVOL** (daily, public chart websocket) | backtest + row | 1996-04-19 → | NYSE-traded volume in NYSE issues (~1bn/day in 2026) |
| Unicorn Research NYSE_advv / NYSE_declv | cross-check | 1965 → 2020-02-14 | site stopped updating Feb 2020; some rows sit on holidays |
| WSJ Markets Diary JSON | row fallback, today only, after 4 PM ET | live | consolidated volume (~4× TradingView) |
| Barchart $UVOL/$DVOL | not used | — | page needs a browser session; not a clean server source |

- **Cross-check 1996-04 → 2020-02** (n 5,980): daily up share correlation **0.945**, mean gap **1.7 pts**. 90% up days 113 (TV) vs 97 (Unicorn), 91 on both; 90% down days 183 vs 145, 141 on both. TradingView flags more extremes (2008–09, 2011).
- **Same test on Unicorn, 2000–2015:** (c) SPY 9m +10.8% mean, 5 of 6 up, vs +4.3% base; (d) +10.1% vs +4.3%. Direction holds; size smaller.
- **Daily update.** `.github/workflows/vol-thrust-history.yml` refreshes the file weekdays 22:20 UTC. The board also reads TradingView live (Node WebSocket) and, for today only, the WSJ diary. The live socket could not be tested from the build sandbox (its proxy blocks Node WebSockets); the Python path is tested.

## Full tables

Cells: `n · hit · median · mean`.

### SPY, 2000–2026

| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |
|---|---|---|---|---|---|---|
| all days (base) | — | 6736 · 64% · +1.4% · +0.8% | 6694 · 69% · +3.5% · +2.4% | 6631 · 73% · +6.4% · +4.8% | 6568 · 76% · +9.5% · +7.2% | -3.2% · -5.2% |
| (a) any 90% down day | 216 | 90 · 69% · +2.6% · +1.8% | 53 · 74% · +6.4% · +4.5% | 35 · 77% · +9.0% · +7.5% | 24 · 75% · +8.8% · +7.2% | -2.9% · -5.5% |
| (b) any 90% up day | 142 | 72 · 65% · +2.1% · +1.2% | 42 · 74% · +5.6% · +3.7% | 30 · 83% · +7.9% · +6.9% | 22 · 82% · +7.5% · +8.4% | -2.9% · -5.6% |
| (c) two 90% up days within 5 sessions | 27 | 19 · 74% · +3.5% · +3.3% | 15 · 87% · +6.9% · +6.9% | 11 · 82% · +12.4% · +11.5% | 9 · 89% · +18.6% · +17.6% | -2.7% · -3.7% |
| (d) 90% down day, then a 90% up day within 10 sessions | 94 | 46 · 65% · +2.8% · +1.5% | 27 · 82% · +7.4% · +6.0% | 20 · 90% · +12.1% · +10.0% | 17 · 88% · +13.2% · +12.5% | -3.0% · -5.7% |

### SPY, 2000–2015

| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |
|---|---|---|---|---|---|---|
| all days (base) | — | 4025 · 61% · +1.1% · +0.4% | 4025 · 63% · +2.5% · +1.3% | 4025 · 66% · +4.6% · +2.8% | 4025 · 70% · +7.0% · +4.3% | -3.8% · -5.8% |
| (a) any 90% down day | 155 | 60 · 65% · +2.0% · +1.6% | 34 · 76% · +6.0% · +4.0% | 22 · 68% · +6.0% · +5.2% | 16 · 69% · +7.9% · +6.4% | -3.0% · -5.5% |
| (b) any 90% up day | 100 | 50 · 60% · +1.0% · +0.4% | 28 · 64% · +2.8% · +2.0% | 20 · 75% · +5.8% · +3.3% | 14 · 71% · +7.2% · +4.3% | -3.0% · -6.0% |
| (c) two 90% up days within 5 sessions | 21 | 15 · 67% · +1.4% · +2.8% | 11 · 82% · +6.9% · +6.4% | 8 · 75% · +9.8% · +9.5% | 6 · 83% · +18.0% · +13.2% | -3.1% · -4.2% |
| (d) 90% down day, then a 90% up day within 10 sessions | 72 | 35 · 63% · +1.3% · +1.2% | 20 · 80% · +7.3% · +5.3% | 14 · 86% · +9.6% · +7.5% | 11 · 82% · +13.2% · +9.9% | -2.9% · -5.3% |

### SPY, 2016–2026

| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |
|---|---|---|---|---|---|---|
| all days (base) | — | 2711 · 70% · +1.8% · +1.3% | 2669 · 79% · +4.6% · +3.9% | 2606 · 83% · +8.7% · +7.9% | 2543 · 87% · +12.7% · +11.8% | -2.4% · -4.3% |
| (a) any 90% down day | 61 | 30 · 77% · +3.7% · +2.1% | 19 · 68% · +6.8% · +5.4% | 13 · 92% · +11.0% · +11.3% | 8 · 88% · +12.3% · +8.7% | -2.2% · -5.5% |
| (b) any 90% up day | 42 | 22 · 77% · +3.4% · +2.9% | 15 · 93% · +7.2% · +7.3% | 11 · 100% · +16.6% · +14.3% | 9 · 100% · +17.3% · +16.1% | -2.4% · -4.6% |
| (c) two 90% up days within 5 sessions | 6 | 4 · 100% · +5.8% · +5.1% | 4 · 100% · +6.8% · +8.3% | 3 · 100% · +13.2% · +17.0% | 3 · 100% · +21.4% · +24.4% | -1.6% · -2.2% |
| (d) 90% down day, then a 90% up day within 10 sessions | 22 | 11 · 73% · +2.9% · +2.2% | 8 · 88% · +9.0% · +8.5% | 7 · 100% · +16.0% · +15.2% | 6 · 100% · +18.4% · +17.8% | -5.1% · -6.3% |

### QQQ, 2000–2026

| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |
|---|---|---|---|---|---|---|
| all days (base) | — | 6736 · 62% · +1.6% · +0.9% | 6694 · 68% · +4.2% · +2.7% | 6631 · 73% · +8.7% · +5.7% | 6568 · 75% · +13.1% · +8.8% | -4.3% · -7.2% |
| (a) any 90% down day | 216 | 90 · 68% · +2.7% · +2.2% | 53 · 76% · +8.4% · +6.8% | 35 · 83% · +10.6% · +10.6% | 24 · 71% · +14.8% · +10.4% | -3.6% · -6.3% |
| (b) any 90% up day | 142 | 72 · 67% · +2.2% · +1.4% | 42 · 74% · +7.4% · +4.8% | 30 · 73% · +8.0% · +9.2% | 22 · 77% · +6.8% · +11.5% | -3.0% · -6.9% |
| (c) two 90% up days within 5 sessions | 27 | 19 · 79% · +1.4% · +3.5% | 15 · 80% · +8.3% · +9.4% | 11 · 82% · +16.5% · +15.1% | 9 · 100% · +26.7% · +25.8% | -1.4% · -3.1% |
| (d) 90% down day, then a 90% up day within 10 sessions | 94 | 46 · 70% · +3.0% · +1.9% | 27 · 85% · +9.3% · +7.9% | 20 · 85% · +16.2% · +13.3% | 17 · 94% · +19.6% · +17.0% | -3.2% · -6.1% |

### QQQ, 2000–2015

| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |
|---|---|---|---|---|---|---|
| all days (base) | — | 4025 · 59% · +1.2% · +0.4% | 4025 · 62% · +3.0% · +1.0% | 4025 · 66% · +5.8% · +2.4% | 4025 · 67% · +7.7% · +4.0% | -5.0% · -8.4% |
| (a) any 90% down day | 155 | 60 · 65% · +2.3% · +2.0% | 34 · 74% · +8.4% · +6.2% | 22 · 82% · +9.2% · +8.2% | 16 · 62% · +13.2% · +8.7% | -3.3% · -6.2% |
| (b) any 90% up day | 100 | 50 · 62% · +1.6% · +0.5% | 28 · 64% · +5.6% · +2.0% | 20 · 65% · +3.6% · +3.9% | 14 · 71% · +4.3% · +5.6% | -3.2% · -7.7% |
| (c) two 90% up days within 5 sessions | 21 | 15 · 73% · +0.8% · +2.9% | 11 · 82% · +8.3% · +8.9% | 8 · 75% · +15.6% · +11.7% | 6 · 100% · +20.6% · +18.7% | -1.4% · -3.2% |
| (d) 90% down day, then a 90% up day within 10 sessions | 72 | 35 · 69% · +2.6% · +1.7% | 20 · 85% · +8.9% · +6.8% | 14 · 86% · +12.9% · +9.7% | 11 · 91% · +12.3% · +12.8% | -3.2% · -5.8% |

### QQQ, 2016–2026

| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |
|---|---|---|---|---|---|---|
| all days (base) | — | 2711 · 68% · +2.2% · +1.7% | 2669 · 77% · +5.8% · +5.2% | 2606 · 83% · +11.9% · +10.8% | 2543 · 88% · +18.7% · +16.4% | -3.3% · -5.4% |
| (a) any 90% down day | 61 | 30 · 73% · +2.9% · +2.7% | 19 · 79% · +9.2% · +7.8% | 13 · 85% · +15.8% · +14.7% | 8 · 88% · +16.3% · +12.3% | -4.7% · -6.5% |
| (b) any 90% up day | 42 | 22 · 77% · +4.2% · +3.6% | 15 · 93% · +9.8% · +10.0% | 11 · 91% · +21.6% · +18.9% | 9 · 89% · +24.8% · +21.7% | -2.2% · -5.3% |
| (c) two 90% up days within 5 sessions | 6 | 4 · 100% · +5.8% · +6.1% | 4 · 75% · +7.8% · +10.9% | 3 · 100% · +17.1% · +22.7% | 3 · 100% · +35.1% · +35.6% | -2.4% · -3.1% |
| (d) 90% down day, then a 90% up day within 10 sessions | 22 | 11 · 73% · +4.5% · +2.5% | 8 · 88% · +9.9% · +10.3% | 7 · 86% · +18.0% · +19.3% | 6 · 100% · +21.5% · +24.1% | -6.8% · -6.9% |

### (c) every trigger, and the non-overlapping 9-month episodes (*)

| date | SPY 1m | SPY 3m | SPY 9m | QQQ 9m | SPY max DD 3m |
|---|---|---|---|---|---|
| 2007-08-31 * | +4.9% | +1.2% | -5.0% | +0.8% | -4.0% |
| 2007-11-28 | +0.6% | -8.6% | -10.2% | -8.3% | -10.7% |
| 2008-11-26 * | -1.5% | -20.0% | +18.6% | +38.4% | -20.0% |
| 2009-03-12 | +14.5% | +26.5% | +48.3% | +54.3% | +0.0% |
| 2009-03-17 | +11.4% | +18.1% | +45.6% | +52.5% | -1.2% |
| 2009-03-23 | +2.8% | +9.2% | +36.2% | +44.4% | -4.2% |
| 2009-07-15 | +8.9% | +15.8% | +31.9% | +36.3% | -0.2% |
| 2010-05-27 * | -2.5% | -4.5% | +21.3% | +26.7% | -7.3% |
| 2010-06-02 | -6.4% | -4.1% | +20.8% | +24.6% | -6.9% |
| 2010-06-15 | -1.6% | +1.1% | +16.6% | +19.8% | -8.3% |
| 2010-07-13 | -0.3% | +6.9% | +22.6% | +25.9% | -4.0% |
| 2010-09-01 | +6.2% | +12.2% | +23.3% | +28.5% | +0.0% |
| 2010-09-03 | +5.2% | +11.4% | +18.1% | +22.2% | -1.1% |
| 2010-12-01 | +4.5% | +10.9% | +2.5% | +4.1% | +0.0% |
| 2011-08-11 * | -0.6% | +5.5% | +17.4% | +21.8% | -5.8% |
| 2011-08-15 | -1.0% | +5.6% | +12.3% | +17.4% | -8.4% |
| 2011-10-10 | +6.9% | +8.7% | +14.0% | +13.5% | -2.7% |
| 2011-11-30 | +1.0% | +10.6% | +14.2% | +21.0% | -3.1% |
| 2012-11-23 * | +1.4% | +6.9% | +19.4% | +19.5% | -0.7% |
| 2013-01-02 | +3.5% | +7.2% | +17.5% | +19.5% | -0.3% |
| 2015-08-27 * | -5.2% | +5.6% | +7.2% | +5.1% | -5.2% |
| 2016-01-29 | +2.3% | +7.1% | +11.7% | +14.1% | -5.6% |
| 2016-06-28 * | +6.7% | +6.6% | +17.7% | +27.6% | +0.0% |
| 2016-06-29 | +5.1% | +5.4% | +16.1% | +25.5% | +0.0% |
| 2020-04-08 * | +6.7% | +15.2% | +40.1% | +57.6% | -0.4% |
| 2022-10-03 * | +4.9% | +4.4% | +21.4% | +35.1% | -2.7% |
| 2022-10-04 | -0.8% | +2.0% | +17.4% | +30.5% | -5.7% |

### Last 20 sessions (TradingView)

| date | up share | ratio |
|---|---|---|
| 2026-10-15 | 73.5% | 2.8:1 up |
| 2026-10-16 | 46.0% | 1.2:1 down |
| 2026-10-19 | 34.0% | 1.9:1 down |
| 2026-10-20 | 74.3% | 2.9:1 up |
| 2026-10-21 | 47.6% | 1.1:1 down |
| 2026-10-22 | 56.6% | 1.3:1 up |
| 2026-10-23 | 37.5% | 1.7:1 down |
| 2026-10-26 | 44.0% | 1.3:1 down |
| 2026-10-27 | 53.5% | 1.2:1 up |
| 2026-10-28 | 47.3% | 1.1:1 down |
| 2026-10-29 | 69.6% | 2.3:1 up |
| 2026-10-30 | 38.0% | 1.6:1 down |
| 2026-11-02 | 64.8% | 1.8:1 up |
| 2026-11-03 | 37.6% | 1.7:1 down |
| 2026-11-04 | 70.2% | 2.4:1 up |
| 2026-11-05 | 16.4% | 5.1:1 down |
| 2026-11-06 | 47.9% | 1.1:1 down |
| 2026-11-09 | 79.7% | 3.9:1 up |
| 2026-11-10 | 38.4% | 1.6:1 down |
| 2026-11-11 | 56.7% | 1.3:1 up |

Unicorn cross-check 1996-04-19 → 2020-02-10 (n 5980): corr 0.945, mean |gap| 1.7 pts; 90% up days 113 vs 97 (both 91); 90% down 183 vs 145 (both 141)

### SPY, 2000–2015, on the Unicorn series (cross-check)

| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |
|---|---|---|---|---|---|---|
| all days (base) | — | 4025 · 61% · +1.1% · +0.4% | 4025 · 63% · +2.5% · +1.3% | 4025 · 66% · +4.6% · +2.8% | 4025 · 70% · +7.0% · +4.3% | -3.8% · -5.8% |
| (a) any 90% down day | 124 | 56 · 62% · +1.3% · +1.2% | 33 · 73% · +6.3% · +3.7% | 22 · 73% · +6.0% · +5.1% | 16 · 69% · +7.9% · +5.8% | -3.4% · -5.7% |
| (b) any 90% up day | 88 | 47 · 60% · +1.6% · +0.5% | 27 · 59% · +1.9% · +1.3% | 19 · 74% · +5.6% · +3.3% | 13 · 77% · +7.4% · +4.6% | -2.7% · -6.1% |
| (c) two 90% up days within 5 sessions | 16 | 12 · 58% · +1.0% · +1.7% | 9 · 67% · +5.5% · +5.0% | 7 · 71% · +9.6% · +6.3% | 6 · 83% · +11.2% · +10.8% | -4.0% · -5.4% |
| (d) 90% down day, then a 90% up day within 10 sessions | 54 | 30 · 67% · +3.1% · +1.7% | 18 · 78% · +6.4% · +5.7% | 13 · 85% · +11.1% · +8.0% | 10 · 80% · +11.3% · +10.1% | -1.9% · -4.4% |

### QQQ, 2000–2015, on the Unicorn series (cross-check)

| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |
|---|---|---|---|---|---|---|
| all days (base) | — | 4025 · 59% · +1.2% · +0.4% | 4025 · 62% · +3.0% · +1.0% | 4025 · 66% · +5.8% · +2.4% | 4025 · 67% · +7.7% · +4.0% | -5.0% · -8.4% |
| (a) any 90% down day | 124 | 56 · 59% · +1.4% · +1.2% | 33 · 73% · +8.4% · +5.9% | 22 · 82% · +9.2% · +8.2% | 16 · 62% · +8.8% · +7.7% | -3.8% · -6.6% |
| (b) any 90% up day | 88 | 47 · 62% · +1.6% · +0.5% | 27 · 59% · +3.9% · +0.8% | 19 · 63% · +3.7% · +3.9% | 13 · 69% · +4.1% · +5.8% | -4.9% · -7.8% |
| (c) two 90% up days within 5 sessions | 16 | 12 · 75% · +0.8% · +2.0% | 9 · 67% · +5.0% · +6.6% | 7 · 71% · +12.8% · +7.1% | 6 · 100% · +18.5% · +16.2% | -1.4% · -5.5% |
| (d) 90% down day, then a 90% up day within 10 sessions | 54 | 30 · 70% · +3.0% · +1.8% | 18 · 83% · +8.7% · +7.2% | 13 · 85% · +13.7% · +10.1% | 10 · 80% · +13.6% · +13.2% | -2.2% · -4.8% |

### Pattern mean vs random draws of the same size (2000–2026; p = share of draws ≥ the pattern)

| pattern | SPY 3m mean · p | SPY 9m mean · p | QQQ 3m mean · p | QQQ 9m mean · p |
|---|---|---|---|---|
| (a) any 90% down day | +4.5% · 0.02 | +7.2% · 0.51 | +6.7% · 0.00 | +10.4% · 0.37 |
| (b) any 90% up day | +3.7% · 0.12 | +8.4% · 0.36 | +4.8% · 0.11 | +11.5% · 0.29 |
| (c) two 90% up days within 5 sessions | +6.9% · 0.01 | +17.6% · 0.01 | +9.4% · 0.01 | +25.8% · 0.00 |
| (d) 90% down day, then a 90% up day within 10 sessions | +6.0% · 0.00 | +12.5% · 0.06 | +7.9% · 0.01 | +17.0% · 0.05 |
