#!/usr/bin/env python3
# scripts/trade-day-plans-backtest.py — the cut-offs for the trade-day call's PLANS verdict (4 Nov 2026).
#
# Stu reads the trade-day call in the Dubai morning, ~10 hours before the US open, and decides whether to
# keep the day for the desk (QQQ 0DTE/1DTE) or make plans. The verdict is three-way on P(R ≥ 1.0):
#   free    P < free_below          low chance of a moving day: make plans
#   check   free_below ≤ P < desk_at  decide at the pre-open update (08:35 ET, adds the futures gap)
#   desk    P ≥ desk_at             likely a moving day
# The MORNING call is made before the gap and the overnight IV change are known, so it is scored here
# with gap = 0 and IV change = 0 — what the board shows at that hour (lib/signalBoard.js tradeDayCall:
# "gap 0 (no futures-implied open yet)", "IV unchanged overnight").
#
# Same panels, definitions and fits as scripts/trade-day-refit.py (imported, not copied):
#   R = (high − low) ÷ open ÷ (prior-close VXN or VIX ÷ 100 ÷ √252); QQQ on QQQ + VXN, SPY on ^GSPC + VIX.
# OUT OF SAMPLE two ways:
#   walk-forward  each calendar year from 2016 is predicted by fit_r on every session 2012 → the year before
#                 (the trend model's walk-forward, applied to the R model) — the headline table;
#   production    the coefficients in lib/tradeDayModel.json (fit 2012–2020) scored 2021 → (a check).
# BASELINE: the cushion band alone — P = the band's share of R ≥ 1.0 known at the time (training years only),
# scored on the same cut-offs, so the extra inputs (prior R) can be judged.
# Per cell: share of days in each verdict, realised share R ≥ 1.0 per verdict, MISSED BIG = share of
# R ≥ 1.3 days that fell in free, DESK DUDS = share of desk days with R < 0.9.
# Also writes the free-verdict days that turned out big (R ≥ 1.3) from 2025 on to <out>/free_big.csv, for
# the 10:00 ET checkpoint check (30-minute bars reach back only to 2025-01).
#
# Inputs: the directory $D of scripts/trade-day-refit.py (its header lists the curl lines).
#   python3 -I scripts/trade-day-plans-backtest.py $D [--out DIR]
import sys, json, importlib.util, os
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('refit', os.path.join(HERE, 'trade-day-refit.py'))
rf = importlib.util.module_from_spec(spec); spec.loader.exec_module(rf)

FREE = [0.30, 0.35, 0.40]
DESK = [0.50, 0.55, 0.60]
BIG, DUD = 1.3, 0.9

def morning(df):
    m = df.copy(); m['gap'] = 0.0; m['ivchg'] = 0.0
    return m

def walk_forward(df, first_year=2016):
    recs = []
    for y in range(first_year, df.index[-1].year + 1):
        tr = df[df.index < f'{y}-01-01']; te = df[(df.index >= f'{y}-01-01') & (df.index < f'{y + 1}-01-01')]
        if len(te) == 0 or len(tr) < 500: continue
        c = rf.fit_r(tr)
        p = rf.Phi(rf.lp_r(c, morning(te)) / c['sigma'])
        rates = (tr.R >= 1).groupby(rf.band_of(tr)).mean()
        base = rf.band_of(te).map(rates).fillna((tr.R >= 1).mean()).values
        recs.append(pd.DataFrame({'R': te.R.values, 'p': p, 'p_band': base}, index=te.index))
    return pd.concat(recs)

def production(df, coef):
    te = df[df.index >= '2021-01-01']
    c = {k: coef[k] for k in ['const', 'cush', 'gap', 'prevR', 'ivchg', 'sigma']}
    tr = df[df.index < '2021-01-01']; rates = (tr.R >= 1).groupby(rf.band_of(tr)).mean()
    return pd.DataFrame({'R': te.R.values, 'p': rf.Phi(rf.lp_r(c, morning(te)) / c['sigma']),
                         'p_band': rf.band_of(te).map(rates).values}, index=te.index)

def cell(w, col, f, d):
    v = np.where(w[col] < f, 'free', np.where(w[col] >= d, 'desk', 'check'))
    R = w.R.values; big = R >= BIG
    o = {}
    for k in ['free', 'check', 'desk']:
        m = v == k
        o[k] = dict(share=float(m.mean()), ge1=float((R[m] >= 1).mean()) if m.any() else None, n=int(m.sum()))
    o['missed_big'] = float((big & (v == 'free')).sum() / big.sum())
    o['free_big_share'] = float((R[v == 'free'] >= BIG).mean()) if (v == 'free').any() else None
    o['desk_dud'] = float((R[v == 'desk'] < DUD).mean()) if (v == 'desk').any() else None
    return o, v

pc = lambda x: '—' if x is None else f'{x * 100:.0f}%'

def table(name, w, col):
    print(f'\n{name}: n {len(w)}, {w.index[0].date()} → {w.index[-1].date()}; all days R≥1.0 {pc((w.R >= 1).mean())}, R≥{BIG} {pc((w.R >= BIG).mean())}')
    print('| free < | desk ≥ | free days | free R≥1 | check days | check R≥1 | desk days | desk R≥1 | missed big (R≥1.3 in free) | 1 in N free days big | desk R<0.9 |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    out = {}
    for f in FREE:
        for d in DESK:
            o, _ = cell(w, col, f, d); out[f'{f}/{d}'] = o
            n = '—' if not o['free_big_share'] else f'{1 / o["free_big_share"]:.1f}'
            print(f'| {f:.2f} | {d:.2f} | {pc(o["free"]["share"])} | {pc(o["free"]["ge1"])} | {pc(o["check"]["share"])} | {pc(o["check"]["ge1"])} | '
                  f'{pc(o["desk"]["share"])} | {pc(o["desk"]["ge1"])} | {pc(o["missed_big"])} | {n} | {pc(o["desk_dud"])} |')
    return out

def main():
    args = sys.argv[1:]; D = args[0]
    outdir = args[args.index('--out') + 1] if '--out' in args else None
    P = rf.panels(D)
    cur = json.load(open(os.path.join(HERE, '..', 'lib', 'tradeDayModel.json')))
    res = {}
    for t, name in [('QQQ', 'QQQ'), ('SPY', 'SPX')]:
        df = P[name]
        w = walk_forward(df)
        sp = rf.spearman(w.p, w.R)
        print(f'\n===== {t} ({name} bars) — morning P(R≥1), gap 0, IV change 0; walk-forward Spearman {sp:.3f}; P quintiles (pred, actual, n) {rf.quintiles(w.p.values, (w.R >= 1).values.astype(float))}')
        res[t] = {'walk_forward': table(f'{t} MODEL walk-forward 2016→', w, 'p'),
                  'baseline': table(f'{t} BASELINE cushion band only, walk-forward 2016→', w, 'p_band'),
                  'production': table(f'{t} MODEL production coefficients, 2021→', production(df, cur['r'][t]), 'p')}
        if outdir and t == 'QQQ':
            os.makedirs(outdir, exist_ok=True)
            for f, d in [(0.30, 0.50), (0.35, 0.50), (0.35, 0.55), (0.40, 0.55)]:
                _, v = cell(w, 'p', f, d)
                sel = w[(v == 'free') & (w.R >= BIG) & (w.index >= '2025-01-01')]
                sel.assign(R=sel.R.round(3), p=sel.p.round(3)).to_csv(f'{outdir}/free_big_{f}_{d}.csv', index_label='date')
                fr = w[(v == 'free') & (w.index >= '2025-01-01')]
                fr.assign(R=fr.R.round(3), p=fr.p.round(3)).to_csv(f'{outdir}/free_all_{f}_{d}.csv', index_label='date')
    print('\nJSON\n' + json.dumps(res))

if __name__ == '__main__':
    main()
