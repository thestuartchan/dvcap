# Supplier and customer maps

Who sells to whom, for the ~30 companies the dashboard watches. This is the free part of what Bloomberg's SPLC does, built from the one source that can't be second-hand: each company's own annual report on EDGAR.

## Where a link comes from

`scripts/supplychain-build.mjs` does the following for each company in `SC_UNIVERSE` (`lib/supplyChain.js`):

1. Finds the company's CIK in SEC's ticker file.
2. Takes its latest annual report from its EDGAR submissions: a 10-K, or a 20-F / 40-F for a foreign filer.
3. Reads the filing's primary document raw, as HTML, and turns it into sentences. Inline-XBRL headers and hidden blocks are dropped.
4. Keeps the links that `extractLinks` finds and writes `data/supplychain.json`.

Every link stores:

| field | what |
|---|---|
| `counterparty` | the other company's ticker, or `null` for an anonymised customer |
| `label` | the name as shown ("TSMC", "Customer A") |
| `relation` | what the counterparty is **to the filer**: `supplier`, `customer` or `competitor` |
| `named` | `false` when the filing names no one ("Customer A", "one customer") |
| `share` | the % of revenue, only when the sentence itself states it |
| `quote` | the exact sentence |
| `filing` | form, accession number, URL and filing date |
| `mentions` | how many sentences in the filing state the same link |

Each company also carries `asOf`, the date of the filing read. `_generated` is when the script last ran.

Nothing comes from press, a summary, a search result or a model. The repo's `check-no-llm-feeds` rule applies to this source like any other.

## How a sentence is read

The rules are written down in code (`linksInSentence`) and tested with fake companies (`test/supplyChain.test.mjs`).

- **Supplier:** a named company plus supplier wording ("rely on", "foundry", "wafers", "sole source", "contract manufacturer", "purchase from").
- **Customer:** a named company plus customer wording ("customer", "sales to", "accounted for N%"). A share is kept only when the sentence names one company and states one percentage of revenue.
- **Competitor:** a named company plus "compete", "competitor" or "competition".
- **Anonymised customer:** "Customer A accounted for 12%" or "one customer accounted for 21% of net sales". Letters and percentages must pair one to one, or nothing is kept.
- **Ambiguous:** left out. That covers a company that is a customer and a competitor in the same sentence, or a sentence with both supplier and customer wording. A missing link is better than a wrong one.

Company names match strictly. A bare "Arm" or "Flex" is an ordinary word, so only the full company name counts.

## What it can't do

- **Anonymised customers stay anonymised.** A filing that says "Customer A, 12%" doesn't say who A is. Naming A would take another primary filing that states it, quoted as its own link. The script never guesses.
- **Shares are rare.** Most filings name suppliers without amounts, and state revenue shares only for anonymised customers.
- **The map is one-sided until both companies are read.** A link stated by both companies' filings becomes one edge with two quotes, and draws heavier.
- **Only annual reports are read.** A supplier change disclosed in a 10-Q or 8-K appears at the next annual report.
- **Non-US companies that don't file with the SEC** (Samsung, SK hynix, Tokyo Electron) appear only as counterparties named in others' filings. Their own reports aren't read.

## Running it

```
SEC_USER_AGENT="Your Name you@example.com" node scripts/supplychain-build.mjs           # the whole universe
SEC_USER_AGENT="Your Name you@example.com" node scripts/supplychain-build.mjs NVDA MU   # some names
```

EDGAR's fair-access policy refuses requests without a contact address in the User-Agent, and asks for at most ten requests a second. The script reads the contact from `SEC_USER_AGENT`, never stores it, and spaces requests 200 ms apart.

When a company can't be read, it keeps its previous links and is listed under `missing` with the reason. Annual reports change once a year, so a quarterly run is enough.

## Reading the map (`lib/supplyChain.js`)

- `neighbours(data, ticker, { named })` returns suppliers, customers and competitors, heaviest first.
- `graph(data, centre, { depth: 1 | 2, named, competitors })` returns the nodes and edges around one company. The second ring follows the supply chain only; competitors are shown around the centre.
- `edgeWeight(edge)`: a stated revenue share sets the weight (10% → 1, capped at 3). Without one, a link both filings state weighs 2 and a one-sided link weighs 1.

The overlay of your own holdings is done in the browser from the Console. This file and the data it reads never see positions.
