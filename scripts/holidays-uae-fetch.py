#!/usr/bin/env python3
"""scripts/holidays-uae-fetch.py — the raw sources for the DFM / ADX holiday calendar.

Reads two public sources and writes their text, unparsed, for scripts/holidays-uae.mjs to merge
(lib/uaeHolidays.js holds every rule):

  1. DFM's circulars — the list the exchange's own Circulars page loads (api2.dfm.ae, no login),
     and the PDF of each holiday, closure and resumption circular from the last ~15 months: the
     annual "Trading and Settlement Holidays for the Calendar Year" list, each one-off "Trading
     Holiday due to", and a regulator-ordered "Market Closure" / "Resumption of Trading".
  2. The UAE public-holiday calendar (Google's public ICS feed), which marks unconfirmed dates
     "(tentative)" — used only for a year DFM has not published yet.

Raw text only: nothing here summarises or interprets. Prints counts only.

Usage: python scripts/holidays-uae-fetch.py OUT.json
"""
import datetime as dt
import io
import json
import sys
import urllib.parse
import urllib.request

from pypdf import PdfReader

UA = {'User-Agent': 'dvcap-holidays/1.0 (+https://github.com/thestuartchan/dvcap)'}
LIST = 'https://api2.dfm.ae/web/sf/v1/circulars'
ASSETS = 'https://assets.dfm.ae'
ICS = 'https://calendar.google.com/calendar/ical/en.ae%23holiday%40group.v.calendar.google.com/public/basic.ics'
LOOKBACK_DAYS = 460


def get(url, timeout=30):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def circulars():
    q = urllib.parse.urlencode({'$expand': 'Resources', '$orderby': 'CircularDate desc', 'sf_culture': 'en', '$top': '80'})
    rows = json.loads(get(f'{LIST}?{q}')).get('value', [])
    since = (dt.date.today() - dt.timedelta(days=LOOKBACK_DAYS)).isoformat()
    out, failed = [], 0
    for c in rows:
        head = (c.get('Headline') or '').strip()
        date = (c.get('CircularDate') or '')[:10]
        # Holidays, and the closures and resumptions the regulator orders (lib/uaeHolidays.js
        # circularKind decides which are market-wide).
        if not any(k in head.lower() for k in ('holiday', 'closure', 'closed', 'suspen', 'resum')) or date < since:
            continue
        res = [r.get('Url') for r in (c.get('Resources') or []) if (r.get('Url') or '').lower().split('?')[0].endswith('.pdf')]
        if not res:
            continue
        path = urllib.parse.quote(res[0], safe="/?=&_.-")
        try:
            pdf = PdfReader(io.BytesIO(get(ASSETS + path)))
            text = ' '.join((p.extract_text() or '') for p in pdf.pages)
        except Exception:  # one unreadable circular never stops the rest
            failed += 1
            continue
        out.append({'no': c.get('CircularNo'), 'date': date, 'headline': head, 'text': text})
    return out, failed


def main():
    if len(sys.argv) < 2:
        sys.exit('usage: holidays-uae-fetch.py OUT.json')
    circ, failed = circulars()
    try:
        ics = get(ICS).decode('utf-8', 'replace')
    except Exception:
        ics = ''
    with open(sys.argv[1], 'w', encoding='utf-8') as f:
        json.dump({'fetchedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'circulars': circ, 'ics': ics}, f)
    print(f'DFM holiday circulars read: {len(circ)} (unreadable: {failed}); public calendar: {"yes" if ics else "unavailable"}')
    if not circ and not ics:
        sys.exit(1)


if __name__ == '__main__':
    main()
