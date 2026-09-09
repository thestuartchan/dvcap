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
    'AV.L',      'BATS.L',    'BP.L',      'DGE.L',     'IGLN.L',    'INFR.L',    'IWDP.L',    'JEPG.L',
    'LGEN.L',    'NG.L',      'SHEL.L',    'SSE.L',     'SVT.L',     'ULVR.L',    'UU.L',      'VHYL.L',
  ]),
  asia: Object.freeze([
    '0002.HK',   '0003.HK',   '0005.HK',   '0006.HK',   '000660.KS', '0008.HK',   '0066.HK',   '0386.HK',
    '042700.KS', '0823.HK',   '0857.HK',   '0883.HK',   '0939.HK',   '0941.HK',   '0981.HK',   '1038.HK',
    '1398.HK',   '2330.TW',   '6823.HK',   'A17U.SI',   'CJLU.SI',   'D05.SI',    'M44U.SI',   'O39.SI',
    'S63.SI',    'U11.SI',    'Z74.SI',
  ]),
});

// Flat lookup, for asserting that a symbol reaching the watchlist came from here.
export const IN_WATCH_UNIVERSE = Object.freeze(
  new Set(Object.values(WATCH_UNIVERSE).flat())
);
