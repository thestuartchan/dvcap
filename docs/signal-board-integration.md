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
           clusters: [{id: macro|dealers|tape|narrative, label, state, on, off, neutral, rows}],
           lean: {state, on, off, of, text}, flips: [{id, label, from, to, at, value, dist, text}] },
  trade_day: { phase, target, as_of, cushion_pct, gex_negative,
               calls: { QQQ: {median_r, mean_r, p_r_ge_1, zone, band: {id, median_r, share_ge_1, n}, implied_1sd, assumed: [], text}, SPY: {...} },
               checkpoints: { QQQ: [{at: "10:00", ok, fr_sigma, band, quiet_below, confirm_at, history, text}, {at: "10:30", ...}], SPY: [...] } },
  scorecard: { scored_days, signals: {<row id>: {on|off: {QQQ_1: {n, hit_pct, mean_pct}, ...}}}, calls: {QQQ: {last20, last60}, SPY: {...}} } }
```

## A. Market Read artifact

1. **Add a dataset** `signal_board` (kind `query`; connector "Market Read Dashboard Gamma"; tool `get_signal_board`; args `{}`). Use a loader that parses the JSON text and returns `data: board.rows`, with `meta` carrying `board.clusters`, `board.lean`, `board.flips`, `trade_day` and `scorecard`. It should fail on `ok: false` with the `errors` text.
2. **Add a "Signal Board" section at the top**, above "What changed":
   - one table row per `board.rows` entry: label, value, `roc` with its `roc_label`, a state chip from `state` (on = green, off = red, neutral = grey, null = "not wired"/"—" with `text`), `benchmark` as the hover text, and `as_of`;
   - grouped under the four `clusters` with their state;
   - the `lean.text` as the section headline;
   - `flips[].text` as "What flips it".

   Rows with `vote: false` (opex, KOSPI, narrative) get a muted "not voted" tag.
3. **Delete the chips `chip1`–`chip4`** and show the four cluster states in their place. The notes file stops writing `chip*`.
4. **★ Combined angle:** replace the "≥2 of sections 2–5 agree" rule text with the board's lean. Keep the `conf*` idea cards, but only when their `via` clusters match the board's non-neutral clusters.
5. **Cross-check:** delete the `x_credit` and `x_breadth` lines. The board's `hy_oas`, `hyg_lqd` and `breadth` rows carry them with thresholds. Keep `x_auction` and `x_skip` (renamed as the day needs).
6. **Delete the `hy_oas` dataset** and point the `t_rates` HY OAS row at the board's `hy_oas` row (`roc` = level, `value` = 5-print bp change).
7. **Add the trade-day call** to the Gamma section header, from `trade_day.calls.QQQ` then `.SPY`:
   - the zone chip;
   - "median R ×, P(≥1.0×) %", plus the band's "median ×, share ≥1.0× of n days";
   - `assumed`, when present.

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
5. **The cushion table:** keep it for reference, but quote the band's **median and share of days ≥1.0×** (`band.median_r`, `band.share_ge_1`), not a single ×.
6. **Self-scoring:** a weekday workflow writes the board and the call to `data/signal_board_history.json` before the US open and scores them afterwards. Show `scorecard.calls.QQQ.last20` / `last60` (hit %, Brier) in `lean_reason` once `n` ≥ 10.
7. **Asia tiles:** keep them. When the board's `kospi` row carries the Crown flag, mention it with its tested number (59.6% vs 55.7% base, n 416), not 80%.

## D. One-time checks after deploy

- `/api/indicators?board=1` answers `ok: true`, and `errors` lists only expected gaps (put/call until the cross-check feed has run once; HY OAS if the FRED key is unset).
- The connector lists three tools. The claude.ai connector settings may need a refresh to show `get_signal_board`.
- After the first scheduled run, `signal board` commits one row to `data/signal_board_history.json`.
