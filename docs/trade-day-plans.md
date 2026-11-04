# Trade-day plans verdict: free / check / desk

The Signal Board's trade-day call now carries a `plans` object (`trade_day.plans`, beside `calls`). It
is a three-way verdict for the Dubai morning, about 10 hours before the US open:

| verdict | rule (QQQ morning P(R ≥ 1.0)) | meaning |
|---|---|---|
| `free` | P < 0.30 | low chance of a moving day: make plans |
| `check` | 0.30 ≤ P < 0.50 | decide at the pre-open update (17:35 Dubai, 08:35 ET), which adds the futures gap |
| `desk` | P ≥ 0.50 | likely a moving day |

A moving day means R ≥ 1.0, where R = session high − low ÷ open ÷ implied 1σ (prior-close VXN ÷ 100 ÷ √252).

**Which P.** The verdict always reads the **morning** probability, which is the call with gap 0 and IV
unchanged. That is what the backtest scored, because the morning decision is made before the gap is
known. Once a gap is known (futures-implied, pre-market or the actual open), `calls.QQQ.p_r_ge_1` moves
with it. A `check` day then also gets `plans.pre_open`: it leans `desk` when that P is ≥ 0.55, and
otherwise says to let the 10:00 ET checkpoint decide. The board informs. It never blocks a trade.

Source: `scripts/trade-day-plans-backtest.py` (it imports the panels and fits of
`scripts/trade-day-refit.py`), run on 4 Nov 2026. The constants are in `lib/signalBoard.js` `PLANS`.

## Backtest

The data is SqueezeMetrics DIX.csv, Cboe VXN/VIX and Yahoo daily bars. SPY is scored on the S&P index
bars with VIX, as the SPY call is. Every number is out of sample:

- **Walk-forward 2016 → 2026-11** (n 2,725): each year is predicted by a fit on 2012 → the year before.
- **Production 2021 → 2026-11** (n 1,466): the coefficients in `lib/tradeDayModel.json` (fit 2012–2020).

Columns: share of days in each verdict, the share of those days that reached R ≥ 1.0, **missed big** (the
share of R ≥ 1.3 days that fell in free), 1 in N free days that ended R ≥ 1.3, and **desk dud** (the share
of desk days that ended R < 0.9).

### QQQ, model, walk-forward (all days: R≥1.0 42%, R≥1.3 20%; Spearman 0.34)

| free < | desk ≥ | free | free R≥1 | check | check R≥1 | desk | desk R≥1 | missed big | 1 in N free big | desk dud |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.30 | 0.50 | 42% | 29% | 43% | 45% | 16% | 64% | 25% | 8.1 | 23% |
| 0.30 | 0.55 | 42% | 29% | 50% | 47% | 8% | 73% | 25% | 8.1 | 15% |
| 0.30 | 0.60 | 42% | 29% | 55% | 49% | 4% | 77% | 25% | 8.1 | 14% |
| 0.35 | 0.50 | 54% | 31% | 30% | 49% | 16% | 64% | 35% | 7.6 | 23% |
| 0.35 | 0.55 | 54% | 31% | 38% | 50% | 8% | 73% | 35% | 7.6 | 15% |
| 0.35 | 0.60 | 54% | 31% | 42% | 52% | 4% | 77% | 35% | 7.6 | 14% |
| 0.40 | 0.50 | 66% | 33% | 18% | 52% | 16% | 64% | 47% | 7.0 | 23% |
| 0.40 | 0.55 | 66% | 33% | 26% | 53% | 8% | 73% | 47% | 7.0 | 15% |
| 0.40 | 0.60 | 66% | 33% | 30% | 55% | 4% | 77% | 47% | 7.0 | 14% |

### QQQ, model, production coefficients 2021 → (all days: R≥1.0 44%, R≥1.3 21%)

| free < | desk ≥ | free | free R≥1 | check | check R≥1 | desk | desk R≥1 | missed big | 1 in N free big | desk dud |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.30 | 0.50 | 43% | 35% | 41% | 47% | 16% | 61% | 29% | 7.0 | 25% |
| 0.30 | 0.55 | 43% | 35% | 49% | 49% | 9% | 66% | 29% | 7.0 | 20% |
| 0.35 | 0.50 | 54% | 35% | 30% | 52% | 16% | 61% | 39% | 6.6 | 25% |
| 0.40 | 0.55 | 66% | 38% | 26% | 54% | 9% | 66% | 51% | 6.2 | 20% |

### QQQ, baseline: the cushion band only (P = the band's share of R ≥ 1.0, known at the time), walk-forward

The band rates come in steps (about 26 / 38 / 42 / 51 / 60 / 68%), so several cut-offs give the same split.

| free < | desk ≥ | free | free R≥1 | check | check R≥1 | desk | desk R≥1 | missed big | 1 in N free big | desk dud |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.30 / 0.35 | 0.50 | 28% | 26% | 39% | 40% | 33% | 57% | 14% | 9.8 | 31% |
| 0.30 / 0.35 | 0.55 | 28% | 26% | 50% | 41% | 22% | 62% | 14% | 9.8 | 26% |
| 0.30 / 0.35 | 0.60 | 28% | 26% | 58% | 45% | 13% | 62% | 14% | 9.8 | 27% |
| 0.40 | 0.50 | 47% | 30% | 20% | 42% | 33% | 57% | 31% | 7.6 | 31% |
| 0.40 | 0.55 | 47% | 30% | 31% | 44% | 22% | 62% | 31% | 7.6 | 26% |

**What the extra inputs add, honestly.** In the morning the only input beyond the cushion is the prior
day's R, because the gap and the IV change are taken as 0. Compared at the **same share of days**, the
model and the band table come out almost the same. With 28% of days free, the model misses 15% of big
days and the bands miss 14%. With 47% free it is 29% against 31%. With 33% of days at the desk, both
reach 1.0× 57–58% of the time. The model's gain is resolution. It can split a band, so it offers a
2-day-a-week free set and a desk set as small as 8–16% of days at 64–73%, which the steps of the band
table cannot produce. The gap is what really sharpens the call, and that is why `check` waits for 08:35 ET.

### SPY (S&P model, VIX), walk-forward (all days: R≥1.0 31%, R≥1.3 15%; Spearman 0.38)

| free < | desk ≥ | free | free R≥1 | check | check R≥1 | desk | desk R≥1 | missed big | 1 in N free big | desk dud |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.30 | 0.50 | 56% | 20% | 31% | 38% | 12% | 61% | 32% | 12.0 | 27% |
| 0.30 | 0.55 | 56% | 20% | 36% | 40% | 7% | 68% | 32% | 12.0 | 23% |
| 0.35 | 0.50 | 66% | 22% | 22% | 41% | 12% | 61% | 41% | 11.0 | 27% |
| 0.35 | 0.55 | 66% | 22% | 27% | 43% | 7% | 68% | 41% | 11.0 | 23% |
| 0.40 | 0.50 | 75% | 24% | 13% | 43% | 12% | 61% | 52% | 9.9 | 27% |
| 0.40 | 0.60 | 75% | 24% | 21% | 47% | 4% | 74% | 52% | 9.9 | 21% |

On the cushion band alone (free < 0.30, desk ≥ 0.55), SPY splits 45% / 45% / 10% of days: free days
reach R ≥ 1.0 20% of the time, desk days 64%, 25% of big days are missed and 25% of desk days are duds.

## Chosen: free < 0.30, desk ≥ 0.50 (QQQ)

- **Free on about 2 days a week (42–43%).** On those days 29–35% still reach 1.0×, against 42–44% on all
  days. About **1 in 7–8 free days turns out big** (R ≥ 1.3), and a quarter of all big days (25–29%)
  fall on a free day. Moving the line to 0.35 frees one more day in ten but misses 35–39% of big days.
- **Desk on about 3 days a month (16%).** Close to 2 in 3 of them move (61–64% reach 1.0×), and about 1
  in 4 (23–25%) ends quiet, below 0.9×. A cut at 0.55 is sharper (66–73%, duds 15–20%) but fires only
  about twice a month and sends the rest to `check`.
- **Check on the rest (41–43%).** These are coin flips (45–47% reach 1.0×). At 08:35 ET, check days
  whose pre-open P (with the actual gap) reached ≥ 0.55 went on to 1.0× 58% of the time, against 43%
  for the rest (walk-forward). The live board uses the futures-implied gap, so it reads a little less
  sharply than that.

## The 10:00 ET checkpoint as the safety net

The test was the free-verdict days (cut 0.30) from 2025-01 on that turned out big (R ≥ 1.3). There are
13 of them, read from 30-minute TradingView bars (that record starts in 2025-01). The 10:00 ET confirm
(first 30 min ≥ 0.50σ) **caught 5 of 13** (2025-06-05, 2025-07-31, 2025-11-13, 2026-06-05, 2026-09-21).
Three were in the middle band, and five were quiet at 10:00 and moved later (for example 2025-10-10,
R 3.1, was 0.29σ at 10:00). The 10:30 ET confirm (first hour ≥ 0.70σ) caught 5, and **either
checkpoint caught 8 of 13**.

How often it is a false alarm on a free day is known only from the last 60 sessions (Yahoo 30-minute
bars): 21 free days, the 10:00 confirm fired on 4, 2 of those reached 1.0× and 1 ended big. That is
indicative only. Across all days, the 10:00 confirm band historically ended ≥ 1.0× 67% of the time (n
138, `CHECKPOINTS`).

`.github/workflows/checkpoint-ping.yml` → `api/tradecard.js?card=checkpoint` → `lib/checkpointPing.js`
posts one Discord message with your mention to the trades channel when QQQ's 10:00 read is `confirm`.
It uses the same service-key gate and the same webhook and mention as the trade alerts, and posts at
most once per New York day. Quiet and middle days post nothing.

To reproduce: fetch the inputs listed in `scripts/trade-day-refit.py`, then run
`python3 -I scripts/trade-day-plans-backtest.py $D --out $OUT`.
