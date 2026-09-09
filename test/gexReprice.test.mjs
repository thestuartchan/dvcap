// test/gexReprice.test.mjs — the morning fallback: when today's quotes are junk but the settled
// positioning is not, the panel reprices the last stored chain instead of saying "cannot".
//
// The failure this covers happened three mornings running (2026-09-02, 09-08, 09-09), each time
// about ten minutes after the US open: full strike coverage, settled open interest, a healthy front
// expiry, and an open-interest-weighted implied vol of 6.6% against a real QQQ chain's ~20%. The
// guard refused, correctly, and the live-recompute button was therefore unusable at exactly the
// hour it exists for.
//
// KV is stubbed at the fetch layer rather than mocked at the module boundary, so the Upstash
// request shape is exercised too — a reprice that reads the wrong key is the bug this would miss.
process.env.KV_REST_API_URL = 'https://unit-test.upstash.io';
process.env.KV_REST_API_TOKEN = 'unit-test';

const STORE = new Map();
globalThis.fetch = async (_url, init) => {
  const [cmd, key, value] = JSON.parse(init.body);
  if (cmd === 'GET') return { ok: true, json: async () => ({ result: STORE.get(key) ?? null }) };
  if (cmd === 'SET') { STORE.set(key, value); return { ok: true, json: async () => ({ result: 'OK' }) }; }
  return { ok: false, status: 400, json: async () => ({}) };
};

const { repriceStored, RAW_KEY, SERIES_KEY } = await import('../lib/gexStore.js');
const { snapshotSymbol } = await import('../lib/optionsChain.js');

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };
const ok = (n, c) => eq(n, !!c, true);

// A small book with a live expiry and one that expires before the reprice clock.
const C = (strike, oi, expiry) => ({ type: 'call', strike, oi, iv: 0.20, expiry });
const P = (strike, oi, expiry) => ({ type: 'put', strike, oi, iv: 0.22, expiry });
const LIVE = '2026-09-19', GONE = '2026-09-08';
const CONTRACTS = [
  C(715, 3000, LIVE), C(720, 9000, LIVE), C(730, 1200, LIVE),
  P(700, 8000, LIVE), P(710, 2500, LIVE),
  C(717, 4000, GONE), P(717, 4000, GONE),
];

const seed = () => {
  STORE.clear();
  STORE.set(SERIES_KEY, JSON.stringify({ QQQ: [
    { date: '2026-09-05', spot: 700, rate: 0.041, divYield: 0.005, advUsd: 2e10, rateSource: 'DTB3 2026-09-04' },
    { date: '2026-09-08', spot: 712.5, rate: 0.042, divYield: 0.005, advUsd: 25e9, rateSource: 'DTB3 2026-09-05' },
  ] }));
  STORE.set(RAW_KEY('QQQ', '2026-09-08'), JSON.stringify({
    symbol: 'QQQ', date: '2026-09-08', asOf: '2026-09-08T15:15:00.000Z', spot: 712.5,
    expiries: [{ date: GONE }, { date: LIVE }], failed: [], contracts: CONTRACTS,
  }));
};

const NOW = new Date('2026-09-09T13:39:00.000Z');

// ── it reads the newest stored chain, not the newest row that happens to have one ──
{
  seed();
  const out = await repriceStored('QQQ', { spot: 716.91, now: NOW });
  ok('a stored chain reprices', out != null);
  eq('it names the day it came from', out.from, '2026-09-08');
  eq('and when that day was captured', out.capturedAt, '2026-09-08T15:15:00.000Z');
  eq('and what spot it was captured at', out.capturedSpot, 712.5);

  // The whole point: the spot is today's, not the capture's.
  eq('the row is priced at the spot passed in', out.row.spot, 716.91);
  eq('not at the spot it was captured at', out.row.spot === 712.5, false);

  // Contracts that expired between the capture and the reprice carry no gamma and must not be
  // counted as if they did — a Friday chain repriced on Monday has lost its heaviest expiry.
  eq('expired contracts drop out', out.contracts, 5);
  eq('and are counted, not silently discarded', out.expired, 2);
  eq('the surviving expiry is the only one listed', out.row.expiries, [LIVE]);

  // Open interest and implied vol are the SETTLED ones. This is the limitation the panel states.
  eq('the settled open interest is carried through', out.row.callOi, 13200);
  eq('as is the settled put open interest', out.row.putOi, 10500);

  ok('the walls come back', out.byStrike?.length > 0);
  ok('so does the expiry grid', out.grid?.expiries?.length === 1);
  eq('the call wall is the heaviest call strike', out.row.callWall, 720);
  eq('the put wall is the heaviest put strike', out.row.putWall, 700);

  // Carried from the stored row rather than refetched — three Yahoo calls to normalise a number
  // that moves a percent a week is not a trade worth making.
  eq('ADV comes from the stored row', out.row.advUsd, 25e9);
  eq('as does the rate when none is passed', out.row.rate, 0.042);
}

// ── an explicit rate wins over the stored one ─────────────────────────────────
{
  seed();
  const out = await repriceStored('QQQ', { spot: 716.91, now: NOW, rate: 0.039, divYield: 0.005 });
  eq('a passed rate is used', out.row.rate, 0.039);
  eq('and it does not claim the stored rate source', out.row.rateSource, null);
}

// ── the refusals ──────────────────────────────────────────────────────────────
{
  seed();
  eq('no spot, no reprice', await repriceStored('QQQ', { spot: null, now: NOW }), null);
  eq('a symbol with no series is null', await repriceStored('SPY', { spot: 650, now: NOW }), null);

  STORE.delete(RAW_KEY('QQQ', '2026-09-08'));
  eq('a row whose raw chain has aged out is null, not an empty summary',
    await repriceStored('QQQ', { spot: 716.91, now: NOW }), null);

  // Every contract expired: there is nothing left to reprice, and a summary built on an empty
  // chain would report a flip of null and walls of null as though they were findings.
  seed();
  eq('a fully expired chain is null',
    await repriceStored('QQQ', { spot: 716.91, now: new Date('2026-10-01T14:00:00.000Z') }), null);
}

// ── THE FLAG THAT GATES IT, DRIVEN END TO END ────────────────────────────────
// ivOnly must be true ONLY when the vol surface is the sole defect. A starved front expiry or
// unpopulated open interest means there is no settled positioning to reprice, and answering those
// from storage would paper over a feed that is genuinely down.
//
// Asserted through snapshotSymbol against a stubbed Yahoo rather than by restating the expression:
// a predicate re-derived in a test proves the test can do arithmetic, not that the code is right.
{
  const day = (iso) => Math.floor(Date.parse(`${iso}T21:00:00Z`) / 1000);
  const EXPIRIES = ['2026-09-11', '2026-09-18', '2026-09-25', '2026-10-16', '2026-11-20', '2026-12-18'];
  const SPOT = 716.91;

  // A book wide enough to clear the ±10% strike band's coverage test at every expiry.
  const strikes = [];
  for (let k = 660; k <= 780; k += 5) strikes.push(k);
  const contract = (strike, oi, iv) => ({ strike, openInterest: oi, impliedVolatility: iv, lastPrice: 1 });

  // scenario knobs: `iv` sets the whole surface, `frontOi` scales the front expiry's book,
  // `oiEvery` populates open interest on only every nth strike to starve coverage.
  const makeChain = (expiry, { iv, frontOi, oiEvery }) => {
    const isFront = expiry === EXPIRIES[0];
    const rows = strikes.map((k, i) => {
      const populated = oiEvery == null || i % oiEvery === 0;
      const oi = !populated ? 0 : Math.round(1000 * (isFront ? frontOi : 1));
      return contract(k, oi, iv);
    });
    return rows;
  };

  const yahooStub = (scen) => async (url, init) => {
    const u = String(url);
    if (u.includes('upstash.io')) {
      const [cmd, key] = JSON.parse(init.body);
      if (cmd === 'GET') return { ok: true, json: async () => ({ result: STORE.get(key) ?? null }) };
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (u.includes('getcrumb')) return { ok: true, headers: { getSetCookie: () => [], get: () => null }, text: async () => 'crumb' };
    if (u.includes('fc.yahoo.com')) return { ok: true, headers: { getSetCookie: () => [], get: () => null }, text: async () => '' };
    if (u.includes('/v7/finance/options/')) {
      const m = /[?&]date=(\d+)/.exec(u);
      const unix = m ? +m[1] : day(EXPIRIES[0]);
      const expiry = EXPIRIES.find(e => day(e) === unix) || EXPIRIES[0];
      return { ok: true, json: async () => ({ optionChain: { result: [{
        underlyingSymbol: 'QQQ', quote: { regularMarketPrice: SPOT },
        expirationDates: EXPIRIES.map(day), strikes,
        options: [{ expirationDate: unix, calls: makeChain(expiry, scen), puts: makeChain(expiry, scen) }],
      }] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };

  const NOW2 = new Date('2026-09-09T13:39:00.000Z');
  const snapWith = async (scen) => {
    const saved = globalThis.fetch;
    globalThis.fetch = yahooStub(scen);
    try { return await snapshotSymbol('QQQ', { now: NOW2, gapMs: 0 }); }
    finally { globalThis.fetch = saved; }
  };

  // 1. Healthy: nothing to route around.
  {
    const s = await snapWith({ iv: 0.20, frontOi: 1 });
    eq('a healthy chain passes', s.ok, true);
    eq('and is not marked repriceable', s.ivOnly, false);
    eq('and its vol surface is not flagged broken', s.ivBroken, false);
  }

  // 2. The morning failure: everything populated, quotes junk.
  {
    const s = await snapWith({ iv: 0.066, frontOi: 1 });
    eq('a 6.6% vol surface is refused', s.ok, false);
    eq('the vol surface is what is flagged', s.ivBroken, true);
    eq('the front expiry is not starved', s.frontStarved, false);
    eq('so it is repriceable', s.ivOnly, true);
    ok('and the reason names the vol', /implied vol/.test(s.reason));
    ok('the spot survives the refusal — the reprice needs it', s.spot === SPOT);
  }

  // 3. A starved front expiry alongside the broken vol: NOT repriceable. There is no settled
  //    front-expiry book to carry, and the front is where the gamma is.
  {
    const s = await snapWith({ iv: 0.066, frontOi: 0.01 });
    eq('a starved front expiry is flagged', s.frontStarved, true);
    // Asserted so this cannot pass for the wrong reason — the vol IS broken here, and the
    // reprice is blocked by the front expiry rather than by the vol guard not firing.
    eq('the vol is broken here too', s.ivBroken, true);
    eq('and blocks the reprice even with the vol broken', s.ivOnly, false);
  }

  // 4. Thin coverage alongside the broken vol: likewise not repriceable.
  {
    const s = await snapWith({ iv: 0.066, frontOi: 1, oiEvery: 4 });
    ok('coverage falls below the floor', s.coverage < 0.60);
    eq('with the vol broken as well', s.ivBroken, true);
    eq('and that blocks the reprice too', s.ivOnly, false);
  }
}

// ── THE WIRING: WHO IS ALLOWED THE FALLBACK ──────────────────────────────────
// A repriced row is not a capture. Its open interest and implied vols belong to another day, so
// writing one into the series would put a number in the historical record that was never observed
// — and open interest is not served historically anywhere, so that row could never be corrected.
// The panel asks dry and gets the fallback; the scheduled capture asks wet and gets the refusal.
{
  const day = (iso) => Math.floor(Date.parse(`${iso}T21:00:00Z`) / 1000);
  const EXPIRIES = ['2026-09-11', '2026-09-18', '2026-09-25', '2026-10-16', '2026-11-20', '2026-12-18'];
  const SPOT = 716.91;
  const strikes = []; for (let k = 660; k <= 780; k += 5) strikes.push(k);
  const rows = () => strikes.map(k => ({ strike: k, openInterest: 1000, impliedVolatility: 0.066, lastPrice: 1 }));

  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('upstash.io')) {
      const [cmd, key, value] = JSON.parse(init.body);
      if (cmd === 'GET') return { ok: true, json: async () => ({ result: STORE.get(key) ?? null }) };
      STORE.set(key, value);
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
    if (u.includes('getcrumb') || u.includes('fc.yahoo.com')) return { ok: true, headers: { getSetCookie: () => [], get: () => null }, text: async () => 'c' };
    if (u.includes('/v7/finance/options/')) {
      const m = /[?&]date=(\d+)/.exec(u);
      const unix = m ? +m[1] : day(EXPIRIES[0]);
      return { ok: true, json: async () => ({ optionChain: { result: [{
        underlyingSymbol: 'QQQ', quote: { regularMarketPrice: SPOT },
        expirationDates: EXPIRIES.map(day), strikes,
        options: [{ expirationDate: unix, calls: rows(), puts: rows() }] }] } }) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  try {
    const { captureGex } = await import('../lib/gexStore.js');
    seed();
    const dry = await captureGex({ symbols: ['QQQ'], dry: true, now: NOW, session: 'open' });
    const r = dry.results[0];
    eq('a dry run answers a broken vol surface with a reprice', r.ok, true);
    eq('and says so rather than passing it off as fresh', r.mode, 'repriced');
    eq('it names the day the positioning came from', r.repricedFrom, '2026-09-08');
    eq('it carries the live spot, not the captured one', r.row.spot, SPOT);
    eq('it reports the live chain\'s vol so the reader can judge', r.liveIv != null, true);
    eq('and it writes nothing', r.wrote, false);
    ok('the walls come back with it', r.byStrike?.length > 0);

    seed();
    const wet = await captureGex({ symbols: ['QQQ'], dry: false, now: NOW, session: 'open' });
    const w = wet.results[0];
    eq('a scheduled capture is refused, not repriced', w.ok, false);
    eq('and labelled as a refusal', w.mode, 'refused');
    eq('but told that a reprice was available', w.repriceable, true);
    eq('and the stored series is untouched',
      JSON.parse(STORE.get(SERIES_KEY)).QQQ.map(x => x.date), ['2026-09-05', '2026-09-08']);
  } finally { globalThis.fetch = saved; }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
