// scripts/holidays-uae.mjs — merge DFM's circulars into data/holidays.json (UAE key).
//
//   node scripts/holidays-uae.mjs --check [data/holidays.json]       is a check due today?
//   node scripts/holidays-uae.mjs SOURCES.json [data/holidays.json]  merge what was fetched
//
// SOURCES.json is scripts/holidays-uae-fetch.py's output. Every rule is in lib/uaeHolidays.js.
// Prints counts and dates only — public exchange calendars, nothing about the account.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { uaeCalendar, mergeUae, checkDue } from '../lib/uaeHolidays.js';

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const today = new Date().toISOString().slice(0, 10);

if (process.argv.includes('--check')) {
  const file = JSON.parse(readFileSync(args[0] || 'data/holidays.json', 'utf8'));
  const force = process.env.FORCE === 'true';
  const c = checkDue(file, { now: new Date() });
  const due = force || c.due;
  console.log(`UAE holidays: ${due ? 'checking' : 'not due'} — ${force ? 'run by hand' : c.why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\n`);
  process.exit(0);
}

const [srcPath, filePath = 'data/holidays.json'] = args;
if (!srcPath) { console.error('usage: holidays-uae.mjs SOURCES.json [data/holidays.json]'); process.exit(2); }
const src = JSON.parse(readFileSync(srcPath, 'utf8'));
const file = JSON.parse(readFileSync(filePath, 'utf8'));
const cal = uaeCalendar({ circulars: src.circulars || [], ics: src.ics || '', today });
// A source that read nothing must not empty the calendar: keep what is there.
if (!cal.closed.length && !cal.tentative.length) { console.log('nothing read from either source — calendar left as it is'); process.exit(1); }
const { file: next, changed } = mergeUae(file, cal, { today, checkedAt: new Date().toISOString() });
writeFileSync(filePath, JSON.stringify(next, null, 2) + '\n');
const ahead = next.UAE.closed.filter(d => d >= today);
console.log(`UAE: ${ahead.length} closures ahead (${ahead.slice(0, 6).join(', ')}${ahead.length > 6 ? ', …' : ''}); tentative ${next.UAE.tentative.length} (${next.UAE.tentative.slice(0, 6).join(', ')}); ${changed ? 'changed' : 'no change to dates'}`);
