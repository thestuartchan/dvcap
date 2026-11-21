// lib/earningsCard.js — the weekly earnings-calendar card that rides on the Monday Market Intel post
// (Stu's private channel). Pure: rows in, HTML out. scripts/recap-card.mjs fetches the logos and
// renders the HTML to a PNG with Playwright.
//
// THE RULES (Stu, 21 Nov 2026).
//   - A name is on the card when it has a confirmed slot (before the open or after the close) and
//     either a market cap of $5B+, or $1–5B with options open interest of 75K+ contracts — the
//     smaller names options traders are actually in.
//   - At most STAR_CAP stars: names key to watch, category leaders or the biggest moves. The stars
//     are chosen by the writer (a judgment), passed in, and capped here.
//   - Each tile shows the options-implied move into the report as a percent of the price.
//
// The rows are Unusual Whales' upcoming-earnings rows (licensed for Stu's personal use), so the card
// goes to the private channel only.
export const CAP_FLOOR = 5e9;
export const SMALL_CAP_FLOOR = 1e9;
export const SMALL_CAP_MIN_OI = 75000;
export const STAR_CAP = 5;
export const PER_SLOT_MAX = 15;   // 5 rows of 3; a busy morning (13 names on 24 Nov 2026) must not cut the $1–5B names

const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const SLOT = { premarket: 'bmo', postmarket: 'amc' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function qualifies(r) {
  const cap = num(r?.marketcap), oi = num(r?.oi);
  if (!SLOT[r?.report_time] || cap == null) return false;
  if (cap >= CAP_FLOOR) return true;
  return cap >= SMALL_CAP_FLOOR && oi != null && oi >= SMALL_CAP_MIN_OI;
}

// UW row → card row. implied_move is in dollars; the tile shows it as a percent of the price.
export function cardRow(r) {
  const px = num(r.curr), im = num(r.implied_move);
  return {
    ticker: String(r.symbol || '').toUpperCase(),
    name: r.full_name || r.symbol,
    date: String(r.report_date || '').slice(0, 10),
    slot: SLOT[r.report_time],
    cap: num(r.marketcap),
    impliedPct: px && im != null ? +(im / px * 100).toFixed(1) : null,
    logo: r.logo || null,
  };
}

// → { rows, dropped } rows de-duplicated by ticker, biggest first in each slot, capped per slot.
export function selectRows(uwRows = []) {
  const seen = new Set(), rows = [];
  for (const r of uwRows) {
    if (!qualifies(r)) continue;
    const c = cardRow(r);
    if (!c.ticker || !/^\d{4}-\d{2}-\d{2}$/.test(c.date) || seen.has(c.ticker)) continue;
    seen.add(c.ticker); rows.push(c);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.slot.localeCompare(b.slot) || b.cap - a.cap);
  const kept = [], dropped = [], per = {};
  for (const r of rows) {
    const k = `${r.date}|${r.slot}`;
    per[k] = (per[k] || 0) + 1;
    (per[k] <= PER_SLOT_MAX ? kept : dropped).push(r);
  }
  return { rows: kept, dropped: dropped.map(r => r.ticker) };
}

export function capStars(stars = [], rows = []) {
  const on = new Set(rows.map(r => r.ticker));
  return [...new Set(stars.map(s => String(s).toUpperCase()))].filter(t => on.has(t)).slice(0, STAR_CAP);
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function weekDays(monday) {
  const t0 = Date.parse(`${monday}T12:00:00Z`);
  return Array.from({ length: 5 }, (_, i) => { const d = new Date(t0 + i * 86400000); return { date: d.toISOString().slice(0, 10), label: `${DOW[d.getUTCDay()]} ${d.getUTCDate()}` }; });
}

// logos: { TICKER: dataUri } (scripts/recap-card.mjs fetches them; a missing logo shows the ticker).
export function cardHtml({ monday, rows, stars = [], notes = {}, headerRight = '', logos = {} }) {
  const starred = new Set(capStars(stars, rows));
  const d0 = new Date(`${monday}T12:00:00Z`);
  const tile = (r) => {
    const lg = logos[r.ticker];
    const img = lg ? `<img src="${esc(lg)}">` : `<div class="mono">${esc(r.ticker)}</div>`;
    const pct = r.impliedPct != null ? `±${r.impliedPct.toFixed(1)}%` : '—';
    return `<div class="tile"><div class="lg">${img}</div><div class="tk">${esc(r.ticker)}${starred.has(r.ticker) ? '<span class="star">★</span>' : ''}</div><div class="im">${pct}</div></div>`;
  };
  const slot = (date, s) => {
    const rs = rows.filter(r => r.date === date && r.slot === s);
    if (!rs.length) return '';
    const [ic, lab] = s === 'bmo' ? ['☀', 'Before open'] : ['☾', 'After close'];
    return `<div class="slot"><div class="sh"><span class="ic">${ic}</span>${lab}</div><div class="grid">${rs.map(tile).join('')}</div></div>`;
  };
  const cols = weekDays(monday).map(({ date, label }) => {
    let body = slot(date, 'bmo') + slot(date, 'amc');
    if (notes[date]) body += `<div class="note">${esc(notes[date])}</div>`;
    if (!body) body = '<div class="empty">No major reports</div>';
    return `<div class="col"><div class="dh">${label}</div>${body}</div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:2000px;background:#0f1115;font-family:Inter,"DejaVu Sans",sans-serif;color:#e8eaed;padding:28px}
.hd{display:flex;justify-content:space-between;align-items:center;background:#171a20;border:1px solid #262a33;border-radius:20px;padding:30px 40px;margin-bottom:24px}
.hd h1{font-family:"Inter Display",Inter;font-size:52px;font-weight:800;letter-spacing:-.5px}
.hd .sub{font-size:28px;color:#9aa0a6;margin-top:6px;font-weight:600}
.hd .rt{text-align:right;font-size:20px;color:#9aa0a6;line-height:1.5}
.cols{display:grid;grid-template-columns:repeat(5,1fr);gap:18px}
.col{min-width:0}
.dh{text-align:center;font-size:26px;font-weight:700;padding:10px 0 14px;border-bottom:1px solid #262a33;margin-bottom:14px}
.slot{background:#171a20;border:1px solid #262a33;border-radius:16px;margin-bottom:16px;overflow:hidden}
.sh{background:#1d2129;padding:12px 16px;font-size:20px;font-weight:700;color:#c9ccd1}
.ic{margin-right:10px;color:#f5c542}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:14px}
.tile{position:relative;background:#11141a;border:1px solid #262a33;border-radius:12px;padding:10px 6px 8px;text-align:center}
.lg{width:96px;height:96px;margin:0 auto;border-radius:10px;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden}
.lg img{width:100%;height:100%;object-fit:contain}
.mono{font-size:24px;font-weight:800;color:#11141a}
.tk{font-size:21px;font-weight:800;margin-top:8px}
.im{font-size:17px;font-weight:700;color:#8ab4f8;margin-top:2px;font-variant-numeric:tabular-nums}
.star{color:#f5c542;font-size:20px;margin-left:5px;vertical-align:2px}
.note{background:#1a1720;border:1px dashed #3a3345;border-radius:16px;padding:22px 14px;text-align:center;font-size:21px;font-weight:700;color:#c3a6ff;margin-bottom:16px}
.empty{color:#6b7078;text-align:center;font-size:19px;padding:20px}
.ft{display:flex;justify-content:space-between;margin-top:10px;padding:16px 8px 0;border-top:1px solid #262a33;font-size:19px;color:#9aa0a6}
.ft b{color:#f5c542} .ft i{color:#8ab4f8;font-style:normal;font-weight:700}
</style></head><body>
<div class="hd"><div><h1>Earnings Calendar</h1><div class="sub">Week of ${MON[d0.getUTCMonth()]} ${d0.getUTCDate()}, ${d0.getUTCFullYear()}</div></div><div class="rt">${esc(headerRight).replace(/\n/g, '<br>')}</div></div>
<div class="cols">${cols}</div>
<div class="ft"><span><b>★</b> key to watch · category leader · biggest move</span><span><i>±x%</i> options-implied move · $5B+, or $1–5B with 75K+ options OI · confirmed time</span></div>
</body></html>`;
}
