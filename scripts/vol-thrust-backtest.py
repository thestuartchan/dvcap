#!/usr/bin/env python3
# scripts/vol-thrust-backtest.py — the 9-to-1 volume days (Lowry / Desmond 2002, "90% days"), tested on SPY
# and QQQ 2000 → 2026 (12 Nov 2026). Results: docs/vol-thrust/README.md.
#
# DEFINITIONS (lib/volThrust.js uses the same ones):
#   up share   NYSE up volume ÷ (up volume + down volume)
#   90% up day up share ≥ 0.90 (≈ 9 to 1);  90% down day  up share ≤ 0.10;  80% days the same at 0.80 / 0.20
# PATTERNS, each dated on the session that completes it, entry at that session's close:
#   (a) any 90% down day
#   (b) any 90% up day
#   (c) two 90% up days within 5 sessions (the second one; Quantifiable Edges 2016: "8 of 9 positive,
#       +25.5% average 9-month" — tested here)
#   (d) a 90% up day within 10 sessions after a 90% down day (the up day)
# OUTCOMES. SPY and QQQ dividend-adjusted closes (Yahoo): return 21 / 63 / 126 / 189 sessions later (1, 3,
# 6, 9 months) and the max drawdown over the next 63 sessions (lowest close ÷ entry − 1). NON-OVERLAPPING
# per horizon: a trigger counts only once the previous counted one's horizon has passed. BASE = every
# session in the same window (overlapping), same horizon. Split 2000–2015 / 2016–2026.
#
# Inputs:
#   data/nyse_updown_volume.json   (scripts/vol-thrust-history.py)
#   for s in SPY QQQ; do curl -sS -A Mozilla/5.0 \
#     "https://query2.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=915148800&period2=$(date +%s)" -o "$D/full_$s.json"; done
#   optional cross-check: curl -sS http://unicorn.us.com/advdec/NYSE_advv.csv -o $D/NYSE_advv.csv (and NYSE_declv.csv)
#   python3 -I scripts/vol-thrust-backtest.py $D [--json OUT]
import json, sys, os
import numpy as np, pandas as pd

D = sys.argv[1]
JSON_OUT = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
HERE = os.path.dirname(os.path.abspath(__file__))
H = {'1m': 21, '3m': 63, '6m': 126, '9m': 189}
DD = 63
WINDOWS = [('2000–2026', '2000-01-01', '2026-12-31'), ('2000–2015', '2000-01-01', '2015-12-31'), ('2016–2026', '2016-01-01', '2026-12-31')]

def yahoo_adj(f):
    r = json.load(open(f))['chart']['result'][0]
    adj = r['indicators'].get('adjclose', [{}])[0].get('adjclose') or r['indicators']['quote'][0]['close']
    off = r['meta'].get('gmtoffset', 0)
    idx = pd.to_datetime([t + off for t in r['timestamp']], unit='s').normalize()
    s = pd.Series(adj, index=idx, dtype=float).dropna()
    return s[~s.index.duplicated(keep='last')]

def tv_share():
    j = json.load(open(os.path.join(HERE, '..', 'data', 'nyse_updown_volume.json')))
    d = pd.DataFrame(j['rows'], columns=['date', 'up', 'down']); d.index = pd.to_datetime(d.date)
    return d.up / (d.up + d.down)

def unicorn_share():
    def rd(f):
        s = pd.read_csv(f, header=None, names=['d', 'v'], dtype={'d': str})
        s.index = pd.to_datetime(s.d.str.strip(), format='%Y%m%d'); return s.v.astype(float)
    try: u, dn = rd(f'{D}/NYSE_advv.csv'), rd(f'{D}/NYSE_declv.csv')
    except FileNotFoundError: return None
    t = u + dn; s = (u / t)[t > 0]
    return s

def patterns(share):
    up90, dn90 = share >= 0.90, share <= 0.10
    u = up90.values; d = dn90.values; n = len(share)
    c = np.zeros(n, bool); dd = np.zeros(n, bool)
    for i in range(n):
        if u[i] and u[max(0, i - 4):i].any(): c[i] = True          # another 90% up day in the 4 sessions before → 2 within 5
        if u[i] and d[max(0, i - 10):i].any(): dd[i] = True        # a 90% down day in the 10 sessions before
    ix = share.index
    return {'a': pd.Series(d, ix), 'b': pd.Series(u, ix), 'c': pd.Series(c, ix), 'd': pd.Series(dd, ix)}

LABEL = {'a': '(a) any 90% down day', 'b': '(b) any 90% up day', 'c': '(c) two 90% up days within 5 sessions',
         'd': '(d) 90% down day, then a 90% up day within 10 sessions'}

def fwd(px):
    v = px.values; n = len(v); out = {}
    for k, h in H.items():
        r = np.full(n, np.nan); r[:n - h] = v[h:] / v[:n - h] - 1; out[k] = pd.Series(r, px.index)
    m = np.full(n, np.nan)
    for i in range(n - DD): m[i] = min(0.0, v[i + 1:i + 1 + DD].min() / v[i] - 1)
    out['dd'] = pd.Series(m, px.index)
    return out

def nonoverlap(dates, pos, h):
    keep, last = [], -10 ** 9
    for d in dates:
        p = pos[d]
        if p - last >= h: keep.append(d); last = p
    return keep

def stats(x):
    x = pd.Series(x).dropna()
    if not len(x): return dict(n=0)
    return dict(n=int(len(x)), hit=round(float((x > 0).mean()) * 100, 1), median=round(float(x.median()) * 100, 2), mean=round(float(x.mean()) * 100, 2))

def run(share, px, lo, hi):
    F = fwd(px); pos = {d: i for i, d in enumerate(px.index)}
    P = patterns(share)
    out = {'base': {}}
    inwin = [d for d in px.index if lo <= str(d.date()) <= hi]
    for k in H: out['base'][k] = stats(F[k].loc[inwin])
    out['base']['dd'] = stats(F['dd'].loc[inwin])
    for p, s in P.items():
        trig = [d for d in s.index[s.values] if d in pos and lo <= str(d.date()) <= hi]
        o = {'triggers': len(trig)}
        for k, h in H.items():
            o[k] = stats(F[k].loc[nonoverlap(trig, pos, h)])
        o['dd'] = stats(F['dd'].loc[nonoverlap(trig, pos, DD)])
        out[p] = o
    return out, P, F, pos

def pc(v): return '—' if v is None else f'{v:+.1f}%'

def table(name, res):
    print(f'\n### {name}\n')
    print('| pattern | triggers | 1m n · hit · median · mean | 3m | 6m | 9m | max DD next 3m (median · mean) |')
    print('|---|---|---|---|---|---|---|')
    def cellf(s): return '—' if not s.get('n') else f"{s['n']} · {s['hit']:.0f}% · {pc(s['median'])} · {pc(s['mean'])}"
    b = res['base']
    print(f"| all days (base) | — | {cellf(b['1m'])} | {cellf(b['3m'])} | {cellf(b['6m'])} | {cellf(b['9m'])} | {pc(b['dd'].get('median'))} · {pc(b['dd'].get('mean'))} |")
    for p in 'abcd':
        o = res[p]
        print(f"| {LABEL[p]} | {o['triggers']} | {cellf(o['1m'])} | {cellf(o['3m'])} | {cellf(o['6m'])} | {cellf(o['9m'])} | {pc(o['dd'].get('median'))} · {pc(o['dd'].get('mean'))} |")

def main():
    tv = tv_share()
    px = {t: yahoo_adj(f'{D}/full_{t}.json') for t in ('SPY', 'QQQ')}
    # The share series on the price calendar: a session TradingView lacks is not a signal day.
    common = px['SPY'].index[(px['SPY'].index >= '1999-12-01')]
    miss = [str(d.date()) for d in common if d not in tv.index and d >= pd.Timestamp('2000-01-01')]
    sh = tv.reindex(common)
    print(f'NYSE up share: TradingView USI:UVOL/DVOL, {tv.index[0].date()} → {tv.index[-1].date()}; '
          f'{len(miss)} SPY sessions from 2000 with no TradingView bar ({", ".join(miss[:6])}{"…" if len(miss) > 6 else ""})')
    s2000 = sh[sh.index >= '2000-01-01'].dropna()
    print(f'Counts 2000 →: 90% up {int((s2000 >= .9).sum())}, 90% down {int((s2000 <= .1).sum())}, 80% up {int((s2000 >= .8).sum())}, 80% down {int((s2000 <= .2).sum())} of {len(s2000)} sessions')
    allres = {}
    for t in ('SPY', 'QQQ'):
        for wname, lo, hi in WINDOWS:
            res, P, F, pos = run(sh.dropna(), px[t], lo, hi)
            allres[f'{t} {wname}'] = res
            table(f'{t}, {wname}', res)
    # (c) episodes, listed, for the Quantifiable Edges claim.
    res, P, F, pos = run(sh.dropna(), px['SPY'], '2000-01-01', '2026-12-31')
    _, _, Fq, _ = run(sh.dropna(), px['QQQ'], '2000-01-01', '2026-12-31')
    trig = [d for d in P['c'].index[P['c'].values] if d in pos and d >= pd.Timestamp('2000-01-01')]
    print('\n### (c) every trigger, and the non-overlapping 9-month episodes (*)\n')
    print('| date | SPY 1m | SPY 3m | SPY 9m | QQQ 9m | SPY max DD 3m |')
    print('|---|---|---|---|---|---|')
    keep9 = set(nonoverlap(trig, pos, H['9m']))
    for d in trig:
        f = lambda S, k: pc(None if pd.isna(S[k].get(d, np.nan)) else S[k][d] * 100)
        print(f"| {d.date()}{' *' if d in keep9 else ''} | {f(F, '1m')} | {f(F, '3m')} | {f(F, '9m')} | {f(Fq, '9m')} | {f(F, 'dd')} |")
    # Recent context: the last 20 sessions.
    last = tv.tail(20)
    print('\n### Last 20 sessions (TradingView)\n')
    print('| date | up share | ratio |')
    print('|---|---|---|')
    for d, s in last.items():
        print(f'| {d.date()} | {s * 100:.1f}% | {s / (1 - s):.1f}:1 up |' if s >= .5 else f'| {d.date()} | {s * 100:.1f}% | {(1 - s) / s:.1f}:1 down |')
    # Cross-check against Unicorn (to Feb 2020): agreement on the day lists, and the 2000–2015 headline.
    un = unicorn_share()
    if un is not None:
        both = tv.index.intersection(un.index)
        a, b = tv[both], un[both]
        print(f'\nUnicorn cross-check {both[0].date()} → {both[-1].date()} (n {len(both)}): corr {a.corr(b):.3f}, '
              f'mean |gap| {(a - b).abs().mean() * 100:.1f} pts; 90% up days {int((a >= .9).sum())} vs {int((b >= .9).sum())} (both {int(((a >= .9) & (b >= .9)).sum())}); '
              f'90% down {int((a <= .1).sum())} vs {int((b <= .1).sum())} (both {int(((a <= .1) & (b <= .1)).sum())})')
        ush = un.reindex(common).dropna()
        for t in ('SPY', 'QQQ'):
            r, *_ = run(ush, px[t], '2000-01-01', '2015-12-31')
            table(f'{t}, 2000–2015, on the Unicorn series (cross-check)', r)
            allres[f'{t} 2000–2015 unicorn'] = r
    # How unusual is each pattern's mean? Share of 5,000 random draws of the same number of sessions from the
    # same window whose mean return is at least the pattern's (a one-sided permutation p; the draws overlap,
    # the episodes do not, so it flatters nothing).
    print('\n### Pattern mean vs random draws of the same size (2000–2026; p = share of draws ≥ the pattern)\n')
    print('| pattern | SPY 3m mean · p | SPY 9m mean · p | QQQ 3m mean · p | QQQ 9m mean · p |')
    print('|---|---|---|---|---|')
    rng = np.random.default_rng(0)
    perm = {}
    for p in 'abcd':
        cells = []
        for t in ('SPY', 'QQQ'):
            res, P, F, pos = run(sh.dropna(), px[t], '2000-01-01', '2026-12-31')
            for k in ('3m', '9m'):
                trig = [d for d in P[p].index[P[p].values] if d in pos and d >= pd.Timestamp('2000-01-01')]
                x = F[k].loc[nonoverlap(trig, pos, H[k])].dropna().values
                pool = F[k][F[k].index >= '2000-01-01'].dropna().values
                draws = np.array([rng.choice(pool, len(x), replace=False).mean() for _ in range(5000)])
                pv = float((draws >= x.mean()).mean()); perm[f'{p} {t} {k}'] = round(pv, 3)
                cells.append(f'{x.mean() * 100:+.1f}% · {pv:.2f}')
        print(f'| {LABEL[p]} | ' + ' | '.join(cells) + ' |')
    allres['perm_p'] = perm
    if JSON_OUT: json.dump(allres, open(JSON_OUT, 'w'), indent=1)

main()
