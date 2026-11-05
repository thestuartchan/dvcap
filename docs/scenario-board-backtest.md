# Scenario board backtest

**Answer first:** the board describes the tape well and forecasts it poorly. Most scenarios are followed by roughly the base 20-session return, and most **relative** moves reverse rather than continue. Three held up in both halves of the decade: **Reflation**, **Small caps on falling yields** and **Memory loses leadership** (all SMH well above base).

## Recommendation (Stu approved 5 Nov 2026; the tables below include the two dropped scenarios as tested)

| Scenario | Keep? | Why |
|---|---|---|
| **Reflation** | Keep | SMH +5.3% / +6.3% in the two halves vs base +2.7% / +1.9%; 80% of episodes up |
| **Small caps on falling yields** | Keep | SPY, QQQ and SMH up in 84% of episodes; above base in both halves. Small caps themselves did not keep beating the S&P (44%, = base) |
| **Memory loses leadership** | Keep | SMH +4.0% / +4.1% vs base; the memory-vs-semis spread kept going in 54% (+1.4 pts vs +0.1 base) — the only spread that continued |
| **Soft landing** | Keep | SMH above base in both halves; cap-weight led |
| **AI leadership resumes** | Keep | Mirror of AI leadership breaks |
| **Rotation out of mega-caps** | Keep (as a description) | Active now; the equal-weight edge **reversed** in 69% of episodes |
| **Defensive rotation** | Keep | Active now; not a duplicate (Credit crack shares 47% of its days) |
| **Software over semis** | Keep (as a description) | Names the software-vs-chips theme; the spread **reversed** in 60% of episodes (−0.9 pts) |
| **Selling exhausting** (reworked) | Keep | Now gated on a credit crack or CTA de-risking in the last 10 sessions. After it fires, the sell-off resumed **35%** of the time vs **48%** on other post-sell-off days; median run 5 sessions (was 3) |
| **Re-risking** | Dropped (5 Nov) | Shares 74% of its days with Soft landing |
| **Carry rebuilds** | Dropped (5 Nov) | Shares 78% of its days with Soft landing; a USD/JPY level alert covers the intervention case better |

- **The adverse scenarios are followed by above-base returns** (Credit crack: SPY +2.4%, 73% up). They describe a sell-off that has already happened; they are not sell signals.
- **Posture:** supportive scenarios take 0.5 off the risk-off score when active (like Duration bid holds). Rotations and the book's relative scenarios (software, memory) leave it unchanged.

- **Window:** 2017-02-03 → 2026-11-04, 2452 sessions (Yahoo daily, 10y)
- **Engine:** `evaluateBoard` from lib/scenarioBoard.js, walked over every session — same legs, thresholds and hysteresis as the live board
- **Episode:** a run of ACTIVE sessions; runs 3 or fewer sessions apart are merged
- **After:** open of the session after the scenario switches on → close 20 sessions later, log %, median across episodes; "up" = share of episodes positive
- **Base:** the same 20-session return from every session: SPY +1.6% (68% up), QQQ +2.0% (67%), SMH +2.5% (64%), equal-weight − SPY −0.3 pts (41%), TLT −0.4% (46%)
- **Small samples:** most scenarios have 10–40 episodes in ten years. Treat a median from fewer than 15 as a hint, not a rate.

## How often, and for how long

| Scenario | Group | Now | Active % of sessions | Building % | Episodes | Median length | Longest | Last started | Most often alongside |
|---|---|---|---|---|---|---|---|---|---|
| Duration bid holds | Rates & growth | building | 14% | 17% | 52 | 5 | 32 | 2026-10-29 | AI leadership resumes (38%) |
| Term-premium break | Rates & growth | quiet | 9% | 28% | 39 | 4 | 21 | 2026-07-29 | Soft landing (25%) |
| Hawkish repricing | Rates & growth | quiet | 13% | 14% | 35 | 8 | 38 | 2026-09-16 | AI leadership resumes (26%) |
| Growth scare | Rates & growth | building | 5% | 8% | 19 | 3 | 30 | 2025-11-26 | Credit crack (81%) |
| Stagflation squeeze | Rates & growth | quiet | 2% | 10% | 14 | 3 | 14 | 2026-03-03 | Credit crack (62%) |
| Credit crack | Risk-off | active | 12% | 9% | 35 | 6 | 29 | 2026-10-30 | Systematic de-risking (45%) |
| Yen carry unwind | Risk-off | building | 6% | 7% | 23 | 3 | 18 | 2026-10-23 | Credit crack (86%) |
| Systematic de-risking | Risk-off | active | 7% | 12% | 45 | 4 | 18 | 2026-11-02 | Credit crack (78%) |
| AI leadership breaks | Your book | active | 12% | 8% | 38 | 6 | 22 | 2026-10-16 | Rotation out of mega-caps (51%) |
| **Soft landing** (new) | Risk-on & recovery | quiet | 18% | 18% | 57 | 6 | 30 | 2026-08-21 | Carry rebuilds (39%) |
| **Re-risking** (new) | Risk-on & recovery | quiet | 8% | 19% | 49 | 4 | 10 | 2026-10-08 | Soft landing (74%) |
| **Selling exhausting** (new) | Risk-on & recovery | quiet | 9% | 3% | 47 | 5 | 12 | 2026-10-29 | Credit crack (23%) |
| **Reflation** (new) | Risk-on & recovery | quiet | 10% | 15% | 35 | 5 | 37 | 2026-08-25 | AI leadership resumes (41%) |
| **Rotation out of mega-caps** (new) | Rotation | active | 15% | 9% | 37 | 8 | 28 | 2026-10-20 | AI leadership breaks (40%) |
| **Defensive rotation** (new) | Rotation | active | 11% | 20% | 35 | 4 | 29 | 2026-10-22 | Credit crack (47%) |
| **AI leadership resumes** (new) | Your book | quiet | 26% | 18% | 51 | 10 | 40 | 2026-09-22 | Soft landing (28%) |
| **Software over semis** (new) | Your book | quiet | 15% | 18% | 43 | 7 | 30 | 2026-10-26 | Duration bid holds (21%) |
| **Memory loses leadership** (new) | Your book | building | 13% | 26% | 54 | 4 | 21 | 2026-03-31 | Software over semis (24%) |
| **Carry rebuilds** (new) | Risk-on & recovery | quiet | 9% | 22% | 41 | 4 | 22 | 2026-10-08 | Soft landing (78%) |
| **Small caps on falling yields** (new) | Rotation | building | 6% | 22% | 25 | 6 | 26 | 2026-06-16 | Duration bid holds (38%) |

## What followed over the next 20 sessions (median %, share of episodes up)

| Scenario | n | SPY | QQQ | SMH | Equal-weight − SPY | TLT |
|---|---|---|---|---|---|---|
| *Base (every session)* | 2452 | +1.6 · 68% | +2.0 · 67% | +2.5 · 64% | −0.3 · 41% | −0.4 · 46% |
| Duration bid holds | 51 | +1.8 · 65% | +0.9 · 65% | +2.7 · 63% | −0.1 · 43% | −0.8 · 37% |
| Term-premium break | 39 | +1.7 · 74% | +2.2 · 67% | +2.0 · 69% | −0.3 · 44% | −0.6 · 46% |
| Hawkish repricing | 35 | +0.8 · 69% | +1.8 · 69% | +2.2 · 57% | −0.3 · 37% | −0.1 · 49% |
| Growth scare | 19 | +2.4 · 79% | +2.2 · 74% | +4.9 · 74% | −0.3 · 42% | +0.5 · 58% |
| Stagflation squeeze | 14 | +1.5 · 64% | +2.3 · 71% | −0.3 · 43% | −0.1 · 50% | −1.8 · 21% |
| Credit crack | 33 | +2.4 · 73% | +2.9 · 73% | +1.7 · 67% | −0.3 · 45% | −1.9 · 36% |
| Yen carry unwind | 22 | +2.4 · 64% | +2.7 · 64% | +3.4 · 68% | −0.3 · 45% | −0.4 · 45% |
| Systematic de-risking | 43 | +2.3 · 70% | +2.2 · 70% | +3.1 · 63% | +0.2 · 51% | −1.3 · 33% |
| AI leadership breaks | 37 | +1.3 · 62% | +1.8 · 65% | +2.3 · 65% | −0.2 · 46% | −2.1 · 27% |
| **Soft landing** | 57 | +1.6 · 72% | +2.7 · 70% | +4.4 · 68% | −0.7 · 33% | −0.5 · 49% |
| **Re-risking** | 48 | +1.5 · 69% | +2.5 · 65% | +3.3 · 65% | −0.2 · 46% | +0.4 · 56% |
| **Selling exhausting** | 46 | +2.0 · 65% | +2.4 · 63% | +1.8 · 57% | −0.2 · 46% | −0.7 · 41% |
| **Reflation** | 35 | +1.7 · 74% | +3.7 · 74% | +5.5 · 80% | −0.5 · 46% | +0.1 · 51% |
| **Rotation out of mega-caps** | 36 | +1.9 · 67% | +2.5 · 72% | +3.5 · 61% | −0.7 · 31% | −1.2 · 33% |
| **Defensive rotation** | 34 | +2.2 · 71% | +2.1 · 76% | +1.7 · 62% | −0.4 · 38% | −1.5 · 41% |
| **AI leadership resumes** | 51 | +2.2 · 78% | +2.3 · 69% | +3.8 · 67% | −0.5 · 41% | −0.5 · 45% |
| **Software over semis** | 42 | +1.5 · 69% | +1.7 · 60% | +0.1 · 50% | −0.1 · 48% | −1.6 · 38% |
| **Memory loses leadership** | 54 | +2.0 · 70% | +3.0 · 78% | +4.0 · 65% | −0.5 · 28% | +0.4 · 52% |
| **Carry rebuilds** | 40 | +1.9 · 68% | +2.8 · 70% | +1.6 · 57% | −0.4 · 40% | +1.2 · 65% |
| **Small caps on falling yields** | 25 | +2.5 · 84% | +3.8 · 84% | +4.1 · 84% | −0.4 · 40% | −1.7 · 28% |

## Does it hold in both halves? (2017-02-03 → 2021-12-16 | 2021-12-16 → 2026-11-04; median 20-session %, n episodes)

| Scenario | SPY 1st | SPY 2nd | SMH 1st | SMH 2nd | EW−SPY 1st | EW−SPY 2nd |
|---|---|---|---|---|---|---|
| *Base* | +1.8 | +1.4 | +2.7 | +1.9 | −0.3 | −0.3 |
| Duration bid holds | +2.2 (31) | +0.9 (20) | +2.8 (31) | +1.3 (20) | −0.1 (31) | −0.1 (20) |
| Term-premium break | +0.9 (18) | +3.5 (21) | +0.3 (18) | +4.8 (21) | +0.3 (18) | −0.4 (21) |
| Hawkish repricing | +2.1 (14) | +0.3 (21) | +2.5 (14) | +0.8 (21) | −0.5 (14) | −0.3 (21) |
| Growth scare | +1.6 (11) | +4.5 (8) | +1.3 (11) | +7.2 (8) | −0.3 (11) | −0.5 (8) |
| Stagflation squeeze | +1.9 (7) | −1.3 (7) | +2.6 (7) | −2.2 (7) | −0.3 (7) | +0.4 (7) |
| Credit crack | +2.4 (17) | +3.3 (16) | +1.4 (17) | +2.5 (16) | −0.3 (17) | −0.1 (16) |
| Yen carry unwind | +2.5 (14) | +0.0 (8) | +3.6 (14) | +1.6 (8) | −0.3 (14) | +0.2 (8) |
| Systematic de-risking | +2.4 (19) | +2.0 (24) | +3.1 (19) | +2.5 (24) | +0.7 (19) | −0.4 (24) |
| AI leadership breaks | +1.3 (13) | +1.0 (24) | +2.3 (13) | +3.1 (24) | −0.2 (13) | −0.4 (24) |
| **Soft landing** | +1.6 (30) | +1.2 (27) | +4.5 (30) | +3.0 (27) | −0.8 (30) | −0.5 (27) |
| **Re-risking** | +1.8 (23) | +1.2 (25) | +3.6 (23) | +1.7 (25) | −0.5 (23) | −0.1 (25) |
| **Selling exhausting** | +2.3 (21) | +1.9 (25) | +3.8 (21) | −0.7 (25) | −0.1 (21) | −0.4 (25) |
| **Reflation** | +2.9 (19) | +1.4 (16) | +5.3 (19) | +6.3 (16) | −0.5 (19) | −0.2 (16) |
| **Rotation out of mega-caps** | +2.1 (14) | +1.3 (22) | +4.2 (14) | +0.7 (22) | −0.8 (14) | −0.2 (22) |
| **Defensive rotation** | +2.5 (20) | +2.0 (14) | +2.5 (20) | +0.7 (14) | −0.5 (20) | −0.2 (14) |
| **AI leadership resumes** | +2.2 (30) | +2.3 (21) | +4.0 (30) | +1.0 (21) | −0.4 (30) | −0.5 (21) |
| **Software over semis** | +1.9 (23) | +0.5 (19) | +1.4 (23) | −0.5 (19) | −0.1 (23) | +0.4 (19) |
| **Memory loses leadership** | +2.0 (34) | +1.5 (20) | +4.0 (34) | +4.1 (20) | −0.5 (34) | −0.8 (20) |
| **Carry rebuilds** | +1.8 (22) | +2.1 (18) | +1.6 (22) | +2.0 (18) | −0.5 (22) | −0.0 (18) |
| **Small caps on falling yields** | +2.2 (13) | +2.8 (12) | +4.1 (13) | +5.0 (12) | −0.4 (13) | −0.4 (12) |

## Does the relative move continue? (next 20 sessions, in the scenario's direction)

| Scenario | Spread | Episodes | Median, scenario's way | Share continuing | Base median | Base share |
|---|---|---|---|---|---|---|
| Rotation out of mega-caps | Equal-weight − S&P | 36 | −0.7 pts | 31% | −0.3 pts | 41% |
| Small caps on falling yields | Small caps − S&P | 25 | −0.3 pts | 44% | −0.4 pts | 44% |
| Software over semis | Software − semis | 42 | −0.9 pts | 40% | −0.5 pts | 47% |
| Memory loses leadership | Memory − semis | 54 | +1.4 pts | 54% | +0.1 pts | 50% |
| AI leadership resumes | Semis − S&P | 51 | +1.2 pts | 57% | +1.2 pts | 60% |
| AI leadership breaks | Semis − S&P | 37 | −2.3 pts | 35% | −1.2 pts | 40% |

## Selling exhausting: which version tells you the sell-off is over?

"Sell-off resumed" = SPY closed below its lowest close of the prior 20 sessions within the next 20. Lower is better: a hedge sold on the signal would have been missed less often.

| Version | Episodes | Median run | Sell-off resumed | SPY next 20 | VIX next 20 |
|---|---|---|---|---|---|
| *Comparison: every session within 10 of a credit crack or CTA de-risking* | 694 sessions | — | 48% | +1.9% | −12.3% |
| v0 · first version: replica already cut + VIX↓5 + S&P↑5 (no gate) | 45 | 3 | 33% | +2.3% | −14.0% |
| v1 · gate + VIX↓5 + S&P↑5 (on the board) | 47 | 5 | 35% | +2.0% | −11.1% |
| v2 · gate + VIX↓5 + S&P↑5 + replica already cut | 33 | 3 | 39% | +2.3% | −12.2% |
| v3 · gate + VIX↓5 + S&P↑5 + credit recovering over 5 sessions | 45 | 3 | 32% | +2.3% | −11.0% |

