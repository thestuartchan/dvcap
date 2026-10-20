#!/usr/bin/env python3
# scripts/trade-day-v2-calibrate.py — the numbers lib/signalBoard.js's trade-day call v2 carries (20 Oct 2026).
#
# Builds on scripts/trade-day-checkpoint-backtest.py (PR #384, same inputs, same definitions) and adds
# what the engine needs to state a call as a DISTRIBUTION rather than a mean:
#   1. the pre-open log-linear model (log R ~ cushion + |gap|/implied + prior-day R + overnight IV change),
#      fit 2012–2020: betas AND the residual standard deviation, so P(R ≥ 1) = Φ((log R̂) / σ);
#      its out-of-sample (2021→) calibration by predicted decile, so the probability is checked, not assumed;
#   2. per cushion band (negative GEX its own band, as lib/trendTells.js CUSHION): the MEDIAN R and the
#      share of days with R ≥ 1.0, the two figures the board shows beside the band;
#   3. per checkpoint band (quiet / middle / confirm at 10:00 and 10:30, PR #384's thresholds): the median
#      R_rest, the share of days with R_rest ≥ its median, and the share whose FULL-day R ended ≥ 1.0.
#
# Definitions (market data only; nothing here reads an account):
#   implied  prior close VXN (QQQ) / VIX (SPX, SPY) ÷ 100 ÷ √252
#   R        (session high − low) ÷ open ÷ implied
#   FR30/60  first 30 / 60 minutes' range ÷ open ÷ implied; R_rest = the rest of the session's range ÷
#            the checkpoint price ÷ the same full-day implied
#   cushion  SqueezeMetrics SPX GEX at the prior close, percentile (0–100) vs the 252 rows before it
#
# Inputs: the same directory $D as scripts/trade-day-checkpoint-backtest.py (its header lists the curl
# commands). Run: python3 -I scripts/trade-day-v2-calibrate.py $D
import json, sys, datetime as dt, math
from zoneinfo import ZoneInfo
import numpy as np, pandas as pd

D = sys.argv[1]
NY = ZoneInfo('America/New_York')
Phi = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))

def yahoo_daily(f):
    r = json.load(open(f))['chart']['result'][0]; q = r['indicators']['quote'][0]
    return pd.DataFrame({'o': q['open'], 'h': q['high'], 'l': q['low'], 'c': q['close']},
                        index=pd.to_datetime(r['timestamp'], unit='s').normalize()).dropna()

def cboe(f):
    d = pd.read_csv(f); d.index = pd.to_datetime(d.DATE)
    return d[['OPEN', 'CLOSE']].rename(columns={'OPEN': 'ivo', 'CLOSE': 'iv'})

dix = pd.read_csv(f'{D}/dix.csv', parse_dates=['date']).set_index('date')
dix['pct'] = dix.gex.rolling(253).apply(lambda x: (x[:-1] < x[-1]).mean(), raw=True)
X4 = ['cush', 'gap', 'prevR', 'ivchg']
daily = {}
for name, px, iv in [('QQQ', 'd_QQQ.json', 'VXN.csv'), ('SPX', 'd_%5EGSPC.json', 'VIX.csv')]:
    p = yahoo_daily(f'{D}/{px}').join(cboe(f'{D}/{iv}'), how='inner')
    p['pc'] = p.c.shift(1); p['ivp'] = p.iv.shift(1)
    p['imp'] = p.ivp / 100 / np.sqrt(252)
    p['R'] = (p.h - p.l) / p.o / p.imp
    p['gap'] = (p.o / p.pc - 1).abs() / p.imp
    p['prevR'] = p.R.shift(1)
    p['ivchg'] = p.ivo / p.ivp - 1
    p['cush'] = dix.pct.shift(1).reindex(p.index) * 100
    p['gex'] = dix.gex.shift(1).reindex(p.index)
    daily[name] = p.dropna(subset=['R', 'cush', 'gex'])

out = {'model': {}, 'bands': {}, 'checkpoints': {}}
print('1. PRE-OPEN MODEL, fit 2012–2020, scored 2021→')
for name, p in daily.items():
    q = p.dropna(subset=X4); q = q[q.index >= '2012-01-01']
    tr, te = q[q.index < '2021-01-01'], q[q.index >= '2021-01-01']
    A = np.c_[np.ones(len(tr)), tr[X4]]
    b = np.linalg.lstsq(A, np.log(tr.R), rcond=None)[0]
    sigma = float(np.std(np.log(tr.R) - A @ b, ddof=len(b)))
    lp = np.c_[np.ones(len(te)), te[X4]] @ b
    prob = np.array([Phi(v / sigma) for v in lp])
    hit1 = (te.R.values >= 1)
    dec = pd.qcut(prob, 5, labels=False, duplicates='drop')
    cal = [(round(float(prob[dec == k].mean()), 2), round(float(hit1[dec == k].mean()), 2), int((dec == k).sum())) for k in sorted(set(dec))]
    brier = float(np.mean((prob - hit1) ** 2))
    sp = pd.Series(np.exp(lp)).corr(pd.Series(te.R.values), method='spearman')
    print(f'  {name}: n train {len(tr)} test {len(te)}; betas {np.round(b, 4).tolist()}; σ {sigma:.3f}; OOS Spearman {sp:+.2f}; '
          f'Brier {brier:.3f} (base rate {hit1.mean():.2f} → {np.mean((hit1.mean() - hit1) ** 2):.3f}); calibration by quintile (pred, actual, n) {cal}')
    out['model'][name] = dict(const=round(b[0], 4), cush=round(b[1], 5), gap=round(b[2], 4), prevR=round(b[3], 4), ivchg=round(b[4], 4),
                              sigma=round(sigma, 3), n_train=len(tr), n_test=len(te), oos_spearman=round(sp, 2), calibration=cal)

print('\n2. CUSHION BANDS — median R and share of days R ≥ 1.0 (negative GEX its own band)')
BANDS = [('neg', None, None), ('p0', 0, 20), ('p20', 20, 40), ('p40', 40, 60), ('p60', 60, 80), ('p80', 80, 101)]
for name, p in daily.items():
    rows = {}
    for key, lo, hi in BANDS:
        a = p[p.gex < 0] if key == 'neg' else p[(p.gex >= 0) & (p.cush >= lo) & (p.cush < hi)]
        rows[key] = dict(median=round(float(a.R.median()), 2), share_ge1=round(float((a.R >= 1).mean()), 2), n=int(len(a)))
    out['bands'][name] = rows
    print(f'  {name}: ' + ' · '.join(f'{k} med {v["median"]} ≥1 {v["share_ge1"]:.0%} (n {v["n"]})' for k, v in rows.items()))

def intraday(f):
    j = json.load(open(f)); b = j['bars'] if 'bars' in j else None
    if b: t, o, h, l, c = b['t'], b['o'], b['h'], b['l'], b['c']
    else:
        r = j['chart']['result'][0]; q = r['indicators']['quote'][0]
        t, o, h, l, c = r['timestamp'], q['open'], q['high'], q['low'], q['close']
    rows = [(dt.datetime.fromtimestamp(x, NY), *v) for x, *v in zip(t, o, h, l, c) if None not in v]
    df = pd.DataFrame(rows, columns=['ts', 'o', 'h', 'l', 'c'])
    df = df[(df.ts.dt.time >= dt.time(9, 30)) & (df.ts.dt.time < dt.time(16, 0))]
    df['date'] = pd.to_datetime(df.ts.dt.date); df['hm'] = df.ts.dt.strftime('%H:%M')
    return df

# PR #384's suggested bands (docs/trade-day-checkpoint.md): [quiet below, confirm at or above].
CP = {('QQQ', 30): (0.33, 0.50), ('QQQ', 60): (0.43, 0.70), ('SPY', 30): (0.25, 0.40), ('SPY', 60): (0.32, 0.55)}
print('\n3. CHECKPOINT BANDS — median R_rest, share R_rest ≥ its median, share full-day R ≥ 1.0')
for (sym, cp), (quiet, conf) in CP.items():
    dname = 'QQQ' if sym == 'QQQ' else 'SPX'
    fn = f'{D}/{sym}_30m.json' if cp == 30 else f'{D}/{sym}_1h.json'
    df = intraday(fn); need = 13 if cp == 30 else 7
    recs = []
    for d, g in df.groupby('date'):
        if len(g) != need or g.hm.iloc[0] != '09:30': continue
        o = g.o.iloc[0]; c_hm = '10:00' if cp == 30 else '10:30'
        first, rest = g[g.hm < c_hm], g[g.hm >= c_hm]
        recs.append(dict(date=d, fr=(first.h.max() - first.l.min()) / o, rest=(rest.h.max() - rest.l.min()) / rest.o.iloc[0], R=(g.h.max() - g.l.min()) / o))
    s = pd.DataFrame(recs).set_index('date').join(daily[dname][['imp']], how='inner').dropna()
    s['FR'] = s.fr / s.imp; s['Rr'] = s.rest / s.imp; s['Rd'] = s.R / s.imp
    med = s.Rr.median(); res = {}
    for lab, m in [('quiet', s.FR < quiet), ('middle', (s.FR >= quiet) & (s.FR < conf)), ('confirm', s.FR >= conf)]:
        a = s[m]
        res[lab] = dict(n=int(len(a)), rest_median=round(float(a.Rr.median()), 2), rest_ge_median=round(float((a.Rr >= med).mean()), 2), day_ge1=round(float((a.Rd >= 1).mean()), 2))
    out['checkpoints'][f'{sym}_{"10:00" if cp == 30 else "10:30"}'] = dict(quiet_below=quiet, confirm_at=conf, sample=f'{s.index[0].date()}→{s.index[-1].date()}', **res)
    print(f'  {sym} {"10:00" if cp == 30 else "10:30"} ({s.index[0].date()}→{s.index[-1].date()}, n {len(s)}): ' + ' · '.join(f'{k}: n {v["n"]}, R_rest med {v["rest_median"]}, ≥med {v["rest_ge_median"]:.0%}, day R≥1 {v["day_ge1"]:.0%}' for k, v in res.items()))

print('\nJSON\n' + json.dumps(out, default=float))
