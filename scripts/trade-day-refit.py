#!/usr/bin/env python3
# scripts/trade-day-refit.py — the trade-day call's three models, fitted and checked out of sample, and the
# quarterly walk-forward refit that PROPOSES new coefficients and never applies them (20 Oct 2026).
#
# THE THREE MODELS (pre-open inputs only, the same ones scripts/trade-day-v2-calibrate.py uses):
#   R model      log R = const + cush·cushion + gap·|gap|/implied + prevR·prior-day R + ivchg·overnight IV
#                change; OLS, residual σ, so median R = exp(log R̂) and P(R ≥ 1) = Φ(log R̂ ÷ σ).
#                QQQ on QQQ bars and VXN; SPY on the S&P index (^GSPC) bars and VIX, as before.
#   P(trend)     logistic on the same inputs plus the negative-GEX band (neg = 1 when
#                SqueezeMetrics GEX at the prior close is below zero). Trend day = the session's close
#                in the top or bottom 20% of its own high–low range (spec A.2). QQQ on QQQ bars and VXN;
#                SPY on SPY's own bars and VIX (the close location is the ETF's, so it is read from the ETF).
#                NOT the Gamma tab's trend day (lib/trendTells.js: ≥0.6 ATR open→close keeping ≥60% of the
#                range, base ≈24%): this one is a close-location day, base ≈49%.
#   band rates   the share of trend days per cushion band (negative GEX its own band, lib/trendTells.js
#                CUSHION) — what the board shows when the logistic has no out-of-sample skill.
#
# Definitions as scripts/trade-day-v2-calibrate.py: implied = prior close VXN / VIX ÷ 100 ÷ √252;
# R = (high − low) ÷ open ÷ implied; cushion = SqueezeMetrics GEX at the prior close, percentile vs the 252
# rows before it. Market data only; nothing here reads an account.
#
# OUT OF SAMPLE. P(trend) is scored walk-forward: each calendar year from 2016 is predicted by a fit on
# every session from 2012 to the end of the year before. The yardstick is the base rate known at the time
# (the share of trend days before that year), and the cushion band's own rate known at the time. SKILL =
# the Brier skill score over the base rate is positive AND its 90% block-bootstrap interval (20-session
# blocks) is above zero. No skill → the board shows the band's base rate and says so (lib/tradeDayModel.json
# trend.<T>.skill = false).
#
# MODES
#   python3 -I scripts/trade-day-refit.py $D                 calibrate: print the fits and the trend verdict
#   python3 -I scripts/trade-day-refit.py $D --refit [--cutoff YYYY-MM-DD] [--out docs/trade-day-refit]
#       THE QUARTERLY REFIT (.github/workflows/trade-day-refit.yml). Cutoff = the last quarter-end before
#       today. Current = lib/tradeDayModel.json. The evaluation window is the four quarters to the cutoff:
#       the current coefficients and a candidate fitted on 2012 → the window's start are both scored on it
#       (both out of sample). The PROPOSAL is the fit on 2012 → the cutoff. Writes <out>/proposed.json,
#       <out>/report.md and <out>/status.json ({changed, reasons}); never touches lib/.
#
# CHANGE THRESHOLD (a proposal is opened only past one of these; THRESHOLDS below):
#   R model, either ticker, on the evaluation window: |Δ Brier of P(R ≥ 1)| ≥ 0.005, or |Δ Spearman| ≥ 0.03,
#   or the proposed and current calls give a different zone on ≥ 15% of the window's sessions;
#   P(trend): the skill verdict flips, or |Δ Brier skill score| ≥ 0.01.
#
# Inputs, one directory $D (the same curl lines as scripts/trade-day-checkpoint-backtest.py, plus SPY daily):
#   curl -sS https://squeezemetrics.com/monitor/static/DIX.csv -o $D/dix.csv
#   curl -sSL https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv -o $D/VIX.csv
#   curl -sSL https://cdn.cboe.com/api/global/us_indices/daily_prices/VXN_History.csv -o $D/VXN.csv
#   for s in QQQ SPY %5EGSPC; do curl -sS -A Mozilla/5.0 \
#     "https://query2.finance.yahoo.com/v8/finance/chart/$s?interval=1d&period1=1293840000&period2=$(date +%s)" -o "$D/d_$s.json"; done
import json, sys, os, math, datetime as dt
import numpy as np, pandas as pd

THRESHOLDS = dict(brier_r=0.005, spearman=0.03, zone_share=0.15, bss_trend=0.01)
X_R = ['cush', 'gap', 'prevR', 'ivchg']
X_T = ['cush', 'neg', 'gap', 'prevR', 'ivchg']
BANDS = [('neg', None, None), ('p0', 0, 20), ('p20', 20, 40), ('p40', 40, 60), ('p60', 60, 80), ('p80', 80, 101)]
START = '2012-01-01'
Phi = np.vectorize(lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2))))

def yahoo_daily(f):
    r = json.load(open(f))['chart']['result'][0]; q = r['indicators']['quote'][0]
    return pd.DataFrame({'o': q['open'], 'h': q['high'], 'l': q['low'], 'c': q['close']},
                        index=pd.to_datetime(r['timestamp'], unit='s').normalize()).dropna()

def cboe(f):
    d = pd.read_csv(f); d.index = pd.to_datetime(d.DATE)
    return d[['OPEN', 'CLOSE']].rename(columns={'OPEN': 'ivo', 'CLOSE': 'iv'})

def panels(D):
    dix = pd.read_csv(f'{D}/dix.csv', parse_dates=['date']).set_index('date')
    dix['pct'] = dix.gex.rolling(253).apply(lambda x: (x[:-1] < x[-1]).mean(), raw=True)
    out = {}
    for name, px, iv in [('QQQ', 'd_QQQ.json', 'VXN.csv'), ('SPX', 'd_%5EGSPC.json', 'VIX.csv'), ('SPY', 'd_SPY.json', 'VIX.csv')]:
        p = yahoo_daily(f'{D}/{px}').join(cboe(f'{D}/{iv}'), how='inner')
        p['pc'] = p.c.shift(1); p['ivp'] = p.iv.shift(1)
        p['imp'] = p.ivp / 100 / np.sqrt(252)
        p['R'] = (p.h - p.l) / p.o / p.imp
        p['gap'] = (p.o / p.pc - 1).abs() / p.imp
        p['prevR'] = p.R.shift(1)
        p['ivchg'] = p.ivo / p.ivp - 1
        p['cush'] = dix.pct.shift(1).reindex(p.index) * 100
        p['gex'] = dix.gex.shift(1).reindex(p.index)
        p['neg'] = (p.gex < 0).astype(float)
        loc = (p.c - p.l) / (p.h - p.l)
        p['T'] = ((loc >= 0.8) | (loc <= 0.2)).astype(float)
        p = p[(p.h > p.l)].dropna(subset=X_T + ['R', 'gex'])
        out[name] = p[p.index >= START]
    return out

def band_of(df):
    b = pd.Series(index=df.index, dtype=object)
    b[df.neg == 1] = 'neg'
    for k, lo, hi in BANDS[1:]:
        b[(df.neg == 0) & (df.cush >= lo) & (df.cush < hi)] = k
    return b

# ── fits ──
def fit_r(df):
    A = np.c_[np.ones(len(df)), df[X_R]]
    b = np.linalg.lstsq(A, np.log(df.R), rcond=None)[0]
    sigma = float(np.std(np.log(df.R) - A @ b, ddof=len(b)))
    return dict(const=round(float(b[0]), 4), cush=round(float(b[1]), 5), gap=round(float(b[2]), 4), prevR=round(float(b[3]), 4), ivchg=round(float(b[4]), 4), sigma=round(sigma, 3))

def lp_r(c, df):
    return c['const'] + c['cush'] * df.cush.values + c['gap'] * df.gap.values + c['prevR'] * df.prevR.values + c['ivchg'] * df.ivchg.values

def fit_logit(df, it=60, l2=1e-6):
    A = np.c_[np.ones(len(df)), df[X_T]]; y = df['T'].values; b = np.zeros(A.shape[1])
    for _ in range(it):
        p = 1 / (1 + np.exp(-A @ b)); W = p * (1 - p)
        step = np.linalg.solve(A.T @ (A * W[:, None]) + l2 * np.eye(len(b)), A.T @ (y - p) - l2 * b)
        b = b + step
        if np.abs(step).max() < 1e-10: break
    return dict(zip(['const'] + X_T, [round(float(v), 5) for v in b]))

def p_trend(c, df):
    z = c['const'] + sum(c[k] * df[k].values for k in X_T)
    return 1 / (1 + np.exp(-z))

def zone(med):
    return np.where(med >= 1.0, 'trade', np.where(med >= 0.9, 'selective', 'lean skip'))

def spearman(a, b):
    return float(pd.Series(a).corr(pd.Series(b), method='spearman'))

def auc(p, y):
    r = pd.Series(p).rank().values; n1 = y.sum(); n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)) if n1 and n0 else None

def quintiles(p, y):
    q = pd.qcut(p, 5, labels=False, duplicates='drop')
    return [[round(float(p[q == k].mean()), 3), round(float(y[q == k].mean()), 3), int((q == k).sum())] for k in sorted(set(q))]

def block_boot_bss(loss_m, loss_b, block=20, n=2000, seed=0):
    rng = np.random.default_rng(seed); L = len(loss_m); k = int(np.ceil(L / block)); out = []
    for _ in range(n):
        starts = rng.integers(0, L - block + 1, k)
        idx = np.concatenate([np.arange(s, s + block) for s in starts])[:L]
        out.append(1 - loss_m[idx].mean() / loss_b[idx].mean())
    return float(np.percentile(out, 5)), float(np.percentile(out, 95))

# ── P(trend), walk-forward ──
def trend_walk_forward(df, first_year=2016, last=None):
    df = df if last is None else df[df.index <= last]
    recs = []
    for y in range(first_year, df.index[-1].year + 1):
        tr = df[df.index < f'{y}-01-01']; te = df[(df.index >= f'{y}-01-01') & (df.index < f'{y + 1}-01-01')]
        if len(te) == 0 or len(tr) < 500: continue
        c = fit_logit(tr); bands_tr = band_of(tr); rates = tr.groupby(bands_tr)['T'].mean()
        recs.append(pd.DataFrame({'y': te['T'].values, 'p': p_trend(c, te), 'base': tr['T'].mean(),
                                  'band': band_of(te).map(rates).fillna(tr['T'].mean()).values}, index=te.index))
    w = pd.concat(recs)
    y = w.y.values
    lm, lb, lband = (w.p.values - y) ** 2, (w.base.values - y) ** 2, (w.band.values - y) ** 2
    bss = 1 - lm.mean() / lb.mean(); lo, hi = block_boot_bss(lm, lb)
    bss_band = 1 - lband.mean() / lb.mean(); blo, bhi = block_boot_bss(lband, lb)
    return dict(span=f'{w.index[0].date()} → {w.index[-1].date()}', n=int(len(w)), base_rate=round(float(y.mean()), 3),
                brier_model=round(float(lm.mean()), 4), brier_base=round(float(lb.mean()), 4), brier_band=round(float(lband.mean()), 4),
                bss=round(float(bss), 4), bss_90=[round(lo, 4), round(hi, 4)], bss_band=round(float(bss_band), 4), bss_band_90=[round(blo, 4), round(bhi, 4)],
                auc=round(auc(w.p.values, y), 3), calibration=quintiles(w.p.values, y), calibration_band=quintiles(w.band.values, y),
                skill=bool(bss > 0 and lo > 0))

def band_rates(df):
    b = band_of(df)
    return {k: [round(float(df[b == k]['T'].mean()) * 100, 1), int((b == k).sum())] for k, *_ in BANDS}

def trend_block(df, last=None):
    d = df if last is None else df[df.index <= last]
    return dict(coef=fit_logit(d), base_pct=round(float(d['T'].mean()) * 100, 1), bands=band_rates(d),
                span=f'{d.index[0].date()} → {d.index[-1].date()}', n=int(len(d)), oos=trend_walk_forward(df, last=last))

# ── R model metrics on a window ──
def r_metrics(c, df):
    lp = lp_r(c, df); p1 = Phi(lp / c['sigma']); y = (df.R.values >= 1).astype(float)
    return dict(n=int(len(df)), spearman=round(spearman(np.exp(lp), df.R.values), 3), brier=round(float(np.mean((p1 - y) ** 2)), 4),
                calibration=quintiles(p1, y)), zone(np.exp(lp))

def last_quarter_end(today):
    q_end_month = ((today.month - 1) // 3) * 3
    if q_end_month == 0: return dt.date(today.year - 1, 12, 31)
    nxt = dt.date(today.year, q_end_month + 1, 1)
    return nxt - dt.timedelta(days=1)

def main():
    args = sys.argv[1:]
    D = args[0]
    P = panels(D)
    opt = lambda k, d=None: args[args.index(k) + 1] if k in args else d
    if '--refit' not in args:
        print('P(TREND) — close in the top or bottom 20% of the day\'s range; inputs cushion, negative-GEX band, gap σ, prior R, IV change')
        out = {}
        for t, name in [('QQQ', 'QQQ'), ('SPY', 'SPY')]:
            b = trend_block(P[name]); out[t] = b
            o = b['oos']
            print(f'\n{t}: fit {b["span"]} n {b["n"]}, base {b["base_pct"]}%; coef {b["coef"]}')
            print(f'  bands (trend %, n): {b["bands"]}')
            print(f'  walk-forward OOS {o["span"]} n {o["n"]}: Brier model {o["brier_model"]} vs base {o["brier_base"]} vs band {o["brier_band"]}; '
                  f'BSS {o["bss"]:+.4f} [90% {o["bss_90"][0]:+.4f}, {o["bss_90"][1]:+.4f}]; band BSS {o["bss_band"]:+.4f} [{o["bss_band_90"][0]:+.4f}, {o["bss_band_90"][1]:+.4f}]; AUC {o["auc"]}')
            print(f'  calibration by predicted quintile (pred, actual, n): model {o["calibration"]}')
            print(f'                                                     band  {o["calibration_band"]}')
            print(f'  SKILL: {o["skill"]}')
        for t, name in [('QQQ', 'QQQ'), ('SPY', 'SPX')]:
            df = P[name]; tr, te = df[df.index < '2021-01-01'], df[df.index >= '2021-01-01']
            c = fit_r(tr); m, _ = r_metrics(c, te)
            print(f'\nR model {t} ({name}) fit 2012–2020 {c}; scored 2021→: {m}')
        print('\nJSON\n' + json.dumps(out))
        return

    today = dt.date.fromisoformat(opt('--today', dt.date.today().isoformat()))
    cutoff = pd.Timestamp(opt('--cutoff', last_quarter_end(today).isoformat()))
    win_start = cutoff - pd.DateOffset(years=1) + pd.Timedelta(days=1)
    outdir = opt('--out', 'docs/trade-day-refit')
    cur = json.load(open(opt('--current', 'lib/tradeDayModel.json')))
    os.makedirs(outdir, exist_ok=True)
    reasons, rep, prop = [], [], {'cutoff': str(cutoff.date()), 'fit': f'{START[:4]} → {cutoff.date()}', 'r': {}, 'trend': {}}
    rep.append(f'# Trade-day refit proposal: data to {cutoff.date()}\n')
    rep.append(f'Generated by `scripts/trade-day-refit.py --refit`. Evaluation window {win_start.date()} → {cutoff.date()} (the four quarters to the cutoff). '
               'Current = `lib/tradeDayModel.json`; candidate = a fit on 2012 → the window\'s start, so both are out of sample on the window; '
               f'proposed = the fit on 2012 → {cutoff.date()}. **Nothing is applied**: to adopt it, copy the numbers into `lib/tradeDayModel.json` by hand and run `npm test`.\n')
    rep.append(f'Thresholds: |Δ Brier P(R≥1)| ≥ {THRESHOLDS["brier_r"]}, |Δ Spearman| ≥ {THRESHOLDS["spearman"]}, zone differs on ≥ {THRESHOLDS["zone_share"]:.0%} of sessions; '
               f'P(trend) skill verdict flips or |Δ BSS| ≥ {THRESHOLDS["bss_trend"]}.\n')
    rep.append('## R model (median R, P(R ≥ 1))\n\n| | n | current Spearman | candidate Spearman | current Brier | candidate Brier | zone differs (proposed vs current) |\n|---|---|---|---|---|---|---|')
    for t, name in [('QQQ', 'QQQ'), ('SPY', 'SPX')]:
        df = P[name]
        win = df[(df.index >= win_start) & (df.index <= cutoff)]
        if len(win) < 100: raise SystemExit(f'{t}: only {len(win)} sessions in the evaluation window')
        c_cur = {k: cur['r'][t][k] for k in ['const', 'cush', 'gap', 'prevR', 'ivchg', 'sigma']}
        c_cand = fit_r(df[df.index < win_start])
        c_prop = fit_r(df[df.index <= cutoff])
        m_cur, z_cur = r_metrics(c_cur, win); m_cand, _ = r_metrics(c_cand, win); _, z_prop = r_metrics(c_prop, win)
        zdiff = float(np.mean(z_cur != z_prop))
        d_brier, d_sp = m_cand['brier'] - m_cur['brier'], m_cand['spearman'] - m_cur['spearman']
        if abs(d_brier) >= THRESHOLDS['brier_r']: reasons.append(f'{t} R model: Brier {m_cur["brier"]} → {m_cand["brier"]}')
        if abs(d_sp) >= THRESHOLDS['spearman']: reasons.append(f'{t} R model: Spearman {m_cur["spearman"]} → {m_cand["spearman"]}')
        if zdiff >= THRESHOLDS['zone_share']: reasons.append(f'{t} R model: zone differs on {zdiff:.0%} of sessions')
        prop['r'][t] = {**c_prop, 'iv': cur['r'][t].get('iv'), **({'model': cur['r'][t]['model']} if cur['r'][t].get('model') else {}),
                        'eval': {'current': m_cur, 'candidate': m_cand, 'zone_differs_pct': round(zdiff * 100, 1)}}
        rep.append(f'| {t} | {m_cur["n"]} | {m_cur["spearman"]} | {m_cand["spearman"]} | {m_cur["brier"]} | {m_cand["brier"]} | {zdiff:.0%} |')
    rep.append('\nProposed coefficients:\n\n```json\n' + json.dumps({t: {k: v for k, v in prop['r'][t].items() if k != 'eval'} for t in prop['r']}, indent=1) + '\n```\n')
    rep.append('## P(trend) (close in the top or bottom 20% of the range)\n\n| | walk-forward span | n | BSS vs base (90%) | band BSS (90%) | AUC | skill now | skill in current file |\n|---|---|---|---|---|---|---|---|')
    for t, name in [('QQQ', 'QQQ'), ('SPY', 'SPY')]:
        b = trend_block(P[name], last=cutoff); o = b['oos']
        was = cur['trend'][t]
        if o['skill'] != was['skill']: reasons.append(f'{t} P(trend): skill verdict {was["skill"]} → {o["skill"]}')
        if abs(o['bss'] - was['oos']['bss']) >= THRESHOLDS['bss_trend']: reasons.append(f'{t} P(trend): BSS {was["oos"]["bss"]} → {o["bss"]}')
        prop['trend'][t] = {'skill': o['skill'], 'coef': b['coef'], 'base_pct': b['base_pct'], 'bands': b['bands'], 'span': b['span'], 'n': b['n'],
                            'oos': {k: o[k] for k in ['span', 'n', 'base_rate', 'brier_model', 'brier_base', 'brier_band', 'bss', 'bss_90', 'bss_band', 'bss_band_90', 'auc', 'calibration', 'calibration_band']}}
        rep.append(f'| {t} | {o["span"]} | {o["n"]} | {o["bss"]:+.4f} [{o["bss_90"][0]:+.4f}, {o["bss_90"][1]:+.4f}] | {o["bss_band"]:+.4f} [{o["bss_band_90"][0]:+.4f}, {o["bss_band_90"][1]:+.4f}] | {o["auc"]} | {o["skill"]} | {was["skill"]} |')
    changed = bool(reasons)
    rep.append('\n## Verdict\n\n' + ('**Changed beyond the thresholds**, so a proposal is opened:\n' + '\n'.join(f'- {r}' for r in reasons) if changed else 'Within the thresholds: no proposal.') + '\n')
    rep.append('Market data only (SqueezeMetrics DIX.csv, Cboe VIX/VXN history, Yahoo daily bars).\n')
    json.dump(prop, open(f'{outdir}/proposed.json', 'w'), indent=1)
    open(f'{outdir}/report.md', 'w').write('\n'.join(rep))
    json.dump({'cutoff': str(cutoff.date()), 'changed': changed, 'reasons': reasons}, open(f'{outdir}/status.json', 'w'), indent=1)
    print(f'cutoff {cutoff.date()}: changed={changed}' + ''.join(f'\n  {r}' for r in reasons))

if __name__ == '__main__':
    main()
