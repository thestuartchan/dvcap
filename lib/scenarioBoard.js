// lib/scenarioBoard.js — the scenario board, rebuilt on settled closes and 20-session trends.
//
// WHY IT WAS REBUILT (2026-09-25). On the day this was written the old board had no usable finding
// at all: C and D UNSCORED, A and B UNVERIFIED, KM UNREADABLE, CP BROKEN on one leg — and every card
// read "just turned" on every refresh. Three causes, all structural:
//
//   1. THE HORIZON WAS WRONG. The header said WEEKS; A and B were scored on ONE-DAY moves in TLT and
//      the 10s30s curve, so they flipped with each day's tape.
//   2. THE SOURCES DISAGREED. Legs mixed a live quote, a delayed Treasury print and an end-of-day
//      spread, so a guard correctly withheld the mark ("unscored", "observation dates disagree")
//      most of the time.
//   3. THERE WAS NO MEMORY. "Since when" needs the previous reading and none was kept.
//
// THE NEW RULES. Every leg is scored on the SAME settled daily close, from one source (Yahoo daily
// bars), on the SPY session calendar — so there is one as-of date for the whole board and nothing
// to disagree. Every leg is a 20-SESSION trend measured in the series' own volatility:
//
//     z = (20-session change) / (σ of daily changes over 60 sessions × √20)
//
// log changes for prices, differences for yields and spreads. A leg switches ON at |z| ≥ 0.5 in its
// direction and OFF only when it fades below 0.25 — hysteresis, so a trend sitting on the line does
// not flicker. And because every input is a bar series, the board's HISTORY is recomputed from the
// same bars: the 20-session strip and "active since" need no stored state.
//
// STATES. ACTIVE — every leg met. BUILDING — at least half the DIRECTIONAL legs met (a permissive
// leg like "credit not cracking" is usually true and must not make every scenario look half-built).
// QUIET — otherwise. NO DATA — a leg's series is missing.
//
// Observation, not instruction: `consequence` is the book's own note on what a scenario means for
// it, carried to the posture card as before.
import { positionAt } from './cta.js';

export const WINDOW = 20;
export const VOL_LOOKBACK = 60;
export const ENTER = 0.5;
export const EXIT = 0.25;
export const HISTORY = 60;
export const STRIP = 20;
export const CTA_CUT_ENTER = -0.25;   // replica down this much over 5 sessions: trend funds cutting
export const CTA_CUT_EXIT = -0.10;
export const CTA_ADD_ENTER = 0.25;    // …and up this much: trend funds adding back
export const CTA_ADD_EXIT = 0.10;
export const CTA_LOW_ENTER = 0.20;    // replica at or under this: little equity left to sell
export const CTA_LOW_EXIT = 0.30;
export const SHORT = 5;               // the short window the recovery legs read

// The series the legs read. `sym` is one bar series; `spread` is a − b; `ratio` is a / b (log).
export const SERIES = Object.freeze({
  TLT:    { sym: 'TLT', kind: 'log', label: 'TLT' },
  // CREDIT, NOT RATES. HYG alone falls when Treasury yields rise — on 2026-09-24 it read −2.5σ over
  // 20 sessions while the 5Y was up 3.1σ and spreads were calm, which scored a rates move as a
  // credit crack. Against IEI (3–7y Treasuries, a similar duration) the rate move cancels and what
  // is left is the spread.
  CREDIT: { ratio: ['HYG', 'IEI'], kind: 'log', label: 'High yield vs Treasuries' },
  SPY:    { sym: 'SPY', kind: 'log', label: 'S&P 500' },
  QQQ:    { sym: 'QQQ', kind: 'log', label: 'Nasdaq 100' },
  SMH:    { sym: 'SMH', kind: 'log', label: 'Semis (SMH)' },
  GLD:    { sym: 'GLD', kind: 'log', label: 'Gold' },
  OIL:    { sym: 'CL=F', kind: 'log', label: 'WTI crude' },
  DXY:    { sym: 'DX-Y.NYB', kind: 'log', label: 'Dollar index' },
  USDJPY: { sym: 'JPY=X', kind: 'log', label: 'USD/JPY' },
  VIX:    { sym: '^VIX', kind: 'log', label: 'VIX' },
  Y5:     { sym: '^FVX', kind: 'diff', label: '5Y yield', bp: true },
  Y10:    { sym: '^TNX', kind: 'diff', label: '10Y yield', bp: true },
  Y30:    { sym: '^TYX', kind: 'diff', label: '30Y yield', bp: true },
  S10S30: { spread: ['^TYX', '^TNX'], kind: 'diff', label: '10s30s curve', bp: true },
  S5S30:  { spread: ['^TYX', '^FVX'], kind: 'diff', label: '5s30s curve', bp: true },
  SMHREL: { ratio: ['SMH', 'SPY'], kind: 'log', label: 'Semis vs S&P' },
  QQQREL: { ratio: ['QQQ', 'SPY'], kind: 'log', label: 'Nasdaq vs S&P' },
  CTA:    { cta: 'SPY', kind: 'cta', label: 'CTA equity replica' },
  CTAPOS: { cta: 'SPY', kind: 'ctapos', label: 'CTA equity replica level' },
  // THE OTHER SIDE OF THE TAPE (4 Nov 2026). The first nine scenarios watch money LEAVING the book's
  // names; on 3 Nov the biggest moves were where it went — value over growth +2.6σ, equal-weight
  // over cap-weight +2.4σ, health care +2.4σ, financials +2.3σ — and none of it was on the board.
  RSPREL: { ratio: ['RSP', 'SPY'], kind: 'log', label: 'Equal-weight vs S&P' },
  VALUE:  { ratio: ['IWD', 'IWF'], kind: 'log', label: 'Value vs growth' },
  FINREL: { ratio: ['XLF', 'SPY'], kind: 'log', label: 'Financials vs S&P' },
  // Three defensive sectors, equally weighted: the mean of their log ratios to the S&P.
  DEFREL: { ratio: [['XLV', 'XLP', 'XLU'], 'SPY'], kind: 'log', label: 'Defensives vs S&P' },
  COPPER: { sym: 'HG=F', kind: 'log', label: 'Copper' },
  EMREL:  { ratio: ['EEM', 'SPY'], kind: 'log', label: 'Emerging markets vs S&P' },
});
const symsOf = (s) => s.sym ? [s.sym] : s.cta ? [s.cta] : (s.spread || s.ratio || []).flat();
export const BOARD_SYMBOLS = Object.freeze([...new Set(Object.values(SERIES).flatMap(symsOf))]);

const L = (series, dir, label, window) => (window ? { series, dir, label, window } : { series, dir, label });
// dir: 'up' | 'down' — directional, with hysteresis; 'notUp' | 'notDown' — permissive, no hysteresis;
// 'cut' | 'add' — the CTA replica's five-session change; 'low' — the replica's level.
// window: the trend's length in sessions (default 20; the recovery legs read 5).
export const GROUPS = Object.freeze([
  { id: 'rates', label: 'Rates & growth' },
  { id: 'stress', label: 'Risk-off' },
  { id: 'riskon', label: 'Risk-on & recovery' },
  { id: 'rotation', label: 'Rotation' },
  { id: 'book', label: 'Your book' },
]);

export const SCENARIO_DEFS = Object.freeze([
  { id: 'A', group: 'rates', name: 'Duration bid holds', tone: 'green', side: 'supportive', weight: 6,
    gloss: 'bonds rally with the curve and credit orderly',
    legs: [L('TLT', 'up', 'TLT rising'), L('S10S30', 'notUp', '10s30s not steepening'), L('CREDIT', 'notDown', 'credit not cracking')],
    meaning: 'Real yields falling with credit calm; duration is being bid for growth reasons, not stress',
    expect: ['long-duration equity leads', 'growth over value', 'gold flat-to-up on falling real yields', 'dollar softer', 'credit stays calm'],
    not: [{ id: 'B', shared: 'Both begin with a dovish impulse', discriminator: 'whether the long end joins the rally — here it does' }],
    consequence: 'Duration leg validated — USFR → IEF/TLT sequencing on track' },
  { id: 'B', group: 'rates', name: 'Term-premium break', tone: 'amber', side: 'supportive', weight: 6,
    gloss: 'the long end sells and the curve steepens without a stronger dollar',
    legs: [L('Y30', 'up', '30Y yield rising'), L('S10S30', 'up', '10s30s steepening'), L('DXY', 'notUp', 'dollar not rising')],
    meaning: 'The long end is demanding more to hold duration — a term-premium or fiscal problem, not a Fed one',
    expect: ['bear steepener', 'long-duration equity underperforms', 'banks and value outperform', 'gold up on a fiscal risk premium', 'dollar down', 'utilities and REITs hit'],
    not: [{ id: 'C', shared: 'Both are yields rising', discriminator: 'curve shape — here the long end leads and the dollar does not follow; in a hawkish repricing the front end leads and the dollar rises' }],
    consequence: 'Skip the bond leg — go bills → equities directly' },
  { id: 'C', group: 'rates', name: 'Hawkish repricing', tone: 'amber', side: 'adverse', weight: 6,
    gloss: 'the front end reprices the Fed higher and the dollar follows',
    legs: [L('Y5', 'up', '5Y yield rising'), L('S5S30', 'down', '5s30s flattening'), L('DXY', 'up', 'dollar rising')],
    meaning: 'The market is repricing the Fed path — real yields rising, and everything held for its duration sells with it',
    expect: ['bear flattener', 'dollar up', 'gold down on rising real yields', 'growth underperforms', 'credit stays calm'],
    not: [{ id: 'D', shared: 'Both can come with equities falling', discriminator: 'credit — a hawkish repricing keeps it orderly; a credit crack does not' },
          { id: 'B', shared: 'Both are yields rising', discriminator: 'curve shape — here the curve flattens and the dollar rises; in a term-premium break it steepens and the dollar does not' }],
    consequence: 'Stay in bills. The AI book is the exposure' },
  { id: 'GS', group: 'rates', name: 'Growth scare', tone: 'amber', side: 'adverse', weight: 7,
    gloss: 'front-end yields, equities and oil all fall together',
    legs: [L('Y5', 'down', '5Y yield falling'), L('SPY', 'down', 'S&P falling'), L('OIL', 'down', 'oil falling')],
    meaning: 'Growth expectations are falling and inflation is not the worry — the front end rallies while risk assets and oil sell',
    expect: ['bull steepener', 'defensives over cyclicals', 'small caps lag', 'yen and dollar firm', 'credit softens'],
    not: [{ id: 'SF', shared: 'Both have equities falling', discriminator: 'yields and oil — falling in a growth scare, rising in stagflation' },
          { id: 'D', shared: 'Both have equities falling', discriminator: 'credit — a growth scare can run with it orderly; a credit crack cannot' }],
    consequence: 'Growth scare — duration is the hedge; cyclicals and small caps carry the risk' },
  { id: 'SF', group: 'rates', name: 'Stagflation squeeze', tone: 'red', side: 'adverse', weight: 7,
    gloss: 'oil and gold up while equities fall',
    legs: [L('OIL', 'up', 'oil rising'), L('GLD', 'up', 'gold rising'), L('SPY', 'down', 'S&P falling')],
    meaning: 'Inflation pressure with weakening growth — both halves of a stock-bond book lose, and real assets hold',
    expect: ['breakevens rising', 'equities and bonds down together', 'energy outperforms', 'gold bid', 'little room for central banks to ease'],
    not: [{ id: 'C', shared: 'Both push yields higher', discriminator: 'gold — a hawkish repricing sells it on rising real yields; stagflation bids it' }],
    consequence: 'Stagflation — stocks and bonds lose together; real assets are the hedge' },
  { id: 'D', group: 'stress', name: 'Credit crack', tone: 'red', side: 'adverse', weight: 9,
    gloss: 'high yield sells with equities while volatility rises',
    legs: [L('CREDIT', 'down', 'high yield lagging Treasuries'), L('VIX', 'up', 'VIX rising'), L('SPY', 'down', 'S&P falling')],
    meaning: 'Credit is cracking alongside equities — the combination insurance exists for',
    expect: ['forced liquidation', 'correlations converge', 'gold can sell too, on margin calls', 'dollar spikes', 'VIX curve inverts', 'the Fed put becomes live'],
    not: [{ id: 'SD', shared: 'Both are equities falling with volatility up', discriminator: 'credit — mechanical de-risking leaves high yield orderly; a credit crack does not' }],
    consequence: 'Insurance scenario — credit is cracking with equities' },
  { id: 'CU', group: 'stress', name: 'Yen carry unwind', tone: 'red', side: 'adverse', weight: 7,
    gloss: 'the yen rallies, volatility jumps and Nasdaq sells',
    legs: [L('USDJPY', 'down', 'yen strengthening'), L('VIX', 'up', 'VIX rising'), L('QQQ', 'down', 'Nasdaq falling')],
    meaning: 'Trades funded in yen are being closed — crowded longs sell together as the funding currency rallies',
    expect: ['USD/JPY falling fast', 'Nikkei and Nasdaq sell together', 'VIX spike', 'high-beta and crowded names lead down', 'correlations rise'],
    not: [{ id: 'GS', shared: 'Both are risk-off', discriminator: 'the yen — a carry unwind is led by yen strength, a growth scare by the front end' }],
    consequence: 'Carry unwind — crowded funding trades deleverage together; the yen is the tell' },
  { id: 'SD', group: 'stress', name: 'Systematic de-risking', tone: 'amber', side: 'adverse', weight: 7,
    gloss: 'trend funds cutting equity exposure as volatility rises',
    legs: [L('CTA', 'cut', 'CTA replica cutting'), L('VIX', 'up', 'VIX rising'), L('SPY', 'down', 'S&P falling')],
    meaning: 'Rules-based funds are selling equities because trends and volatility tell them to — selling that exhausts as the replica nears flat',
    expect: ['selling accelerates through CTA cut levels', 'index selling heavier than single names', 'realized volatility climbing', 'exhausts near the CTA net-flat level'],
    not: [{ id: 'D', shared: 'Both are equities falling with volatility up', discriminator: 'credit — mechanical de-risking leaves high yield orderly' }],
    consequence: 'Systematic de-risking — mechanical selling that exhausts near the CTA net-flat level' },
  { id: 'AI', group: 'book', name: 'AI leadership breaks', tone: 'red', side: 'adverse', weight: 9,
    gloss: 'semis lag the index and Nasdaq lags the S&P',
    legs: [L('SMHREL', 'down', 'semis lagging the S&P'), L('QQQREL', 'down', 'Nasdaq lagging the S&P'), L('SMH', 'down', 'semis falling')],
    meaning: 'The AI and semiconductor trade is losing leadership — the book\'s largest exposure',
    expect: ['memory and equipment names lead down', 'equal-weight holds better than cap-weight', 'Korea and Taiwan follow', 'capex guidance scrutinised'],
    not: [{ id: 'GS', shared: 'Both can see Nasdaq down', discriminator: 'relative performance — AI breaking is semis lagging a steadier index' }],
    consequence: 'AI leadership breaking — the AI book is the exposure' },

  // ── RISK-ON & RECOVERY ──
  { id: 'SL', group: 'riskon', name: 'Soft landing', tone: 'green', side: 'supportive', weight: 6,
    gloss: 'equities rise, volatility falls and credit tightens',
    legs: [L('SPY', 'up', 'S&P rising'), L('VIX', 'down', 'VIX falling'), L('CREDIT', 'up', 'high yield beating Treasuries')],
    meaning: 'Risk is being bought with credit leading — growth holding up without an inflation scare',
    expect: ['dips bought quickly', 'cyclicals and small caps join', 'VIX curve in steep contango', 'premium sells well'],
    not: [{ id: 'RR', shared: 'Both are equities up with volatility down', discriminator: 'credit — a soft landing has it tightening; a CTA re-risking can run on positioning alone' }],
    consequence: 'Soft landing — the tape and credit agree; dips are for buying' },
  { id: 'RR', group: 'riskon', name: 'Re-risking', tone: 'green', side: 'supportive', weight: 7,
    gloss: 'trend funds adding equities back as volatility falls',
    legs: [L('CTA', 'add', 'CTA replica adding'), L('VIX', 'down', 'VIX falling'), L('SPY', 'up', 'S&P rising')],
    meaning: 'Rules-based funds are buying back exposure because trends and volatility now let them — buying that runs until the replica is full',
    expect: ['buying accelerates through CTA buy levels', 'index-led gains', 'realized volatility falling', 'slows as the replica nears its maximum'],
    not: [{ id: 'SD', shared: 'Both are the CTA replica moving', discriminator: 'direction — the same funds, buying instead of selling' }],
    consequence: 'Re-risking — mechanical buying that fades as the replica fills' },
  { id: 'EX', group: 'riskon', name: 'Selling exhausting', tone: 'green', side: 'supportive', weight: 7,
    gloss: 'trend funds already cut, and the first week of bounce with volatility easing',
    legs: [L('CTAPOS', 'low', 'CTA replica already cut'), L('VIX', 'down', 'VIX falling over 5 sessions', SHORT), L('SPY', 'up', 'S&P rising over 5 sessions', SHORT)],
    meaning: 'The mechanical sellers have little left to sell and the tape is turning — where downside hedges stop paying and start decaying',
    expect: ['downside hedges lose value fast', 'short covering in the most-sold names', 'VIX curve back to contango', 'can fail if credit keeps widening'],
    not: [{ id: 'RR', shared: 'Both are a turn higher with volatility falling', discriminator: 'stage — exhaustion is the first week off the low; re-risking is the funds actually buying back' }],
    consequence: 'Selling exhausting — review the downside hedges before they decay' },
  { id: 'RF', group: 'riskon', name: 'Reflation', tone: 'green', side: 'supportive', weight: 5,
    gloss: 'a weaker dollar with copper and emerging markets bid',
    legs: [L('DXY', 'down', 'dollar falling'), L('COPPER', 'up', 'copper rising'), L('EMREL', 'up', 'emerging markets beating the S&P')],
    meaning: 'Global growth is being bought — easier dollar conditions lift metals and the rest of the world',
    expect: ['materials and industrials lead', 'Korea and Taiwan bid', 'breakevens drift up', 'gold firm'],
    not: [{ id: 'SF', shared: 'Both can have commodities rising', discriminator: 'equities — reflation has them rising with the rest of the world; stagflation has them falling' }],
    consequence: 'Reflation — the rest of the world and metals over US mega-caps' },

  // ── ROTATION ── Money moving between equities rather than leaving them: no effect on the stance.
  { id: 'RO', group: 'rotation', name: 'Rotation out of mega-caps', tone: 'amber', side: 'rotation', weight: 6,
    gloss: 'equal-weight, value and financials beat the cap-weighted index',
    legs: [L('RSPREL', 'up', 'equal-weight beating the S&P'), L('VALUE', 'up', 'value beating growth'), L('FINREL', 'up', 'financials beating the S&P')],
    meaning: 'Leadership is broadening away from the largest growth names — money moving inside equities, not leaving them',
    expect: ['equal-weight holds better than cap-weight', 'banks and industrials lead', 'mega-cap tech lags even on up days', 'index moves understate the average stock'],
    not: [{ id: 'AI', shared: 'Both have mega-cap tech lagging', discriminator: 'where the money goes — here it stays in equities; an AI break can be pure selling' }],
    consequence: 'Rotation — the cap-weighted index understates the average stock; the AI book carries the relative risk' },
  { id: 'DR', group: 'rotation', name: 'Defensive rotation', tone: 'amber', side: 'rotation', weight: 6,
    gloss: 'health care, staples and utilities lead while bonds rally',
    legs: [L('DEFREL', 'up', 'defensives beating the S&P'), L('TLT', 'up', 'TLT rising'), L('SPY', 'notUp', 'S&P not rising')],
    meaning: 'Investors are hiding inside equities — late-cycle positioning, usually ahead of slower growth',
    expect: ['low-beta over high-beta', 'yields drift lower', 'cyclicals lag', 'credit can stay calm for a while'],
    not: [{ id: 'GS', shared: 'Both have bonds bid and defensives ahead', discriminator: 'oil and the S&P — a growth scare has both falling; a defensive rotation can sit with them flat' }],
    consequence: 'Defensive rotation — slower growth being priced; high-beta carries the risk' },

  // ── YOUR BOOK, THE OTHER WAY ──
  { id: 'AR', group: 'book', name: 'AI leadership resumes', tone: 'green', side: 'supportive', weight: 9,
    gloss: 'semis beat the index and Nasdaq beats the S&P',
    legs: [L('SMHREL', 'up', 'semis beating the S&P'), L('QQQREL', 'up', 'Nasdaq beating the S&P'), L('SMH', 'up', 'semis rising')],
    meaning: 'The AI and semiconductor trade is leading again — the book\'s largest exposure working',
    expect: ['memory and equipment names lead', 'cap-weight beats equal-weight', 'Korea and Taiwan follow', 'capex guidance rewarded'],
    not: [{ id: 'RO', shared: 'Both are a leadership call', discriminator: 'direction — the mega-caps leading again rather than lagging' }],
    consequence: 'AI leadership resuming — the AI book is working' },
]);

const NAME_OF = Object.fromEntries(SCENARIO_DEFS.map(d => [d.id, d.name]));

// ── SERIES ───────────────────────────────────────────────────────────────────
// Bars per symbol → closes on the MASTER calendar (SPY's sessions), each forward-filled from its
// last close on or before that session. Different markets keep different holidays; a yen quote on
// a US holiday is not a missing bar and a Treasury holiday is not a zero move.
export function alignCloses(barsBySym = {}, master = 'SPY') {
  const cal = (barsBySym[master] || []).map(b => b?.date).filter(Boolean);
  const out = { dates: cal, closes: {} };
  for (const [sym, bars] of Object.entries(barsBySym)) {
    const rows = (bars || []).filter(b => b?.date && Number.isFinite(+b.close) && +b.close > 0).sort((a, b) => a.date.localeCompare(b.date));
    const col = [];
    let j = 0, last = null;
    for (const d of cal) {
      while (j < rows.length && rows[j].date <= d) { last = +rows[j].close; j++; }
      col.push(last);
    }
    out.closes[sym] = col;
  }
  return out;
}

function valueSeries(def, closes) {
  if (def.sym) return closes[def.sym] || null;
  const [a, b] = def.spread || def.ratio || [];
  // A basket against one series: the mean of the members' log ratios.
  if (Array.isArray(a)) {
    const cols = a.map(x => closes[x]), B = closes[b];
    if (!B || cols.some(c => !c)) return null;
    return B.map((y, i) => (y == null || cols.some(c => c[i] == null)) ? null : cols.reduce((t, c) => t + Math.log(c[i] / y), 0) / cols.length);
  }
  const A = closes[a], B = closes[b];
  if (!A || !B) return null;
  return A.map((x, i) => (x == null || B[i] == null) ? null : def.spread ? x - B[i] : Math.log(x / B[i]));
}

// z of the `window`-session change at index i, in the series' own daily volatility.
export function zAt(values, i, kind, window = WINDOW) {
  if (!values || i < Math.max(window, VOL_LOOKBACK) || values[i] == null || values[i - window] == null) return null;
  // Ratios are already logs, so they difference like yields.
  const k = kind === 'log' && values[i] > 0 && values[i - WINDOW] > 0 ? 'log' : 'diff';
  const d = [];
  for (let t = i - VOL_LOOKBACK + 1; t <= i; t++) {
    if (values[t] == null || values[t - 1] == null) continue;
    if (k === 'log' && !(values[t] > 0 && values[t - 1] > 0)) continue;
    d.push(k === 'log' ? Math.log(values[t] / values[t - 1]) : values[t] - values[t - 1]);
  }
  if (d.length < VOL_LOOKBACK * 0.8) return null;
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length);
  const change = k === 'log' ? Math.log(values[i] / values[i - window]) : values[i] - values[i - window];
  // No movement at all is a reading of zero, not a missing one; movement with no scale is missing.
  if (!(sd > 1e-12)) return Math.abs(change) < 1e-12 ? 0 : null;
  return change / (sd * Math.sqrt(window));
}

// The CTA replica on the master series, per session, and its five-session change.
function ctaCuts(spyCloses, from = 0) {
  // Only the walked window needs it (and five sessions before it for the change).
  const start = Math.max(0, from - 6);
  const pos = spyCloses.map((_, i) => (i < start ? null : positionAt(spyCloses.slice(0, i + 1).filter(x => x != null))));
  return { pos, cut: pos.map((p, i) => (p == null || i < 5 || pos[i - 5] == null) ? null : p - pos[i - 5]) };
}

// ── ONE LEG THROUGH TIME, WITH HYSTERESIS ────────────────────────────────────
export function walkLeg(leg, reading, from, to) {
  const out = [];
  let on = false;
  for (let i = from; i <= to; i++) {
    const v = reading(i);
    if (v == null) { out.push({ met: null, v: null }); on = false; continue; }
    let met;
    if (leg.dir === 'up') met = on ? v >= EXIT : v >= ENTER;
    else if (leg.dir === 'down') met = on ? v <= -EXIT : v <= -ENTER;
    else if (leg.dir === 'notUp') met = v < ENTER;
    else if (leg.dir === 'notDown') met = v > -ENTER;
    else if (leg.dir === 'cut') met = on ? v <= CTA_CUT_EXIT : v <= CTA_CUT_ENTER;
    else if (leg.dir === 'add') met = on ? v >= CTA_ADD_EXIT : v >= CTA_ADD_ENTER;
    else if (leg.dir === 'low') met = on ? v <= CTA_LOW_EXIT : v <= CTA_LOW_ENTER;
    on = !!met;
    out.push({ met, v });
  }
  return out;
}
const DIRECTIONAL = new Set(['up', 'down', 'cut', 'add', 'low']);
const CTA_DIRS = new Set(['cut', 'add', 'low']);
// A directional leg reading beyond the entry threshold in the WRONG direction.
export const contradicts = (leg, v) => v != null && ((leg.dir === 'up' && v <= -ENTER) || (leg.dir === 'down' && v >= ENTER));

export function statusOf(legStates, legs) {
  if (legStates.some(s => s.met == null)) return 'NO DATA';
  const met = legStates.filter(s => s.met).length;
  if (met === legs.length) return 'ACTIVE';
  const dir = legs.map((l, k) => [l, legStates[k]]).filter(([l]) => DIRECTIONAL.has(l.dir));
  // A DIRECTIONAL LEG MOVING HARD THE OTHER WAY VETOES "BUILDING". On 2026-09-24 the term-premium
  // break read building off a rising 30Y while its defining leg — a steepening curve — sat at −3.0σ,
  // flattening hard: the opposite of the scenario, and the signature of the hawkish one beside it.
  if (dir.some(([l, st]) => contradicts(l, st.v))) return 'QUIET';
  const need = Math.max(1, Math.ceil(dir.length / 2));
  return dir.filter(([, st]) => st.met).length >= need ? 'BUILDING' : 'QUIET';
}

const fmtZ = (z) => (z == null ? '—' : `${z > 0 ? '+' : z < 0 ? '−' : ''}${Math.abs(z).toFixed(1)}σ`);
function legDisplay(leg, def, v) {
  if (v == null) return 'no data';
  if (leg.dir === 'cut' || leg.dir === 'add') return `replica ${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))} pts over 5 sessions`;
  if (leg.dir === 'low') return `replica at ${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} (≤ +${CTA_LOW_ENTER.toFixed(2)} = little left to sell)`;
  return `${fmtZ(v)} over ${leg.window || WINDOW} sessions`;
}
// Curve shorthand into words, keeping the shorthand in brackets so it still matches the charts:
// "5s30s flattening" → "the 5-year vs 30-year Treasury yield gap narrowing (5s30s flattening)".
export function plainLeg(label = '') {
  const m = String(label).match(/^(\d+)s(\d+)s\s+(flattening|steepening)$/i);
  if (m) return `the ${m[1]}-year vs ${m[2]}-year Treasury yield gap ${/flat/i.test(m[3]) ? 'narrowing' : 'widening'} (${label})`;
  return label;
}

// How far an unmet directional leg is from switching on, in its own units.
function distanceTo(leg, v) {
  if (v == null) return null;
  if (leg.dir === 'up') return ENTER - v;
  if (leg.dir === 'down') return v + ENTER;
  if (leg.dir === 'cut') return v - CTA_CUT_ENTER;
  if (leg.dir === 'add') return CTA_ADD_ENTER - v;
  if (leg.dir === 'low') return v - CTA_LOW_ENTER;
  return null;
}

// ── THE BOARD ────────────────────────────────────────────────────────────────
// `barsBySym` — daily bars per symbol, oldest first, settled sessions only. Returns the scenarios
// in the shape the posture card already reads (id, name, confirmed, side, consequence, met, total,
// weight, broken, proximity, watch) plus the new fields the board renders.
// `history` — how many sessions to walk back (the backtest walks them all); `days` on each scenario
// is that walk's daily status.
export function evaluateBoard(barsBySym = {}, { defs = SCENARIO_DEFS, history = HISTORY, keepDays = false } = {}) {
  const { dates, closes } = alignCloses(barsBySym, 'SPY');
  const n = dates.length;
  if (!n) return { asOf: null, scenarios: [] };
  const to = n - 1;
  const from = Math.max(0, to - history + 1);
  const cta = closes.SPY ? ctaCuts(closes.SPY, from) : null;
  const readings = {};
  const readerFor = (key, window = WINDOW) => {
    const id = `${key}:${window}`;
    if (readings[id]) return readings[id];
    const def = SERIES[key];
    if (def.kind === 'cta') { readings[id] = (i) => cta?.cut?.[i] ?? null; return readings[id]; }
    if (def.kind === 'ctapos') { readings[id] = (i) => cta?.pos?.[i] ?? null; return readings[id]; }
    const vals = valueSeries(def, closes);
    readings[id] = (i) => (vals ? zAt(vals, i, def.ratio || def.spread ? 'diff' : def.kind, window) : null);
    return readings[id];
  };

  const scenarios = defs.map(d => {
    const legRuns = d.legs.map(l => walkLeg(l, readerFor(l.series, l.window), from, to));
    const days = [];
    for (let k = 0; k <= to - from; k++) days.push({ date: dates[from + k], status: statusOf(legRuns.map(r => r[k]), d.legs) });
    const now = legRuns.map(r => r.at(-1));
    const status = days.at(-1).status;
    // How long it has said this: back through the walked history to the last different status.
    let s = days.length - 1;
    while (s > 0 && days[s - 1].status === status) s--;
    const legs = d.legs.map((l, k) => ({
      label: l.label, series: l.series, seriesLabel: SERIES[l.series]?.label ?? l.series, dir: l.dir,
      directional: DIRECTIONAL.has(l.dir), met: now[k].met, value: now[k].v == null ? null : +now[k].v.toFixed(2),
      display: legDisplay(l, SERIES[l.series], now[k].v), distance: now[k].met ? null : (() => { const x = distanceTo(l, now[k].v); return x == null ? null : +x.toFixed(2); })(),
    }));
    const met = legs.filter(x => x.met).length;
    const nearest = legs.filter(x => !x.met && x.distance != null).sort((a, b) => a.distance - b.distance)[0] || null;
    // ACTIVE: the leg closest to switching off is the one to watch. Otherwise: the closest to on.
    const dirLegs = legs.filter(x => x.directional && x.value != null);
    const weakest = dirLegs.filter(x => !CTA_DIRS.has(x.dir)).sort((a, b) => Math.abs(a.value) - Math.abs(b.value))[0] || null;
    // In words a reader new to the curve can act on: what the leg IS, how far from normal it sits,
    // and what happens if it fades (see plainLeg).
    const watch = status === 'ACTIVE'
      ? (weakest ? `${plainLeg(weakest.label)} is the weakest leg holding this up (${fmtZ(weakest.value)} from normal); if it drifts back inside ±${EXIT}σ, it switches off and the scenario loses that support` : null)
      : nearest ? `${plainLeg(nearest.label)} — ${nearest.dir === 'cut' || nearest.dir === 'add' ? `${Math.round(nearest.distance * 100)} pts` : nearest.dir === 'low' ? `${nearest.distance.toFixed(2)} of replica` : `${nearest.distance.toFixed(1)}σ`} from switching on` : null;
    const perm = legs.filter(x => !x.directional).map(x => x.label);
    const breaksIf = status === 'ACTIVE'
      ? `${dirLegs.map(x => x.label).join(', ')} fading back inside ±${EXIT}σ${perm.length ? `, or ${perm.join(', ')} failing` : ''}`
      : null;
    return {
      id: d.id, group: d.group, name: d.name, gloss: d.gloss, tone: d.tone, side: d.side, weight: d.weight,
      status, confirmed: status === 'ACTIVE', broken: false,
      met, total: legs.length, proximity: legs.length ? met / legs.length : 0, countDisplay: `${met}/${legs.length}`,
      legs, strip: days.slice(-STRIP), since: days[s].date, sinceSessions: days.length - s, sinceCapped: s === 0,
      watch, nearest: nearest ? { label: nearest.label, distance: nearest.distance } : null,
      consequence: d.consequence, implication: d.meaning, meaning: d.meaning, expect: d.expect,
      // BY NAME. The board shows names, so a line reading "Not D." pointed at nothing on the screen.
      notLines: (d.not || []).map(x => `${x.id ? `Not ${(NAME_OF[x.id] || x.id).toLowerCase()}. ` : ''}${x.shared}; the difference is ${x.discriminator}.`),
      breaksIf,
      source: 'bars',
      ...(keepDays ? { days } : {}),
    };
  });
  return { asOf: dates[to], scenarios };
}

// ── KOREA AND CHINA, FROM THEIR OWN DATA ─────────────────────────────────────
// KM and CP read feeds no bar series carries — KOFIA margin loans and KRX flows (lib/koreaUnwind.js) and the
// SMIC A/H premium — so they stay on lib/scenarios.js and are mapped into the same four states.
export function mapLegacy(s) {
  if (!s) return null;
  // A leg that REPORTED but was too small to read is a reading — "no forced selling today" — and
  // counts as not met. Only a leg with no input at all is missing. On 2026-09-25 KM read "no data"
  // because its 7709 leg was flat, which is the most informative thing it could have said.
  const missing = (c) => c.met == null && (!c.neutral || /no value|not reported/.test(c.reason || '') || c.display === 'n/a') && !c.near;
  const legs = (s.conditions || []).map(c => ({
    label: c.label, met: c.met == null ? (missing(c) ? null : false) : !!c.met, value: null, directional: true,
    display: c.display ?? 'n/a', distance: null, reason: c.met == null ? (c.reason || null) : null,
  }));
  const readable = legs.filter(l => l.met != null);
  const met = readable.filter(l => l.met).length;
  const status = s.broken ? 'QUIET'
    : !readable.length ? 'NO DATA'
    : (met === legs.length) ? 'ACTIVE'
    : met >= Math.max(1, Math.ceil(legs.length / 2)) ? 'BUILDING'
    : 'QUIET';
  const gaps = legs.filter(l => l.met == null).map(l => l.label);
  return {
    id: s.id, group: 'book', name: String(s.name || '').replace(/\b([A-Z])([A-Z]+)\b/g, (m, x, y) => x + y.toLowerCase()),
    gloss: s.gloss, tone: s.tone, side: s.side, weight: s.weight,
    status, confirmed: status === 'ACTIVE', broken: !!s.broken,
    met, total: legs.length, proximity: legs.length ? met / legs.length : 0, countDisplay: `${met}/${legs.length}`,
    legs, strip: null, since: null, sinceSessions: null,
    watch: s.watch, nearest: null, consequence: s.consequence, implication: s.implication, meaning: s.implication,
    expect: s.expect || [], notLines: s.notLines || [],
    breaksIf: s.falsifier || null, brokenBy: s.brokenBy || [], qualifier: s.qualifier || null,
    note: s.broken ? `ended: ${(s.brokenBy || []).join(' · ') || 'its disproof was met'}`
      : status === 'NO DATA' ? `no input: ${gaps.join(', ')}`
      : gaps.length ? `not reported here: ${gaps.join(', ')}` : null,
    source: 'feeds',
  };
}

const STATUS_RANK = { ACTIVE: 0, BUILDING: 1, QUIET: 2, 'NO DATA': 3 };
export function sortBoard(scenarios = []) {
  return [...scenarios].sort((a, b) =>
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) || (b.weight - a.weight) || (b.proximity - a.proximity));
}

// One line for the top of the board.
export function boardSummary(scenarios = []) {
  const by = (st) => scenarios.filter(s => s.status === st).map(s => s.name);
  return { active: by('ACTIVE'), building: by('BUILDING'), quiet: by('QUIET').length, noData: by('NO DATA') };
}
