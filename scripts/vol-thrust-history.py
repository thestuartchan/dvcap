#!/usr/bin/env python3
# scripts/vol-thrust-history.py — refresh data/nyse_updown_volume.json: NYSE up volume and down volume per
# session, the input of the Signal Board's 9-to-1 row (lib/volThrust.js) and of scripts/vol-thrust-backtest.py.
#
# SOURCE. TradingView's own daily series USI:UVOL ("NYSE UP VOLUME") and USI:DVOL ("NYSE DOWN VOLUME"),
# read keyless from the same websocket the public chart page uses (unauthorized token, daily bars). The
# series start 1996-04-19 (UVOL) and 1992 (DVOL); only dates both carry are kept. It is NYSE-traded volume
# in NYSE-listed issues (about 1bn shares a day in 2026), not the consolidated tape the WSJ diary shows
# (about 4bn): the up SHARE is what the row reads, and the two agree on it closely (docs/vol-thrust).
# Cross-check 1996-04 → 2020-02 against Unicorn Research's NYSE_advv / NYSE_declv files (the site stopped
# updating on 14 Feb 2020): correlation of the daily up share 0.94, mean absolute gap 1.7 points.
#
#   pip install websocket-client
#   python3 -I scripts/vol-thrust-history.py [data/nyse_updown_volume.json]
#
# Writes {source, fields, rows: [[date, up, down], …]} sorted by date. The last bar is dropped when it is
# today's (New York) and the session is still open (the bar is still forming).
import json, random, re, string, sys, datetime as dt
from zoneinfo import ZoneInfo
from websocket import create_connection

OUT = sys.argv[1] if len(sys.argv) > 1 else 'data/nyse_updown_volume.json'
NY = ZoneInfo('America/New_York')

def msg(f, p):
    s = json.dumps({'m': f, 'p': p}, separators=(',', ':'))
    return f'~m~{len(s)}~m~{s}'

def bars(symbol, n=9000):
    ws = create_connection('wss://data.tradingview.com/socket.io/websocket', header=['Origin: https://www.tradingview.com'], timeout=30)
    cs = 'cs_' + ''.join(random.choice(string.ascii_lowercase) for _ in range(12))
    ws.send(msg('set_auth_token', ['unauthorized_user_token']))
    ws.send(msg('chart_create_session', [cs, '']))
    ws.send(msg('resolve_symbol', [cs, 'sds_sym_1', '={"symbol":"%s","adjustment":"splits"}' % symbol]))
    ws.send(msg('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', '1D', n]))
    while True:
        r = ws.recv()
        for part in re.split(r'~m~\d+~m~', r):
            if part.startswith('~h~'): ws.send(f'~m~{len(part)}~m~{part}'); continue
            if not part: continue
            try: j = json.loads(part)
            except ValueError: continue
            if j.get('m') == 'timescale_update':
                ws.close()
                # v = [t, o, h, l, c, v]; the close is the day's value. t is the session open in UTC.
                return {dt.datetime.fromtimestamp(b['v'][0], dt.UTC).astimezone(NY).date().isoformat(): b['v'][4] for b in j['p'][1]['sds_1']['s']}
            if j.get('m') in ('symbol_error', 'series_error', 'critical_error', 'protocol_error'):
                raise SystemExit(f'{symbol}: {j.get("m")}')

up, dn = bars('USI:UVOL'), bars('USI:DVOL')
dates = sorted(set(up) & set(dn))
now = dt.datetime.now(NY)
if dates and dates[-1] == now.date().isoformat() and now.strftime('%H:%M') < '16:30':
    dates = dates[:-1]
rows = [[d, int(up[d]), int(dn[d])] for d in dates if up[d] is not None and dn[d] is not None and up[d] + dn[d] > 0]
json.dump({'source': 'TradingView USI:UVOL / USI:DVOL daily (NYSE up / down volume), scripts/vol-thrust-history.py',
           'updated': now.date().isoformat(), 'fields': ['date', 'up', 'down'], 'rows': rows},
          open(OUT, 'w'), separators=(',', ':'))
print(f'{OUT}: {len(rows)} sessions {rows[0][0]} → {rows[-1][0]}')
