#!/usr/bin/env python3
# scripts/ema-vwap-backtest.py — the "EMA × VWAP" 3-minute strategy on QQQ and SPY (13 Oct 2026).
#
# An Instagram reel (an ad for a paid indicator) calls this "one of the best strategies". A 21-session
# Yahoo pilot found no edge after costs; this is the proper test, with a chronological holdout and a
# random-entry placebo. Backtest only: nothing here feeds the dashboard, the console or alerts.
# Market data only, read raw. No positions, fills or journal data anywhere.
#
# ── FETCH (into one scratch directory, never the repo) ───────────────────────────────────────────
#   D=/tmp/emavwap; mkdir -p $D
#   TradingView connector, mcp-tv-get-ohlcv, format=columns, count=8000, date_from 2025-01-01, saved
#   as returned ({symbol, interval, bars: {t, o, h, l, c, v}}; t = bar open, unix UTC; regular
#   session only). has_more was false for every series on 13 Oct 2026 — the feed's whole window:
#     NASDAQ:QQQ / AMEX:SPY · 3m   → $D/tv.<SYM>.3m.json    (from 2026-08-17, 5,200 bars)
#     NASDAQ:QQQ / AMEX:SPY · 5m   → $D/tv.<SYM>.5m.json    (from 2026-07-13, 5,070 bars)
#     NASDAQ:QQQ / AMEX:SPY · 1m   → $D/tv.<SYM>.1m.json    (from 2026-09-21, 6,240 bars)
#     NASDAQ:QQQ / AMEX:SPY · 15m  → $D/tv.<SYM>.15m.json   (from 2026-01-02, 5,070 bars; information)
#   The 3-minute history does not reach 2025: "available history starts 2026-08-17". IBKR's connector
#   returns only the latest 1,000 bars with no paging back; EODHD and FMP intraday are not on the
#   plans this account holds. The TradingView window is the longest raw 3-minute series available.
#   curl -sS https://squeezemetrics.com/monitor/static/DIX.csv -o $D/dix.csv
#   now=$(date +%s); for s in SPY QQQ; do for k in 0 1 2 3; do p2=$((now-k*7*86400)); p1=$((p2-7*86400)); \
#     curl -sS -A Mozilla/5.0 "https://query1.finance.yahoo.com/v8/finance/chart/$s?interval=1m&period1=$p1&period2=$p2" \
#     -o $D/$s.1m.$k.json; done; done
#   python3 -I scripts/ema-vwap-backtest.py $D            (charts need matplotlib on PYTHONPATH)
#
# ── THE STRATEGY, AS IMPLEMENTED ─────────────────────────────────────────────────────────────────
#   Bars        regular session, 09:30–16:00 New York. A session missing any bar is dropped, which
#               also drops the half days (3m 130, 5m 78, 1m 390, 15m 26 bars expected).
#   VWAP        per session, reset at the open: Σ(hlc3 × volume) / Σ volume, hlc3 = (h+l+c)/3 —
#               TradingView's default. The volume is TradingView's (one venue; see the cross-check).
#   EMA         on closes, regular-session bars, CONTINUOUS across days (TradingView's default),
#               α = 2/(n+1), seeded with the SMA of the first n closes. n ∈ {9, 20, 21}. The first
#               session of each series is warm-up and is not traded.
#   Long entry  bar i closes ABOVE its VWAP and bar i−1 (same session) closed AT OR BELOW its VWAP — a
#               fresh cross from below. The first bar of a session cannot signal (no prior bar).
#   Long exit   the first bar after the entry signal bar that closes BELOW the EMA.
#   Short       the mirror: close below VWAP after a close at or above it; exit on a close above the EMA.
#   One at a    entries are taken only when flat. A bar that exits may enter the OTHER side if it is
#   time        itself a fresh cross that way; never the same side again on its exit bar. Re-entry
#               needs a new cross — staying above VWAP after an EMA exit does not re-enter.
#   Fills       base: the NEXT bar's open after the signal bar (entry and exit). An entry signal on
#               the last bar is not taken. Sensitivity: the signal bar's close.
#   Close       anything still open at the session's last bar exits at that bar's close.
#   Returns     per trade in bp of the entry price; long (exit−entry)/entry, short (entry−exit)/entry.
#   Costs       gross; 0.15 bp per side (shares: half-spread + IBKR commission); 0.5 bp per side.
#
# ── EVALUATION ───────────────────────────────────────────────────────────────────────────────────
#   Variants    {QQQ, SPY} × {3m, 5m} × {EMA 9, 20, 21} × {long, short, long+short} × {next-open,
#               close} × {gross, 0.15, 0.5}. Also, as checks (not candidates): 3m built from 1m bars
#               (16 sessions) and 15m (≈190 sessions, a slower timeframe than the reel's).
#   Holdout     each series' sessions split CHRONOLOGICALLY 70 / 30. The single best variant is picked
#               on the 70% ONLY — highest mean net bp at 0.15 bp/side, next-open fills, ≥100 trades —
#               and reported once on the untouched 30%. That number is the verdict.
#   Placebo     per variant: the same trades per session, the same sides, the same holding times (in
#               bars), at random entry bars (uniform over the bars that leave room for the hold), the
#               same fill rule. 1,000 draws; the variant's percentile = share of draws whose mean is
#               below the real mean.
#   CI          95% block bootstrap by SESSION (2,000 resamples of whole sessions).
#   Drawdown    peak-to-trough of the cumulative net bp, trade by trade.
#   Regime      SqueezeMetrics SPX GEX at the previous close (DIX.csv), sign only, as in #338.
#               Information only: never used to pick a variant.
#   Edge        ALL of: out-of-sample net mean > 0 with its CI above 0; at or above the placebo's
#               95th percentile; QQQ and SPY the same sign; 3m and 5m the same sign (out of sample,
#               same EMA / side / fill). Otherwise no edge.
#
# ── VWAP CROSS-CHECK ─────────────────────────────────────────────────────────────────────────────
#   TradingView's intraday volume is one venue's (~11–13% of consolidated). On every session both
#   feeds hold (Yahoo 1m, last ~20 sessions), the TradingView 3m VWAP at each bar close is compared
#   with Yahoo's typical-price VWAP over the same minutes, time-weighted (Yahoo's 1m volume is not
#   reliable — #338) and volume-weighted. Reported: median and mean |gap| in cents, and how often the
#   two agree on the side of VWAP the close is on (what the entry rule reads).

import json, csv, sys, os, glob, math, random, statistics as st, datetime as dt
from zoneinfo import ZoneInfo

NY = ZoneInfo('America/New_York')
D = sys.argv[1] if len(sys.argv) > 1 else '/tmp/emavwap'
OUT = os.path.join(D, 'out'); os.makedirs(OUT, exist_ok=True)
SYMS = ['QQQ', 'SPY']
EXPECTED = {1: 390, 3: 130, 5: 78, 15: 26}
EMAS = [9, 20, 21]
SIDES = ['long', 'short', 'both']
FILLS = ['next', 'close']
COSTS = [0.0, 0.15, 0.5]
BASE_COST = 0.15
DRAWS = 1000
BOOT = 2000
MIN_TRADES = 100
random.seed(20261013)

# ── DATA ────────────────────────────────────────────────────────────────────────────────────────
def load_tv(sym, step):
    j = json.load(open(f'{D}/tv.{sym}.{step}m.json'))
    b = j['bars']
    return [dict(t=b['t'][i], o=b['o'][i], h=b['h'][i], l=b['l'][i], c=b['c'][i], v=b['v'][i] or 0) for i in range(len(b['t']))]

def to_sessions(rows, step):
    by = {}
    for r in rows:
        ny = dt.datetime.fromtimestamp(r['t'], NY)
        mins = ny.hour * 60 + ny.minute - (9 * 60 + 30)
        if mins < 0 or mins >= 390: continue
        by.setdefault(ny.date().isoformat(), []).append({**r, 'k': mins // step})
    out, dropped = [], []
    for d in sorted(by):
        bars = sorted(by[d], key=lambda x: x['t'])
        ks = [x['k'] for x in bars]
        if len(bars) != EXPECTED[step] or ks != list(range(EXPECTED[step])): dropped.append(d); continue
        out.append((d, bars))
    return out, dropped

def resample(sessions1, step):
    out = []
    for d, bars in sessions1:
        g = {}
        for b in bars: g.setdefault(b['k'] // step, []).append(b)
        nb = [dict(t=v[0]['t'], o=v[0]['o'], h=max(x['h'] for x in v), l=min(x['l'] for x in v), c=v[-1]['c'], v=sum(x['v'] for x in v), k=k)
              for k, v in sorted(g.items())]
        if len(nb) == 390 // step and all(len(v) == step for v in g.values()): out.append((d, nb))
    return out

def indicators(sessions, n):
    """VWAP per session; EMA continuous across sessions. Returns per-session lists aligned to bars."""
    ema, seed, out = None, [], []
    for d, bars in sessions:
        cv = cpv = 0.0
        vw, em = [], []
        for b in bars:
            tp = (b['h'] + b['l'] + b['c']) / 3
            cv += b['v']; cpv += tp * b['v']
            vw.append(cpv / cv if cv > 0 else tp)
            if ema is None:
                seed.append(b['c'])
                if len(seed) == n: ema = sum(seed) / n
                em.append(ema)
            else:
                ema = ema + (2 / (n + 1)) * (b['c'] - ema)
                em.append(ema)
        out.append((d, bars, vw, em))
    return out

# ── THE STRATEGY ────────────────────────────────────────────────────────────────────────────────
def run(ind, side, fill, skip_first=True):
    trades = []
    for si, (d, bars, vw, em) in enumerate(ind):
        if skip_first and si == 0: continue
        if any(e is None for e in em): continue
        n = len(bars)
        pos = None   # dict(side, sig_bar, entry, entry_bar)
        for i in range(n):
            c = bars[i]['c']
            exited_side = None
            if pos is not None and i > pos['sig']:
                ex = (pos['side'] == 'long' and c < em[i]) or (pos['side'] == 'short' and c > em[i])
                if ex:
                    if fill == 'next':
                        if i + 1 < n: px, xb = bars[i + 1]['o'], i + 1
                        else: px, xb = c, i
                    else: px, xb = c, i
                    trades.append(close_trade(d, si, pos, px, xb, bars, 'ema'))
                    exited_side, pos = pos['side'], None
            if pos is None and i > 0:
                up = c > vw[i] and bars[i - 1]['c'] <= vw[i - 1]
                dn = c < vw[i] and bars[i - 1]['c'] >= vw[i - 1]
                want = 'long' if up and side in ('long', 'both') else 'short' if dn and side in ('short', 'both') else None
                if want and want != exited_side:
                    if fill == 'next':
                        if i + 1 < n: pos = dict(side=want, sig=i, entry=bars[i + 1]['o'], eb=i + 1)
                    else: pos = dict(side=want, sig=i, entry=c, eb=i)
        if pos is not None:
            trades.append(close_trade(d, si, pos, bars[-1]['c'], n - 1, bars, 'close'))
    return trades

def close_trade(d, si, pos, px, xb, bars, why):
    g = (px - pos['entry']) / pos['entry'] * 1e4 * (1 if pos['side'] == 'long' else -1)
    return dict(date=d, si=si, side=pos['side'], entry=pos['entry'], exit=px, eb=pos['eb'], xb=xb, hold=xb - pos['eb'],
                t_in=bars[pos['eb']]['t'], t_out=bars[xb]['t'], gross=g, why=why)

# ── STATISTICS ──────────────────────────────────────────────────────────────────────────────────
def net(t, cost): return t['gross'] - 2 * cost

def stats(trades, cost, nsess, step):
    if not trades: return dict(n=0)
    r = [net(t, cost) for t in trades]
    wins, losses = [x for x in r if x > 0], [x for x in r if x <= 0]
    cum = peak = dd = 0.0
    for x in r:
        cum += x; peak = max(peak, cum); dd = max(dd, peak - cum)
    byday = {}
    for t, x in zip(trades, r): byday[t['date']] = byday.get(t['date'], 0) + x
    top5 = sum(sorted(r, reverse=True)[:5])
    return dict(n=len(r), mean=st.mean(r), win=len(wins) / len(r), avg_win=st.mean(wins) if wins else 0, avg_loss=st.mean(losses) if losses else 0,
                pf=(sum(wins) / -sum(losses)) if losses and sum(losses) < 0 else float('inf'), maxdd=dd, per_day=len(r) / max(1, nsess),
                hold_min=st.mean(t['hold'] for t in trades) * step, pos_days=sum(1 for v in byday.values() if v > 0) / max(1, len(byday)),
                top5=(top5 / sum(r)) if sum(r) != 0 else float('nan'), total=sum(r))

def boot_ci(trades, cost):
    # Whole sessions resampled; a session contributes its trades' sum and count, so each resample is
    # O(sessions). Net = gross − 2·cost per trade, so the interval shifts by exactly that.
    by = {}
    for t in trades:
        s_, n_ = by.get(t['date'], (0.0, 0)); by[t['date']] = (s_ + t['gross'], n_ + 1)
    days = list(by.values())
    if len(days) < 2: return (float('nan'), float('nan'))
    ms, k = [], len(days)
    for _ in range(BOOT):
        S = N = 0
        for _ in range(k):
            s_, n_ = days[random.randrange(k)]; S += s_; N += n_
        ms.append(S / N if N else 0)
    ms.sort()
    return ms[int(0.025 * BOOT)] - 2 * cost, ms[int(0.975 * BOOT) - 1] - 2 * cost

def placebo(trades, ind_by_si, fill, draws=DRAWS, paths=False):
    """Random entries: same count per session, sides and holds. Returns the gross mean per draw
    (costs are identical per trade, so percentiles hold for every cost) and optionally cumulative paths."""
    if not trades: return [], []
    specs = [(t['si'], t['side'], t['hold']) for t in trades]
    means, curves = [], []
    for _ in range(draws):
        tot, path, cum = 0.0, [], 0.0
        for si, side, hold in specs:
            bars = ind_by_si[si][1]; n = len(bars)
            if fill == 'next':
                k = random.randrange(1, max(2, n - hold)) if n - hold > 1 else 1
                k = min(k, n - 1); x = min(k + hold, n - 1)
                pin, pout = bars[k]['o'], (bars[x]['o'] if x > k and x < n - 1 else bars[x]['c'] if x == n - 1 else bars[x]['o'])
            else:
                k = random.randrange(0, max(1, n - hold)); x = min(k + hold, n - 1)
                pin, pout = bars[k]['c'], bars[x]['c']
            g = (pout - pin) / pin * 1e4 * (1 if side == 'long' else -1)
            tot += g
            if paths: cum += g; path.append(cum)
        means.append(tot / len(specs))
        if paths: curves.append(path)
    return means, curves

def pctile(real, dist):
    return sum(1 for m in dist if m < real) / len(dist) * 100 if dist else float('nan')

# ── REGIME ──────────────────────────────────────────────────────────────────────────────────────
def regime_map():
    rows = [(r['date'], float(r['gex'])) for r in csv.DictReader(open(f'{D}/dix.csv')) if r.get('gex')]
    rows.sort()
    def prev(d):
        lo = None
        for x, g in rows:
            if x < d: lo = g
            else: break
        return lo
    return prev

# ── VWAP CROSS-CHECK ────────────────────────────────────────────────────────────────────────────
def yahoo_1m(sym):
    out = {}
    for f in sorted(glob.glob(f'{D}/{sym}.1m.*.json')):
        r = json.load(open(f))['chart']['result'][0]
        q = r['indicators']['quote'][0]
        for i, t in enumerate(r['timestamp']):
            if q['close'][i] is None: continue
            ny = dt.datetime.fromtimestamp(t, NY)
            m = ny.hour * 60 + ny.minute - 570
            if 0 <= m < 390: out.setdefault(ny.date().isoformat(), {})[m] = (q['high'][i], q['low'][i], q['close'][i], q['volume'][i] or 0)
    return out

def vwap_check(sym, sess3):
    y = yahoo_1m(sym)
    gaps_t, gaps_v, gaps_tt, agree, n, days = [], [], [], 0, 0, []
    for d, bars in sess3:
        yd = y.get(d)
        if not yd or len(yd) < 385: continue
        days.append(d)
        ctv = cpv = 0.0; tw = []; ctw = 0.0; cnt = 0; tvt = 0.0; tvn = 0
        for b in bars:
            ctv += b['v']; cpv += (b['h'] + b['l'] + b['c']) / 3 * b['v']
            tvt += (b['h'] + b['l'] + b['c']) / 3; tvn += 1
            tv_vwap = cpv / ctv if ctv else None
            for m in range(b['k'] * 3, b['k'] * 3 + 3):
                if m in yd:
                    h, l, c, v = yd[m]; tp = (h + l + c) / 3
                    ctw += tp; cnt += 1; tw.append((tp, v))
            if tv_vwap is None or not cnt: continue
            ytw = ctw / cnt
            vv = sum(v for _, v in tw); yvw = sum(tp * v for tp, v in tw) / vv if vv else ytw
            gaps_t.append(abs(tv_vwap - ytw) * 100); gaps_v.append(abs(tv_vwap - yvw) * 100)
            gaps_tt.append(abs(tvt / tvn - ytw) * 100)   # both time-weighted: the price data alone
            n += 1; agree += 1 if (b['c'] > tv_vwap) == (b['c'] > ytw) else 0
    return dict(sym=sym, sessions=len(days), first=days[0] if days else None, last=days[-1] if days else None,
                med_t=st.median(gaps_t) if gaps_t else None, mean_t=st.mean(gaps_t) if gaps_t else None,
                med_v=st.median(gaps_v) if gaps_v else None, mean_v=st.mean(gaps_v) if gaps_v else None, agree=agree / n if n else None,
                med_tt=st.median(gaps_tt) if gaps_tt else None)

# ── MAIN ────────────────────────────────────────────────────────────────────────────────────────
def main():
    prev_gex = regime_map()
    series, notes = {}, []
    for sym in SYMS:
        for step in (3, 5, 15):
            s, dropped = to_sessions(load_tv(sym, step), step)
            series[(sym, f'{step}m')] = (s, step)
            notes.append(f'{sym} {step}m: {len(s)} sessions {s[0][0]} → {s[-1][0]}, dropped {len(dropped)} {dropped}')
        s1, dropped1 = to_sessions(load_tv(sym, 1), 1)
        r3 = resample(s1, 3)
        series[(sym, '3m-from-1m')] = (r3, 3)
        notes.append(f'{sym} 3m from 1m: {len(r3)} sessions {r3[0][0]} → {r3[-1][0]}, dropped {len(dropped1)} {dropped1}')

    rows, keep = [], {}
    for (sym, tf), (sess, step) in series.items():
        ns = len(sess); cut = int(round(ns * 0.7))
        for n in EMAS:
            ind = indicators(sess, n)
            for side in SIDES:
                for fill in FILLS:
                    tr = run(ind, side, fill)
                    parts = {'ALL': tr, 'IS': [t for t in tr if t['si'] < cut], 'OOS': [t for t in tr if t['si'] >= cut]}
                    nsess = {'ALL': ns - 1, 'IS': cut - 1, 'OOS': ns - cut}
                    plac = {k: placebo(v, ind, fill)[0] for k, v in parts.items()}
                    keep[(sym, tf, n, side, fill)] = dict(ind=ind, tr=tr, parts=parts, cut=cut, ns=ns, step=step, plac=plac)
                    for split, ts in parts.items():
                        g_lo, g_hi = boot_ci(ts, 0.0) if ts else (float('nan'), float('nan'))
                        for cost in COSTS:
                            s = stats(ts, cost, nsess[split], step)
                            lo, hi = g_lo - 2 * cost, g_hi - 2 * cost
                            gp = [t for t in ts if (prev_gex(t['date']) or 0) > 0]; gn = [t for t in ts if (prev_gex(t['date']) or 0) < 0]
                            rows.append(dict(sym=sym, tf=tf, ema=n, side=side, fill=fill, split=split, cost_bp_side=cost,
                                             sessions=nsess[split], first=sess[1 if split != 'OOS' else cut][0], last=sess[cut - 1 if split == 'IS' else -1][0],
                                             **{k: (round(v, 3) if isinstance(v, float) else v) for k, v in s.items()},
                                             ci_lo=round(lo, 3), ci_hi=round(hi, 3),
                                             placebo_pct=round(pctile(s.get('mean', 0) + 2 * cost if s['n'] else 0, plac[split]), 1) if s['n'] else None,
                                             gexpos_n=len(gp), gexpos_mean=round(st.mean(net(t, cost) for t in gp), 3) if gp else None,
                                             gexneg_n=len(gn), gexneg_mean=round(st.mean(net(t, cost) for t in gn), 3) if gn else None))

    with open(f'{OUT}/variants.csv', 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)

    # ── SELECTION ON THE 70% ONLY ──
    cand = [r for r in rows if r['split'] == 'IS' and r['cost_bp_side'] == BASE_COST and r['fill'] == 'next'
            and r['tf'] in ('3m', '5m') and r['n'] >= MIN_TRADES]
    print('# data'); [print('  ' + x) for x in notes]
    print(f'# candidates on the 70% (next-open, {BASE_COST} bp/side, ≥{MIN_TRADES} trades): {len(cand)}')
    if not cand:
        print('  none qualifies — no variant reaches the trade minimum in-sample'); best = None
    else:
        best = max(cand, key=lambda r: r['mean'])
        top = sorted(cand, key=lambda r: -r['mean'])[:8]
        for r in top: print(f"  {r['sym']} {r['tf']} EMA{r['ema']} {r['side']:5} IS n={r['n']} mean={r['mean']:+.2f}bp CI[{r['ci_lo']:+.2f},{r['ci_hi']:+.2f}] pct={r['placebo_pct']}")
    find = lambda **k: next((r for r in rows if all(r[a] == b for a, b in k.items())), None)
    verdict = {}
    if best:
        key = dict(ema=best['ema'], side=best['side'], fill='next', cost_bp_side=BASE_COST)
        oos = find(sym=best['sym'], tf=best['tf'], split='OOS', **key)
        other_sym = find(sym=[s for s in SYMS if s != best['sym']][0], tf=best['tf'], split='OOS', **key)
        other_tf = find(sym=best['sym'], tf='5m' if best['tf'] == '3m' else '3m', split='OOS', **key)
        conds = {
            'OOS net mean > 0': bool(oos and oos['n'] and oos['mean'] > 0),
            'OOS CI above 0': bool(oos and oos['n'] and oos['ci_lo'] > 0),
            'OOS ≥ 95th pct of placebo': bool(oos and oos['placebo_pct'] is not None and oos['placebo_pct'] >= 95),
            'other symbol same sign (OOS)': bool(oos and other_sym and other_sym['n'] and (other_sym['mean'] > 0) == (oos['mean'] > 0)),
            'other timeframe same sign (OOS)': bool(oos and other_tf and other_tf['n'] and (other_tf['mean'] > 0) == (oos['mean'] > 0)),
        }
        verdict = dict(best=best, oos=oos, other_sym=other_sym, other_tf=other_tf, conds=conds, edge=all(conds.values()))
        print('# selected (on the 70%)', {k: best[k] for k in ('sym', 'tf', 'ema', 'side', 'fill', 'n', 'mean', 'ci_lo', 'ci_hi', 'placebo_pct')})
        print('# out of sample (the verdict number)', {k: oos[k] for k in ('n', 'sessions', 'first', 'last', 'mean', 'ci_lo', 'ci_hi', 'win', 'pf', 'maxdd', 'per_day', 'hold_min', 'pos_days', 'top5', 'placebo_pct')} if oos and oos['n'] else oos)
        for lab, r in (('other symbol', other_sym), ('other timeframe', other_tf)):
            print(f'#   {lab}:', {k: r[k] for k in ('sym', 'tf', 'n', 'mean', 'ci_lo', 'ci_hi', 'placebo_pct')} if r and r['n'] else r)
        for c in COSTS:
            r = find(sym=best['sym'], tf=best['tf'], split='OOS', ema=best['ema'], side=best['side'], fill='next', cost_bp_side=c)
            rc = find(sym=best['sym'], tf=best['tf'], split='OOS', ema=best['ema'], side=best['side'], fill='close', cost_bp_side=c)
            print(f'#   OOS at {c} bp/side: next-open {r["mean"]:+.2f}bp, close-fill {rc["mean"]:+.2f}bp')
        print('# bar for edge:', conds, '→', 'EDGE' if verdict['edge'] else 'NO EDGE')
        # trades CSV for the selected variant, every split marked
        k = (best['sym'], best['tf'], best['ema'], best['side'], 'next')
        with open(f'{OUT}/trades_selected.csv', 'w', newline='') as f:
            w = csv.writer(f); w.writerow(['date', 'split', 'side', 'entry_time_ny', 'exit_time_ny', 'entry', 'exit', 'hold_bars', 'exit_on', 'gross_bp', 'net_bp_0.15', 'net_bp_0.5', 'gex_prev_sign'])
            for t in keep[k]['tr']:
                g = prev_gex(t['date'])
                w.writerow([t['date'], 'IS' if t['si'] < keep[k]['cut'] else 'OOS', t['side'],
                            dt.datetime.fromtimestamp(t['t_in'], NY).strftime('%H:%M'), dt.datetime.fromtimestamp(t['t_out'], NY).strftime('%H:%M'),
                            t['entry'], t['exit'], t['hold'], t['why'], round(t['gross'], 3), round(net(t, 0.15), 3), round(net(t, 0.5), 3),
                            '' if g is None else ('+' if g > 0 else '-')])

    # ── OVERVIEW: every 3m / 5m variant out of sample, base cost, next-open ──
    print('# all 3m/5m variants, OUT OF SAMPLE, next-open, 0.15 bp/side (mean bp, n, placebo pct)')
    for sym in SYMS:
        for tf in ('3m', '5m', '3m-from-1m', '15m'):
            line = []
            for n in EMAS:
                for side in SIDES:
                    r = find(sym=sym, tf=tf, split='OOS' if tf != '3m-from-1m' else 'ALL', ema=n, side=side, fill='next', cost_bp_side=BASE_COST)
                    line.append(f"E{n}{side[0]} {r['mean']:+.1f}({r['n']},{r['placebo_pct']:.0f})" if r and r['n'] else f'E{n}{side[0]} –')
            print(f'  {sym} {tf:11}', ' '.join(line))
    cnt = sum(1 for r in rows if r['split'] == 'OOS' and r['cost_bp_side'] == BASE_COST and r['fill'] == 'next' and r['tf'] in ('3m', '5m') and r['n'] and r['mean'] > 0)
    tot = sum(1 for r in rows if r['split'] == 'OOS' and r['cost_bp_side'] == BASE_COST and r['fill'] == 'next' and r['tf'] in ('3m', '5m') and r['n'])
    print(f'#   positive out of sample: {cnt} of {tot} (3m/5m, next-open, {BASE_COST} bp/side)')

    # ── REGIME (information only) ──
    if best:
        r = find(sym=best['sym'], tf=best['tf'], split='ALL', ema=best['ema'], side=best['side'], fill='next', cost_bp_side=BASE_COST)
        print(f"# regime, selected variant, all sessions: GEX+ n={r['gexpos_n']} mean={r['gexpos_mean']}bp · GEX− n={r['gexneg_n']} mean={r['gexneg_mean']}bp")
        # SPX GEX stayed positive through the 3m and 5m windows; the 15m series (from January) is the
        # only one with negative-gamma days, so the split is shown there too — information only.
        for sym in SYMS:
            r = find(sym=sym, tf='15m', split='ALL', ema=best['ema'], side=best['side'], fill='next', cost_bp_side=BASE_COST)
            print(f"#   15m {sym} same rules: GEX+ n={r['gexpos_n']} mean={r['gexpos_mean']}bp · GEX− n={r['gexneg_n']} mean={r['gexneg_mean']}bp")

    # ── VWAP CROSS-CHECK ──
    print('# VWAP cross-check: TradingView 3m VWAP vs Yahoo 1m typical-price VWAP, cents')
    vc = {}
    for sym in SYMS:
        v = vwap_check(sym, series[(sym, '3m')][0]); vc[sym] = v
        print(f"  {sym}: {v['sessions']} sessions {v['first']} → {v['last']} · time-weighted |gap| median {v['med_t']:.1f}¢ mean {v['mean_t']:.1f}¢ · "
              f"volume-weighted median {v['med_v']:.1f}¢ mean {v['mean_v']:.1f}¢ · same side of VWAP {v['agree'] * 100:.1f}% of bars · "
              f"TradingView's own bars time-weighted vs Yahoo time-weighted median {v['med_tt']:.1f}¢")

    json.dump(dict(verdict={k: v for k, v in verdict.items()}, vwap=vc, notes=notes), open(f'{OUT}/summary.json', 'w'), indent=1, default=str)

    # ── EQUITY CURVES ──
    try:
        import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt
    except Exception:
        print('# charts skipped: matplotlib not on the path'); return
    if not best: return
    for sym in SYMS:
        k = (sym, best['tf'], best['ema'], best['side'], 'next')
        e = keep[k]; tr = e['tr']
        if not tr: continue
        cum, xs = [], 0.0
        for t in tr: xs += net(t, BASE_COST); cum.append(xs)
        _, curves = placebo(tr, e['ind'], 'next', draws=DRAWS, paths=True)
        curves = [[c - 2 * BASE_COST * (i + 1) for i, c in enumerate(p)] for p in curves]
        med = [st.median(p[i] for p in curves) for i in range(len(tr))]
        lo = [sorted(p[i] for p in curves)[int(0.05 * DRAWS)] for i in range(len(tr))]
        hi = [sorted(p[i] for p in curves)[int(0.95 * DRAWS) - 1] for i in range(len(tr))]
        split_at = next((i for i, t in enumerate(tr) if t['si'] >= e['cut']), len(tr))
        fig, ax = plt.subplots(figsize=(10, 4.6), dpi=120)
        x = list(range(1, len(tr) + 1))
        ax.fill_between(x, lo, hi, color='#9aa5b1', alpha=0.25, label='placebo 5–95%')
        ax.plot(x, med, color='#6b7785', lw=1.2, ls='--', label='placebo median')
        ax.plot(x, cum, color='#1f5fbf', lw=1.8, label=f'strategy, net {BASE_COST} bp/side')
        ax.axvspan(split_at + 0.5, len(tr) + 0.5, color='#f2b134', alpha=0.12, label='out of sample (30%)')
        ax.axhline(0, color='#333', lw=0.6)
        ax.set_title(f"{sym} {best['tf']} · EMA {best['ema']} · {best['side']} · next-open fills — {tr[0]['date']} → {tr[-1]['date']}", fontsize=10)
        ax.set_xlabel('trade #'); ax.set_ylabel('cumulative net bp'); ax.legend(fontsize=8, loc='best'); ax.grid(alpha=0.25)
        fig.tight_layout(); fig.savefig(f'{OUT}/equity_{sym}.png'); plt.close(fig)
    print('# charts written')

if __name__ == '__main__':
    main()
