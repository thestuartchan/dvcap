# MACRO_BUILD_HANDOFF.md

## What this is
Extending the existing dvcap dashboard (React/Vite/Vercel, FRED + serverless `api/`)
into a global macro trading tool: automated region-by-region Daily Pre-Reads +
a maintainable global macro calendar + (roadmap) live dashboard, timezone engine,
alerting, and a journal/rules-log.

## Status: Layer 1 built & tested (this package, drop into repo)
- `data/universe.js` — tickers per region (asia/eu/us), tagged by role
  (foundry/memory/litho/equip/index/megacap/gpu) + `leader` flags. Single source of truth.
- `api/lib/quotes.js` — DATA SPINE. Normalized quote shape, honest `stale` flag on every
  print. Sources: Yahoo (equities/indices/oil, keyless — `api/lib/yahoo.js`) + FRED
  (yields/OAS — `api/lib/fred.js`, shares `FRED_API_KEY` with `api/indicators.js`).
  Everything reads this. [Reconciled: was FMP-primary + placeholder oil; moved onto the
  repo's existing keyless Yahoo stack and unified the FRED key.]
- `api/lib/regime.js` — DETERMINISTIC regime engine (memory-vs-foundry split, credit
  state, oil-vs-pivot, structure-vs-MAs). NO model. Pure arithmetic. TESTED against live
  Jul 13 numbers — correctly output "memory-specific weakness (foundry holding)".
- `api/lib/calendar.js` + `data/calendar.json` — global macro calendar, hand-maintained
  monthly; `monthView(y,m)` + `weekHighlights()` (auto Mon–Sun). TESTED.
- `api/preread.js` — assembles data + regime, calls `claude-sonnet-5` for ONLY the prose
  read, formats Discord-ready, posts webhook. Not yet run end-to-end (needs live keys).
- `vercel.json` — cron: Asia 01:00 UTC / EU 08:00 UTC / US 13:00 UTC, weekdays.

See TRADING_CONTEXT.md for WHY the tool is shaped this way (the trading framework the
regime engine encodes). Read it before touching regime.js or universe.js.

## Design decisions (do not undo)
1. Regime computed in CODE, model only writes prose — this is what stops hallucinated
   numbers. Never let the model see raw data and produce a tag.
2. Every print carries a `stale` flag (>20min). The Pre-Read must show ⚠️ on stale data,
   never launder it into a clean number. Mirrors the manual discipline.
3. Pre-Read content rules (baked into the preread.js system prompt, keep them): research/
   data only; NEVER mention the user's portfolio/positions/theses; no instructional
   guidance ("don't short X"); no disclaimers/"not advice" footers.
4. Calendar is a static maintained JSON, not a live feed — economic calendars are flaky/
   paywalled; hand-kept is more reliable.
5. Model string is `claude-sonnet-5` (standard Messages API, ~$2/$10 per MTok through
   Aug 31 2026). Pre-Read is ~2k in/1k out = sub-cent. Don't over-model this.

## FIRST TASKS in Claude Code (in order)
1. ✅ DONE — Merged & reconciled against the existing `api/` stack: spine now reads the
   repo's keyless Yahoo endpoint (`api/lib/yahoo.js`, same one `api/prices.js`/`indicators.js`
   use) and shares the FRED key via `api/lib/fred.js` (`FRED_API_KEY`). No duplicate key.
2. ✅ DONE — Oil is NOT a gap: `oilQuote()` reads Yahoo `CL=F`/`BZ=F` (keyless), the same
   WTI source `api/indicators.js` already uses. No OIL_KEY / paid feed needed.
3. Set env vars in Vercel: FRED_API_KEY, ANTHROPIC_API_KEY, DISCORD_WEBHOOK.
   (FRED_API_KEY is already set for the existing dashboard; FMP_KEY / OIL_KEY no longer used.)
4. Dry-run: `GET /api/preread?region=asia` (no post) → eyeball the message + regime JSON.
   Then `&post=1` to test the webhook. Then enable cron.

## ROADMAP (layers 2–5, each a discrete build)
2. Dashboard UI tab — render spine + regime live (the v3 playbook, but dynamic).
   Reference: `global-macro-playbook-v3.html` (design/structure to port to React).
3. Timezone engine — auto-detect location, highlight the LIVE region, countdown to next
   open, show the session relay. THIS is what makes it "regardless of region." Build next.
4. Alerting — push level breaks / regime changes / calendar events to phone.
5. Journal + rules-log persistence — the playbook's v0.1 entry-rule "develop-blanks"
   become an editable store; grows region-by-region as the tape teaches.

## Known gaps / cautions
- IBKR `get_price_snapshot` had a serialization bug (contract_id coerced to string). If
  wiring IBKR as a data source, test that first — search_contracts works, the snapshot didn't.
- Korea stress cluster (Asia pre-read): USD/KRW (Yahoo `KRW=X`) and VKOSPI (CNBC
  `.KSVKOSPI`) are live/keyless. CSOP 7709 **units outstanding** — CSOP/HKEX are 403
  bot-walled, so it's scraped by a headless-browser cron (`api/scrape-7709.js`, 00:30 UTC)
  that commits daily to `data/korea_7709.json` via the GitHub API (needs `GITHUB_TOKEN`/
  `GITHUB_REPO`). Validate on first deploy with `GET /api/scrape-7709?dry=1` and tune the
  label regexes if `units` comes back null — the CSOP DOM can't be checked from a dev box
  (Chromium is Linux-only) and the bot-wall may need header tweaks. 7709 *price* is live via
  Yahoo `7709.HK`. Modeled as a Korea-LOCAL regime gate (`regime.korea`), kept separate from
  the global OAS gate — do not merge them.
- EU/US quotes in the seeded universe are close-of-Friday; live only when those markets open.
- MAs are now computed from Yahoo daily closes (`api/lib/yahoo.js`), not a provider's
  precomputed field — this resolves the old "FMP index MAs are garbage (KOSPI nonsense)" gap.
  The newest close in the SMA window may be intraday; the 50/200d level is barely affected.

## Build sequence discipline
Get Layer 1 live and posting Pre-Reads FIRST — that alone kills the daily manual grind and
proves the data spine. Then build Layer 3 (timezone engine). Layers 4–5 need infra decisions
(push service, datastore) beyond the current serverless pattern — don't attempt all at once.
