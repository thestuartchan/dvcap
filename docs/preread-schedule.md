# Pre-read schedule — why it looks like this, and what to do if it breaks

## Two entries, one firing each, Asia and US

```
42 22 * * *  ->  /api/preread?region=asia&post=1&cron=1
42 13 * * *  ->  /api/preread?region=us&post=1&cron=1
```

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
