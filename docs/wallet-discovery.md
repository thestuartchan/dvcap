# Reading the whole wallet

## Why a key is needed at all

An ERC-20 balance is stored **inside each token's own contract**, in a mapping keyed by holder. So
a node answers *"how much USDC does this address hold?"* instantly, and has **no answer at all** for
*"what does this address hold?"* — nothing on chain writes that index.

Native ETH is different: it lives in the account state, which is why every chain shows its native
coin and only listed tokens beside it.

Enumerating a wallet therefore needs something that has replayed every `Transfer` event and built
the reverse index. Blockscout's public instances were tried first, to avoid a key entirely: 503 or
empty on all four majors, on 2026-09-07.

## Without a key

The wallet still works. It checks the verified contract list in `lib/chains.js` — 23 addresses,
each confirmed against the chain by asking its own `symbol()` and `decimals()`. Complete for
majors, blind to everything else, and the card says so rather than implying the list is the whole
truth.

## Getting the key

1. Go to **https://www.alchemy.com** and sign up. The free tier is enough — this makes at most one
   request per chain per console load.
2. In the dashboard, create an app (any name). Alchemy issues **one key that works across networks**,
   so you do not need an app per chain.
3. Copy the **API key** — the bare key, not the full HTTPS URL. If you copied a URL like
   `https://eth-mainnet.g.alchemy.com/v2/abc123`, the key is just the `abc123` part.

## Setting it

In **Vercel → your project → Settings → Environment Variables**:

- **Name:** `ALCHEMY_API_KEY`
- **Value:** the key
- **Environments:** Production (add Preview too if you want previews to show real balances)

Then **redeploy** — Vercel does not apply environment changes to an existing deployment. Merging
anything, or hitting Redeploy on the latest commit, is enough.

Do not paste the key into a chat, a commit, or a PR. It goes into Vercel and nowhere else.

## What changes once it is set

All six chains switch from "check these 23 contracts" to "return every token this address holds",
including **Robinhood Chain**, whose tokenised assets have no published contract list and are
invisible without it.

The key is passed as a URL **path segment**, which makes the URL itself a credential — so every
error raised in `lib/alchemy.js` is redacted before it is reported, and the key never reaches a
log, a response body or the browser. The wallet is served only from the authenticated
`/api/manual-entry` route.

## The bound

At most 5 pages of 100 tokens per chain per load. An address junked with airdrops must not turn
into an unbounded request on every page view. If a wallet has more than 500 tokens on one chain the
card **says the list was cut short** — a capped list that looked complete is the one failure this
whole path exists to remove.
