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
| Narrative: AI headlines | nothing: dvcap has no news feed that is not a model | **NOT WIRED** | The row says so. Wiring it needs a keyless headline source (open question). |

## 2. Trade-day call: four definitions became one

| Where | What it computed | Fate |
|---|---|---|
| Daily Brief skill, steps 3–6 | DIX percentile, then blended the table's bucket midpoints into a ratio, then zoned it (≥1.0 Trade / 0.9–1.0 Selective / <0.9 Lean skip); QQQ Trade below ~32nd, SPY below ~14th | **REPLACE** with `trade_day.calls` (integration doc). The zone rule stays the same; the input becomes the model's median R. |
| `lib/trendTells.js` CUSHION `lean` | Hand-written per band: 20–40th = *Selective* | **Rewired.** Each band's lean is now `zoneOf(band.qqq median)`, the skill's rule. **Conflict fixed:** 20–40th (QQQ median 1.01×) now reads *Trade*, matching the skill's QQQ zone. `zoneOf` lives in trendTells and the board imports it. |
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
2. **20–40th band lean:** the table said Selective, the skill's QQQ zone said Trade. **Fixed:** one rule, `zoneOf`.
3. **The skill's per-ticker zones** blend bucket midpoints, while the board uses a fitted model (cushion + gap + prior R + IV change). Both use the same zone cut-offs. The board is out of sample (Spearman +0.33 QQQ / +0.39 SPX vs +0.28 / +0.34 for cushion alone). **Resolved** by the integration doc: the skill reads the board.
4. **Brent box:** the cross-check box includes today; a breakout needs the box *before* today. **Both kept, labelled:** `rangeOf` for position, the prior 20 sessions for breakout.
5. **RSP ÷ SPY windows** (20d marketState and board; 5d/35d cross-check; 5d/20d ratio cards). These are different horizons, not different definitions. Flagged and kept.
6. **"Positioning" naming:** the connector's leak filter rejects any answer containing the word, so the cluster is named "Dealers & vol".
