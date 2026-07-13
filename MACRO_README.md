# dvcap-macro — automated regional Pre-Reads + macro calendar

Drop-in for your existing dvcap Vercel app. Adds auto-generated, region-by-region
Daily Pre-Reads (posted to Discord at each regional open) and a maintainable global
macro calendar.

## Architecture (3 layers)
1. **Data spine** (`api/lib/quotes.js`) — one normalized quote shape, FMP primary,
   graceful fallback, honest `stale` flags. Everything reads this, never a raw provider.
2. **Regime engine** (`api/lib/regime.js`) — deterministic tagging (memory/foundry split,
   credit state, oil read, structure). NO model. Pure arithmetic. This is what keeps
   the tool from ever inventing a number.
3. **Generator** (`api/preread.js`) — assembles data + regime, calls `claude-sonnet-5`
   for ONLY the prose "read" paragraph, formats Discord-ready, posts the webhook.

## Env vars (Vercel project settings)
```
FMP_KEY            your FMP key (equities/indices)
FRED_KEY           st. louis FRED key (yields, OAS)  — free
OIL_KEY            oil price source key (fills the FMP commodity gap)
ANTHROPIC_API_KEY  for the prose read
DISCORD_WEBHOOK    channel webhook for auto-posting
```

## Cron (vercel.json) — times are UTC
- Asia  01:00 UTC = 09:00 HKT
- EU    08:00 UTC = 09:00 London
- US    13:00 UTC = 09:00 ET
Weekdays only. `?post=1` posts to Discord; drop it to dry-run.

## Test locally
`GET /api/preread?region=asia` returns `{ message, regime }` as JSON (no post).
Add `&post=1` to also fire the webhook.

## Maintaining the calendar
Edit `data/calendar.json` monthly. Each event: `{ date, title, region, tier }`.
`weekHighlights()` auto-surfaces the current Mon–Sun; `monthView(y,m)` returns a month.

## Build roadmap (next pieces, in order)
1. ✅ Data spine + regime engine + Pre-Read generator + calendar  ← DONE
2. Dashboard UI tab — render the spine + regime live (the v3 playbook, but dynamic)
3. Timezone engine — auto-highlight the live region, countdown to next open
4. Alerting — push level breaks / regime changes / calendar events to phone
5. Journal/rules-log persistence — the playbook's develop-blanks become editable store
