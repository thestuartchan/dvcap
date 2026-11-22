# Noise-band intraday momentum backtest — method

The script is `scripts/noise-band-backtest.py`. This doc covers the rules, data and method only.

**The results are not here.** They're built from Unusual Whales data, which is licensed for Stu's personal use, so the report stays out of this public repo. Stu has it privately.

## Rules tested
| Rule | Definition |
|---|---|
| Opening range | High/low of 09:30–09:45 ET |
| Noise band (reel) | sigma_m = mean of \|close(m) ÷ 09:30 open − 1\| over the previous 20 sessions; band = open × (1 ± 1.25 sigma_m) |
| Noise band (paper) | Zarattini, Aziz & Barbon 2024, *Beat the Market* (SFI RP 24-97): 14 sessions; upper anchored on max(open, prior close), lower on min |
| Checks | Reel: every 10 min, 10:00–14:00, on bar closes. Paper: :00 and :30 from 10:00 |
| Entry (reel) | Close beyond the OR (± room), the band and VWAP, all at once; one trade a day |
| Exit | Reel: 15:45, or trail (give back 50% after X). Paper: trailing max/min(band, VWAP); flat at the close |
| Options | ATM / 1 ITM / 1 OTM; 0DTE, next listed expiry, ~1 week; hold, −50% or −30% stop |
| Sizing | Fixed premium $500 / $1,000 / $2,000; 1% / 2% / 5% of equity; Kelly with a bootstrap range |

## Data
| Source | Coverage | Notes |
|---|---|---|
| UW 1-minute bars (dvcap door `?uw=hist&kind=ohlc`) | 11 Jul 2022 → | UW's history starts here, so 2008 and 2015–21 are out of reach |
| UW option minute trades (`?uw=hist&kind=option`) | ~Apr 2025 → | Trades split by bid/ask side, not NBBO quotes. Buys use the ask-side average; sells use the bid-side average |
| Yahoo ^VIX / ^VXN, SqueezeMetrics GEX | Daily | Regime splits and the Black-Scholes proxy |

The Black-Scholes proxy is used only to show how much it flatters, measured against real trades on the same days. It is never reported as option P&L.

## Running it
```
python3 -I scripts/noise-band-backtest.py $D --fetch-options   # downloads the option-days it needs
python3 -I scripts/noise-band-backtest.py $D --out report.md
```
The header of the script lists how `$D` is filled.
