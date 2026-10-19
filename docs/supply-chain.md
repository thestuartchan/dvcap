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

The rules are written down in code (`linksInSentence`) and tested with fake companies (`test/supplyChain.test.mjs`). A keyword next to a name is not enough: the first real run over the 28 annual reports showed "customers" beside any company ("Intel targets our customers"), "supplier" in a director's biography, "competitive" in "competitive advantage", and supplier wording about someone else's suppliers. So the name has to sit where the wording points.

- **Supplier:** the filer speaks about itself (we / our / the Company), and the name is in the list after "foundries / suppliers / contract manufacturers … such as / include / are", or follows "manufactured by", "rely on", "purchase … from", or "we use / utilize …" in a sentence about wafers, manufacturing, assembly or packaging. Hypotheticals ("would shift to", "capable of producing") and co-ownership ("jointly owned by") are not supply.
- **Customer:** the name is in the list after "customers include / included / are / (for example, …)", or follows "sales to" / "revenues from", or "our top / largest customer, X", or "X, which is a major customer", or "X accounted for N%". A share is kept only when the sentence names one company and states one percentage of revenue, and not a threshold ("10% or more").
- **Competitor:** a named company plus "compete", "competitor", "competition" or "competitive products", with no supplier or customer wording in the sentence. "Competitive advantage / position / landscape", "highly competitive" and "anti-competition claims" don't count.
- **Anonymised customer:** "Customer A accounted for 12%", "sales to one direct customer represented 22% … another direct customer 14%", "two customers accounted for 19% and 15%, respectively", "one of our end customers accounted for 12%", "our largest customer in 2023, 2024 and 2025 accounted for 25%, 22% and 19%". Labels and percentages must pair one to one. Across years, only the latest year is kept; when the newest year's sentence can't be paired up, older years are dropped rather than shown as current. Thresholds, groups ("top five customers") and receivables are skipped.
- **Ambiguous:** left out. A name the sentence makes both a supplier and a customer, or a supplier/customer and a competitor (Intel's "tiles manufactured by TSMC, a key competitor"), is dropped from that sentence. A missing link is better than a wrong one.
- **Sentences:** a full stop after "Inc." / "Ltd." / "Corp." doesn't end a sentence when what follows is a bracket or the next company of a list.

Company names match strictly. A bare "Arm" or "Flex" is an ordinary word, so only the full company name counts.

## What it can't do

- **Anonymised customers stay anonymised.** A filing that says "Customer A, 12%" doesn't say who A is. Naming A would take another primary filing that states it, quoted as its own link. The script never guesses.
- **Shares are rare.** Most filings name suppliers without amounts, and state revenue shares only for anonymised customers.
- **The map is one-sided until both companies are read.** A link stated by both companies' filings becomes one edge with two quotes, and draws heavier.
- **Only annual reports are read.** A supplier change disclosed in a 10-Q or 8-K appears at the next annual report.
- **Non-US companies that don't file with the SEC** (Samsung, SK hynix, Tokyo Electron) appear only as counterparties named in others' filings. Their own reports aren't read.
- **Only the counterparty table is recognised.** A supplier the table doesn't list (Fabrinet, SPIL, Xiaomi, Sony) is not a link, even when the sentence is clear.
- **Plain statements only.** A relationship the filing implies but doesn't state in one sentence (Microsoft as AMD's console customer, Amazon as Vistra's power buyer) is missed on purpose.

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

- `mapFor(data, ticker)` is what the ticker page's card draws: the three roles, whether the company's own filing was read, and why there is nothing when there is nothing.

## On the ticker page

`src/SupplyChainCard.jsx` fills the `data-slot="supply-chain"` card on Tickers › Ticker. `data/supplychain.json` is bundled with the page (no API call, no Vercel function). Suppliers on the left, customers on the right, competitors below. A company's name re-centres the map on it; its “” opens the sentence and a link to the filing. Anonymised customers are dashed and labelled; a % shows only where the filing states one.

The "held" tint is worked out in the browser from the Console rows that page already loaded behind the login. It is never written to this file, the JSON, a log or a request.
