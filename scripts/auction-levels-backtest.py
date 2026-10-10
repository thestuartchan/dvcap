#!/usr/bin/env python3
# scripts/auction-levels-backtest.py — do auction (Market Profile) levels beat a random level? (11 Oct 2026)
#
# The "auction + GEX + magnets" framework says price "loves to come back" to the previous day's
# value area and POC, to naked POCs and to single prints. This tests that against levels the same
# distance from price, on QQQ and SPY. Backtest only: nothing here feeds the dashboard or alerts.
# Market data only, read raw. No positions, fills or journal data anywhere.
#
# ── FETCH (into one scratch directory, never the repo) ───────────────────────────────────────────
#   D=/tmp/auction; mkdir -p $D
#   TradingView connector, mcp-tv-get-ohlcv, format=columns, count=8000 (one page each; has_more was
#   false on 11 Oct 2026 — if it is true, page back with date_to=next_date_to and concatenate):
#     symbol NASDAQ:QQQ / AMEX:SPY · interval 30m · date_from 2025-01-01   → $D/tv.<SYM>.30m.json
#     symbol NASDAQ:QQQ / AMEX:SPY · interval 15m · date_from 2025-12-01   → $D/tv.<SYM>.15m.json
#     symbol NASDAQ:QQQ / AMEX:SPY · interval 5m  · date_from 2026-06-01   → $D/tv.<SYM>.5m.json
#   (the tool's JSON saved as returned: {symbol, interval, bars: {t, o, h, l, c, v}}; t is unix UTC;
#   TradingView serves the regular session only)
#   curl -sS https://squeezemetrics.com/monitor/static/DIX.csv -o $D/dix.csv
#   for s in SPY QQQ; do curl -sS -A Mozilla/5.0 \
#     "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=1704067200&period2=$(date +%s)" -o $D/$s.d.json; done
#   now=$(date +%s); for s in SPY QQQ; do for k in 0 1 2 3; do p2=$((now-k*7*86400)); p1=$((p2-7*86400)); \
#     curl -sS -A Mozilla/5.0 "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=1m&period1=$p1&period2=$p2" \
#     -o $D/$s.1m.$k.json; done; done
#   for s in SPY QQQ; do curl -sS "https://dvcap.vercel.app/api/gex?symbol=$s" -o $D/gex.$s.json; done
#   python3 -I scripts/auction-levels-backtest.py $D
#
# ── TIERS ────────────────────────────────────────────────────────────────────────────────────────
#   A  30-minute bars from 2 Jan 2025 (~440 sessions) — Market Profile by TPO, Dalton's definition.
#   B  15-minute bars from 2 Jan 2026 (~190 sessions) — volume profile.
#   C  5-minute bars from 6 Jul 2026 (~65 sessions)   — volume profile; the precision check.
#   Regular hours only (09:30–16:00 New York). A session missing any bar is dropped, which also
#   drops the half days (13 / 26 / 78 bars expected).
#
# ── DEFINITIONS, AS IMPLEMENTED ─────────────────────────────────────────────────────────────────
#   Bins       $0.10. A bar covers every bin from floor(low/0.10) to floor(high/0.10).
#   Profile    tier A (TPO): each 30-minute bar adds one TPO to every bin its range covers.
#              tiers B, C, 1-minute (volume): each bar's volume is spread evenly across its bins.
#   POC        the bin with the most TPOs / volume; ties go to the bin nearest the session midpoint.
#              The level is the bin's centre.
#   Value area start at the POC; add whichever neighbouring bin (one above, one below) holds more,
#              the upper one on a tie, until 70% of the TPOs / volume is inside. VAH = top edge of
#              the highest bin, VAL = bottom edge of the lowest.
#   PD levels  the previous session's POC, VAH, VAL (that session must be the previous trading day).
#   Naked POC  the POC of session k (k within the last 20 sessions, k ≤ d−2) that no session from
#              k+1 to d−1 traded through. The previous day's own POC is the PD POC, not a naked one.
#   Single     the session split into 30-minute periods; bins touched by exactly one period; a run of
#   prints     3+ consecutive such bins that includes neither the session's top nor bottom bin. The
#              level is the run's midpoint. Levels for session d are session d−1's single prints.
#   ATR        daily ATR(14), Wilder-smoothed (lib/atr.js), from Yahoo's settled daily bars, as of
#              the previous close — known before the open.
#   Regime     SqueezeMetrics SPX GEX at the previous close (DIX.csv), sign only; plus, as an extra
#              split, below / above its trailing-year median (negative GEX is rare). dvcap's own flip
#              (from 1 Sep 2026): the open against the PREVIOUS capture's flip (lib/gexDays.js rule).
#   Not tested imbalance, absorption and delta need bid/ask data, which none of these sources have.
#
# ── WHAT THE VOLUME IS (checked 11 Oct 2026; printed under "data notes") ─────────────────────────
#   TradingView's intraday volume sums to ~11–13% of Yahoo's consolidated daily volume: one venue's
#   prints under the account's data plan, not the tape. Tiers B and C are therefore one venue's
#   volume-at-price — the shape, not the size, is what a POC or value area uses, but it is not the
#   consolidated profile. Yahoo's 1-minute volume sums to 2–12× its own daily figure and is not used:
#   the 1-minute precision check is built by time at price (each minute one TPO) instead.
#
# ── TESTS ────────────────────────────────────────────────────────────────────────────────────────
#   1 Touch     P(the session trades through the level), by distance from the open in ATR. Baseline
#               for each level: the share of ALL sessions whose range reached that same distance from
#               the open on that side. Edge = touch − baseline, in percentage points.
#   2 Hold      from the first touch, does price go 0.25 ATR back the way it came before it goes
#               0.25 ATR through? The bar that touches can only show a break for certain (an
#               excursion back may have come before the touch), so a touch bar showing both, or only
#               the move back, is ambiguous and left out — for real and placebo levels alike. Not
#               resolved by the close: left out. Placebo: the same level moved a random 0.2–0.6 ATR
#               up or down, on the same days (4 per real level). Edge = hold − placebo hold.
#   3 VA rules  open inside vs outside the previous value area: range and where the session closes.
#               The "80% rule": open outside, then two consecutive 30-minute periods closing inside;
#               how often the rest of the session reaches the far side. Baseline: from the same
#               30-minute close in every session, how often the rest of the session travels the same
#               distance (ATR) the same way.
#   4 Naked     each naked POC counted once, from the second session after it formed: hit within 1, 5
#     POCs      and 10 sessions vs the share of all start days that reached that distance that way.
#   5 Single    each single print counted once, from the next session: filled (traded through its
#     prints    midpoint) within 1 and 5 sessions, against the same distance-matched baseline.
#   6 Splits    tests 1–2 by gamma regime; and, on the dvcap capture days only, by whether the level
#               sits within 0.1% of the previous capture's call wall, put wall or flip.
#   Every edge carries a bootstrap 95% interval: sessions resampled with replacement, 1000 times.
#
# ── VERDICT RULE (brief of 11 Oct) ──────────────────────────────────────────────────────────────
#   A level type has an edge only if, on tier A, it beats its baseline by ≥10 points on touch or on
#   hold with the interval above zero, for BOTH QQQ and SPY, and tier B's edge on that test is
#   positive for both. Otherwise: no edge found.
import json, csv, sys, glob, math, random, bisect, statistics as st, datetime as dt
from zoneinfo import ZoneInfo

S = sys.argv[1]
NY = ZoneInfo('America/New_York')
BIN = 0.10; VA_SHARE = 0.70; SP_MIN = 3; NAKED_LOOKBACK = 20; HOLD_ATR = 0.25
PLACEBO = (0.2, 0.6); PLACEBOS = 4; BOOT = 1000; SEED = 20261011; CONFLUENCE = 0.001
BUCKETS = [(0, .25), (.25, .5), (.5, 1), (1, math.inf)]
BUCKET_LABEL = ['0–0.25', '0.25–0.5', '0.5–1', '>1']
TIERS = [('A', '30m', 13, 'tpo'), ('B', '15m', 26, 'vol'), ('C', '5m', 78, 'vol')]
TYPES = ['PD POC', 'PD VAH', 'PD VAL', 'naked POC', 'single print']
rng = random.Random(SEED)

# ── DATA ─────────────────────────────────────────────────────────────────────────────────────────
def yahoo(path):
    r = json.load(open(path))['chart']['result'][0]; q = r['indicators']['quote'][0]
    return r, q

def daily(sym):
    r, q = yahoo(f'{S}/{sym}.d.json'); off = r['meta']['gmtoffset']; out = []
    for t, o, h, l, c in zip(r['timestamp'], q['open'], q['high'], q['low'], q['close']):
        if None in (o, h, l, c) or h < l: continue
        out.append((dt.datetime.utcfromtimestamp(t + off).date().isoformat(), o, h, l, c))
    return out

def wilder_atr(bars, p=14):
    tr = [(bars[i][0], max(bars[i][2] - bars[i][3], abs(bars[i][2] - bars[i - 1][4]), abs(bars[i][3] - bars[i - 1][4])))
          for i in range(1, len(bars))]
    out, a = {}, None
    for i, (d, x) in enumerate(tr):
        if i + 1 < p: continue
        a = sum(v for _, v in tr[:p]) / p if a is None else (a * (p - 1) + x) / p
        out[d] = a
    return out

def regular(t):
    loc = dt.datetime.fromtimestamp(t, NY)
    m = loc.hour * 60 + loc.minute
    return loc.date().isoformat(), m

def sessions_from(rows, expected, step):
    """rows: [(t, o, h, l, c, v)] → {date: [(minute, o, h, l, c, v)]}, complete regular sessions only."""
    by = {}
    for t, o, h, l, c, v in rows:
        if None in (o, h, l, c): continue
        d, m = regular(t)
        if 570 <= m < 960: by.setdefault(d, []).append((m, o, h, l, c, v or 0))
    out = {}
    for d, bs in by.items():
        bs.sort()
        if len(bs) == expected and all(bs[i][0] == 570 + i * step for i in range(expected)): out[d] = bs
    return out

def tv(sym, iv):
    b = json.load(open(f'{S}/tv.{sym}.{iv}.json'))['bars']
    return list(zip(b['t'], b['o'], b['h'], b['l'], b['c'], b['v']))

def yahoo_1m(sym):
    rows = {}
    for f in sorted(glob.glob(f'{S}/{sym}.1m.*.json')):
        r, q = yahoo(f)
        for t, o, h, l, c, v in zip(r.get('timestamp') or [], q['open'], q['high'], q['low'], q['close'], q['volume']):
            rows[t] = (t, o, h, l, c, v)
    by = {}
    for t, o, h, l, c, v in rows.values():
        if None in (o, h, l, c): continue
        d, m = regular(t)
        if 570 <= m < 960: by.setdefault(d, []).append((m, o, h, l, c, v or 0))
    # Yahoo's 1-minute feed skips the odd minute: a session needs 380 of its 390.
    return {d: sorted(bs) for d, bs in by.items() if len(bs) >= 380}

# ── PROFILES ─────────────────────────────────────────────────────────────────────────────────────
def bins_of(lo, hi): return range(math.floor(lo / BIN + 1e-9), math.floor(hi / BIN + 1e-9) + 1)

def periods30(bars):
    """The session as 30-minute periods: [(set of bins, high, low, close)]."""
    out = {}
    for m, o, h, l, c, v in bars:
        k = (m - 570) // 30
        p = out.setdefault(k, [set(), -math.inf, math.inf, None])
        p[0].update(bins_of(l, h)); p[1] = max(p[1], h); p[2] = min(p[2], l); p[3] = c
    return [tuple(out[k]) for k in sorted(out)]

def build(bars, kind):
    hi = max(b[2] for b in bars); lo = min(b[3] for b in bars); mid = (hi + lo) / 2
    prof = {}
    for m, o, h, l, c, v in bars:
        bs = bins_of(l, h)
        w = 1 if kind == 'tpo' else v / len(bs)
        for b in bs: prof[b] = prof.get(b, 0) + w
    poc = max(prof, key=lambda b: (prof[b], -abs((b + .5) * BIN - mid)))
    total = sum(prof.values()); inside = prof[poc]; a = z = poc; bmin, bmax = min(prof), max(prof)
    while inside < VA_SHARE * total and (a > bmin or z < bmax):
        up = prof.get(z + 1, 0) if z < bmax else -1; dn = prof.get(a - 1, 0) if a > bmin else -1
        if up >= dn: z += 1; inside += up
        else: a -= 1; inside += dn
    per = periods30(bars)
    count = {}
    for bset, *_ in per:
        for b in bset: count[b] = count.get(b, 0) + 1
    top, bot = math.floor(hi / BIN + 1e-9), math.floor(lo / BIN + 1e-9)
    singles, run = [], []
    for b in range(bot, top + 2):
        if b <= top and count.get(b) == 1: run.append(b); continue
        if len(run) >= SP_MIN and run[0] != bot and run[-1] != top: singles.append((run[0] + run[-1] + 1) / 2 * BIN)
        run = []
    return dict(poc=(poc + .5) * BIN, vah=(z + 1) * BIN, val=a * BIN, singles=singles, periods=per,
                open=bars[0][1], high=hi, low=lo, close=bars[-1][4], bars=bars)

# ── STATISTICS ───────────────────────────────────────────────────────────────────────────────────
_RESAMPLES = {}
def resamples(n):
    """BOOT lists of n session indices drawn with replacement, made once per sample size."""
    if n not in _RESAMPLES: _RESAMPLES[n] = [rng.choices(range(n), k=n) for _ in range(BOOT)]
    return _RESAMPLES[n]

def boot(per_session, stat):
    """per_session: {session_index: tuple of sums}. Point estimate and a 95% interval, sessions
    resampled with replacement. stat(tuple of totals) → value or None."""
    keys = list(per_session)
    if not keys: return None
    vecs = [per_session[k] for k in keys]; n = len(keys); w = len(vecs[0])
    cols = [[v[j] for v in vecs] for j in range(w)]
    point = stat([sum(c) for c in cols])
    if point is None: return None
    draws = []
    for idx in resamples(n):
        x = stat([sum(map(c.__getitem__, idx)) for c in cols])
        if x is not None: draws.append(x)
    draws.sort()
    return point, draws[int(.025 * len(draws))], draws[int(.975 * len(draws)) - 1], n

def fmt_ci(r, pct=True):
    if r is None: return '—'
    p, lo, hi, _ = r
    f = (lambda x: f'{x * 100:+.1f}') if pct else (lambda x: f'{x:+.2f}')
    return f'{f(p)} [{f(lo)}, {f(hi)}]'

def share(sorted_vals, x):
    """Share of values ≥ x."""
    return 1 - bisect.bisect_left(sorted_vals, x) / len(sorted_vals) if sorted_vals else None

# ── ONE SYMBOL, ONE TIER ─────────────────────────────────────────────────────────────────────────
def hold_test(sess, L, A):
    """+1 hold, 0 break, None ambiguous / never touched / unresolved."""
    O = sess['open']; up = L > O     # approached from below when the level is above the open
    away = L - HOLD_ATR * A if up else L + HOLD_ATR * A
    thru = L + HOLD_ATR * A if up else L - HOLD_ATR * A
    bars = sess['bars']; j = None
    for i, (m, o, h, l, c, v) in enumerate(bars):
        if l <= L <= h: j = i; break
    if j is None: return None, False
    m, o, h, l, c, v = bars[j]
    got_thru = h >= thru if up else l <= thru
    got_away = l <= away if up else h >= away
    if got_thru and not got_away: return 0, True
    if got_away: return None, True                      # ambiguous in the touch bar
    for m, o, h, l, c, v in bars[j + 1:]:
        t = h >= thru if up else l <= thru
        a = l <= away if up else h >= away
        if t and a: return None, True
        if t: return 0, True
        if a: return 1, True
    return None, True

def run(sym, tier, iv, expected, kind, ctx):
    step = int(iv[:-1])
    raw = sessions_from(tv(sym, iv), expected, step)
    days = ctx['days']; atr = ctx['atr']; prevday = ctx['prevday']
    dates = [d for d in sorted(raw) if d in prevday and prevday[d] in atr]
    sess = []
    for d in dates:
        s = build(raw[d], kind); s['date'] = d; s['A'] = atr[prevday[d]]; sess.append(s)
    n = len(sess)
    ok_prev = [i > 0 and sess[i - 1]['date'] == prevday[sess[i]['date']] for i in range(n)]
    # Unconditional excursions from the open, in ATR — the touch baseline.
    upx = sorted((s['high'] - s['open']) / s['A'] for s in sess)
    dnx = sorted((s['open'] - s['low']) / s['A'] for s in sess)
    # Which session traded through which price, for naked POCs and fills.
    def traded(i, L): return sess[i]['low'] <= L <= sess[i]['high']
    # Levels known before each open.
    levels = {}
    for i in range(n):
        if not ok_prev[i]: continue
        p = sess[i - 1]; lv = [('PD POC', p['poc']), ('PD VAH', p['vah']), ('PD VAL', p['val'])]
        for k in range(max(0, i - NAKED_LOOKBACK), i - 1):
            L = sess[k]['poc']
            if not any(traded(j, L) for j in range(k + 1, i)): lv.append(('naked POC', L))
        lv += [('single print', x) for x in p['singles']]
        levels[i] = lv
    # Regime labels for each session.
    gex = ctx['gex']; gdates = ctx['gdates']; caps = ctx['caps'].get(sym, [])
    def gex_label(d):
        j = bisect.bisect_left(gdates, d) - 1
        if j < 0: return None, None
        g = gex[gdates[j]]; win = [gex[x] for x in gdates[max(0, j - 252):j]]
        return ('GEX +' if g > 0 else 'GEX −'), (('GEX low half' if g < st.median(win) else 'GEX high half') if len(win) >= 200 else None)
    def prior_cap(d):
        c = [x for x in caps if x['date'] < d]
        return c[-1] if c else None
    lab = {}
    for i, s in enumerate(sess):
        g1, g2 = gex_label(s['date']); c = prior_cap(s['date'])
        flip = None
        if c and c.get('flipLevel'): flip = 'above dvcap flip' if s['open'] > c['flipLevel'] else 'below dvcap flip'
        lab[i] = dict(gsign=g1, ghalf=g2, flip=flip, cap=c)
    # Tests 1 and 2: one record per level.
    recs = []
    for i, lv in levels.items():
        s = sess[i]; O, A = s['open'], s['A']
        for typ, L in lv:
            x = (L - O) / A; up = x > 0; dist = abs(x)
            touched = (s['high'] >= L) if up else (s['low'] <= L)
            base = share(upx if up else dnx, dist)
            h, _ = hold_test(s, L, A)
            ph = []
            for _ in range(PLACEBOS):
                Lp = L + rng.choice((-1, 1)) * rng.uniform(*PLACEBO) * A
                ph.append(hold_test(s, Lp, A)[0])
            c = lab[i]['cap']; conf = None
            if c:
                walls = [c.get(k) for k in ('callWall', 'putWall', 'flipLevel') if c.get(k)]
                conf = any(abs(L - w) / w <= CONFLUENCE for w in walls)
            recs.append(dict(i=i, typ=typ, dist=dist, touch=1 if touched else 0, base=base, hold=h, ph=ph, conf=conf, **{k: lab[i][k] for k in ('gsign', 'ghalf', 'flip')}))
    out = dict(sym=sym, tier=tier, n=n, first=sess[0]['date'] if sess else None, last=sess[-1]['date'] if sess else None, recs=recs, sess=sess, levels=levels, ok_prev=ok_prev)
    # Test 3: value-area rules.
    va = dict(inside=[], outside=[])
    for i in range(n):
        if not ok_prev[i]: continue
        p = sess[i - 1]; s = sess[i]
        side = 'inside' if p['val'] <= s['open'] <= p['vah'] else 'outside'
        va[side].append(dict(i=i, rng=(s['high'] - s['low']) / s['A'], close_in=1 if p['val'] <= s['close'] <= p['vah'] else 0))
    out['va'] = va
    # The 80% rule, with a time- and distance-matched baseline.
    def rest_excursion(s, k, up):
        rest = s['periods'][k + 1:]
        if not rest: return None
        c = s['periods'][k][3]
        return ((max(p[1] for p in rest) - c) if up else (c - min(p[2] for p in rest))) / s['A']
    exc = {}
    for s in sess:
        for k in range(len(s['periods']) - 1):
            for up in (True, False): exc.setdefault((k, up), []).append(rest_excursion(s, k, up))
    exc = {key: sorted(v) for key, v in exc.items()}
    eighty = []
    for i in range(n):
        if not ok_prev[i]: continue
        p = sess[i - 1]; s = sess[i]; per = s['periods']
        above = s['open'] > p['vah']; below = s['open'] < p['val']
        if not (above or below): continue
        inside = [p['val'] <= q[3] <= p['vah'] for q in per]
        k = next((k for k in range(1, len(per)) if inside[k - 1] and inside[k]), None)
        if k is None or k >= len(per) - 1: continue
        c = per[k][3]; target = p['val'] if above else p['vah']
        dist = (c - target) / s['A'] if above else (target - c) / s['A']
        e = rest_excursion(s, k, not above)
        eighty.append(dict(i=i, hit=1 if e >= dist else 0, base=share(exc[(k, not above)], dist)))
    out['eighty'] = eighty
    # Tests 4 and 5: naked POCs and single prints, each counted once.
    def multi_exc(t, N, up):
        if t + N - 1 >= n: return None
        s = sess[t]
        return ((max(sess[j]['high'] for j in range(t, t + N)) - s['open']) if up else (s['open'] - min(sess[j]['low'] for j in range(t, t + N)))) / s['A']
    mexc = {(N, up): sorted(x for x in (multi_exc(t, N, up) for t in range(n)) if x is not None) for N in (1, 5, 10) for up in (True, False)}
    def later(kind_events):
        res = {}
        for N in (1, 5, 10):
            ev = []
            for t, L in kind_events:
                if t + N - 1 >= n: continue
                s = sess[t]; up = L > s['open']; dist = abs(L - s['open']) / s['A']
                hit = any(traded(j, L) for j in range(t, t + N))
                ev.append(dict(i=t, hit=1 if hit else 0, base=share(mexc[(N, up)], dist)))
            res[N] = ev
        return res
    naked_ev = [(k + 2, sess[k]['poc']) for k in range(n - 2) if ok_prev[k + 1] and not traded(k + 1, sess[k]['poc'])]
    single_ev = [(k + 1, L) for k in range(n - 1) if ok_prev[k + 1] for L in sess[k]['singles']]
    out['naked'] = later(naked_ev); out['single'] = later(single_ev)
    return out

# ── REPORT ───────────────────────────────────────────────────────────────────────────────────────
def touch_stat(rs):
    per = {}
    for r in rs:
        v = per.setdefault(r['i'], [0.0, 0.0, 0.0]); v[0] += r['touch'] - r['base']; v[1] += 1; v[2] += r['touch']
    return per

def touch_line(rs):
    per = touch_stat(rs)
    if not per: return None
    e = boot(per, lambda t: t[0] / t[1] if t[1] else None)
    n = sum(1 for _ in rs); t = sum(r['touch'] for r in rs) / n; b = sum(r['base'] for r in rs) / n
    return dict(n=n, touch=t, base=b, edge=e)

def hold_line(rs):
    per = {}
    for r in rs:
        v = per.setdefault(r['i'], [0.0, 0.0, 0.0, 0.0])
        if r['hold'] is not None: v[0] += r['hold']; v[1] += 1
        for h in r['ph']:
            if h is not None: v[2] += h; v[3] += 1
    if not per: return None
    e = boot(per, lambda t: (t[0] / t[1] - t[2] / t[3]) if t[1] and t[3] else None)
    T = [sum(v[j] for v in per.values()) for j in range(4)]
    return dict(n=int(T[1]), hold=T[0] / T[1] if T[1] else None, placebo=T[2] / T[3] if T[3] else None, edge=e,
                undecided=sum(1 for r in rs if r['touch'] and r['hold'] is None))

def rate_line(ev):
    per = {}
    for e in ev:
        v = per.setdefault(e['i'], [0.0, 0.0, 0.0]); v[0] += e['hit'] - e['base']; v[1] += 1; v[2] += e['hit']
    if not per: return None
    b = boot(per, lambda t: t[0] / t[1] if t[1] else None)
    return dict(n=len(ev), hit=sum(e['hit'] for e in ev) / len(ev), base=sum(e['base'] for e in ev) / len(ev), edge=b)

def pc(x): return '—' if x is None else f'{x * 100:.0f}%'

def report(res):
    sym, tier = res['sym'], res['tier']
    print(f"\n===== {sym} · tier {tier} · {res['n']} sessions {res['first']} → {res['last']} =====")
    recs = res['recs']; summary = {}
    print(f"  {'level':13s} {'n':>5s} {'touch':>6s} {'base':>6s}  {'touch edge, pts [95% CI]':28s} {'hold':>5s} {'plac.':>5s} {'n hold':>6s}  hold edge, pts [95% CI]")
    for typ in TYPES:
        rs = [r for r in recs if r['typ'] == typ]
        t = touch_line(rs); h = hold_line(rs)
        summary[typ] = dict(touch=t['edge'] if t else None, hold=h['edge'] if h else None)
        if not t: print(f'  {typ:13s}     0'); continue
        print(f"  {typ:13s} {t['n']:5d} {pc(t['touch']):>6s} {pc(t['base']):>6s}  {fmt_ci(t['edge']):28s} {pc(h['hold']):>5s} {pc(h['placebo']):>5s} {h['n']:6d}  {fmt_ci(h['edge'])}")
        for (lo, hi), labl in zip(BUCKETS, BUCKET_LABEL):
            sub = [r for r in rs if lo <= r['dist'] < hi]
            t2 = touch_line(sub); h2 = hold_line(sub)
            if not t2: continue
            print(f"    {labl + ' ATR':11s} {t2['n']:5d} {pc(t2['touch']):>6s} {pc(t2['base']):>6s}  {fmt_ci(t2['edge']):28s} {pc(h2['hold']):>5s} {pc(h2['placebo']):>5s} {h2['n']:6d}  {fmt_ci(h2['edge'])}")
    und = sum(1 for r in recs if r['touch'] and r['hold'] is None); tch = sum(r['touch'] for r in recs)
    print(f"  hold test: {und} of {tch} touched levels ambiguous or unresolved at this bar size, left out")
    # Splits.
    print('  splits (all level types pooled; touch edge | hold edge):')
    for key, vals in (('gsign', ('GEX +', 'GEX −')), ('ghalf', ('GEX low half', 'GEX high half')), ('flip', ('above dvcap flip', 'below dvcap flip'))):
        for v in vals:
            rs = [r for r in recs if r[key] == v]
            if not rs: continue
            t = touch_line(rs); h = hold_line(rs)
            note = ' (small sample: dvcap captures from 1 Sep 2026)' if key == 'flip' else (' (rare: few sessions)' if v == 'GEX −' else '')
            print(f"    {v:18s} sessions {len({r['i'] for r in rs}):4d} levels {t['n']:5d}  touch {fmt_ci(t['edge'])} | hold {fmt_ci(h['edge'])}{note}")
    for v, labl in ((True, 'within 0.1% of a dvcap wall/flip'), (False, 'not near a wall/flip')):
        rs = [r for r in recs if r['conf'] is v]
        if not rs: continue
        t = touch_line(rs); h = hold_line(rs)
        print(f"    {labl:34s} levels {t['n']:5d}  touch {fmt_ci(t['edge'])} | hold {fmt_ci(h['edge'])} (small sample)")
    # Value-area rules.
    va = res['va']
    for side in ('inside', 'outside'):
        xs = va[side]
        if xs: print(f"  open {side:7s} prior VA: {len(xs):4d} sessions · median range {st.median(x['rng'] for x in xs):.2f} ATR · closed inside prior VA {pc(sum(x['close_in'] for x in xs) / len(xs))}")
    r80 = rate_line(res['eighty'])
    if r80: print(f"  80% rule: {r80['n']} triggers · reached the far side {pc(r80['hit'])} vs matched baseline {pc(r80['base'])} · edge {fmt_ci(r80['edge'])}")
    for name, key, Ns in (('naked POC', 'naked', (1, 5, 10)), ('single print fill', 'single', (1, 5))):
        parts = []
        for N in Ns:
            r = rate_line(res[key][N])
            if r: parts.append(f"{N}d {pc(r['hit'])} vs {pc(r['base'])} edge {fmt_ci(r['edge'])} (n={r['n']})")
        if parts: print(f"  {name}: " + ' · '.join(parts))
    return summary

def precision(a, b, label):
    """Median gap between two tiers' PD levels on the sessions both have."""
    da = {s['date']: s for s in a['sess']}; gaps = {'poc': [], 'vah': [], 'val': []}
    for s in b['sess']:
        t = da.get(s['date'])
        if not t: continue
        for k in gaps: gaps[k].append(abs(t[k] - s[k]))
    if not gaps['poc']: return
    print(f"  {label}: {len(gaps['poc'])} sessions · median gap POC {st.median(gaps['poc']) * 100:.0f}¢ · VAH {st.median(gaps['vah']) * 100:.0f}¢ · VAL {st.median(gaps['val']) * 100:.0f}¢")

def main():
    gexs = {}
    for row in csv.DictReader(open(f'{S}/dix.csv')): gexs[row['date']] = float(row['gex'])
    caps = {}
    for sym in ('SPY', 'QQQ'):
        try: caps[sym] = sorted((c for c in json.load(open(f'{S}/gex.{sym}.json'))['series'] if c.get('date')), key=lambda c: c['date'])
        except FileNotFoundError: caps[sym] = []
    results = {}
    for sym in ('QQQ', 'SPY'):
        d = daily(sym); atr = wilder_atr(d)
        prevday = {d[i][0]: d[i - 1][0] for i in range(1, len(d))}
        ctx = dict(days=[x[0] for x in d], atr=atr, prevday=prevday, gex=gexs, gdates=sorted(gexs), caps=caps)
        for tier, iv, expected, kind in TIERS:
            results[(sym, tier)] = run(sym, tier, iv, expected, kind, ctx)
        m1 = yahoo_1m(sym)
        if m1:
            sess = []
            for dd in sorted(m1):
                s = build(m1[dd], 'tpo'); s['date'] = dd; sess.append(s)
            results[(sym, '1m')] = dict(sess=sess)
    print('===== data notes =====')
    for sym in ('QQQ', 'SPY'):
        yv = {}
        r, q = yahoo(f'{S}/{sym}.d.json'); off = r['meta']['gmtoffset']
        for t, v in zip(r['timestamp'], q['volume']): yv[dt.datetime.utcfromtimestamp(t + off).date().isoformat()] = v
        for tier, iv, expected, kind in TIERS:
            rat = [sum(b[5] for b in s['bars']) / yv[s['date']] for s in results[(sym, tier)]['sess'] if yv.get(s['date'])]
            print(f"  {sym} tier {tier} ({iv}): TradingView volume is {st.median(rat):.0%} of Yahoo's consolidated daily volume (median) — one venue's prints")
    summ = {}
    for sym in ('QQQ', 'SPY'):
        for tier, *_ in TIERS: summ[(sym, tier)] = report(results[(sym, tier)])
    print('\n===== how far coarse levels sit from fine ones (previous-day POC / VAH / VAL) =====')
    for sym in ('QQQ', 'SPY'):
        precision(results[(sym, 'A')], results[(sym, 'C')], f'{sym} tier A (30m TPO) vs tier C (5m volume)')
        precision(results[(sym, 'B')], results[(sym, 'C')], f'{sym} tier B (15m volume) vs tier C (5m volume)')
        if (sym, '1m') in results:
            precision(results[(sym, 'A')], results[(sym, '1m')], f'{sym} tier A (30m TPO) vs 1-minute time at price')
            precision(results[(sym, 'C')], results[(sym, '1m')], f'{sym} tier C (5m volume) vs 1-minute time at price')
    print('\n===== verdict (rule: tier A ≥ +10 pts with CI above zero for QQQ and SPY, tier B positive for both) =====')
    passed = []
    for typ in TYPES:
        why = []
        for test in ('touch', 'hold'):
            a = [summ[(s, 'A')][typ][test] for s in ('QQQ', 'SPY')]
            b = [summ[(s, 'B')][typ][test] for s in ('QQQ', 'SPY')]
            if all(x and x[0] >= .10 and x[1] > 0 for x in a) and all(x and x[0] > 0 for x in b):
                why.append(test)
        print(f"  {typ:13s} {'EDGE on ' + ' and '.join(why) if why else 'no edge found'}")
        if why: passed.append(typ)
    print(f"  overall: {'edge in ' + ', '.join(passed) if passed else 'no edge found'}")

if __name__ == '__main__':
    main()
