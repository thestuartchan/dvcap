#!/usr/bin/env python3
# scripts/cushion-calibration.py — recalibrate the dealer-cushion table: deciles, the 0DTE era,
# per-ticker cut-offs (14 Oct 2026).
#
# The morning gamma call reads next-day range ÷ implied move by the SqueezeMetrics SPX GEX
# percentile ("the cushion"), and since 14 Oct cuts it per ticker on the RATIO: >= 1.0x Trade day,
# 0.9-1.0x Selective, < 0.9x Lean skip (QQQ 32nd / 60th percentile, SPY 14th / 33rd, interpolated
# from a five-bucket table pooled over 2012-2026). This asks whether those cut-offs still hold in
# the 0DTE era. Analysis only: nothing here feeds the dashboard, Console, journal or alerts.
# Market data only, read raw. No positions, fills or journal data anywhere. Standard library only.
#
# ── FETCH (into one scratch directory, never the repo) ───────────────────────────────────────────
#   D=/tmp/cushcal; mkdir -p $D
#   curl -sS https://squeezemetrics.com/monitor/static/DIX.csv -o $D/dix.csv
#   for s in VIX VXN; do curl -sSL -A Mozilla/5.0 \
#     https://cdn.cboe.com/api/global/us_indices/daily_prices/${s}_History.csv -o $D/$(echo $s | tr A-Z a-z).csv; done
#   for s in QQQ SPY %5EGSPC; do curl -sS -A Mozilla/5.0 \
#     "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=1293840000&period2=$(date +%s)" \
#     -o $D/$(echo $s | sed 's/%5E//').d.json; done
#   for s in QQQ SPY; do curl -sS -A Mozilla/5.0 \
#     "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=60m&range=2y" -o $D/$s.h.json; done
#   python3 -I scripts/cushion-calibration.py $D <outdir>
#   (outdir receives cushion_calibration.json, tables.md and one SVG chart per ticker)
#
# ── DEFINITIONS, AS IMPLEMENTED ─────────────────────────────────────────────────────────────────
#   Day t       a Yahoo daily bar (regular session). t-1 is the previous Yahoo bar.
#   Cushion     DIX.csv `gex` at the close of t-1. Percentile = bisect_left(sorted previous 252 DIX
#               rows, gex) / 252 — the rank against the 252 rows BEFORE t-1, as the Gamma panel's
#               "Today's tells -> Dealer gamma" reads it. gex < 0 is its own bucket and is left out of
#               the deciles and the curve (as the original table did). A day needs 252 prior DIX rows,
#               so the first labelled day is in May 2012 (DIX starts 2 May 2011).
#   Implied 1σ  close(t-1) × IV(t-1) / 100 / sqrt(252): VXN for QQQ, VIX for SPY and SPX (Cboe CSV
#               closes). sqrt(252) = 15.87; the brief writes 15.9, a 0.2% difference — sqrt(252) is
#               what the original study and the panel use, so it is kept.
#   Ratio       (high - low on t) / implied 1σ.
#   Trend day   the original cushion study's: |close - open| >= 60% of (high - low) AND
#               |close - open| >= 0.8 × implied 1σ.
#   Abs range   (high - low on t) / close(t-1), in %.
#   Hygiene     NYSE half days dropped (the day after Thanksgiving; 24 Dec and 3 Jul when Mon-Thu).
#               A day missing a cushion, a t-1 IV or OHLC is dropped and counted (the warm-up — before
#               252 DIX rows exist — counted apart from real gaps). A day t is read only once DIX.csv
#               has a row for t itself: the session has closed, so an unfinished day is never read.
#   Periods     A 2011-01..2022-04 (pre-0DTE; effectively May 2012 on) · B 2022-05..end (SPX weekday
#               expiries complete) · B2 2023-01..end (QQQ dailies, sensitivity) · All.
#   Statistic   the MEDIAN ratio, as the original table and the current cut-offs used. Means are
#               reported beside it as context, never used for the decision.
#   Curve       isotonic (non-increasing) MEDIAN regression of ratio on percentile, by pool-adjacent-
#               violators over 2-point percentile bins, each pooled block's value the median of every
#               day in it. Evaluated at bin centres (1, 3, ..., 99) and interpolated linearly between
#               them. Crossing of a level = the first percentile where the curve falls through it.
#   Bootstrap   monthly blocks: calendar months resampled with replacement to the period's month
#               count, 1,000 resamples, seed 20261014. CIs are the 2.5 / 97.5 percentiles. A crossing
#               CI counts only resamples whose curve crosses; the count that do not is reported.
#   Decision    period B only. A level changes only if B's crossing differs from the current one by
#               more than 7 percentile points AND its CI excludes the current value. Otherwise keep.
#   First hour  optional: Yahoo 60-minute bars (2 years). Days whose 09:30-10:30 bar range exceeds
#               half the implied 1σ, whole-day ratio by cushion tercile.
import json, csv, sys, math, bisect, random, statistics as st, datetime as dt, heapq, os

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(OUT, exist_ok=True)
SEED, NBOOT, BIN = 20261014, 1000, 2
CURRENT = {'QQQ': (32, 60), 'SPY': (14, 33), 'SPX': (14, 33)}   # (cross 1.0, cross 0.9) in percentile
PERIODS = {'A': ('2011-01-01', '2022-04-30'), 'B': ('2022-05-01', '9999'), 'B2': ('2023-01-01', '9999'), 'All': ('2011-01-01', '9999')}
TICKERS = [('QQQ', 'QQQ', 'vxn'), ('SPY', 'SPY', 'vix'), ('SPX', 'GSPC', 'vix')]
TREND_DEF = '|close - open| >= 60% of (high - low) AND |close - open| >= 0.8 x implied 1-sigma (the original cushion study\'s definition)'

def yahoo(name):
    r = json.load(open(f'{SRC}/{name}.d.json'))['chart']['result'][0]; off = r['meta']['gmtoffset']; q = r['indicators']['quote'][0]
    out = {}
    for t, o, h, l, c in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if None in (o, h, l, c): continue
        out[dt.datetime.utcfromtimestamp(t + off).date().isoformat()] = (o, h, l, c)
    return out
def cboe(name):
    out = {}
    for r in csv.reader(open(f'{SRC}/{name}.csv')):
        if r and r[0][:1].isdigit():
            m, d, y = r[0].split('/'); out[f'{y}-{m}-{d}'] = float(r[-1])
    return out
def half_days(y0, y1):
    hd = set()
    for y in range(y0, y1 + 1):
        nov = [dt.date(y, 11, d) for d in range(1, 31) if dt.date(y, 11, d).weekday() == 3]
        hd.add((nov[3] + dt.timedelta(days=1)).isoformat())
        for m, d in [(12, 24), (7, 3)]:
            x = dt.date(y, m, d)
            if x.weekday() <= 3: hd.add(x.isoformat())
    return hd

G = [(r['date'], float(r['gex'])) for r in csv.DictReader(open(f'{SRC}/dix.csv')) if r.get('gex')]
GEX = dict(G); PCT = {}
for i, (d, g) in enumerate(G):
    if i >= 252:
        PCT[d] = bisect.bisect_left(sorted(x for _, x in G[i - 252:i]), g) / 252
LAST_DIX = G[-1][0]
HALF = half_days(2011, 2026)

def rows_for(yname, ivname, hygiene=True):
    bars = yahoo(yname); iv = cboe(ivname); ds = sorted(bars); rows = []
    drop = {'half_day': 0, 'warmup_before_252_dix_rows': 0, 'no_cushion': 0, 'no_iv': 0, 'bad_bar': 0}
    first_pct = min(PCT)
    for i in range(1, len(ds)):
        d, p = ds[i], ds[i - 1]
        if d > LAST_DIX: break                                     # not yet in DIX.csv: the session is unfinished
        if hygiene and d in HALF: drop['half_day'] += 1; continue
        if p < first_pct: drop['warmup_before_252_dix_rows'] += 1; continue
        if p not in PCT: drop['no_cushion'] += 1; continue
        if p not in iv: drop['no_iv'] += 1; continue
        o, h, l, c = bars[d]; pc = bars[p][3]
        if not (h > l > 0): drop['bad_bar'] += 1; continue
        sig = pc * iv[p] / 100 / math.sqrt(252); rng = h - l; oc = abs(c - o)
        rows.append(dict(d=d, m=d[:7], g=GEX[p], pc=PCT[p] * 100, rr=rng / sig, ar=rng / pc * 100,
                         trend=oc / rng >= 0.6 and oc / sig >= 0.8, sig=sig))
    return rows, drop, (ds[0], rows[-1]['d'] if rows else None)

# ── isotonic median regression (non-increasing), PAVA over BIN-point percentile bins ──
def iso_fit(rows):
    bins = {}
    for r in rows:
        if r['g'] < 0: continue
        b = min(int(r['pc'] // BIN), 100 // BIN - 1); bins.setdefault(b, []).append(r['rr'])
    blocks = []                                                    # [values sorted, fit, bins]
    for b in sorted(bins):
        blocks.append([sorted(bins[b]), None, [b]]); blocks[-1][1] = st.median(blocks[-1][0])
        while len(blocks) >= 2 and blocks[-2][1] < blocks[-1][1]:
            v2, _, b2 = blocks.pop(); v1, _, b1 = blocks.pop()
            v = list(heapq.merge(v1, v2)); blocks.append([v, st.median(v), b1 + b2])
    pts = sorted((b * BIN + BIN / 2, fit) for v, fit, bs in blocks for b in bs)
    return pts
def at(pts, x):
    if not pts: return None
    if x <= pts[0][0]: return pts[0][1]
    if x >= pts[-1][0]: return pts[-1][1]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1: return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 > x0 else y1
def crossing(pts, level):
    if not pts: return None, 'no data'
    if pts[0][1] < level: return None, f'below {level} everywhere'
    if pts[-1][1] >= level: return None, f'at or above {level} everywhere'
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if y0 >= level > y1: return x0 + (level - y0) * (x1 - x0) / (y1 - y0), None
    return None, 'no crossing'

def boot_months(rows, rng):
    by = {}
    for r in rows: by.setdefault(r['m'], []).append(r)
    ms = sorted(by)
    for _ in range(NBOOT):
        yield [r for m in (rng.choice(ms) for _ in ms) for r in by[m]]
def q(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; f = math.floor(k); c = math.ceil(k)
    return xs[f] + (xs[c] - xs[f]) * (k - f)
def ci(xs): return [round(q(xs, 0.025), 3), round(q(xs, 0.975), 3)] if len(xs) >= 20 else None

def decile_of(r): return min(int(r['pc'] // 10), 9)
def summarize(rows, rng):
    pos = [r for r in rows if r['g'] >= 0]; neg = [r for r in rows if r['g'] < 0]
    dec = [[r for r in pos if decile_of(r) == k] for k in range(10)]
    boots = list(boot_months(rows, rng))
    bmed = [[] for _ in range(10)]; bmean = [[] for _ in range(10)]; bneg = []; bnegmed = []; bc = {1.0: [], 0.9: []}; miss = {1.0: 0, 0.9: 0}
    for s in boots:
        sp = [r for r in s if r['g'] >= 0]
        for k in range(10):
            v = [r['rr'] for r in sp if decile_of(r) == k]
            if v: bmed[k].append(st.median(v)); bmean[k].append(st.fmean(v))
        nv = [r['rr'] for r in s if r['g'] < 0]
        if nv: bneg.append(st.fmean(nv)); bnegmed.append(st.median(nv))
        pts = iso_fit(s)
        for L in (1.0, 0.9):
            x, _ = crossing(pts, L)
            if x is None: miss[L] += 1
            else: bc[L].append(x)
    pts = iso_fit(rows)
    out = {'n': len(rows), 'deciles': [], 'curve': [[round(x, 1), round(y, 3)] for x, y in pts]}
    for k, v in enumerate(dec):
        rr = [r['rr'] for r in v]
        out['deciles'].append({'lo': k * 10, 'hi': k * 10 + 10, 'mid': k * 10 + 5, 'n': len(v),
            'ratio_mean': round(st.fmean(rr), 3) if rr else None, 'ratio_median': round(st.median(rr), 3) if rr else None,
            'ci': ci(bmed[k]), 'ci_mean': ci(bmean[k]),
            'pct_gt_1': round(sum(x > 1 for x in rr) / len(rr) * 100, 1) if rr else None,
            'trend_pct': round(sum(r['trend'] for r in v) / len(v) * 100, 1) if v else None,
            'abs_range_pct': round(st.fmean(r['ar'] for r in v), 3) if v else None})
    nr = [r['rr'] for r in neg]
    out['negative_gex'] = {'n': len(neg), 'ratio_mean': round(st.fmean(nr), 3) if nr else None, 'ci': ci(bneg),
                           'ratio_median': round(st.median(nr), 3) if nr else None, 'ci_median': ci(bnegmed),
                           'trend_pct': round(sum(r['trend'] for r in neg) / len(neg) * 100, 1) if neg else None,
                           'abs_range_pct': round(st.fmean(r['ar'] for r in neg), 3) if neg else None}
    for L, key in [(1.0, 'cross_1_0'), (0.9, 'cross_0_9')]:
        x, why = crossing(pts, L)
        out[key] = {'pct': round(x, 1) if x is not None else None, 'ci': ci(bc[L]) and [round(c, 1) for c in ci(bc[L])],
                    'resamples_without_crossing': miss[L], **({'note': why} if why else {})}
    return out

def mean_curve_cross(rows):   # sensitivity only: the same curve on MEANS (PAVA, L2)
    bins = {}
    for r in rows:
        if r['g'] >= 0: bins.setdefault(min(int(r['pc'] // BIN), 100 // BIN - 1), []).append(r['rr'])
    blocks = []
    for b in sorted(bins):
        blocks.append([sum(bins[b]), len(bins[b]), [b]])
        while len(blocks) >= 2 and blocks[-2][0] / blocks[-2][1] < blocks[-1][0] / blocks[-1][1]:
            s2, n2, b2 = blocks.pop(); s1, n1, b1 = blocks.pop(); blocks.append([s1 + s2, n1 + n2, b1 + b2])
    pts = sorted((b * BIN + BIN / 2, s / n) for s, n, bs in blocks for b in bs)
    return {L: crossing(pts, L)[0] for L in (1.0, 0.9)}

# ── 1. reproduce the original table (its method exactly: no half-day drop, medians, gex >= 0 buckets) ──
ORIG = {'QQQ': [1.20, 1.10, 1.01, 0.92, 0.88, 0.78], 'SPX': [1.12, 1.02, 0.92, 0.80, 0.76, 0.68]}
BUCKETS = [('negative', lambda r: r['g'] < 0), ('<20', lambda r: r['g'] >= 0 and r['pc'] < 20), ('20-40', lambda r: r['g'] >= 0 and 20 <= r['pc'] < 40),
           ('40-60', lambda r: r['g'] >= 0 and 40 <= r['pc'] < 60), ('60-80', lambda r: r['g'] >= 0 and 60 <= r['pc'] < 80), ('80+', lambda r: r['g'] >= 0 and r['pc'] >= 80)]
repro = {}
for tk, yn, ivn in TICKERS:
    rows, _, _ = rows_for(yn, ivn, hygiene=False)
    got = [round(st.median(r['rr'] for r in rows if f(r)), 3) for _, f in BUCKETS]
    repro[tk] = {'buckets': [b for b, _ in BUCKETS], 'median': got, 'n': [sum(1 for r in rows if f(r)) for _, f in BUCKETS],
                 'trend_pct': [round(sum(r['trend'] for r in rows if f(r)) / max(1, sum(1 for r in rows if f(r))) * 100, 1) for _, f in BUCKETS]}
    if tk in ORIG:
        repro[tk]['original'] = ORIG[tk]; repro[tk]['max_gap'] = round(max(abs(a - b) for a, b in zip(got, ORIG[tk])), 3)
print('REPRODUCTION', json.dumps(repro))
bad = [tk for tk in ORIG if repro[tk]['max_gap'] > 0.02]
if bad:
    print('STOP: reproduction gap > 0.02 for', bad); json.dump({'reproduction': repro}, open(f'{OUT}/reproduction.json', 'w'), indent=1); sys.exit(2)

# ── 2-5. deciles × periods, crossings, rolling windows ──
rng = random.Random(SEED)
res = {'generated_utc': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
       'source': {'gex': 'SqueezeMetrics DIX.csv', 'ohlc': 'Yahoo Finance daily (v8 chart API): QQQ, SPY, ^GSPC', 'iv': 'Cboe VIX/VXN',
                  'start': None, 'end': None},
       'trend_day_definition': TREND_DEF, 'decision_period': 'B', 'verdict': 'keep', 'tickers': {}, 'rolling_crossings': {},
       'first_hour_tell': None, 'reproduction': repro, 'dropped': {}, 'sensitivity_mean_curve_B': {}}
for tk, yn, ivn in TICKERS:
    rows, drop, (first_bar, last_day) = rows_for(yn, ivn)
    res['dropped'][tk] = drop
    res['source']['start'] = first_bar; res['source']['end'] = last_day
    res['source']['first_labelled_day'] = rows[0]['d']
    T = {'periods': {}}
    for pk, (a, b) in PERIODS.items():
        pr = [r for r in rows if a <= r['d'] <= b]
        T['periods'][pk] = summarize(pr, rng)
        T['periods'][pk]['from'] = pr[0]['d']; T['periods'][pk]['to'] = pr[-1]['d']
    B = T['periods']['B']; cur = CURRENT[tk]; rec = list(cur); why = []
    for i, key in enumerate(['cross_1_0', 'cross_0_9']):
        x, c = B[key]['pct'], B[key]['ci']
        if x is not None and c and abs(x - cur[i]) > 7 and not (c[0] <= cur[i] <= c[1]):
            rec[i] = round(x); why.append(f'{key}: B {x} (CI {c}) vs current {cur[i]}')
    T['recommended_cutoffs_pct'] = {'trade_below': rec[0], 'lean_skip_above': rec[1]}
    T['change_reasons'] = why
    pts = [tuple(p) for p in B['curve']]
    T['page_anchors'] = {'mids': [5, 15, 25, 35, 45, 55, 65, 75, 85, 95], 'ratios': [round(at(pts, m), 3) for m in range(5, 100, 10)],
                         'negative': B['negative_gex']['ratio_median'], 'period': 'B', 'statistic': 'isotonic median'}
    res['tickers'][tk] = T
    if why and tk != 'SPX': res['verdict'] = 'change'
    mc = mean_curve_cross([r for r in rows if r['d'] >= PERIODS['B'][0]])
    res['sensitivity_mean_curve_B'][tk] = {('cross_1_0' if L == 1.0 else 'cross_0_9'): (round(v, 1) if v is not None else None) for L, v in mc.items()}
    roll = []
    for y in range(2012, 2025):
        w = [r for r in rows if f'{y}-01-01' <= r['d'] <= f'{y + 2}-12-31']
        pts = iso_fit(w)
        roll.append({'window': f'{y}-{y + 2}', 'n': len(w), 'cross_1_0': (lambda v: round(v, 1) if v is not None else None)(crossing(pts, 1.0)[0]),
                     'cross_0_9': (lambda v: round(v, 1) if v is not None else None)(crossing(pts, 0.9)[0])})
    res['rolling_crossings'][tk] = roll

# ── 6. the first-hour tell (Yahoo 60m, two years) ──
def first_hour(sym):
    r = json.load(open(f'{SRC}/{sym}.h.json'))['chart']['result'][0]; off = r['meta']['gmtoffset']; qq = r['indicators']['quote'][0]; fh = {}
    for t, h, l in zip(r['timestamp'], qq['high'], qq['low']):
        if None in (h, l): continue
        loc = dt.datetime.utcfromtimestamp(t + off)
        if (loc.hour, loc.minute) == (9, 30): fh[loc.date().isoformat()] = h - l
    return fh
fht = {}
for tk, yn, ivn in TICKERS[:2]:
    rows, _, _ = rows_for(yn, ivn); fh = first_hour(tk)
    live = [r for r in rows if r['d'] in fh and r['g'] >= 0]
    hit = [r for r in live if fh[r['d']] > 0.5 * r['sig']]
    terc = []
    for lo, hi in [(0, 100 / 3), (100 / 3, 200 / 3), (200 / 3, 100.01)]:
        v = [r['rr'] for r in hit if lo <= r['pc'] < hi]; base = [r['rr'] for r in live if lo <= r['pc'] < hi]
        terc.append({'tercile': f'{lo:.0f}-{min(hi, 100):.0f}', 'n': len(v), 'ratio_median': round(st.median(v), 3) if v else None,
                     'all_days_n': len(base), 'all_days_ratio_median': round(st.median(base), 3) if base else None})
    fht[tk] = {'from': live[0]['d'] if live else None, 'to': live[-1]['d'] if live else None, 'days': len(live), 'tell_days': len(hit), 'by_tercile': terc}
res['first_hour_tell'] = {'source': 'Yahoo Finance 60-minute bars, two years; the 09:30-10:30 bar', **fht}

json.dump(res, open(f'{OUT}/cushion_calibration.json', 'w'), indent=1)

# ── tables.md ──
L = []
f2 = lambda v: '—' if v is None else f'{v:.2f}'
for tk in res['tickers']:
    T = res['tickers'][tk]
    L.append(f'## {tk}\n')
    for pk in ['A', 'B', 'B2', 'All']:
        P = T['periods'][pk]
        L.append(f'### {tk} · period {pk} ({P["from"]} → {P["to"]}, n={P["n"]})\n')
        L.append('| Cushion | n | Median ratio | 95% CI | Mean | Ratio > 1 | Trend days | Abs range |')
        L.append('|---|---|---|---|---|---|---|---|')
        ng = P['negative_gex']
        L.append(f"| GEX negative | {ng['n']} | {f2(ng['ratio_median'])} | {ng['ci_median'] and f2(ng['ci_median'][0]) + '–' + f2(ng['ci_median'][1]) or '—'} | {f2(ng['ratio_mean'])} | — | {ng['trend_pct'] if ng['trend_pct'] is not None else '—'}% | {f2(ng['abs_range_pct'])}% |")
        for dd in P['deciles']:
            c = dd['ci']
            L.append(f"| {dd['lo']}–{dd['hi']}th | {dd['n']} | {f2(dd['ratio_median'])} | {f2(c[0]) + '–' + f2(c[1]) if c else '—'} | {f2(dd['ratio_mean'])} | {dd['pct_gt_1']}% | {dd['trend_pct']}% | {f2(dd['abs_range_pct'])}% |")
        for key, lab in [('cross_1_0', '1.0×'), ('cross_0_9', '0.9×')]:
            x = P[key]
            L.append(f"\nCurve crosses {lab} at **{x['pct'] if x['pct'] is not None else '—'}** (CI {x['ci']}; {x['resamples_without_crossing']} of {NBOOT} resamples do not cross){' — ' + x['note'] if x.get('note') else ''}")
        L.append('')
    L.append(f"**Rolling 3-year crossings ({tk})**\n\n| Window | n | 1.0× | 0.9× |\n|---|---|---|---|")
    for w in res['rolling_crossings'][tk]:
        L.append(f"| {w['window']} | {w['n']} | {w['cross_1_0'] if w['cross_1_0'] is not None else '—'} | {w['cross_0_9'] if w['cross_0_9'] is not None else '—'} |")
    L.append('')
open(f'{OUT}/tables.md', 'w').write('\n'.join(L))

# ── one SVG chart per ticker: median ratio by decile, A vs B, CIs, 1.0 / 0.9 lines, B's crossing CIs shaded ──
def svg(tk):
    T = res['tickers'][tk]; W, H, l, r_, t, b = 760, 420, 60, 20, 40, 50
    allv = [v for pk in 'AB' for dd in T['periods'][pk]['deciles'] for v in (dd['ci'] or [dd['ratio_median']]) if v is not None]
    y0, y1 = min(0.5, min(allv) - 0.05), max(1.5, max(allv) + 0.05)
    X = lambda p: l + (W - l - r_) * p / 100; Y = lambda v: t + (H - t - b) * (1 - (v - y0) / (y1 - y0))
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="Helvetica,Arial,sans-serif" font-size="12">',
         f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
         f'<text x="{l}" y="22" font-size="15" font-weight="700" fill="#222">{tk}: next-day range ÷ implied move by cushion decile (median, 95% CI)</text>']
    B = T['periods']['B']
    for key, col in [('cross_1_0', '#2f7d4f'), ('cross_0_9', '#b7791f')]:
        c = B[key]['ci']
        if c: s.append(f'<rect x="{X(c[0]):.1f}" y="{t}" width="{max(1, X(c[1]) - X(c[0])):.1f}" height="{H - t - b}" fill="{col}" opacity="0.12"/>')
        if B[key]['pct'] is not None: s.append(f'<line x1="{X(B[key]["pct"]):.1f}" x2="{X(B[key]["pct"]):.1f}" y1="{t}" y2="{H - b}" stroke="{col}" stroke-dasharray="2 3"/>')
    cur = CURRENT[tk]
    for v in cur: s.append(f'<line x1="{X(v):.1f}" x2="{X(v):.1f}" y1="{H - b}" y2="{H - b + 8}" stroke="#555" stroke-width="2"/>')
    s.append(f'<text x="{X(cur[0]):.1f}" y="{H - b + 20}" text-anchor="middle" fill="#555" font-size="10">now {cur[0]}</text>')
    s.append(f'<text x="{X(cur[1]):.1f}" y="{H - b + 20}" text-anchor="middle" fill="#555" font-size="10">now {cur[1]}</text>')
    for lv, col in [(1.0, '#2f7d4f'), (0.9, '#b7791f')]:
        s.append(f'<line x1="{l}" x2="{W - r_}" y1="{Y(lv):.1f}" y2="{Y(lv):.1f}" stroke="{col}" stroke-width="1.2"/>')
        s.append(f'<text x="{l - 6}" y="{Y(lv) + 4:.1f}" text-anchor="end" fill="{col}">{lv:.1f}×</text>')
    for v in [y0, y1]: s.append(f'<text x="{l - 6}" y="{Y(v) + 4:.1f}" text-anchor="end" fill="#888">{v:.2f}</text>')
    for p in range(0, 101, 10): s.append(f'<text x="{X(p):.1f}" y="{H - b + 34}" text-anchor="middle" fill="#888">{p}</text>')
    s.append(f'<text x="{(l + W - r_) / 2}" y="{H - 4}" text-anchor="middle" fill="#555">cushion percentile (SqueezeMetrics GEX vs trailing 252 sessions); shaded = period B crossing 95% CI</text>')
    for pk, col, dx in [('A', '#8a8f98', -6), ('B', '#2b55c7', 6)]:
        P = T['periods'][pk]; pts = []
        for dd in P['deciles']:
            if dd['ratio_median'] is None: continue
            x = X(dd['mid']) + dx; pts.append(f'{x:.1f},{Y(dd["ratio_median"]):.1f}')
            if dd['ci']: s.append(f'<line x1="{x:.1f}" x2="{x:.1f}" y1="{Y(dd["ci"][0]):.1f}" y2="{Y(dd["ci"][1]):.1f}" stroke="{col}" stroke-width="2"/>')
            s.append(f'<circle cx="{x:.1f}" cy="{Y(dd["ratio_median"]):.1f}" r="3.5" fill="{col}"/>')
        s.append(f'<polyline points="{" ".join(pts)}" fill="none" stroke="{col}" stroke-width="1" opacity="0.6"/>')
        s.append(f'<text x="{W - r_ - (330 if pk == "A" else 160)}" y="{t + 14}" fill="{col}" font-weight="700">● {pk} ({P["from"][:7]} – {P["to"][:7]})</text>')
    s.append('</svg>')
    open(f'{OUT}/cushion_{tk}.svg', 'w').write('\n'.join(s))
for tk in res['tickers']: svg(tk)
print('VERDICT', res['verdict'], {tk: res['tickers'][tk]['recommended_cutoffs_pct'] for tk in res['tickers']})
for tk in res['tickers']:
    for pk in ['A', 'B', 'B2', 'All']:
        P = res['tickers'][tk]['periods'][pk]
        print(tk, pk, P['n'], 'x1.0', P['cross_1_0']['pct'], P['cross_1_0']['ci'], P['cross_1_0']['resamples_without_crossing'], '| x0.9', P['cross_0_9']['pct'], P['cross_0_9']['ci'], P['cross_0_9']['resamples_without_crossing'])
