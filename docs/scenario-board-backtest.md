# Scenario board backtest

**Answer first:** the board describes the tape well and forecasts it poorly. Most scenarios, old and new, are followed by roughly the base 20-session return. **Reflation** is the only new one whose follow-through held in both halves of the decade (SMH **+5.3% / +6.3%** vs base +2.7% / +1.9%).

## Findings

| Scenario | Keep? | Why |
|---|---|---|
| **Rotation out of mega-caps** | Keep | Active now. Fills the blind spot (value +2.6σ, equal-weight +2.4σ on 3 Nov). Afterwards equal-weight lagged in 69% of episodes (−0.7 pts vs base −0.3), so rotations tend to fade — but the 2nd half is near base. |
| **Defensive rotation** | Keep | Active now. Not a duplicate: its most frequent companion, Credit crack, shares only 47% of its active days. |
| **AI leadership resumes** | Keep | Mirror of AI leadership breaks — tells you when the book's main exposure is working. SPY after: +2.2 / +2.3 vs base +1.8 / +1.4. |
| **Reflation** | Keep | Best follow-through: SMH +5.5% median, 80% of episodes up; held in both halves. |
| **Soft landing** | Keep | SMH above base in both halves (+4.5 / +3.0); equal-weight lagged (cap-weight leads). |
| **Re-risking** | Drop or merge | Active alongside Soft landing **74%** of the time — mostly a duplicate. |
| **Selling exhausting** | Rework or drop | Flickers (median **3 sessions**); edge in the first half only (SPY +3.5 vs +1.8), none in the second (+1.5 vs +1.4). |

- **The adverse scenarios are followed by above-base returns** (Credit crack: SPY +2.4%, 73% up). They describe a sell-off that has already happened; they are not sell signals.
- **Posture:** the new supportive scenarios take 0.5 off the risk-off score when active (the same as Duration bid holds). Rotations leave the score unchanged.

- **Window:** 2017-02-03 → 2026-11-03, 2451 sessions (Yahoo daily, 10y)
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
| Growth scare | Rates & growth | quiet | 5% | 8% | 19 | 3 | 30 | 2025-11-26 | Credit crack (81%) |
| Stagflation squeeze | Rates & growth | quiet | 2% | 10% | 14 | 3 | 14 | 2026-03-03 | Credit crack (62%) |
| Credit crack | Risk-off | active | 12% | 9% | 35 | 6 | 29 | 2026-10-30 | Systematic de-risking (45%) |
| Yen carry unwind | Risk-off | building | 6% | 7% | 23 | 3 | 18 | 2026-10-23 | Credit crack (86%) |
| Systematic de-risking | Risk-off | active | 7% | 12% | 45 | 4 | 18 | 2026-11-02 | Credit crack (78%) |
| AI leadership breaks | Your book | active | 12% | 8% | 38 | 6 | 22 | 2026-10-16 | Rotation out of mega-caps (50%) |
| **Soft landing** (new) | Risk-on & recovery | quiet | 18% | 18% | 57 | 6 | 30 | 2026-08-21 | AI leadership resumes (39%) |
| **Re-risking** (new) | Risk-on & recovery | quiet | 8% | 19% | 49 | 4 | 10 | 2026-10-08 | Soft landing (74%) |
| **Selling exhausting** (new) | Risk-on & recovery | quiet | 6% | 21% | 45 | 3 | 13 | 2026-04-02 | Credit crack (26%) |
| **Reflation** (new) | Risk-on & recovery | quiet | 10% | 15% | 35 | 5 | 37 | 2026-08-25 | AI leadership resumes (41%) |
| **Rotation out of mega-caps** (new) | Rotation | active | 15% | 9% | 37 | 8 | 28 | 2026-10-20 | AI leadership breaks (40%) |
| **Defensive rotation** (new) | Rotation | active | 11% | 20% | 35 | 4 | 29 | 2026-10-22 | Credit crack (47%) |
| **AI leadership resumes** (new) | Your book | quiet | 26% | 18% | 51 | 10 | 40 | 2026-09-22 | Soft landing (28%) |

## What followed over the next 20 sessions (median %, share of episodes up)

| Scenario | n | SPY | QQQ | SMH | Equal-weight − SPY | TLT |
|---|---|---|---|---|---|---|
| *Base (every session)* | 2451 | +1.6 · 68% | +2.0 · 67% | +2.5 · 64% | −0.3 · 41% | −0.4 · 46% |
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
| **Selling exhausting** | 45 | +2.3 · 67% | +2.7 · 64% | +2.7 · 64% | +0.0 · 51% | −0.7 · 44% |
| **Reflation** | 35 | +1.7 · 74% | +3.7 · 74% | +5.5 · 80% | −0.5 · 46% | +0.1 · 51% |
| **Rotation out of mega-caps** | 36 | +1.9 · 67% | +2.5 · 72% | +3.5 · 61% | −0.7 · 31% | −1.2 · 33% |
| **Defensive rotation** | 34 | +2.2 · 71% | +2.1 · 76% | +1.7 · 62% | −0.4 · 38% | −1.5 · 41% |
| **AI leadership resumes** | 51 | +2.2 · 78% | +2.3 · 69% | +3.8 · 67% | −0.5 · 41% | −0.5 · 45% |

## Does it hold in both halves? (2017-02-03 → 2021-12-15 | 2021-12-15 → 2026-11-03; median 20-session %, n episodes)

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
| **Selling exhausting** | +3.5 (17) | +1.5 (28) | +4.5 (17) | +2.6 (28) | +0.1 (17) | −0.1 (28) |
| **Reflation** | +2.9 (19) | +1.4 (16) | +5.3 (19) | +6.3 (16) | −0.5 (19) | −0.2 (16) |
| **Rotation out of mega-caps** | +2.1 (14) | +1.3 (22) | +4.2 (14) | +0.7 (22) | −0.8 (14) | −0.2 (22) |
| **Defensive rotation** | +2.5 (20) | +2.0 (14) | +2.5 (20) | +0.7 (14) | −0.5 (20) | −0.2 (14) |
| **AI leadership resumes** | +2.2 (30) | +2.3 (21) | +4.0 (30) | +1.0 (21) | −0.4 (30) | −0.5 (21) |

