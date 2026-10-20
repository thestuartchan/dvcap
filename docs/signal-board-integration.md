# Signal Board: integration steps outside the repo (20 Oct 2026)

dvcap now serves the board in two places:

- `GET /api/indicators?board=1`: public, market data only, edge-cached for 5 minutes.
- The read-only `get_signal_board` tool on the **Market Read Dashboard Gamma** connector. It takes no arguments.

The Market Read artifact and the two skills live outside this repo, so this PR does not change them. Apply the steps below once the PR is merged and deployed. Never write the connector URL, the gamma feed slug or any token into the page, a dataset or a skill.

## Answer shape (abridged)

```
{ ok, at, source, today, errors: [{series, error}],
  board: { rows: [{dim, id, label, value, roc, roc_label, state: on|neutral|off|null, thresholds: {on, off, dir, unit},
                   benchmark, text, as_of, vote, flags: [], flip: {to, at, when, dist}, ...}],
           clusters: [{id: macro|dealers|tape|narrative, label, state, on, off, neutral, rows}],   // crypto rows sit in tape, vote: false
           lean: {state, on, off, of, text}, flips: [{id, label, from, to, at, value, dist, text}] },
  trade_day: { phase, target, as_of, cushion_pct, gex_negative,
               calls: { QQQ: {median_r, mean_r, p_r_ge_1, zone, band: {id, median_r, share_ge_1, n}, implied_1sd, assumed: [], text,
                              p_trend, trend: {p, source: "model"|"band base rate", skill, band_pct, band_n, base_pct, text},
                              // connector (get_signal_board) only:
                              gamma: {as_of, mode, spot, net_gamma_bn, flip, flip_usable, call_wall, call_wall_gamma_bn, pin_lo, pin_hi, trap_near, move_1sd, stale} | null,
                              conflict: {call_zone, gamma_reads: "pinned"|"unstable", rules: [...], detail: [{id, text}], sigma_usd, gamma_as_of, gamma_mode, overrides: false, text} | null},
                              // public /api/indicators?board=1 instead: no `gamma` key at all, and
                              // conflict: {call_zone, gamma_reads, rules: [...], overrides: false, text}   // text has no price level
                        SPY: {...} },
               checkpoints: { QQQ: [{at: "10:00", ok, fr_sigma, band, quiet_below, confirm_at, history, text}, {at: "10:30", ..., history: {..., trend_day_pct, trend_n, trend_base_pct, trend_span}}], SPY: [...] } },
  scorecard: { scored_days, signals: {<row id>: {on|off: {QQQ_1: {n, hit_pct, mean_pct}, ...}}}, calls: {QQQ: {last20, last60}, SPY: {...}} } }
```

**Public vs connector.** Gamma levels never leave on the public route:
- `/api/indicators?board=1`, and so `data/signal_board_history.json`, which is written from it into the public repo, omits each call's `gamma` object.
- On that route, `conflict` carries only `call_zone`, `gamma_reads`, the rule ids, `overrides: false` and a generic sentence with no price in it (e.g. "live gamma shows a pin near spot").
- The token-gated `get_signal_board` tool carries the full `gamma` object and the level-bearing `conflict` (`detail`, `sigma_usd`, `gamma_as_of`, `gamma_mode`).
- Both are computed the same way; only the public answer is trimmed (`publicTradeDay` in `lib/signalBoard.js`).
- The Market Read page and the Daily Brief read the connector, so they get the full view.
- The snapshot keeps rule ids only.

## A. Market Read artifact

1. **Add a dataset** `signal_board` (kind `query`; connector "Market Read Dashboard Gamma"; tool `get_signal_board`; args `{}`). Use a loader that parses the JSON text and returns `data: board.rows`, with `meta` carrying `board.clusters`, `board.lean`, `board.flips`, `trade_day` and `scorecard`. It should fail on `ok: false` with the `errors` text.
2. **Add a "Signal Board" section at the top**, above "What changed":
   - one table row per `board.rows` entry: label, value, `roc` with its `roc_label`, a state chip from `state` (on = green, off = red, neutral = grey, null = "not wired"/"—" with `text`), `benchmark` as the hover text, and `as_of`;
   - grouped under the four `clusters` with their state;
   - the `lean.text` as the section headline;
   - `flips[].text` as "What flips it".

   Rows with `vote: false` (opex, KOSPI, the four crypto rows, narrative) get a muted "not voted" tag. The narrative row (`ai_narrative`) has two inputs: `value` is the 5-day tone change, `roc` is the 5d-vs-20d coverage change, and `thresholds.coverage_pct` is the coverage gate. Its `flip.text` and `metrics` (share, 5v5, 20v20, tone) say the rest. Show `flip.text` rather than composing one.
3. **Delete the chips `chip1`–`chip4`** and show the four cluster states in their place. The notes file stops writing `chip*`.
4. **★ Combined angle:** replace the "≥2 of sections 2–5 agree" rule text with the board's lean. Keep the `conf*` idea cards, but only when their `via` clusters match the board's non-neutral clusters.
5. **Cross-check:** delete the `x_credit` and `x_breadth` lines. The board's `hy_oas`, `hyg_lqd` and `breadth` rows carry them with thresholds. Keep `x_auction` and `x_skip` (renamed as the day needs).
6. **Delete the `hy_oas` dataset** and point the `t_rates` HY OAS row at the board's `hy_oas` row (`roc` = level, `value` = 5-print bp change).
7. **Add the trade-day call** to the Gamma section header, from `trade_day.calls.QQQ` then `.SPY`:
   - the zone chip;
   - "median R ×, P(≥1.0×) %", plus the band's "median ×, share ≥1.0× of n days";
   - `assumed`, when present;
   - **P(trend):** "P(trend day) `trend.band_pct`% (band) · all days `trend.base_pct`%". While `trend.source` is `"band base rate"` (it is on 20 Oct 2026, for both tickers), label it "band base rate, no model skill" in muted text and never as a forecast. Hover: `trend.text`;
   - **Conflict:** when `conflict` is non-null, show an amber "⚠ gamma disagrees" line under the ticker's chip with `conflict.text`. The zone chip stays as the call made it; never recolour or replace it. When `gamma.stale` is true, show "gamma board stale — no conflict check" instead.

   Show `trade_day.checkpoints` as two small lines per ticker, with the threshold before the window closes and the band and history after it.
8. **Keep everything else as is:**
   - the `ratios`/`corr` cards and their stats, which are charts;
   - `sr_levels`, the gamma datasets, `spx_map`, `cal`, `earn`, `history`, `px_hist`, `us02y` and `ib`.

## B. `current-market-read` skill

- **"What to analyse" step 4 (Ratios), 2nd-tier ratios, and step 9 (Cross-check):**
  - Read `get_signal_board` first.
  - Credit vs equities, breadth, "SqueezeMetrics GEX/DIX vs dvcap sign" and put/call now come from the board rows (`hy_oas`, `hyg_lqd`, `breadth`, `cushion`, `put_call`). Remove those four items from the manual cross-check list.
  - AAII, COT, ACM, auctions, FactSet and FMS stay manual.
- **Chips:** stop writing `chip1`–`chip4` (the page shows cluster states).
- **★ Combined angle:** an idea qualifies only when the board's lean or at least two **clusters** agree, not two page sections. Name the clusters in `via`.
- **New rule:** the read's headline must not contradict the board's lean without saying why. If the prose disagrees, state the board's lean and the 2–3 `flips` that would change it.
- **Data rules:** add "Signal Board rows carry their own as-of; HY OAS is a session late."

## C. `morning-gamma-regime` skill (Daily Brief)

1. **Gather:**
   - Replace "SqueezeMetrics DIX.csv (`curl`)" with one `get_signal_board` call. Fall back to the board endpoint with Bash `curl`, under the same rules as the gamma boards: never WebFetch, never print the URL.
   - Keep the gamma boards for structure.
2. **The gamma call, step 3 (cushion):**
   - Delete the hand percentile and the per-ticker midpoint blend.
   - `cushion_pct` = `trade_day.cushion_pct`; `gex_negative` = `trade_day.gex_negative`.
   - The per-ticker zone is `trade_day.calls.<T>.zone`, which uses the same cut-offs (≥1.0 Trade, 0.9–1.0 Selective, <0.9 Lean skip) applied to the model's median R.
   - `cushion_text` quotes `calls.QQQ.text`, then SPY's.
   - The page's gamma bar should draw `median_r` directly instead of blending bucket midpoints. That is a page change on the brief artifact; until then, keep writing `cushion_pct`.
3. **Step 6 `lean`** follows `calls.QQQ.zone` (unchanged order: Trade / Selective / Lean skip / "Wait for the print").
4. **Step 7 `tell`:** replace "09:30–10:30 range > half the implied 1σ" with the two checkpoints from `trade_day.checkpoints`. Give the dollar thresholds as `confirm_at × implied_1sd` and `quiet_below × implied_1sd`:
   - QQQ: 10:00 ≥0.50σ / <0.33σ, 10:30 ≥0.70σ / <0.43σ;
   - SPY: 10:00 ≥0.40σ / <0.25σ, 10:30 ≥0.55σ / <0.32σ.
5. **P(trend) and the conflict flag:**
   - `cushion_text`: after each ticker's `calls.<T>.text`, which already ends with the P(trend day) sentence, add nothing more for P(trend). While `trend.source` is `"band base rate"`, do not call a trend day likely or unlikely from it. The ≥80th band's ~42% against ~49% is the only step worth one clause.
   - When `calls.<T>.conflict` is non-null, add one line to `lean_reason`: "Gamma disagrees: " + `conflict.text`. Keep `lean` exactly as `calls.QQQ.zone` gives it. The flag informs, it never overrides: do not move the lean a notch for it.
   - `tell` (step 7): at 10:30, after the band, quote `history.trend_day_pct` against `history.trend_base_pct`, labelled "ended a trend day", as history only.
6. **The cushion table:** keep it for reference, but quote the band's **median and share of days ≥1.0×** (`band.median_r`, `band.share_ge_1`), not a single ×.
7. **Self-scoring:** a weekday workflow writes the board and the call to `data/signal_board_history.json` before the US open and scores them afterwards. Show `scorecard.calls.QQQ.last20` / `last60` (hit %, Brier) in `lean_reason` once `n` ≥ 10.
8. **Asia tiles:** keep them. When the board's `kospi` row carries the Crown flag, mention it with its tested number (59.6% vs 55.7% base, n 416), not 80%.

## D. One-time checks after deploy

- `/api/indicators?board=1` answers `ok: true`, and `errors` lists only expected gaps (put/call until the cross-check feed has run once; HY OAS if the FRED key is unset).
- The connector lists three tools. The claude.ai connector settings may need a refresh to show `get_signal_board`.
- After the first scheduled run, `signal board` commits one row to `data/signal_board_history.json`.

## E. Crypto rows (added 20 Oct 2026): where they go

There are four rows, all `dim: "crypto"` inside the Tape cluster and all `vote: false`. None is voted; the reasons are in `docs/signal-board-audit.md` §7.

| id | value | thresholds (on / off) | extra |
|---|---|---|---|
| `btc_ma` | BTC closes above its 20/50/100/200-day averages, 0–4 | 4 / ≤1 (the QQQ/SOXX rule) | `mas` (distances); `break_200d`; flag text when today is the first close below the 200-day after ≥20 above |
| `btc_qqq` | BTC ÷ QQQ % change over 20 US sessions | +12% / −8% | `roc` = 5-session % |
| `eth_btc` | ETH ÷ BTC % change over 20 days | +5.5% / −7.5% | `roc` = 5-day % |
| `btc_dd` | BTC close vs its 52-week closing high, % | −7.5% / −45% | `high`, `high_date` |

BTC trades every day, so the rows' `as_of` can be a weekend date or today. US spot bitcoin ETF flows are not wired, because no free source works without scraping.

**Market Read artifact** (the steps in A cover these rows automatically; these are the only additions):
- In the Signal Board table, show the four crypto rows as a sub-group under **Tape**, labelled "Crypto (shown, not voted)". Keep them below KOSPI and out of the cluster tally.
- In the cross-asset / ★ Combined angle area, when `btc_ma.flags` is non-empty, show the flag text verbatim as a warning line. It is the only crypto reading with a tested lead on QQQ: 54% vs 24% for a ≥5% QQQ fall within 20 sessions, n 13.
- In the existing gold / BTC cross-asset line (the debasement read), add `btc_dd.text` and `btc_qqq.text` as one line beneath it. Do not add a second BTC quote; the page already shows BTC's price.
- Do not add crypto to `ratios` / `corr`. Correlation already lives there, and BTC ÷ QQQ is now a board row.

**Daily Brief (`morning-gamma-regime`)**:
- In the "overnight" block, add one line from the board: `btc_ma.text` (trend and nearest average), then `btc_qqq.text` and `eth_btc.text`. BTC is the only risk asset that traded through the weekend and the US night, so this line carries the overnight risk-appetite read. Quote the as-of date.
- When `btc_ma.flags` is non-empty, say so in `lean_reason` with the tested numbers, and never as a vote on the lean.
- Do not turn the crypto rows into a gamma or trade-day input. They were tested against QQQ/SOXX direction, not against range R.

**`current-market-read`**: in the cross-asset step, read the four rows from `get_signal_board` instead of quoting BTC by hand. The headline may cite them as context but must not count them toward a cluster.

## F. P(trend), the conflict flag and the quarterly refit (added 20 Oct 2026)

Evidence and rules are in `docs/signal-board-audit.md` §8–10.

**P(trend day)** = the close in the top or bottom 20% of the day's range. It is a different definition from the Gamma tab's ATR trend day, so never put the two side by side as one number.
- `calls.<T>.p_trend` is the number to show; `calls.<T>.trend` says where it came from.
- The fitted model had no out-of-sample skill (walk-forward 2016–2026, n 2,714; Brier skill score +0.004 QQQ / +0.002 SPY with intervals spanning zero). The value is therefore the cushion band's base rate, and `trend.text` says so in words. Show `trend.text` on hover, not a composed sentence.
- If a later refit flips `skill` to true, `trend.source` becomes `"model"`. The same fields then carry the model's probability, and the label drops "band base rate".

**Conflict flag** (`calls.<T>.conflict`):
- **Market Read:** an amber line under the trade-day chip in the Gamma section header, `conflict.text` verbatim, with `conflict.detail[].text` as bullets on expand. The ladder and levels already shown are the same board (`gamma_as_of`, `gamma_mode`).
- **Daily Brief:** one line in `lean_reason` (C.5). The page's gamma bar keeps drawing `median_r`.
- **`current-market-read`:** when a conflict is present, the gamma prose must name both views: the call's zone and what the structure reads. Do not let the structure silently win.
- **Never:** recolour the zone, change `lean`, or count the conflict as a cluster vote.

**Quarterly refit.** Nothing to wire. A pull request titled "Trade-day refit proposal: data to <date> (not applied)" appears only when performance moved past the thresholds. Adopting it means copying `docs/trade-day-refit/proposed.json`'s `r` / `trend` blocks into `lib/tradeDayModel.json` by hand and running `npm test`. The skills and the page read the numbers through `get_signal_board` and need no change.
