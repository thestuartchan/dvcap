#!/usr/bin/env python3
# scripts/correlation-backtest.py — do implied correlation and dispersion add anything beyond VIX? (11 Oct 2026)
#
# The Market Watch panel (lib/impliedCorrelation.js) shows COR1M, VIXEQ − VIX and DSPX as
# information. This is the test a gauge has to pass before it may feed the regime score — the rule
# the gamma flip is held to. Market data only, read raw. Fetch into a scratch directory first:
#   D=/tmp/corr; mkdir -p $D
#   for s in COR1M VIXEQ VIX DSPX; do curl -sSL "https://cdn.cboe.com/api/global/us_indices/daily_prices/${s}_History.csv" -o $D/$s.csv; done
#   curl -sS https://squeezemetrics.com/monitor/static/DIX.csv -o $D/dix.csv
#   for s in SPY QQQ; do curl -sS -A Mozilla/5.0 \
#     "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=1136073600&period2=$(date +%s)" -o $D/$s.d.json; done
#   python3 -I scripts/correlation-backtest.py $D
#
# ── QUESTIONS ────────────────────────────────────────────────────────────────────────────────────
#   Q1 Drawdowns. Max drawdown over the next 10 and 20 sessions (lowest low ÷ the signal day's close
#      − 1) after (a) COR1M up ≥ X points in 5 sessions, or (b) VIXEQ − VIX narrowing ≥ Y points in
#      5 sessions while VIX rose. X and Y are the 80th and 90th percentiles of the 5-session changes
#      (both reported; no search). "Beyond VIX": each signal day is compared with the NON-signal days
#      in the same cell of VIX level quintile × VIX 5-session change quintile; the effect is the mean
#      of (signal day − its cell's mean). Negative = deeper drawdown than VIX alone predicts.
#   Q2 Low correlation. COR1M in the bottom 10% of its trailing 252-session range of values (a
#      rolling percentile): forward 20- and 60-session return and max drawdown against the other
#      days — raw, and matched on VIX level quintile the same way. The "calm before the break" story.
#   Q3 Trend days, as lib/trendTells.js and scripts/trend-day-backtest.py define them: |close − open|
#      ≥ 0.6 ATR and ≥ 60% of the range (ATR = mean true range of the 14 sessions before). Rate on
#      the session after a COR1M jump (signal at the prior close) against days in the same cell of
#      VIX level quintile × VIX 5-session change quintile × SqueezeMetrics GEX sign (all at the prior
#      close), so the answer is beyond VIX and GEX. VIX CHANGE is in the cell on purpose: COR1M jumps
#      when VIX jumps, and a trailing 14-session ATR lags a vol pickup, so a jump day's next session
#      is "wider than ATR" partly by construction — matching on the VIX move takes that out.
#   Every effect: a 95% interval from a block bootstrap (blocks of 20 sessions, 1000 draws; the cell
#   means are re-estimated in every draw), and the same effect on the first and second halves of each
#   signal's sample. Percentages are percentage points.
#
# ── VERDICT RULE (brief of 11 Oct) ──────────────────────────────────────────────────────────────
#   A gauge earns a regime-score input only if, on BOTH SPY and QQQ, Q1 or Q3 shows an effect
#   beyond VIX with the interval clear of zero (Q1 deeper, Q3 higher), and the effect has the same
#   sign in the first and second halves of the sample. Checked at each threshold separately and
#   reported for both. Otherwise: display only.
#
# COR1M before its 2021 launch is Cboe's own back-calculation, published in the same file; it is
# used as published. VIXEQ and DSPX start 19 Jun 2014.
import json, csv, sys, random, bisect, statistics as st, datetime as dt

D = sys.argv[1]
BOOT = 1000; BLOCK = 20; SEED = 20261011
rng = random.Random(SEED)

def cboe(name):
    out = {}
    with open(f'{D}/{name}.csv') as f:
        rows = list(csv.reader(f))
    head = [h.strip().upper() for h in rows[0]]; ci = head.index('CLOSE') if 'CLOSE' in head else len(head) - 1
    for r in rows[1:]:
        try:
            m, d, y = r[0].split('/'); out[f'{y}-{int(m):02d}-{int(d):02d}'] = float(r[ci])
        except (ValueError, IndexError): pass
    return out

def daily(sym):
    r = json.load(open(f'{D}/{sym}.d.json'))['chart']['result'][0]; off = r['meta']['gmtoffset']; q = r['indicators']['quote'][0]
    out = []
    for t, o, h, l, c in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if None in (o, h, l, c) or h < l: continue
        out.append((dt.datetime.utcfromtimestamp(t + off).date().isoformat(), o, h, l, c))
    return out

COR = cboe('COR1M'); VIXEQ = cboe('VIXEQ'); VIX = cboe('VIX'); DSPX = cboe('DSPX')
GEX = {}
for row in csv.DictReader(open(f'{D}/dix.csv')): GEX[row['date']] = float(row['gex'])

def quintile_edges(vals):
    s = sorted(vals); return [s[int(len(s) * k / 5)] for k in (1, 2, 3, 4)]
def qbin(edges, v): return bisect.bisect_right(edges, v)

def pctile(vals, p):
    s = sorted(vals); return s[min(len(s) - 1, int(p * len(s)))]

# ── THE MATCHED EFFECT AND ITS BLOCK BOOTSTRAP ───────────────────────────────────────────────────
def matched(days, idx=None):
    """days: [(cell, signal 0/1, outcome)]. Mean over signal days of (outcome − mean of non-signal days
    in the same cell). Signal days in a cell with no non-signal day are left out."""
    idx = range(len(days)) if idx is None else idx
    cs, cn = {}, {}
    for i in idx:
        c, s, y = days[i]
        if not s: a = cs.setdefault(c, [0.0, 0]); a[0] += y; a[1] += 1
    tot, n = 0.0, 0
    for i in idx:
        c, s, y = days[i]
        if s and c in cs: tot += y - cs[c][0] / cs[c][1]; n += 1
    return (tot / n, n) if n else (None, 0)

def blocks(n):
    k = (n + BLOCK - 1) // BLOCK
    idx = []
    for _ in range(k):
        s = rng.randrange(0, max(1, n - BLOCK + 1)); idx.extend(range(s, min(n, s + BLOCK)))
    return idx[:n]

_DRAWS = {}
def ci(days):
    p, n = matched(days)
    if p is None: return None
    key = len(days)
    if key not in _DRAWS: _DRAWS[key] = [blocks(len(days)) for _ in range(BOOT)]
    xs = sorted(x for x in (matched(days, idx)[0] for idx in _DRAWS[key]) if x is not None)
    return p, xs[int(.025 * len(xs))], xs[int(.975 * len(xs)) - 1], n

def halves(days):
    h = len(days) // 2
    return matched(days[:h])[0], matched(days[h:])[0]

def f(x, scale=100, dp=2):
    return '—' if x is None else f'{x * scale:+.{dp}f}'
def fci(r, scale=100, dp=2):
    return '—' if r is None else f'{f(r[0], scale, dp)} [{f(r[1], scale, dp)}, {f(r[2], scale, dp)}] (n={r[3]})'

# ── PER SYMBOL ───────────────────────────────────────────────────────────────────────────────────
results = {}
def run(sym):
    b = daily(sym)
    dates = [x[0] for x in b]
    close = [x[4] for x in b]; low = [x[3] for x in b]; high = [x[2] for x in b]; opn = [x[1] for x in b]
    n = len(b)
    def fdd(i, N):   # max drawdown over the next N sessions from today's close
        return min(low[i + 1:i + 1 + N]) / close[i] - 1 if i + N < n else None
    def fret(i, N): return close[i + N] / close[i] - 1 if i + N < n else None
    # 5-session changes, each on that series' own calendar, read at the signal day.
    def ch5(series, i):
        d0 = dates[i]; j = i - 5
        if j < 0 or d0 not in series or dates[j] not in series: return None
        return series[d0] - series[dates[j]]
    gap = {d: VIXEQ[d] - VIX[d] for d in VIXEQ if d in VIX}
    rows = []
    for i in range(n):
        d = dates[i]
        if d not in VIX: continue
        rows.append(dict(i=i, d=d, vix=VIX[d], dvix=ch5(VIX, i), dcor=ch5(COR, i), dgap=ch5(gap, i),
                         cor=COR.get(d), dd10=fdd(i, 10), dd20=fdd(i, 20), dd60=fdd(i, 60), r20=fret(i, 20), r60=fret(i, 60)))
    out = {'sym': sym, 'first': rows[0]['d'], 'last': rows[-1]['d']}
    vix_e = quintile_edges([r['vix'] for r in rows]); dv_e = quintile_edges([r['dvix'] for r in rows if r['dvix'] is not None])
    print(f'\n===== {sym} · {len(rows)} sessions {rows[0]["d"]} → {rows[-1]["d"]} =====')
    # ── Q1 ──
    cors = [r['dcor'] for r in rows if r['dcor'] is not None]
    gaps = [r['dgap'] for r in rows if r['dgap'] is not None]
    q1 = {}
    print(' Q1 · max drawdown after the signal, beyond VIX level and VIX change (pts; negative = deeper)')
    for p in (.8, .9):
        X = pctile(cors, p); Y = -pctile(gaps, 1 - p)
        for name, test, base in (
            (f'COR1M +{X:.2f} in 5 sessions ({int(p*100)}th pct)', lambda r: r['dcor'] >= X, lambda r: r['dcor'] is not None),
            (f'gap −{Y:.2f} in 5 sessions with VIX up ({int(p*100)}th pct)', lambda r: r['dgap'] <= -Y and r['dvix'] > 0, lambda r: r['dgap'] is not None),
        ):
            for N in (10, 20):
                days = [((qbin(vix_e, r['vix']), qbin(dv_e, r['dvix'])), 1 if test(r) else 0, r[f'dd{N}'])
                        for r in rows if base(r) and r['dvix'] is not None and r[f'dd{N}'] is not None]
                c = ci(days); h1, h2 = halves(days)
                raw_sig = [y for _, s, y in days if s]; raw_all = [y for _, s, y in days if not s]
                key = ('cor' if name.startswith('COR1M') else 'gap', p, N)
                q1[key] = dict(ci=c, halves=(h1, h2))
                print(f'  {name:46s} {N:2d}d  signal {st.mean(raw_sig)*100:6.2f}% vs other {st.mean(raw_all)*100:6.2f}%  beyond VIX {fci(c)}  halves {f(h1)} / {f(h2)}')
    out['q1'] = q1
    # ── Q2 ──
    print(' Q2 · COR1M in the bottom 10% of its trailing year')
    cr = [r for r in rows if r['cor'] is not None]
    hist = []
    for k, r in enumerate(cr):
        w = [x['cor'] for x in cr[max(0, k - 252):k]]
        r['corpct'] = sum(1 for v in w if v < r['cor']) / len(w) if len(w) >= 200 else None
    for N, key in ((20, 'r20'), (60, 'r60'), (20, 'dd20'), (60, 'dd60')):
        days = [(qbin(vix_e, r['vix']), 1 if r['corpct'] < .10 else 0, r[key]) for r in cr if r['corpct'] is not None and r[key] is not None]
        sig = [y for _, s, y in days if s]; oth = [y for _, s, y in days if not s]
        c = ci(days); h1, h2 = halves(days)
        what = 'return' if key.startswith('r') else 'max drawdown'
        print(f'  forward {N}d {what:12s} low-corr {st.mean(sig)*100:6.2f}% (n={len(sig)}) vs rest {st.mean(oth)*100:6.2f}%  raw diff {(st.mean(sig)-st.mean(oth))*100:+.2f}  beyond VIX level {fci(c)}  halves {f(h1)} / {f(h2)}')
    # ── Q3 ──
    print(' Q3 · trend-day rate on the session after a COR1M jump, beyond VIX level, VIX change and GEX sign')
    gd = sorted(GEX)
    trend = {}
    for i in range(15, n):
        tr = [max(high[k] - low[k], abs(high[k] - close[k - 1]), abs(low[k] - close[k - 1])) for k in range(i - 14, i)]
        a = sum(tr) / 14; rngd = high[i] - low[i]
        if rngd <= 0: continue
        mv = abs(close[i] - opn[i]) / a; eff = abs(close[i] - opn[i]) / rngd
        trend[i] = 1 if mv >= .6 and eff >= .6 else 0
    q3 = {}
    for p in (.8, .9):
        X = pctile(cors, p)
        days = []; first = None
        for r in rows:
            j = r['i'] + 1
            if j not in trend or r['dcor'] is None or r['dvix'] is None: continue
            g = bisect.bisect_right(gd, r['d']) - 1      # GEX at the signal day's close (= prior close for day j)
            if g < 0 or gd[g] != r['d']: continue
            days.append(((qbin(vix_e, r['vix']), qbin(dv_e, r['dvix']), GEX[gd[g]] > 0), 1 if r['dcor'] >= X else 0, trend[j]))
            first = first or r['d']
        c = ci(days); h1, h2 = halves(days)
        sig = [y for _, s, y in days if s]; oth = [y for _, s, y in days if not s]
        q3[p] = dict(ci=c, halves=(h1, h2))
        print(f'  COR1M +{X:.2f} ({int(p*100)}th pct): trend days {st.mean(sig)*100:5.1f}% vs {st.mean(oth)*100:5.1f}%  beyond VIX+GEX {fci(c, 100, 1)}  halves {f(h1, 100, 1)} / {f(h2, 100, 1)}  (from {first})')
    out['q3'] = q3
    # DSPX cross-check: how closely its 5-session changes track the gap's.
    pairs = [(DSPX[dates[r['i']]] - DSPX[dates[r['i'] - 5]], r['dgap']) for r in rows if r['dgap'] is not None and r['i'] >= 5 and dates[r['i']] in DSPX and dates[r['i'] - 5] in DSPX]
    if len(pairs) > 30:
        xs, ys = zip(*pairs); mx, my = st.mean(xs), st.mean(ys)
        cov = sum((x - mx) * (y - my) for x, y in pairs); vx = sum((x - mx) ** 2 for x in xs); vy = sum((y - my) ** 2 for y in ys)
        print(f' DSPX vs the gap, 5-session changes: correlation {cov / (vx * vy) ** .5:.2f} over {len(pairs)} days')
    results[sym] = out

for s in ('SPY', 'QQQ'): run(s)

# ── VERDICT ──────────────────────────────────────────────────────────────────────────────────────
print('\n===== verdict (both symbols; Q1 deeper or Q3 higher, interval clear of zero, same sign in both halves) =====')
def q1_pass(sym, g, p):
    for N in (10, 20):
        x = results[sym]['q1'][(g, p, N)]; c = x['ci']; h1, h2 = x['halves']
        if c and c[2] < 0 and h1 is not None and h2 is not None and h1 < 0 and h2 < 0: return f'Q1 {N}d'
    return None
def q3_pass(sym, p):
    x = results[sym]['q3'][p]; c = x['ci']; h1, h2 = x['halves']
    return 'Q3' if c and c[1] > 0 and h1 is not None and h2 is not None and h1 > 0 and h2 > 0 else None
verdict = {}
for g, label in (('cor', 'COR1M jump'), ('gap', 'VIXEQ − VIX narrowing with VIX up')):
    ok = []
    for p in (.8, .9):
        per = {s: [x for x in (q1_pass(s, g, p), q3_pass(s, p) if g == 'cor' else None) if x] for s in ('SPY', 'QQQ')}
        if per['SPY'] and per['QQQ']: ok.append(f"{int(p*100)}th pct: SPY {', '.join(per['SPY'])}; QQQ {', '.join(per['QQQ'])}")
    verdict[g] = ok
    print(f"  {label:36s} {'PASSES — ' + ' | '.join(ok) if ok else 'display only'}")
print(f"  overall: {'regime-score candidate' if any(verdict.values()) else 'display only'}")
