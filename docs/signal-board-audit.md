# Signal Board audit (20 Oct 2026)

Before the Signal Board was built, this audit listed every place a market signal is computed or shown. It covers dvcap (`lib/`, `api/`, `src/`, `scripts/`), the Market Read artifact (page plus datasets, outside the repo) and the two skills (`morning-gamma-regime`, `current-market-read`, also outside the repo). Each signal gets one fate:

- **REPLACE**: the board becomes the source, and the old code is removed or rewired.
- **MERGE**: the reading becomes one board row, built on the existing definition.
- **KEEP**: it stays where it is, for the reason given.
- **MOVE**: the logic moves into the board.

Market data only throughout.

The engine is `lib/signalBoard.js`. Its inputs come from `lib/signalBoardFeed.js`. It is served at `/api/indicators?board=1` and through the `get_signal_board` tool on the Market Read Dashboard Gamma connector. The integration steps for the artifact and the skills are in `docs/signal-board-integration.md`.

## 1. Board rows and where each comes from

| Board row | Was computed in | Fate | How |
|---|---|---|---|
| Credit: HYG ÷ LQD 5d | nowhere in dvcap. `lib/scenarios.js` and `lib/catalyst.js` name LQD; `lib/recon.js` uses HYG alone | **NEW** | Yahoo closes |
| Credit: HY OAS 5d (bp) | `lib/marketState.js` creditComponent (5 prints); `lib/crossCheck.js` computeCredit (chg5, same window); the Market Read `hy_oas` dataset (TradingView FRED, page-side); `lib/gates.js` level×direction gate | **MERGE** | The board row *is* `creditComponent`'s `hyChg5Bp`. The cross-check keeps its raw-series block for the skill (same 5-print definition, so no conflict). |
| Rates: 10Y 5d (bp) | Market Read `t_rates` (1-day change only, IBKR TNX); `lib/scenarioBoard.js` (20-session trends) | **NEW** (5d) | Yahoo ^TNX. The Market Read 1-day row stays as a quote. |
| Rates: MOVE | `lib/marketState.js` ratesVolComponent; `lib/benchmarks.js` percentile | **MERGE** | The board row is `ratesVolComponent`'s percentile and 5d change. |
| Oil: Brent in 20-day box, breakout | `lib/crossCheck.js` computeOilPolicy (`range_pct_20d`); the skill's prose ("Brent and its Dec–Jan spread") | **MERGE** | The board imports `rangeOf` from `lib/crossCheck.js`, now exported: one box definition. The breakout flag (close beyond the *prior* 20 sessions' high or low) is new. |
| Dealers & vol: gamma cushion | `lib/squeeze.js` gexPercentile → `lib/gexDays.js` todayTellInputs → Gamma tab "Today's tells" (`src/GexPanel.jsx`); the Daily Brief skill step 3 (curl DIX.csv, own percentile); `lib/crossCheck.js` computeDix `gex_pct_rank_1y` | **REPLACE / rewire** | The board uses `gexPercentile`. **Conflict fixed:** `computeDix` ranked over the last 252 rows *including* today with mid-ranks, while the Gamma tab ranks against the 252 *before* today. It now uses `gexPercentile`, so all three surfaces report one number. The skill's own DIX percentile is replaced by the board (integration doc). |
| Dealers & vol: VIX ÷ 20d realised | nowhere | **NEW** | Yahoo ^VIX and ^GSPC |
| Dealers & vol: VIX9D ÷ VIX | `lib/volterm.js` (VIX9D vs **VIX3M**, ±2.5% flat band, pre-read card); `lib/marketState.js` equityVolComponent (VIX ÷ VIX3M); `lib/trendTells.js` curve tell (VIX ÷ VIX3M) | **KEEP** volterm and trendTells | These measure different points on the curve. The board's front-end row is VIX9D ÷ VIX, as the brief asks. volterm is the pre-read's event-pricing overlay (front vs back 1-day divergence), which the board does not do. The curve tell carries its own 15-year trend-day rates. |
| Dealers & vol: SKEW | nowhere | **NEW** | Yahoo ^SKEW |
| Dealers & vol: equity put/call | `lib/crossCheckFeed.js` putCall (Cboe daily, KV history) → cross-check `put_call` block | **MERGE** | The board reads the cross-check's KV block and does not fetch again. |
| Dealers & vol: sessions to opex | `lib/gammaMcp.js` isStandardMonthly; `lib/catalyst.js`; `lib/gexDecay.js` (post-expiry book) | **MERGE** | The board uses the same third-Friday rule, shifted to Thursday on a holiday. It is shown but does not vote. |
| Tape: RSP ÷ QQQ 20d | Market Read `ratio_stats` (page-side, IBKR); `lib/ratios.js` (Ratios panel cards) | **KEEP** both, **MERGE** the state | The ratio cards are charts with a 60-day band and a fast-move flag. The board adds only the risk-on/off state, using the cards' colour convention (rising = broadening = green). |
| Tape: breadth | `lib/marketState.js` breadthComponent (RSP ÷ SPY and IWM ÷ SPY, 20d); `lib/crossCheck.js` computeBreadth (5d / 35d + weekly streak + `narrowing`); `lib/ratios.js` RSP ÷ SPY card; the Market Read `rsp_spy` card | **MERGE** | The board row *is* `breadthComponent`. **Windows differ, which is flagged, not a conflict:** the cross-check's 35-session `narrowing` flag answers a slower question and stays as the skill's raw-data cross-check. |
| Tape: SOXX and QQQ vs 20/50/100/200dma | `lib/cta.js` (trend-fund replica: 21/63/252-session flips, NQ/ES only); Market Read `sr_levels` (20/50/200-day averages as price levels, page-side); `lib/watchSetup.js` / `lib/yahoo.js` (200-day for single names) | **NEW** row, **KEEP** cta | The CTA replica is a vol-scaled model with its own flip prices. The board gives the plain moving-average distances the brief asks for. The two are different questions, and both are labelled. |
| Asia: KOSPI | `lib/handoff.js` (Asia → US handoff); `lib/regionTape.js` (region chip, ATR-gated); `lib/koreaFetch.js` (KRX flows); the Daily Brief tiles (TradingView KRX:KOSPI) | **NEW** row (does not vote) | Daily close, ^KS11, which carries KRX's close; the KSE intraday feed is stale and is not read. Crown's pattern is flagged with the tested result: 59.6% vs a 55.7% base, n 416 (`scripts/kospi-crown-backtest.py`). It is not voted. |
| Crypto: BTC vs 20/50/100/200-day, 200-day break flag | `lib/quotes.js` getMacro → `lib/yahoo.js` yahooTrend('BTC-USD') (1d/5d/20d change, 50/200-day, 52-week high, as a summary) → `classifyDebasement` (gold + BTC) and the cross-asset tape (`lib/assemble.js`, `lib/read.js`); `lib/regimeState.js` (BTC direction) | **MERGE** the definitions, **NEW** row (does not vote) | Same symbol, source and definitions as the macro spine (7-day daily bars; 52-week high = highest close of the year). The board fetches the 2-year series itself because the spine keeps only the summary. The debasement classifier and the regime reads stay as they are: they answer a different question (gold vs BTC). |
| Crypto: BTC ÷ QQQ 20 sessions | nowhere | **NEW** (does not vote) | Yahoo BTC-USD ÷ QQQ on shared dates |
| Crypto: ETH ÷ BTC 20 days | nowhere (ETH appears only as a symbol hint in `lib/crypto.js` and an on-chain asset in `lib/chains.js`) | **NEW** (does not vote) | Yahoo ETH-USD |
| Crypto: BTC off its 52-week high | `yahooTrend` `pctOffHi` (macro spine) | **MERGE** | Same definition (close vs the year's highest close), on a dated 365-day window |
| Crypto: US spot bitcoin ETF net flows | nowhere | **NOT WIRED** | There is no free source that works without sign-up and without scraping. Skipped rather than scraped. |
| Narrative: AI build-out coverage and tone | nothing before this row: dvcap had no news feed that is not a model | **NEW** row (does not vote, flagged for review) | GDELT DOC 2.0 (`lib/narrativeFeed.js`): article counts as a share of all coverage, and GDELT's dictionary tone. No model. The 2017–2026 test found no edge (section 6), so the row is shown and scored but does not vote, as with the Asia row. |

## 2. Trade-day call: four definitions became one

| Where | What it computed | Fate |
|---|---|---|
| Daily Brief skill, steps 3–6 | DIX percentile, then blended the table's bucket midpoints into a ratio, then zoned it (≥1.0 Trade / 0.9–1.0 Selective / <0.9 Lean skip); QQQ Trade below ~32nd, SPY below ~14th | **REPLACE** with `trade_day.calls` (integration doc). The zone rule stays the same; the input becomes the model's median R. |
| `lib/trendTells.js` CUSHION `lean` | One hand-written lean per band for both tickers: 20–40th = *Selective* | **Rewired, per ticker.** Each band now carries `leanQqq = zoneOf(qqq median)` and `leanSpx = zoneOf(spx median)`, the skill's rule; SPY reads the SPX lean (`bandLean`). **Conflict fixed:** 20–40th reads *Trade* for QQQ (1.01×) and *Selective* for SPX (0.92×); 40–60th reads *Lean skip* for SPX (0.80×). This matches the skill's zones (QQQ Trade below ~32nd, SPY below ~14th). The Gamma tab shows both leans, and the board's trade-day call carries its own ticker's. `zoneOf` lives in trendTells and the board imports it. |
| Daily Brief skill, step 7 `tell` | First hour > ½ implied σ | **REPLACE** with the checkpoints (10:00 ≥0.50σ / <0.33σ QQQ, ≥0.40σ / <0.25σ SPY; 10:30 ≥0.70σ / <0.43σ QQQ, ≥0.55σ / <0.32σ SPY, from PR #384). The old tell fired on 57% of QQQ sessions. |
| `lib/trendTells.js` firstHour tell (ATR units, trend-day odds) | 10:30 net move ÷ ATR → trend-day rate | **KEEP.** It is a different outcome (trend day, direction) from the board's range checkpoint (how much the rest of the day moves). |
| The brief's 1.10× vs the backtest's 1.27× | mean vs median, and negative-GEX days in or out | **Reconciled** in PR #384: the table holds medians with negative GEX as its own band. The board shows the band's **median and share of days ≥1.0×**, not a mean. |

## 3. Market Read page and datasets (outside the repo)

| Page section / dataset | Computes | Fate under the board |
|---|---|---|
| chips `chip1`–`chip4` (notes) | Regime chips written as prose by the skill | **REPLACE** with cluster states from the board |
| ★ Combined angle (`conf1`–`conf3`) | "≥2 of sections 2–5 point the same way", judged in prose | **REPLACE** the counting rule with the board's cluster lean. Keep the idea cards (tickers, structure, invalidation); they are analysis, not signals. |
| `x_credit`, `x_breadth` cross-check lines | HY OAS vs SPY and RSP ÷ SPY vs SPY, judged in prose | **MERGE** into the board's credit and breadth rows. Keep `x_auction` and `x_skip`. |
| `hy_oas` dataset (TradingView FRED) + its `t_rates` row | HY OAS level, 1-day change | **REPLACE** the dataset with the board's `hy_oas` row (same FRED series, 5-print change). |
| `t_tape`, `t_rates`, `t_fx` (IBKR quotes) | Level and 1-day change, tone | **KEEP.** Live quotes, not signals. |
| `ratios` + `ratio_stats`, `corr` + `corr_stats` | Ratio level, 5d/20d, percentile, 60-day break, ⚡ | **KEEP** (charts). The page's `ratio_stats` duplicates `lib/ratios.js`'s maths on a different feed (IBKR vs Yahoo). Flagged; out of scope here. |
| `sr_levels` (20/50/200-day averages as levels) | Price support and resistance | **KEEP** as levels. The board's MA rows give the state and distances for QQQ and SOXX. |
| `gamma_levels`, `gamma_ladder`, `spx_map` | Gamma structure | **KEEP**; the board does not touch structure. |
| `cal`, `earn`, `history`, `px_hist`, `us02y`, `ib` | Calendar and price data | **KEEP** |

## 4. Other dvcap signal surfaces (not board dimensions) — KEEP

These answer different questions, on different clocks, and none duplicates a board row:

- `lib/marketState.js` conditions (0–100 stress composite): the board *reads* its components rather than recomputing them.
- `lib/regimeState.js` (cross-asset tape classifier).
- `lib/posture.js` (tape stance card).
- `lib/scenarioBoard.js` (20-session scenarios).
- `lib/regimeEngine.js` (four-state regime).
- `lib/gates.js` (level × direction gates).
- `lib/recon.js` (HYG → OAS predictiveness).
- `lib/impliedCorrelation.js` (COR1M, VIXEQ − VIX).
- `lib/gexBrief.js` / `lib/gexRead.js` / `lib/gexDays.js` (gamma structure and its own-session record).
- `lib/cta.js` (trend-fund replica).
- `lib/watchSetup.js` (single-name setups).

Folding the stress composite into the board's Macro cluster is a possible follow-up. It would change a sizing input, so it was not done here.

## 5. Conflicts found

1. **Cushion percentile:** `computeDix` (mid-rank, today included) vs `gexPercentile` (the 252 sessions before today). **Fixed:** both now use `gexPercentile`.
2. **Band leans:** the table had one lean per band for both tickers (20–40th Selective), while the skill zones each ticker on its own median. **Fixed:** one rule, `zoneOf`, applied per ticker (QQQ: Trade / Trade / Trade / Selective / Lean skip / Lean skip; SPX: Trade / Trade / Selective / Lean skip / Lean skip / Lean skip).
3. **The skill's per-ticker zones** blend bucket midpoints, while the board uses a fitted model (cushion + gap + prior R + IV change). Both use the same zone cut-offs. The board is out of sample (Spearman +0.33 QQQ / +0.39 SPX vs +0.28 / +0.34 for cushion alone). **Resolved** by the integration doc: the skill reads the board.
4. **Brent box:** the cross-check box includes today; a breakout needs the box *before* today. **Both kept, labelled:** `rangeOf` for position, the prior 20 sessions for breakout.
5. **RSP ÷ SPY windows** (20d marketState and board; 5d/35d cross-check; 5d/20d ratio cards). These are different horizons, not different definitions. Flagged and kept.
6. **"Positioning" naming:** the connector's leak filter rejects any answer containing the word, so the cluster is named "Dealers & vol".
7. **"key" in a row:** the connector's leak check matches substrings, so "keyless" or "keyword" anywhere in the board fails the whole `get_signal_board` answer. The Narrative row's text avoids both, and a test checks the row against the filter.
8. **BTC's 52-week high vs its all-time high:** the 52-week row reads the highest close of the last 365 days, which is the macro spine's `pctOffHi` definition. The October 2025 peak (≈124.8k) left that window in early October 2026. On 20 Oct 2026 the row reads about −29% from 114.5k (26 Oct 2025), not −35% from the all-time high. **Kept** as the spine's definition; the row's text names the high and its date.

## 6. Narrative row: source, rule and test (20 Oct 2026)

**Source.** GDELT DOC 2.0 API (`api.gdeltproject.org/api/v2/doc/doc`): free, no sign-up, no credential. Two daily timelines: `timelinevolraw` (matching articles, plus `norm`, all articles GDELT saw that day) and `timelinetone` (mean tone from GDELT's word dictionary). No LLM and no embedding. It was reachable from the build container through Node's `fetch`, the same call the Vercel function makes. It rate-limits hard: one request every 5 seconds per address, with 429s for minutes after a burst. RSS was not needed as a fallback.

**Query** (`NARRATIVE_QUERY`): `("data center" OR "data centers" OR hyperscaler OR hyperscalers OR "AI capex" OR "AI chip" OR "AI chips" OR "AI spending" OR "AI infrastructure") sourcelang:english`. "data center" also catches non-AI coverage. Since 2023 the AI build-out dominates it: share of all coverage averaged 0.06–0.09% in 2017–2023, 0.11% in 2024, 0.20% in 2025 and 0.41% in 2026.

**Measures** (UTC calendar days; the current day is dropped while it fills, and days with no collection are dropped):
- share = count ÷ norm;
- coverage trend = 5-day mean share ÷ 20-day mean share − 1, with 5-vs-prior-5 and 20-vs-prior-20 shown;
- tone = the article-weighted 5-day mean, and its change against the 5 days before.

**Rule** (`narrativeState`, one pair of numbers for both directions):
- **risk-off**: coverage ≥ +10% while the tone change is ≤ −0.25, i.e. the story is getting louder and worse;
- **risk-on**: tone change ≥ +0.25 and coverage ≥ −10%;
- **neutral** otherwise.

±10% and ±0.25 are the 2017–2026 quartiles of the two measures (p25 −10.9% / p75 +10.5%; −0.25 / +0.25; n 3,518 days). They were set from those distributions, not fitted to returns. Over all days the row reads on 17.8%, neutral 74.3% and off 7.9%.

**Cache.** Each timeline is cached in KV for 3 hours and refreshed on its own, with a 5.5-second gap before the second request. On a failed refresh the last good copy is served for up to 4 days. With nothing usable, the row reads "not available" and the board carries on without it.

**Test** (`scripts/narrative-backtest.mjs`, which uses the row's own functions). The signal for session S is the state through the last UTC day before S. GDELT's day ends at 20:00 New York, after the close, so the trade is entered at S's open. Returns run from open(S) to the close 1, 3 or 5 sessions later. The 3- and 5-session windows overlap. Sessions run 2017-02-01 → 2026-10-19 (n 2,431).

| | SOXX 1d | SOXX 3d | SOXX 5d | QQQ 1d | QQQ 3d | QQQ 5d |
|---|---|---|---|---|---|---|
| Spearman, state (−1/0/+1) vs return | +0.010 | +0.018 | +0.009 | +0.003 | +0.018 | +0.005 |
| Spearman, tone change vs return | +0.005 | +0.034 | +0.034 | −0.008 | +0.027 | +0.010 |
| Risk-on (n 333): % up / base % up | 50.8 / 51.7 | 57.7 / 55.2 | 57.4 / 56.8 | 53.2 / 53.8 | 62.5 / 57.9 | 59.2 / 59.3 |
| Risk-off (n 162): % down / base % down | 50.6 / 48.3 | 45.7 / 44.8 | 46.3 / 43.2 | 42.6 / 46.2 | 42.0 / 42.1 | 42.0 / 40.7 |

From 2023 only (n 941; on 126, off 38), Spearman runs from −0.027 to +0.013. Risk-off is followed by a SOXX fall on 52.6% of next sessions against a 46.4% base, but n is only 38. Pre-2023 looks the same as the full sample.

**Verdict: no edge.** Every Spearman is within ±0.035, and the hit rates sit at their base rates. So `NARRATIVE_TEST.edge` is `false`. The row is shown with its state, flagged "under review, not voted", and scored from the snapshot log like every other row. The Narrative cluster therefore reads null and the lean counts three clusters. To make it vote, set `edge: true`, but only once the log or a better query shows an edge.

## 7. Crypto rows: why none votes (`scripts/crypto-signal-backtest.py`)

The sample runs from 2015-04-06 to 2026-10-19: 2,903 US sessions. ETH starts 2017-11-30. The test reads crypto from the bar dated the day **before** each US session. Yahoo's BTC bar for day t closes at 20:00 ET, four hours after the US close, so using it would leak the overnight move into the score. The outcomes are next 1/3/5-session QQQ and SOXX returns. The 1-session binomial p is the significance test, because the 3- and 5-session windows overlap.

| Row (on / off) | QQQ next session: risk-on up vs base | risk-off down vs base | Spearman 1d / 5d | Verdict |
|---|---|---|---|---|
| BTC MA count (4 / ≤1) | 58.2% vs 56.0% (n 1,038, p 0.15) | 45.8% vs 44.0% (n 970, p 0.29) | +0.026 / +0.048 | no vote |
| BTC ÷ QQQ 20s (+12% / −8%) | 59.8% vs 56.0% (n 752, p 0.03); 5s 66.2% vs 60.1%; holds in 2015–20 and 2021–26 | 44.6% vs 44.0% (n 715, p 0.76) | +0.045 / +0.084 | no vote: the edge is one-sided, and a voting row votes both ways. Candidate to promote from the snapshot log. |
| ETH ÷ BTC 20d (+5.5% / −7.5%) | 55.8% vs 56.1% (n 563) | 42.2% vs 43.9% (n 559) | −0.008 / −0.009 | no vote |
| BTC off 52w high (−7.5% / −45%) | 57.4% vs 56.3% (n 700) | 47.5% vs 43.7% (n 667, p 0.05) | +0.012 / +0.004 | no vote: drawdowns are context. A fresh BTC −20% crossing was followed by a QQQ −10% reading within 130 sessions 10 of 14 times, against 77% of all days, so it is no lead. |

SOXX tells the same story (BTC ÷ QQQ risk-on: 58.5% vs 54.5%, p 0.03; the other rows are within 2 points of base).

**Lead/lag.** BTC's first close below its 200-day after ≥20 closes above happened 13 times. QQQ fell ≥5% within 20 sessions after 7 of them (54%), against 24% of all days (binomial p 0.02, but the events cluster in sell-offs) and 28% after QQQ's own first close below its 50-day (n 29). The median worst 20-session QQQ drawdown was −5.5%, against −1.9% for all days. Seven of the 13 breaks came while QQQ was still above its 50-day; four of those saw QQQ fall ≥5% within 20 sessions. This becomes a **flag** on the BTC trend row with its numbers, not a vote. **Redundancy:** when the QQQ trend row reads risk-on and BTC's reads risk-off, QQQ's next 5 sessions averaged −0.14% (n 345), against +0.42% when both read risk-on (n 719). This is the same divergence the 200-day flag catches.

**Benchmark.** The KOSPI row did not vote at 59.6% vs 55.7% (n 416). The crypto rows are held to the same bar. All four rows are scored in the snapshot log (`scorecard.signals.btc_*`), and BTC ÷ QQQ can be promoted to a Tape vote once its risk-off side shows an edge there.

## 8. P(trend day) on the trade-day call (spec A.2, 20 Oct 2026)

**Definition.** A trend day is a session whose close lands in the top or bottom 20% of its own high–low range. It is a close-location day with a base rate of about 49%. It is **not** the Gamma tab's trend day (`lib/trendTells.js`: ≥0.6 ATR open→close keeping ≥60% of the range, base ≈24%). The two answer different questions and both stay, each labelled.

**Model.** The model is a logistic regression on the same pre-open inputs as P(R ≥ 1): cushion percentile, a negative-GEX band dummy, |gap| ÷ implied, prior-day R and the overnight IV change. QQQ uses QQQ bars and VXN. SPY uses SPY's own bars and VIX, because the close location belongs to the ETF. The script is `scripts/trade-day-refit.py` (calibrate mode), the coefficients are in `lib/tradeDayModel.json` `trend`, and the code is `trendDayProb` in `lib/signalBoard.js`.

**Out-of-sample test.** The test is walk-forward: each year from 2016 is predicted by a fit on 2012 → the end of the year before. The comparison is against the base rate known at the time and against the cushion band's rate known at the time. The sample is 2016-01-04 → 2026-10-19, n 2,714 per ticker. The full fit runs 2012-05-02 → 2026-10-19, n 3,637.

| | QQQ | SPY |
|---|---|---|
| Base rate (OOS window) | 49.6% | 48.3% |
| Brier: model / base rate / band rate | 0.2495 / 0.2504 / 0.2493 | 0.2496 / 0.2500 / 0.2496 |
| Brier skill score vs base (90% block bootstrap) | +0.004 [−0.004, +0.012] | +0.002 [−0.005, +0.010] |
| Band rate's skill score vs base | +0.004 [−0.002, +0.012] | +0.002 [−0.005, +0.008] |
| AUC | 0.546 | 0.530 |
| Calibration by predicted quintile, predicted → realised | 40→42, 44→47, 47→52, 51→54, 57→53 | 42→44, 45→47, 47→49, 51→48, 56→53 |

**Verdict: no out-of-sample skill.** In both cases the interval includes zero, and the top quintile is not monotone. So `skill` is `false` for both tickers, and the call shows the **cushion band's base rate** (`trend.source: "band base rate"`). The row text says so. The band rates come from the full 2012–2026 sample:

| Band | neg GEX | <20th | 20–40th | 40–60th | 60–80th | ≥80th | all |
|---|---|---|---|---|---|---|---|
| QQQ trend-day % (n) | 56.2 (317) | 54.0 (404) | 51.5 (586) | 50.2 (671) | 50.7 (672) | 41.5 (987) | 49.1 |
| SPY trend-day % (n) | 57.1 (317) | 52.7 (404) | 48.6 (586) | 47.7 (671) | 50.4 (672) | 43.1 (987) | 48.5 |

The only clear step is the top band, about 8 points below the rest. It is shown as history, not as a forecast with skill.

**Checkpoints.** The trend-day share per checkpoint band was added to `scripts/trade-day-checkpoint-backtest.py` (by first-range quartile) and to `scripts/trade-day-v2-calibrate.py` (by band, carried in `CHECKPOINTS.<T>['10:30'].trend`). The free intraday record supports it only at 10:30, from Yahoo hourly bars 2024-10 → 2026-10 (n 493):
- QQQ: quiet 43%, middle 44%, confirm 47% against a 45% base.
- SPY: quiet 37%, middle 44%, confirm 42% against 41%.

So the first hour barely moves the trend-day odds. 10:00 has no trend share, because Yahoo's 30-minute bars reach back only 60 sessions.

## 9. The conflict flag (spec A.6)

The trade-day call reads the SPX-wide cushion and the tape. The gamma board reads the ticker's own strikes. When the two disagree, the call carries a `conflict` object (`tradeConflict` in `lib/signalBoard.js`). **It never changes the call:** `overrides: false`, and the zone, median R and P(R ≥ 1) stand.

**Source of the structure.** It is the board the gamma feed and the connector's `get_gamma_*` tools serve. `feedBoard` moved unchanged from `api/gex.js` to `lib/gexFeedBoard.js`, so both read it, and it is reshaped by `gexFeedPayload` (`lib/gexFeed.js`). Nothing is fetched a second way. The connector's `get_signal_board` may mint a recompute, as its gamma tools do. The public `/api/indicators?board=1` passes `recompute: false`: it serves a kept recompute or the stored board and never fetches a chain. No new serverless function was added (still 12).

**Rules** (fixed; `CONFLICT = { sigma: 0.5, maxAgeDays: 4 }`). σ is the call's `implied_1sd` in dollars, falling back to the board's ±1σ to the nearest expiry.

| Call | Rule id | Fires when |
|---|---|---|
| Trade | `pin_box` | spot inside the board's pin box [bottom, top] **and** net gamma at spot > 0 |
| Trade | `call_wall` | net gamma > 0 **and** the board's call wall has positive gamma **and** spot within 0.5σ of it |
| Lean skip | `below_flip` | the flip is a usable line (not a fragile zone) **and** spot below it **and** net gamma < 0 |
| Lean skip | `trapdoor` | the near trapdoor is below spot and within 0.5σ of it |
| Selective | none | already the middle call |

A board more than 4 calendar days older than the session being called raises nothing (`gamma.stale: true`). On the connector (`get_signal_board`), each call also carries `gamma`, the structure the rules read (spot, flip, net gamma, call wall, pin box, near trapdoor, as-of, mode), so both views are on the answer. **The public `/api/indicators?board=1` carries no gamma levels.** It has no `gamma` object, and its `conflict` is rule ids, `overrides: false` and a generic sentence with no price (`publicTradeDay`). The snapshot is written from that public answer and keeps rule ids only. The snapshot log keeps `call.<T>.conflict` (rule ids) and `call.<T>.p_trend`, so both are scored from the log like everything else. On the 8 Oct SPY board (the test fixture), spot 774.64 sat below a usable flip at 775.59 with net gamma −$1.83bn per 1%, so a Lean skip call on it carries `below_flip`.

## 10. Quarterly walk-forward refit

**Where the coefficients live.** The coefficients moved out of `lib/signalBoard.js` into `lib/tradeDayModel.json`, unchanged. `scripts/trade-day-refit.py --refit` does the refit:
- The cutoff is the last quarter-end.
- The current coefficients and a candidate fitted on 2012 → the start of the evaluation window are both scored out of sample on the four quarters to the cutoff.
- The proposal is the fit on 2012 → the cutoff.
- It writes `docs/trade-day-refit/{proposed.json, report.md, status.json}` and **never edits `lib/`**.

**Thresholds** (any one opens a proposal):
- R model: |Δ Brier P(R≥1)| ≥ 0.005, or |Δ Spearman| ≥ 0.03, or the zone differs on ≥ 15% of sessions;
- P(trend): the skill verdict flips, or |Δ BSS| ≥ 0.01.

**Schedule.** `.github/workflows/trade-day-refit.yml` runs on the first weekday after each quarter-end at 13:23 UTC. The cron fires on the 1st–3rd of Jan/Apr/Jul/Oct, and a guard keeps only the first weekday. Past a threshold, it pushes `refit/trade-day-<cutoff>` and opens a pull request with the report as its body; within the thresholds it commits nothing. It uses free sources only (SqueezeMetrics, Cboe, Yahoo) and the workflow's own `GITHUB_TOKEN`. Opening the pull request needs the repository setting "Allow GitHub Actions to create and approve pull requests". Without it the branch is pushed and the run warns.

**Baseline.** The first run (cutoff 2026-09-30, window 2025-10-01 → 2026-09-30, n 251) is committed under `docs/trade-day-refit/`:

| | Spearman, current vs candidate | Brier, current vs candidate | Zone differs |
|---|---|---|---|
| QQQ | 0.231 vs 0.224 | 0.226 vs 0.229 | 2% |
| SPY | 0.266 vs 0.257 | 0.188 vs 0.192 | 7% |

P(trend) has no skill either way. The verdict is within the thresholds, so there is no proposal.

## Software vs semis row (`igv_smh`, shown, not voted)

IGV ÷ SMH over 20 sessions, with ORCL ÷ IGV as a side reading in the row text. Quartiles of the 20-session change, Yahoo adjusted closes 2012-06 → 2026-10 (n 3,598): p25 −3.57%, p75 +2.50%; the row reads "software leading" at or above +2.5% and "chips leading" at or below −3.6%.

Why it doesn't vote: QQQ's next 20 sessions were up 68% after a top-quartile reading (n 896) and 64% after a bottom-quartile one (n 890), against 68% on all days, and the 2012–18 and 2019–26 halves point opposite ways. It is a rotation gauge (where money is moving inside tech), not a direction call. The row's on/off colouring follows the threshold rule (chips leading = on), nothing more.

ORCL ÷ IGV separates the two readings of a rising IGV ÷ SMH: ORCL falling with the chips means AI build-out funding stress; ORCL rising with software means a broad software bid.

### Platforms vs chips side reading (`mags_soxx_20d`, shown, not voted)

MAGS ÷ SOXX over 20 sessions, a second side reading on the software row next to `orcl_igv_20d` ("Platforms vs chips (MAGS ÷ SOXX)"). It never votes and never changes the row's state. Quartiles of the 20-session change, IBKR closes 2023-04 → 2026-10 (n 887): p25 −4.35%, p75 +3.65%; the reading says "platforms beating chips" above +3.65%, "chips beating platforms" below −4.35%, otherwise "in range". With no MAGS or SOXX closes it is null and left out of the row text; the row itself is unaffected.

Overlap: corr 0.76 with IGV ÷ SMH (0.81 non-overlapping) and −0.23 with NVDA ÷ META. It largely restates the row it sits on, which is why it is a side reading and not a row.

Forward test (next 20 sessions): after a top-quartile reading QQQ averaged +2.7% and was up 73% of the time, against +2.0% / 69% on all days. No SOXX edge, no drawdown edge.

Regime, crossing the sign of each ratio's 20-session change (next 20 sessions):

| Cell | QQQ | SOXX | QQQ fell 5%+ |
|---|---|---|---|
| Both up | +2.10% | +2.73% | 30% |
| MAGS÷SOXX up, IGV÷SMH down | +2.40% | +4.27% | 12% |
| MAGS÷SOXX down, IGV÷SMH up | +0.99% | +3.28% | 29% |
| Both down | +1.89% | +3.98% | 17% |

When both are positive the row carries a note (`regime_note`, also appended to the row text): "Software and platforms both beating chips: since 2023, QQQ fell 5%+ within 20 sessions 30% of the time in this regime vs 21% on all days (n=53 non-overlapping, one regime; context, not a vote)."
