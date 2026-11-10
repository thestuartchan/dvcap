// lib/uw.js — Unusual Whales, build step 8 (wave A): market tide, net premium, flow alerts, dark-pool
// levels, NOPE and UW's own GEX levels, read from the UW REST API with the key in UW_API_KEY.
//
// LICENCE, FIRST. The API is for personal use only, and Unusual Whales closes accounts that
// redistribute. So nothing this module returns may reach a public route, a shared Discord channel,
// an idea card, the repo or a log line. It is read only by:
//   - lib/routes/flow.js, which gates every data answer behind authorised() (the dashboard session or
//     the scheduler's service key), and
//   - the private channel (lib/alerts.js source `flow`, DISCORD_PRIVATE_WEBHOOK, Stu only).
// The public `?health=1` answer carries part names, ok flags and times — never a UW number.
//
// Every normaliser below takes the API's answer as it came and returns plain, small rows. Each is
// defensive about the envelope ({data: …} or bare) because the REST answers and UW's MCP answers
// wrap differently, and a shape we did not expect returns null (shown as "not available"), never a
// guess. Paths are UW's published ones (api.unusualwhales.com/docs); none is invented.

export const UW_BASE = 'https://api.unusualwhales.com';
export const UW_TICKERS = Object.freeze(['QQQ', 'SPY']);

// The last usage counts UW reported (lib/routes/flow.js shows them with the intraday chart).
export const uwUsage = { today: null, limit: null };
export const uwConfigured = (env = process.env) => !!String(env?.UW_API_KEY || '').trim();

const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : null; };
const rowsOf = (a) => {
  if (Array.isArray(a)) return a;
  if (a && Array.isArray(a.data)) return a.data;
  if (a && a.data && Array.isArray(a.data.data)) return a.data.data;
  if (a && Array.isArray(a.result)) return a.result;
  return null;
};
const objOf = (a) => (a && typeof a === 'object' && !Array.isArray(a) ? (a.data && typeof a.data === 'object' && !Array.isArray(a.data) ? a.data : a) : null);

// One GET. Retries once on 429/503 after Retry-After (capped at 5 s, so a scheduler run never stalls).
// Throws with the status only: the body can echo request details, and nothing here is logged.
export async function uwGet(path, { query = {}, env = process.env, fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const key = String(env?.UW_API_KEY || '').trim();
  if (!key) throw new Error('UW_API_KEY unset');
  if (!/^\/api\/[a-z0-9\-/{}_.]+$/i.test(path)) throw new Error('bad UW path');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null && v !== '') qs.append(k, String(v));
  const url = `${UW_BASE}${path}${qs.toString() ? `?${qs}` : ''}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let r;
    try { r = await fetchImpl(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${key}`, 'User-Agent': 'dvcap/1.0' }, signal: ctl.signal }); }
    finally { clearTimeout(t); }
    if ((r.status === 429 || r.status === 503) && attempt === 0) {
      const wait = Math.min(5, Number(r.headers?.get?.('retry-after')) || 2);
      await new Promise(res => setTimeout(res, wait * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`UW ${r.status}`);
    // Usage from the response headers (counts only, never data): the daily allowance is the limit
    // that applies; UW has no per-minute cap (changelog 2026-10-30).
    const used = Number(r.headers?.get?.('x-uw-daily-req-count')), cap = Number(r.headers?.get?.('x-uw-token-req-limit'));
    if (Number.isFinite(used) && used > 0) uwUsage.today = used;
    if (Number.isFinite(cap) && cap > 0) uwUsage.limit = cap;
    return r.json();
  }
  throw new Error('UW retry exhausted');
}

// Market Tide: cumulative net call and put premium through the day (5-minute points).
export function tideSummary(answer) {
  const rows = rowsOf(answer);
  if (!rows || !rows.length) return null;
  const pts = rows.map(r => ({ t: r.timestamp || null, c: num(r.net_call_premium), p: num(r.net_put_premium), v: num(r.net_volume) }))
    .filter(r => r.t && r.c != null && r.p != null);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  const net = last.c - last.p;
  return {
    date: rows[rows.length - 1].date || String(last.t).slice(0, 10), at: last.t,
    netCall: last.c, netPut: last.p, net, netVolume: last.v,
    lean: net > 0 ? 'calls' : net < 0 ? 'puts' : 'flat',
    series: pts.map(r => ({ t: r.t, c: r.c, p: r.p })),
  };
}

// Net premium ticks: per-minute rows; the day's total is their sum.
export function netPremSummary(answer) {
  const rows = rowsOf(answer);
  if (!rows || !rows.length) return null;
  let c = 0, p = 0, cv = 0, pv = 0, n = 0;
  for (const r of rows) {
    const a = num(r.net_call_premium), b = num(r.net_put_premium);
    if (a == null || b == null) continue;
    c += a; p += b; cv += num(r.net_call_volume) || 0; pv += num(r.net_put_volume) || 0; n++;
  }
  if (!n) return null;
  return { netCall: c, netPut: p, net: c - p, netCallVolume: cv, netPutVolume: pv, ticks: n, at: rows[rows.length - 1].tape_time || rows[rows.length - 1].timestamp || null };
}

// Flow alerts (unusual-activity rule hits): the fields a reader needs, nothing else.
export function flowAlertRows(answer, { limit = 25 } = {}) {
  const rows = rowsOf(answer);
  if (!rows) return null;
  return rows.slice(0, limit).map(r => {
    const prem = num(r.total_premium), ask = num(r.total_ask_side_prem), bid = num(r.total_bid_side_prem);
    const side = prem && ask != null && bid != null ? (ask / prem >= 0.6 ? 'ask' : bid / prem >= 0.6 ? 'bid' : 'mixed') : null;
    return {
      ticker: r.ticker || null, type: r.type || null, strike: num(r.strike), expiry: r.expiry || null,
      premium: prem, size: num(r.total_size), side, rule: r.alert_rule || null,
      sweep: !!r.has_sweep, floor: !!r.has_floor, opening: !!r.all_opening_trades,
      volOi: num(r.volume_oi_ratio), underlying: num(r.underlying_price), at: r.created_at || null,
    };
  }).filter(r => r.ticker);
}

// Dark-pool price levels: the prices where most off-exchange volume printed, biggest first.
export function darkpoolLevels(answer, { top = 5, spot = null, bandPct = 6 } = {}) {
  const o = objOf(answer);
  const rows = (o && Array.isArray(o.stock_price_vol) ? o.stock_price_vol : null) || rowsOf(answer);
  if (!rows) return null;
  const lv = rows.map(r => ({ price: num(r.price), dp: num(r.dark_pool_volume), lit: num(r.regular_volume) }))
    .filter(r => r.price != null && r.dp != null && r.dp > 0)
    .filter(r => spot == null || Math.abs(r.price / spot - 1) * 100 <= bandPct);
  const total = lv.reduce((s, r) => s + r.dp, 0) || 1;
  return lv.sort((a, b) => b.dp - a.dp).slice(0, top).map(r => ({ ...r, share: r.dp / total }));
}

// UW's own GEX levels (directionalized volume by default) — the cross-check against dvcap's board.
export function gexLevelsOf(answer) {
  const o = objOf(answer);
  if (!o) return null;
  const pick = (k) => num(o[k]);
  const out = { callWall: pick('call_wall'), putWall: pick('put_wall'), flip: pick('gamma_flip'), magnet: pick('gamma_magnet'),
    nearbyFlips: Array.isArray(o.nearby_flips) ? o.nearby_flips.map(num).filter(v => v != null).slice(0, 5) : [],
    source: o.source || null, date: o.date || null, time: o.time || null };
  return out.callWall == null && out.putWall == null && out.flip == null && out.magnet == null ? null : out;
}

// NOPE: the latest minute's value (the API's field names vary by version; take the first present).
export function nopeLast(answer) {
  const rows = rowsOf(answer);
  if (!rows || !rows.length) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const v = num(r.nope ?? r.nope_value ?? r.value);
    if (v != null) return { nope: v, fill: num(r.nope_fill), at: r.timestamp || r.tape_time || null };
  }
  return null;
}

// dvcap's board vs UW's: how far apart the call wall and flip sit, in % of spot. Agreement is a
// line in the panel; disagreement over 0.5% is flagged, never "resolved" — both views are shown.
export function gammaCrossCheck(uw, dv, spot) {
  if (!uw || !dv || !Number.isFinite(spot) || spot <= 0) return null;
  const d = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? +(((a - b) / spot) * 100).toFixed(2) : null);
  const wall = d(uw.callWall, dv.callWall), flip = d(uw.flip, dv.flip);
  const far = [wall, flip].some(x => x != null && Math.abs(x) > 0.5);
  return { wallGapPct: wall, flipGapPct: flip, agree: !far && (wall != null || flip != null) };
}

// One snapshot: the market tide plus, per ticker, net premium, flow alerts, dark-pool levels, UW's
// GEX levels and NOPE. Each part fails alone (its error recorded as a short code), so one slow
// endpoint never blanks the panel. `get` is uwGet, passed in so the tests control the network.
export async function flowSnapshot({ tickers = UW_TICKERS, get, now = new Date(), alertLimit = 12 } = {}) {
  const parts = {};
  const run = async (name, fn) => { try { const v = await fn(); parts[name] = v == null ? 'empty' : 'ok'; return v; } catch (e) { parts[name] = String(e?.message || e).slice(0, 40); return null; } };
  const tide = await run('tide', async () => tideSummary(await get('/api/market/market-tide', { query: { interval_5m: true } })));
  const byTicker = {};
  for (const t of tickers) {
    const T = encodeURIComponent(t);
    const prem = await run(`${t}:netprem`, async () => netPremSummary(await get(`/api/stock/${T}/net-prem-ticks`)));
    const alerts = await run(`${t}:alerts`, async () => flowAlertRows(await get(`/api/stock/${T}/flow-alerts`, { query: { limit: alertLimit } }), { limit: alertLimit }));
    const gex = await run(`${t}:gex`, async () => gexLevelsOf(await get(`/api/stock/${T}/gex-levels`)));
    const spot = alerts?.find(a => a.underlying != null)?.underlying ?? null;
    const dp = await run(`${t}:darkpool`, async () => darkpoolLevels(await get(`/api/darkpool/${T}/price-levels`), { spot }));
    const nope = await run(`${t}:nope`, async () => nopeLast(await get(`/api/stock/${T}/nope`)));
    byTicker[t] = { netPrem: prem, alerts, gex, darkpool: dp, nope, spot };
  }
  const ok = Object.values(parts).filter(v => v === 'ok').length;
  return { at: (now instanceof Date ? now : new Date(now)).toISOString(), tide, tickers: byTicker, parts, ok, of: Object.keys(parts).length };
}

// The part names and states only: what the public health answer may say.
export const healthOf = (snap) => (snap ? { at: snap.at, ok: snap.ok, of: snap.of, parts: snap.parts } : null);

// A compact daily row for the 60-day keep-or-cancel scorecard (step 9 scores it against the session).
export function dailyRow(snap) {
  if (!snap?.tide) return null;
  const t = (k) => snap.tickers?.[k] || {};
  return {
    date: snap.tide.date, tideNet: snap.tide.net, tideLean: snap.tide.lean,
    ...Object.fromEntries(Object.keys(snap.tickers || {}).flatMap(k => [
      [`${k}_net`, t(k).netPrem?.net ?? null], [`${k}_alerts`, t(k).alerts?.length ?? null], [`${k}_nope`, t(k).nope?.nope ?? null],
    ])),
  };
}

const usdShort = (v) => (v == null ? '—' : `${v < 0 ? '−' : '+'}$${Math.abs(v) >= 1e9 ? (Math.abs(v) / 1e9).toFixed(2) + 'bn' : Math.abs(v) >= 1e6 ? (Math.abs(v) / 1e6).toFixed(1) + 'M' : Math.round(Math.abs(v) / 1e3) + 'k'}`);
export { usdShort };

// The close card for the PRIVATE channel only (lib/alerts.js source `flow`).
// "Mon 9 Nov" from YYYY-MM-DD; anything else passes through.
const dayLabel = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return d || '';
  const t = new Date(`${d}T12:00:00Z`);
  return `${t.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })} ${t.getUTCDate()} ${t.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })}`;
};
const usdPlain = (v) => usdShort(v).replace(/^\+/, '');
const two = (v) => { const r = (+v).toFixed(2); return r === '-0.00' ? '0.00' : r.replace('-', '−'); };
const LEAN_WORD = { calls: 'Calls lead', puts: 'Puts lead', flat: 'Flat' };
const SIDE_WORD = { ask: 'at the ask', bid: 'at the bid', mixed: 'mixed' };

// THE PLAIN READ (Stu, 10 Nov: "I need to know in simpler terms what it's telling me"). One short
// line per item, the standard reading of each figure, no forecast:
//   net premium  money paid for calls minus puts, at the ask minus at the bid: + = buyers leaned bullish
//   NOPE         options' net delta vs share volume: near 0 = options are not pushing the stock
//   gamma flip   above it dealers damp moves; below it they chase them (moves run further)
//   alert side   at the ask = an eager buyer; at the bid = an eager seller
const sizeWord = (v) => { const a = Math.abs(v || 0); return a >= 250e6 ? 'heavy' : a >= 50e6 ? 'clear' : a >= 10e6 ? 'light' : 'barely any'; };
export function plainRead(snap) {
  const out = [];
  const t = snap?.tide;
  if (t) {
    const tn = t.net ?? ((t.netCall ?? 0) - (t.netPut ?? 0));
    out.push(t.lean === 'calls' ? `Market-wide: options money leaned **bullish** (${sizeWord(tn)} call buying / put selling).`
      : t.lean === 'puts' ? `Market-wide: options money leaned **bearish** (${sizeWord(tn)} put buying / call selling).`
        : 'Market-wide: options money was **balanced**.');
  }
  for (const [k, v] of Object.entries(snap?.tickers || {})) {
    const bits = [];
    const net = v.netPrem?.net;
    if (net != null) bits.push(net > 0 ? `${sizeWord(net)} **bullish** flow` : net < 0 ? `${sizeWord(net)} **bearish** flow` : 'no net flow');
    const n = v.nope?.nope;
    if (n != null) bits.push(Math.abs(n) < 0.5 ? 'options not pushing the price' : n > 0 ? 'options adding buying pressure' : 'options adding selling pressure');
    const spot = v.spot, flip = v.gex?.flip, wall = v.gex?.callWall;
    if (spot != null && flip != null) bits.push(spot < flip ? `price below UW's flip (${flip}): moves can run further` : `price above UW's flip (${flip}): moves tend to be damped`);
    if (spot != null && wall != null && wall > spot) bits.push(`ceiling near ${wall}`);
    const top = (v.alerts || []).slice().sort((a, b) => (b.premium || 0) - (a.premium || 0))[0];
    if (top?.side === 'ask' || top?.side === 'bid') bits.push(`biggest unusual trade: ${top.type}s ${top.side === 'ask' ? 'bought' : 'sold'}`);
    if (bits.length) out.push(`${k}: ${bits.join('; ')}.`);
  }
  return out;
}

// The private close card: the plain read first, then one field per ticker, label → value lines.
export function closeCard(snap) {
  if (!snap?.tide) return null;
  const t = snap.tide;
  const plain = plainRead(snap);
  const fields = [];
  if (plain.length) fields.push({ name: 'What it says', value: plain.join('\n').slice(0, 1024), inline: false });
  fields.push({ name: 'Market Tide', value: `**${LEAN_WORD[t.lean] || t.lean}** · net calls ${usdShort(t.netCall)} · net puts ${usdShort(t.netPut)}`, inline: false });
  for (const [k, v] of Object.entries(snap.tickers || {})) {
    const top = (v.alerts || []).slice().sort((a, b) => (b.premium || 0) - (a.premium || 0))[0];
    const lines = [
      `Net premium **${usdShort(v.netPrem?.net)}**${v.nope?.nope != null ? ` · NOPE ${two(v.nope.nope)}` : ''}`,
      [v.gex?.callWall != null ? `UW call wall ${v.gex.callWall}` : '', v.gex?.flip != null ? `flip ${v.gex.flip}` : '', v.gex?.putWall != null ? `put wall ${v.gex.putWall}` : ''].filter(Boolean).join(' · '),
      top ? `Top alert: ${top.type} ${top.strike} ${dayLabel(top.expiry)} · ${usdPlain(top.premium)}${top.side ? ` ${SIDE_WORD[top.side] || top.side}` : ''}` : '',
    ].filter(Boolean);
    fields.push({ name: k, value: lines.join('\n').slice(0, 1024), inline: false });
  }
  return {
    allowed_mentions: { parse: [] },
    embeds: [{ title: `🐋 Flow at the close · ${dayLabel(t.date)}`, color: 0x8E6CD8, fields,
      footer: { text: 'Unusual Whales · personal use · private channel only' } }],
  };
}

// ── 0DTE INTRADAY FLOW (10 Nov 2026; Stu trades a lot of 0DTE) ───────────────
// Per-minute directional delta flow (UW /stock/{T}/greek-flow: options' net delta bought minus sold,
// by minute; summed here into a running total from the open), the same for today's expiry only
// (/greek-flow/{expiry}), and 1-minute prices (/ohlc/1m). A VIEW for the Gamma tab: it never feeds the
// trade-day call, the checkpoints or any card.
const SESSION_OPEN_MIN = 9 * 60 + 30, SESSION_END_MIN = 16 * 60 + 15;
const nyParts = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
};
export const nyDayOf = (now = new Date()) => nyParts((now instanceof Date ? now : new Date(now)).toISOString())?.day || null;
const minuteKey = (iso) => { const d = new Date(iso); if (Number.isNaN(d.getTime())) return null; d.setUTCSeconds(0, 0); return d.toISOString(); };

// Per-minute directional delta from a greek-flow answer → Map(minute ISO → number), session minutes only.
export function dirDeltaByMinute(answer, day = null) {
  const rows = rowsOf(answer);
  const out = new Map();
  for (const r of rows || []) {
    const t = r?.timestamp || r?.tape_time || r?.time;
    const v = num(r?.dir_delta_flow);
    if (!t || v == null) continue;
    const ny = nyParts(t);
    if (!ny || (day && ny.day !== day) || ny.min < SESSION_OPEN_MIN || ny.min > SESSION_END_MIN) continue;
    const k = minuteKey(t);
    out.set(k, (out.get(k) || 0) + v);
  }
  return out;
}
// 1-minute closes from an OHLC answer (REST: start_time/close; tolerant of start/c) → Map(minute ISO → close).
export function closesByMinute(answer, day = null) {
  const rows = rowsOf(answer);
  const out = new Map();
  for (const r of rows || []) {
    const t = r?.start_time || r?.start || r?.timestamp;
    const c = num(r?.close ?? r?.c);
    if (!t || c == null) continue;
    const ny = nyParts(t);
    if (!ny || (day && ny.day !== day) || ny.min < SESSION_OPEN_MIN || ny.min > SESSION_END_MIN) continue;
    out.set(minuteKey(t), c);
  }
  return out;
}
// The chart's points: every minute that has flow or a price, with running totals from the open.
export function intradayPoints({ all = new Map(), zero = new Map(), price = new Map() } = {}) {
  const keys = [...new Set([...all.keys(), ...zero.keys(), ...price.keys()])].sort();
  let cum = 0, cum0 = 0, last = null;
  const pts = [];
  for (const k of keys) {
    cum += all.get(k) || 0; cum0 += zero.get(k) || 0;
    if (price.has(k)) last = price.get(k);
    pts.push({ t: k, price: last, cum: Math.round(cum), cum0: Math.round(cum0) });
  }
  return pts;
}
export async function intradaySnapshot({ ticker, get, now = new Date() } = {}) {
  const T = encodeURIComponent(String(ticker || '').toUpperCase());
  const day = nyDayOf(now);
  const parts = {};
  const run = async (name, fn) => { try { const v = await fn(); parts[name] = v && v.size ? 'ok' : 'empty'; return v || new Map(); } catch (e) { parts[name] = String(e?.message || e).slice(0, 40); return new Map(); } };
  const all = await run('flow', async () => dirDeltaByMinute(await get(`/api/stock/${T}/greek-flow`), day));
  const zero = await run('0dte', async () => dirDeltaByMinute(await get(`/api/stock/${T}/greek-flow/${day}`), day));
  const price = await run('price', async () => closesByMinute(await get(`/api/stock/${T}/ohlc/1m`, { query: { limit: 500 } }), day));
  const points = intradayPoints({ all, zero, price });
  const lastPt = points[points.length - 1] || null;
  return { at: (now instanceof Date ? now : new Date(now)).toISOString(), ticker: decodeURIComponent(T), day, parts,
    ok: Object.values(parts).filter(v => v === 'ok').length, of: Object.keys(parts).length,
    last: lastPt, points };
}
