// lib/auctions.js — the Treasury auction calendar and how the last one went.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// On 2026-09-10 the board had nothing about the 30-year auction that settled at 1pm that day, on
// a morning when the long end was the entire story and scenario C sat three tenths of a basis
// point from its trigger. B's watch list names "30Y auction tail / bid-to-cover" and there was
// nowhere for a reader to look.
//
// TreasuryDirect publishes both halves for free and without a key: the announced calendar, and
// every completed auction's internals. This module reads them and answers two questions — what is
// coming, and how did the last one of this tenor go against the run of them.
//
// ── WHAT IS NOT HERE, AND WHY ────────────────────────────────────────────────
// THE TAIL. A tail is the high yield minus the when-issued yield at the bid deadline, and nobody
// publishes when-issued. Every "tail" on a free feed is somebody's estimate against a 1pm print
// they did not timestamp. So this module reports what Treasury actually publishes — the high
// yield, the bid-to-cover, and who took the paper — and says the tail is not available rather
// than manufacturing one. `bidToCover` against the trailing run of the SAME tenor is the honest
// version of the same question.
//
// TREASURY BUYBACKS. Conducted by the New York Fed on Treasury's behalf, closing at 1:40pm ET for
// liquidity-support operations. The NY Fed's markets API carries SOMA operations only — outright
// bill and coupon purchases closing at 09:20 — and TreasuryDirect has no buyback endpoint. Probed
// on 2026-09-10; if a feed appears, it belongs here beside the auctions. Until then buybacks are
// hand-entered in data/calendar.json, which is how this board already carries known dated events,
// and they carry a time so the card can count down to them.

const TD = 'https://www.treasurydirect.gov/TA_WS/securities';
export const AUCTION_TIMEOUT_MS = 12000;
// How far ahead the calendar looks. Treasury announces roughly a week out, so a longer horizon
// mostly returns nothing and a shorter one misses the announcement window.
export const AUCTION_HORIZON_DAYS = 10;
// How many prior auctions of a tenor make a run. Six covers about half a year of monthly coupons
// — long enough to have a mean, short enough that the mean is about this regime.
export const RUN_LENGTH = 6;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const day = (v) => (typeof v === 'string' && v.length >= 10) ? v.slice(0, 10) : null;

// ── THE TENOR IS `originalSecurityTerm`, NOT `securityTerm` ──────────────────
// A reopened 30-year prints as "29-Year 11-Month" and a reopened 20-year as "19-Year 11-Month".
// Grouping on the displayed term would put every reopening in its own bucket of one, so a
// bid-to-cover would have nothing to be compared against — and the run is the whole point.
export function tenorOf(row) {
  const t = row?.originalSecurityTerm || row?.securityTerm || null;
  return t ? String(t).trim() : null;
}

// The long end is what this board holds duration risk against; a 4-week bill is calendar noise.
export const LONG_END = Object.freeze(['30-Year', '20-Year', '10-Year']);
export const COUPON_TYPES = Object.freeze(['Bond', 'Note', 'TIPS', 'FRN']);
// Accepts a raw TreasuryDirect row or a normalized one — the field is named differently on each
// and a mismatch here silently empties the coupon calendar rather than erroring.
export const isCoupon = (row) => COUPON_TYPES.includes(String(row?.securityType || row?.type || ''));

export function normalizeAuction(row) {
  if (!row) return null;
  const offering = num(row.offeringAmount);
  const compAccepted = num(row.competitiveAccepted);
  const indirect = num(row.indirectBidderAccepted);
  const dealer = num(row.primaryDealerAccepted);
  return {
    cusip: row.cusip || null,
    type: row.securityType || null,
    tenor: tenorOf(row),
    term: row.securityTerm || null,
    // WHAT TO PRINT. `tenor` groups a reopening with its own run and is the wrong label for it —
    // today's 30-year prints as "29-Year 11-Month" and a reopened 13-week bill carries a 26-week
    // original term. The label says the tenor and marks the reopening; the grouping key stays put.
    label: tenorOf(row) ? `${tenorOf(row)}${row.reopening === 'Yes' ? ' (reopening)' : ''}` : (row.securityTerm || null),
    reopening: row.reopening === 'Yes',
    auctionDate: day(row.auctionDate),
    announcementDate: day(row.announcementDate),
    issueDate: day(row.issueDate),
    closesAt: row.closingTimeCompetitive || null,
    offering,
    highYield: num(row.highYield),
    bidToCover: num(row.bidToCoverRatio),
    // WHO TOOK IT. A dealer share well above its own run means the syndicate absorbed paper the
    // end buyers did not want, which is the part of a weak auction a bid-to-cover can hide.
    indirectShare: (indirect != null && compAccepted > 0) ? +(indirect / compAccepted * 100).toFixed(1) : null,
    dealerShare: (dealer != null && compAccepted > 0) ? +(dealer / compAccepted * 100).toFixed(1) : null,
    // Published fields only. See the note above on why there is no tail here.
    tail: null,
    tailNote: 'not published — a tail needs the when-issued yield at the bid deadline, which no free feed carries',
  };
}

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// ── HOW IT WENT, AGAINST ITS OWN RUN ─────────────────────────────────────────
// A bid-to-cover of 2.61 is meaningless alone. Against the last six 30-years it is a statement.
// Observational: the reading describes where the number sits, never what to do about it.
export function auctionRead(done, history = []) {
  if (!done || done.bidToCover == null) return null;
  const run = history
    .filter(a => a && a.tenor === done.tenor && a.auctionDate && a.auctionDate < done.auctionDate && a.bidToCover != null)
    .slice(0, RUN_LENGTH);
  if (!run.length) return { run: 0, note: `no prior ${done.tenor} auctions on hand to compare against` };
  const covers = run.map(a => a.bidToCover);
  const avg = +mean(covers).toFixed(2);
  const delta = +(done.bidToCover - avg).toFixed(2);
  const best = done.bidToCover > Math.max(...covers);
  const worst = done.bidToCover < Math.min(...covers);
  const word = best ? 'the strongest of the run'
    : worst ? 'the weakest of the run'
    : delta > 0 ? 'above the run' : delta < 0 ? 'below the run' : 'level with the run';
  const dShares = run.map(a => a.dealerShare).filter(v => v != null);
  const dAvg = dShares.length ? +mean(dShares).toFixed(1) : null;
  const dealerHeavy = (dAvg != null && done.dealerShare != null) ? done.dealerShare > dAvg + 3 : null;
  return {
    run: run.length, avgBidToCover: avg, delta, best, worst, word,
    avgDealerShare: dAvg, dealerHeavy,
    // WHO TOOK IT is a separate sentence because it can disagree with the cover, and when it does
    // that disagreement is the finding: a cover held up by the dealers who had to bid.
    dealerNote: dealerHeavy == null ? null
      : dealerHeavy
        ? `dealers took ${done.dealerShare}% against a ${dAvg}% run — the syndicate absorbed more than usual`
        : `dealers took ${done.dealerShare}% against a ${dAvg}% run — end demand covered it`,
    note: `bid-to-cover ${done.bidToCover.toFixed(2)} against a ${avg.toFixed(2)} average of the last ${run.length} — ${word}`,
  };
}

// ── THE CALENDAR ─────────────────────────────────────────────────────────────
export function auctionCalendar({ upcoming = [], history = [], now = new Date(), horizonDays = AUCTION_HORIZON_DAYS } = {}) {
  const today = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + horizonDays * 86400000).toISOString().slice(0, 10);
  const up = upcoming.map(normalizeAuction).filter(a => a?.auctionDate && a.auctionDate >= today && a.auctionDate <= end);
  const hist = history.map(normalizeAuction).filter(Boolean)
    .sort((a, b) => (b.auctionDate || '').localeCompare(a.auctionDate || ''));

  // Auctions that ALREADY RAN TODAY are the ones that go missing: they leave `upcoming` the moment
  // they are announced as done and land in the history, so a board reading only the calendar shows
  // nothing on the one day the auction actually mattered.
  const todayDone = hist.filter(a => a.auctionDate === today);
  const todayPending = up.filter(a => a.auctionDate === today);

  const longEnd = (a) => LONG_END.includes(a.tenor);
  // NEXT IS THE NEXT COUPON, not the next auction. Treasury runs bills two or three times a week
  // and a duration book does not care; putting a 26-week bill in the headline slot buries the
  // 20-year two days later, which is the one that moves the long end.
  const byDate = (a, b) => (a.auctionDate || '').localeCompare(b.auctionDate || '')
    || (Number(longEnd(b)) - Number(longEnd(a)));
  const next = [...up].filter(isCoupon).sort(byDate)[0] || null;
  const nextLongEnd = [...up].filter(a => longEnd(a)).sort(byDate)[0] || null;
  // The most recent long-end auction with results, whenever it ran — the one a duration book cares
  // about, and the one B's watch list names.
  const lastLongEnd = hist.find(a => longEnd(a) && a.bidToCover != null) || null;

  return {
    today: todayDone.map(a => ({ ...a, read: auctionRead(a, hist) })),
    pendingToday: todayPending,
    upcoming: up,
    next, nextLongEnd,
    lastLongEnd: lastLongEnd ? { ...lastLongEnd, read: auctionRead(lastLongEnd, hist) } : null,
    asOf: now.toISOString(),
  };
}

async function td(path) {
  const r = await fetch(`${TD}/${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(AUCTION_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`TreasuryDirect ${path} → ${r.status}`);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

// WARN AND RETURN NULL, NEVER BLOCK. An auction card that fails to load is a missing card; an
// assemble that throws is a missing dashboard.
export async function fetchAuctions({ now = new Date() } = {}) {
  try {
    const [upcoming, bonds, notes] = await Promise.all([
      td('upcoming?format=json'),
      td('auctioned?format=json&type=Bond&pagesize=10'),
      td('auctioned?format=json&type=Note&pagesize=14'),
    ]);
    return auctionCalendar({ upcoming, history: [...bonds, ...notes], now });
  } catch (e) {
    console.warn('[auctions] TreasuryDirect unavailable — the auction card will be absent:', e?.message || e);
    return null;
  }
}

// ── INTO THE CALENDAR ────────────────────────────────────────────────────────
// The reason the 30-year went missing on 2026-09-10 is that nothing put it there: data/calendar.json
// is hand-maintained and auctions are announced a week out, so they only appear if somebody types
// them. These entries are generated from the announced calendar, in the shape weekHighlights()
// already returns, so the week-ahead and the stance card's NEXT row pick them up unchanged.
export function auctionEvents(cal, existing = []) {
  if (!cal) return [];
  // ── DO NOT DOUBLE-BOOK A HAND-ENTERED AUCTION ──────────────────────────────
  // data/calendar.json already carries some of these, typed by hand — "US 10Y note auction — the
  // demand read the 30Y trades off" sits on 2026-09-09. A generated entry beside it would print
  // the same auction twice in the week ahead, in two different wordings, which reads as two
  // auctions. The hand-entered one wins: it carries a note the feed cannot.
  const taken = new Set((existing || [])
    .filter(e => e?.date && /auction/i.test(String(e.title || '')))
    .map(e => e.date));
  return (cal.upcoming || []).filter(isCoupon).filter(a => !taken.has(a.auctionDate)).map(a => ({
    date: a.auctionDate,
    title: `US ${a.label} auction${a.offering ? ` · $${(a.offering / 1e9).toFixed(0)}bn` : ''}`,
    region: 'US', scope: 'global',
    // Long end is tier 1: it is the one that reprices duration. Front-end coupons are tier 2.
    tier: LONG_END.includes(a.tenor) ? 1 : 2,
    // The competitive bid deadline, which is when the auction actually happens.
    time: a.closesAt ? to24h(a.closesAt) : null,
    tz: 'America/New_York',
    auction: true,
  })).filter(e => e.date && e.title);
}

// "01:00 PM" → "13:00". The calendar's own time field is 24-hour and the countdown parses it as
// such, so an unconverted "01:00 PM" would count down to one in the morning.
export function to24h(t) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t || '').trim());
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (/pm/i.test(m[3])) h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}
