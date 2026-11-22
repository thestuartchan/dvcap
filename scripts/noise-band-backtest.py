#!/usr/bin/env python3
# scripts/noise-band-backtest.py — the "noise band" intraday momentum rule on SPY and QQQ, with option P&L
# (22 Nov 2026). Research only: no orders, no alerts, nothing posted.
#
# WHY. An Instagram reel claims a one-trade-a-day QQQ options bot. Stu asked for a proper test of its rule
# and of the published version it resembles (Zarattini, Aziz & Barbon, "Beat the Market: An Effective
# Intraday Momentum Strategy for S&P500 ETF (SPY)", Swiss Finance Institute Research Paper No. 24-97, 2024).
#
# THE RULES
#   reel     OR = high/low of 09:30–09:45 ET. Noise band: sigma_m = mean over the previous 20 sessions of
#            |close(m) ÷ that day's 09:30 open − 1|; band = open × (1 ± 1.25 × sigma_m). VWAP from 09:30.
#            Checks every 10 minutes from 10:00 to 14:00 on bar closes. Short when close < OR low × (1 − room),
#            close < lower band and close < VWAP; long the mirror. One trade a day; exit 15:45, or a trailing
#            exit that gives back 50% of the best favourable move once that move reaches X.
#   paper    14-session sigma, band = max(open, prior close) × (1 + sigma) and min(open, prior close) ×
#            (1 − sigma); checks on the hour and half hour from 10:00; long above the upper band, short
#            below the lower; trailing stop max(upper, VWAP) / min(lower, VWAP) at the same checks;
#            re-entry allowed; flat at the close. The paper's volatility-targeted sizing is not applied.
#
# DATA (Stu chose Unusual Whales, 22 Nov 2026; licensed for his personal use, so the raw rows AND the
# results stay out of the repo — the cache and the report live outside it)
#   1-minute bars    UW /api/stock/{T}/ohlc/1m per date, through dvcap's keyed door (lib/uwHistory.js):
#                    curl "https://dvcap.vercel.app/api/flex-sync?uw=hist&kind=ohlc&ticker=SPY&date=2024-01-18"
#                    (the session's environment adds the key). UW's minute history starts 11 Jul 2022.
#                    Saved as $D/bars/{T}_{YYYY-MM-DD}.json = [[start_iso, o, h, l, c, v], …] regular session.
#   option minutes   UW /api/option-contract/{OSI}/intraday per date (same door, kind=option). Trades in
#                    1-minute buckets, split by bid / ask side — NOT NBBO quotes. History starts Apr 2025.
#                    Saved as $D/opt/{OSI}_{date}.json (raw rows). `--fetch-options` downloads what is needed.
#   daily            Yahoo chart JSON for SPY, QQQ, ^VIX, ^VXN in $D/daily/ (Cboe's CSVs refuse automated
#                    clients since 19 Nov 2026), SqueezeMetrics DIX.csv (GEX) as $D/daily/dix.csv:
#                    curl -sS https://squeezemetrics.com/monitor/static/DIX.csv -o $D/daily/dix.csv
#   Option prices from real trades: buy at the ask-side average of the first minute after the signal that
#   has ask-side volume, sell at the bid-side average at 15:45 (last bid-side print in 15:36–15:45),
#   stops read each minute's bid-side average (its low when no bid-side print). $0.65 a contract each way.
#   The Black-Scholes PROXY (whole history) prices from the prior close VIX (SPY) / VXN (QQQ), r = 4.5%,
#   with a modelled spread — never presented as real option P&L.
#
#   python3 -I scripts/noise-band-backtest.py $D --out report.md [--fetch-options]
import sys, os, json, math, argparse, datetime as dt, urllib.request, concurrent.futures as cf
from zoneinfo import ZoneInfo
import numpy as np, pandas as pd

NY = ZoneInfo('America/New_York')
TICKERS = ('SPY', 'QQQ')
N_MIN = 390                       # 09:30 … 15:59 bars
OR_END = 15                       # bars 0–14 = 09:30–09:44
EXIT_IDX = 374                    # the 15:44 bar closes at 15:45
REEL_CHECKS = list(range(29, 270, 10))           # bars closing 10:00, 10:10 … 14:00
PAPER_CHECKS = list(range(29, 360, 30))          # 10:00, 10:30 … 15:30
CUSHION = [('neg', None, None, 1.12, 1.20), ('p0', 0, .2, 1.02, 1.10), ('p20', .2, .4, .92, 1.01),
           ('p40', .4, .6, .80, .92), ('p60', .6, .8, .76, .88), ('p80', .8, 1.01, .68, .78)]   # lib/trendTells.js
DOOR = 'https://dvcap.vercel.app/api/flex-sync?uw=hist'

# ── loading ───────────────────────────────────────────────────────────────────────────────────────
def yahoo_daily(path):
    j = json.load(open(path))['chart']['result'][0]
    q = j['indicators']['quote'][0]
    idx = [dt.datetime.fromtimestamp(t, NY).date().isoformat() for t in j['timestamp']]
    return pd.DataFrame({'open': q['open'], 'close': q['close']}, index=idx).dropna()

def load_bars(D, t):
    days = {}
    for f in sorted(os.listdir(f'{D}/bars')):
        if not f.startswith(t + '_'): continue
        rows = json.load(open(f'{D}/bars/{f}'))
        if len(rows) < 300: continue                       # half days and gaps out
        a = np.full((N_MIN, 5), np.nan)
        for s, o, h, l, c, v in rows:
            ts = dt.datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(NY)
            m = (ts.hour * 60 + ts.minute) - 570
            if 0 <= m < N_MIN: a[m] = (o, h, l, c, v)
        df = pd.DataFrame(a, columns=list('ohlcv')).ffill().bfill()
        df['v'] = df['v'].fillna(0)
        days[f[len(t) + 1:-5]] = df.to_numpy()
    return days

def cushion_series(D):
    g = pd.read_csv(f'{D}/daily/dix.csv', parse_dates=['date']).set_index('date')['gex']
    pct = g.rolling(253).apply(lambda w: (w[:-1] < w[-1]).mean(), raw=True)
    return pd.DataFrame({'gex': g, 'pct': pct}).set_index(g.index.strftime('%Y-%m-%d'))

def band_of(pct, gex):
    if gex is not None and gex < 0: return CUSHION[0]
    if pct is None or np.isnan(pct): return None
    return next((b for b in CUSHION[1:] if b[1] <= pct < b[2]), None)

def zone_of(med):
    return None if med is None else 'trade' if med >= 1.0 else 'selective' if med >= 0.9 else 'lean skip'

# ── signals ───────────────────────────────────────────────────────────────────────────────────────
def day_features(days, lookback):
    """sigma[m] per day from the previous `lookback` sessions (none of today)."""
    keys = sorted(days)
    moves = {k: np.abs(days[k][:, 3] / days[k][0, 0] - 1) for k in keys}
    out = {}
    for i, k in enumerate(keys):
        if i < lookback: continue
        out[k] = np.mean([moves[x] for x in keys[i - lookback:i]], axis=0)
    return out

def vwap(a):
    tp = (a[:, 1] + a[:, 2] + a[:, 3]) / 3
    v = np.where(a[:, 4] > 0, a[:, 4], 1.0)
    return np.cumsum(tp * v) / np.cumsum(v)

def reel_trade(a, sig, room=0.0, mult=1.25, trail_x=None, trail_half=False):
    o = a[0, 0]
    orh, orl = a[:OR_END, 1].max(), a[:OR_END, 2].min()
    up, lo, vw = o * (1 + mult * sig), o * (1 - mult * sig), vwap(a)
    for m in REEL_CHECKS:
        c = a[m, 3]
        d = -1 if (c < orl * (1 - room) and c < lo[m] and c < vw[m]) else 1 if (c > orh * (1 + room) and c > up[m] and c > vw[m]) else 0
        if not d: continue
        entry, exit_i = c, EXIT_IDX
        x = trail_x if not trail_half else 0.5 * mult * sig[m]
        if x is not None:
            best = 0.0
            for j in range(m + 1, EXIT_IDX + 1):
                fav = d * (a[j, 3] / entry - 1)
                best = max(best, fav)
                if best >= x and fav <= 0.5 * best: exit_i = j; break
        return dict(m=m, d=d, entry=entry, exit=a[exit_i, 3], exit_i=exit_i, ret=d * (a[exit_i, 3] / entry - 1), half=mult * sig[m])
    return None

def paper_trades(a, sig, prev_close):
    o = a[0, 0]
    up, lo, vw = max(o, prev_close) * (1 + sig), min(o, prev_close) * (1 - sig), vwap(a)
    pos, entry, out = 0, None, []
    for m in PAPER_CHECKS:
        c = a[m, 3]
        if pos == 1 and c < max(up[m], vw[m]): out.append(c / entry - 1); pos = 0
        elif pos == -1 and c > min(lo[m], vw[m]): out.append(1 - c / entry); pos = 0
        if pos == 0:
            if c > up[m]: pos, entry = 1, c
            elif c < lo[m]: pos, entry = -1, c
    if pos: c = a[-1, 3]; out.append(pos * (c / entry - 1))
    return out

# ── options ───────────────────────────────────────────────────────────────────────────────────────
def norm_cdf(x): return 0.5 * (1 + math.erf(x / math.sqrt(2)))
def bs(S, K, T, vol, call, r=0.045):
    if T <= 0: return max(0.0, (S - K) if call else (K - S))
    d1 = (math.log(S / K) + (r + vol * vol / 2) * T) / (vol * math.sqrt(T)); d2 = d1 - vol * math.sqrt(T)
    return S * norm_cdf(d1) - K * math.exp(-r * T) * norm_cdf(d2) if call else K * math.exp(-r * T) * norm_cdf(-d2) - S * norm_cdf(-d1)

def expiry_for(day, kind, trading_days):
    i = trading_days.index(day)
    if kind == '0dte': return day
    if kind == 'next': return trading_days[i + 1] if i + 1 < len(trading_days) else None
    target = (dt.date.fromisoformat(day) + dt.timedelta(days=7)).isoformat()
    return next((d for d in trading_days[i:] if d >= target), None)

def osi(t, exp, call, K):
    return f"{t}{exp[2:4]}{exp[5:7]}{exp[8:10]}{'C' if call else 'P'}{int(round(K * 1000)):08d}"

def minute_key(iso):
    ts = dt.datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(NY)
    return ts.hour * 60 + ts.minute - 570

def side_px(r, side):
    v = float(r.get(f'volume_{side}_side') or 0)
    return float(r[f'premium_{side}_side']) / 100 / v if v > 0 else None

def option_real(rows, m_sig, stops):
    """Real-trade option result: buy ask-side after the signal, sell bid-side at 15:45. → {stop: ret}"""
    by = {}
    for r in rows or []:
        k = minute_key(r['start_time'])
        if 0 <= k < N_MIN: by[k] = r
    entry = next((side_px(by[k], 'ask') for k in range(m_sig + 1, m_sig + 6) if k in by and side_px(by[k], 'ask')), None)
    exitp = next((side_px(by[k], 'bid') for k in range(EXIT_IDX, EXIT_IDX - 10, -1) if k in by and side_px(by[k], 'bid')), None)
    if entry is None or exitp is None or entry <= 0: return None
    out = {}
    for s in stops:
        px = exitp
        if s is not None:
            for k in range(m_sig + 2, EXIT_IDX + 1):
                if k not in by: continue
                b = side_px(by[k], 'bid') or float(by[k]['low'])
                if b <= entry * (1 - s): px = b; break
        out[s] = (px * 100 - entry * 100 - 1.30) / (entry * 100)
    return out

def option_proxy(a, tr, day, exp, vol, call, K, stops):
    """Black-Scholes PROXY path on the underlying's minute closes. Spread modelled as ±(1.5% + $0.005)."""
    def T(m):
        d = (dt.date.fromisoformat(exp) - dt.date.fromisoformat(day)).days
        return max(0.0, (d * 1440 + (390 - m)) / (365 * 1440))
    mid0 = bs(tr['entry'], K, T(tr['m']), vol, call)
    if mid0 < 0.05: return None
    entry = mid0 * 1.015 + 0.005
    out = {}
    for s in stops:
        px = None
        if s is not None:
            for k in range(tr['m'] + 1, tr['exit_i'] + 1):
                b = bs(a[k, 3], K, T(k), vol, call) * 0.985 - 0.005
                if b <= entry * (1 - s): px = b; break
        if px is None: px = bs(a[tr['exit_i'], 3], K, T(tr['exit_i']), vol, call) * 0.985 - 0.005
        out[s] = (max(px, 0) * 100 - entry * 100 - 1.30) / (entry * 100)
    return out

# ── stats ─────────────────────────────────────────────────────────────────────────────────────────
def tstat(x): x = np.asarray(x); return x.mean() / (x.std(ddof=1) / math.sqrt(len(x))) if len(x) > 2 and x.std() > 0 else float('nan')
def best_share(x, n):
    x = np.asarray(x); tot = x.sum()
    return np.sort(x)[-n:].sum() / tot if tot > 0 else float('nan')
def max_dd(curve):
    peak = np.maximum.accumulate(curve); return float(((curve - peak) / peak).min())
def longest_run(flags):
    best = cur = 0
    for f in flags: cur = cur + 1 if f else 0; best = max(best, cur)
    return best
def kelly(r):
    r = np.asarray(r); fs = np.linspace(0, 1, 201)
    g = [np.mean(np.log(np.maximum(1 + f * r, 1e-9))) for f in fs]
    return float(fs[int(np.argmax(g))])

def pct(x, dp=2): return '—' if x is None or (isinstance(x, float) and math.isnan(x)) else f'{x * 100:.{dp}f}%'

def summary_row(name, rets):
    r = np.asarray(rets)
    if len(r) == 0: return f'| {name} | 0 | — | — | — | — | — | — |'
    curve = np.cumprod(1 + r * 0.0 + r)   # compounding the underlying return, 1x
    return (f'| {name} | {len(r)} | {pct((r > 0).mean(), 0)} | {pct(r.mean())} | {pct(np.median(r))} | {tstat(r):.1f} | '
            f'{pct(best_share(r, 5), 0)} | {pct(max_dd(np.cumprod(1 + r)), 1)} |')

# ── main ──────────────────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(); ap.add_argument('D'); ap.add_argument('--out', required=True); ap.add_argument('--fetch-options', action='store_true')
    A = ap.parse_args(); D = A.D
    vix = {'SPY': yahoo_daily(f'{D}/daily/%5EVIX.json')['close'], 'QQQ': yahoo_daily(f'{D}/daily/%5EVXN.json')['close']}
    cush = cushion_series(D)
    L = []
    w = L.append
    trades_all = {}
    for t in TICKERS:
        days = load_bars(D, t); keys = sorted(days)
        sig20, sig14 = day_features(days, 20), day_features(days, 14)
        prev_close = {keys[i]: days[keys[i - 1]][-1, 3] for i in range(1, len(keys))}
        base = []
        for k in keys:
            if k not in sig20: continue
            tr = reel_trade(days[k], sig20[k])
            if tr: tr['day'] = k; base.append(tr)
        trades_all[t] = (days, keys, base, sig20, sig14, prev_close)
    # ---- report header
    first = min(min(v[1]) for v in trades_all.values()); last = max(max(v[1]) for v in trades_all.values())
    w(f'# Noise-band intraday momentum — SPY and QQQ ({first} → {last})\n')
    w('Data: Unusual Whales 1-minute bars (history starts 11 Jul 2022) and option minute trades (from Apr 2025), via dvcap. '
      'Personal-use licence: this report stays out of the repo.\n')
    # ---- underlying, by variant
    for t in TICKERS:
        days, keys, base, sig20, sig14, pc = trades_all[t]
        w(f'\n## {t} — underlying, per trade (no leverage)\n')
        w('| Variant | Trades | Hit | Mean | Median | t | Best-5 share | Max DD |'); w('|---|---|---|---|---|---|---|---|')
        for room in (0, 0.0005, 0.001):
            r = [x['ret'] for k in keys if k in sig20 for x in [reel_trade(days[k], sig20[k], room=room)] if x]
            w(summary_row(f'Reel, room {room * 100:.2f}%, hold to 15:45', r))
        for X, lab in ((0.005, '0.5%'), (0.01, '1.0%'), (0.015, '1.5%')):
            r = [x['ret'] for k in keys if k in sig20 for x in [reel_trade(days[k], sig20[k], trail_x=X)] if x]
            w(summary_row(f'Reel, trail after {lab}', r))
        r = [x['ret'] for k in keys if k in sig20 for x in [reel_trade(days[k], sig20[k], trail_half=True)] if x]
        w(summary_row('Reel, trail after ½ band', r))
        pr = [y for k in keys if k in sig14 and k in pc for y in paper_trades(days[k], sig14[k], pc[k])]
        w(summary_row('Paper (ZAB 2024), all trades', pr))
        b = base
        w(f'\nShorts {sum(x["d"] < 0 for x in b)}: mean {pct(np.mean([x["ret"] for x in b if x["d"] < 0]))} (t {tstat([x["ret"] for x in b if x["d"] < 0]):.1f}) · '
          f'Longs {sum(x["d"] > 0 for x in b)}: mean {pct(np.mean([x["ret"] for x in b if x["d"] > 0]))} (t {tstat([x["ret"] for x in b if x["d"] > 0]):.1f}) · fired on {len(b)} of {len([k for k in keys if k in sig20])} days\n')
        # sensitivity
        w('\nSensitivity (reel, hold to 15:45; mean per trade · trades):\n')
        w('| Band × | 14-session σ | 20-session σ |'); w('|---|---|---|')
        for mult in (1.0, 1.25, 1.5):
            cells = []
            for S in (sig14, sig20):
                r = [x['ret'] for k in keys if k in S for x in [reel_trade(days[k], S[k], mult=mult)] if x]
                cells.append(f'{pct(np.mean(r)) if r else "—"} · {len(r)}')
            w(f'| {mult} | {cells[0]} | {cells[1]} |')
        # by year / entry time / regime
        df = pd.DataFrame([dict(day=x['day'], ret=x['ret'], d=x['d'], m=x['m']) for x in b])
        df['year'] = df.day.str[:4]
        w('\nBy year: ' + ' · '.join(f'{y} {pct(g.ret.mean())} (n {len(g)}, hit {pct((g.ret > 0).mean(), 0)})' for y, g in df.groupby('year')))
        df['slot'] = np.where(df.m <= 89, '10:00–11:00', 'after 11:00')
        w('\nBy entry time: ' + ' · '.join(f'{s} {pct(g.ret.mean())} (n {len(g)})' for s, g in df.groupby('slot')))
        vv = vix[t].shift(1)
        df['vol'] = [vv.get(d, np.nan) for d in df.day]
        df['vbucket'] = pd.cut(df.vol, [0, 15, 20, 25, 30, 99], labels=['<15', '15–20', '20–25', '25–30', '≥30'])
        w('\nBy prior-close ' + ('VIX' if t == 'SPY' else 'VXN') + ': ' + ' · '.join(f'{s} {pct(g.ret.mean())} (n {len(g)})' for s, g in df.groupby('vbucket', observed=True)))
        bands, zones = [], []
        prev = {d: p for d, p in zip(cush.index[1:], cush.index[:-1])}
        for d in df.day:
            p = prev.get(d)
            row = cush.loc[p] if p in cush.index else None
            bd = band_of(None if row is None else row.pct, None if row is None else row.gex)
            bands.append(bd[0] if bd else None); zones.append(zone_of(bd[4] if t == 'QQQ' else bd[3]) if bd else None)
        df['band'], df['zone'] = bands, zones
        w('\nBy gamma cushion band: ' + ' · '.join(f'{s} {pct(g.ret.mean())} (n {len(g)})' for s, g in df.groupby('band')))
        # zone: fire rate and result
        all_days = [k for k in keys if k in sig20]
        zr = []
        for d in all_days:
            p = prev.get(d); row = cush.loc[p] if p in cush.index else None
            bd = band_of(None if row is None else row.pct, None if row is None else row.gex)
            zr.append(zone_of(bd[4] if t == 'QQQ' else bd[3]) if bd else None)
        zdf = pd.DataFrame({'day': all_days, 'zone': zr}); zdf['fired'] = zdf.day.isin(set(df.day))
        w('\nBy trade-day zone (fire rate · mean per trade): ' + ' · '.join(
            f'{z} {pct(g.fired.mean(), 0)} · {pct(df[df.zone == z].ret.mean())} (n {int(g.fired.sum())})' for z, g in zdf.groupby('zone')))
        # concentration
        r = df.ret.to_numpy()
        top5 = df.sort_values('ret').day.tail(5)
        w(f'\nConcentration: best 5 trades {pct(best_share(r, 5), 0)} of profit, best 10 {pct(best_share(r, 10), 0)}; '
          f'without the 5 best days: mean {pct(df[~df.day.isin(top5)].ret.mean())}, total {pct(df[~df.day.isin(top5)].ret.sum(), 1)} vs {pct(r.sum(), 1)}\n')
    # overlap
    sb = {x['day']: x['d'] for x in trades_all['SPY'][2]}; qb = {x['day']: x['d'] for x in trades_all['QQQ'][2]}
    both = set(sb) & set(qb)
    w(f'\n## Overlap\nBoth fired on {len(both)} days ({pct(len(both) / max(1, len(set(sb) | set(qb))), 0)} of days with any trade); '
      f'same direction on {sum(sb[d] == qb[d] for d in both)} of them.\n')
    # ---- options
    stops = (None, 0.5, 0.3)
    opt_rows = []
    need = []
    for t in TICKERS:
        days, keys, base, *_ = trades_all[t]
        for tr in base:
            call = tr['d'] > 0
            for kind in ('0dte', 'next', 'week'):
                exp = expiry_for(tr['day'], kind, keys)
                if not exp: continue
                for shift, lab in ((0, 'ATM'), (-1 if call else 1, 'ITM'), (1 if call else -1, 'OTM')):
                    if lab != 'ATM' and kind != 'next': continue
                    K = round(tr['entry']) + shift
                    sym = osi(t, exp, call, K)
                    vol = vix[t].shift(1).get(tr['day'], np.nan) / 100
                    prox = option_proxy(days[tr['day']], tr, tr['day'], exp, vol, call, K, stops) if vol == vol else None
                    real = None
                    f = f'{D}/opt/{sym}_{tr["day"]}.json'
                    if tr['day'] >= '2025-04-01':
                        if os.path.exists(f): real = option_real(json.load(open(f)), tr['m'], stops)
                        else: need.append((sym, tr['day']))
                    opt_rows.append(dict(t=t, day=tr['day'], kind=kind, strike=lab, d=tr['d'], prox=prox, real=real))
    if A.fetch_options and need:
        def get(job):
            sym, day = job
            try:
                with urllib.request.urlopen(f'{DOOR}&kind=option&contract={sym}&date={day}', timeout=60) as r: j = json.load(r)
                rows = j.get('data'); rows = rows.get('data') if isinstance(rows, dict) else rows
                if j.get('ok'): json.dump(rows or [], open(f'{D}/opt/{sym}_{day}.json', 'w')); return 1
            except Exception: pass
            return 0
        os.makedirs(f'{D}/opt', exist_ok=True)
        with cf.ThreadPoolExecutor(4) as ex: got = sum(ex.map(get, need))
        print(f'fetched {got} of {len(need)} option-days; run again without --fetch-options for the report'); return
    if need: print(f'{len(need)} option-days not cached (run with --fetch-options)')
    O = pd.DataFrame(opt_rows)
    w('\n## Options — all or nothing vs stops\n')
    w('Real = UW option trades (ask-side buys, bid-side sells, $0.65/contract), Apr 2025 →. PROXY = Black-Scholes from prior-close VIX/VXN with a modelled spread — not real P&L.\n')
    w('| Ticker | Structure | Source | Trades | Hit | Mean | Median | Best-5 share | Mean −50% stop | Mean −30% stop |'); w('|---|---|---|---|---|---|---|---|---|---|')
    for t in TICKERS:
        for kind in ('0dte', 'next', 'week'):
            for lab in ('ATM', 'ITM', 'OTM'):
                sub = O[(O.t == t) & (O.kind == kind) & (O.strike == lab)]
                if sub.empty: continue
                for src in ('real', 'prox'):
                    vals = [x for x in sub[src] if x]
                    if not vals: continue
                    r0 = np.array([v[None] for v in vals]); r5 = np.array([v[0.5] for v in vals]); r3 = np.array([v[0.3] for v in vals])
                    w(f'| {t} | {kind} {lab} | {"real" if src == "real" else "PROXY"} | {len(r0)} | {pct((r0 > 0).mean(), 0)} | {pct(r0.mean(), 1)} | {pct(np.median(r0), 1)} | '
                      f'{pct(best_share(r0, 5), 0)} | {pct(r5.mean(), 1)} | {pct(r3.mean(), 1)} |')
    # ---- the proxy against real trades on the SAME days (how far the model flatters)
    w('\n## Proxy vs real, same days (Apr 2025 →, hold to 15:45)\n')
    w('| Ticker | Structure | Days | Real mean | Real median | PROXY mean | PROXY median | Real mean without best 5 |'); w('|---|---|---|---|---|---|---|---|')
    for t in TICKERS:
        for kind in ('0dte', 'next', 'week'):
            sub = O[(O.t == t) & (O.kind == kind) & (O.strike == 'ATM')]
            pairs = [(r[None], p[None]) for r, p in zip(sub.real, sub.prox) if r and p]
            if len(pairs) < 10: continue
            R, P = np.array([a for a, _ in pairs]), np.array([b for _, b in pairs])
            w(f'| {t} | {kind} ATM | {len(R)} | {pct(R.mean(), 1)} | {pct(np.median(R), 1)} | {pct(P.mean(), 1)} | {pct(np.median(P), 1)} | {pct(np.sort(R)[:-5].mean(), 1)} |')
    # ---- sizing on the reel's own structure (next expiry, ATM, hold) — real where it exists, proxy for the long view
    w('\n## Sizing — next-expiry ATM, all or nothing (hold to 15:45)\n')
    for src in ('real', 'prox'):
        for t in TICKERS:
            sub = O[(O.t == t) & (O.kind == 'next') & (O.strike == 'ATM')].dropna(subset=[src]).sort_values('day')
            vals = [(d, v[None]) for d, v in zip(sub.day, sub[src]) if v]
            if len(vals) < 10: continue
            ds, r = [d for d, _ in vals], np.array([x for _, x in vals])
            k = kelly(r)
            rng = np.random.default_rng(7); boots = [kelly(rng.choice(r, len(r))) for _ in range(300)]
            w(f'\n**{t}, {"real trades" if src == "real" else "PROXY"}** ({ds[0]} → {ds[-1]}, {len(r)} trades) — Kelly {pct(k, 0)}, half-Kelly {pct(k / 2, 0)}; '
              f'bootstrap 10th–90th: {pct(np.percentile(boots, 10), 0)}–{pct(np.percentile(boots, 90), 0)} (the estimate moves this much)\n')
            w('| Sizing | End equity (from $100k) | Max DD | Longest losing streak (trades) | Longest drawdown (trading days) | Worst month |'); w('|---|---|---|---|---|---|')
            for lab, fn in [(f'${p:,} premium', (lambda p: (lambda eq, x: eq + p * x))(p)) for p in (500, 1000, 2000)] + \
                           [(f'{f * 100:.0f}% of equity', (lambda f: (lambda eq, x: eq * (1 + f * x)))(f)) for f in (0.01, 0.02, 0.05)]:
                eq = [100000.0]
                for x in r: eq.append(fn(eq[-1], x))
                eq = np.array(eq)
                peak = np.maximum.accumulate(eq)
                underwater = [e < p for e, p in zip(eq[1:], peak[1:])]
                ser = pd.Series(np.diff(eq), index=pd.to_datetime(ds)).groupby(pd.Grouper(freq='ME')).sum()
                w(f'| {lab} | ${eq[-1]:,.0f} | {pct(max_dd(eq), 1)} | {longest_run(r < 0)} | {longest_run(underwater)} | ${ser.min():,.0f} ({ser.idxmin():%b %Y}) |')
    open(A.out, 'w').write('\n'.join(L) + '\n')
    print(f'report written: {A.out} ({len(L)} lines)')

if __name__ == '__main__':
    main()
