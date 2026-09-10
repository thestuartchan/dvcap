// test/auctions.test.mjs — Treasury supply: the calendar, and how the last one went.
import { auctionCalendar, auctionRead, normalizeAuction, auctionEvents, tenorOf, to24h,
         isCoupon, RUN_LENGTH, LONG_END } from '../lib/auctions.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}`); } };
const eq = (n, g, w) => { const a = JSON.stringify(g), b = JSON.stringify(w);
  if (a === b) { pass++; console.log(`✅ ${n}`); } else { fail++; console.log(`❌ ${n}  got ${a} want ${b}`); } };

// TreasuryDirect's own records, fetched 2026-09-10. Today's 30-year and the run behind it.
const raw = (o) => ({
  cusip: o.cusip, securityType: o.type || 'Bond', securityTerm: o.term,
  originalSecurityTerm: o.tenor, reopening: o.reopening ? 'Yes' : 'No',
  auctionDate: o.date + 'T00:00:00', announcementDate: (o.announced || o.date) + 'T00:00:00',
  issueDate: (o.issue || o.date) + 'T00:00:00', closingTimeCompetitive: o.closes || '01:00 PM',
  offeringAmount: String(o.offering ?? ''), highYield: o.hy == null ? '' : String(o.hy),
  bidToCoverRatio: o.btc == null ? '' : String(o.btc),
  competitiveAccepted: String(o.comp ?? ''), indirectBidderAccepted: String(o.ind ?? ''),
  primaryDealerAccepted: String(o.dlr ?? ''),
});
const TODAY30 = raw({ cusip: '912810UW6', tenor: '30-Year', term: '29-Year 11-Month', reopening: true,
  date: '2026-09-10', announced: '2026-09-03', offering: 22000000000, hy: 5.3080, btc: 2.610000,
  comp: 21957470500, ind: 17452770500, dlr: 484800000 });
const HISTORY = [
  raw({ cusip: '912810UX4', tenor: '20-Year', term: '20-Year', date: '2026-08-19', offering: 16000000000, hy: 5.2040, btc: 2.530000, comp: 15900000000, ind: 9947939100, dlr: 1900000000 }),
  raw({ cusip: '912810UW6', tenor: '30-Year', term: '30-Year', date: '2026-08-13', offering: 25000000000, hy: 5.2160, btc: 2.390000, comp: 24900000000, ind: 16647723000, dlr: 3000000000 }),
  raw({ cusip: '912810UU0', tenor: '30-Year', term: '29-Year 10-Month', reopening: true, date: '2026-07-09', offering: 22000000000, hy: 5.0580, btc: 2.440000, comp: 21900000000, ind: 17065257000, dlr: 2600000000 }),
  raw({ cusip: '912810UV8', tenor: '20-Year', term: '19-Year 10-Month', reopening: true, date: '2026-07-22', offering: 13000000000, hy: 5.1630, btc: 2.640000, comp: 12900000000, ind: 8903970000, dlr: 1500000000 }),
];
const NOW = new Date('2026-09-10T17:20:00Z');

// ── THE TENOR IS THE ORIGINAL TERM ──────────────────────────────────────────
// A reopened 30-year prints as "29-Year 11-Month". Grouping on the displayed term puts every
// reopening in a bucket of one, and a bid-to-cover with nothing to compare against is a number.
{
  eq('a reopening groups with its own tenor', tenorOf(TODAY30), '30-Year');
  eq('and the label says it is a reopening', normalizeAuction(TODAY30).label, '30-Year (reopening)');
  eq('a new issue does not', normalizeAuction(HISTORY[1]).label, '30-Year');
}

// ── HOW IT WENT, AGAINST ITS OWN RUN ────────────────────────────────────────
{
  const done = normalizeAuction(TODAY30);
  eq('the high yield is carried', done.highYield, 5.308);
  eq('and the cover', done.bidToCover, 2.61);
  // WHO TOOK IT is the part a cover can hide.
  eq('indirect share of the competitive take', done.indirectShare, 79.5);
  eq("and the dealers' share", done.dealerShare, 2.2);
  // THE TAIL IS ABSENT ON PURPOSE. It needs the when-issued yield at the bid deadline and no free
  // feed carries it; every "tail" on one is somebody's estimate against an untimestamped print.
  eq('no tail is manufactured', done.tail, null);
  ok('and the absence is explained', /when-issued/.test(done.tailNote));

  const read = auctionRead(done, HISTORY.map(normalizeAuction));
  eq('only the same tenor counts as the run', read.run, 2);   // the two prior 30-years, not the 20s
  eq('with its average', read.avgBidToCover, 2.42);
  eq('and where this one sits', read.word, 'the strongest of the run');
  ok('said as a sentence', /bid-to-cover 2\.61 against a 2\.42 average of the last 2/.test(read.note));
  // The dealer sentence is separate BECAUSE IT CAN DISAGREE with the cover — a cover held up by
  // the syndicate that had to bid is a weak auction wearing a strong number.
  eq('dealers were not carrying it', read.dealerHeavy, false);
  ok('and the note says so', /end demand covered it/.test(read.dealerNote));

  // The mirror: same cover, dealers well above their run.
  const heavy = auctionRead({ ...done, dealerShare: 22 }, HISTORY.map(normalizeAuction));
  eq('a syndicate-heavy take is flagged', heavy.dealerHeavy, true);
  ok('and named', /the syndicate absorbed more than usual/.test(heavy.dealerNote));

  eq('no prior of that tenor, no comparison', auctionRead({ ...done, tenor: '7-Year' }, HISTORY.map(normalizeAuction)).run, 0);
  eq('and no cover, no reading at all', auctionRead({ ...done, bidToCover: null }, []), null);
  ok('the run length is a named constant', RUN_LENGTH >= 4);
}

// ── THE AUCTION THAT WENT MISSING ───────────────────────────────────────────
// The 30-year settled at 1pm on 2026-09-10 and nothing on the board mentioned it. It leaves the
// announced calendar the moment it is done and lands in the history, so a board reading only the
// calendar shows nothing on the one day the auction actually mattered.
{
  const cal = auctionCalendar({ upcoming: [], history: [TODAY30, ...HISTORY], now: NOW });
  eq('an auction that ran today is still today', cal.today.length, 1);
  eq('with its result attached', cal.today[0].read.word, 'the strongest of the run');
  eq('and it is the long end one a duration book cares about', cal.lastLongEnd.tenor, '30-Year');
  ok('30-year is in the long end', LONG_END.includes('30-Year'));
}

// ── NEXT IS THE NEXT COUPON, NOT THE NEXT AUCTION ───────────────────────────
// Treasury runs bills two or three times a week. A 26-week bill in the headline slot buries the
// 20-year two days later, which is the one that reprices the long end.
{
  const bills = [
    raw({ cusip: 'B1', type: 'Bill', tenor: '26-Week', term: '13-Week', date: '2026-09-14', offering: 92000000000, closes: '11:30 AM' }),
  ];
  const coupons = [
    raw({ cusip: '912810UX4', type: 'Bond', tenor: '20-Year', term: '19-Year 11-Month', reopening: true, date: '2026-09-15', offering: 13000000000 }),
    raw({ cusip: '91282CRE3', type: 'Note', tenor: '10-Year', term: '9-Year 10-Month', reopening: true, date: '2026-09-17', offering: 19000000000 }),
  ];
  const cal = auctionCalendar({ upcoming: [...bills, ...coupons], history: HISTORY, now: NOW });
  eq('the bill does not take the headline slot', cal.next.tenor, '20-Year');
  eq('and the long-end slot agrees here', cal.nextLongEnd.tenor, '20-Year');
  eq('but the bill is still on the calendar', cal.upcoming.length, 3);
  ok('bills are not coupons', !isCoupon(bills[0]) && isCoupon(coupons[0]));
  // The horizon is real: an auction a month out is not this week's business.
  eq('beyond the horizon it drops out',
     auctionCalendar({ upcoming: coupons, history: [], now: NOW, horizonDays: 2 }).upcoming.length, 0);
}

// ── INTO THE CALENDAR ───────────────────────────────────────────────────────
// The reason it went missing is that nothing put it there: data/calendar.json is hand-maintained
// and Treasury announces a week out.
{
  const cal = auctionCalendar({ upcoming: [
    raw({ cusip: 'X', type: 'Bond', tenor: '20-Year', term: '19-Year 11-Month', reopening: true, date: '2026-09-15', offering: 13000000000 }),
    raw({ cusip: 'B', type: 'Bill', tenor: '26-Week', term: '13-Week', date: '2026-09-14', offering: 92000000000 }),
  ], history: [], now: NOW });
  const ev = auctionEvents(cal);
  eq('only coupons reach the calendar', ev.length, 1);
  eq('dated on the auction, not the issue', ev[0].date, '2026-09-15');
  eq('named with the size', ev[0].title, 'US 20-Year (reopening) auction · $13bn');
  eq('long end is tier 1', ev[0].tier, 1);
  // THE TIME IS THE BID DEADLINE, IN 24-HOUR. The calendar's countdown parses `time` as 24-hour,
  // so an unconverted "01:00 PM" would count down to one in the morning.
  eq('the bid deadline is converted', ev[0].time, '13:00');
  eq('noon is not midnight', to24h('12:00 PM'), '12:00');
  eq('and midnight is not noon', to24h('12:30 AM'), '00:30');
  eq('an unparseable time claims nothing', to24h('whenever'), null);

  // DO NOT DOUBLE-BOOK. data/calendar.json already carries some of these by hand, with notes the
  // feed cannot produce. Two entries for one auction read as two auctions.
  const hand = [{ date: '2026-09-15', title: 'US 20Y auction — the demand read the 30Y trades off', region: 'US' }];
  eq('a hand-entered auction wins its date', auctionEvents(cal, hand).length, 0);
  const elsewhere = [{ date: '2026-09-16', title: 'US 20Y auction', region: 'US' }];
  eq('and only its own date', auctionEvents(cal, elsewhere).length, 1);
  // A non-auction entry on the same day must not suppress it.
  eq('an unrelated event does not', auctionEvents(cal, [{ date: '2026-09-15', title: 'US CPI (Aug)' }]).length, 1);
}

// ── A MISSING FEED IS A MISSING CARD, NOT A MISSING DASHBOARD ───────────────
{
  eq('no calendar, no events', auctionEvents(null), []);
  const empty = auctionCalendar({ upcoming: [], history: [], now: NOW });
  eq('nothing today', empty.today, []);
  eq('nothing next', empty.next, null);
  eq('and no long end to report on', empty.lastLongEnd, null);
  eq('a null row normalizes to null', normalizeAuction(null), null);
}

console.log(fail ? `\n❌ ${fail} FAILED (${pass} passed)` : `\n✅ ALL ${pass} PASSED`);
process.exit(fail ? 1 : 0);
