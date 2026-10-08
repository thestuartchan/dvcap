#!/usr/bin/env python3
# scripts/trend-day-backtest.py — the 15-year test behind lib/trendTells.js BACKTEST (run 8 Oct 2026).
#
# Which tells, known before the open (or at 10:30 for the first hour), came with clean trend days
# (>=0.6 ATR open->close, keeping >=60% of the range) on SPY and QQQ since May 2011. Market data
# only, read raw from the sources; no summaries. Fetch into a directory first:
#   D=/tmp/bt; mkdir -p $D
#   curl -sS https://squeezemetrics.com/monitor/static/DIX.csv -o $D/dix.csv
#   for s in SPY QQQ %5EVIX %5EVIX3M; do n=$(echo $s | tr -d "%5E"); curl -sS -A Mozilla/5.0 \
#     "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=1293840000&period2=$(date +%s)" -o $D/$n.d.json; done
#   for s in SPY QQQ; do curl -sS -A Mozilla/5.0 "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=60m&range=2y" -o $D/$s.h.json; done
#   python3 -I scripts/trend-day-backtest.py $D
# Update BACKTEST in lib/trendTells.js from the QQQ section when the numbers move.
import json, csv, sys, datetime as dt, statistics as st
S = sys.argv[1]
def daily(n):
    r = json.load(open(f'{S}/{n}.d.json'))['chart']['result'][0]; off = r['meta']['gmtoffset']; q = r['indicators']['quote'][0]
    out = []
    for t, o, h, l, c in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if None in (o, h, l, c) or h <= l: continue
        out.append((dt.datetime.utcfromtimestamp(t + off).date().isoformat(), o, h, l, c))
    return out
def firsthour(n):
    r = json.load(open(f'{S}/{n}.h.json'))['chart']['result'][0]; off = r['meta']['gmtoffset']; q = r['indicators']['quote'][0]
    fh = {}
    for t, o, h, l, c in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if None in (o, c): continue
        loc = dt.datetime.utcfromtimestamp(t + off)
        d = loc.date().isoformat()
        if (loc.hour, loc.minute) == (9, 30) and d not in fh: fh[d] = c   # the 09:30–10:30 bar's close
    return fh
vix = {d: c for d, o, h, l, c in daily('VIX')}; v3 = {d: c for d, o, h, l, c in daily('VIX3M')}
gex = {}
for row in csv.DictReader(open(f'{S}/dix.csv')): gex[row['date']] = float(row['gex'])
gdates = sorted(gex)
def pctile(d, window=252):   # GEX percentile vs the trailing year (it grows with the market)
    i = gdates.index(d) if d in gex else None
    if i is None or i < window: return None
    w = [gex[x] for x in gdates[i - window:i]]
    return sum(1 for x in w if x < gex[d]) / len(w)
for sym in ['SPY', 'QQQ']:
    b = daily(sym); fh = firsthour(sym)
    rows = []
    gidx = {d: i for i, d in enumerate(gdates)}
    for i in range(16, len(b)):
        d, o, h, l, c = b[i]; pd = b[i - 1][0]
        tr = [max(b[k][2] - b[k][3], abs(b[k][2] - b[k - 1][4]), abs(b[k][3] - b[k - 1][4])) for k in range(i - 14, i)]
        a = sum(tr) / 14
        if pd not in vix or pd not in gex: continue
        mv = abs(c - o) / a; eff = abs(c - o) / (h - l)
        gp = None
        gi = gidx.get(pd)
        if gi is not None and gi >= 252:
            w = sorted(gex[x] for x in gdates[gi - 252:gi]); g0 = gex[pd]
            gp = sum(1 for x in w if x < g0) / 252
        rows.append(dict(date=d, trend=mv >= 0.6 and eff >= 0.6, up=c >= o, range=(h - l) / a, move=mv,
            gex=gex[pd], gexPos=gex[pd] > 0, gexPct=gp, vix=vix[pd], curve=(vix[pd] / v3[pd]) if pd in v3 else None,
            gap=abs(o - b[i - 1][4]) / a, prevLoc=(b[i - 1][4] - b[i - 1][3]) / (b[i - 1][2] - b[i - 1][3]),
            fh=((fh[d] - o) / a) if d in fh else None))
    n = len(rows); base = sum(r['trend'] for r in rows) / n
    print(f'\n===== {sym}: {n} sessions {rows[0]["date"]} → {rows[-1]["date"]} · trend-day base rate {base:.1%} =====')
    def rep(name, f, xs=rows):
        sub = [r for r in xs if f(r)]
        if not sub: print(f'  {name:42s} n=0'); return
        t = sum(r['trend'] for r in sub) / len(sub); bb = sum(r['trend'] for r in xs) / len(xs)
        h1 = [r for r in sub if r['date'] < '2019-01-01']; h2 = [r for r in sub if r['date'] >= '2019-01-01']
        hs = lambda z: f'{sum(r["trend"] for r in z)/len(z):.0%} (n={len(z)})' if z else '—'
        print(f'  {name:42s} n={len(sub):5d}  trend {t:5.1%}  lift {t/bb:4.2f}×  · 2011–18 {hs(h1)} · 2019–26 {hs(h2)}  · median range {st.median(r["range"] for r in sub):.2f}')
    print(' Dealer gamma (SqueezeMetrics SPX GEX, prior close):')
    rep('GEX negative', lambda r: not r['gexPos']); rep('GEX positive', lambda r: r['gexPos'])
    for lo, hi in [(0, .2), (.2, .4), (.4, .6), (.6, .8), (.8, 1.01)]:
        rep(f'GEX percentile vs trailing year {int(lo*100)}–{int(min(hi,1)*100)}%', lambda r, lo=lo, hi=hi: r['gexPct'] is not None and lo <= r['gexPct'] < hi)
    print(' VIX (prior close):')
    for lo, hi in [(0, 14), (14, 16), (16, 20), (20, 25), (25, 99)]:
        rep(f'VIX {lo}–{hi}', lambda r, lo=lo, hi=hi: lo <= r['vix'] < hi)
    print(' VIX curve, VIX ÷ VIX3M (prior close; lower = steeper contango):')
    for lo, hi in [(0, .8), (.8, .85), (.85, .9), (.9, 1.0), (1.0, 9)]:
        rep(f'curve {lo}–{hi}', lambda r, lo=lo, hi=hi: r['curve'] is not None and lo <= r['curve'] < hi)
    print(' Open:')
    rep('gap < 0.2 ATR', lambda r: r['gap'] < .2); rep('gap 0.2–0.5 ATR', lambda r: .2 <= r['gap'] < .5); rep('gap ≥ 0.5 ATR', lambda r: r['gap'] >= .5)
    rep('prior close in top 20% of its range', lambda r: r['prevLoc'] >= .8); rep('prior close in bottom 20%', lambda r: r['prevLoc'] <= .2); rep('prior close in the middle', lambda r: .2 < r['prevLoc'] < .8)
    print(' Combined (the 8 Oct hypothesis, all pre-open):')
    rep('VIX < 16 and curve < 0.85', lambda r: r['vix'] < 16 and r['curve'] is not None and r['curve'] < .85)
    rep('… and GEX positive', lambda r: r['vix'] < 16 and r['curve'] is not None and r['curve'] < .85 and r['gexPos'])
    rep('… and gap < 0.2 ATR', lambda r: r['vix'] < 16 and r['curve'] is not None and r['curve'] < .85 and r['gap'] < .2)
    rep('VIX ≥ 20', lambda r: r['vix'] >= 20)
    fhrows = [r for r in rows if r['fh'] is not None]
    if fhrows:
        b2 = sum(r['trend'] for r in fhrows) / len(fhrows)
        print(f' First hour (last two years only, {len(fhrows)} sessions, base {b2:.1%}):')
        for lo, hi in [(0, .2), (.2, .3), (.3, .5), (.5, .75), (.75, 99)]:
            sub = [r for r in fhrows if lo <= abs(r['fh']) < hi]
            if sub:
                t = sum(r['trend'] for r in sub) / len(sub); same = sum(1 for r in sub if r['trend'] and ((r['fh'] > 0) == r['up'])) / max(1, sum(r['trend'] for r in sub))
                print(f'  |first hour| {lo}–{hi} ATR   n={len(sub):4d}  trend {t:5.1%}  lift {t/b2:4.2f}×  · trend days going the first hour\'s way {same:.0%}')
        sub = [r for r in fhrows if abs(r['fh']) >= .5 and r['vix'] < 16]
        if sub: print(f'  first hour ≥0.5 ATR and VIX < 16       n={len(sub):4d}  trend {sum(r["trend"] for r in sub)/len(sub):5.1%}')
        sub = [r for r in fhrows if abs(r['fh']) >= .5 and r['vix'] >= 16]
        if sub: print(f'  first hour ≥0.5 ATR and VIX ≥ 16       n={len(sub):4d}  trend {sum(r["trend"] for r in sub)/len(sub):5.1%}')
