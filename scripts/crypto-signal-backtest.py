#!/usr/bin/env python3
# scripts/crypto-signal-backtest.py — do the Signal Board's crypto rows say anything about QQQ and SOXX?
#
# THE ROWS (lib/signalBoard.js cryptoRows), rebuilt on daily history:
#   btc_ma      BTC closes above its 20/50/100/200-day averages (BTC's own 7-day daily bars), 0–4;
#               the QQQ/SOXX rule: 4 risk-on, 0–1 risk-off.
#   btc_qqq     BTC ÷ QQQ over 20 US sessions, % (crypto leading or lagging equity risk appetite).
#   eth_btc     ETH ÷ BTC over 20 days, % (speculative breadth inside crypto).
#   btc_dd      BTC close vs its 52-week (365-day) closing high, %.
# Thresholds for the three continuous rows are their own quartiles over the sample (printed below).
#
# TIMING (the one trap). Yahoo dates a BTC bar by its UTC day, so the close dated t prints at 00:00 UTC
# t+1 = 20:00 ET t, four hours AFTER the US close of t. Scoring QQQ close(t) → close(t+k) on that bar
# would let the 16:00–20:00 crypto move, which overnight futures share, leak into the answer. The
# headline therefore reads BTC/ETH as of the bar dated t−1 (the last close known before 16:00 ET t);
# the same-date read is printed as a check on how much the leak flatters it.
#
# OUTCOMES. Forward QQQ and SOXX returns 1/3/5 sessions from the close of t (adjusted closes). Hit rate:
# risk-on → up, risk-off → down, against the base rate of the same sample. Spearman of the row's value
# against the forward return. 3- and 5-session windows overlap, so their n overstates independent
# observations; the 1-session binomial p is the honest significance test. Split 2015–2020 / 2021–2026.
# LEAD/LAG: from each first BTC close below its 200-day average after ≥20 days above, QQQ's worst
# drawdown over the next 20/60 sessions against the same measure on all days; and whether BTC's
# 52-week-high drawdown crossing −20% led QQQ's own −10% drawdowns.
#
# Data: Yahoo chart API, no sign-up (market data only):
#   for s in BTC-USD ETH-USD QQQ SOXX; do curl -sS -A 'Mozilla/5.0' \
#     "https://query2.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=1388534400&period2=$(date +%s)" -o "$D/d_$s.json"; done
#   python3 -I scripts/crypto-signal-backtest.py $D
import json, sys, math
import pandas as pd

D = sys.argv[1]

def daily(f, adj=True):
    r = json.load(open(f))['chart']['result'][0]
    q = r['indicators']['quote'][0]
    c = (r['indicators'].get('adjclose') or [{}])[0].get('adjclose') if adj else None
    c = c or q['close']
    off = r['meta'].get('gmtoffset', 0)
    idx = pd.to_datetime([t + off for t in r['timestamp']], unit='s').normalize()
    s = pd.Series(c, index=idx, dtype='float64').dropna()
    return s[~s.index.duplicated(keep='last')]

def binom_p(k, n, p):
    lp = lambda i: math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * math.log(p) + (n - i) * math.log(1 - p)
    pmf = [math.exp(lp(i)) for i in range(n + 1)]
    obs = pmf[k]
    return min(1.0, sum(x for x in pmf if x <= obs * (1 + 1e-9)))

btc, eth = daily(f'{D}/d_BTC-USD.json', False), daily(f'{D}/d_ETH-USD.json', False)
qqq, soxx = daily(f'{D}/d_QQQ.json'), daily(f'{D}/d_SOXX.json')

# Crypto-calendar measures, on BTC's own daily bars.
ma = pd.concat([btc.rolling(n).mean() for n in (20, 50, 100, 200)], axis=1)
btc_ma = (ma.lt(btc, axis=0)).sum(axis=1).where(ma.notna().all(axis=1))
btc_dd = (btc / btc.rolling(365, min_periods=365).max() - 1) * 100
eb = (eth / btc).dropna()
eth_btc = (eb / eb.shift(20) - 1) * 100
crypto = pd.DataFrame({'btc_ma': btc_ma, 'btc_dd': btc_dd, 'eth_btc': eth_btc, 'btc': btc})

def frame(lag):
    # Each US session t reads the crypto bar dated t − lag calendar days (lag 1 = the headline).
    c = crypto.copy(); c.index = c.index + pd.Timedelta(days=lag)
    f = pd.DataFrame({'qqq': qqq, 'soxx': soxx}).dropna().join(c, how='left')
    f['btc_qqq'] = ((f.btc / f.qqq) / (f.btc / f.qqq).shift(20) - 1) * 100
    for t in ('qqq', 'soxx'):
        for k in (1, 3, 5):
            f[f'{t}_{k}'] = (f[t].shift(-k) / f[t] - 1) * 100
    return f

f = frame(1)
start = f.dropna(subset=['btc_ma']).index[0]
f = f[f.index >= start]
print(f'Sample: {f.index[0].date()} → {f.index[-1].date()} ({len(f)} US sessions); ETH from {f.dropna(subset=["eth_btc"]).index[0].date()}; 52w high from {f.dropna(subset=["btc_dd"]).index[0].date()}')

# Quartile thresholds for the continuous rows.
TH = {}
for col in ('btc_qqq', 'eth_btc', 'btc_dd'):
    x = f[col].dropna()
    TH[col] = (x.quantile(0.25), x.quantile(0.75))
    print(f'  {col}: p25 {TH[col][0]:+.1f}%  p75 {TH[col][1]:+.1f}%  (n {len(x)})')

# The board's thresholds (rounded from the quartiles above; see lib/signalBoard.js THRESHOLDS).
RULES = {
    'btc_ma': (+1, 4, 1),
    'btc_qqq': (+1, 12, -8),
    'eth_btc': (+1, 5.5, -7.5),
    'btc_dd': (+1, -7.5, -45),
}
def state(v, r):
    d, on, off = r
    if pd.isna(v): return None
    if d > 0: return 'on' if v >= on else 'off' if v <= off else 'neutral'
    return 'off' if v >= off else 'on' if v <= on else 'neutral'

def score(f, label):
    print(f'\n=== {label} ===')
    out = {}
    for row, r in RULES.items():
        st = f[row].map(lambda v: state(v, r))
        print(f'\n{row} (on {r[1]}, off {r[2]}):  days on {int((st=="on").sum())}, neutral {int((st=="neutral").sum())}, off {int((st=="off").sum())}')
        for h in ('qqq_1', 'qqq_3', 'qqq_5', 'soxx_1', 'soxx_5'):
            m = f[h].notna() & st.notna()
            base = (f.loc[m, h] > 0).mean()
            on = f.loc[m & (st == 'on'), h]; off = f.loc[m & (st == 'off'), h]
            hit_on, hit_off = (on > 0).mean(), (off < 0).mean()
            rho = f.loc[m, [row, h]].corr(method='spearman').iloc[0, 1]
            p = ''
            if h.endswith('_1'):
                p = f'  p(on) {binom_p(int((on > 0).sum()), len(on), base):.2f}  p(off) {binom_p(int((off < 0).sum()), len(off), 1 - base):.2f}'
            print(f'  {h:7s} base up {base:5.1%} | on n {len(on):4d} up {hit_on:5.1%} mean {on.mean():+.2f}% | off n {len(off):4d} down {hit_off:5.1%} (base down {1-base:5.1%}) mean {off.mean():+.2f}% | Spearman {rho:+.3f}{p}')
            out[(row, h)] = (len(on), hit_on, len(off), hit_off, base, rho)
    return out

score(f, 'HEADLINE: crypto as of the bar dated t−1 (known before the US close)')
for a, b in (('2015', '2020'), ('2021', '2026')):
    score(f[(f.index >= f'{a}-01-01') & (f.index <= f'{b}-12-31')], f'SPLIT {a}–{b}')
g = frame(0); g = g[g.index >= start]
print('\n=== CHECK: same-date crypto bar (prints 4h after the US close — leaks) ===')
for row in RULES:
    print(f'  {row}: Spearman vs qqq_1 {g[[row, "qqq_1"]].corr(method="spearman").iloc[0,1]:+.3f} (headline {f[[row, "qqq_1"]].corr(method="spearman").iloc[0,1]:+.3f})')

# Redundancy: does BTC's trend add anything on days the QQQ trend row already reads?
qma = pd.concat([f.qqq.rolling(n).mean() for n in (20, 50, 100, 200)], axis=1)
f['qqq_ma'] = qma.lt(f.qqq, axis=0).sum(axis=1).where(qma.notna().all(axis=1))
print('\n=== REDUNDANCY: QQQ 5-session forward return by QQQ trend state × BTC trend state ===')
for qs in ('on', 'neutral', 'off'):
    for bs in ('on', 'neutral', 'off'):
        m = (f.qqq_ma.map(lambda v: state(v, RULES['btc_ma'])) == qs) & (f.btc_ma.map(lambda v: state(v, RULES['btc_ma'])) == bs) & f.qqq_5.notna()
        x = f.loc[m, 'qqq_5']
        if len(x): print(f'  QQQ {qs:7s} BTC {bs:7s}: n {len(x):4d} up {(x>0).mean():5.1%} mean {x.mean():+.2f}%')

# LEAD/LAG 1: first BTC close below its 200-day after ≥20 days above, QQQ worst drawdown ahead.
def fwd_min(s, n): return pd.concat([s.shift(-k) for k in range(1, n + 1)], axis=1).min(axis=1) / s * 100 - 100
for n in (20, 60):
    f[f'qqq_mdd_{n}'] = fwd_min(f.qqq, n)
b200 = (btc > btc.rolling(200).mean()).astype(float).where(btc.rolling(200).mean().notna())
above_run = b200.groupby((b200 != b200.shift()).cumsum()).cumcount() + 1
brk = (b200 == 0) & (b200.shift(1) == 1) & (above_run.shift(1) >= 20)
ev = [d + pd.Timedelta(days=1) for d in brk[brk].index]        # known at the next US session (t−1 rule)
evd = [f.index[f.index.searchsorted(d)] for d in ev if f.index.searchsorted(d) < len(f)]
evd = [d for d in evd if d >= start]
print(f'\n=== LEAD/LAG: BTC first close below its 200-day after ≥20 days above (n {len(evd)}) ===')
for n in (20, 60):
    col = f'qqq_mdd_{n}'
    allv = f[col].dropna(); evv = f.loc[[d for d in evd if d in f.index], col].dropna()
    print(f'  QQQ worst drawdown next {n} sessions: after breaks median {evv.median():.1f}% (n {len(evv)}), share ≤ −5% {(evv <= -5).mean():.0%} | all days median {allv.median():.1f}%, share ≤ −5% {(allv <= -5).mean():.0%}')
print('  events: ' + ', '.join(str(d.date()) for d in evd))

# LEAD/LAG 2: QQQ −10% drawdowns from a 252-day high — did BTC's 52-week drawdown cross −20% first?
qdd = f.qqq / f.qqq.rolling(252, min_periods=60).max() - 1
starts = qdd[(qdd <= -0.10) & (qdd.shift(1) > -0.10)].index
eps = []
for d in starts:
    if eps and (d - eps[-1]).days < 90: continue
    eps.append(d)
print(f'\n=== LEAD/LAG: QQQ first −10% from its 252-day high (episodes ≥90 days apart, n {len(eps)}) ===')
lead = []
for d in eps:
    w = f.loc[:d].tail(130)                                    # the half-year before
    hit = w[w.btc_dd <= -20]
    first = hit.index[0] if len(hit) else None
    # Only a FRESH crossing counts as a lead: BTC must have been above −20% at the window's start.
    fresh = first is not None and w.btc_dd.iloc[0] > -20
    days = (d - first).days if first is not None else None
    lead.append((d, days, fresh))
    print(f'  {d.date()}: BTC 52w drawdown at the QQQ break {f.loc[d, "btc_dd"]:.0f}%; '
          + (f'crossed −20% {days} days before' + ('' if fresh else ' (already below at window start)') if first is not None else 'BTC never ≤ −20% in the prior 130 sessions'))
fr = [x for x in lead if x[2]]
print(f'  fresh BTC crossings that led a QQQ −10%: {len(fr)} of {len(eps)}; lead days {[x[1] for x in fr]}')
# And the false alarms: fresh BTC −20% crossings NOT followed by a QQQ −10% within 130 sessions.
bc = f.btc_dd
cross = bc[(bc <= -20) & (bc.shift(1) > -20)].index
cr = []
for d in cross:
    if cr and (d - cr[-1]).days < 90: continue
    cr.append(d)
fol = [d for d in cr if (qdd.loc[d:].head(130) <= -0.10).any()]
print(f'  BTC fresh −20% crossings (≥90 days apart): {len(cr)}; followed by QQQ −10% within 130 sessions: {len(fol)}')
# Base rate for the line above: from any session, a QQQ −10% (from its 252-day high) within 130 sessions.
anyq = pd.Series([(qdd.iloc[i + 1:i + 131] <= -0.10).any() for i in range(len(qdd))], index=qdd.index)
print(f'  base: any session followed by a QQQ −10% reading within 130 sessions: {anyq[anyq.index >= start].mean():.0%}')

# CONTROL for the 200-day break: is BTC's break better than QQQ's own first close below its 50-day
# after ≥20 days above? And does the BTC break add anything on days QQQ is still above its 50-day?
q50 = (f.qqq > f.qqq.rolling(50).mean()).astype(float).where(f.qqq.rolling(50).mean().notna())
qrun = q50.groupby((q50 != q50.shift()).cumsum()).cumcount() + 1
qbrk = (q50 == 0) & (q50.shift(1) == 1) & (qrun.shift(1) >= 20)
qev = [d for d in qbrk[qbrk].index if d >= start]
print(f'\n=== CONTROL: QQQ first close below its 50-day after ≥20 days above (n {len(qev)}) ===')
for n in (20, 60):
    col = f'qqq_mdd_{n}'; v = f.loc[qev, col].dropna()
    print(f'  QQQ worst drawdown next {n}: median {v.median():.1f}% (n {len(v)}), share ≤ −5% {(v <= -5).mean():.0%}')
pre = [d for d in evd if d in f.index and q50.loc[d] == 1]
print(f'  BTC 200-day breaks while QQQ was still above its 50-day: n {len(pre)}: ' + ', '.join(f'{d.date()} → 20s {f.loc[d, "qqq_mdd_20"]:.1f}%' for d in pre))
k = int((f.loc[evd, 'qqq_mdd_20'].dropna() <= -5).sum()); n = int(f.loc[evd, 'qqq_mdd_20'].notna().sum())
print(f'  binomial: {k} of {n} BTC breaks saw QQQ ≤ −5% within 20 sessions vs base {(f.qqq_mdd_20.dropna() <= -5).mean():.0%}: p {binom_p(k, n, (f.qqq_mdd_20.dropna() <= -5).mean()):.3f} (events cluster in crashes; not independent)')
