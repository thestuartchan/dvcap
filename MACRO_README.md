# dvcap-macro — automated regional Pre-Reads + macro calendar

Drop-in for your existing dvcap Vercel app. Adds auto-generated, region-by-region
Daily Pre-Reads (posted to Discord at each regional open) and a maintainable global
macro calendar.

## Architecture (3 layers)
1. **Data spine** (`lib/quotes.js`) — one normalized quote shape, Yahoo primary
   (keyless; equities/indices/oil via `lib/yahoo.js`) + FRED (yields/OAS via
   `lib/fred.js`), honest `stale` flags. Everything reads this, never a raw provider.
2. **Regime engine** (`lib/regime.js`) — deterministic tagging (memory/foundry split,
   credit state, oil read, structure). NO model. Pure arithmetic. This is what keeps
   the tool from ever inventing a number.
3. **Generator** (`api/preread.js`) — assembles data + regime, calls `claude-sonnet-5`
   for ONLY the prose "read" paragraph, formats Discord-ready, posts the webhook.

## Env vars (Vercel project settings)
```
FRED_API_KEY       st. louis FRED key (yields, OAS) — free. Shared with api/indicators.js.
ANTHROPIC_API_KEY  for the prose read
DISCORD_WEBHOOK    channel webhook for auto-posting
GITHUB_TOKEN       fine-grained PAT with contents:write on this repo — lets /api/scrape-7709
                   commit the daily 7709 units row back to data/korea_7709.json
GITHUB_REPO        "owner/name" of this repo (e.g. stu/market-watch)
GITHUB_BRANCH      deploy branch to commit to (optional, defaults to "main")
```
Equities, indices, and oil come from Yahoo (keyless) — no FMP_KEY or OIL_KEY needed.
GITHUB_* are only needed for the 7709 units auto-population (below); everything else runs without them.

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

## Korea stress cluster (Asia pre-read only)
A Korea-LOCAL credit/fear gate, modeled SEPARATELY from the global HY-OAS gate (OAS
answers "is this a world credit event?"; this answers "is the leveraged-memory forced-
deleveraging spiral exhausting?"). Rendered as a 🇰🇷 KOREA STRESS block and as a
`regime.korea` object. Three tells (`lib/regime.js` → `koreaStress`):
- **USD/KRW** — Yahoo `KRW=X` (keyless). Rising = won weakening = outflows; falling/flat = stabilizing.
- **VKOSPI** — CNBC `.KSVKOSPI` (keyless, `lib/cnbc.js`; Yahoo/FMP don't carry it).
  Bands calm<20 / elevated 30–45 / panic 80+. Elevated **and falling** = peak-and-roll (fear exhausting).
- **CSOP 7709 units outstanding** — the deleveraging tell (day-over-day UNITS, not price/AUM).
  The authoritative CSOP page and HKEX are bot-protected (HTTP 403 to plain fetch), so units
  are scraped by a **headless browser** cron: `api/scrape-7709.js` (puppeteer-core +
  @sparticuz/chromium) renders the CSOP page daily at **00:30 UTC** and commits a row to
  `data/korea_7709.json` via the GitHub API (needs `GITHUB_TOKEN`/`GITHUB_REPO`). The Asia
  pre-read (01:00 UTC) then reads that file. Price still comes live from Yahoo `7709.HK`.
  Manual edits to the JSON remain a valid fallback; with <2 rows the tell reads "manual input pending".

  **First-deploy validation (do once):** hit `GET /api/scrape-7709?dry=1` — it scrapes but
  does NOT commit, returning `{ entry: { units, nav, aum, source } }`. If `units` is null it
  returns the matched labels + a text sample so you can tune the label regexes in `scrapeCsop()`
  (CSOP's DOM/labels can't be verified from a dev box — Chromium is Linux/Lambda-only, and the
  bot-wall may need header/fingerprint tweaks). Once `?dry=1` shows a sane number, the cron is live.
  `source` will read `csop-headless` (explicit units label) or `csop-headless-derived(aum/nav)`
  (fell back to AUM÷NAV from the same page). Note: the commit triggers a redeploy, so units land
  in the pre-read same-day only if that redeploy finishes within the 30-min window before 01:00 UTC.

The washout-exhausting **cluster** fires only when all three align: won stabilizing AND
VKOSPI peaking & rolling AND units flattening. Otherwise `active` (still deleveraging) or `mixed`.

## Build roadmap (next pieces, in order)
1. ✅ Data spine + regime engine + Pre-Read generator + calendar  ← DONE
2. Dashboard UI tab — render the spine + regime live (the v3 playbook, but dynamic)
3. Timezone engine — auto-highlight the live region, countdown to next open
4. Alerting — push level breaks / regime changes / calendar events to phone
5. Journal/rules-log persistence — the playbook's develop-blanks become editable store
