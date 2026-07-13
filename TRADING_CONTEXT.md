# TRADING_CONTEXT.md — why this tool is shaped this way

Context for anyone (human or Claude Code) building dvcap-macro. This is the *trading logic*
the tool encodes. You don't need to trade to build it, but the data model and the regime
engine only make sense against this. Read once before touching `regime.js` or `universe.js`.

---

## The operator
Macro/semi trader, currently rotating across timezones (extended stint in Asia, trades
globally). Home tape is US semis + index (QQQ/NQ, SOXX, NVDA, MU, TSM) and short-dated
options; expanding to Asia (HK/China + Korea/Taiwan/Japan leaders) and EU (ASML complex).
Runs a defensive, dry-powder posture. The tool exists to make trading *any* region
sustainable without living on US hours.

## The core edge (what the tool must serve)
Not a strategy — a **process**: macro/semi tape-reading, level discipline, cross-market
confirmation, and knowing when NOT to trade. The tool's job is to surface the read fast,
region-aware, so the operator can act (or correctly not act). It is a decision scaffold,
never a signal generator.

## The framework the regime engine encodes

### 1. The session relay (why regions are chained)
Markets lead each other around the clock: Korea → Japan → Taiwan → HK → Europe → US → back
to Asia. Each region opens holding the last one's information. So the tool reads regional
LEADERS (Hynix/Samsung for memory, TSMC/SMIC for foundry, ASML for litho, NVDA/MU for US)
to confirm or diverge before trading any single name. `leader:true` in universe.js marks these.

### 2. Memory vs Foundry (the live sub-sector axis)
The semi complex is not monolithic. Memory (Hynix, Samsung, MU) and foundry (TSMC, SMIC,
Hua Hong) decouple hard. `memoryVsFoundry()` computes the spread of avg %change between the
two role buckets:
- spread ~0 → moving together (broad semi move)
- foundry >> memory → "memory-specific weakness" (e.g. Jul 13: foundry −0.15% vs memory −4.2%)
- memory >> foundry → "foundry-specific weakness"
This tag tells the operator whether to trade the index or the split. It is the single most
important computed output. It must come from arithmetic, never the model.

### 3. Region-idiosyncratic vs global-AI
Each region has a local driver that can override the global cycle: Asia = China policy /
Southbound flow / PBOC; EU = ECB + energy sensitivity; US = the Fed. When a local narrative
dominates, that region decouples (Jul 13: HK +0.5% while Korea bled −2.6%). The tool reads
LEADERS for the global signal, the local INDEX for the idiosyncratic one.

### 4. The credit anchor (the regime arbiter)
A selloff is a *correction* until credit confirms it's a *regime break*. `creditState()` reads
US HY OAS: <2.8 calm, <3.0 watch, <3.5 defending, >3.5 stress ("Path-2"). This is the master
gate — no amount of equity weakness flips the regime until credit widens. Asia adds a China-
property-credit channel; EU adds spreads. OAS is FRED-daily, so ALWAYS flagged "last hard print."

### 5. The oil → yields → AI-valuations transmission
The dominant cross-asset macro trade: oil up + US 2Y breaking higher = "higher for longer" =
hits high-multiple AI names hardest, in every region. `oilRead()` tracks WTI vs the 73.08
pivot: holding above = inflation impulse building; can't hold = no breakout yet. Same trade
in Seoul, Amsterdam, New York — one dashboard, three regions.

## Vehicles by region (why the tool is data-first, not options-first)
- US: deep options (incl. 0-DTE), NQ/ES futures. The catalyst book.
- Asia: cash equities (core) + HSI/HSTECH futures. No 0-DTE; weeklies thin. Swing tempo.
- EU: cash equities (ASML) + DAX/STOXX futures.
The tool is instrument-agnostic — it surfaces the read; the operator picks the vehicle.
This is why the data model is quotes+regime, not order/position management.

## The Pre-Read (the daily deliverable, now automated)
Region-by-region market summary posted to Discord at each regional open. HARD content rules
(baked into preread.js system prompt — do not relax):
- Research and data ONLY.
- NEVER mention the operator's portfolio, positions, or theses. (These summaries go to a
  community; they must be clean market data, not personal.)
- No instructional guidance ("don't short X" / "don't buy Y").
- No disclaimers, no "not advice" footers.
- Terse, punchy, scannable. Lead with the single most important thing.

## Data discipline (learned the hard way, encode it)
- Every print carries a `stale` flag; the Pre-Read shows ⚠️ on stale data. NEVER launder a
  stale/last-close number into a clean live-looking one. Tag the source and timestamp.
- Provider fallback cascade: FMP (equities) → isolated oil source → FRED (yields/OAS) →
  web as last resort. FMP commodity is plan-gated (the oil gap). FMP index MAs are garbage
  (KOSPI returned nonsense) — don't trust index MAs from FMP.
- Cross-check timestamps: Asian/EU/US markets are open at different times; a "live" call on a
  closed market returns the last close. The tool must know which markets are open (timezone
  engine, roadmap layer 3) and flag accordingly.

## What the tool is NOT
- Not a signal generator or auto-trader. Decision scaffold only.
- Not a position/PnL tracker (that's the separate Google Sheet + IBKR).
- Not a backtester. It's a live situational-awareness surface.
```

