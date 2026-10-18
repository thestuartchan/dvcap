#!/usr/bin/env python3
"""scripts/holidays-fetch.py — next year's exchange holidays, generated instead of typed.

data/holidays.json was topped up by hand each year and ran out on 31 Dec 2026. This fills the
years it does not yet cover from exchange_calendars (pinned in the workflow), the maintained
open-source rule set for each exchange's trading calendar: full-day closures and early closes.

SAFE BY CONSTRUCTION, the same rule the file states: a missing date degrades to a normal session,
a wrong one mislabels a real session. So this only ever ADDS dates for a YEAR the file has none
for, never edits or removes a date a person entered, and records where each generated year came
from under `_generated` — Data health shows it, and a hand correction afterwards always stands.

Usage: python scripts/holidays-fetch.py [data/holidays.json] [--years=2027,2028]
Prints counts only.
"""
import datetime as dt
import json
import sys

import exchange_calendars as xc
import pandas as pd

# dvcap's exchange code (lib/sessions.js) → exchange_calendars' MIC.
MIC = {'US': 'XNYS', 'SEHK': 'XHKG', 'KRX': 'XKRX', 'TWSE': 'XTAI', 'TSE': 'XTKS',
       'EURONEXT': 'XAMS', 'XETRA': 'XETR', 'LSE': 'XLON'}


def year_dates(code, year):
    cal = xc.get_calendar(MIC[code], start=f'{year - 1}-12-01', end=f'{year + 1}-01-31')
    lo, hi = pd.Timestamp(f'{year}-01-01'), pd.Timestamp(f'{year}-12-31')
    # Every weekday in the year that is not a session is a closure (weekends are already closed
    # in lib/sessions.js and are not listed).
    sessions = set(d.strftime('%Y-%m-%d') for d in cal.sessions_in_range(lo, hi))
    closed = [d.strftime('%Y-%m-%d') for d in pd.bdate_range(lo, hi) if d.strftime('%Y-%m-%d') not in sessions]
    half = sorted(d.strftime('%Y-%m-%d') for d in cal.early_closes if lo <= d <= hi)
    return closed, half


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    path = args[0] if args else 'data/holidays.json'
    flag = next((a.split('=', 1)[1] for a in sys.argv[1:] if a.startswith('--years=')), None)
    this_year = dt.date.today().year
    years = [int(y) for y in flag.split(',')] if flag else [this_year + 1]
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    gen = data.setdefault('_generated', {})
    added = 0
    for year in years:
        for code in MIC:
            ex = data.setdefault(code, {'closed': [], 'half': []})
            have = [d for d in ex.get('closed', []) + ex.get('half', []) if d.startswith(f'{year}-')]
            if have:
                print(f'{code} {year}: already has {len(have)} dates — left as entered')
                continue
            closed, half = year_dates(code, year)
            ex['closed'] = sorted(set(ex.get('closed', []) + closed))
            ex['half'] = sorted(set(ex.get('half', []) + half))
            gen.setdefault(str(year), {})[code] = {
                'source': f'exchange_calendars {xc.__version__}', 'mic': MIC[code],
                'at': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                'closed': len(closed), 'half': len(half)}
            added += len(closed) + len(half)
            print(f'{code} {year}: added {len(closed)} closed, {len(half)} half')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'{added} dates added')


if __name__ == '__main__':
    main()
