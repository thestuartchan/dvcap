# The wallet card

A second Discord card, in a **different channel** from the trades card, that posts when the
wallet's composition changes.

## What it publishes, and what it never does

The channel is **public**, so this follows the same rule `lib/tradecard.js` enforces: four
quantities never leave — **size, absolute P&L, market value, share of book**.

| published | never published |
|---|---|
| symbol | quantity or balance |
| price | dollar value of anything |
| day change % | wallet total, per-chain or across chains |
| which chain | free vs. resting split |
| bought / sold / added / trimmed | how much was bought or sold |

`lib/walletcard.js` builds the payload from an **allow-list** (`WALLET_PUBLIC_FIELDS`), so a field
added upstream is invisible here until somebody decides otherwise. There are tests that build rows
whose private figures are distinctive digit strings and assert those strings appear nowhere in the
serialised output.

### One thing it still discloses

A public list of holdings plus buy and sell prices is enough for someone to **find the wallet on
chain** by matching the trades — and the address then reveals everything above. The size is not in
the card; the card is a fingerprint that leads to it. That is a judgement for the account owner and
it has been made deliberately. It is written down so the next reader does not have to rediscover it.

## When it fires

Only when the composition actually changed. It compares against a snapshot in Redis and reports
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
