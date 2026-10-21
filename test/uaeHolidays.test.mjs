// lib/uaeHolidays.js — DFM / ADX closures from DFM's circulars. The texts below are the circulars'
// own wording (public exchange notices), trimmed.
import { parseAnnual, parseOneOff, parseResumption, circularKind, parseIcs, uaeCalendar, mergeUae, checkDue, occasionOf, isAnnualCircular, isOneOffCircular } from '../lib/uaeHolidays.js';
import { marketState } from '../lib/sessions.js';

let pass = 0, fail = 0;
const eq = (n, g, w) => { const ok = JSON.stringify(g) === JSON.stringify(w); console.log(`${ok ? '✅' : '❌'} ${n}` + (ok ? '' : `  got ${JSON.stringify(g)} want ${JSON.stringify(w)}`)); ok ? pass++ : fail++; };

const ANNUAL = `Circular No: 12/2025 Date: 29/12/2025 Subject: Trading and Settlement Holidays for the Calendar Year 2026 for Securities Market (Excluding Derivatives contracts). In addition to the official weekend holiday on Saturday and Sunday, please take note of the Trading and Settlement holidays for the calendar year 2026 for Securities Market listed below: SR. NO. DATE DAY DESCRIPTION 1 01-Jan-2026 Thursday NEW YEAR'S DAY 2 19-Mar-2026 Thursday EID AL FITR* 3 20-Mar-2026 Friday EID AL FITR* 4 21-Mar-2026 Saturday EID AL FITR* 5 26-May-2026 Tuesday ARAFAH (HAJ) DAY* 6 27-May-2026 Wednesday EID AL ADHA* 7 28-May-2026 Thursday EID AL ADHA* 8 29-May-2026 Friday EID AL ADHA* 9 16-Jun-2026 Tuesday HIJRI NEW YEAR'S DAY* 10 25-Aug-2026 Tuesday PROPHET MUHAMMAD'S BIRTHDAY 11 02-Dec-2026 Wednesday UAE NATIONAL DAY 12 03-Dec-2026 Thursday UAE NATIONAL DAY *Islamic holidays may vary and are subject to change`;
const PROPHET = `Circular No.: 11/2026 Issuance Date: 24/08/2026 Trading Holiday due to the Prophet’s Birthday Kindly be informed that, on the occasion of Prophet’s Birthday, the Market will be closed on Friday, 28th of August 2026, and will resume operations on Monday, 31st of August 2026. For information regarding settlement dates, please refer to Dubai Clear.`;
const HIJRI = `Circular No.: 09/2026 Issuance Date: 11/06/2026 Trading Holiday due to New Hijri Year 1448 Kindly note that, on the occasion of New Hijri Year 1448, Market will be closed on Monday 15th of June 2026 and will resume work on Tuesday 16th of June 2026.`;
const ADHA = `Circular No.: 08/2026 Issuance Date: 19/05/2026 Trading Holiday due to Eid Al Adha 2026 Kindly note that, on the occasion of Eid Al Adha, DFM will be closed from Tuesday, May 26, 2026, to Sunday, May 31, 2026. The official working and trading will resume on Monday, June 01, 2026.`;
const NATIONAL = `Circular No.: Issuance Date: 11/2025 28/11/2025 Trading Holiday due to United Arab Emirates 54th National Day Holiday The Dubai Financial Market will be closed on the occasion of the 54th United Arab Emirates National Day on Monday 1st December 2025 and Tuesday 2nd December 2025. Business operations will resume on Wednesday 3rd December 2025.`;
const CLOSURE = `Circular No.: 03/2026 Issuance Date: 01/03/2026 Market closure Dubai Financial Market (DFM) refers to the announcement issued by the UAE Capital Market Authority regarding the closure of the capital markets. DFM confirms that trading on the Dubai Financial Market will be suspended effective Monday, 2 March 2026 and on Tuesday 3 March 2026, in line with the Authority’s decision. Market participants are advised to follow official announcement issued by the UAE Capital Market Authority and Dubai Financial Market for further updates.`;
const RESUME = `Circular No.: 05/2026 Issuance Date: 03/03/2026 Resumption of Trading Dubai Financial Market (DFM) refers to the announcement issued by the UAE Capital Markets Authority (CMA) regarding the resumption of trading on UAE capital markets on Wednesday,4March 2026.In line with the CMA's decision, DFM announces the resumption of trading on the Dubai Financial Market on Wednesday, 4 March 2026.`;
const OPEN = `Market closure. Trading on the Dubai Financial Market will be suspended effective Monday, 2 March 2026 until further notice.`;
const ONE_NAME = `Trading in the shares of XYZ PJSC listed on the Dubai Financial Market will be suspended on Monday, 2 March 2026 pending disclosure.`;
const ICS = ['BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20270310', 'SUMMARY:Eid al-Fitr (tentative)', 'DESCRIPTION:Public holiday\\nDate is tentative and may change.', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20271202', 'SUMMARY:National Day', 'DESCRIPTION:Public holiday', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20270106', 'SUMMARY:Leilat al-Meiraj (tentative)', 'DESCRIPTION:Observance', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20270516', 'SUMMARY:Eid al-Adha public sector', 'DESCRIPTION:Public holiday', 'END:VEVENT',
  'END:VCALENDAR'].join('\r\n');

// ── THE ANNUAL LIST ──────────────────────────────────────────────────────────
const a = parseAnnual(ANNUAL);
eq('every row read', a.length, 12);
eq('a starred date is tentative, an unstarred one is not', [a[1], a[9]].map(r => [r.date, r.tentative]), [['2026-03-19', true], ['2026-08-25', false]]);
eq('names kept', a[4].name, 'ARAFAH (HAJ) DAY');

// ── ONE-OFF CIRCULARS ────────────────────────────────────────────────────────
eq('"closed on <day>, 28th of August" — one day, not the resume date', parseOneOff(PROPHET), { from: '2026-08-28', to: '2026-08-28', dates: ['2026-08-28'], occasion: 'prophet-birthday' });
eq('"closed on Monday 15th of June"', parseOneOff(HIJRI)?.dates, ['2026-06-15']);
eq('"closed from … to …" — weekdays only', parseOneOff(ADHA)?.dates, ['2026-05-26', '2026-05-27', '2026-05-28', '2026-05-29']);
eq('"on <date> and <date>" — both', parseOneOff(NATIONAL)?.dates, ['2025-12-01', '2025-12-02']);
eq('no dates, nothing', parseOneOff('Kindly note the market will open as usual.'), null);
eq('occasions', ['EID AL FITR', 'ARAFAH (HAJ) DAY', "HIJRI NEW YEAR'S DAY", 'Mouloud', 'UAE NATIONAL DAY', "NEW YEAR'S DAY"].map(occasionOf),
  ['eid-al-fitr', 'eid-al-adha', 'hijri-new-year', 'prophet-birthday', 'national-day', 'new-year']);
eq('which circulars are which', [isAnnualCircular('Trading and Settlement Holidays for the Calendar Year 2026 for Securities Market (Excluding Derivatives contracts)'),
  isAnnualCircular('Trading and Settlement Holidays for the Calendar Year 2026 for Derivatives contracts'),
  isOneOffCircular('Trading Holiday due to Eid Al Adha 2026'), isOneOffCircular('Revision in Expiry Date for Single Stock Futures due to Eid Al Fitr 2026 Holiday')], [true, false, true, false]);

// ── CLOSURES THE REGULATOR ORDERS ───────────────────────────────────────────
eq('"suspended effective Monday, 2 March … and on Tuesday 3 March" — both days', parseOneOff(CLOSURE)?.dates, ['2026-03-02', '2026-03-03']);
eq('the resumption day, even written "Wednesday,4March 2026"', parseResumption(RESUME), '2026-03-04');
eq('kinds: market closure, resumption, holiday, annual', [
  circularKind({ headline: 'Market Closure', text: CLOSURE }), circularKind({ headline: 'Resumption of Trading', text: RESUME }),
  circularKind({ headline: 'Trading Holiday due to Eid Al Adha 2026', text: ADHA }), circularKind({ headline: 'Trading and Settlement Holidays for the Calendar Year 2026 for Securities Market (Excluding Derivatives contracts)', text: ANNUAL })],
  ['closure', 'resumption', 'closure', 'annual']);
eq('one company\'s suspension is not the market closing', [circularKind({ headline: 'Suspension of Trading in XYZ PJSC Shares', text: ONE_NAME }), circularKind({ headline: 'Trading Suspension', text: ONE_NAME })], [null, null]);
const ordered = uaeCalendar({ circulars: [{ no: '03/2026', date: '2026-03-01', headline: 'Market Closure', text: CLOSURE }], today: '2026-10-21' });
eq('a closure with dates closes them', ordered.closed, ['2026-03-02', '2026-03-03']);
const openNow = uaeCalendar({ circulars: [{ no: '03/2026', date: '2026-03-01', headline: 'Market Closure', text: OPEN }], today: '2026-03-03' });
eq('"until further notice" with no resumption yet: closed through today, and said so', [openNow.closed, openNow.openClosure], [['2026-03-02', '2026-03-03'], { from: '2026-03-02', circular: 'DFM 03/2026' }]);
const openThen = uaeCalendar({ circulars: [{ no: '03/2026', date: '2026-03-01', headline: 'Market Closure', text: OPEN }, { no: '05/2026', date: '2026-03-03', headline: 'Resumption of Trading', text: RESUME }], today: '2026-10-21' });
eq('…and the resumption circular ends it the day before trading restarts', [openThen.closed, openThen.openClosure], [['2026-03-02', '2026-03-03'], null]);

// ── THE FEED ─────────────────────────────────────────────────────────────────
eq('public holidays only, not observances or public-sector days', parseIcs(ICS).map(r => [r.date, r.tentative]), [['2027-03-10', true], ['2027-12-02', false]]);

// ── THE YEAR ─────────────────────────────────────────────────────────────────
const circulars = [
  { no: '12/2025', date: '2025-12-29', headline: 'Trading and Settlement Holidays for the Calendar Year 2026 for Securities Market (Excluding Derivatives contracts)', text: ANNUAL },
  { no: '08/2026', date: '2026-05-18', headline: 'Trading Holiday due to Eid Al Adha 2026', text: ADHA },
  { no: '09/2026', date: '2026-06-10', headline: 'Trading Holiday due to New Hijri Year 1448', text: HIJRI },
  { no: '11/2026', date: '2026-08-23', headline: "Trading Holiday Due to Prophet's Birthday", text: PROPHET },
];
const early = uaeCalendar({ circulars: circulars.slice(0, 1), ics: ICS, today: '2026-01-02' });
eq('before any confirmation: the moon holidays wait as tentative', early.tentative.slice(0, 4), ['2026-03-19', '2026-03-20', '2026-05-26', '2026-05-27']);
eq('…the fixed ones are closures', early.closed, ['2026-01-01', '2026-08-25', '2026-12-02', '2026-12-03']);
eq('…and the next year comes from the public calendar, tentative only', [early.tentative.includes('2027-03-10'), early.tentative.includes('2027-12-02'), early.basis], [true, true, { 2026: 'dfm-annual', 2027: 'feed' }]);
const cal = uaeCalendar({ circulars, ics: ICS, today: '2026-10-21' });
eq('Arafat and Eid al-Adha confirmed', ['2026-05-26', '2026-05-29'].every(d => cal.closed.includes(d)), true);
eq('the Hijri New Year moves to the day DFM named', [cal.closed.includes('2026-06-15'), cal.closed.includes('2026-06-16')], [true, false]);
eq('an unstarred annual date moves too — the Prophet\'s Birthday to the 28th', [cal.closed.includes('2026-08-28'), cal.closed.includes('2026-08-25')], [true, false]);
eq('every name says where it came from', cal.names['2026-08-28'], "Prophet's Birthday · DFM 11/2026");

// ── INTO THE FILE ────────────────────────────────────────────────────────────
const before = { US: { closed: ['2026-11-26'] }, UAE: { closed: ['2026-03-02', '2026-08-25'], half: [] }, _uae: { managed: ['2026-08-25'] } };
const { file, changed } = mergeUae(before, cal, { today: '2026-10-21', checkedAt: '2026-10-21T05:00:00Z' });
eq('a date entered by hand stands', file.UAE.closed.includes('2026-03-02'), true);
eq('a past date this wrote and the circulars dropped is kept as history', file.UAE.closed.includes('2026-08-25'), true);
eq('other exchanges are untouched', file.US, { closed: ['2026-11-26'] });
eq('tentative is its own list, never closed', [file.UAE.tentative.includes('2027-03-10'), file.UAE.closed.includes('2027-03-10')], [true, false]);
eq('changed, and stamped', [changed, file._uae.checkedAt], [true, '2026-10-21T05:00:00Z']);
const moved = mergeUae({ UAE: { closed: ['2026-12-02', '2026-12-04'], half: [] }, _uae: { managed: ['2026-12-02', '2026-12-04'] } }, { closed: ['2026-12-02'], tentative: [], names: {}, basis: {} }, { today: '2026-10-21' });
eq('a future date this wrote and the circulars no longer support is removed', moved.file.UAE.closed, ['2026-12-02']);
eq('the same dates again: no change', mergeUae(file, cal, { today: '2026-10-21' }).changed, false);

// ── WHEN TO LOOK, AND WHEN TO WRITE ──────────────────────────────────────────
eq('every run looks', [checkDue({}, { now: new Date('2026-10-21T05:00:00Z') }).due, checkDue({ _uae: { checkedAt: '2026-10-21T05:00:00Z' } }, { now: new Date('2026-10-21T06:00:00Z') }).due], [true, true]);
eq('an open closure is named in the reason', /awaiting resumption/.test(checkDue({ _uae: { checkedAt: '2026-03-02T05:00:00Z', openClosure: { from: '2026-03-02' } } }, { now: new Date('2026-03-02T17:00:00Z') }).why), true);
const quiet = mergeUae(file, cal, { today: '2026-10-21', checkedAt: '2026-10-21T17:00:00Z' });
eq('nothing moved: the file is left exactly as it was — no commit, no redeploy', [quiet.wrote, quiet.file === file, quiet.file._uae.checkedAt], [false, true, '2026-10-21T05:00:00Z']);
eq('…until the weekly heartbeat records the check', mergeUae(file, cal, { today: '2026-10-28', checkedAt: '2026-10-28T05:00:00Z' }).wrote, true);
eq('a moved date is written at once', mergeUae(file, { ...cal, closed: [...cal.closed, '2026-12-04'] }, { today: '2026-10-21', checkedAt: '2026-10-21T17:00:00Z' }).wrote, true);

// ── THE SESSION READS IT ─────────────────────────────────────────────────────
eq('a confirmed closure is a holiday for a .AE name', marketState('XYZ.AE', new Date('2026-12-02T08:00:00Z')), 'holiday');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
