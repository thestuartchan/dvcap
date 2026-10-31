# Ideas cards — one Discord card per selected trade idea

`POST /api/ideas-card` keeps a private Discord channel in step with the idea book: one card per
selected idea, edited in place when the idea changes, deleted when it leaves the set. It is routed
to `api/tradecard.js?card=ideas` by `vercel.json`, because the deployment is at 12 of 12 functions.
The card is built in `lib/ideacard.js`.

## Setup

| Variable | What it is |
|---|---|
| `DISCORD_IDEAS_WEBHOOK` | The channel's incoming-webhook URL. This is a credential: anyone who has it can post to the channel. If it is unset or is not a Discord webhook URL, the route answers `200 {ok:false, reason:'no webhook'}` and posts nothing. |
| `IDEAS_CARD_TOKEN` | The caller's token, sent as the `x-ideas-token` header. It is scoped to this route only. It is not a service key, the service key and the dashboard session do not open this route, and a value equal to any other credential is refused. If it is unset, every call is refused. |

Redis (the existing Upstash integration) keeps an idea id → `{messageId, hash}` map. Without
Redis the route answers `ok:false` with the reason `no store`.

**Make the channel private.** An idea is not a position, but a list of what is about to be traded
should not be public. The webhook is bound to that one channel, so ideas cannot land anywhere else.

## What a card shows: per-contract economics, never size

The card is built from a whitelist of fields: ticker, structure, thesis and its tag, play, side,
sector, catalyst and its time (shown as Discord timestamps in each reader's own timezone),
entry, invalidation, exit, expiry, up to four alternatives, the price note and status. It also shows
**per-contract** economics: cost, max gain, R:R, odds, breakeven and EV.

The card **never** shows a size of any kind. It never shows a contract count, `taken` / `takenAt`,
a ladder, planned R, the note, the outcome or the order. These fields may be present in the
request body, but the projection never reads them. `test/ideacard.test.mjs` checks this with
sentinel values.

Anything cut to fit Discord's limits ends in `… (trimmed)`. The limits are 256 for the title,
4096 for the description, 1024 for a field, 25 fields and 6000 characters in total.

## Contract

```
POST /api/ideas-card
x-ideas-token: <IDEAS_CARD_TOKEN>
Content-Type: application/json

{ "ideas": [ { "id": "…", "ticker": "…", "structure": "…", "metrics": { "kind": "debit", … }, … } ] }
```

The body is the **whole** desired set. An idea missing from it has its card deleted.

```
200 { ok, posted: [ids], edited: [ids], deleted: [ids], unchanged: [ids], errors: [{ id|index, error }] }
```

- The route processes at most 25 ideas per call. Any idea past the 25th is named in `errors`, and
  its existing card is kept.
- The calls to Discord run one after another. On a 429 the route waits and retries.
- If an edit returns 404 (the message was deleted by hand), the card is posted again.
- A Discord outage shows up as entries in `errors`, never as a 5xx. The stored id is kept, so the
  next call retries that card.
- If a card is deleted by hand while its idea has not changed, the route does not notice. The card
  comes back on the next change to that idea.

## Short card (`card`)

An idea may carry `card: {thesis, trigger, wrong, exit, alts}`, a pre-abbreviated public summary.
When present the Discord card is built from it (one-line fields, at most two alternatives under
"Also considered"); the long fields are the fallback. Keys inside `card` are whitelisted like the
rest. Rank is no longer shown: it is the board's order, not a property of the idea.

Colour (left bar): green = long/bullish, red = short/bearish, amber = a volatility play
(long or short vol), grey = anything else.

## Trigger alerts

A card edit is silent in Discord, so when a trigger fires on an idea the caller can also send
`alerts`: `{ "alerts": [{ "id": "<idea id>", "text": "<one line>" }] }`. Each is posted as a NEW
message in the ideas channel (that is what Discord notifies on), pinging `DISCORD_USER_ID` when set
and linking back to the idea's card.

- `alerts` may come with or without `ideas`. Without `ideas`, the call only notifies; the cards are
  left alone (a missing `ideas` is not an empty set).
- At most 5 per call, 400 characters each. Text that reads like size, a fill or the book (`1.5R`,
  `filled`, `contracts`, `NLV`, …) is refused by name and not posted.
- Each alert is keyed on id + text; a key already sent (last 50 kept) is skipped, so a retry never
  pings twice. The response adds `alerted` and `skipped`.
