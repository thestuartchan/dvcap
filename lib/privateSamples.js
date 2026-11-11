// lib/privateSamples.js — one sample of every message the private Discord channel can receive, built
// with the real card builders so a test shows each format exactly as it will arrive (Job health →
// "Send one of every type", api/regime-log.js ?tick=test-private&all=1).
//
// Every sample is marked TEST in its title and carries made-up numbers on placeholder tickers: no
// book data, no Unusual Whales data. Add a sample here whenever a new private message type is added
// (lib/alerts.js SOURCES with channel 'private'); test/privateSamples.test.mjs checks the two agree.
import { privateTestCard, failureCard, recoveredCard } from './cronRouter.js';
import { deskAlertCard } from './deskRules.js';
import { closeCard, namesCard, flowLineShort } from './uw.js';
import { scorecard, scorecardCard } from './uwScorecard.js';
import { darkpoolCard } from './uwExtras.js';

const mark = (payload) => ({
  ...payload,
  embeds: (payload.embeds || []).map(e => ({ ...e, title: `TEST · ${e.title || ''}`.slice(0, 256) })),
  allowed_mentions: { parse: [] },
});

export function privateSamples(now = new Date()) {
  const iso = now.toISOString();
  const today = iso.slice(0, 10);
  const desk = deskAlertCard({
    fresh: [
      { name: 'SAMPLE A · Mar \'27 call spread', rule: { state: 'hit', kind: 'stop', text: 'close below 100.00', note: 'sample note' } },
      { name: 'SAMPLE B · shares', rule: { state: 'due', kind: 'review', text: 'review on this date' } },
    ],
    near: [{ name: 'SAMPLE C · shares', rule: { kind: 'tp', text: 'close above 50.00' } }],
  }, { today, now: iso, flowFor: (x) => (x.name.startsWith('SAMPLE A')
    ? flowLineShort({ ticker: 'SAMPLE', net: 12e6, alerts: 4, sweeps: 3, top: { type: 'call', strike: 100, expiry: today, premium: 2.1e6, side: 'ask', sweep: true, opening: true } })
    : flowLineShort({ ticker: 'SAMPLF', net: 0.4e6, alerts: 0, sweeps: 0, top: null })) });
  const flow = closeCard({
    tide: { date: today, netCall: 123e6, netPut: -45e6, lean: 'calls' },
    tickers: {
      SAMPLE: { netPrem: { net: 12e6 }, nope: { nope: 1.23 }, gex: { callWall: 100, flip: 95 },
        alerts: [{ type: 'call', strike: 100, expiry: today, premium: 1.5e6, side: 'ask' }] },
    },
  }, { gamma: { SAMPLE: { ok: true, session: 'open', agree: 3, scored: 4, checks: [{ name: 'flip', score: true, state: 'differ' }] } } });
  // The day-60 scorecard on 60 made-up days: flow sign alternating, moves alternating, so no edge.
  const days = Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2030, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  const rows = days.map((date, i) => ({ date, tideNet: i % 2 ? 1 : -1, QQQ_net: 1, SPY_net: i % 3 ? 1 : -1, QQQ_nope: null, SPY_nope: null }));
  const outs = Object.fromEntries(days.map((d, i) => [d, { same: i % 2 ? 0.01 : -0.01, next: i % 4 < 2 ? 0.01 : -0.01 }]));
  const sc = scorecard({ rows, outcomes: { QQQ: outs, SPY: outs }, gamma: { SAMPLE: { sessions: 40, checks: { flip: { agree: 34, of: 40 } }, medianFlipGapPct: 0.21 } }, today: days[59] });
  return [
    { source: 'test', label: 'Connection test', payload: privateTestCard(now) },
    { source: 'job', label: 'Job failure', payload: mark(failureCard({ id: 'sample-job', slot: iso, ok: false, status: null, note: 'sample: no answer within 290s' }, now.getTime())) },
    { source: 'job', label: 'Job recovered', payload: mark(recoveredCard({ id: 'sample-job', slot: iso }, { slot: new Date(now.getTime() - 3600000).toISOString() }, now.getTime())) },
    { source: 'desk', label: 'Desk rules at the close', payload: mark(desk) },
    { source: 'flow', label: 'UW flow at the close', payload: mark(flow) },
    { source: 'flow', label: 'UW flow on your names', payload: mark(namesCard([
      { ticker: 'SAMPLE', net: 12e6, alerts: 4, sweeps: 3, top: { type: 'call', strike: 100, expiry: today, premium: 2.1e6, side: 'ask', sweep: true, opening: true } },
      { ticker: 'SAMPLF', net: -6e6, alerts: 1, sweeps: 0, top: null },
    ], { day: today })) },
    { source: 'flow', label: 'Dark pool at your Desk levels', payload: mark(darkpoolCard({ day: today, hits: [
      { name: 'SAMPLE A · shares', kind: 'stop', level: 100, count: 3, total: 4.2e6, biggest: { price: 100.12, premium: 2.1e6 } }] })) },
    { source: 'flow', label: 'UW 60-day scorecard', payload: mark(scorecardCard({ ...sc, signals: sc.signals.map(x => ({ ...x, label: x.label.replace('QQQ', 'SAMPLE').replace('SPY', 'SAMPLF') })) })) },
  ];
}
