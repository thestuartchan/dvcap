// lib/assets.js — the insurance-asset universe.
//
// Pure data, extracted from App.jsx so it can be shared: the Console reads it to tell whether a
// traded symbol overlaps the insurance book, and the Insurance tab ranks it by regime. Moving it
// here keeps a 100-line constant out of the component file and gives both consumers one source.

// ─── INSURANCE ASSETS ─────────────────────────────────────────────────────────
// The best→worst bar ranks these six by macro regime (stagRank/defRank/refRank/infRank). Cross-tab
// consistency with the SCENARIO_MATRIX, audited Aug-20:
//   • stag ↔ matrix `stag` column, def ↔ matrix `def` column — DIRECT maps. The bar order follows the
//     matrix glyphs (✅✅>✅>⚠️>❌), ties broken by 2022 evidence. stag: gold>staples>miners>farmland>btc>tlt.
//     def: tbonds>gold>staples>miners>farmland>btc.
//   • inf = Inflationary BOOM — explicitly NOT the matrix `inf` (=Debasement crisis) column, so ranked by
//     regime logic: gold>btc>miners>farmland>staples>tbonds (real assets win, miners cap below physical
//     gold per B1, the leveraged farmland REIT lags the metals, bonds toxic).
//   • ref = Reflationary Growth — a benign regime with no matrix column. Miners lag BY DESIGN (the gold
//     safe-haven bid fades), so here alone farmland outranks miners; staples/farmland lead.
// Invariant: the farmland REIT sits BELOW the gold-linked miners in every regime except reflationary
// growth (2022: GDX −9% vs FPI −14%), and miners NEVER outrank physical gold anywhere.
export const ASSETS = [
  {
    // Aug-20 Part B — Physical Gold is its own asset, distinct from miners (which only ever
    // EXPRESS a gold view, with equity beta). The primary real-asset hold; ranks above miners in
    // every regime. Matches the SCENARIO_MATRIX, which already separates GLD from GDX.
    id:"gold", name:"Physical Gold", icon:"🥇", color:"#B45309", bg:"#FFFBEB", bdr:"#FDE68A",
    stagRank:1, defRank:2, refRank:4, infRank:1, volatility:"MED",
    stagNote:"The classic stagflation hedge — monetary, no growth dependency (1970s: $35 → ~$850). The primary real-asset hold; miners are only a cautioned, leveraged expression of it.",
    crisisScore:80, inflationScore:88, deflationScore:60, liquidityScore:55, stagScore:90,
    verdict:"THE debasement + stagflation hedge. Held value where miners collapsed (2008). SOLD in a liquidity dash-for-cash (−12% over 8 sessions, Mar 2020), then rips. Sits above miners in every regime.",
    tickers:[
      {t:"GLD",     name:"SPDR Gold Trust",       type:"ETF", note:"Largest, most liquid. 0.40% fee."},
      {t:"IAU",     name:"iShares Gold Trust",    type:"ETF", note:"Lower fee (0.25%). Same physical exposure."},
      {t:"SGOL",    name:"abrdn Physical Gold",   type:"ETF", note:"Swiss-vaulted. 0.17% fee — cheapest."},
      {t:"2840.HK", name:"SPDR Gold Trust (HK)",  type:"ETF", note:"HKD-pegged, zero HK withholding tax. Use via IBKR HK account.", link:"https://www.hkex.com.hk"},
    ],
  },
  {
    id:"miners", name:"Gold Miners", icon:"⛏️", state:"WATCH",
    // P0.3 + Aug-20 B1 — miners NEVER rank above physical gold, in any regime. Evidence: GDX lagged
    // GLD ~6.5%/yr since 2006 (~−350% cumulative), worst during equity crises; ~2× the volatility,
    // asymmetric; the "2–3×" is sell-side convention (only ~1.2× realised through 2023–25). Even in a
    // pure gold bull (debasement) they merely MATCH gold while carrying equity beta. So they sit below
    // Physical Gold everywhere — including a demotion from #1 in Inflationary Boom to #4.
    stagRank:3, defRank:4, refRank:5, infRank:3, volatility:"HIGH",
    stagNote:"⚠️ Cautioned in stagflation — miners are equities with operating leverage to gold (equity beta, sold in liquidity events: GDX fell ~70% in 2008). The stagflation hedge is physical gold (GLD / 2840.HK); miners are a leveraged, cautioned expression of the view, not a hedge. Add only after a VIX peak confirms the liquidity phase has passed. Rank #3 only because they stay gold-linked (2022: GDX ~−9% vs the farmland REIT −14% and BTC −64%) — not a promotion to hedge status.",
    crisisScore:70, inflationScore:82, deflationScore:30, liquidityScore:40, stagScore:50,
    verdict:"A leveraged EXPRESSION of gold, never a substitute — it has lagged GLD ~6.5%/yr since 2006 and is worst in crises. Even in a debasement bull it only matches gold while carrying equity beta, dilution and cost inflation. Physical gold is the hedge; miners never rank above it.",
    tickers:[
      {t:"GDX",  name:"VanEck Gold Miners ETF",     type:"ETF",   note:"Best entry. $33B AUM, 57 miners. Top: AEM, NEM, ABX."},
      {t:"GDXJ", name:"VanEck Junior Gold Miners",  type:"ETF",   note:"Higher beta. More upside, more volatile."},
      {t:"RING", name:"iShares MSCI Global Gold",   type:"ETF",   note:"Lower fee (0.39%). Concentrated in top 3 miners."},
      {t:"AEM",  name:"Agnico Eagle Mines",          type:"Stock", note:"Highest quality senior miner. Strong balance sheet."},
      {t:"NEM",  name:"Newmont Corporation",         type:"Stock", note:"World's largest miner. Dividend payer."},
      {t:"ABX",  name:"Barrick Mining (fmr GOLD)",  type:"Stock", note:"#2 global miner. 5 continents."},
      {t:"WPM",  name:"Wheaton Precious Metals",    type:"Stock", note:"Streaming model — lower operating risk."},
      {t:"2840.HK", name:"SPDR Gold Trust HK",     type:"ETF",   note:"Physical gold ETF on HKEX. HKD/USD pegged = no FX drag vs GLD. Zero HK withholding tax. Use if holding via IBKR HK account.", link:"https://www.hkex.com.hk"},
    ],
    regionalNote:"Physical Gold (Dubai): 0% VAT on gold purchases in UAE. Available via Dubai Gold Souk, DMCC dealers, or Emirates NBD/ADCB gold savings accounts. No FX risk given AED/USD peg. Best local debasement hedge for UAE residents.",
  },
  {
    id:"farmland", name:"Farmland REIT", icon:"🌾", state:"BENIGN",
    // Aug-20 B4 + Recovery-brief D — ONE definition: the investable instrument (FPI / LAND) is a
    // small-cap farmland REIT, not raw farmland. So it is RATE-SENSITIVE — it trades like small-cap
    // REITs regardless of the underlying acreage. The decisive test is 2022: the unleveraged NCREIF
    // land index returned +9.64% while FPI FELL >14%. The wrapper does not deliver the land's inflation
    // hedge — so it drops below miners in stagflation (#4, not #3). NCREIF itself is not investable here.
    stagRank:4, defRank:5, refRank:3, infRank:4, volatility:"MED",
    stagNote:"The REIT is NOT the land. FPI/LAND are small-cap, leveraged, rate-sensitive REITs: in 2022 (the closest stagflation test) the unleveraged NCREIF land index returned +9.64% while FPI fell >14%. Real-value protection is capped by the wrapper — below physical gold, energy and even the gold-linked miners in a stagflation.",
    crisisScore:55, inflationScore:80, deflationScore:45, liquidityScore:55, stagScore:60,
    verdict:"A small-cap farmland REIT (FPI / LAND) — real-asset exposure diluted by REIT rate-sensitivity, leverage and small-cap beta. NOT a proxy for the land: 2022 the NCREIF index rose +9.64% while FPI fell. Extra return drivers unrelated to farmland — NAV discount (FPI 25–30%) and US-situs estate exposure. Below gold, energy and miners as a stagflation hedge; sold in a hawkish repricing.",
    tickers:[
      {t:"LAND", name:"Gladstone Land",    type:"REIT", note:"Berry & vegetable farms. ~$350M cap. Thinly traded."},
      {t:"FPI",  name:"Farmland Partners", type:"REIT", note:"Row-crop (corn, soy, wheat). Geographic diversity."},
    ],
  },
  {
    id:"tbonds", name:"Treasury Bonds", icon:"🏛️", color:"#1E40AF", bg:"#EFF6FF", bdr:"#BFDBFE",
    // Aug-20 — the best asset in a deflationary recession (#1), the worst in stagflation / hawkish
    // repricing / inflationary boom (rising yields crush duration). Re-ranked with Physical Gold added.
    stagRank:6, defRank:1, refRank:6, infRank:6, volatility:"MED",
    stagNote:"WORST stagflation asset. Inflation erodes real value; rate hikes crush price. TLT lost 30%+ in 2022.",
    crisisScore:75, inflationScore:20, deflationScore:95, liquidityScore:95, stagScore:10,
    verdict:"Works in deflation/growth-scare recessions (2008, 2020). Fails in stagflation. Know your recession type first.",
    tickers:[
      {t:"TLT",  name:"iShares 20+ Year Treasury", type:"ETF", note:"Max duration. ~16% price sensitivity per 1% rate move."},
      {t:"IEF",  name:"iShares 7-10 Year Treasury",type:"ETF", note:"Lower duration alternative to TLT. Use if uncertain about crash depth or speed of recovery. 100bps cut ≈ 7-8% NAV appreciation vs TLT's 15-18%. Less reward, less risk."},
      {t:"ZROZ", name:"PIMCO 25+ Zero Coupon",     type:"ETF", note:"Maximum duration. High conviction rate cut only."},
      {t:"BIL",  name:"SPDR 1-3 Month T-Bill",     type:"ETF", note:"Essentially cash. Yield tracks the T-bill curve — see the Income tab for the live rate."},
    ],
  },
  {
    id:"staples", name:"Consumer Staples", icon:"🛒", color:"#5B21B6", bg:"#F5F3FF", bdr:"#C4B5FD",
    // Aug-20 B2 — the best defensive EQUITY in stagflation (pricing power, non-discretionary demand),
    // but that is a narrower claim than "top hold": gold and energy are the primary hedges (2022: XLE
    // +64%, XLP ~−3%). So #2 behind Physical Gold in stagflation. Best defensive in reflationary growth.
    stagRank:2, defRank:3, refRank:1, infRank:5, volatility:"LOW",
    stagNote:"Best defensive EQUITY in stagflation — brand pricing power passes through inflation, non-discretionary demand holds. But gold and energy outrank it as the primary hedges; staples are adequate, not standout (2022: XLE +64%, XLP ~−3%).",
    crisisScore:75, inflationScore:60, deflationScore:70, liquidityScore:90, stagScore:75,
    verdict:"Most reliable defensive sector. Brands = pricing power. Non-discretionary = recession-proof demand.",
    tickers:[
      {t:"XLP",  name:"Consumer Staples SPDR",    type:"ETF",   note:"Best ETF. Top 5: PG, COST, KO, PEP, PM."},
      {t:"PG",   name:"Procter & Gamble",          type:"Stock", note:"69yr dividend streak. Dividend King."},
      {t:"KO",   name:"Coca-Cola",                 type:"Stock", note:"Berkshire #3. 2.7% yield. 100+ yr brand."},
      {t:"PEP",  name:"PepsiCo",                   type:"Stock", note:"Frito-Lay diversification. Aristocrat."},
      {t:"WMT",  name:"Walmart",                   type:"Stock", note:"Recession beneficiary — budget trade-down."},
      {t:"COST", name:"Costco",                    type:"Stock", note:"Membership = sticky revenue."},
      {t:"MDLZ", name:"Mondelez",                  type:"Stock", note:"Global snacks. 3.5% dividend."},
    ],
  },
  {
    id:"btc", name:"Bitcoin", icon:"₿", color:"#F7931A", bg:"#FFF8F0", bdr:"#F7931A",
    // Aug-20 B7 — the debasement correlation is real but YOUNG (~2yr consistent); −50% in 48h (Mar
    // 2020), −64% through 2022. Correct direction, thin evidence — so it sits below Physical Gold in
    // debasement / inflationary boom, not alongside it.
    stagRank:5, defRank:6, refRank:2, infRank:2, volatility:"VERY HIGH",
    stagNote:"Mixed in stagflation — debasement tailwind, but risk-off selloffs hit it hard (−64% through 2022, the deepest drawdown of any bar asset). Shines only once panic clears and the dollar-credibility narrative takes over. Short (~2yr) debasement track record.",
    crisisScore:40, inflationScore:85, deflationScore:20, liquidityScore:90, stagScore:55,
    verdict:"Hardest debasement hedge in existence — fixed supply, no central bank, no balance sheet. Best in class if the thesis is dollar credibility loss or Fed balance sheet explosion. Critical caveat: in a liquidity crisis onset (2008-style, March 2020-style), BTC sells off WITH equities — it dropped 50% in 48 hours in March 2020. It is NOT crash protection. It is post-crash, post-panic, debasement-phase protection. Correlation to Nasdaq in risk-off stress periods remains ~0.6–0.7. Size as high-conviction, long-horizon, volatile insurance — meaningful but not dominant.",
    uaeBenefit:"No UAE capital gains tax on crypto. AED/USD peg means no FX drag. IBKR Singapore supports BTC exposure via IBIT ETF.",
    tickers:[
      {t:"IBIT",    name:"iShares Bitcoin Trust",       type:"ETF",    note:"BlackRock ETF. Most liquid US access to BTC. $50B+ AUM. Use this over direct BTC for IBKR trading."},
      {t:"BTC-USD", name:"Bitcoin spot",                type:"Crypto", note:"Direct spot via Binance or Hyperliquid. Use for sizing beyond ETF or for crypto-native accounts."},
      {t:"FBTC",    name:"Fidelity Wise Origin Bitcoin",type:"ETF",    note:"Alternative to IBIT. Slightly lower expense ratio. Same exposure."},
    ],
  },
];
