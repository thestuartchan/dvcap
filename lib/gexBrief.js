// lib/gexBrief.js — the day-trade layer of the pre-read: where price sits against the option book.
//
// WHY THE PRE-READ CANNOT HAVE FRESH GEX, AND WHY THAT IS SURVIVABLE.
//
// Yahoo serves NO open interest before the US open. Measured 2026-09-02 at 09:30 UTC, four hours
// pre-open: the 0DTE expiry returned 209 contracts carrying 922,440 of volume and ZERO open
// interest. The implied-vol surface is then broken for roughly twenty minutes after the bell (the
// 6.6% reading of 2026-09-09). So the first usable fresh capture of a session is about 13:50 UTC —
// after the US brief fires at 12:42 and after the 09:45 ET deadline that stops it being a pre-read.
//
// There is no schedule that fixes this. The vendor does not have the data yet.
//
// But open interest SETTLES OVERNIGHT and does not move during a session, so the stale part of a
// stored capture is only its spot and its clock — and both are cheap to replace. That is the whole
// idea here: take the best positioning available, reprice it at the live pre-market spot, and say
// out loud which half is current.
//
// A CASCADE, NOT A SWITCH. Four rungs, each labelled, so the section degrades instead of vanishing:
//
//   1. `occ`      today's settled open interest from the OCC (authoritative; both Yahoo and CBOE
//                 derive from it — verified 2026-09-09, 5,055 shared QQQ series, zero differences)
//                 combined with the stored vol surface and the live spot.
//   2. `repriced` yesterday's stored chain repriced at the live spot — one settlement of open
//                 interest behind, everything else current.
//   3. `stored`   the stored row as captured, unrepriced. Honest and blunt.
//   4. `none`     nothing stored. The section is omitted rather than faked.
//
// Rung 1 is not wired yet: whether the OCC publishes early enough is being measured rather than
// assumed. Rungs 2-4 work today, and rung 1 slots in above them without touching anything below.
export const RUNGS = Object.freeze(['occ', 'repriced', 'stored', 'none']);

// ── THE MAP ──────────────────────────────────────────────────────────────────
// One line per index, both on the SAME axis: percent away from that index's own spot, with price
// centred. Two bars each normalised to their own zone looked comparable and were not — QQQ's walls
// span 2.8% and SPY's 1.3%, so the same pixel meant a different distance on each row.
//
// Rendered inside a code fence by the caller. Discord uses a monospace font there on every
// platform, which is the only place ASCII alignment survives; outside one it is proportional and
// collapses. Code blocks also do not wrap on mobile — they scroll — so the width is held to 34
// characters, and the numbers are always printed underneath so the picture is never load-bearing.
export const MAP_LO = -3.0, MAP_HI = 1.5, MAP_W = 30;

export function mapRow(name, { spot, putWall, callWall, flipLevel } = {}) {
  if (!(spot > 0)) return null;
  const pctOf = (v) => (v / spot - 1) * 100;
  const cell = (p) => Math.round(((p - MAP_LO) / (MAP_HI - MAP_LO)) * (MAP_W - 1));
  const t = Array(MAP_W).fill('·');
  const put = (c, ch) => { const i = cell(c); if (i >= 0 && i < MAP_W) t[i] = ch; };
  if (putWall > 0) put(pctOf(putWall), 'P');
  if (callWall > 0) put(pctOf(callWall), 'C');
  if (flipLevel > 0) put(pctOf(flipLevel), '|');
  // Price last, so it wins the cell when a wall rounds onto the same column — the one mark the
  // reader must always be able to find. `^` rather than `O`: it sits high in the character cell and
  // breaks the run of dots, where a round glyph sinks into them.
  t[cell(0)] = '^';
  return `${name} ${t.join('')}`;
}

// ── IS ANYTHING HOLDING IT? ──────────────────────────────────────────────────
// A large share of the book expiring TODAY, concentrated near spot, is a pin: the hedging of that
// gamma buys dips and sells rips at those strikes and mechanically holds price there — until it
// expires. Its ABSENCE is equally a finding, and the more useful one, because an index with
// nothing holding it is free to trend.
//
// Measured 2026-09-09: QQQ carried 24% of its book expiring at 717-719 with spot at 718.36, and
// SPY carried 3.6% with none of it near spot. Reporting "3.6%" told the reader nothing; reporting
// "nothing is holding SPY, and SPY is the one sitting on its floor" was the best line on the board.
export const PIN_MIN_SHARE = 10;   // below this the number is noise; the absence is still reported
export const PIN_NEAR_PCT = 0.6;   // a peak further than this from spot is not pinning anything

// `expired` says the session that book belonged to has already closed. On the Asia brief, which
// fires at 23:13 UTC against a US close at 20:00, the front expiry HAS expired — and the section
// still printed "35% of QQQ's book expires today ... which holds it there until the last hour",
// in the present tense, under a heading saying "today". It was describing a session that finished
// three hours earlier. A pin that has expired is not a pin; it is a fact about this afternoon.
export function pinOf(grid, { spot, today, expired = false } = {}) {
  const rows = grid?.expiries || [];
  const front = rows.find(e => e.expiry === today);
  if (!front || !(spot > 0)) return { pinned: false, share: null, reason: 'no expiry today' };
  const share = front.shareOfAbs ?? 0;
  const peaks = [front.peakPutStrike, front.peakCallStrike].filter(v => v > 0);
  const near = peaks.length > 0 && peaks.every(k => Math.abs(k / spot - 1) * 100 <= PIN_NEAR_PCT);
  return {
    expired,
    pinned: !expired && share >= PIN_MIN_SHARE && near,
    share: +share.toFixed(1), near, peaks,
    band: peaks.length === 2 ? `${Math.min(...peaks)}–${Math.max(...peaks)}` : null,
  };
}

// ── THE SECTION ──────────────────────────────────────────────────────────────
// `rows` are one per index: { name, spot, putWall, callWall, flipLevel, flipZoneLo, flipZoneHi,
// pin }. `vintage` is the rung reached, plus the date the positioning came from.
const f2 = (v) => v == null ? '—' : (+v).toFixed(2);
const pctFrom = (v, spot) => (v == null || !(spot > 0)) ? '—'
  : `${v > spot ? '+' : ''}${((v / spot - 1) * 100).toFixed(v / spot - 1 === 0 ? 1 : 2)}%`;

// ── HOW BIG A DAY THE OPTIONS ARE PAID FOR ───────────────────────────────────
// The map says WHERE the levels are and never how far price is expected to travel, which is the
// other half of deciding whether a level is reachable today. A put wall 1.9% below spot is a
// different proposition on a day the options are priced for ±0.6% than on one priced for ±1.5%.
//
// spot × IV ÷ √252 — the one-standard-deviation move over one trading day implied by the book's
// own open-interest-weighted volatility. It is the market's own number, not a forecast: roughly
// two days in three land inside it, which also means roughly one in three does not, and the line
// says so rather than presenting a band as a boundary.
//
// TRADING DAYS, NOT CALENDAR DAYS. √252 and not √365 — the quoted vol is annualised over the days
// the market is open, and dividing by the wrong root understates the daily move by about a fifth.
export const TRADING_DAYS = 252;
export function expectedRange(spot, iv) {
  if (!(spot > 0) || !(iv > 0)) return null;
  // A quote can arrive as 0.2175 or as 21.75 depending on the source. Anything above 3 is a
  // percentage that has not been divided — 300% annualised vol on an index is not a real reading,
  // and silently treating it as a decimal would inflate the band a hundredfold.
  const v = iv > 3 ? iv / 100 : iv;
  const pts = spot * v / Math.sqrt(TRADING_DAYS);
  return { pts: +pts.toFixed(2), pct: +(pts / spot * 100).toFixed(2), iv: +(v * 100).toFixed(1) };
}

// `tense` — 'preview' when the session this book belongs to has not opened yet, 'closed' when it
// is over. The difference is not decoration: the same numbers mean "what the open runs into" and
// "what this afternoon did", and only one of them is a map for a trade.
export function renderGexSection(rows = [], { rung = 'none', from = null, asOf = null, tense = 'preview' } = {}) {
  const live = rows.filter(r => r && r.spot > 0);
  if (!live.length || rung === 'none') return null;
  const out = [];

  out.push('```');
  out.push(`    ${String(MAP_LO).replace('-0', '-')}%        spot        +${MAP_HI}%`);
  for (const r of live) { const m = mapRow(r.name, r); if (m) out.push(m); }
  out.push('```');
  out.push('`^` price · `|` pivot · `P` put wall · `C` call wall');

  for (const r of live) {
    out.push(`• **${r.name}** ${f2(r.spot)} — put wall ${f2(r.putWall)} (${pctFrom(r.putWall, r.spot)})`
      + ` · pivot ${f2(r.flipLevel)} (${pctFrom(r.flipLevel, r.spot)})`
      + ` · call wall ${f2(r.callWall)} (${pctFrom(r.callWall, r.spot)})`);
  }

  // How far the book is paid for price to travel, next to the levels it would be travelling to.
  // Omitted per row rather than faked when the vol is missing.
  const ranges = live.map(r => ({ r, e: expectedRange(r.spot, r.iv) })).filter(x => x.e);
  if (ranges.length) {
    out.push(`• 📏 **Priced for** ${ranges.map(({ r, e }) => `**${r.name}** ±${e.pts} (±${e.pct}%)`).join(' · ')}`
      + ` — one ordinary day's move, on the book's own volatility. About one day in three finishes outside it.`);
  }

  // ── WHAT IS HOLDING WHAT ───────────────────────────────────────────────────
  // Said as a comparison rather than two independent facts. An index with nothing expiring near
  // spot is free to trend, and that matters most when it is also the one nearest a wall — which is
  // a sentence neither row can produce on its own.
  // A CLOSED SESSION HAS NO PIN TO REPORT. What is worth carrying instead is where price finished
  // against the book, because that is the handoff the next session opens from.
  if (tense === 'closed') {
    for (const r of live) {
      if (!(r.flipLevel > 0)) continue;
      const side = r.spot >= r.flipLevel ? 'above' : 'below';
      out.push(`• **${r.name}** closed ${side} its pivot by ${Math.abs(r.spot - r.flipLevel).toFixed(2)}`
        + ` — ${side === 'below' ? 'the side where moves extend' : 'the side where moves get absorbed'}.`);
    }
    const label0 = `_where the US finished against its option book. Today's expiry is gone; overnight settlement will move these before the next open._`;
    out.push(label0);
    return out.join('\n');
  }

  const pinned = live.filter(r => r.pin?.pinned), loose = live.filter(r => r.pin && !r.pin.pinned);
  if (pinned.length && loose.length) {
    const p = pinned[0], l = loose[0];
    out.push(`• **${p.name} is anchored, ${l.name} is not.** ${p.pin.share}% of ${p.name}'s book expires today around ${p.pin.band || 'spot'}`
      + ` — hedging that holds it there until the last hour. ${l.name} has nothing expiring near spot, so it is free to trend.`);
  } else if (pinned.length) {
    const p = pinned[0];
    out.push(`• **${p.name} is anchored** — ${p.pin.share}% of its book expires today around ${p.pin.band || 'spot'}, which holds it there until the last hour.`);
  } else if (loose.length === live.length) {
    out.push(`• **Nothing is anchored today.** No index has meaningful expiry near spot, so neither is being held.`);
  }

  const label = {
    occ: `positioning is today's settled open interest (OCC), repriced at the live spot`,
    repriced: `positioning is the ${from || 'last stored'} close, repriced at the live spot — open interest is one settlement behind, the pivot is current`,
    stored: `positioning is the ${from || 'last stored'} capture as taken — not repriced, so the pivot is that session's, not now's`,
  }[rung];
  if (label) out.push(`_${label}${asOf ? ` · captured ${asOf.slice(11, 16)}Z` : ''}_`);
  return out.join('\n');
}
