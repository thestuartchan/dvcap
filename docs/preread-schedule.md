# Pre-read schedule — why it looks like this, and what to do if it breaks

## One cron entry, three hours, minute 42

```
42 8,13,22 * * *   ->  /api/preread?all=1&post=1&cron=1
```

Each firing runs all three regions; the window gate keeps the wrong ones out and the same-day
dedupe makes a repeat a no-op. Minute 42 is not arbitrary. It is the intersection of every
region's delivery window across BOTH daylight-saving halves:

| region | cron hour (UTC) | minutes that land in-window year-round |
|---|---|---|
| asia | 22 | 40–59 |
| eu   | 08 | 40–59 |
| us   | 13 | **40–44** |

The US is the binding constraint, and only because its deadline is the open plus fifteen. With the
previous 09:30 ET deadline there is **no** minute at 13:MM UTC that lands inside the US window in
both halves of the year — which is why the original design needed a separate entry per DST half,
blew through the Hobby cap of two, and silently ran only the first two of five.

There are no DST pairs any more. The gate resolves each region's real local time through `Intl` on
every firing, so the 25 October and 1 November transitions need no change here.

## If Vercel throttles cron frequency

The Hobby plan caps cron ENTRIES at two. Whether it also caps how often one entry may fire is not
documented anywhere we can rely on, and the current entry asks for three firings a day. If only one
lands, the console's missed-brief card will say so within a day — that is what it is for.

**The fallback is decided in advance: keep Asia and US, drop EU.** Use both slots, one hour each,
so a per-entry daily cap cannot take a region away:

```json
{ "crons": [
  { "path": "/api/preread?region=asia&post=1&cron=1", "schedule": "42 22 * * *" },
  { "path": "/api/preread?region=us&post=1&cron=1",   "schedule": "42 13 * * *" }
] }
```

Europe then rides on the GitHub Actions backup alone. It is the right one to sacrifice: its brief is
written to land *into* the session rather than ahead of it, so it loses least by arriving late.

The second slot is deliberately left empty today so this switch needs no other change.

## The backup trigger

`.github/workflows/preread.yml` fires the same three hours a few minutes later. GitHub's scheduler
dropped six of seven firings on 2026-09-02/03 and ran others up to 3h24m late, so it is a backup and
nothing more. It costs nothing and the dedupe makes a double delivery impossible.
