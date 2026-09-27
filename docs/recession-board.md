# The recession board

## What it is

A **hand-kept panel** of a few named research houses, official models and prediction markets. It is
not a survey, and the heading no longer says "Wall Street" because that implied a breadth the panel
does not have.

Some rows have live feeds (Kalshi, Polymarket, the NY Fed yield-curve model). The **research-house
rows have no feed and are typed in by hand.**

A number goes in only from a source that was actually read. A search-engine summary of a house's
view is not one — the same rule `api/indicators` applies when it refuses an LLM as a feed, and it
applies to hand-entered rows too. Where a figure could not be traced to a primary source, the row
says so rather than carrying a plausible number.

## When to refresh — four times a year

Refresh **a week or two after each FOMC projection round**, because that is when the houses revise:

| when | why then |
|---|---|
| **late March** | after the March SEP; Q1 revisions land |
| **late June** | after the June SEP; mid-year outlooks are out |
| **late September** | after the September SEP; post-summer revisions |
| **mid December** | after the December SEP, and the year-ahead outlooks published Nov–Dec |

The FOMC publishes projections quarterly (March, June, September, December) and the sell-side
revises against them, so a week or two after each meeting catches the most freshly published views
for the least work. Mid-December is deliberately last rather than early-January: the year-ahead
outlooks are already out by then, and waiting for January adds nothing but staleness.

The page shows a stale badge past 90 days, which is the same cadence stated as a deadline.

## Retiring a vintage

A view whose stated condition did not happen is **archived**: kept out of the weighted average, with
the reason recorded on the row.

Archived rows are for the record, not the eye. **Retire them once they stop being current** — the
four March-2026 vintages sat greyed-out at 35–49% for six months and still anchored the reader, and
the number a reader half-remembers is not fixed by a strikethrough. Their reasons survive in git,
which is the right place for a thing nobody needs on screen.

## Dispersion states the panel size

Two sources both saying 35% used to render as *"sources cluster within 0pp"*, which reads as firm
consensus and is the exact opposite of the truth: two views cannot disagree by much, so 0pp across
two of them is an absence of evidence rather than agreement.

Dispersion now names the count — *"only 2 independent views — too few to disagree, so 0pp of spread
is not consensus"* — and carries a `thin` flag below `THIN_PANEL` (3), the smallest panel where one
source can be the odd one out and still leave two to form a view.

## Refresh log

**2026-09-27 — September round** (after the Sep 16 SEP). Every hand-kept row re-read from its
primary source:

- **Goldman Sachs** — still 15%; no print newer than the note that cut 25% → 15% ("Global Views: More
  Crude, Less Concern", reported 1 Jul).
- **NY Fed DSGE** — the September forecast (Liberty Street Economics, 18 Sep) again states no
  recession probability (growth 1.2% for 2026, 0.1% for 2027). Stays retired.
- **J.P. Morgan Asset Management** — 3Q Global Fixed Income Views (22 Sep): Recession 5%, Crisis 10%.
  Scenario weights, so added as a qualitative row and kept out of the average.
- **FOMC** — the July-minutes row is replaced by the September decision: a 25bp hike, 12–0; SEP
  median funds rate 4.1 for end-2026 and end-2027.
- **Moody's (Zandi)** — 40% over 12 months, quoted directly from a TheStreet interview (reported
  2026-05-20). Read, and left out: it predates the June peace deal that moved every other house
  (Goldman 25% → 15%), and at 130 days old it would enter at 0.28 recency. Measured on 2026-09-27
  it would lift the rolling consensus 14.3% → 16.5% and cut the alive share 73.6% → 64.4% — a
  larger sizing haircut on a superseded view. A post-deal Zandi figure would go in.
- **Goldman** — the operator's source (Yahoo Finance, 2026-07-01) confirms the 15% note; nothing
  newer found on 2026-09-27.
- **EY-Parthenon, JPMorgan Research** — no dated primary figure found; still retired.

Next round: mid-December, after the Dec 8–9 SEP.
