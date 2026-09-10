// briefSections.js — the pre-read, in words a person uses.
//
// THE PROBLEM THIS SOLVES. The brief was a correct instrument panel written for someone who
// already knew what every gauge was. "HY OAS 2.67 (last hard print) · CALM", "Split: foundry-
// specific weakness", "Tripwires · 2/5" — each of those is a true statement and none of them
// says what it MEANS or what a reader would do differently for knowing it. Measured on the
// 2026-09-08 briefs: eleven of the twenty-nine content lines were a label, a number and a
// classification, with no sentence attached.
//
// So every section here renders in two parts: the CLEAN DATA, and then, where there is one, an
// IMPLICATION on its own line behind 👉. The implication is derived from the same figures and
// says what the arrangement of them is consistent with — never what to do about it. That is not
// a stylistic preference: lib/read.js asserts the brief carries no positioning language, and
// this module is held to the same assertion.
//
// SIX SECTIONS, IN THIS ORDER, AND THE ORDER IS THE ARGUMENT:
//   GEX (US only) → TODAY'S WATCHLIST → CLOCK → OVERNIGHT → BACKDROP → WHAT WOULD CHANGE IT
// Levels first because that is the surface a day trade is placed against. Then the names moving
// against it. Then the schedule that governs when. Then what already happened. Then the slower
// conditions everything sits inside. And last, the things that would make the whole page wrong —
// which is the only part that stays useful after the figures above have gone stale.
//
// NOTHING IS FAKED TO FILL A SECTION. Every builder here returns null rather than a heading with
// an em-dash under it, and the caller drops a null section entirely.

// ── Small shared formatting ──────────────────────────────────────────────────

// A move smaller than half a tenth is not a direction. "-0.0%" is a worse way of saying flat
// than the word is, and it reads as a fact about the sign when it is a fact about the rounding.
export function pctWord(v) {
  if (v == null || !Number.isFinite(+v)) return null;
  return Math.abs(v) < 0.05 ? 'flat' : `${v > 0 ? '+' : ''}${(+v).toFixed(1)}%`;
}

// "1h 12m" / "45m" / "2h". Minutes only below an hour, and the minutes are dropped at the hour
// so a round wait does not read as "3h 0m".
export function humanDur(mins) {
  if (mins == null || !Number.isFinite(+mins) || mins < 0) return null;
  const m = Math.round(mins);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// A wall clock in someone else's zone, which is the only form of "when" that needs no arithmetic
// from the reader.
export function clockIn(tz, instant) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
      .format(instant instanceof Date ? instant : new Date(instant));
  } catch { return null; }
}

// ── 🕐 CLOCK ─────────────────────────────────────────────────────────────────
// WHAT IT ANSWERS: how long have I got, and what lands inside that.
//
// The old brief carried a CALENDAR of the next ten days and no statement at all about the
// session it was written for. A reader could not tell from it whether the market opened in five
// minutes or five hours, which is the first thing a day trade needs and the one thing a
// pre-market brief is uniquely placed to say.
//
// Markets are grouped by their countdown, not listed one per line: "Seoul and Tokyo in 6m" is
// the same sentence three lines of "opens in 6m" were trying to be. Grouping is exact-minute,
// because two exchanges that open within a minute of each other are one event to a reader and
// rounding them together would be inventing a coincidence that is not there.
export function clockSection({ markets = [], usOpen = null, halfDayNote = null, today = [], ahead = [] } = {}) {
  const out = [];

  // Trading now, opening soon, and shut for the day are three different facts and used to share
  // one word. A market already trading gets its remaining time, because "closes in 40m" is what
  // decides whether a setup has room to work.
  const opening = markets.filter(m => m.toOpen != null && m.toOpen >= 0);
  const live    = markets.filter(m => m.toClose != null && m.toClose >= 0);
  const shut    = markets.filter(m => m.toOpen == null && m.toClose == null);

  const byWait = new Map();
  for (const m of opening) {
    const k = Math.round(m.toOpen);
    if (!byWait.has(k)) byWait.set(k, []);
    byWait.get(k).push(m.name);
  }
  for (const [wait, names] of [...byWait.entries()].sort((a, b) => a[0] - b[0])) {
    // NEXT SESSION, SAID SO. A countdown that reaches past midnight is a different claim from one
    // inside the current day, and "opens in 14h" on a market that has already traded today reads
    // as a market that has not opened yet unless the line says which session it means.
    const next = markets.find(m => m.toOpen === wait)?.nextDay ? ' _(next session)_' : '';
    out.push(`🔔 **${listWords(names)}** ${wait <= 0 ? 'opening now' : `${names.length > 1 ? 'open' : 'opens'} in **${humanDur(wait)}**`}${next}`);
  }
  for (const m of live) {
    out.push(`🟢 **${m.name}** trading — **${humanDur(m.toClose)}** left`);
  }
  if (shut.length) {
    // WHY it is shut, when that is knowable. "Closed" covers a weekend, a holiday and a session
    // that simply finished, and those are not the same news.
    const byPhase = new Map();
    for (const m of shut) {
      const why = m.phase === 'weekend' ? 'weekend' : m.phase === 'holiday' ? 'holiday' : m.phase === 'post' ? 'done for the day' : 'closed';
      if (!byPhase.has(why)) byPhase.set(why, []);
      byPhase.get(why).push(m.name);
    }
    for (const [why, names] of byPhase) out.push(`⚪ **${listWords(names)}** — ${why}`);
  }

  // The US open, in the reader's own clock. This is the single most-asked question of a brief
  // read from Hong Kong or London and the old one never answered it in any form.
  if (usOpen) {
    out.push(usOpen.toOpen != null
      ? `🇺🇸 **US opens in ${humanDur(usOpen.toOpen)}**${usOpen.localTime ? ` — ${usOpen.localTime} your time` : ''}`
      : usOpen.toClose != null
        ? `🇺🇸 **US trading** — ${humanDur(usOpen.toClose)} left`
        // Reached only when the countdown itself could not be computed — the holiday file running
        // out past 2026-12-31 is the realistic cause. A bare "closed" is the honest fallback; a
        // guessed hour would be worse than no hour.
        : `🇺🇸 **US closed** — next open unknown, the exchange calendar does not reach that far`);
  }

  if (halfDayNote) out.push(halfDayNote);

  // TODAY IS NOT THE SAME KIND OF THING AS THIS WEEK. A release landing in the session you are
  // about to trade governs that session; one landing on Thursday is a note to yourself. They sat
  // in one undifferentiated ten-day list, ordered by date, so the item that mattered most was
  // wherever the calendar happened to put it.
  if (today.length) out.push(`📌 **Today:** ${today.join(' · ')}`);
  if (ahead.length) out.push(`📆 **Ahead:** ${ahead.join(' · ')}`);

  return out.length ? out.map(l => `• ${l}`).join('\n') : null;
}

// "A", "A and B", "A, B and C" — the sentence form, not the array form.
export function listWords(xs = []) {
  const a = xs.filter(Boolean);
  if (!a.length) return '';
  if (a.length === 1) return a[0];
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// ── 🌙 OVERNIGHT ─────────────────────────────────────────────────────────────
// WHAT IT ANSWERS: what already happened that this session has to react to.
//
// For Asia and Europe that is the US tape. For the US brief it was NOTHING — the section was
// suppressed entirely, on the reasoning that the US numbers are the session about to start
// rather than a handoff into it. True of the US numbers, and it left the US reader the only one
// with no answer to the question at all, while Asia had already finished trading and Europe was
// two hours into its own session.
//
// The implication is the shape of the moves, not their size: whether the risk was concentrated
// somewhere or spread across everything is the part that survives into the next session.
// `legs` and `risk` are each ONE line; `lines` is for a caller that has already decided its own
// grouping. The US brief needs the second: its two legs are whole continents, and joining Asia and
// Europe with the section's usual middot ran them into a single 140-character line whose only
// boundary between two overnight sessions was a punctuation mark.
export function overnightSection({ legs = [], risk = [], lines = [], lead = null } = {}) {
  const out = [...lines.filter(Boolean)];
  if (legs.length) out.push(legs.join(' · '));
  if (risk.length) out.push(risk.join(' · '));
  // LAST, not first. It reads as a conclusion, and a conclusion printed above its evidence asks
  // the reader to take it on trust and then check it backwards.
  if (lead && out.length) out.push(lead);
  if (!out.length) return null;
  return out.map(l => `• ${l}`).join('\n');
}

// SPREAD OR CONCENTRATED. Given the chip complex and the broad index, says which one moved more
// and what that arrangement is consistent with. Returns null when either leg is missing, because
// the whole claim is a comparison and half of it is not a weaker version of it.
export function breadthNote(narrowPct, broadPct, { narrow = 'chips', broad = 'the broad market' } = {}) {
  if (narrowPct == null || broadPct == null) return null;
  const n = +narrowPct, b = +broadPct;
  if (!Number.isFinite(n) || !Number.isFinite(b)) return null;
  // Both flat is a real state and worth saying plainly rather than forcing into a comparison.
  if (Math.abs(n) < 0.05 && Math.abs(b) < 0.05) return `${cap(narrow)} and ${broad} both finished flat — nothing was handed over either way.`;
  if (Math.sign(n) !== Math.sign(b) && Math.abs(n) >= 0.05 && Math.abs(b) >= 0.05) {
    return `${cap(narrow)} and ${broad} moved opposite ways — the move belongs to ${narrow}, not to risk appetite generally.`;
  }
  const gap = Math.abs(n) - Math.abs(b);
  if (gap >= 0.5) return `${cap(narrow)} moved further than ${broad}, so the ${n < 0 ? 'weakness' : 'strength'} is concentrated rather than broad.`;
  if (gap <= -0.5) return `${cap(broad)} moved further than ${narrow}, so this is broad risk rather than a chip story.`;
  return `${cap(narrow)} and ${broad} moved together, which reads as broad risk rather than anything sector-specific.`;
}

const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;

// ── 🌡️ BACKDROP ──────────────────────────────────────────────────────────────
// WHAT IT ANSWERS: what conditions is this session happening inside.
//
// This replaces four separate sections — NAMES, INDICES, MACRO and REGIME — which between them
// used twenty-odd lines to carry about six facts. NAMES listed fifteen quotes at one per line
// when the brief's own reader had told us the individual prints were not what they read it for;
// they are compressed to a single line here, sorted by move, so the outliers are still visible
// and the middle of the distribution stops taking up a screen.
//
// Every gauge is named for what it measures rather than for its ticker. "HY OAS" is the extra
// yield lenders demand from risky companies, and a reader who does not already know that learns
// nothing from the abbreviation; a reader who does know it loses nothing from the words.
export function compressLine(rows = [], { max = 6 } = {}) {
  const usable = rows.filter(r => r && r.changePct != null && Number.isFinite(+r.changePct));
  if (!usable.length) return null;
  // BIGGEST MOVERS, BOTH WAYS. Sorting by absolute move keeps a −4% and a +4% and drops the
  // ±0.1% names in between, which is the opposite of what alphabetical or universe order did.
  const shown = [...usable].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).slice(0, max);
  const txt = shown.map(r => `**${r.name}** ${pctWord(r.changePct)}`).join(' · ');
  const rest = usable.length - shown.length;
  return rest > 0 ? `${txt} _(+${rest} more)_` : txt;
}

// The credit gate, in the words it would be explained in. `stale` is carried separately from
// the direction because a spread that did not publish and a spread that did not move are
// different facts that rendered identically for months.
export function creditLine({ oas, date, state, stale = false, hygPct = null } = {}) {
  if (oas == null) return null;
  const calm = /calm|tight|benign/i.test(String(state || ''));
  const words = calm ? 'lenders are relaxed about risky borrowers'
    : /widen|stress/i.test(String(state || '')) ? 'lenders are charging more to carry risk'
    : 'in the middle of its own range';
  const live = hygPct != null ? ` · junk-bond ETF **${pctWord(hygPct)}** today` : '';
  const when = stale
    ? ` — **no new print** since ${date || 'the last one'}`
    : date ? ` _(${date})_` : '';
  return `🩹 **Credit:** risky companies pay **${oas}pp** over government debt${when} — ${words}${live}`;
}

// ── THE CURVE HAS TWO HALVES AND THEY MEAN DIFFERENT THINGS ──────────────────
// The line carried 2yr and 10yr and read the shape off that pair alone. On 2026-09-10 that pair
// was +41bp and the brief called it "the normal way round" — while 10s30s was +45bp, making the
// LONG END the steepest part of the curve, which the line had no way of noticing and no way of
// saying.
//
// The two halves answer different questions. 2s10s is about policy: how much easing or tightening
// the market has priced into the next couple of years. 10s30s is about the price of holding
// duration at all — supply, term premium, and what a lender wants for taking thirty years of
// inflation risk. A curve steepening at the front is a call on the Fed; one steepening at the back
// is not, and reading the second as the first is a specific way to be wrong.
//
// The 30Y was already fetched, already carried a 10s30s delta in lib/assemble.js, and was already
// a scenario condition. It simply never reached the brief.
//
// A LEVEL is a slow-moving fact; the SHAPE is what changes, and the shape is the part with a
// plain-English reading. The shape comment renders only when it is saying something the front end
// does not already say.
export const LONG_END_LED_PP = 0.10;   // how much wider 10s30s must be than 2s10s to be the story

export function ratesLine({ us2y, us10y, us30y } = {}) {
  if (us2y == null && us10y == null && us30y == null) return null;
  const parts = [];
  if (us2y != null) parts.push(`**2yr ${us2y}%**`);
  if (us10y != null) parts.push(`**10yr ${us10y}%**`);
  if (us30y != null) parts.push(`**30yr ${us30y}%**`);

  let tail = '';
  if (us2y != null && us10y != null) {
    const front = +us10y - +us2y;
    const back = us30y != null ? +us30y - +us10y : null;
    if (front < -0.05) {
      tail = ' — short money costs more than long, which is the unusual way round';
    } else if (back != null && back > front + LONG_END_LED_PP) {
      // The case the old line could not see. Said without claiming a cause: the gap is a fact, what
      // it is compensation for is not.
      tail = ' — the steepest part is the long end, so this is the price of holding duration rather'
           + ' than a view on where policy goes';
    } else if (back != null && front > back + LONG_END_LED_PP) {
      tail = ' — the steepness is in the policy-sensitive front end';
    } else if (front < 0.25) {
      tail = ' — the two are nearly level';
    } else {
      tail = ' — the normal way round';
    }
  }
  return `💵 **Money:** ${parts.join(' · ')}${tail}`;
}

// Oil separated into the two things it can be saying. A cheaper barrel is a cost tailwind for
// everyone who burns it; a dearer one is only an inflation story once it has been dear for a
// while, and the brief used to imply the second from a single day's print.
export function oilLine({ wti, brent, above, stale = false } = {}) {
  if (wti == null) return null;
  const b = brent != null ? ` · Brent **$${brent}**` : '';
  const s = stale ? ' ⚠️ _(not today\'s print)_' : '';
  return `🛢️ **Oil:** WTI **$${wti}**${b}${s} — ${above ? 'above its recent trend, so it adds to costs rather than easing them' : 'below its recent trend, which takes pressure off costs'}`;
}

// The fear gauge, with a band that means something without a lookup table.
export function volLine({ vix, changePct, band } = {}) {
  if (vix == null) return null;
  const word = band && band !== 'n/a' ? String(band).toLowerCase() : null;
  const plain = word === 'calm' || word === 'low' ? 'priced for an ordinary session'
    : word === 'elevated' || word === 'high' ? 'priced for a wider day than usual'
    : word === 'extreme' ? 'priced for a violent day'
    : null;
  const d = changePct != null ? ` ${pctWord(changePct)}` : '';
  return `😰 **Fear:** VIX **${vix}**${d}${plain ? ` — ${plain}` : ''}`;
}

export function backdropSection(lines = []) {
  const out = lines.filter(Boolean);
  return out.length ? out.map(l => `• ${l}`).join('\n') : null;
}

// ── 🔀 WHAT WOULD CHANGE IT ──────────────────────────────────────────────────
// WHAT IT ANSWERS: what would make everything above wrong.
//
// This is the only section that stays useful after the numbers have gone stale, and it was the
// one buried deepest — a "Tripwires · 2/5" row inside the READ, listing which gauges had fired
// and never once saying what firing WOULD mean. A count is not a tripwire. A tripwire is a level
// and a consequence.
//
// Fired and not-fired are rendered differently and deliberately: something already true is a
// present condition, not a thing to watch for, and collapsing the two was how a brief could show
// "2/5" while a reader took all five as pending.
export function changeSection({ items = [], flipsIf = null, lead = null } = {}) {
  const out = [];
  if (lead) out.push(`⚠️ ${lead}`);
  const usable = items.filter(i => i && i.name && i.tripped !== null && i.tripped !== undefined);
  const fired = usable.filter(i => i.tripped);
  const pending = usable.filter(i => !i.tripped);
  for (const i of pending) out.push(`👁 **${i.name}**${i.watch ? ` → ${i.watch}` : ''}`);
  for (const i of fired) out.push(`🔴 **${i.name}** — already true${i.means ? `, which ${i.means}` : ''}`);
  // The Korea conditional, where the region has one. Rendered as its own line rather than folded
  // in, because it is a conditional about a thesis and the rest of the list is about levels.
  if (flipsIf) out.push(`↪ ${String(flipsIf).replace(/^Flips if /, 'The Korea read changes if ')}`);
  if (!out.length) return null;
  return out.map(l => `• ${l}`).join('\n');
}

// ── THE TRIPWIRES, SAID OUT LOUD ─────────────────────────────────────────────
// lib/gates.js names each gauge for the field it reads — "OAS widening", "NQ lower low",
// "Retail not absorbing". Those are precise and they are not sentences. A reader who does not
// already know what OAS is cannot act on the first, and nothing in the brief told them.
//
// Matched by PREFIX, not by equality, because one of the five carries its own threshold in its
// name ("KRW > 1400") and that threshold moves. An unrecognised gauge falls through with its
// original name and no invented meaning — a wrong plain-English gloss on a live risk gauge is a
// worse failure than an unglossed one.
const TRIPWIRE_PLAIN = [
  { match: /^OAS widening/i,
    name: 'Lenders start charging more to carry risk',
    watch: 'junk spreads above 3.00pp **and** still rising over five days',
    means: 'takes the calm backdrop off the table' },
  { match: /^KRW/i,
    name: (n) => `The won weakens past ${String(n).replace(/^KRW\s*>\s*/, '')}`,
    watch: 'that level, on a close rather than a wick',
    means: 'reads as money leaving Korea rather than rotating inside it' },
  // The 30Y through its hawkish level. The threshold is the scenario engine's own — see
  // lib/gates.js — so the two cannot drift apart and describe the same line at two numbers.
  { match: /^30Y >/i,
    name: (n) => `The 30-year yield clears ${String(n).replace(/^30Y\s*>\s*/, '')}`,
    watch: 'that level on a close — the long end repricing, not a one-day wick',
    means: 'means lenders are demanding more to hold duration' },
  { match: /^VIX rising/i,
    name: 'Fear climbing from an already-high base',
    watch: 'VIX above 20 **and** rising, not just rising',
    means: 'means options are being paid up for a wider day' },
  { match: /^NQ lower low/i,
    name: "Nasdaq futures undercut yesterday's low",
    watch: "the prior session's low giving way",
    means: "puts yesterday's buyers underwater" },
  { match: /^Retail not absorbing/i,
    // GERUNDS, DELIBERATELY. lib/read.js bans imperative and positioning vocabulary and matches on
    // whole words, so "what foreigners sell" trips a guard that "foreign selling" does not — and
    // the guard is right to be blunt about it. This is also the wording the composed READ already
    // uses for the same gauge, so the two cannot describe one condition in two vocabularies.
    name: 'Korean retail stops absorbing foreign selling',
    watch: 'retail absorbing under half of the foreign selling',
    means: 'leaves no domestic bid under the selling' },
];

export function plainTripwire(item) {
  if (!item?.name) return null;
  const hit = TRIPWIRE_PLAIN.find(t => t.match.test(item.name));
  if (!hit) return { name: item.name, tripped: item.tripped, watch: null, means: null };
  return {
    name: typeof hit.name === 'function' ? hit.name(item.name) : hit.name,
    tripped: item.tripped,
    watch: hit.watch,
    means: hit.means,
  };
}

// ── 🔄 SINCE YESTERDAY ───────────────────────────────────────────────────────
// WHAT IT ANSWERS: what is different from the last time you read this.
//
// Every other section describes a state. A reader who read yesterday's brief already holds most of
// that state, and the part they cannot get from today's message alone is what MOVED — which is
// also the part that decides whether to re-read the rest of it.
//
// SLOW GAUGES ONLY. The quotes change every day by construction and saying so is noise; a credit
// spread that moved, a tripwire that flipped, a wall that shifted are all events. A day on which
// none of them happened renders NOTHING rather than "no change" — a brief that reports the absence
// of news every morning trains a reader to skip the line on the morning there is some.
//
// TRIPWIRES FIRST, because a gauge crossing its threshold is a change of state and the rest are
// changes of degree.
export const SINCE_MIN = {
  oas: 0.05,      // percentage points on the credit spread — below this is print noise
  vix: 1.0,       // VIX points
  wall: 0.25,     // per cent of spot, for a gamma wall moving
  krw: 5,         // won
  oil: 2.0,       // per cent on WTI
};

export function sinceSection(now = {}, prev = null) {
  if (!prev) return null;
  const out = [];

  // A gauge that crossed. `wires` is a map of name → tripped, so a wire that appeared or
  // disappeared between briefs is skipped rather than reported as a flip in one direction.
  const a = prev.wires || {}, b = now.wires || {};
  for (const name of Object.keys(b)) {
    if (!(name in a) || a[name] === b[name] || a[name] == null || b[name] == null) continue;
    out.push(b[name]
      ? `🔴 **${name}** — crossed since yesterday`
      : `🟢 **${name}** — no longer true`);
  }

  const move = (key, label, unit, min, { fmt = (v) => v, dir = null } = {}) => {
    const x = prev[key], y = now[key];
    if (x == null || y == null || !Number.isFinite(+x) || !Number.isFinite(+y)) return;
    const d = +y - +x;
    if (Math.abs(d) < min) return;
    const word = dir ? ` — ${d > 0 ? dir[0] : dir[1]}` : '';
    out.push(`**${label}** ${fmt(x)} → **${fmt(y)}**${unit ? unit : ''}${word}`);
  };
  move('oas', 'Credit spread', 'pp', SINCE_MIN.oas, { dir: ['lenders charging more', 'lenders charging less'] });
  move('vix', 'VIX', '', SINCE_MIN.vix, { dir: ['a wider day priced in', 'a calmer one priced in'] });
  move('krw', 'Won', '', SINCE_MIN.krw, { dir: ['weaker', 'stronger'] });

  // Percentage moves are measured against the prior value, not as a difference.
  const pctMove = (key, label, min, dir) => {
    const x = +prev[key], y = +now[key];
    if (!(x > 0) || !(y > 0)) return;
    const d = (y / x - 1) * 100;
    if (Math.abs(d) < min) return;
    out.push(`**${label}** ${x} → **${y}** (${d > 0 ? '+' : ''}${d.toFixed(1)}%) — ${d > 0 ? dir[0] : dir[1]}`);
  };
  pctMove('wti', 'Oil', SINCE_MIN.oil, ['adding to costs', 'easing them']);

  // A wall that moved is a level that moved, and a reader trading off yesterday's number needs to
  // know before they place against it.
  for (const [name, walls] of Object.entries(now.walls || {})) {
    const was = prev.walls?.[name];
    if (!was || !(now.spot?.[name] > 0)) continue;
    for (const side of ['putWall', 'callWall']) {
      const x = was[side], y = walls[side];
      if (!(x > 0) || !(y > 0)) continue;
      const movedPct = Math.abs(y - x) / now.spot[name] * 100;
      if (movedPct < SINCE_MIN.wall) continue;
      out.push(`**${name} ${side === 'putWall' ? 'put' : 'call'} wall** ${x} → **${y}**`);
    }
  }

  if (!out.length) return null;
  return out.map(l => `• ${l}`).join('\n');
}
