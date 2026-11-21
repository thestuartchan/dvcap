#!/usr/bin/env python3
# scripts/quiet-day-condors.py — RESEARCH ONLY (12 Nov 2026; results in docs/quiet-day-condors/README.md).
# Does selling a defined-risk 0DTE iron condor pay on the trade-day call's "Likely quiet" (free) days?
#
# THE DAYS. The same panels and walk-forward as scripts/trade-day-plans-backtest.py (imported, not copied):
# each year from 2016 is predicted by a fit on 2012 → the year before; the MORNING P(R ≥ 1.0) (gap 0, IV
# unchanged) gives the verdict free (< 0.30) / check / desk (≥ 0.50), lib/signalBoard.js PLANS. QQQ on QQQ
# bars + VXN; SPX on ^GSPC bars + VIX (the SPY call's model), each on its own P.
#
# THE TRADE, every session, at the open:
#   σ        the implied 1-day move = prior close VXN / VIX ÷ 100 ÷ √252, as a fraction; σ$ = open × σ
#   shorts   call at open × (1 + kσ), put at open × (1 − kσ), k = 1.0 / 1.5 / 2.0
#   wings    0.5σ further out each side (width 0.5σ$); strikes are not rounded to a listed grid
#   credit   Black–Scholes mid, r = 0, at one of two vols for the session's total s.d.:
#              INDEX   σ itself (prior-close VIX / VXN ÷ √252), 2016 → . An UPPER BOUND: it charges the buyer
#                      the whole day's implied variance, overnight included, for a 09:30–16:00 option.
#              0DTE    the market's own 0DTE price: Cboe VIX1D at the open ÷ 100 ÷ √252 for SPX; for QQQ the
#                      same ratio applied to VXN (VXN × VIX1D open ÷ prior VIX close — there is no QQQ 1-day
#                      index). VIX1D's open prints from 2023-04-03 (earlier rows carry only a close).
#                      2023-04 → 2026-11, VIX1D open ÷ prior VIX close has median 0.62, and SPX open→close
#                      log returns ÷ the VIX1D s.d. have s.d. 0.97 (÷ the VIX s.d.: 0.62) — VIX1D is the fair one.
#            minus the HAIRCUT: half the bid/ask on each of the 4 legs — QQQ $0.01 a leg, SPX 0.10 pt a leg —
#            plus commission $0.65 a contract (QQQ $0.0065 a share a leg; SPX 0.0065 pt a leg). Paid again on an
#            early close. The mid (no haircut) and 2× the haircut are shown as checks.
#   settle   at the close (cash value of the four legs at the session close; QQQ's physical settlement and
#            early assignment are ignored)
#   max risk wing width − credit. P&L is reported in σ$ and in % of max risk.
# VARIANT B — the 10:00 ET kill switch: if the first 30 minutes' range ÷ open ÷ σ ≥ the "moving" level (QQQ
# 0.50, SPX 0.40, docs/trade-day-checkpoint.md), buy the condor back at the 10:00 price, Black–Scholes with the
# remaining s.d. σ × √(6 / 6.5), plus the haircut again. TradingView 30-minute bars (NASDAQ:QQQ, SP:SPX),
# regular session, reach back to 2025-01-02 only, so B is scored 2025-01 → and A is shown on the same days.
#
# Inputs: $D as scripts/trade-day-refit.py (dix.csv, VIX.csv, VXN.csv, d_QQQ.json, d_%5EGSPC.json, d_SPY.json), plus
#   curl -sSL https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX1D_History.csv -o $D/VIX1D.csv
# and $D/QQQ_30m.json and $D/SPX_30m.json ({bars: {t, o, h, l, c}}, t epoch s — TradingView's OHLCV shape).
#   python3 -I scripts/quiet-day-condors.py $D [--json OUT]
import sys, os, json, math, importlib.util, datetime as dt
from zoneinfo import ZoneInfo
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
rf = load('refit', 'trade-day-refit.py')
pl = load('plans', 'trade-day-plans-backtest.py')

D = sys.argv[1]
JSON_OUT = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
NY = ZoneInfo('America/New_York')
FREE, DESK = 0.30, 0.50
KS = [1.0, 1.5, 2.0]
WING = 0.5
HALF = {'QQQ': 0.01, 'SPX': 0.10}      # half the bid/ask a leg, $ (QQQ per share) or index points (SPX)
FEE = {'QQQ': 0.0065, 'SPX': 0.0065}   # commission a leg, in $ (QQQ per share) or index points (SPX per point)
MOVING = {'QQQ': 0.50, 'SPX': 0.40}
TODAY = dt.date.today().isoformat()

N = np.vectorize(lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2))))
def bs(S, K, v, call):
    # r = 0; v = total s.d. of log price to expiry (> 0)
    d1 = (np.log(S / K) + v * v / 2) / v; d2 = d1 - v
    return S * N(d1) - K * N(d2) if call else K * N(-d2) - S * N(-d1)

def condor_value(S, kc, kp, w, v):
    return (bs(S, kc, v, True) - bs(S, kc + w, v, True)) + (bs(S, kp, v, False) - bs(S, kp - w, v, False))

def condor_payoff(S, kc, kp, w):
    return (np.clip(S - kc, 0, w)) + (np.clip(kp - S, 0, w))

def intraday(f):
    b = json.load(open(f))['bars']
    t = pd.to_datetime(b['t'], unit='s', utc=True).tz_convert(NY)
    d = pd.DataFrame({'o': b['o'], 'h': b['h'], 'l': b['l'], 'c': b['c']}, index=t)
    first = d[d.index.strftime('%H:%M') == '09:30']
    first.index = pd.to_datetime(first.index.date)
    return first   # the 09:30–10:00 bar: its open, high, low and close (the 10:00 price)

def simulate(df, t, k, iv_scale=1.0, kill=None, price='index', hair=1.0):
    o = df.o.values; c = df.c.values; s = df.imp.values
    sd = o * s                                   # σ$
    w = WING * sd
    kc, kp = o * (1 + k * s), o * (1 - k * s)
    pv = (s if price == 'index' else df.imp0.values) * iv_scale
    mid = condor_value(o, kc, kp, w, pv)
    cost = hair * 4 * HALF[t] + 4 * FEE[t]
    credit = mid - cost
    pnl = credit - condor_payoff(c, kc, kp, w)
    killed = np.zeros(len(df), bool)
    if kill is not None:
        fr, px10 = kill['fr'].values, kill['c10'].values
        killed = fr >= MOVING[t]
        buy = condor_value(px10, kc, kp, w, pv * math.sqrt(6 / 6.5)) + cost
        pnl = np.where(killed, credit - buy, pnl)
    risk = w - credit
    return pd.DataFrame({'pnl_sigma': pnl / sd, 'pnl_risk': pnl / risk, 'credit_sigma': credit / sd, 'risk_sigma': risk / sd, 'killed': killed}, index=df.index)

def worst_run(series_on_all_days, n=20):
    return float(series_on_all_days.rolling(n, min_periods=1).sum().min())

def summarize(sim, mask, all_index):
    x = sim[mask]
    if not len(x): return dict(n=0)
    on_all = pd.Series(0.0, index=all_index); on_all[x.index] = x.pnl_sigma.values
    on_all_r = pd.Series(0.0, index=all_index); on_all_r[x.index] = x.pnl_risk.values
    return dict(n=int(len(x)), win=round(float((x.pnl_sigma > 0).mean()) * 100, 1),
                mean_s=round(float(x.pnl_sigma.mean()), 4), median_s=round(float(x.pnl_sigma.median()), 4),
                mean_r=round(float(x.pnl_risk.mean()) * 100, 2), median_r=round(float(x.pnl_risk.median()) * 100, 2),
                worst_s=round(float(x.pnl_sigma.min()), 3), worst_r=round(float(x.pnl_risk.min()) * 100, 1),
                run20_s=round(worst_run(on_all), 3), run20_r=round(worst_run(on_all_r) * 100, 1),
                credit_s=round(float(x.credit_sigma.mean()), 4), killed=round(float(x.killed.mean()) * 100, 1),
                total_s=round(float(x.pnl_sigma.sum()), 2))

def line(lbl, k, s, extra=''):
    if not s.get('n'): return f'| {lbl} | {k} | 0 | — | — | — | — | — | — | — | — |'
    return (f"| {lbl} | ±{k}σ | {s['n']} | {s['win']:.0f}% | {s['credit_s']:.3f} | {s['mean_s']:+.3f} · {s['median_s']:+.3f} | "
            f"{s['mean_r']:+.1f}% · {s['median_r']:+.1f}% | {s['worst_s']:+.2f}σ ({s['worst_r']:+.0f}%) | {s['run20_s']:+.2f}σ ({s['run20_r']:+.0f}%) |{extra}")

HDR = '| verdict | shorts | n | win | credit σ | P&L σ mean · median | % of max risk mean · median | worst day | worst 20-session run |'
SEP = '|---|---|---|---|---|---|---|---|---|'

def vix1d_ratio():
    a = pd.read_csv(os.path.join(D, 'VIX1D.csv')); a.index = pd.to_datetime(a.DATE)
    a = a[~((a.OPEN == a.HIGH) & (a.OPEN == a.LOW) & (a.OPEN == a.CLOSE))]          # rows with a real open print
    v = pd.read_csv(os.path.join(D, 'VIX.csv')); v.index = pd.to_datetime(v.DATE)
    return (a.OPEN / v.CLOSE.shift(1).reindex(a.index)).dropna()                     # VIX1D open ÷ prior VIX close

def table_a(title, df, t, price, verdicts=('free', 'check', 'desk', 'all'), res=None):
    print(f'\n### {title}\n'); print(HDR); print(SEP)
    for v in verdicts:
        for k in KS:
            m = (df.verdict == v).values if v != 'all' else np.ones(len(df), bool)
            s = summarize(simulate(df, t, k, price=price), m, df.index)
            if res is not None: res[f'{v} {k}'] = s
            print(line(v, k, s))

def main():
    P = rf.panels(D)
    ratio = vix1d_ratio()
    out = {}
    for t, name, f30 in [('QQQ', 'QQQ', 'QQQ_30m.json'), ('SPX', 'SPX', 'SPX_30m.json')]:
        df = P[name]; df = df[df.index < TODAY]
        w = pl.walk_forward(df)
        df = df.loc[w.index].copy(); df['p'] = w.p.values
        df['verdict'] = np.where(df.p < FREE, 'free', np.where(df.p >= DESK, 'desk', 'check'))
        idx = df.index
        print(f'\n## {t}: walk-forward {idx[0].date()} → {idx[-1].date()}, n {len(df)}; free {np.mean(df.verdict == "free") * 100:.0f}% · check {np.mean(df.verdict == "check") * 100:.0f}% · desk {np.mean(df.verdict == "desk") * 100:.0f}% of days')
        oc = (df.c - df.o).abs() / df.o / df.imp
        print(f'R (range ÷ σ) median: free {df.R[df.verdict == "free"].median():.2f}, check {df.R[df.verdict == "check"].median():.2f}, desk {df.R[df.verdict == "desk"].median():.2f}; '
              f'|close − open| ÷ σ median: free {oc[df.verdict == "free"].median():.2f}, all {oc.median():.2f}; '
              f'close beyond ±1σ of the open: free {(oc[df.verdict == "free"] > 1).mean() * 100:.1f}%, all {(oc > 1).mean() * 100:.1f}%')
        res = {'index': {}, '0dte': {}, 'B': {}}
        table_a(f'{t} — hold to the close, credit at the INDEX vol (upper bound), 2016 → 2026', df, t, 'index', res=res['index'])
        # The market's 0DTE price: VIX1D at the open.
        d0 = df.join(ratio.rename('r1d'), how='inner')
        d0['imp0'] = d0.imp * d0.r1d
        d0 = d0.dropna(subset=['imp0'])
        print(f'\n{t}: 0DTE pricing days {d0.index[0].date()} → {d0.index[-1].date()}, n {len(d0)}; pricing s.d. ÷ σ median {d0.r1d.median():.2f}')
        table_a(f'{t} — hold to the close, credit at the 0DTE price (VIX1D open), {d0.index[0].date()} → {d0.index[-1].date()}', d0, t, '0dte', res=res['0dte'])
        for hair, key, what in ((0.0, '0dte_mid', 'at the MID, no haircut (the gross edge before costs)'), (2.0, '0dte_2x', 'at 2× the haircut')):
            print(f'\n### {t} — the same {what}, free and all days\n'); print(HDR); print(SEP)
            res[key] = {}
            for v in ('free', 'all'):
                for k in KS:
                    m = (d0.verdict == v).values if v != 'all' else np.ones(len(d0), bool)
                    s = summarize(simulate(d0, t, k, price='0dte', hair=hair), m, d0.index); res[key][f'{v} {k}'] = s
                    print(line(v, k, s))
        # Variant B on the intraday period, 0DTE pricing.
        fb = intraday(os.path.join(D, f30))
        fb = fb[fb.index.isin(d0.index)]
        sub = d0.loc[fb.index]
        kill = pd.DataFrame({'fr': (fb.h - fb.l).values / sub.o.values / sub.imp.values, 'c10': fb.c.values}, index=fb.index)
        print(f'\n### {t} — B: the 10:00 ET kill switch (first 30 min ≥ {MOVING[t]:.2f}σ → buy back at 10:00), 0DTE pricing, {fb.index[0].date()} → {fb.index[-1].date()}, n {len(sub)}\n')
        print('| verdict | shorts | n | killed | A hold: mean σ · win · worst day · worst 20 | B kill: mean σ · win · worst day · worst 20 |'); print('|---|---|---|---|---|---|')
        for v in ['free', 'check', 'desk', 'all']:
            for k in KS:
                m = (sub.verdict == v).values if v != 'all' else np.ones(len(sub), bool)
                a = summarize(simulate(sub, t, k, price='0dte'), m, sub.index); b = summarize(simulate(sub, t, k, price='0dte', kill=kill), m, sub.index)
                res['B'][f'{v} {k}'] = {'A': a, 'B': b}
                if not a.get('n'): print(f'| {v} | ±{k}σ | 0 | — | — | — |'); continue
                print(f"| {v} | ±{k}σ | {a['n']} | {b['killed']:.0f}% | {a['mean_s']:+.3f} · {a['win']:.0f}% · {a['worst_s']:+.2f}σ · {a['run20_s']:+.2f}σ | "
                      f"{b['mean_s']:+.3f} · {b['win']:.0f}% · {b['worst_s']:+.2f}σ · {b['run20_s']:+.2f}σ |")
        out[t] = res
    if JSON_OUT: json.dump(out, open(JSON_OUT, 'w'), indent=1)

if __name__ == '__main__':
    main()
