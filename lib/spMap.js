// lib/spMap.js — the S&P map: SPX index gamma read in SPY prices, beside the SPY board (12 Oct 2026).
//
// WHY. The S&P board read SPY's options only. SPX index options (SPX + SPXW) are the much bigger
// pool — about 94% of S&P options gamma on 12 Oct (+$99bn per 1% against SPY's +$7–8bn) — and some
// levels exist only there: 7900 → SPY 787.4 was the biggest S&P wall and nothing on the SPY board
// showed it. Stu trades SPY, MES and ES, not SPX, so SPX is a MAP converted into SPY prices (and ES
// equivalents), never a separate board to trade off.
//
// THE CONVERSION. ratio = SPY spot ÷ SPX spot, both read at the same moment — never a fixed 10: the
// ratio drifts with dividends (0.09967 on 12 Oct). Two reads more than RATIO_GAP_WARN_MIN apart are
// still converted but flagged ⚠ with the gap. ES = SPX + basis, basis = ES front − SPX, both live;
// when SPX is not printing (outside the session) the last regular-session basis is used and said.
//
// THE AGREEMENT. Within ±BAND_PCT of spot, converted:
//   ★ agree      an SPY node and an SPX node of the same sign within AGREE_PCT of each other, each at
//                least AGREE_MIN_FRAC of its own book's largest node in the band;
//   ◆ spx_only   an SPX top node (top TOP_POS positive, TOP_NEG negative) with no qualifying SPY node;
//   ✗ disagree   a qualifying node of the OTHER sign within AGREE_PCT — the two books point opposite ways;
//   spy_only     an SPY level with no qualifying SPX node near it (said, never coloured red).
// Both flips are shown; more than GREY_ZONE_PCT apart, the space between them is a grey zone. A wall
// carried more than TODAY_WARN by today's expiry says it rolls off at the close.
//
// Pure: the boards are the feed's (lib/gexFeed.js via lib/gammaMcp.js dashboardFor), the quotes are
// passed in. fetchSpRates (below) is the one function that reads the network.

export const RATIO_GAP_WARN_MIN = 5;
export const BAND_PCT = 3;
export const AGREE_PCT = 0.1;
export const AGREE_MIN_FRAC = 0.25;
export const TOP_POS = 5, TOP_NEG = 3;
export const GREY_ZONE_PCT = 0.2;
export const TODAY_WARN = 0.5;
export const LADDER_BAND_PCT = 3.5;

const num = (v) => (v == null || v === '' || !Number.isFinite(+v)) ? null : +v;
const r2 = (v) => (num(v) == null ? null : +(+v).toFixed(2));
const r5 = (v) => (num(v) == null ? null : +(+v).toFixed(5));
const isoOf = (ts) => (num(ts) == null ? null : new Date(+ts * 1000).toISOString());

// ── THE TWO NUMBERS EVERY CONVERSION RESTS ON ─────────────────────────────────
// spy / spx: { price, ts (unix s), session: 'open' | 'closed', date (the session date of the price) }.
// Inside the session both are live prints and the gap is the clock between them. Outside it both are
// the last regular closes — the same moment by definition — and are paired by session date, because
// the vendor's last-update stamps on two closing prints can sit an hour apart without either moving.
export function spxRatio({ spy, spx } = {}) {
  const a = num(spy?.price), b = num(spx?.price);
  if (!(a > 0) || !(b > 0)) return { ratio: null, reason: !(a > 0) ? 'no SPY price' : 'no SPX price' };
  const closes = spy?.session !== 'open' && spx?.session !== 'open' && spy?.date && spy.date === spx?.date;
  const gapMin = closes ? 0 : (num(spy?.ts) != null && num(spx?.ts) != null ? Math.round(Math.abs(spy.ts - spx.ts) / 60) : null);
  return {
    ratio: r5(a / b), spy: a, spx: b,
    asof: closes ? `${spx.date} close` : isoOf(Math.min(num(spy?.ts) ?? Infinity, num(spx?.ts) ?? Infinity)),
    basis: closes ? 'both last regular closes' : 'live prints',
    gapMin, warn: gapMin != null && gapMin > RATIO_GAP_WARN_MIN,
  };
}

// es: { price, ts } the front contract now; spx as above; `atClose`: ES at SPX's last regular print
// ({ price, ts }), for when SPX is not printing.
export function esBasis({ es, spx, atClose = null } = {}) {
  const e = num(es?.price), s = num(spx?.price);
  if (!(s > 0)) return { basis: null, reason: 'no SPX price' };
  if (spx?.session === 'open' && e > 0) {
    return { basis: r2(e - s), asof: isoOf(Math.min(num(es?.ts) ?? Infinity, num(spx?.ts) ?? Infinity)), label: 'live', es: e };
  }
  const c = num(atClose?.price);
  if (c > 0) return { basis: r2(c - s), asof: isoOf(atClose.ts) ?? (spx?.date ? `${spx.date} close` : null), label: 'last regular-session basis (ES at the SPX close)', es: c };
  return { basis: null, reason: 'SPX is not printing and no ES print at its close was found' };
}

export const spyEq = (spxStrike, ratio) => (num(spxStrike) == null || !(num(ratio) > 0) ? null : r2(spxStrike * ratio));
export const esEq = (spxLevel, basis) => (num(spxLevel) == null || num(basis) == null ? null : r2(spxLevel + basis));
const spxOf = (spyPrice, ratio) => (num(spyPrice) == null || !(num(ratio) > 0) ? null : spyPrice / ratio);

// ── THE MAP ──────────────────────────────────────────────────────────────────
// spyDash / spxDash: dashboardFor() answers ({ levels, ladder, meta }) with the ladder in $M per 1%,
// split nearest / monthly / other. `today` is the New York trading date.
export function spMap({ spyDash, spxDash, ratio, basis, today = null } = {}) {
  const rt = num(ratio?.ratio), bs = num(basis?.basis);
  const spySpot = num(spyDash?.meta?.spot), spxSpot = num(spxDash?.meta?.spot);
  if (!(rt > 0) || !(spySpot > 0) || !(spxSpot > 0)) return { ok: false, reason: !(rt > 0) ? (ratio?.reason || 'no ratio') : 'a board is missing' };
  const inBand = (k, s) => Math.abs(k / s - 1) * 100 <= BAND_PCT + 1e-9;
  const todayShare = (row) => {
    if (!row || !today || !row.gamma_mn) return null;
    const t = row.near_expiry === today && row.near_expiry !== row.monthly_expiry ? row.near_mn
      : row.monthly_expiry === today ? row.monthly_mn : 0;
    return Math.sign(t) === Math.sign(row.gamma_mn) ? Math.abs(t / row.gamma_mn) : 0;
  };
  const spyRows = (spyDash.ladder || []).filter(r => inBand(r.strike, spySpot));
  const spxRows = (spxDash.ladder || []).filter(r => inBand(r.strike, spxSpot)).map(r => ({ ...r, spy: spyEq(r.strike, rt) }));
  const maxOf = (rows) => Math.max(0, ...rows.map(r => Math.abs(r.gamma_mn)));
  const spyMax = maxOf(spyRows), spxMax = maxOf(spxRows);
  const qualSpy = (r) => spyMax > 0 && Math.abs(r.gamma_mn) >= AGREE_MIN_FRAC * spyMax;
  const qualSpx = (r) => spxMax > 0 && Math.abs(r.gamma_mn) >= AGREE_MIN_FRAC * spxMax;
  const near = (a, b) => Math.abs(a - b) / b * 100 <= AGREE_PCT + 1e-9;
  const spyAt = (k) => spyRows.find(r => r.strike === k) || null;

  // An SPX node's verdict against the SPY book.
  const judgeSpx = (x) => {
    const same = spyRows.filter(r => near(r.strike, x.spy) && qualSpy(r) && Math.sign(r.gamma_mn) === Math.sign(x.gamma_mn));
    if (same.length && qualSpx(x)) return { agreement: 'agree', with: same.sort((a, b) => Math.abs(b.gamma_mn) - Math.abs(a.gamma_mn))[0] };
    const opp = spyRows.filter(r => near(r.strike, x.spy) && qualSpy(r) && Math.sign(r.gamma_mn) !== Math.sign(x.gamma_mn));
    if (opp.length && qualSpx(x)) return { agreement: 'disagree', with: opp[0] };
    return { agreement: 'spx_only', with: null };
  };
  // An SPY level's verdict against the SPX book.
  const judgeSpy = (price, sign) => {
    const cands = spxRows.filter(x => near(x.spy, price) && qualSpx(x));
    const same = cands.filter(x => Math.sign(x.gamma_mn) === sign).sort((a, b) => Math.abs(b.gamma_mn) - Math.abs(a.gamma_mn));
    const opp = cands.filter(x => Math.sign(x.gamma_mn) !== sign);
    if (same.length) return { agreement: 'agree', with: same[0] };
    if (opp.length) return { agreement: 'disagree', with: opp[0] };
    return { agreement: 'spy_only', with: null };
  };
  const rollNote = (share) => (share != null && share > TODAY_WARN ? `${Math.round(share * 100)}% today's expiry — rolls off at the close` : null);
  const rowOut = (o) => ({ label: o.label, spy: o.spy ?? null, spx: o.spx ?? null, spx_spy_eq: o.spx != null ? spyEq(o.spx, rt) : null,
    es_eq: o.spx != null ? esEq(o.spx, bs) : (o.spy != null && bs != null ? esEq(spxOf(o.spy, rt), bs) : null),
    agreement: o.agreement, note: o.note ?? null, ...(o.kind ? { kind: o.kind } : {}) });

  const levels = [];
  // ── THE LABELLED LEVELS, BOTH BOARDS ──
  // One row per label: SPY's own level, and SPX's own level of the same name (its wall, its pin box,
  // its trapdoors — the SPX board carries the same labels), converted. The agreement is the node
  // rule above, at the SPY level's price: is there an SPX node of size and the same sign right there.
  const SPY_KEYS = { wall: 'Call wall', pin_hi: 'Pin box top', pin_lo: 'Pin box bottom', magnet: 'Magnet', trap_near: 'Near trapdoor', trap_deep: 'Deep trapdoor', pivot: 'Post-expiry pivot' };
  const spxSame = (key, nth) => num((spxDash.levels || []).filter(l => l.key === key)[nth]?.strike);
  const seen = {};
  for (const lv of (spyDash.levels || []).filter(l => SPY_KEYS[l.key] && num(l.strike) != null)) {
    const nth = seen[lv.key] = (seen[lv.key] ?? -1) + 1;
    const price = num(lv.strike);
    const at = spyAt(price);
    const sign = at ? Math.sign(at.gamma_mn) || 1 : (lv.key.startsWith('trap') ? -1 : 1);
    const j = judgeSpy(price, sign);
    const own = spxSame(lv.key, nth);
    const notes = [];
    if (j.agreement === 'agree') notes.push(`SPX ${j.with.strike} (${j.with.gamma_mn > 0 ? '+' : ''}${(j.with.gamma_mn / 1000).toFixed(1)}bn) sits at the same price`);
    if (j.agreement === 'disagree') notes.push(`SPX ${j.with.strike} is ${j.with.gamma_mn > 0 ? 'positive' : 'negative'} here — the books point opposite ways`);
    if (j.agreement === 'spy_only') notes.push('no SPX node of size within 0.1% — SPY-only');
    const roll = lv.key === 'wall' ? rollNote(todayShare(at)) : null;
    if (roll) notes.push(roll);
    levels.push(rowOut({ label: SPY_KEYS[lv.key], kind: lv.key, spy: price, spx: own, agreement: j.agreement, note: notes.join(' · ') || null }));
  }
  // SPX labels SPY lacks (SPY has no deep trapdoor, say): SPX's own level, converted.
  for (const key of Object.keys(SPY_KEYS)) {
    const mine = (spyDash.levels || []).filter(l => l.key === key).length;
    (spxDash.levels || []).filter(l => l.key === key).slice(mine).forEach(l => {
      const x = spxRows.find(r => r.strike === num(l.strike));
      const j = x ? judgeSpx(x) : { agreement: 'spx_only' };
      levels.push(rowOut({ label: SPY_KEYS[key], kind: key, spx: num(l.strike), agreement: j.agreement === 'agree' ? 'agree' : 'spx_only', note: 'SPX board only' }));
    });
  }
  // ── THE SPX BOOK'S OWN TOP NODES ──
  // A top node is also a node of size (AGREE_MIN_FRAC of the band's largest): fifth place among four
  // real walls and a sliver is not a level to flag.
  const pos = spxRows.filter(x => x.gamma_mn > 0 && qualSpx(x)).sort((a, b) => b.gamma_mn - a.gamma_mn).slice(0, TOP_POS);
  const neg = spxRows.filter(x => x.gamma_mn < 0 && qualSpx(x)).sort((a, b) => a.gamma_mn - b.gamma_mn).slice(0, TOP_NEG);
  const top = [...pos.map((x, i) => ({ x, i, s: 1 })), ...neg.map((x, i) => ({ x, i, s: -1 }))];
  const nodes = [];
  for (const { x, i, s } of top) {
    const j = judgeSpx(x);
    const what = s > 0 ? (i === 0 ? 'biggest S&P wall' : `SPX positive #${i + 1}`) : (i === 0 ? 'largest SPX negative' : `SPX negative #${i + 1}`);
    const notes = [`${(x.gamma_mn / 1000).toFixed(1)}bn per 1%`];
    if (j.agreement === 'agree') notes.push(`SPY ${j.with.strike} agrees`);
    if (j.agreement === 'disagree') notes.push(`SPY ${j.with.strike} has the other sign`);
    const roll = s > 0 ? rollNote(todayShare(x)) : null;
    if (roll) notes.push(roll);
    const row = rowOut({ label: `SPX ${x.strike} — ${what}`, kind: s > 0 ? 'spx_pos' : 'spx_neg', spx: x.strike, agreement: j.agreement, note: notes.join(' · ') });
    levels.push(row);
    nodes.push({ spx: x.strike, spy: x.spy, spy_strike: Math.round(x.spy), gamma_mn: x.gamma_mn, agreement: j.agreement, what, spy_with: j.with?.strike ?? null });
  }
  // ── BOTH FLIPS ──
  const spyFlip = num((spyDash.levels || []).find(l => l.key === 'flip')?.strike);
  const spxFlip = num((spxDash.levels || []).find(l => l.key === 'flip')?.strike);
  const spxFlipSpy = spxFlip != null ? spyEq(spxFlip, rt) : null;
  const gapPct = spyFlip != null && spxFlipSpy != null ? Math.abs(spyFlip - spxFlipSpy) / spySpot * 100 : null;
  const grey = gapPct != null && gapPct > GREY_ZONE_PCT ? { lo: r2(Math.min(spyFlip, spxFlipSpy)), hi: r2(Math.max(spyFlip, spxFlipSpy)), gap_pct: r2(gapPct) } : null;
  const flipNote = grey ? `grey zone ${grey.lo}–${grey.hi} (${grey.gap_pct}% apart): between the two flips the books disagree on the regime` : (gapPct != null ? `within ${r2(gapPct)}% — one flip` : null);
  if (spyFlip != null || spxFlip != null) {
    levels.unshift(rowOut({ label: 'Flip', kind: 'flip', spy: r2(spyFlip), spx: spxFlip != null ? r2(spxFlip) : null,
      agreement: grey ? 'disagree' : (spyFlip != null && spxFlip != null ? 'agree' : null), note: flipNote }));
  }

  // ── SPX GAMMA IN SPY $1 STRIKES, FOR THE DUAL LADDER ──
  const buckets = new Map();
  for (const r of (spxDash.ladder || [])) {
    const k = Math.round(spyEq(r.strike, rt));
    const b = buckets.get(k) || { spy_strike: k, gamma_mn: 0, near_mn: 0, monthly_mn: 0, other_mn: 0 };
    b.gamma_mn += r.gamma_mn; b.near_mn += r.near_mn; b.monthly_mn += r.monthly_mn; b.other_mn += r.other_mn;
    buckets.set(k, b);
  }
  const spxLadderSpy = [...buckets.values()].sort((a, b) => b.spy_strike - a.spy_strike);

  const net = (d) => num((d.levels || []).find(l => l.key === 'net')?.gamma_bn);
  const spyNet = net(spyDash), spxNet = net(spxDash);
  return {
    ok: true,
    ratio: rt, ratio_asof: ratio.asof ?? null, ratio_gap_min: ratio.gapMin ?? null, ratio_warn: !!ratio.warn, ratio_basis: ratio.basis ?? null,
    es_basis: bs, es_basis_asof: basis?.asof ?? null, es_basis_label: basis?.label ?? basis?.reason ?? null,
    spy: { spot: spySpot, net_bn: spyNet, flip: r2(spyFlip) },
    spx: { spot: spxSpot, net_bn: spxNet, flip: r2(spxFlip), flip_spy: spxFlipSpy },
    spx_share_pct: spyNet != null && spxNet != null && spyNet + spxNet !== 0 ? r2(spxNet / (spyNet + spxNet) * 100) : null,
    grey_zone: grey,
    levels, nodes,
    spx_ladder_spy: spxLadderSpy,
  };
}

// The block the connector returns: the brief's shape, nothing more.
export function spMapBlock(m) {
  if (!m?.ok) return { unavailable: m?.reason || 'no map' };
  return { ratio: m.ratio, ratio_asof: m.ratio_asof, ...(m.ratio_warn ? { ratio_warning: `SPY and SPX read ${m.ratio_gap_min} minutes apart` } : {}),
    es_basis: m.es_basis, es_basis_asof: m.es_basis_asof, es_basis_label: m.es_basis_label,
    levels: m.levels.map(({ kind: _kind, ...r }) => r), spx_ladder_spy: m.spx_ladder_spy };
}

// ── THE DUAL LADDER'S ROWS (the panel) ──
// One row per SPY $1 strike inside ±LADDER_BAND_PCT: SPY's own gamma and SPX's converted, each in $M,
// and the highlight the agreement rules give it — ★ agree (gold), ◆ spx_only (blue) — with its label.
export function dualLadder(m, spyDash, { bandPct = LADDER_BAND_PCT } = {}) {
  if (!m?.ok) return [];
  const s = m.spy.spot;
  const spyBy = new Map((spyDash?.ladder || []).map(r => [Math.round(r.strike), r.gamma_mn]));
  const spxBy = new Map(m.spx_ladder_spy.map(r => [r.spy_strike, r.gamma_mn]));
  const keys = [...new Set([...spyBy.keys(), ...spxBy.keys()])].filter(k => Math.abs(k / s - 1) * 100 <= bandPct + 1e-9).sort((a, b) => b - a);
  const marks = new Map();
  for (const n of m.nodes) {
    if (n.agreement !== 'agree' && n.agreement !== 'spx_only') continue;
    const k = n.agreement === 'agree' && n.spy_with != null ? Math.round(n.spy_with) : n.spy_strike;
    if (!marks.has(k)) marks.set(k, { mark: n.agreement, label: `${k} · SPX ${n.spx}: ${n.what}${n.agreement === 'agree' ? ', SPY agrees' : ''}` });
  }
  return keys.map(k => ({ spy_strike: k, spy_mn: spyBy.get(k) ?? 0, spx_mn: spxBy.get(k) ?? 0, ...(marks.get(k) || {}) }));
}

// ── THE QUOTES (network) ──
// SPY and SPX (^GSPC) and the ES front (ES=F) from the same Yahoo quote call the pre-read uses, and ES
// at SPX's last regular print from Yahoo's 5-minute ES bars when SPX is not printing. CME's own pages
// refuse automated reads (403, "scraping … strictly prohibited", 12 Oct), so ES is Yahoo's feed of
// the CME contract and is labelled so.
export async function fetchSpRates({ getQuotes, marketState, fetchImpl = fetch, now = new Date() } = {}) {
  const qs = await getQuotes(['SPY', '^GSPC', 'ES=F'], { prepost: false });
  const q = Object.fromEntries((qs || []).map(x => [x.sym, x]));
  const nyDate = (ts) => (num(ts) == null ? null : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts * 1000)));
  const side = (sym, st) => ({ price: num(q[sym]?.price), ts: num(q[sym]?.ts), session: st, date: nyDate(q[sym]?.ts) });
  const open = marketState('SPY') === 'open';
  const spy = side('SPY', open ? 'open' : 'closed');
  const spx = side('^GSPC', open ? 'open' : 'closed');
  const es = { price: num(q['ES=F']?.price), ts: num(q['ES=F']?.ts) };
  let atClose = null;
  if (!open && spx.ts) {
    try {
      const r = await fetchImpl('https://query1.finance.yahoo.com/v8/finance/chart/ES%3DF?interval=5m&range=5d', { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      const j = r.ok ? await r.json() : null;
      const res = j?.chart?.result?.[0];
      const ts = res?.timestamp || [], cl = res?.indicators?.quote?.[0]?.close || [];
      // The SPX close is 16:00 New York; its own stamp can run later. The ES bar that ENDS at the
      // session close (the 15:55 bar) is the pairing.
      const closeTs = Date.parse(`${spx.date}T16:00:00${nyOffset(spx.date)}`) / 1000;
      let best = null;
      for (let i = 0; i < ts.length; i++) if (cl[i] != null && ts[i] + 300 <= closeTs + 1 && (!best || ts[i] > best.ts)) best = { ts: ts[i] + 300, price: cl[i] };
      if (best && closeTs - best.ts <= 900) atClose = best;
    } catch { /* the basis says it could not be read */ }
  }
  return { spy, spx, es, atClose, at: now.toISOString() };
}
// New York's UTC offset on a date, as "-04:00" / "-05:00".
function nyOffset(date) {
  const t = new Date(`${date}T12:00:00Z`);
  const h = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(t);
  const off = h - 12;
  return `${off < 0 ? '-' : '+'}${String(Math.abs(off)).padStart(2, '0')}:00`;
}
