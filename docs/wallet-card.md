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

## Chain logos

Holdings are **grouped into one embed per chain**, each headed by that chain's real logo, fetched by
Discord from the web when it renders the card. Nothing to upload and nothing to configure.

That shape is forced by Discord rather than chosen for looks: an embed description cannot carry
inline images and markdown image syntax does not render inside one, so an embed's **author icon** is
the only place an arbitrary image can sit next to text. Grouping also shortens every line, because
the chain no longer has to be repeated on each one.

Logos all come from `icons.llamao.fi` so the set reads as one family rather than six croppings. If a
URL ever 404s, Discord omits the icon and the chain name still shows — a dead link degrades the card
rather than breaking it. A chain with no logo mapped gets no `icon_url` at all, because Discord
renders a *broken* image for a dead link and nothing for a missing one.

### A chain earns its section

A chain gets its own logo-headed section only when it holds **two or more** things
(`MIN_CHAIN_HOLDINGS`). A chain carrying only its gas token is not a position — it is the fee left
over from making one somewhere else — and a whole section announcing "ETH" is a lot of card for a
fact nobody acts on. Two is the bar because on a chain where gas is held, one real position already
reads as two holdings, so a chain promotes itself the moment something is actually bought there.

Thin chains are dropped **silently**. An earlier version named them in a muted line and that line
turned out to be more noise than the rows it replaced.

Nothing the card exists for is lost: a **trade** on a dropped chain is still announced in the events
at the top, so activity always surfaces even when a standing balance does not. The console remains
the place that shows everything.

Dropping happens **before** the embed cap is measured, so thin chains cannot push a real one out.

A message takes at most ten embeds. One is spent on the day's events, so **beyond nine chains** the
card falls back to a single flat list marked with the Unicode marks below — fewer decorations rather
than a truncated wallet.

## Chain marks (the fallback layout)

Used only in that flat layout, where nothing else says which chain a row belongs to.

| chain | mark |
|---|---|
| Ethereum | ⟠ |
| Arbitrum | 🔷 |
| Base | 🔵 |
| Polygon | 🟣 |
| HyperEVM / Hyperliquid | 🌊 |
| Robinhood Chain | 🪶 |
| anything else | ⬦ |

### The header mark

The card carries two headers doing different jobs. The embed **title** says what the message is —
`Daily Summary` — and is plain text. The first **description** line says whose wallet, and that is
where the mark goes, under the reserved key `Wallet` in the same map. It is not a chain, so it is not in the built-in table; unset, the
header simply reads without one.

**The header is the description's first line, not the embed title.** Discord renders a custom emoji
inside an embed description and **not** inside its title — a title carrying `<:name:id>` prints that
text literally. Since the header is where a wallet mark belongs, the header moved. A bold first line
reads as a title anyway, and it puts the whole card in one rendering context.

### Using the real chain logos

Unicode has no chain logos, so the marks above are stand-ins. Real logos are possible, but they are
**custom Discord emoji** — they live on one server and are referenced by id, not by name.

1. Upload each logo to the server: **Server Settings → Emoji → Upload Emoji**.
2. In any channel, type `\:name:` (with the backslash) and send it. Discord prints the raw form,
   e.g. `<:ethereum:1234567890123456>`. That string is what the card needs.
3. Set `DISCORD_CHAIN_EMOJI` in Vercel to a JSON object keyed by the chain label exactly as it
   appears on the card, then redeploy:

   ```json
   {
     "Wallet":          "<:1385metamask:000000000000000000>",
     "Ethereum":        "<:18119ethereum:000000000000000000>",
     "Robinhood Chain": "<:666045robinhoodlogo:000000000000000000>",
     "Hyperliquid":     "<:Hyperliquid_Blob_Green:000000000000000000>",
     "HyperEVM":        "<:Hyperliquid_Blob_Green:000000000000000000>"
   }
   ```

Any chain the object omits keeps its built-in mark, so a partial map is fine. A malformed value —
bad JSON, a non-string, anything with a newline — is ignored and the built-ins stand, because a typo
in an env var must not stop the daily card from posting.

## Hyperliquid

Three different things, wired separately because they are different animals.

| | where it comes from | how it appears |
|---|---|---|
| **HyperEVM** balances | on-chain, one of the six chains | a chain section, `HyperEVM` |
| **HL spot** ledger | `spotClearinghouseState` | a chain section, `Hyperliquid` — diffed like any other balance, so a spot buy there is announced like a spot buy anywhere |
| **Perps** | `clearinghouseState` + `frontendOpenOrders` | their own section, `Hyperliquid · perps` |

### Perps are reported, not diffed

A perp is not a balance that went up or down. It has a direction, an invalidation level and an
objective, so it is shown as it stands.

```
🟢 HYPE Long 84.97 (+1.2R) · SL 70.00 · TP 110.00 (+4.7R)
🔴 BTC Short 96500.00 (+0.3R) · SL 104000.00 · TP 86000.00 (+2R)
⚪ SOL Long 175.00 · no stop
```

**Published:** symbol, direction, mark, the stop and target levels, and R. Levels and R are what a
trade-idea channel is for — `lib/tradecard.js` has published exactly these for the swing book since
it was written, and R comes from that same `rOf` rather than a second implementation.

**Never:** size, notional, margin used, unrealised P&L, leverage — and not the **liquidation price**,
which is excluded by instruction and would leak size anyway, being a function of margin.

Entry is not printed, but that is presentation rather than protection: entry is recoverable from the
mark, the stop and R by algebra. It is left off because it was not asked for and the line reads
better short.

Direction is spelled out in words on every line. The swing card hides the marker for an all-long
book, which is right there and wrong here — a short read as a long is the worst error this card can
make.

`_no stop_` is said out loud rather than left as an absence. R is null without a stop (there is
nothing for it to be a multiple of), and a missing R that means nothing looks the same as a missing R
that means something.

### Telling a stop from a target

Getting this backwards would not fail loudly — it would file a stop as a target and R would come out
inverted and plausible. So the classifier does not depend on the venue's label alone:

1. If `orderType` names a take profit or a stop, that decides it.
2. Otherwise **geometry** decides — below entry on a long is a stop, above it is a target, and the
   reverse for a short.

The label is consulted first because it alone describes a **stop moved past entry** to lock a gain
in, which sits on the target's side and which geometry would misfile. Geometry is the fallback
because the exact label strings are unconfirmed: ten of the largest HYPE position holders were
carrying no trigger orders at all, so there was nothing live to check the strings against.

When several stops or targets rest at once, the **operative** one is whichever would fire first —
nearest the mark on its own side.
