#!/usr/bin/env python3
# scripts/trade-day-checkpoint-backtest.py — does the first 30 / 60 minutes tell us how much the REST of
# the day will move, beyond the pre-open trade-day call? (20 Oct 2026)
#
# The morning brief makes a pre-open "Trade day / Selective / Lean skip" call per ticker from the
# SqueezeMetrics cushion (lib/trendTells.js CUSHION). This script:
#   1. RECONCILES that table: rebuilds the range ÷ implied bands every way they could have been built
#      (mean / median, negative-GEX days in or out of the <20th band, divisor open / prior close).
#   2. Fits the pre-open four-factor model (cushion, |gap|/implied, prior-day R, overnight IV change)
#      on 2012–2020 daily bars and scores 2021–2026 out of sample.
#   3. INTRADAY CHECKPOINT: on 30-minute and hourly bars, asks whether the range of the first 30 / 60
#      minutes (÷ the implied one-day move) predicts the range of the rest of the session, alone and on
#      top of the pre-open model, scored walk-forward (each day predicted from earlier days only).
#
# Definitions (all market data; nothing here reads a position):
#   implied   prior close VXN (QQQ) / VIX (SPX, SPY) ÷ 100 ÷ √252 — the one-day 1σ, as a fraction
#   R         (session high − low) ÷ open ÷ implied
#   FR30/60   (high − low from 09:30 to 10:00 / 10:30 New York) ÷ open ÷ implied
#   R_rest    (high − low from the checkpoint to the close) ÷ price at the checkpoint ÷ implied
#             (a full-day implied, so a typical value is below 1: most of the day's time has not gone)
#   cushion   SqueezeMetrics SPX GEX at the prior close, percentile vs the 252 rows before it
#   trend day the session's close in the top or bottom 20% of its own high–low range (spec A.2; the
#             trade-day call's P(trend), scripts/trade-day-refit.py), read from the same intraday bars
#
# Inputs, fetched into one directory $D first:
#   curl -sS https://squeezemetrics.com/monitor/static/DIX.csv -o $D/dix.csv
#   curl -sSL https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv -o $D/VIX.csv
#   curl -sSL https://cdn.cboe.com/api/global/us_indices/daily_prices/VXN_History.csv -o $D/VXN.csv
#   for s in QQQ %5EGSPC; do curl -sS -A Mozilla/5.0 \
#     "https://query2.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=1293840000&period2=$(date +%s)" -o "$D/d_$s.json"; done
#   Intraday, regular session, saved as {SYM}_30m.json and {SYM}_1h.json for QQQ and SPY. Either
#     - TradingView's OHLCV (format=columns, the {bars:{t,o,h,l,c}} shape; 30m reaches back to Jan 2025,
#       1h to Jan 2023 — the longest free record found), or
#     - Yahoo chart JSON (interval=60m&range=2y, or interval=30m&range=60d).
#   python3 -I scripts/trade-day-checkpoint-backtest.py $D
import json, sys, datetime as dt
from zoneinfo import ZoneInfo
import numpy as np, pandas as pd

D = sys.argv[1]
NY = ZoneInfo('America/New_York')

def yahoo_daily(f):
    r = json.load(open(f))['chart']['result'][0]; q = r['indicators']['quote'][0]
    return pd.DataFrame({'o': q['open'], 'h': q['high'], 'l': q['low'], 'c': q['close']},
                        index=pd.to_datetime(r['timestamp'], unit='s').normalize()).dropna()

def cboe(f):
    d = pd.read_csv(f); d.index = pd.to_datetime(d.DATE)
    return d[['OPEN', 'CLOSE']].rename(columns={'OPEN': 'ivo', 'CLOSE': 'iv'})

def intraday(f):
    j = json.load(open(f))
    if 'bars' in j: b = j['bars']; t, o, h, l, c = b['t'], b['o'], b['h'], b['l'], b['c']
    else:
        r = j['chart']['result'][0] if 'chart' in j else j; q = r['indicators']['quote'][0]
        t, o, h, l, c = r['timestamp'], q['open'], q['high'], q['low'], q['close']
    rows = [(dt.datetime.fromtimestamp(x, NY), *v) for x, *v in zip(t, o, h, l, c) if None not in v]
    df = pd.DataFrame(rows, columns=['ts', 'o', 'h', 'l', 'c'])
    df = df[(df.ts.dt.time >= dt.time(9, 30)) & (df.ts.dt.time < dt.time(16, 0))]
    df['date'] = pd.to_datetime(df.ts.dt.date); df['hm'] = df.ts.dt.strftime('%H:%M')
    return df

# ── daily panel ────────────────────────────────────────────────────────────────────────────────
dix = pd.read_csv(f'{D}/dix.csv', parse_dates=['date']).set_index('date')
dix['pct'] = dix.gex.rolling(253).apply(lambda x: (x[:-1] < x[-1]).mean(), raw=True)
X4 = ['cush', 'gap', 'prevR', 'ivchg']
daily = {}
for name, px, iv in [('QQQ', 'd_QQQ.json', 'VXN.csv'), ('SPX', 'd_%5EGSPC.json', 'VIX.csv')]:
    p = yahoo_daily(f'{D}/{px}').join(cboe(f'{D}/{iv}'), how='inner')
    p['pc'] = p.c.shift(1); p['ivp'] = p.iv.shift(1)
    p['imp'] = p.ivp / 100 / np.sqrt(252)
    p['R'] = (p.h - p.l) / p.o / p.imp
    p['R_pc'] = (p.h - p.l) / p.pc / p.imp
    p['gap'] = (p.o / p.pc - 1).abs() / p.imp
    p['prevR'] = p.R.shift(1)
    p['ivchg'] = p.ivo / p.ivp - 1
    p['cush'] = dix.pct.shift(1).reindex(p.index) * 100
    p['gex'] = dix.gex.shift(1).reindex(p.index)
    daily[name] = p.dropna(subset=['R', 'cush', 'gex'])

# ── 1. reconcile the CUSHION table ─────────────────────────────────────────────────────────────
print('=' * 100 + '\n1. CUSHION TABLE RECONCILIATION (lib/trendTells.js: QQQ 1.20/1.10/1.01/0.92/0.88/0.78, SPX 1.12/1.02/0.92/0.80/0.76/0.68)')
BANDS = [(0, 20), (20, 40), (40, 60), (60, 80), (80, 101)]
for name, p in daily.items():
    print(f'\n{name}: {p.index[0].date()} → {p.index[-1].date()}, n={len(p)}')
    neg = p[p.gex < 0]
    print(f'  {"band":9s} {"n all":>6s} {"mean all":>9s} {"med all":>8s} | {"n ex-neg":>8s} {"mean ex":>8s} {"MED ex-neg":>10s} {"med ex (÷prior close)":>22s}')
    print(f'  {"GEX<0":9s} {len(neg):6d} {neg.R.mean():9.2f} {neg.R.median():8.2f} | {"":8s} {"":8s} {neg.R.median():10.2f} {neg.R_pc.median():22.2f}')
    for lo, hi in BANDS:
        a = p[(p.cush >= lo) & (p.cush < hi)]; e = a[a.gex >= 0]
        print(f'  {f"{lo}–{min(hi,100)}th":9s} {len(a):6d} {a.R.mean():9.2f} {a.R.median():8.2f} | {len(e):8d} {e.R.mean():8.2f} {e.R.median():10.2f} {e.R_pc.median():22.2f}')

# ── 2. pre-open four-factor model, fit 2012–2020 ────────────────────────────────────────────────
print('\n' + '=' * 100 + '\n2. PRE-OPEN MODEL (log R ~ cushion + gap + prevR + ivchg), train 2012–2020, test 2021→')
BETA = {}
def spear(a, b): return pd.Series(a).corr(pd.Series(b), method='spearman')
def hit(pred, y): pred, y = np.asarray(pred), np.asarray(y); return ((pred >= np.median(pred)) == (y >= np.median(y))).mean()
for name, p in daily.items():
    q = p.dropna(subset=X4); q = q[q.index >= '2012-01-01']
    tr, te = q[q.index < '2021-01-01'], q[q.index >= '2021-01-01']
    b = np.linalg.lstsq(np.c_[np.ones(len(tr)), tr[X4]], np.log(tr.R), rcond=None)[0]; BETA[name] = b
    pf = np.exp(np.c_[np.ones(len(te)), te[X4]] @ b)
    print(f'  {name}: train n={len(tr)} test n={len(te)}  OOS Spearman {spear(pf, te.R.values):+.2f}  hit {hit(pf, te.R):.0%}  betas {dict(zip(["const"] + X4, np.round(b, 4)))}')
    p['pre'] = np.exp(np.c_[np.ones(len(p)), p[X4].fillna(0)] @ b)
    p.loc[p[X4].isna().any(axis=1), 'pre'] = np.nan

# ── 3. intraday checkpoints ────────────────────────────────────────────────────────────────────
def sessions(sym, f, step):
    df = intraday(f'{D}/{f}')
    need = 13 if step == 30 else 7
    out = []
    for d, g in df.groupby('date'):
        if len(g) != need or g.hm.iloc[0] != '09:30': continue
        o = g.o.iloc[0]
        rec = dict(date=d, open=o, H=g.h.max(), L=g.l.min(), C=g.c.iloc[-1])
        for cp, label in ([('10:00', 30), ('10:30', 60)] if step == 30 else [('10:30', 60)]):
            first, rest = g[g.hm < cp], g[g.hm >= cp]
            rec[f'fr{label}'] = (first.h.max() - first.l.min()) / o
            rec[f'rest{label}'] = (rest.h.max() - rest.l.min()) / rest.o.iloc[0]
            rec[f'fnet{label}'] = abs(first.c.iloc[-1] - o) / o
        out.append(rec)
    return pd.DataFrame(out).set_index('date')

def walk_forward(df, cols, y, min_train=120):
    """Each day predicted by OLS on log y fitted to all earlier days only."""
    pred = np.full(len(df), np.nan); Xm = df[cols].values; Y = np.log(df[y].values)
    for i in range(min_train, len(df)):
        A = np.c_[np.ones(i), Xm[:i]]; b = np.linalg.lstsq(A, Y[:i], rcond=None)[0]
        pred[i] = np.r_[1, Xm[i]] @ b
    return pred

print('\n' + '=' * 100 + '\n3. INTRADAY CHECKPOINTS — R_rest = rest-of-session range ÷ checkpoint price ÷ full-day implied')
RESULTS = []
for sym, dname in [('QQQ', 'QQQ'), ('SPY', 'SPX')]:
    p = daily[dname]
    for step in (30, 60):
        fn = f'{sym}_{"30m" if step == 30 else "1h"}.json'
        try: s = sessions(sym, fn, step)
        except FileNotFoundError: print(f'  {fn} missing — skipped'); continue
        s = s.join(p[['imp', 'pre', 'cush', 'gex', 'R']], how='inner').dropna(subset=['imp', 'pre'])
        cps = [30, 60] if step == 30 else [60]
        for cp in cps:
            z = s.copy()
            loc = (z.C - z.L) / (z.H - z.L); z['TD'] = ((loc >= 0.8) | (loc <= 0.2)).astype(float)
            z['FR'] = z[f'fr{cp}'] / z.imp; z['Rr'] = z[f'rest{cp}'] / z.imp; z['FN'] = z[f'fnet{cp}'] / z.imp
            z['lpre'] = np.log(z.pre); z['lFR'] = np.log(z.FR.clip(lower=1e-3))
            z['p_pre'] = walk_forward(z, ['lpre'], 'Rr'); z['p_fr'] = walk_forward(z, ['lFR'], 'Rr'); z['p_both'] = walk_forward(z, ['lpre', 'lFR'], 'Rr')
            t = z.dropna(subset=['p_both'])
            if not len(t):   # a short intraday file (Yahoo's 30m reaches back 60 days) leaves nothing to score
                print(f'\n  {sym} {"30m" if step == 30 else "1h"} checkpoint {"10:00" if cp == 30 else "10:30"}: n={len(z)}, fewer than the 120 sessions the walk-forward needs; skipped'); continue
            src = f'{sym} {"30m" if step == 30 else "1h"} bars, checkpoint {"10:00" if cp == 30 else "10:30"}'
            print(f'\n  {src}: {z.index[0].date()} → {z.index[-1].date()}, n={len(z)} (walk-forward scored n={len(t)}, from {t.index[0].date()})')
            print(f'    in-sample Spearman vs R_rest: FR {spear(z.FR, z.Rr):+.2f} · pre-open model {spear(z.pre, z.Rr):+.2f} · first-{cp} net move {spear(z.FN, z.Rr):+.2f} · FR vs pre-open {spear(z.FR, z.pre):+.2f}')
            for col, lab in [('p_pre', 'pre-open only'), ('p_fr', f'first-{cp} range only'), ('p_both', 'pre-open + first range')]:
                qq = pd.qcut(t[col], 4, labels=False)
                print(f'    OOS [{lab:24s}] Spearman {spear(t[col], t.Rr):+.2f}  hit {hit(t[col], t.Rr):.0%}  mean R_rest by predicted quartile {t.groupby(qq).Rr.mean().round(2).tolist()}')
                RESULTS.append(dict(sym=sym, cp=cp, model=lab, n=len(t), sp=round(spear(t[col], t.Rr), 3), hit=round(hit(t[col], t.Rr), 3)))
            rng = np.random.default_rng(0); idx = np.arange(len(t)); dsp = []
            for _ in range(1000):
                k = rng.choice(idx, len(idx)); u = t.iloc[k]
                dsp.append(spear(u.p_both.values, u.Rr.values) - spear(u.p_pre.values, u.Rr.values))
            print(f'    gain from adding the first range: ΔSpearman {np.mean(dsp):+.3f}, 90% bootstrap [{np.percentile(dsp, 5):+.3f}, {np.percentile(dsp, 95):+.3f}]')
            print(f'    FR quartile cut-points (× implied 1σ): {np.round(z.FR.quantile([.25, .5, .75]).values, 2).tolist()} · median R_rest {z.Rr.median():.2f}')
            fq = pd.qcut(z.FR, 4, labels=['Q1', 'Q2', 'Q3', 'Q4'])
            print('    by FR quartile: ' + ' · '.join(f'{k}: R_rest mean {g.Rr.mean():.2f} med {g.Rr.median():.2f}, day R≥1 {(g.R >= 1).mean():.0%}' for k, g in z.groupby(fq, observed=True)))
            print(f'    trend-day share (close in the top/bottom 20% of the range), base {z.TD.mean():.0%}: ' + ' · '.join(f'{k} {g.TD.mean():.0%}' for k, g in z.groupby(fq, observed=True)))
            # the brief's tell, and a few nearby thresholds
            for thr in ([0.25, 0.35, 0.5] if cp == 30 else [0.35, 0.5, 0.65, 0.8]):
                a, b = z[z.FR > thr], z[z.FR <= thr]
                print(f'    tell FR > {thr:.2f}σ: n={len(a):4d} ({len(a)/len(z):.0%}) R_rest mean {a.Rr.mean():.2f} vs {b.Rr.mean():.2f}; R_rest ≥ median {(a.Rr >= z.Rr.median()).mean():.0%} vs {(b.Rr >= z.Rr.median()).mean():.0%}; full-day R ≥ 1 {(a.R >= 1).mean():.0%} vs {(b.R >= 1).mean():.0%}')
            # does the checkpoint overturn the pre-open call?
            z['call'] = pd.cut(z.cush.where(z.gex >= 0, -1), [-2, 20, 60, 101], labels=['trade', 'selective', 'lean skip'], right=False)
            hi = z.FR > z.FR.median()
            for c, g in z.groupby('call', observed=True):
                h, l = g[hi.loc[g.index]], g[~hi.loc[g.index]]
                print(f'    pre-open {c:9s} n={len(g):4d}: first range above median → R_rest mean {h.Rr.mean():.2f} (n={len(h)}); below → {l.Rr.mean():.2f} (n={len(l)})')

print('\n' + '=' * 100 + '\nSUMMARY (walk-forward OOS)')
print(pd.DataFrame(RESULTS).to_string(index=False))
