// data/watchUniverse.js — the WATCHLIST universe: what the pre-read is allowed to look at.
//
// SEPARATE FROM `names` IN data/universe.js, AND DELIBERATELY SO. That list is the semiconductor
// book — it drives the NAMES block, the foundry/memory split, the AI axis and the leader stars, and
// widening it would corrupt every one of those. This list only feeds the watchlist, which asks a
// different question: what is worth looking at today.
//
// BY CORE TICKER, NOT BY VENUE. A name belongs to the region its underlying trades in, so nothing
// Hong Kong-listed reaches the US brief even though CSOP lists leveraged products on US stocks in
// Hong Kong, and vice versa.
//
// NO INDEX PRODUCTS AND NO LEVERAGED ONES AS ENTRIES. A leveraged product is a way to express a
// view on something else, so it belongs in the bracket beside its underlying — see data/adjacent.js
// — not as a line of its own. AMDL, IRE, RGTZ, TSLL and UNHG were all in the source list and were
// moved there rather than dropped.
//
// EVERY SYMBOL WAS RESOLVED AGAINST THE LIVE FEED before being written here, rather than assumed
// from its name. That caught two: the UAE names quote as .AE and not .DFM, and VF Corp is VFC.
//
// HELD OUT, because nothing here may be a symbol that returns no price:
//   0011.HK / 0011-OL.HK  Hang Seng Bank — neither form resolves through this project's price
//                         route, though Yahoo's own web UI accepts the second
//   FI                    Fiserv — does not resolve, cause unknown
//   FAB / ADNOC Gas / ADNOC Distribution / e&  — no ADX suffix tried resolves (.ADX, .AD, .AE)
//   The DFM names (DEWA, Salik, Parkin, Empower) resolve but are parked at the owner's request.
//
// REMOVED AS INDEX PRODUCTS, having arrived through the source list: IGLN.L (iShares Physical
// Gold), INFR.L (iShares Global Infrastructure), IWDP.L (iShares Developed Markets Property
// Yield), JEPG.L (JPM Global Equity Premium Income) and VHYL.L (Vanguard FTSE All-World High
// Dividend Yield). Every one is a basket tracking an index, and the rule at the top of this file
// admits no index products. DRAM stays: it was identified by name as the Roundhill Memory ETF and
// asked for specifically, and a single-theme fund is a view on that theme rather than on a market.
export const WATCH_UNIVERSE = Object.freeze({
  us: Object.freeze([
    'AAL',       'AAOI',      'AAPL',      'ACHR',      'ADBE',      'AEHR',      'AMAT',      'AMD',
    'AMZN',      'ARM',       'ASML',      'ASST',      'ASTS',      'AVGO',      'BABA',      'BLSH',
    'BMNR',      'BULL',      'BURU',      'BYND',      'CIFR',      'CMG',       'COIN',      'CRCL',
    'CRWD',      'CRWV',      'DDOG',      'DKNG',      'DRAM',      'DUOL',      'FFH.TO',    'FIG',
    'FRMI',      'GOOGL',     'GTLB',      'HIMS',      'HMC',       'HNST',      'HOOD',      'IBM',
    'INTC',      'IONQ',      'IREN',      'ISRG',      'JD',        'LCID',      'LLY',       'LULU',
    'MA',        'META',      'MRNA',      'MRVL',      'MSFT',      'MSTR',      'MU',        'NBIS',
    'NFLX',      'NKE',       'NOW',       'NVDA',      'NVO',       'OKLO',      'ONDS',      'OPEN',
    'ORCL',      'OSCR',      'PATH',      'PLTR',      'PYPL',      'QBTS',      'QCOM',      'RDDT',
    'RGTI',      'RIVN',      'RUM',       'RUN',       'SMR',       'SNOW',      'SOFI',      'STZ',
    'TER',       'TSLA',      'UNH',       'UPS',       'VFC',       'WMT',       'XPEV',      'ZETA',
  ]),
  eu: Object.freeze([
    // ── UK, LSE ──────────────────────────────────────────────────────────────
    'AV.L',      'AZN.L',     'BARC.L',    'BATS.L',    'BP.L',      'DGE.L',     'GLEN.L',    'GSK.L',
    'HSBA.L',    'LGEN.L',    'LSEG.L',    'NG.L',      'REL.L',     'RIO.L',     'RR.L',      'SHEL.L',
    'SSE.L',     'SVT.L',     'TSCO.L',    'ULVR.L',    'UU.L',
    // ── Netherlands, Euronext Amsterdam ──────────────────────────────────────
    // THE EU LIST WAS ENTIRELY BRITISH. Every one of the sixteen entries was an LSE line, so the
    // European watchlist could not surface ASML on a day ASML moved — while the same brief quoted
    // ASML three lines below in its own NAMES block. Six of this region's names sat in
    // data/universe.js and none of them was scannable.
    'AD.AS',     'ADYEN.AS',  'ASM.AS',    'ASML.AS',   'BESI.AS',   'HEIA.AS',   'INGA.AS',   'PHIA.AS',
    // ── France, Euronext Paris ───────────────────────────────────────────────
    'AIR.PA',    'BNP.PA',    'CAP.PA',    'DG.PA',     'MC.PA',     'OR.PA',     'RMS.PA',    'SAF.PA',
    'SAN.PA',    'STMPA.PA',  'SU.PA',     'TTE.PA',
    // ── Germany, XETRA ───────────────────────────────────────────────────────
    'ALV.DE',    'BAS.DE',    'BMW.DE',    'DBK.DE',    'DTE.DE',    'IFX.DE',    'MBG.DE',    'MUV2.DE',
    'RHM.DE',    'SAP.DE',    'SIE.DE',    'VOW3.DE',
  ]),
  asia: Object.freeze([
    '0002.HK',   '0003.HK',   '0005.HK',   '0006.HK',   '000660.KS', '0008.HK',   '0066.HK',   '0386.HK',
    '042700.KS', '0823.HK',   '0857.HK',   '0883.HK',   '0939.HK',   '0941.HK',   '0981.HK',   '1038.HK',
    '1398.HK',   '6823.HK',   'A17U.SI',   'CJLU.SI',   'D05.SI',    'M44U.SI',   'O39.SI',    'S63.SI',
    'U11.SI',    'Z74.SI',
    // ── Korea ────────────────────────────────────────────────────────────────
    // 005930 SAMSUNG WAS MISSING. It sits in this region's own `names` block in data/universe.js
    // and in data/adjacent.js (7747/7347.HK on both sides), and the watchlist — the one thing that
    // decides what gets looked at — could not see it. SK Hynix came through the source list and
    // Samsung did not, which is an accident of what was in the images rather than a judgement.
    '005930.KS', '005380.KS', '000270.KS', '035420.KS', '035720.KS', '051910.KS', '068270.KS',
    '105560.KS', '207940.KS', '373220.KS',
    // ── Japan ────────────────────────────────────────────────────────────────
    // A LARGER HOLE THAN SAMSUNG: there was not one Japanese name here. The Asia brief quotes the
    // Nikkei in its indices and its watchlist could never surface anything that moved it. Local
    // primary listings on the JPX, same rule as everywhere else — no ADRs, no US wrappers.
    // Chosen to cover the ground the rest of the list covers: chip equipment, tech megacaps,
    // autos, trading houses, banks, industrials.
    '4063.T',    '4502.T',    '6098.T',    '6146.T',    '6301.T',    '6501.T',    '6702.T',    '6758.T',
    '6857.T',    '7011.T',    '7203.T',    '7267.T',    '7974.T',    '8031.T',    '8035.T',    '8058.T',
    '8306.T',    '8316.T',    '9983.T',    '9984.T',
    // ── Taiwan ───────────────────────────────────────────────────────────────
    '2308.TW',   '2317.TW',   '2330.TW',   '2412.TW',   '2454.TW',   '2881.TW',   '3008.TW',
  ]),
});

// Flat lookup, for asserting that a symbol reaching the watchlist came from here.
export const IN_WATCH_UNIVERSE = Object.freeze(
  new Set(Object.values(WATCH_UNIVERSE).flat())
);
