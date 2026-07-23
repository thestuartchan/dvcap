// universe.js — single source of truth for what each region watches.
// Roles drive the regime engine. Foundry is split by node/segment because leading-edge,
// mature-node, and analog/auto diverge violently (2026-07-23: STMicro -15.2%, TSMC -0.2%,
// SMIC -2.9%, Hua Hong -7.0% — not one category):
//   'foundry-leading' | 'foundry-mature' | 'analog' | 'memory' | 'litho' | 'equip'
//   | 'gpu' | 'megacap' | 'index'
// ROLE_META (below) carries each role's display label + AI-levered flag.
// leader:true = a regional bellwether used for cross-market confirmation.

export const UNIVERSE = {
  asia: {
    label: 'Asia',
    tz: 'Asia/Hong_Kong',
    prereadHourLocal: 7,          // 07:00 HKT = pre-market brief, before Korea/Japan (08:00 HKT / 09:00 local) open. HK/KR/TW/JP keep no DST, so 23:00 UTC maps here year-round.
    names: [
      { sym: '0981.HK',   name: 'SMIC',        role: 'foundry-mature',  leader: true  },
      { sym: '1347.HK',   name: 'Hua Hong',    role: 'foundry-mature'                 },
      { sym: '0522.HK',   name: 'ASMPT',       role: 'equip'                          },
      { sym: '6082.HK',   name: 'Biren',       role: 'gpu'                            },
      { sym: '0700.HK',   name: 'Tencent',     role: 'megacap'                        },
      { sym: '9988.HK',   name: 'Alibaba',     role: 'megacap'                        },
      { sym: '1810.HK',   name: 'Xiaomi',      role: 'megacap'                        },
      { sym: '1211.HK',   name: 'BYD',         role: 'megacap'                        },
      // regional leaders (print before/with HK)
      { sym: '2330.TW',   name: 'TSMC',        role: 'foundry-leading', leader: true  },
      { sym: '000660.KS', name: 'SK Hynix',    role: 'memory',   leader: true  },
      { sym: '005930.KS', name: 'Samsung',     role: 'memory',   leader: true  },
    ],
    indices: [
      { sym: '^HSI',    name: 'HSI'    },
      { sym: 'HSTECH.HK', name: 'HSTECH' },
      { sym: '^KS11',   name: 'KOSPI'  },
      { sym: '^N225',   name: 'Nikkei' },
    ],
  },

  eu: {
    label: 'Europe',
    tz: 'Europe/London',
    prereadHourLocal: 9,          // ~09:00 London, into the EU open
    names: [
      { sym: 'ASML.AS',  name: 'ASML',    role: 'litho',   leader: true },
      { sym: 'ASM.AS',   name: 'ASM Intl',role: 'equip'                },
      { sym: 'BESI.AS',  name: 'BE Semi', role: 'equip'                },
      { sym: 'STMPA.PA', name: 'STMicro', role: 'analog',  leader: true },
      { sym: 'SAP.DE',   name: 'SAP',     role: 'megacap'             },
      { sym: 'SIE.DE',   name: 'Siemens', role: 'megacap'             },
    ],
    indices: [
      { sym: '^STOXX50E', name: 'STOXX 50' },
      { sym: '^GDAXI',    name: 'DAX'      },
      { sym: '^FTSE',     name: 'FTSE 100' },
    ],
  },

  us: {
    label: 'US',
    tz: 'America/New_York',
    prereadHourLocal: 9,          // ~09:00 ET, pre-open
    names: [
      { sym: 'NVDA', name: 'NVDA', role: 'gpu',             leader: true },
      { sym: 'MU',   name: 'MU',   role: 'memory',          leader: true },
      { sym: 'TSM',  name: 'TSM',  role: 'foundry-leading', leader: true },
      { sym: 'INTC', name: 'INTC', role: 'foundry-leading'              },
      { sym: 'ARM',  name: 'ARM',  role: 'gpu'                          },
      // analog / auto IDM — US read-across for an STMicro guide/miss
      { sym: 'TXN',  name: 'TXN',  role: 'analog'                       },
      { sym: 'ADI',  name: 'ADI',  role: 'analog'                       },
      { sym: 'NXPI', name: 'NXP',  role: 'analog'                       },
      { sym: 'AMZN', name: 'AMZN', role: 'megacap'                      },
      { sym: 'GOOGL',name: 'GOOGL',role: 'megacap'                      },
    ],
    indices: [
      { sym: 'QQQ',  name: 'QQQ'  },
      { sym: 'SOXX', name: 'SOXX' },
      { sym: 'SMH',  name: 'SMH'  },
      { sym: '^VIX', name: 'VIX'  },
    ],
  },
};

// Role metadata: display label + AI-levered flag (ai:true = AI-capex recipient; false =
// mature/analog/auto; null = not on the AI axis). Drives category grouping and the
// AI-levered-vs-non-AI regime axis. Keep in sync with the roles used in UNIVERSE above.
export const ROLE_META = {
  'foundry-leading': { label: 'Leading-edge foundry', short: 'lead foundry',   ai: true  },
  'foundry-mature':  { label: 'Mature-node foundry',  short: 'mature foundry', ai: false },
  'analog':          { label: 'Analog / Auto IDM',    short: 'analog/auto',    ai: false },
  'memory':          { label: 'Memory',               short: 'memory',         ai: true  },
  'litho':           { label: 'Litho',                short: 'litho',          ai: true  },
  'equip':           { label: 'Equipment',            short: 'equip',          ai: true  },
  'gpu':             { label: 'GPU / accelerator',    short: 'gpu',            ai: true  },
  'megacap':         { label: 'Megacap',              short: 'megacap',        ai: null  },
  'index':           { label: 'Index',                short: 'index',          ai: null  },
};

// Global macro gauges — same dashboard for every region.
export const MACRO = [
  { key: 'wti',   name: 'WTI',   source: 'oil'  },
  { key: 'brent', name: 'Brent', source: 'oil'  },
  { key: 'us2y',  name: 'US 2Y', source: 'fred', series: 'DGS2'  },
  { key: 'us10y', name: 'US 10Y',source: 'fred', series: 'DGS10' },
  { key: 'oas',   name: 'HY OAS',source: 'fred', series: 'BAMLH0A0HYM2' },
];
