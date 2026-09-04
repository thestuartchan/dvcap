# Pre-read schedule — why it looks like this, and what to do if it breaks

## Two entries, one firing each, Asia and US

```
42 22 * * 0-4  ->  /api/preread?region=asia&post=1&cron=1   06:42 HKT, year-round
42 12 * * 1-5  ->  /api/preread?region=us&post=1&cron=1     08:42 ET in EDT  ** MOVE TO 13 ON 1 NOV **
```

## The day-of-week field runs a day ahead of Asia

Both entries were `* * *` and delivered a pre-market brief every Saturday and
Sunday. Fixing that is not as simple as writing `1-5` on both, because **a cron's
day-of-week is evaluated in UTC and a pre-read's day is the region's**:

| cron (UTC) | region | local time | local day |
|---|---|---|---|
| Fri 22:42 | Asia | 06:42 HKT | **Saturday** |
| Sat 22:42 | Asia | 06:42 HKT | **Sunday** |
| Sun 22:42 | Asia | 06:42 HKT | Monday ✓ |
| Sat 12:42 | US | 08:42 ET | **Saturday** |
| Mon 12:42 | US | 08:42 ET | Monday ✓ |

The US brief lands on the same calendar day it fires, so `1-5` is right there.
The Asia brief lands the **next** day, so its UTC week runs one ahead: `0-4`
(Sun–Thu UTC) is Mon–Fri in Hong Kong. `1-5` on the Asia entry would have
delivered Tuesday through **Saturday** — the obvious fix makes it worse.

That offset is invisible in a cron string and cannot be unit-tested there, so the
schedule is only the first layer. `api/preread.js` asks the region what day it
actually is (`isWeekendIn(R.tz)`) and refuses to deliver on a weekend regardless
of what fired it, including a manual `?post=1`. `&force=1` overrides; a dry run
without `post=1` is never blocked, so the brief stays testable on any day.

Weekends only. A holiday calendar is per-market and per-year, and the guard
deliberately does not pretend to be one — Lunar New Year and Golden Week will
still deliver a brief for a shut market. An unknown weekday is not treated as a
weekend, so the guard can never silence a brief it is unsure about.

## ⚠ 1 NOVEMBER 2026 — MOVE THE US ENTRY TO `42 13 * * 1-5`

There is no single UTC hour that serves the US in both daylight-saving halves,
and the reason is Vercel's punctuality rather than arithmetic.

Measured on this project, Vercel crons run **16 to 33 minutes late**. The US
delivery window is 08:40–09:45 ET, so a firing needs to land early in it:

| cron (UTC) | half | on time | +16m | +33m | headroom |
|---|---|---|---|---|---|
| 13:42 | EDT | 09:42 ✓ | 09:58 ✗ | 10:15 ✗ | **3 min** |
| 13:42 | EST | 08:42 ✓ | 08:58 ✓ | 09:15 ✓ | 63 min |
| 12:42 | EDT | 08:42 ✓ | 08:58 ✓ | 09:15 ✓ | 63 min |
| 12:42 | EST | 07:42 ✗ | — | — | opens too early |

13:42 was chosen because it is the only minute inside the window in both halves
ON TIME — which is worthless, because the scheduler is never on time. Three
minutes of headroom against a scheduler that runs half an hour late is a firing
that misses every day.

So the entry follows the season, and the date is written here rather than left to
memory. Between 1 November and the March transition the GitHub backup at 13:49
UTC is the only US trigger, and it is unreliable.

## WHAT WENT WRONG, AND THE DISTINCTION THAT MATTERS

The previous version of this file asked ONE entry to fire at three hours:
`42 8,13,22 * * *`. That is not a cron the Hobby plan will accept, and the
failure mode is the expensive one: **Vercel rejects the deployment**. The build
never completes, the previous deployment keeps serving, and the site looks
completely normal while every merge silently stops reaching production.

It blocked six pull requests for a day — the intervention flags, Gate 2, the
scenario thresholds, the MGC backfill, the recompute refusals, the heatmap
figures — none of them anything to do with cron.

The distinction that was got wrong:

| overage | what Vercel does |
|---|---|
| more ENTRIES than the cap (2) | deploys, silently runs only the first two |
| more FIRINGS PER DAY than the cap (1) | **rejects the deployment** |

The original five-entry config deployed fine and ran only two, which is what sent
this to GitHub Actions in the first place. A multi-hour schedule looks like a
tidier way to say the same thing and is not the same thing at all.

So: one hour per entry, and never a comma in the hours field on this plan.

## Which regions, and why these two

Two entries is the cap and there are three regions, so one loses. Per the
operator's instruction: **keep Asia and US, drop EU.** Europe rides the GitHub
Actions backup alone, and it is the right one to sacrifice — its brief is written
to land INTO the session rather than ahead of it, so it loses least by arriving
late or not at all.

Times are UTC and the gate resolves each region's real local time through `Intl`
on every firing, so the DST transitions need no change here. 22:42 UTC is 06:42
HKT year-round (no DST in HK/KR/TW/JP). 13:42 UTC is 09:42 ET in EDT and 08:42 in
EST — both inside the US window of 08:40 to 09:45, which only works because the
deadline is the open plus fifteen.

## The backup trigger

`.github/workflows/preread.yml` fires all three regions at the same hours a few
minutes later, and is the ONLY trigger Europe has. GitHub's scheduler dropped six
of seven firings on 2026-09-02/03 and ran others up to 3h24m late, so it is a
backup and nothing more. The same-day dedupe makes a double delivery impossible.

## If a brief goes missing

The console shows a red card for any region past its deadline with nothing
posted, with how late it is and when that region last delivered. That is the
detector — a missing brief should never again be found by noticing an absence in
a chat channel.
