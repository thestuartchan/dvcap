// lib/privateSamples.js — one sample of every message the private Discord channel can receive, built
// with the real card builders so a test shows each format exactly as it will arrive (Job health →
// "Send one of every type", api/regime-log.js ?tick=test-private&all=1).
//
// Every sample is marked TEST in its title and carries made-up numbers on placeholder tickers: no
// book data, no Unusual Whales data. Add a sample here whenever a new private message type is added
// (lib/alerts.js SOURCES with channel 'private'); test/privateSamples.test.mjs checks the two agree.
import { privateTestCard, failureCard } from './cronRouter.js';
import { deskAlertCard } from './deskRules.js';
import { closeCard } from './uw.js';

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
  }, { today, now: iso });
  const flow = closeCard({
    tide: { date: today, netCall: 123e6, netPut: -45e6, lean: 'calls' },
    tickers: {
      SAMPLE: { netPrem: { net: 12e6 }, nope: { nope: 1.23 }, gex: { callWall: 100, flip: 95 },
        alerts: [{ type: 'call', strike: 100, expiry: today, premium: 1.5e6, side: 'ask' }] },
    },
  });
  return [
    { source: 'test', label: 'Connection test', payload: privateTestCard(now) },
    { source: 'job', label: 'Job failure', payload: mark(failureCard({ id: 'sample-job', slot: iso, ok: false, status: null, note: 'sample: no answer within 290s' }, now.getTime())) },
    { source: 'desk', label: 'Desk rules at the close', payload: mark(desk) },
    { source: 'flow', label: 'UW flow at the close', payload: mark(flow) },
  ];
}
