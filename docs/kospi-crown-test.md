# Crown's KOSPI claim, tested (20 Oct 2026)

**Claim** (Crown Macro Desk, 19 Oct): when KOSPI closes up after two or more consecutive down sessions, the US is up the next session more than 80% of the time.

**Test** (`scripts/kospi-crown-backtest.py`): Yahoo daily closes for ^KS11 (the KRX index close), QQQ and ^GSPC, 2012-01-02 to 2026-10-16.

- Day *t* is a Seoul session that closes up after N or more down closes.
- "Next US session" is the first New York session on or after *t*'s date. Seoul closes at 06:30 UTC, before the 13:30 UTC US open.
- Results are shown against the base rate of all US sessions, with a two-sided binomial p-value.

| Condition | n | QQQ up close→close (base 55.7%) | QQQ up open→close (base 53.9%) | SPX up close→close (base 54.3%) |
|---|---|---|---|---|
| KOSPI up after ≥2 down | 416 | **59.6%** (p 0.11) | 53.8% (p 1.00) | 58.9% (p 0.06) |
| … 2012–2019 | 231 | 59.7% | 53.2% | 60.6% |
| … 2020–2026 | 185 | 59.5% | 54.6% | 56.8% |
| KOSPI up after ≥3 down | 187 | 58.3% (p 0.51) | 50.8% | 56.7% |
| KOSPI up, any day (control) | 1,940 | 61.5% | 54.6% | 59.9% |

**Result: not supported.**

- The pattern was followed by a US up day about 59–60% of the time, not more than 80%.
- That is 4 points above the base rate and not significant (p 0.06–0.11).
- It does *worse* than any KOSPI up day (61.5%), so the down streak adds nothing.
- On what a trader can still capture after the Korean close (US open→close), there is no edge: 53.8% vs a 53.9% base.
- The close→close lift is mostly the overnight gap that KOSPI and US futures share.

On the Signal Board, the KOSPI row shows the pattern with these numbers, but it does not vote.
