# API authentication — what to set, and why it exists

## The two minutes of setup

**One value, the same in two places, named the same thing in both.**

1. Invent a long random string. Anything unguessable — a password manager's
   "generate" button is ideal. It is never typed again after this.

2. **Vercel** → your project → Settings → Environment Variables → Add
   - Name: `TRADECARD_KEY`
   - Value: *the string*
   - Environments: Production (and Preview, if you use preview deployments)
   - Save, then **Deployments → ⋯ → Redeploy** — environment variables only
     take effect on a new build.

3. **GitHub** → the repo → Settings → Secrets and variables → Actions →
   New repository secret
   - Name: `TRADECARD_KEY`
   - Value: *the same string*

That is the whole task. Nothing else uses it and nothing else needs changing.

## How to know it worked

Actions → **tradecard** → Run workflow. A green run means the two values
match. A red one prints exactly which side is wrong, because the endpoint
says so rather than answering a bare "unauthorised":

- *no service key configured on the server* — step 2 is missing, or the
  deployment has not been rebuilt since.
- *the key presented does not match* — the two values differ.
- *no key presented* — step 3 is missing.

## Why it exists

Verified against production on 2026-09-06, unauthenticated, from outside:

| endpoint | | served |
|---|---|---|
| `GET /api/manual-entry` | 200 | the trade console — 37 rows with fills, cost basis, and `settings.equity` |
| `GET /api/flex-sync` | 200 | the IBKR account, its positions and summary |
| `GET /api/tradecard` | 200 | rebuilt and **posted** the Discord card |

`middleware.js` matches `/` and nothing else, so the login page protects the
dashboard and none of the API beneath it. Two of those routes checked a key
that read `if (!want) return true` — no secret configured, everyone welcome —
and no secret was configured.

Equity, position size, absolute P&L and share of book are the four
quantities `lib/tradecard.js` refuses to publish, enforced there by
construction and by test. The card was guarded carefully while the endpoint
underneath served the same numbers to anyone with the URL.

## Who may call what

- **A browser** with the dashboard session cookie: everything. This is why
  the console keeps working with no key set anywhere.
- **A workflow** presenting `TRADECARD_KEY`: the two endpoints its crons hit.
- **Anyone else**: 401.

`scripts/check-api-auth.mjs` fails the build if a route neither gates itself
nor is listed there as public *with a reason*, and specifically for the
fail-open shape that caused this.

## The other variable

`HYPERLIQUID_ADDRESS` is unrelated and optional. It is a public wallet
address rather than a credential — anyone can read any address's positions
from the venue — but it is the same identifier on every EVM chain, so it is
configured the same way and kept out of the repo.
