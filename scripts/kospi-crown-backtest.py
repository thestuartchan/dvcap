#!/usr/bin/env python3
# scripts/kospi-crown-backtest.py — Crown's claim, tested: "when KOSPI closes UP after two or more consecutive
# down sessions, the US is up the next session more than 80% of the time" (Crown Macro Desk, 19 Oct 2026).
#
# THE TEST. Day t is a Seoul session that closes up after ≥ N consecutive down closes (N = 2, 3). "The next US
# session" is the first New York session on or after t's calendar date: Seoul closes at 06:30 UTC, New York
# opens at 13:30 UTC the same date, so the Korean result is known before the US open. Two US outcomes:
#   close→close  the US close on that session vs the prior US close (what "US up" usually means), and
#   open→close   the part a trader acting on the Korean result could still capture (the gap is gone).
# Each is reported against its base rate (all US sessions, and all sessions after any KOSPI up day), with
# a two-sided binomial test against the base and the split 2012–2019 / 2020–2026.
#
# Data: Yahoo chart API, keyless (market data only):
#   for s in %5EKS11 QQQ %5EGSPC; do curl -sS -A 'Mozilla/5.0' \
#     "https://query2.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=1293840000&period2=$(date +%s)" -o "$D/d_$s.json"; done
#   python3 -I scripts/kospi-crown-backtest.py $D
# KRX's own KOSPI close is the same series; the KSE index feed's stale INTRADAY value does not enter a
# daily-close test.
import json, sys, math
import pandas as pd

D = sys.argv[1]

def daily(f):
    r = json.load(open(f))['chart']['result'][0]; q = r['indicators']['quote'][0]
    off = r['meta'].get('gmtoffset', 0)
    idx = pd.to_datetime([t + off for t in r['timestamp']], unit='s').normalize()
    return pd.DataFrame({'o': q['open'], 'c': q['close']}, index=idx).dropna().loc[lambda d: ~d.index.duplicated(keep='last')]

def binom_p(k, n, p):
    # two-sided exact binomial test, small and dependency-free
    lp = lambda i: math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * math.log(p) + (n - i) * math.log(1 - p)
    pmf = [math.exp(lp(i)) for i in range(n + 1)]
    obs = pmf[k]
    return min(1.0, sum(x for x in pmf if x <= obs * (1 + 1e-9)))

ks = daily(f'{D}/d_%5EKS11.json')
ks['up'] = ks.c > ks.c.shift(1); ks['dn'] = ks.c < ks.c.shift(1)
run = []; n = 0
for d in ks.dn.shift(1).fillna(False):
    n = n + 1 if d else 0; run.append(n)
ks['prior_down_run'] = run          # consecutive down closes ending the session BEFORE t

us = {}
for name, f in [('QQQ', 'd_QQQ.json'), ('SPX', 'd_%5EGSPC.json')]:
    u = daily(f'{D}/{f}'); u['cc'] = u.c / u.c.shift(1) - 1; u['oc'] = u.c / u.o - 1
    us[name] = u.dropna()

def next_us(u, d):
    i = u.index.searchsorted(d)              # first US session on or after the Seoul date
    return u.iloc[i] if i < len(u) else None

ks = ks[(ks.index >= '2012-01-01')]
print(f'KOSPI sessions {ks.index[0].date()} → {ks.index[-1].date()}: {len(ks)}')
for name, u in us.items():
    u12 = u[u.index >= '2012-01-01']
    base_cc, base_oc = (u12.cc > 0).mean(), (u12.oc > 0).mean()
    print(f'\n{name}: base rate 2012→ (all US sessions, n {len(u12)}): close→close up {base_cc:.1%}, open→close up {base_oc:.1%}')
    def rate(sel, label):
        rows = [next_us(u, d) for d in sel.index]; rows = [r for r in rows if r is not None]
        if not rows: return
        cc = sum(r.cc > 0 for r in rows); oc = sum(r.oc > 0 for r in rows); n = len(rows)
        mcc = sum(r.cc for r in rows) / n * 100
        print(f'  {label:52s} n {n:4d} · close→close up {cc / n:.1%} (p vs base {binom_p(cc, n, base_cc):.2f}) · open→close up {oc / n:.1%} (p {binom_p(oc, n, base_oc):.2f}) · mean c→c {mcc:+.2f}%')
    rate(ks[ks.up], 'after ANY KOSPI up day')
    for N in (2, 3):
        sel = ks[ks.up & (ks.prior_down_run >= N)]
        rate(sel, f'KOSPI up after ≥{N} down sessions (Crown), 2012–2026')
        rate(sel[sel.index < '2020-01-01'], f'   … 2012–2019')
        rate(sel[sel.index >= '2020-01-01'], f'   … 2020–2026')
