// lib/volThrustFeed.js — NYSE up / down volume per session for the 9-to-1 row (lib/volThrust.js).
//
// THREE LAYERS, newest wins per date (market data only, keyless, nothing here can fail the board):
//   1. data/nyse_updown_volume.json — TradingView's USI:UVOL / USI:DVOL daily history, refreshed each
//      weekday evening by .github/workflows/vol-thrust-history.yml (scripts/vol-thrust-history.py) and
//      by hand with the same script. The backtest (docs/vol-thrust) runs on this same file.
//   2. TradingView live — the same two series over TradingView's public chart websocket (the
//      unauthorized-user token its free chart uses), the last 30 daily bars. Best-effort: no WebSocket in
//      the runtime, a refused socket or 6 s without an answer → skipped.
//   3. WSJ Markets Diary (wsj.com/market-data/stocks/marketsdiary, its JSON) — TODAY only, and only once
//      its timestamp is 4:00 PM ET or later on today's date: NYSE advancing / declining share volume.
//      Consolidated volume (≈4× the TradingView series), so it fills a date the other two lack and never
//      replaces them; the session carries source 'WSJ diary' so the row says which it read.
import HIST from '../data/nyse_updown_volume.json' with { type: 'json' };

export const TV_WS = 'wss://data.tradingview.com/socket.io/websocket';
export const WSJ_DIARY = 'https://www.wsj.com/market-data/stocks/marketsdiary?id=%7B%22application%22%3A%22WSJ%22%2C%22marketsDiaryType%22%3A%22overview%22%7D&type=mdc_marketsdiary';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const NYHM = (ms) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
const NYD = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

export function historySessions(hist = HIST, n = 400) {
  return (hist?.rows || []).slice(-n).map(([date, up, down]) => ({ date, up, down, source: 'TradingView (history file)' }));
}

// TradingView's socket frames: "~m~<len>~m~<json>" and "~h~<n>" heartbeats.
export function tvFrames(raw) {
  return String(raw || '').split(/~m~\d+~m~/).filter(Boolean);
}
export const tvMsg = (m, p) => { const s = JSON.stringify({ m, p }); return `~m~${s.length}~m~${s}`; };
// A timescale_update frame → { 'YYYY-MM-DD': value } (the bar's close; t is the session open in UTC).
export function tvBars(frame) {
  let j; try { j = JSON.parse(frame); } catch { return null; }
  if (j?.m !== 'timescale_update') return null;
  const s = j.p?.[1]?.sds_1?.s;
  if (!Array.isArray(s)) return null;
  const out = {};
  for (const b of s) { const v = b?.v; if (Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[4])) out[NYD(v[0] * 1000)] = v[4]; }
  return out;
}

export function tvSeries(symbol, { bars = 30, timeoutMs = 6000, WS = globalThis.WebSocket } = {}) {
  return new Promise((resolve) => {
    if (typeof WS !== 'function') return resolve(null);
    let ws, done = false;
    const end = (v) => { if (done) return; done = true; clearTimeout(timer); try { ws?.close(); } catch { /* closed */ } resolve(v); };
    const timer = setTimeout(() => end(null), timeoutMs);
    try { ws = new WS(TV_WS); } catch { return end(null); }
    const cs = `cs_${Math.random().toString(36).slice(2, 14)}`;
    ws.onopen = () => {
      ws.send(tvMsg('set_auth_token', ['unauthorized_user_token']));
      ws.send(tvMsg('chart_create_session', [cs, '']));
      ws.send(tvMsg('resolve_symbol', [cs, 'sds_sym_1', `={"symbol":"${symbol}"}`]));
      ws.send(tvMsg('create_series', [cs, 'sds_1', 's1', 'sds_sym_1', '1D', bars]));
    };
    ws.onmessage = (e) => {
      for (const f of tvFrames(e?.data)) {
        if (f.startsWith('~h~')) { try { ws.send(`~m~${f.length}~m~${f}`); } catch { /* closed */ } continue; }
        const b = tvBars(f);
        if (b) return end(b);
        if (/"m":"(symbol_error|series_error|critical_error|protocol_error)"/.test(f)) return end(null);
      }
    };
    ws.onerror = () => end(null);
    ws.onclose = () => end(null);
  });
}

// WSJ's diary JSON → { date, up, down, at } for NYSE, or null. Its timestamp reads "4:00 PM EST 11/12/26".
export function parseWsjDiary(j) {
  const d = j?.data;
  const ts = String(d?.timestamp || '').match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s+E[SD]T\s+(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  const vol = (d?.instrumentSets || []).find(s => /share volume/i.test(s?.headerFields?.[0]?.label || ''))?.instruments || [];
  const get = (name) => { const v = vol.find(x => x?.name === name)?.NYSE; const n = v == null ? NaN : +String(v).replace(/,/g, ''); return Number.isFinite(n) ? n : null; };
  const up = get('Advancing'), down = get('Declining');
  if (!ts || up == null || down == null) return null;
  const h = (+ts[1] % 12) + (ts[3] === 'PM' ? 12 : 0);
  return { date: `20${ts[6]}-${ts[4].padStart(2, '0')}-${ts[5].padStart(2, '0')}`, at: `${String(h).padStart(2, '0')}:${ts[2]}`, up, down };
}

export async function wsjToday({ today, fetchImpl = fetch } = {}) {
  try {
    const r = await fetchImpl(WSJ_DIARY, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const p = parseWsjDiary(await r.json());
    return p && p.date === today && p.at >= '16:00' ? { date: p.date, up: p.up, down: p.down, source: 'WSJ diary (consolidated volume)' } : null;
  } catch { return null; }
}

// The sessions the row reads: { sessions: [{date, up, down, source}], errors: [{series, error}] }.
export async function nyseVolumeInputs({ now = new Date(), tv = tvSeries, wsj = wsjToday, hist = HIST } = {}) {
  const today = NYD(now.getTime()), hm = NYHM(now.getTime());
  const errors = [];
  const byDate = new Map(historySessions(hist).map(s => [s.date, s]));
  if (!byDate.size) errors.push({ series: 'NYSE up/down volume history', error: 'no rows' });
  const [u, d] = await Promise.all([tv('USI:UVOL').catch(() => null), tv('USI:DVOL').catch(() => null)]);
  if (u && d) {
    // Today's bar is still forming until the close (and TradingView's settle a few minutes after it).
    for (const date of Object.keys(u)) if (!(date === today && hm < '16:15') && d[date] != null && u[date] + d[date] > 0) byDate.set(date, { date, up: u[date], down: d[date], source: 'TradingView' });
  } else errors.push({ series: 'TradingView USI:UVOL/DVOL', error: 'no live answer (history file read)' });
  if (!byDate.has(today)) {
    const w = await Promise.resolve().then(() => wsj({ today })).catch(() => null);
    if (w) byDate.set(today, w);
  }
  return { sessions: [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)), errors };
}
