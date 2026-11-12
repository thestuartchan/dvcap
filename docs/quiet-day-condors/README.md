# Quiet-day condors: does selling 0DTE premium pay on "Likely quiet" days? (12 Nov 2026)

Research only — no dashboard change. Script: `scripts/quiet-day-condors.py` (imports the panels and walk-forward of
`scripts/trade-day-refit.py` / `scripts/trade-day-plans-backtest.py`, PR #445's verdicts).

## Answer

- **No edge on free days.** Priced at what 0DTE options actually cost (Cboe VIX1D at the open), a ±1.0σ condor held to the close on free days lost **−3.3%** of max risk per trade on QQQ and **−1.0%** on SPX (2023-04 → 2026-11, n 437 / 571).
- **Free days are the worst bucket, not the best.** Same trade, SPX: free −1.0%, check +1.8%, desk **+4.9%** of max risk. The quiet is already in the price: VIX1D is low on those days.
- **Before costs it is still about zero.** At the mid, SPX free ±1.0σ makes +0.6% of max risk and QQQ −1.9%. The bid/ask and fees decide it.
- **±1.5σ and ±2.0σ do not pay.** At 0DTE prices the mid credit is below the cost of four legs (credit < 0 after the haircut).
- **The 10:00 ET kill switch does not add edge.** On free days the mean is unchanged (QQQ −0.009σ → −0.008σ, SPX −0.000σ → −0.003σ) and the win rate falls (60% → 47%, 76% → 61%). It does trim the worst 20-session run on "all" days (SPX −1.23σ → −0.76σ, QQQ −1.60σ → −1.36σ).
- **The upper-bound version looks great, and that is the trap.** Price the condor at the prior-close VIX/VXN instead and free days show +14% (QQQ) / +19% (SPX) of max risk. But that charges the buyer a full day's implied variance, overnight included, for a 09:30–16:00 option. VIX1D at the open is a median **0.62×** that, and it matches realised SPX open→close moves (returns ÷ its s.d. have s.d. 0.97; ÷ the VIX s.d., 0.62).

## Headline: ±1.0σ shorts, 0.5σ wings, hold to the close, 0DTE pricing (2023-04 → 2026-11)

| ticker | verdict | n | win | mean P&L, % of max risk | median | worst 20-session run |
|---|---|---|---|---|---|---|
| QQQ | free | 437 | 67% | **−3.3%** | +1.0% | −1.28σ (−261%) |
| QQQ | check | 340 | 79% | −2.3% | +2.8% | −1.01σ |
| QQQ | desk | 130 | 86% | +0.3% | +6.0% | −1.10σ |
| QQQ | all | 907 | 74% | −2.4% | +2.0% | −1.92σ |
| SPX | free | 571 | 80% | **−1.0%** | +1.9% | −1.09σ (−236%) |
| SPX | check | 261 | 90% | +1.8% | +4.5% | −0.73σ |
| SPX | desk | 75 | 89% | +4.9% | +7.6% | −0.64σ |
| SPX | all | 907 | 84% | +0.3% | +2.9% | −1.23σ |

Worst single day is a full loss (−100% of max risk) in every bucket.

## Setup

| item | rule |
|---|---|
| days | QQQ (QQQ bars + VXN) and SPX (^GSPC bars + VIX), walk-forward 2016-01 → 2026-11-11 |
| verdict | morning P(R ≥ 1.0) with gap 0, IV unchanged: free < 0.30, desk ≥ 0.50 (lib/signalBoard.js PLANS) — each ticker on its own P |
| σ | prior-close VXN / VIX ÷ 100 ÷ √252; σ$ = open × σ |
| shorts | open × (1 ± kσ), k = 1.0 / 1.5 / 2.0; wings 0.5σ further out; strikes not rounded to a listed grid |
| credit | Black–Scholes mid, r = 0 |
| pricing vol — 0DTE (main) | VIX1D open ÷ 100 ÷ √252 (SPX); QQQ = VXN × VIX1D open ÷ prior VIX close. VIX1D has open prints from 2023-04-03 |
| pricing vol — index (upper bound) | σ itself, 2016 → |
| haircut | half the bid/ask a leg: **QQQ $0.01, SPX 0.10 pt**; + $0.65 a contract commission. Paid again on an early close. Mid and 2× shown |
| settle | close's intrinsic value; QQQ assignment ignored |
| max risk | wing width − credit |
| B: kill switch | first 30 min range ÷ open ÷ σ ≥ 0.50 (QQQ) / 0.40 (SPX) → buy back at the 10:00 price, BS with s.d. × √(6/6.5), + haircut |
| B period | TradingView 30-min bars (NASDAQ:QQQ, SP:SPX) from **2025-01-02** → 2026-11-11, n 467 |
| worst 20-session run | trading only that bucket's days, the worst sum over any 20 consecutive sessions |

## Caveats

- **No skew.** Black–Scholes at one vol prices far puts too cheap and far calls too rich. Real wing credits differ; the ±1.5σ / ±2.0σ conclusion (no credit after costs) is the most exposed to this.
- **VIX1D open prints are noisy** (the first minutes of the session). The median ratio 0.62 is stable by year (0.66 / 0.63 / 0.62 / 0.57 for 2023–26).
- **QQQ has no 1-day vol index.** Its 0DTE price borrows SPX's VIX1D ÷ VIX ratio.
- **Intraday sample is short** (467 sessions, 171 QQQ free days). Variant B is indicative, not settled.

## Full output

### QQQ: walk-forward 2016-01-04 → 2026-11-11, n 2731; free 42% · check 43% · desk 16% of days
R (range ÷ σ) median: free 0.79, check 0.95, desk 1.18; |close − open| ÷ σ median: free 0.34, all 0.41; close beyond ±1σ of the open: free 9.2%, all 12.8%

#### QQQ — hold to the close, credit at the INDEX vol (upper bound), 2016 → 2026

| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |
|---|---|---|---|---|---|---|---|---|
| free | ±1.0σ | 1139 | 93% | 0.083 | +0.058 · +0.093 | +14.2% · +22.8% | -0.46σ (-100%) | -0.45σ (-106%) |
| free | ±1.5σ | 1139 | 78% | 0.017 | +0.011 · +0.027 | +2.3% · +5.7% | -0.52σ (-100%) | -1.25σ (-241%) |
| free | ±2.0σ | 1139 | 34% | -0.012 | -0.014 · -0.001 | -2.6% · -0.3% | -0.54σ (-100%) | -1.59σ (-292%) |
| check | ±1.0σ | 1165 | 88% | 0.085 | +0.043 · +0.093 | +10.5% · +22.9% | -0.47σ (-100%) | -1.49σ (-371%) |
| check | ±1.5σ | 1165 | 78% | 0.019 | +0.008 · +0.028 | +1.7% · +5.9% | -0.54σ (-100%) | -0.88σ (-172%) |
| check | ±2.0σ | 1165 | 44% | -0.010 | -0.013 · -0.001 | -2.4% · -0.1% | -0.56σ (-100%) | -1.14σ (-206%) |
| desk | ±1.0σ | 427 | 84% | 0.091 | +0.033 · +0.095 | +8.2% · +23.6% | -0.44σ (-100%) | -1.38σ (-340%) |
| desk | ±1.5σ | 427 | 88% | 0.025 | +0.000 · +0.031 | +0.1% · +6.5% | -0.51σ (-100%) | -1.44σ (-296%) |
| desk | ±2.0σ | 427 | 61% | -0.004 | -0.014 · +0.002 | -2.6% · +0.4% | -0.53σ (-100%) | -0.96σ (-187%) |
| all | ±1.0σ | 2731 | 89% | 0.085 | +0.048 · +0.093 | +11.7% · +22.9% | -0.47σ (-100%) | -1.63σ (-391%) |
| all | ±1.5σ | 2731 | 80% | 0.019 | +0.008 · +0.028 | +1.7% · +5.8% | -0.54σ (-100%) | -1.56σ (-325%) |
| all | ±2.0σ | 2731 | 42% | -0.010 | -0.013 · -0.001 | -2.5% · -0.2% | -0.56σ (-100%) | -1.79σ (-329%) |

QQQ: 0DTE pricing days 2023-04-03 → 2026-11-11, n 907; pricing s.d. ÷ σ median 0.62

#### QQQ — hold to the close, credit at the 0DTE price (VIX1D open), 2023-04-03 → 2026-11-11

| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |
|---|---|---|---|---|---|---|---|---|
| free | ±1.0σ | 437 | 67% | 0.012 | -0.017 · +0.005 | -3.3% · +1.0% | -0.51σ (-100%) | -1.28σ (-261%) |
| free | ±1.5σ | 437 | 7% | -0.008 | -0.016 · -0.009 | -3.1% · -1.8% | -0.51σ (-100%) | -0.66σ (-132%) |
| free | ±2.0σ | 437 | 1% | -0.011 | -0.015 · -0.011 | -2.8% · -2.2% | -0.51σ (-100%) | -0.68σ (-134%) |
| check | ±1.0σ | 340 | 79% | 0.022 | -0.012 · +0.013 | -2.3% · +2.8% | -0.50σ (-100%) | -1.01σ (-210%) |
| check | ±1.5σ | 340 | 17% | -0.003 | -0.015 · -0.006 | -2.9% · -1.2% | -0.51σ (-100%) | -0.67σ (-132%) |
| check | ±2.0σ | 340 | 2% | -0.008 | -0.011 · -0.008 | -2.3% · -1.6% | -0.51σ (-100%) | -0.58σ (-115%) |
| desk | ±1.0σ | 130 | 86% | 0.047 | +0.003 · +0.028 | +0.3% · +6.0% | -0.46σ (-100%) | -1.10σ (-298%) |
| desk | ±1.5σ | 130 | 48% | 0.008 | -0.010 · -0.000 | -2.1% · -0.0% | -0.50σ (-100%) | -0.99σ (-211%) |
| desk | ±2.0σ | 130 | 13% | -0.004 | -0.012 · -0.006 | -2.4% · -1.2% | -0.50σ (-100%) | -0.56σ (-111%) |
| all | ±1.0σ | 907 | 74% | 0.021 | -0.012 · +0.010 | -2.4% · +2.0% | -0.51σ (-100%) | -1.92σ (-427%) |
| all | ±1.5σ | 907 | 17% | -0.004 | -0.015 · -0.007 | -2.9% · -1.4% | -0.51σ (-100%) | -1.48σ (-294%) |
| all | ±2.0σ | 907 | 3% | -0.009 | -0.013 · -0.009 | -2.6% · -1.8% | -0.51σ (-100%) | -0.73σ (-144%) |

#### QQQ — the same at the MID, no haircut (the gross edge before costs), free and all days

| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |
|---|---|---|---|---|---|---|---|---|
| free | ±1.0σ | 437 | 84% | 0.019 | -0.009 · +0.012 | -1.9% · +2.5% | -0.50σ (-100%) | -1.14σ (-235%) |
| free | ±1.5σ | 437 | 24% | -0.001 | -0.009 · -0.003 | -1.7% · -0.5% | -0.51σ (-100%) | -0.55σ (-111%) |
| free | ±2.0σ | 437 | 2% | -0.004 | -0.007 · -0.004 | -1.5% · -0.8% | -0.50σ (-100%) | -0.57σ (-113%) |
| all | ±1.0σ | 907 | 86% | 0.027 | -0.006 · +0.017 | -1.1% · +3.4% | -0.50σ (-100%) | -1.79σ (-407%) |
| all | ±1.5σ | 907 | 38% | 0.003 | -0.008 · -0.001 | -1.7% · -0.3% | -0.51σ (-100%) | -1.35σ (-273%) |
| all | ±2.0σ | 907 | 9% | -0.003 | -0.007 · -0.004 | -1.4% · -0.7% | -0.50σ (-100%) | -0.59σ (-117%) |

#### QQQ — the same at 2× the haircut, free and all days

| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |
|---|---|---|---|---|---|---|---|---|
| free | ±1.0σ | 437 | 43% | 0.005 | -0.024 · -0.002 | -4.7% · -0.5% | -0.51σ (-100%) | -1.43σ (-286%) |
| free | ±1.5σ | 437 | 2% | -0.015 | -0.023 · -0.016 | -4.4% · -3.0% | -0.52σ (-100%) | -0.78σ (-151%) |
| free | ±2.0σ | 437 | 0% | -0.018 | -0.022 · -0.018 | -4.2% · -3.5% | -0.52σ (-100%) | -0.79σ (-153%) |
| all | ±1.0σ | 907 | 57% | 0.015 | -0.018 · +0.003 | -3.7% · +0.7% | -0.51σ (-100%) | -2.04σ (-447%) |
| all | ±1.5σ | 907 | 10% | -0.010 | -0.021 · -0.013 | -4.1% · -2.5% | -0.52σ (-100%) | -1.60σ (-314%) |
| all | ±2.0σ | 907 | 1% | -0.015 | -0.019 · -0.015 | -3.7% · -3.0% | -0.52σ (-100%) | -0.88σ (-170%) |

#### QQQ — B: the 10:00 ET kill switch (first 30 min ≥ 0.50σ → buy back at 10:00), 0DTE pricing, 2025-01-02 → 2026-11-11, n 467

| verdict | shorts | n | killed | A hold: mean σ · win · worst day · worst 20 | B kill: mean σ · win · worst day · worst 20 |
|---|---|---|---|---|---|
| free | ±1.0σ | 171 | 20% | -0.009 · 60% · -0.51σ · -0.58σ | -0.008 · 47% · -0.50σ · -0.58σ |
| free | ±1.5σ | 171 | 20% | -0.013 · 6% · -0.51σ · -0.63σ | -0.012 · 4% · -0.51σ · -0.65σ |
| free | ±2.0σ | 171 | 20% | -0.013 · 0% · -0.51σ · -0.66σ | -0.013 · 0% · -0.51σ · -0.67σ |
| check | ±1.0σ | 205 | 33% | -0.009 · 80% · -0.50σ · -1.01σ | -0.016 · 55% · -0.49σ · -0.84σ |
| check | ±1.5σ | 205 | 33% | -0.011 · 22% · -0.50σ · -0.67σ | -0.016 · 9% · -0.50σ · -0.68σ |
| check | ±2.0σ | 205 | 33% | -0.010 · 3% · -0.51σ · -0.58σ | -0.012 · 1% · -0.30σ · -0.45σ |
| desk | ±1.0σ | 91 | 47% | -0.000 · 84% · -0.46σ · -1.10σ | -0.013 · 45% · -0.40σ · -0.78σ |
| desk | ±1.5σ | 91 | 47% | -0.016 · 52% · -0.50σ · -0.99σ | -0.016 · 23% · -0.47σ · -0.74σ |
| desk | ±2.0σ | 91 | 47% | -0.014 · 15% · -0.50σ · -0.56σ | -0.012 · 3% · -0.07σ · -0.34σ |
| all | ±1.0σ | 467 | 31% | -0.007 · 73% · -0.51σ · -1.60σ | -0.012 · 50% · -0.50σ · -1.36σ |
| all | ±1.5σ | 467 | 31% | -0.013 · 22% · -0.51σ · -1.48σ | -0.015 · 10% · -0.51σ · -0.86σ |
| all | ±2.0σ | 467 | 31% | -0.012 · 4% · -0.51σ · -0.68σ | -0.012 · 1% · -0.51σ · -0.69σ |

### SPX: walk-forward 2016-01-04 → 2026-11-11, n 2731; free 56% · check 31% · desk 12% of days
R (range ÷ σ) median: free 0.71, check 0.89, desk 1.13; |close − open| ÷ σ median: free 0.32, all 0.37; close beyond ±1σ of the open: free 6.7%, all 10.3%

#### SPX — hold to the close, credit at the INDEX vol (upper bound), 2016 → 2026

| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |
|---|---|---|---|---|---|---|---|---|
| free | ±1.0σ | 1538 | 95% | 0.095 | +0.076 · +0.098 | +18.7% · +24.4% | -0.42σ (-100%) | -0.75σ (-188%) |
| free | ±1.5σ | 1538 | 98% | 0.029 | +0.022 · +0.032 | +4.8% · +6.8% | -0.48σ (-100%) | -0.40σ (-82%) |
| free | ±2.0σ | 1538 | 62% | -0.000 | -0.002 · +0.003 | -0.4% · +0.7% | -0.51σ (-100%) | -0.66σ (-131%) |
| check | ±1.0σ | 856 | 91% | 0.097 | +0.066 · +0.099 | +16.5% · +24.8% | -0.42σ (-100%) | -0.95σ (-237%) |
| check | ±1.5σ | 856 | 97% | 0.031 | +0.024 · +0.034 | +5.2% · +7.2% | -0.47σ (-100%) | -0.45σ (-96%) |
| check | ±2.0σ | 856 | 67% | 0.002 | +0.000 · +0.005 | +0.1% · +1.0% | -0.50σ (-100%) | -0.56σ (-110%) |
| desk | ±1.0σ | 337 | 82% | 0.099 | +0.034 · +0.098 | +8.4% · +24.3% | -0.41σ (-100%) | -2.09σ (-524%) |
| desk | ±1.5σ | 337 | 93% | 0.033 | +0.014 · +0.034 | +3.1% · +7.3% | -0.47σ (-100%) | -0.87σ (-185%) |
| desk | ±2.0σ | 337 | 79% | 0.004 | -0.002 · +0.006 | -0.3% · +1.1% | -0.50σ (-100%) | -0.70σ (-141%) |
| all | ±1.0σ | 2731 | 92% | 0.096 | +0.068 · +0.098 | +16.8% · +24.4% | -0.42σ (-100%) | -1.73σ (-433%) |
| all | ±1.5σ | 2731 | 97% | 0.030 | +0.022 · +0.032 | +4.7% · +6.9% | -0.48σ (-100%) | -1.00σ (-212%) |
| all | ±2.0σ | 2731 | 66% | 0.001 | -0.001 · +0.004 | -0.2% · +0.8% | -0.51σ (-100%) | -0.83σ (-165%) |

SPX: 0DTE pricing days 2023-04-03 → 2026-11-11, n 907; pricing s.d. ÷ σ median 0.62

#### SPX — hold to the close, credit at the 0DTE price (VIX1D open), 2023-04-03 → 2026-11-11

| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |
|---|---|---|---|---|---|---|---|---|
| free | ±1.0σ | 571 | 80% | 0.016 | -0.005 · +0.010 | -1.0% · +1.9% | -0.50σ (-100%) | -1.09σ (-236%) |
| free | ±1.5σ | 571 | 11% | -0.004 | -0.011 · -0.006 | -2.3% · -1.1% | -0.51σ (-100%) | -0.62σ (-124%) |
| free | ±2.0σ | 571 | 1% | -0.007 | -0.010 · -0.007 | -2.0% · -1.4% | -0.51σ (-100%) | -0.65σ (-128%) |
| check | ±1.0σ | 261 | 90% | 0.030 | +0.007 · +0.022 | +1.8% · +4.5% | -0.49σ (-100%) | -0.73σ (-151%) |
| check | ±1.5σ | 261 | 41% | 0.002 | -0.002 · -0.002 | -0.3% · -0.3% | -0.48σ (-97%) | -0.50σ (-99%) |
| check | ±2.0σ | 261 | 6% | -0.005 | -0.005 · -0.005 | -0.9% · -1.0% | -0.01σ (-2%) | -0.09σ (-18%) |
| desk | ±1.0σ | 75 | 89% | 0.059 | +0.022 · +0.035 | +4.9% · +7.6% | -0.46σ (-100%) | -0.64σ (-190%) |
| desk | ±1.5σ | 75 | 68% | 0.015 | +0.000 · +0.006 | -0.1% · +1.2% | -0.42σ (-100%) | -0.55σ (-135%) |
| desk | ±2.0σ | 75 | 28% | 0.001 | -0.008 · -0.004 | -1.8% · -0.8% | -0.47σ (-100%) | -0.54σ (-116%) |
| all | ±1.0σ | 907 | 84% | 0.024 | +0.001 · +0.014 | +0.3% · +2.9% | -0.50σ (-100%) | -1.23σ (-265%) |
| all | ±1.5σ | 907 | 24% | -0.001 | -0.008 · -0.004 | -1.5% · -0.9% | -0.51σ (-100%) | -0.62σ (-125%) |
| all | ±2.0σ | 907 | 5% | -0.006 | -0.009 · -0.006 | -1.7% · -1.2% | -0.51σ (-100%) | -0.65σ (-129%) |

#### SPX — the same at the MID, no haircut (the gross edge before costs), free and all days

| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |
|---|---|---|---|---|---|---|---|---|
| free | ±1.0σ | 571 | 94% | 0.024 | +0.002 · +0.017 | +0.6% · +3.6% | -0.49σ (-100%) | -1.04σ (-230%) |
| free | ±1.5σ | 571 | 78% | 0.004 | -0.004 · +0.001 | -0.8% · +0.3% | -0.50σ (-100%) | -0.49σ (-99%) |
| free | ±2.0σ | 571 | 22% | 0.000 | -0.003 · -0.000 | -0.5% · -0.1% | -0.50σ (-100%) | -0.51σ (-102%) |
| all | ±1.0σ | 907 | 93% | 0.031 | +0.007 · +0.021 | +1.8% · +4.5% | -0.49σ (-100%) | -1.11σ (-242%) |
| all | ±1.5σ | 907 | 83% | 0.006 | -0.001 · +0.002 | -0.1% · +0.5% | -0.50σ (-100%) | -0.48σ (-98%) |
| all | ±2.0σ | 907 | 35% | 0.001 | -0.002 · -0.000 | -0.3% · -0.1% | -0.50σ (-100%) | -0.51σ (-102%) |

#### SPX — the same at 2× the haircut, free and all days

| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |
|---|---|---|---|---|---|---|---|---|
| free | ±1.0σ | 571 | 58% | 0.009 | -0.013 · +0.002 | -2.5% · +0.4% | -0.51σ (-100%) | -1.20σ (-252%) |
| free | ±1.5σ | 571 | 3% | -0.011 | -0.019 · -0.012 | -3.7% · -2.4% | -0.52σ (-100%) | -0.76σ (-150%) |
| free | ±2.0σ | 571 | 0% | -0.015 | -0.018 · -0.014 | -3.5% · -2.8% | -0.51σ (-100%) | -0.79σ (-153%) |
| all | ±1.0σ | 907 | 67% | 0.017 | -0.006 · +0.007 | -1.1% · +1.4% | -0.51σ (-100%) | -1.36σ (-288%) |
| all | ±1.5σ | 907 | 12% | -0.008 | -0.015 · -0.011 | -2.8% · -2.1% | -0.52σ (-100%) | -0.77σ (-152%) |
| all | ±2.0σ | 907 | 2% | -0.013 | -0.015 · -0.013 | -3.0% · -2.4% | -0.51σ (-100%) | -0.80σ (-156%) |

#### SPX — B: the 10:00 ET kill switch (first 30 min ≥ 0.40σ → buy back at 10:00), 0DTE pricing, 2025-01-02 → 2026-11-11, n 467

| verdict | shorts | n | killed | A hold: mean σ · win · worst day · worst 20 | B kill: mean σ · win · worst day · worst 20 |
|---|---|---|---|---|---|
| free | ±1.0σ | 251 | 19% | -0.000 · 76% · -0.50σ · -0.73σ | -0.003 · 61% · -0.50σ · -0.58σ |
| free | ±1.5σ | 251 | 19% | -0.010 · 13% · -0.51σ · -0.59σ | -0.009 · 8% · -0.51σ · -0.62σ |
| free | ±2.0σ | 251 | 19% | -0.010 · 1% · -0.51σ · -0.62σ | -0.009 · 0% · -0.51σ · -0.63σ |
| check | ±1.0σ | 166 | 38% | +0.003 · 87% · -0.49σ · -0.73σ | -0.012 · 54% · -0.49σ · -0.62σ |
| check | ±1.5σ | 166 | 38% | -0.003 · 41% · -0.48σ · -0.50σ | -0.010 · 22% · -0.48σ · -0.58σ |
| check | ±2.0σ | 166 | 38% | -0.004 · 7% · -0.01σ · -0.07σ | -0.007 · 3% · -0.03σ · -0.13σ |
| desk | ±1.0σ | 50 | 60% | +0.013 · 86% · -0.46σ · -0.64σ | +0.001 · 40% · -0.27σ · -0.32σ |
| desk | ±1.5σ | 50 | 60% | -0.002 · 76% · -0.42σ · -0.55σ | -0.004 · 28% · -0.03σ · -0.10σ |
| desk | ±2.0σ | 50 | 60% | -0.010 · 38% · -0.47σ · -0.54σ | -0.007 · 8% · -0.02σ · -0.13σ |
| all | ±1.0σ | 467 | 30% | +0.003 · 81% · -0.50σ · -1.23σ | -0.006 · 56% · -0.50σ · -0.76σ |
| all | ±1.5σ | 467 | 30% | -0.007 · 30% · -0.51σ · -0.59σ | -0.009 · 15% · -0.51σ · -0.65σ |
| all | ±2.0σ | 467 | 30% | -0.008 · 7% · -0.51σ · -0.62σ | -0.008 · 2% · -0.51σ · -0.65σ |
