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
  // ── A COLLISION IS A FACT, NOT A DRAWING PROBLEM ───────────────────────────
  // The marks were written in order and the later one overwrote the earlier, so when both walls
  // rounded onto the same column the put wall VANISHED and the row showed a lone `C`. Observed on
  // SPY 2026-09-10: both walls at 760 with put gamma 6.5x the call gamma there, and the map drew
  // the call side only — the dominant half of the strike erased by draw order.
  //
  // `B` for both. It is not a third kind of level, it is the two known ones landing in one cell,
  // and the line beneath says which side is heavier. Silently losing one was the alternative.
  const put = (c, ch) => {
    const i = cell(c);
    if (i < 0 || i >= MAP_W) return;
    // Walls only ever collide with each other here; the pivot keeps its own glyph because a pivot
    // sharing a cell with a wall is a different statement and the levels line carries both numbers.
    t[i] = (t[i] === 'P' && ch === 'C') || (t[i] === 'C' && ch === 'P') ? 'B' : ch;
  };
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
export function renderGexSection(rows = [], { rung = 'none', from = null, asOf = null, tense = 'preview', spotSource = null, ivAgeMin = null } = {}) {
  const live = rows.filter(r => r && r.spot > 0);
  if (!live.length || rung === 'none') return null;
  const out = [];

  out.push('```');
  out.push(`    ${String(MAP_LO).replace('-0', '-')}%        spot        +${MAP_HI}%`);
  for (const r of live) { const m = mapRow(r.name, r); if (m) out.push(m); }
  out.push('```');
  out.push('`^` price · `|` pivot · `P` put wall · `C` call wall · `B` both at one strike');

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

  // ── LEVELS THAT ARE REAL, THEN WHAT KIND OF DAY ────────────────────────────
  // Three numbers per index told a reader where the levels were and nothing about which of them
  // they could lean on. The dashboard's own read had the better version of this and the brief
  // never got it: whether a wall is a standing level or one expiry's book, whether it is a line or
  // a zone, which side of it is actually heavy, and what the regime means for the SHAPE of the day.
  for (const r of live) {
    const lv = realLevels({ spot: r.spot, putWall: r.putWall, callWall: r.callWall,
                            byStrike: r.byStrike, agreement: r.agreement, pin: r.pin });
    if (lv.length) { out.push(`**${r.name} — levels that are real**`); out.push(...lv); }
  }
  for (const r of live) {
    const dk = dayKind(r);
    if (dk.length) { out.push(`**${r.name} — what kind of day**`); out.push(...dk); }
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
    // THE SPOT IS NAMED, because the rung does not guarantee one. settledGex takes the caller's
    // spot where there is one and falls back to CBOE's snapshot where there is not, and those are
    // different claims: a pre-market print is the reason to recompute at all, while CBOE's is
    // whatever its CDN last published. Saying "the live spot" for both would make the weaker case
    // borrow the stronger one's wording.
    occ: `positioning is today's settled open interest (OCC), priced at ${spotSource === 'CBOE' ? "CBOE's last published spot" : 'the live spot'}`,
    repriced: `positioning is the ${from || 'last stored'} close, repriced at the live spot — open interest is one settlement behind, the pivot is current`,
    stored: `positioning is the ${from || 'last stored'} capture as taken — not repriced, so the pivot is that session's, not now's`,
  }[rung];
  // A SURFACE OLDER THAN THE FETCH IS SAID SO. CBOE zeroes its greeks at the bell, and the rung
  // survives that by reusing the last good surface — which is the right call and is not the same
  // claim as a fully current read.
  const ivNote = ivAgeMin != null ? ` · implied vol from ${ivAgeMin}min ago (CBOE published none on this read)` : '';
  if (label) out.push(`_${label}${asOf ? ` · captured ${asOf.slice(11, 16)}Z` : ''}${ivNote}_`);
  return out.join('\n');
}

// ── WHICH SIDE OF A WALL IS ACTUALLY HEAVY ───────────────────────────────────
// A wall is the strike carrying the most gamma-weighted open interest ON THAT SIDE, and the two
// sides are computed independently — so "put wall 760 · call wall 760" is not a balanced strike,
// it is one strike that won both counts. Observed on SPY 2026-09-10: both walls at 760, with put
// gamma 6,665 against call gamma 1,031. Six and a half to one, rendered as a tie.
//
// The ratio is the fact the two numbers hide. It is reported at every wall, not only on a
// collision, because a call wall that is 1.1x its own puts and one that is 5x are different levels
// wearing the same label.
export const DOMINANCE_MIN = 1.5;   // below this the strike is genuinely two-sided and says so

export function wallDominance(byStrike = [], strike) {
  const row = (byStrike || []).find(r => Number(r?.strike) === Number(strike));
  if (!row) return null;
  const c = Number(row.callGamma) || 0, p = Number(row.putGamma) || 0;
  if (!(c > 0) && !(p > 0)) return null;
  const heavy = p >= c ? 'put' : 'call';
  const ratio = +(Math.max(c, p) / Math.max(Math.min(c, p), 1e-9)).toFixed(1);
  return {
    callGamma: c, putGamma: p, heavy, ratio,
    twoSided: ratio < DOMINANCE_MIN,
    // Said in words at the point of use — "6.5x the calls there" reads; "ratio 6.5" does not.
    phrase: ratio < DOMINANCE_MIN
      ? 'roughly two-sided'
      : `${ratio}x the ${heavy === 'put' ? 'calls' : 'puts'} there`,
  };
}

// ── LEVELS THAT ARE REAL, AND WHAT KIND OF DAY ───────────────────────────────
// The brief's map gave three numbers per index and no sense of which of them a person could
// actually lean on. The dashboard's own read (lib/gexRead.js) had the better version of this and
// the pre-read never got it: which wall is a standing level versus one expiry's book, whether a
// wall is a line or a zone, and what the regime means for the SHAPE of the day rather than its
// direction.
//
// OBSERVATIONAL THROUGHOUT. These describe what an arrangement is consistent with — moves
// extending, moves being absorbed — and never what to do about it. lib/read.js's assertion is run
// over this file's strings by the suite, and it bans the vocabulary that would make these calls.

// A wall that no single expiry peaks at is a SUM, not a level: several expiries each contributing
// a little, adding to a maximum that no one book actually defends. Rendered as a band, because a
// point implies a precision the number does not have.
export const ZONE_PCT = 0.2;   // half-width of the band, as a per cent of spot

export function realLevels({ spot, putWall, callWall, byStrike = [], agreement = null, pin = null } = {}) {
  if (!(spot > 0)) return [];
  const out = [];
  const away = (k) => `${k > spot ? '+' : ''}${((k / spot - 1) * 100).toFixed(1)}%`;
  const band = (k) => {
    const w = spot * ZONE_PCT / 100;
    return `${(k - w).toFixed(0)}–${(k + w).toFixed(0)}`;
  };

  // ── ONE STRIKE, ONE LINE ───────────────────────────────────────────────────
  // The first cut looped the two walls independently, so a strike that won both counts printed
  // TWICE — and the second copy described the call wall as "6.5x the calls there", which is the
  // put side's ratio pasted onto the wrong sentence. Both walls landing together is a single fact
  // about a single strike and reads as one.
  const both = callWall > 0 && putWall > 0 && Number(callWall) === Number(putWall);
  const describe = (strike, kinds) => {
    const d = wallDominance(byStrike, strike);
    const bits = [`**${f2(strike)}** — ${kinds}, ${away(strike)}`];
    if (d?.twoSided) bits.push('Roughly two-sided, so it cuts both ways');
    // Named for the side that is actually heavy, not for the label the line happens to carry.
    else if (d) bits.push(`${d.ratio}x ${d.heavy}-heavy`);
    bits.push(d?.heavy === 'call' || (!d && kinds.startsWith('heaviest call'))
      ? 'Rallies tend to slow here rather than reverse'
      : 'Declines tend to slow here rather than turn');
    let line = `• ${bits.join('. ')}.`;
    // WHOSE BOOK IS IT? A wall that is one expiry's positioning stops existing when that expiry
    // does, and anyone leaning on it needs that before they lean. On a shared strike take the
    // WEAKER of the two agreements — a level is only as standing as its least-supported half.
    const cands = [agreement?.call, agreement?.put].filter(Boolean);
    const a = both ? cands.sort((x, y) => x.agree - y.agree)[0]
                   : (kinds.startsWith('heaviest call') ? agreement?.call : agreement?.put);
    if (a?.total > 1 && a.agree === 0) {
      line += ` No single expiry peaks exactly here, so read it as **${band(strike)}** rather than a line.`;
    } else if (a?.agree === 1 && a.matched?.length) {
      line += ` Owned by the ${a.matched[0]} expiry — it matters into that date more than today.`;
    } else if (a?.agree > 1) {
      line += ` Holds across ${a.agree} of ${a.total} expiries — a standing level rather than one day's book.`;
    }
    return line;
  };

  if (both) {
    out.push(describe(callWall, 'both walls sit on this one strike'));
  } else {
    if (callWall > 0) out.push(describe(callWall, 'heaviest call positioning'));
    if (putWall > 0) out.push(describe(putWall, 'heaviest put positioning'));
  }

  // The pin is the third real level and the only one that is about TODAY specifically.
  if (pin?.pinned) {
    out.push(`• **${pin.band || f2(spot)}** — today's expiring options are stacked right here (${pin.share}% of the whole book). That is the pin.`);
  }
  return out;
}

// WHAT KIND OF DAY — the regime as three bands rather than one label, because "negative gamma" is
// a fact about where price IS and the reader wants to know what happens if it moves.
export function dayKind({ spot, flipZoneLo, flipZoneHi, flipLevel } = {}) {
  const lo = flipZoneLo > 0 ? flipZoneLo : flipLevel, hi = flipZoneHi > 0 ? flipZoneHi : flipLevel;
  if (!(spot > 0) || !(lo > 0) || !(hi > 0)) return [];
  const where = spot < lo ? 'below' : spot > hi ? 'above' : 'inside';
  return [
    `• **Below ${f2(lo)}** — moves extend rather than fade. A stop sized for a normal day is more likely to be taken out by noise.${where === 'below' ? '  ← here now' : ''}`,
    `• **Above ${f2(hi)}** — moves get absorbed. Fades tend to work and breakouts tend to fail back into the range.${where === 'above' ? '  ← here now' : ''}`,
    `• **Between** — neither, and the zone is ${f2(hi - lo)} wide because that is how far the pivot moves as the dealer assumption varies.${where === 'inside' ? '  ← here now' : ''}`,
  ];
}
