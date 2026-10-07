// lib/regionTape.js — each region's own tape, as one chip: Asia · Europe · US.
//
// The stance card is ONE master board: the book is one book, and the dollar, gold, BTC and US
// rates trade round the clock and are the same for every region. What a single board cannot show
// is WHERE the stress sits — a KOSPI-led sell-off and a Nasdaq-led one are different mornings. So
// each region gets a chip beside the board, never a competing stance: its main indices, each
// judged against its own daily range (the same ATR gate as the stance card), plus one currency
// tell. Each regional pre-read leads with its own chip.
//
// Built from daily bars, so the move is the session's close against the one before (the live
// bar where a market is open), and the ATR is the instrument's own. Public market data only.
import { yahooDailyOHLCBatch } from './yahoo.js';
import { atrSummary } from './atr.js';
import { ATR_GATE } from './scenarios.js';

export const REGION_TAPE = Object.freeze({
  asia: { label: 'Asia', indices: [['^KS11', 'KOSPI'], ['^HSI', 'Hang Seng'], ['^N225', 'Nikkei']],
          fx: { sym: 'KRW=X', name: 'USD/KRW', weakWhen: 'up', word: 'won' } },
  eu:   { label: 'Europe', indices: [['^STOXX50E', 'STOXX 50'], ['^GDAXI', 'DAX'], ['^FTSE', 'FTSE 100']],
          fx: { sym: 'EURUSD=X', name: 'EUR/USD', weakWhen: 'down', word: 'euro' } },
  us:   { label: 'US', indices: [['QQQ', 'Nasdaq 100'], ['SPY', 'S&P 500'], ['IWM', 'Russell 2000']],
          fx: { sym: 'DX-Y.NYB', name: 'DXY', weakWhen: 'down', word: 'dollar' } },
});
export const REGION_ORDER = Object.freeze(['asia', 'eu', 'us']);

const sgn = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`;

// legs: { indices: [{ name, value, atr }], fx: { value, atr } } — value and atr in percent.
export function regionTapeRead(region, legs = {}) {
  const def = REGION_TAPE[region];
  if (!def) return null;
  const idx = (legs.indices || []).map(l => {
    const ok = l?.value != null && l?.atr > 0;
    const vote = !ok ? null : Math.abs(l.value) < ATR_GATE * l.atr ? 0 : l.value < 0 ? -1 : 1;
    return { name: l.name, value: l.value ?? null, atr: l.atr ?? null, vote };
  });
  const read = idx.filter(l => l.vote != null);
  const off = read.filter(l => l.vote < 0), on = read.filter(l => l.vote > 0);
  // A MAJORITY OF THE INDICES THAT COULD SPEAK, as on the stance card.
  const direction = !read.length ? 'unavailable'
    : off.length * 2 > read.length ? 'risk-off'
    : on.length * 2 > read.length ? 'risk-on'
    : !off.length && !on.length ? 'quiet' : 'mixed';
  const fx = legs.fx && legs.fx.value != null && legs.fx.atr > 0 ? legs.fx : null;
  let fxTell = null;
  if (fx && Math.abs(fx.value) >= ATR_GATE * fx.atr) {
    const weak = def.fx.weakWhen === 'up' ? fx.value > 0 : fx.value < 0;
    fxTell = { text: `${def.fx.word} ${weak ? (def.fx.word === 'dollar' ? 'offered' : 'weak') : (def.fx.word === 'dollar' ? 'bid' : 'firm')}`, weak, value: fx.value };
  }
  const movers = (direction === 'risk-off' ? off : direction === 'risk-on' ? on : read.filter(l => l.vote))
    .map(l => `${l.name} ${sgn(l.value)}`);
  const text = direction === 'unavailable' ? 'no index reading'
    : direction === 'quiet' ? 'indices inside their ranges'
    : movers.join(', ');
  return { region, label: def.label, direction, text, fx: fxTell, legs: idx, asOf: legs.asOf || null,
           line: `${def.label}: ${direction}${direction === 'unavailable' ? '' : ` (${text})`}${fxTell ? ` · ${fxTell.text}` : ''}` };
}

// The session move and the ATR from one series of daily bars.
export function legFromBars(bars = []) {
  const b = (bars || []).filter(x => x && Number.isFinite(x.close));
  if (b.length < 16) return { value: null, atr: null, date: null };
  const last = b[b.length - 1], prev = b[b.length - 2];
  return { value: +((last.close / prev.close - 1) * 100).toFixed(2), atr: atrSummary(b)?.atrPct ?? null, date: last.date };
}

export async function regionTapes(regions = REGION_ORDER) {
  const syms = regions.flatMap(r => [...REGION_TAPE[r].indices.map(([s]) => s), REGION_TAPE[r].fx.sym]);
  const bars = await yahooDailyOHLCBatch(syms, '6mo');
  const out = {};
  for (const r of regions) {
    const def = REGION_TAPE[r];
    const indices = def.indices.map(([s, name]) => ({ name, ...legFromBars(bars?.[s]) }));
    const fx = legFromBars(bars?.[def.fx.sym]);
    const asOf = indices.map(i => i.date).filter(Boolean).sort().at(-1) || null;
    out[r] = regionTapeRead(r, { indices, fx, asOf });
  }
  return out;
}
