// lib/koreaUnwind.js — the Korea Mechanical Unwind scenario's inputs, from the KOFIA / KRX store.
//
// WHY IT MOVED. KM read two things: CSOP 7709 units outstanding (typed in by hand, and no longer
// kept) and VKOSPI (fetched for the Asia board only). On the US and Europe boards it therefore
// read "no data", and on Asia it leaned on a count nobody was updating. Both are replaced by what
// the daily Korea fetch already stores for every region, with no extra request:
//
//   margin loans (KOFIA 신용융자)  — leveraged retail being sold out: the mechanical seller itself
//   foreign net (KRX, KOSPI)      — the selling the leverage is meeting
//   KOSPI day change (KOFIA)      — the tape it is happening on
//
// ONE DATE FOR ALL THREE. KOFIA posts margin loans a day behind the index and the flow, and the
// scenario's break is a conjunction ("KOSPI rising while margin loans are still falling") whose
// legs must be from the same day to mean anything. So the inputs are taken at the latest date all
// three carry, not each at its own latest.
import { closeOnlyAtr } from './atr.js';

const rowsOf = (series, key) => (series?.[key] || []).filter(r => r && r.date && Number.isFinite(Number(r.value)));

export function kmInputs(series = {}) {
  const margin = rowsOf(series, 'marginLoans'), kospi = rowsOf(series, 'kospi'), foreign = rowsOf(series, 'foreignNet');
  const has = (rows, d) => rows.some(r => r.date === d);
  const date = margin.map(r => r.date).filter(d => has(kospi, d) && has(foreign, d)).sort().at(-1);
  if (!date) return null;
  // Daily % changes up to the common date, from the levels (the stored pct is KOFIA's own and is
  // used for the day itself; the history for the noise floor is recomputed so a gap cannot hide).
  const pctSeries = (rows) => {
    const lv = rows.filter(r => r.date <= date).sort((a, b) => a.date.localeCompare(b.date)).map(r => Number(r.value));
    const out = [];
    for (let i = 1; i < lv.length; i++) if (lv[i - 1] > 0) out.push(((lv[i] - lv[i - 1]) / lv[i - 1]) * 100);
    return out;
  };
  const dayPct = (rows) => {
    const i = rows.findIndex(r => r.date === date);
    const r = rows[i];
    if (Number.isFinite(Number(r?.pct))) return +Number(r.pct).toFixed(2);
    const prev = rows.filter(x => x.date < date).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    return prev && Number(prev.value) > 0 ? +(((Number(r.value) - Number(prev.value)) / Number(prev.value)) * 100).toFixed(2) : null;
  };
  const leg = (rows) => ({ value: dayPct(rows), atr: closeOnlyAtr(pctSeries(rows)), date });
  return {
    date,
    margin: leg(margin),
    kospi: leg(kospi),
    foreignNet: { value: Number(foreign.find(r => r.date === date).value), unit: foreign.find(r => r.date === date).unit || null, date },
  };
}
