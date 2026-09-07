# The wallet card

A second Discord card, in a **different channel** from the trades card, that posts when the
wallet's composition changes.

## What it publishes, and what it never does

The channel is **public**, so this follows the same rule `lib/tradecard.js` enforces: four
quantities never leave — **size, absolute P&L, market value, share of book**.

| published | never published |
|---|---|
| symbol | quantity or balance |
| **market** price of the token | the **entry** price you paid |
| day change % | dollar value of anything |
| which chain | wallet total, per-chain or across chains |
| bought / sold / added / trimmed | free vs. resting split |
| | how much was bought or sold |

### Two things are called "price" and only one of them is about you

A **holdings** price is the current market price of a token. It is identical for every holder on
earth and is already on Dexscreener — it identifies nobody, and it is the entire point of a holdings
overview. It is published.

An **entry** price is what this wallet paid, and it belongs to one transaction. Next to a token and
a time window it pins a single swap out of the few in that window, and a swap names an address. It
is not published, and it is not carried on the event object at all: `EVENT_PUBLIC_FIELDS` is
`kind, symbol, chain`, so it cannot reach a payload by accident.

`lib/walletcard.js` builds the payload from an **allow-list** (`WALLET_PUBLIC_FIELDS`), so a field
added upstream is invisible here until somebody decides otherwise. There are tests that build rows
whose private figures are distinctive digit strings and assert those strings appear nowhere in the
serialised output.

### The thing no field-level rule fixes

The **holdings set is itself a fingerprint**, and it survives every price and timing rule above.
ERC-20 holder lists are public and indexed, so intersecting the holders of two or three obscure
tokens very likely yields one address — with no timing, no prices, and no event feed needed. It
works against a screenshot of the holdings list alone.

This is accepted knowingly rather than mitigated: the wallet is a bounded project account, not a
net-worth account, and the obscure tokens are simultaneously the content worth posting and the whole
fingerprint — they are the same thing. Removing them would delete the reason the card exists.

Written down so the next reader does not mistake the price and timing rules for a solution to it.

## When it fires

**Detection every 30 minutes, publication once a day at 22:00 UTC.** The two are split on purpose:

- Posting within half an hour of a trade puts that trade in a half-hour window, and on a quiet chain
  the swaps of one obscure token in half an hour may number in the single digits. The post time is
  itself the filter. Batching widens the window to a day.
- Detection still runs every half hour because **a position opened and closed between two daily posts
  would otherwise never have existed** — the snapshot either side of it is identical. Detect runs
  buffer into `WALLET_PENDING_KEY` and post nothing; the daily run detects, publishes, then drains.
- **It posts even on a quiet day.** A card that appears only when something happened makes its own
  presence the signal. A card every day at the same hour says nothing by existing.

Folding a repeated detection is idempotent: identity is `(kind, symbol, chain)`, which since the
entry price left is the whole event, so a run that buffered but failed to advance its snapshot
re-detects the same events and they collapse back into one entry. Buying and later trimming the same
token are different kinds, so both survive — that is a real pair of decisions.

Two ordering rules are load-bearing: the buffer is written **before** the snapshot moves, and the
buffer is drained **only** on a confirmed Discord post.

Events are reported only when the composition actually changed. It compares against a snapshot in Redis and reports
four events: **bought**, **sold**, **added to**, **trimmed**.

Materiality is judged on **notional, not quantity** — a thousand of something worthless and a
thousandth of something valuable are the same number and not the same event. The floor is
`MIN_NOTIONAL_USD`, currently **$20**, set from how the account trades: tranches are not bought
below that, so anything smaller is not a decision. It also means gas dust, which moves a native
balance on every transaction, never posts.

An **unpriced** token cannot be shown to be material, so nothing is said about it.

## Re-sent, not edited

The trades card edits one message in place, because a swing book that re-posts all day is noise.
This one posts a fresh message each time, so it surfaces in the channel exactly when something
happened — which is the right behaviour precisely because it is rare.

## Setting it up

1. In Discord, **Channel → Edit Channel → Integrations → Webhooks → New Webhook**, in the channel
   you want the card in. Copy the URL — it is a **credential**: anyone holding it can post there.
2. In **Vercel → Settings → Environment Variables**, add `DISCORD_WALLET_WEBHOOK` with that URL,
   for Production. Then **redeploy** — an environment variable does not reach an existing
   deployment until something redeploys.
3. Nothing else. `.github/workflows/walletcard.yml` already polls every 30 minutes between 06:00
   and 23:00 UTC, and uses the `TRADECARD_KEY` secret this repo already has.

Unset the variable and the card simply stops posting.

## The first run posts nothing

With no snapshot to compare against, every holding would look newly bought and the first card would
be a fabricated buying spree. The first run records the wallet and stays quiet; the second run
onward reports changes.

## What it is not

Polling means the card says *"this changed since I last looked"*, not *"you just traded"*. Several
swaps inside one 30-minute window collapse into a single card. Per-trade cards would mean watching
transfers rather than diffing balances — more machinery, and worth doing only if the diff turns out
not to be enough.
