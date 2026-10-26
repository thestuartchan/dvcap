# Event cards → Discord events channel

`POST /api/event-card` (rewritten to `api/tradecard.js?card=event`; the deployment is at 12 of 12 functions).

Macro event cards (FOMC, CPI, payrolls, BoJ, earnings clusters) are built by Stu and Claude together as a rendered PNG plus a short post. Claude uploads the approved card here; dvcap posts it to the events channel and keeps the Discord message id in Redis so the **same message is refreshed in place** later.

## Why in place
Cards go out with lead time, 1–3 days before the event, so there is room to position. On the event day the levels on the card (yields, gamma nodes, implied moves) are stale, so Claude re-renders the card with fresh numbers and uploads it under the same `id`. The message is edited, not re-posted: one message per event, always current.

## Auth
Header `x-ideas-token` (the same token as the ideas cards, `IDEAS_CARD_TOKEN`). It opens the ideas and event cards and nothing else.

## Env
- `DISCORD_EVENTS_WEBHOOK`: webhook URL for the events channel. If it's unset, nothing posts.
- `DISCORD_EVENTS_ROLE_ID` (optional): numeric role id to ping (e.g. the @Gayros role). Only that role can be pinged.

## Actions
| Body | Effect |
|---|---|
| `{ action: "upsert", id, heading, text, image_b64 }` | Posts the card the first time; after that, edits the same message (picture and text). A re-upload of identical content returns `unchanged`. If the message was deleted by hand, it is posted afresh. |
| `{ action: "delete", id }` | Deletes the message and forgets the id. |
| `{ action: "list" }` | Returns ids, headings and times only. |

The `id` is lowercase with dashes, e.g. `fomc-2026-10-28`. The message is built as `## <heading>`, then the role ping, then `<text>` (600 characters at most). The image must be a PNG of 3 MB or less.

## Rules (enforced by how cards are built)
Research only: no positions, sizing or book references; no instructions; no endpoint URLs or slugs. Times on the card are in ET.
